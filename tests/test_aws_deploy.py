"""Offline deployment packets and read-only admission checks; no AWS credentials."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from scripts.aws_deploy import FILES, prepare, preflight

IMAGE='123456789012.dkr.ecr.us-east-1.amazonaws.com/gesso-render@sha256:'+'a'*64


class Reader:
    def __init__(self):
        self.calls=[]
        self.account='123456789012';self.quota=16;self.active=[]
        self.ami={'ImageId':'ami-0123456789abcdef0','Architecture':'x86_64','State':'available',
            'RootDeviceName':'/dev/sda1','OwnerId':'amazon','Name':'GPU base',
            'BlockDeviceMappings':[{'DeviceName':'/dev/sda1','Ebs':{'VolumeSize':60,'SnapshotId':'snap-123'}}]}
        self.snapshot_size=60;self.offered=True
        self.volume={'VolumeId':'vol-0123456789abcdef0','Encrypted':True,'AvailabilityZone':'us-east-1a','State':'available','Size':100}
        self.digest='sha256:'+'a'*64

    def call(self,*args):
        self.calls.append(args)
        operation=args[:2]
        if operation==('sts','get-caller-identity'):return {'Account':self.account,'Arn':'arn:aws:iam::'+self.account+':user/test'}
        if operation==('service-quotas','get-service-quota'):return {'Quota':{'Value':self.quota}}
        if operation==('ec2','describe-instance-types'):
            types=args[args.index('--instance-types')+1:]
            return {'InstanceTypes':[{'InstanceType':item,'VCpuInfo':{'DefaultVCpus':4 if item.endswith('.xlarge') else 8},
                'ProcessorInfo':{'SupportedArchitectures':['x86_64']},'GpuInfo':{'Gpus':[{'Manufacturer':'NVIDIA'}]}} for item in types]}
        if operation==('ec2','describe-instances'):return {'Reservations':[{'Instances':self.active}]}
        if operation==('ssm','get-parameter'):return {'Parameter':{'Value':self.ami['ImageId']}}
        if operation==('ec2','describe-images'):return {'Images':[copy.deepcopy(self.ami)]}
        if operation==('ec2','describe-snapshots'):return {'Snapshots':[{'State':'completed','VolumeSize':self.snapshot_size}]}
        if operation==('ec2','describe-instance-type-offerings'):return {'InstanceTypeOfferings':[{'Location':'us-east-1a'}] if self.offered else []}
        if operation==('ec2','describe-availability-zones'):return {'AvailabilityZones':[{'ZoneId':'use1-az1','State':'available'}]}
        if operation==('ec2','describe-volumes'):return {'Volumes':[copy.deepcopy(self.volume)]}
        if operation==('ecr','describe-images'):return {'imageDetails':[{'imageDigest':self.digest,'imageSizeInBytes':1234}]}
        raise AssertionError('Unexpected AWS operation: '+repr(args))


class AwsDeployTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)/'source';self.root.mkdir()
        (self.root/'infra/aws').mkdir(parents=True)
        for name in FILES:
            (self.root/'infra/aws'/name).write_text('#!/bin/sh\necho bootstrap\n' if name.endswith('.sh') else '{}\n')
        for command in (['git','init','-q'],['git','add','infra'],['git','-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','fixture']):
            subprocess.run(command,cwd=self.root,check=True,capture_output=True)
        self.output=Path(temporary.name)/'packet'

    def prepare(self,**options):
        return prepare(region='us-east-1',domain='studio.example.com',image_uri=IMAGE,output=self.output,root=self.root,**options)

    def check(self,reader=None,fetch=None):
        return preflight(self.output/'plan.json',root=self.root,reader=reader or Reader(),fetch=fetch or (lambda url:(self.output/'bootstrap.sh').read_bytes()))

    def test_prepare_is_offline_preserves_reviewed_files_and_prints_no_execute_command(self):
        plan,commands=self.prepare()
        self.assertTrue(plan['sourceCommitted'])
        for name in FILES:self.assertEqual((self.output/name).read_bytes(),(self.root/'infra/aws'/name).read_bytes())
        self.assertIn(plan['sourceCommit'],plan['bootstrapUrl'])
        self.assertIn('create-change-set',commands['createChangeSet'])
        self.assertNotIn('execute-change-set',json.dumps(commands))
        self.assertFalse((self.output/'parameters.json').exists())
        with self.assertRaisesRegex(ValueError,'existing review packets'):self.prepare()

    def test_uncommitted_or_changed_source_never_runs_cloud_checks(self):
        (self.root/'infra/aws/bootstrap.sh').write_text('uncommitted\n')
        plan,_=self.prepare();self.assertFalse(plan['sourceCommitted'])
        reader=Reader();report=self.check(reader)
        self.assertEqual(report['status'],'failed');self.assertEqual(reader.calls,[])
        self.assertIn('uncommitted draft',report['errors'][0])
        self.assertFalse((self.output/'parameters.json').exists())

    def test_packet_tampering_or_missing_published_bootstrap_never_runs_cloud_checks(self):
        self.prepare();(self.output/'bootstrap.sh').write_text('modified\n')
        reader=Reader();report=self.check(reader)
        self.assertEqual(reader.calls,[]);self.assertIn('differs',report['errors'][0])
        (self.output/'bootstrap.sh').write_bytes((self.root/'infra/aws/bootstrap.sh').read_bytes())
        report=self.check(reader,lambda url:b'wrong published content')
        self.assertEqual(reader.calls,[]);self.assertIn('published bootstrap',report['errors'][0])

    def test_image_is_digest_pinned_and_same_region_before_creating_any_packet(self):
        for image in (IMAGE.replace('@sha256:',':latest-'),IMAGE.replace('us-east-1','us-west-2')):
            with self.subTest(image=image),self.assertRaisesRegex(ValueError,'same-region'):
                prepare(domain='studio.example.com',image_uri=image,output=self.output,root=self.root)
        self.assertFalse(self.output.exists())

    def test_domain_storage_and_existing_volume_require_explicit_safe_inputs(self):
        for domain in ('https://studio.example.com','*.example.com','127.0.0.1','studio.example.com:443','localhost'):
            with self.subTest(domain=domain),self.assertRaises(ValueError):
                prepare(domain=domain,image_uri=IMAGE,output=self.output,root=self.root)
        for options in ({'root_gib':59},{'workspace_gib':19},{'existing_volume_id':'vol-0123456789abcdef0'},{'availability_zone':'us-west-2a'}):
            with self.subTest(options=options),self.assertRaises(ValueError):self.prepare(**options)

    def test_read_only_preflight_pins_ami_zone_and_parameters_without_secrets(self):
        plan,_=self.prepare();reader=Reader();report=self.check(reader)
        self.assertEqual(report['status'],'ok',report['errors'])
        parameters={item['ParameterKey']:item['ParameterValue'] for item in json.loads((self.output/'parameters.json').read_text())}
        self.assertEqual(parameters['AmiId'],reader.ami['ImageId'])
        self.assertEqual(parameters['AvailabilityZone'],'us-east-1a')
        self.assertEqual(parameters['RootDeviceName'],'/dev/sda1')
        self.assertEqual(parameters['BootstrapSha256'],plan['bootstrapSha256'])
        self.assertEqual(parameters['ImageUri'],IMAGE)
        self.assertEqual(parameters['ExistingWorkspaceVolumeId'],'')
        self.assertNotIn('AccessKey',json.dumps(parameters))
        for call in reader.calls:self.assertTrue(call[1].startswith(('describe-','get-')))

    def test_wrong_account_or_missing_image_digest_does_not_generate_launch_parameters(self):
        self.prepare();reader=Reader();reader.account='111111111111'
        self.assertIn('same account',self.check(reader)['errors'][0])
        reader.account='123456789012';reader.digest='sha256:'+'b'*64
        self.assertIn('digest',self.check(reader)['errors'][0])
        self.assertFalse((self.output/'parameters.json').exists())

    def test_quota_subtracts_active_on_demand_gpu_usage_but_not_spot(self):
        self.prepare();reader=Reader();reader.quota=8
        reader.active=[{'InstanceType':'g6.xlarge'}]
        report=self.check(reader)
        self.assertEqual(report['status'],'failed');self.assertIn('4 vCPUs available',report['errors'][0])
        reader.active[0]['InstanceLifecycle']='spot'
        self.assertEqual(self.check(reader)['status'],'ok')

    def test_ami_architecture_root_snapshot_size_and_az_offering_are_checked(self):
        self.prepare();reader=Reader();reader.ami['Architecture']='arm64'
        self.assertIn('x86_64',self.check(reader)['errors'][0])
        reader.ami['Architecture']='x86_64';reader.snapshot_size=120
        self.assertIn('--root-gib 120',self.check(reader)['errors'][0])
        reader.snapshot_size=60;reader.offered=False
        self.assertIn('not offered',self.check(reader)['errors'][0])
        self.assertFalse((self.output/'parameters.json').exists())

    def test_existing_volume_must_be_encrypted_unattached_and_same_zone(self):
        self.prepare(existing_volume_id='vol-0123456789abcdef0',availability_zone='us-east-1a')
        for change in ({'Encrypted':False},{'State':'in-use'},{'AvailabilityZone':'us-east-1b'}):
            reader=Reader();reader.volume.update(change)
            self.assertIn('encrypted, unattached',self.check(reader)['errors'][0])
        report=self.check();self.assertEqual(report['status'],'ok',report['errors'])
        self.assertEqual(report['checks']['workspaceVolume']['format'],'never format an existing volume')

    def test_failed_repeat_check_invalidates_prior_parameters_but_retains_evidence(self):
        self.prepare();self.assertEqual(self.check()['status'],'ok')
        old=(self.output/'parameters.json').read_bytes()
        reader=Reader();reader.quota=0
        report=self.check(reader)
        self.assertEqual(report['status'],'failed')
        self.assertFalse((self.output/'parameters.json').exists())
        self.assertEqual((self.output/report['previousParameters']).read_bytes(),old)
        # Source-file changes must invalidate prior successful parameters too.
        self.assertEqual(self.check()['status'],'ok')
        (self.output/'bootstrap.sh').write_text('modified after review\n')
        self.assertEqual(self.check()['status'],'failed')
        self.assertFalse((self.output/'parameters.json').exists())
