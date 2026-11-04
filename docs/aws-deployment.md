# Run the connected studio on AWS

This setup keeps the editor on Vercel and runs the Python backend, imports and
render queue on one EC2 GPU instance. Preparing the configuration does not launch
an instance, publish an image, upload the local workspace or connect production
Vercel to AWS. Review the generated files and cloud costs before provisioning.

## Rendering stays on Cycles

Final native product and mesh frames still use **Blender 4.3.2 Cycles**. The
browser editor uses Three.js; Gaussian previews and export background plates use
Spark/WebGL. Gaussian plates keep the existing limitations around near-field
depth, occlusion, product reflections and transmission. An AWS GPU does not turn
those plates into a complete Cycles environment.

The NVIDIA host supports Cycles through OptiX/CUDA and the headless browser
through its graphics driver. The selected container, host driver and actual
renderer must pass the runtime checks before their output is accepted. A working
`nvidia-smi`, a requested device or a successful image build alone does not prove
that a native frame or a Gaussian plate rendered on the GPU.

## One host owns the workspace

| Part | Prepared configuration |
| --- | --- |
| Editor | Existing Vercel project, initially left on its published static demo |
| Backend | One Linux/amd64 Gesso container, published to private ECR and pinned by image digest |
| GPU host | NVIDIA Deep Learning Base GPU AMI on an EC2 G6 instance |
| Workspace | Dedicated encrypted gp3 EBS volume mounted at `/data`; application data under `/data/workspace` |
| Network | Dedicated VPC/public subnet and Elastic IP; public TCP 80/443 reach Caddy |
| TLS | Caddy with the supplied backend hostname; DNS A record points to the Elastic IP |
| Application port | 8787, exposed only to the host loopback interface |
| Administration | Systems Manager Session Manager; no inbound SSH port or SSH key |
| Workspace key | Secrets Manager generates it; the host mounts a read-only key file from `/run` into the container |

The infrastructure templates are [registry.json](../infra/aws/registry.json) and
[workspace.json](../infra/aws/workspace.json). The preparation and read-only
preflight commands live in [aws_deploy.py](../scripts/aws_deploy.py). Image
publication is a separately dispatched GitHub Actions workflow; publishing an
image does not launch the workspace.

Keep one active backend. The project store, POSIX locks, immutable asset files
and serial render queue use this filesystem. This configuration does not create
ECS replicas, an ALB, a NAT gateway or an elastic render fleet. It is a shared
workspace with an access key, not a multi-user deployment.

The EBS volume has separate retention policies for stack deletion and resource
replacement. Keep it in the host's Availability Zone. Mount by verified EBS
identity/filesystem UUID, not by an assumed NVMe enumeration. A host replacement
requires a maintenance window, stopping writes, unmounting and detaching the old
attachment before reuse. Retaining a volume is not a backup.

## Prepare the deployment

You need an AWS account/profile, a region with G6 availability, a backend hostname
you control, and access to its DNS records. Do not use the Vercel hostname as the
backend hostname. An example is `api.example.com`; replace all example account,
region, domain and digest values below.

### Create the private registry and publishing role

Create a reviewable CloudFormation change set for `infra/aws/registry.json` with
`CAPABILITY_IAM`. Its parameters are:

| Parameter | Default / supplied value |
| --- | --- |
| `RepositoryName` | `gesso-render` |
| `GitHubRepository` | `kimestelle/3d-product-suite` |
| `GitHubOidcSubject` | This repository's exact immutable-ID `main` subject; supply the actual subject when using a different repository or customized claims |
| `ExistingGitHubOidcProviderArn` | Supply the account's existing GitHub provider ARN, or leave empty to create one |

An account cannot register the same GitHub provider URL twice. Inspect its
existing IAM OIDC providers before choosing that parameter. The role trust must
match the workflow's actual repository/`main` subject and `sts.amazonaws.com`
audience; the template does not accept a wildcard subject.

