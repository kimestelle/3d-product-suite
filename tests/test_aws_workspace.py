"""Infrastructure boundaries for the single persistent GPU workspace."""
import json
import subprocess
import tempfile
from unittest.mock import patch
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AwsWorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = json.loads((ROOT / 'infra/aws/workspace.json').read_text())
        cls.resources = cls.template['Resources']
        cls.bootstrap = (ROOT / 'infra/aws/bootstrap.sh').read_text()

    def test_only_one_host_can_own_the_serial_queue(self):
        hosts = [value for value in self.resources.values() if value['Type'] == 'AWS::EC2::Instance']
        self.assertEqual(len(hosts), 1)
        self.assertFalse(any(value['Type'].startswith(('AWS::AutoScaling', 'AWS::ECS')) for value in self.resources.values()))
        self.assertIn('Workspace is attached to another host', self.bootstrap)
        self.assertNotIn('detach-volume', self.bootstrap)

    def test_workspace_survives_host_or_stack_deletion(self):
        volume = self.resources['WorkspaceVolume']
        self.assertEqual(volume['DeletionPolicy'], 'Retain')
        self.assertEqual(volume['UpdateReplacePolicy'], 'Retain')
        self.assertIs(volume['Properties']['Encrypted'], True)
        self.assertEqual(volume['Properties']['VolumeType'], 'gp3')
        self.assertEqual(self.resources['PublicSubnet']['Properties']['AvailabilityZone'], volume['Properties']['AvailabilityZone'])
        self.assertIn('ExistingDiskNeedsPinnedZone', self.template['Rules'])
        self.assertIn('GESSO_FORMAT_NEW_VOLUME:-false', self.bootstrap)
        self.assertIn('wipefs --no-act', self.bootstrap)
        self.assertIn('--output NAME,SERIAL', self.bootstrap)
        self.assertIn('UUID=%s /data', self.bootstrap)

    def test_application_and_administration_ports_are_not_public(self):
        rules = self.resources['WebSecurityGroup']['Properties']['SecurityGroupIngress']
        self.assertEqual({rule['FromPort'] for rule in rules}, {80, 443})
        self.assertIn("'127.0.0.1:8787:8787'", self.bootstrap)
        self.assertNotIn('KeyName', self.resources['RenderHost']['Properties'])
        metadata = self.resources['RenderHost']['Properties']['MetadataOptions']
        self.assertEqual(metadata['HttpTokens'], 'required')
        self.assertEqual(metadata['HttpPutResponseHopLimit'], 1)

    def test_access_key_is_generated_and_mounted_not_embedded(self):
        secret = self.resources['WorkspaceAccessKey']
        self.assertEqual(secret['Properties']['GenerateSecretString']['PasswordLength'], 64)
        self.assertNotIn('SecretString', secret['Properties'])
        self.assertTrue(all('AccessKey' not in name for name in self.template['Parameters']))
        self.assertEqual({name for name in self.template['Parameters'] if 'Secret' in name}, {'AtlasKeySecretArn', 'FalKeySecretArn'})
        self.assertIn('GESSO_ACCESS_KEY_FILE=/run/secrets/gesso-access-key', self.bootstrap)
        self.assertNotIn("'--env','GESSO_ACCESS_KEY='", self.bootstrap)
        statements = self.resources['HostRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
        secret_read = next(item for item in statements if item['Action'] == 'secretsmanager:GetSecretValue')
        self.assertEqual(secret_read['Resource'], {'Ref': 'WorkspaceAccessKey'})

    def test_release_and_bootstrap_are_pinned(self):
        parameters = self.template['Parameters']
        self.assertIn('@sha256:', parameters['ImageUri']['AllowedPattern'])
        self.assertIn('[a-f0-9]{40}', parameters['BootstrapUrl']['AllowedPattern'])
        userdata = self.resources['RenderHost']['Properties']['UserData']['Fn::Base64']['Fn::Sub'][0]
        self.assertIn('sha256sum --check --status', userdata)
        self.assertIn('exec bash /opt/gesso/bootstrap.sh', userdata)

    def test_optional_provider_grants_are_exact_secret_resources(self):
        statements=self.resources['HostRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
        for provider in ('Atlas','Fal'):
            parameter=provider+'KeySecretArn'
            self.assertEqual(self.template['Parameters'][parameter]['Default'],'')
            conditional=next(item['Fn::If'] for item in statements if item.get('Fn::If',[None])[0]=='Use'+provider+'Key')
            self.assertEqual(conditional[1],{'Effect':'Allow','Action':'secretsmanager:GetSecretValue','Resource':{'Ref':parameter}})
            self.assertEqual(conditional[2],{'Ref':'AWS::NoValue'})

    def test_gpu_readiness_follows_final_systemd_reload(self):
        self.assertEqual(self.bootstrap.count('systemctl daemon-reload'), 1)
        self.assertLess(self.bootstrap.index('systemctl daemon-reload'), self.bootstrap.index('check_render_runtime.py'))
        self.assertIn('--require-gpu --output /data/workspace/aws-runtime-check.json', self.bootstrap)
        self.assertEqual(self.resources['RenderHost']['CreationPolicy']['ResourceSignal']['Count'], 1)
        self.assertIn('signal-resource', self.bootstrap)

    def test_local_build_context_excludes_private_handoffs_and_workspace(self):
        ignored = set((ROOT / '.dockerignore').read_text().splitlines())
        self.assertTrue({'outputs', '.aws', '.codex', '.agents', 'workspace-data*', '**/*.zip', 'gesso-*.mp4'}.issubset(ignored))
        self.assertNotIn('**/*.mp4', ignored)  # Public product reels remain build inputs.


class AwsStartAppTests(unittest.TestCase):
    def setUp(self):
        source=(ROOT/'infra/aws/bootstrap.sh').read_text().split("cat >/opt/gesso/start-app.py <<'PY'\n",1)[1].split("\nPY\n",1)[0]
        self.code=compile(source,'start-app.py','exec')
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.directory=Path(temporary.name)
        self.runtime=self.directory/'run-gesso'
        self.config=self.directory/'config.json'
        self.values={'GESSO_SECRET_ARN':'workspace-arn','AWS_DEFAULT_REGION':'us-east-1','GESSO_IMAGE_URI':'registry/image@sha256:digest',
                     'GESSO_PUBLIC_URL':'https://gesso.example.com','GESSO_DOMAIN':'api.example.com',
                     'GESSO_ATLAS_SECRET_ARN':'atlas-arn','GESSO_FAL_SECRET_ARN':'fal-arn'}
        self.config.write_text(json.dumps(self.values))
        self.key=b'workspace-test-key-'+b'a'*40
        self.secrets={'workspace-arn':self.key,'atlas-arn':b'atlas-test-key','fal-arn':b'fal-test-key'}
        self.started=[]

    def run_start(self, *, rejected=None):
        real_path=Path
        def mapped_path(value):
            return {'/run/gesso':self.runtime,'/opt/gesso/config.json':self.config}.get(value,real_path(value))
        def command(args,**kwargs):
            if args[:3]==['aws','secretsmanager','get-secret-value']:
                arn=args[args.index('--secret-id')+1]
                return subprocess.CompletedProcess(args,1 if arn==rejected else 0,self.secrets[arn]+b'\n',b'private-provider-response')
            self.assertEqual(args,['docker','rm','--force','gesso-api'])
            return subprocess.CompletedProcess(args,0,b'',b'')
        def start(program,args):
            self.assertEqual(program,'docker');self.started.append(args)
        with patch('pathlib.Path',side_effect=mapped_path),patch('subprocess.run',side_effect=command),patch('os.chown'), \
                patch('os.execvp',side_effect=start),patch('os.sysconf',side_effect=lambda name: {'SC_PHYS_PAGES':8_388_608,'SC_PAGE_SIZE':4096}[name]),patch('os.cpu_count',return_value=8):
            exec(self.code,{'__name__':'__main__'})

    def test_provider_keys_are_private_files_and_container_has_host_recovery_budget(self):
        self.run_start()
        self.assertEqual(len(self.started),1)
        args=self.started[0]
        serialized=' '.join(args)
        for filename,content in [('access-key',self.key),('atlas-key',b'atlas-test-key'),('fal-key',b'fal-test-key')]:
            target=self.runtime/filename
            self.assertEqual(target.read_bytes(),content)
            self.assertEqual(target.stat().st_mode&0o777,0o400)
            self.assertNotIn(content.decode(),serialized)
        self.assertIn('WLT_API_KEY_FILE=/run/secrets/atlas-key',args)
        self.assertIn('FAL_KEY_FILE=/run/secrets/fal-key',args)
        self.assertIn('no-new-privileges',args)
        self.assertEqual(args[args.index('--memory')+1],str(24*1024**3))
        self.assertEqual(args[args.index('--memory-swap')+1],str(24*1024**3))
        self.assertEqual(args[args.index('--cpus')+1],'7')

    def test_missing_optional_providers_start_without_mounting_old_keys(self):
        self.values.pop('GESSO_ATLAS_SECRET_ARN');self.values.pop('GESSO_FAL_SECRET_ARN')
        self.config.write_text(json.dumps(self.values))
        self.run_start()
        self.assertNotIn('WLT_API_KEY_FILE',' '.join(self.started[0]))
        self.assertNotIn('FAL_KEY_FILE',' '.join(self.started[0]))

    def test_rejected_or_malformed_provider_secret_never_starts_the_app(self):
        self.runtime.mkdir(mode=0o700)
        previous=self.runtime/'atlas-key';previous.write_bytes(b'previous-valid-provider-key')
        previous.chmod(0o400)
        with self.assertRaisesRegex(SystemExit,'Cannot load a configured Gesso secret') as error:
            self.run_start(rejected='atlas-arn')
        self.assertNotIn('private-provider-response',str(error.exception))
        self.assertEqual(self.started,[])
        self.assertEqual(previous.read_bytes(),b'previous-valid-provider-key')
        for value in (b'{"key":"private"}',b'line1\nline2',b'key with spaces'):
            self.secrets['atlas-arn']=value
            with self.assertRaisesRegex(SystemExit,'plain key on one line'):
                self.run_start()
        self.assertEqual(self.started,[])
