#!/usr/bin/env bash
# Runs on the pinned AWS Ubuntu NVIDIA DLAMI, never inside the app container.
set -Eeuo pipefail
umask 077
exec > >(tee -a /var/log/gesso-bootstrap.log) 2>&1

for setting in AWS_DEFAULT_REGION GESSO_STACK_ID GESSO_DOMAIN GESSO_IMAGE_URI GESSO_VOLUME_ID GESSO_SECRET_ARN GESSO_PUBLIC_URL; do
  test -n "${!setting:-}" || { echo "Missing deployment setting: $setting"; exit 1; }
done
for program in aws docker nvidia-smi nvidia-ctk curl python3 lsblk blkid mkfs.ext4 sha256sum; do
  command -v "$program" >/dev/null || { echo "The selected DLAMI lacks $program"; exit 1; }
done
metadata_token=$(curl --fail --silent --show-error --max-time 10 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token)
instance_id=$(curl --fail --silent --show-error --max-time 10 -H "X-aws-ec2-metadata-token: $metadata_token" http://169.254.169.254/latest/meta-data/instance-id)
unset metadata_token
signal_finished() {
  result=$?
  trap - EXIT
  aws cloudformation signal-resource --stack-name "$GESSO_STACK_ID" --logical-resource-id RenderHost --unique-id "$instance_id" --status "$([ "$result" -eq 0 ] && echo SUCCESS || echo FAILURE)" || true
  exit "$result"
}
trap signal_finished EXIT

# Never force-detach a mounted workspace from an older host during replacement.
volume_info=$(aws ec2 describe-volumes --volume-ids "$GESSO_VOLUME_ID" --output json)
volume_state=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["Volumes"][0]["State"])' <<<"$volume_info")
if [ "$volume_state" = available ]; then
  aws ec2 attach-volume --volume-id "$GESSO_VOLUME_ID" --instance-id "$instance_id" --device /dev/sdf >/dev/null
elif ! python3 -c 'import json,sys; v=json.load(sys.stdin)["Volumes"][0]; sys.exit(not any(a["InstanceId"]==sys.argv[1] for a in v["Attachments"]))' "$instance_id" <<<"$volume_info"; then
  echo 'Workspace is attached to another host. Stop it and use the documented maintenance procedure.'
  exit 1