For this repository the default is
`repo:kimestelle@137699667/3d-product-suite@1421629111:ref:refs/heads/main`.
Confirm the actual subject if the organization changes its OIDC claims. Explicitly
empty selects the legacy name-only subject and is not the default for this repo.

Review the change set before executing it. The stack creates a private,
encrypted ECR repository with immutable tags, and a publishing role with access
to that repository. The role has no instance/stack provisioning permission.
The repository is retained when its stack is deleted. Record these stack
outputs: `RepositoryName`, `RepositoryUri`, `GitHubPublishRoleArn` and
`ExpectedGitHubSubject`.

For a first registry stack, the standard change-set command is:

```bash
aws --profile YOUR_AWS_PROFILE --region us-east-1 \
  cloudformation create-change-set \
  --stack-name gesso-registry \
  --change-set-name review-registry \
  --change-set-type CREATE \
  --template-body file://infra/aws/registry.json \
  --capabilities CAPABILITY_IAM
```

If the account already has the provider, add
`--parameters ParameterKey=ExistingGitHubOidcProviderArn,ParameterValue=YOUR_PROVIDER_ARN`.
Other parameter overrides follow the same AWS CLI form. Inspect the resulting
change set in CloudFormation; execute it only after reviewing its exact account,
permissions and retained resources. This command creates a change set, not the
registry resources themselves. Existing stacks require an update change set.

### Publish a verified image

The manual workflow defaults to verification only, without an ECR push:

```bash
gh workflow run aws-image.yml --ref main -f publish=false
```

After reviewing the AWS account, region, role and repository, explicitly publish:

```bash
gh workflow run aws-image.yml --ref main \
  -f publish=true \
  -f aws_region=us-east-1 \
  -f role_arn=arn:aws:iam::111122223333:role/REPLACE_WITH_PUBLISH_ROLE \
  -f repository_name=gesso-render
```

The workflow builds Linux/amd64 and checks a disposable authenticated workspace,
a small Cycles CPU render and software WebGL2 before publication. It uses
temporary GitHub OIDC credentials. No long-lived AWS key is added to GitHub. CPU
CI checks cannot certify NVIDIA hardware; the deployed host still needs its GPU
diagnostic.

Use the full `imageUri` from the workflow's `release.json` artifact/job summary
as the preparation command's `--image-uri`. Its `@sha256:` digest binds the
workspace to the published bytes. An immutable tag includes the commit, workflow
run and attempt; do not substitute a moving `latest` tag. Publish success alone
does not create an EC2 instance or connect Vercel.

### Prepare and check the workspace packet

After image publication, prepare the workspace files without making AWS calls:

```bash
python scripts/aws_deploy.py prepare \
  --region us-east-1 \
  --domain api.example.com \
  --image-uri 111122223333.dkr.ecr.us-east-1.amazonaws.com/gesso-render@sha256:REPLACE_WITH_IMAGE_DIGEST \
  --output /tmp/gesso-aws
```

Replace the example account, domain and digest. Use the complete image digest
from the reviewed publication, not a moving tag. The command validates the
configuration and writes local files; it does not provision cloud resources.
The default instance is `g6.2xlarge`; use `--help` for the instance, storage and
stack options.

The packet contains `workspace.json`, `registry.json`, `bootstrap.sh` and
`plan.json`. Optional flags include `--availability-zone`,
`--existing-volume-id`, `--workspace-gib`, `--root-gib`, `--ami-id`,
`--public-editor-url` and `--stack-name` (default `gesso-workspace`). Existing
volumes require a matching pinned Availability Zone and remain unformatted.
The root disk must be at least as large as the selected AMI's root snapshot.

Preparation can retain an uncommitted draft for review, but preflight refuses
that draft. Commit and push the deployment files, then prepare a fresh packet
before preflight. The published bootstrap must match the packet's exact commit
and checksum; unrelated uncommitted frontend work is not a deployment input.

