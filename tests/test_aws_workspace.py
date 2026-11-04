"""Infrastructure boundaries for the single persistent GPU workspace."""
import json
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
        self.assertFalse(any('AccessKey' in name or 'Secret' in name for name in self.template['Parameters']))
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