fi
aws ec2 wait volume-in-use --volume-ids "$GESSO_VOLUME_ID"
volume_serial=${GESSO_VOLUME_ID//-/}
workspace_device=''
for attempt in $(seq 1 60); do
  workspace_device=$(lsblk --nodeps --noheadings --paths --output NAME,SERIAL | awk -v expected="$volume_serial" '$2==expected {print $1}')
  [ -n "$workspace_device" ] && break
  sleep 2
done
test -b "$workspace_device" || { echo 'Cannot identify the workspace EBS device by its volume ID'; exit 1; }
test "$(wc -w <<<"$workspace_device")" -eq 1 || { echo 'Ambiguous workspace device'; exit 1; }
if ! blkid "$workspace_device" >/dev/null; then
  test "${GESSO_FORMAT_NEW_VOLUME:-false}" = true || { echo 'An existing workspace has no recognized filesystem. No formatting performed.'; exit 1; }
  # Refuse partitioned/unknown existing disks instead of guessing they are empty.
  test "$(lsblk --noheadings --output NAME "$workspace_device" | wc -l)" -eq 1 || { echo 'Partitioned workspace requires manual review'; exit 1; }
  test -z "$(wipefs --no-act --noheadings --output TYPE "$workspace_device")" || { echo 'Existing disk signature requires manual review'; exit 1; }
  mkfs.ext4 -L gesso-workspace "$workspace_device"
fi
test "$(blkid -s TYPE -o value "$workspace_device")" = ext4 || { echo 'Expected an ext4 workspace; no formatting performed'; exit 1; }
workspace_uuid=$(blkid -s UUID -o value "$workspace_device")
mkdir -p /data
grep -q "UUID=$workspace_uuid /data " /etc/fstab || printf 'UUID=%s /data ext4 defaults,nofail 0 2\n' "$workspace_uuid" >>/etc/fstab
mountpoint -q /data || mount /data
test "$(findmnt --noheadings --output UUID --target /data)" = "$workspace_uuid" || { echo 'Another filesystem occupies /data'; exit 1; }
mkdir -p /data/workspace /data/caddy /opt/gesso
chown 10001:10001 /data/workspace

nvidia-smi --query-gpu=name,driver_version --format=csv,noheader
nvidia-ctk runtime configure --runtime=docker
systemctl enable --now docker
systemctl restart docker
registry=${GESSO_IMAGE_URI%%/*}
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
docker pull "$GESSO_IMAGE_URI"
docker logout "$registry"

# The host refreshes this private tmpfs file at every service start. The key is
# never a CloudFormation parameter, userdata value, Docker env value or log line.
python3 - <<'PY'
import json,os
from pathlib import Path
names=('AWS_DEFAULT_REGION','GESSO_IMAGE_URI','GESSO_SECRET_ARN','GESSO_DOMAIN','GESSO_PUBLIC_URL')
Path('/opt/gesso/config.json').write_text(json.dumps({name:os.environ[name] for name in names}))
PY
cat >/opt/gesso/start-app.py <<'PY'
import json,os,pathlib,subprocess
c=json.loads(pathlib.Path('/opt/gesso/config.json').read_text())
os.environ['AWS_DEFAULT_REGION']=c['AWS_DEFAULT_REGION']
directory=pathlib.Path('/run/gesso');directory.mkdir(mode=0o700,exist_ok=True)
key=directory/'access-key'
value=subprocess.check_output(['aws','secretsmanager','get-secret-value','--secret-id',c['GESSO_SECRET_ARN'],'--query','SecretString','--output','text']).strip()
if len(value)<32 or b'\n' in value:raise SystemExit('Invalid workspace access key')
key.write_bytes(value);key.chmod(0o400);os.chown(key,10001,10001)
subprocess.run(['docker','rm','--force','gesso-api'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
os.execvp('docker',['docker','run','--rm','--init','--name','gesso-api','--gpus','all','--shm-size','1g','--pids-limit','1024','--log-opt','max-size=20m','--log-opt','max-file=3',
 '--publish','127.0.0.1:8787:8787','--mount','type=bind,src=/data/workspace,dst=/data/workspace',
 '--mount','type=bind,src=/run/gesso/access-key,dst=/run/secrets/gesso-access-key,readonly',
 '--env','GESSO_ACCESS_KEY_FILE=/run/secrets/gesso-access-key','--env','GESSO_DATA_DIR=/data/workspace','--env','GESSO_CYCLES_DEVICE=AUTO',
 '--env','GESSO_CAPTURE_DEVICE=auto','--env','NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics','--env','AWS_EC2_METADATA_DISABLED=true',
 '--env','GESSO_PUBLIC_URL='+c['GESSO_PUBLIC_URL'],'--env','GESSO_BACKEND_URL=https://'+c['GESSO_DOMAIN'],c['GESSO_IMAGE_URI']])
PY
chmod 700 /opt/gesso/start-app.py
cat >/etc/systemd/system/gesso.service <<'UNIT'
[Unit]
Description=Gesso persistent workspace and serial render queue
Requires=docker.service
After=docker.service network-online.target
RequiresMountsFor=/data/workspace
[Service]
ExecStart=/usr/bin/python3 /opt/gesso/start-app.py
ExecStop=/usr/bin/docker stop --time 120 gesso-api
Restart=on-failure
RestartSec=10
TimeoutStopSec=150
[Install]
WantedBy=multi-user.target
UNIT

caddy_archive=/opt/gesso/caddy.tar.gz
curl --fail --location --retry 5 --max-time 180 https://github.com/caddyserver/caddy/releases/download/v2.11.8/caddy_2.11.8_linux_amd64.tar.gz --output "$caddy_archive"
printf 'f032f8805e4df2ce5e1a8a624495c91e9ff763d8ff3ceddadd4784a07c472f40  %s\n' "$caddy_archive" | sha256sum --check --status
tar --extract --gzip --file "$caddy_archive" --directory /usr/local/bin caddy
chmod 755 /usr/local/bin/caddy
rm "$caddy_archive"
id caddy >/dev/null 2>&1 || useradd --system --home-dir /data/caddy --shell /usr/sbin/nologin caddy
chown -R caddy:caddy /data/caddy
mkdir -p /etc/caddy
printf '%s {\n  reverse_proxy 127.0.0.1:8787\n}\n' "$GESSO_DOMAIN" >/etc/caddy/Caddyfile
chmod 644 /etc/caddy/Caddyfile
cat >/etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Gesso HTTPS reverse proxy
After=network-online.target gesso.service
RequiresMountsFor=/data/caddy
[Service]
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=/data/caddy
Environment=XDG_CONFIG_HOME=/data/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/data/caddy
IPAddressDeny=169.254.169.254
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now gesso
for attempt in $(seq 1 120); do
  if curl --fail --silent http://127.0.0.1:8787/api/health >/dev/null; then break; fi
  sleep 2
done
curl --fail --silent --show-error http://127.0.0.1:8787/api/health
# A real Cycles frame and actual WebGL2 renderer must pass before signaling ready.
docker exec --user 10001:10001 gesso-api python /app/scripts/check_render_runtime.py --url http://127.0.0.1:8787 --require-gpu --output /data/workspace/aws-runtime-check.json

systemctl enable --now caddy
echo 'GPU runtime passed. Point the backend DNS A record to the stack Elastic IP, then verify HTTPS and access before connecting Vercel.'