Run the separate preflight with the intended AWS profile:

```bash
python scripts/aws_deploy.py preflight \
  --plan /tmp/gesso-aws/plan.json \
  --profile YOUR_AWS_PROFILE
```

Preflight is read-only against AWS. It checks the account, regional GPU quota,
instance offerings, official AMI, published ECR digest and any supplied existing
volume. Its local report and resolved parameters make those decisions
reviewable. The regional **Running On-Demand G and VT instances** quota must
cover the selected instance's vCPU count in addition to existing use. The AWS
default quota is zero. An instance being offered in a region does not guarantee
capacity in the chosen Availability Zone.

The official AMI is resolved through this regional public SSM parameter:

```text
/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id
```

Record the resolved AMI and review the resulting changes before launch. A later
`latest` AMI may contain different drivers; a passing earlier host test does not
validate that replacement. Resolve preflight failures before launch; do not
replace missing evidence with guessed AMI IDs or image tags.

Only a successful preflight writes `parameters.json` for deployment. It also
writes `preflight.json` with the check results. Preserve the plan/report together
so an image, AMI, zone or volume change remains reviewable.

### Review the workspace change set

Review the workspace CloudFormation change set before executing it. The generated
packet and command help describe its concrete stack inputs. Confirm the image
digest, resolved AMI, region/Availability Zone, instance type, workspace size,
retention policies, public origin/domain and IAM permissions. The launch step
creates billable resources and exposes the authenticated backend through Caddy;
it is separate from offline preparation and read-only preflight.

For a first workspace stack with a passing packet:

```bash
aws --profile YOUR_AWS_PROFILE --region us-east-1 \
  cloudformation create-change-set \
  --stack-name gesso-workspace \
  --change-set-name review-workspace \
  --change-set-type CREATE \
  --template-body file:///tmp/gesso-aws/workspace.json \
  --parameters file:///tmp/gesso-aws/parameters.json \
  --capabilities CAPABILITY_IAM
```

The helper prints the commands for its configured stack/region. Use an update
change set for an existing stack and perform the storage maintenance procedure
before a host replacement. No preparation or preflight command executes a
change set.

## Launch and verify before connecting Vercel

After the reviewed stack is launched:

1. Point the backend hostname's DNS A record at the stack's Elastic IP. Remove a
   conflicting AAAA record unless IPv6 is explicitly configured. Keep TCP 80/443
   reachable for Caddy's certificate challenges and HTTPS service. Certificate
   issuance depends on correct public DNS and outbound access to the issuer.
2. Connect with Session Manager and inspect bootstrap/service logs. Confirm the
   dedicated EBS volume is mounted and the workspace survived a controlled
   service restart. Confirm the container image digest matches the reviewed
   publication.
3. Run the runtime diagnostic in the deployed image, using its container name:

   ```bash
   docker exec --user gesso gesso-api \
     python scripts/check_render_runtime.py \
       --url http://127.0.0.1:8787 \
       --require-gpu \
       --output /tmp/gesso-runtime.json
   ```

   This renders a small real Cycles frame and opens the production capture
   canvas to check its actual WebGL2 renderer. `--require-gpu` rejects CPU
   Cycles or software/unavailable browser graphics. Copy the receipt out of the
   container before replacing it. Context initialization is not a complete
   Gaussian asset/export test; check a representative Gaussian result next.
4. Open `https://api.example.com/api/health`; expect `{"status":"ok"}`. This
   endpoint deliberately reports no projects, provider credentials or GPU facts.
5. Open the backend editor and sign in with the workspace key from Secrets
   Manager. Check that an unauthenticated API request cannot read the workspace.
   Import a small test product, save, reload, and export a short real result.
   Review the exported media and its actual device receipt. Preserve its timing;
   do not advertise an export-speed improvement from instance specifications.

Use Secrets Manager's authenticated console or an authorized local workflow to
retrieve the workspace key. Do not paste it into a URL, Git, Vite environment,
image build argument, CloudFormation parameter or deployment log. The generated
key file is temporary host runtime data; do not bundle it into the image. The
instance role can pull the selected ECR repository and read its exact workspace
secret; the app does not require permanent AWS access keys.

Only after those checks, prepare the existing Vercel rewrite:

```bash
python scripts/connect_vercel_backend.py https://api.example.com
git diff -- vercel.json
```

Review and deploy the normal editor build to the existing Vercel project. Remove
any manually configured `VITE_STATIC_DEMO=1` override. API requests, asset URLs
and downloads then remain on the Vercel origin through an external rewrite.
`GESSO_PUBLIC_URL` must remain the exact production editor origin, and
`GESSO_BACKEND_URL` must match the HTTPS backend origin. The direct backend uses
the same access key. Preview deployment origins are not allowed implicitly.

Vercel's external rewrite timeout is 120 seconds. Render submissions return
before their background work completes, but a synchronous import may exceed
that timeout. For a slow import, use the backend editor directly and check
whether it completed before retrying. Do not replace the public demo with an
unhealthy or unverified backend.

## Move and retain work

Source-code and container deployments do not upload `workspace-data/`. Moving
the local studio is a separate explicit transfer: stop edits and exports, back
up the complete source workspace, transfer its projects/assets/materials/jobs
and other referenced files, verify checksums, then start the cloud service on
that copy. Keep the local originals and saved revisions. Never copy a changing
workspace while a render or asset import is writing it.

Set ownership on the transferred cloud copy to the container's UID/GID
`10001:10001` before starting the app; local ownership metadata may name a
different user. Keep that operation scoped to `/data/workspace`. It does not
change source file bytes and must not modify the local original workspace.

Take a recoverable backup of the full EBS workspace before host replacement,
image migration or source cleanup. EBS snapshots capture disk state, not
unwritten application buffers; pause writes for application-consistent backups.
After restoration, verify referenced assets and a saved project before accepting
new edits. Interrupted renders retain their records and expose **Resume**; they
do not automatically restart or promise identical pixels on a different GPU.

NVIDIA documents a systemd-cgroup issue where `systemctl daemon-reload` can make
running containers lose GPU access. After host/driver/service maintenance,
restart the app container and repeat the GPU diagnostic before accepting new
exports. A receipt from before maintenance does not verify the current runtime.

Stopping EC2 stops its compute use, but EBS, retained snapshots, ECR and Elastic
IP/public IPv4 resources can continue to cost money. Review the selected region's
prices, GPU quota, disk size, backup retention and expected uptime before
executing the change set. This setup intentionally keeps the GPU host running
for the connected editor; it does not provide automatic sleep or autoscaling.

## Primary references

- [AWS G6 instance capabilities](https://aws.amazon.com/ec2/instance-types/g6/)
- [Regional EC2 quotas](https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html)
- [Official Base GPU AMI lookup](https://docs.aws.amazon.com/dlami/latest/devguide/aws-deep-learning-x86-base-gpu-ami-ubuntu-22-04.html)
- [NVIDIA container installation](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- [NVIDIA graphics/compute capabilities](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html)
- [Chromium headless GPU behavior](https://chromium.googlesource.com/chromium/src.git/+/show/refs/heads/main/docs/gpu/using-gpu-hardware-in-headless-chrome.md)
- [Caddy HTTPS prerequisites](https://caddyserver.com/docs/automatic-https)
- [Caddy releases](https://github.com/caddyserver/caddy/releases)
- [SSM administration](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [EBS attachment precautions](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-volumeattachment.html)
- [EBS snapshot consistency](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-creating-snapshot.html)
- [CloudFormation retention on replacement](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-attribute-updatereplacepolicy.html)
- [Vercel rewrite timeout](https://vercel.com/docs/limits#proxied-request-timeout)
