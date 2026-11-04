#!/usr/bin/env python3
"""Prepare a review packet or run read-only AWS deployment checks. Never launch resources."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from film.hosting import https_origin

FILES = ('workspace.json', 'registry.json', 'bootstrap.sh')
INSTANCE_TYPES = ('g6.xlarge', 'g6.2xlarge', 'g5.2xlarge')
AMI_PARAMETER = '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id'
GPU_QUOTA = 'L-DB2E81BA'
PUBLIC_REPOSITORY = 'https://raw.githubusercontent.com/kimestelle/3d-product-suite'
REGION = re.compile(r'(?:us|eu|ap|sa|ca|me|af|il|mx)-[a-z]+-[0-9]+\Z')
ECR = re.compile(r'(?P<account>[0-9]{12})\.dkr\.ecr\.(?P<region>[a-z0-9-]+)\.amazonaws\.com/(?P<repository>[a-z0-9]+(?:[._/-][a-z0-9]+)*)@(?P<digest>sha256:[a-f0-9]{64})\Z')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False)+'\n')


def bootstrap_url(commit):
    return f'{PUBLIC_REPOSITORY}/{commit}/infra/aws/bootstrap.sh'


def committed_bytes(root, commit, name):
    return subprocess.check_output(['git', 'show', f'{commit}:infra/aws/{name}'], cwd=root, stderr=subprocess.DEVNULL)


def commands(packet, plan, profile=None):
    base=['aws','--region',plan['region']]
    if profile:
        base += ['--profile',profile]
    scope=['--stack-name',plan['stackName'],'--change-set-name','gesso-'+plan['sourceCommit'][:12]]
    return {
        'preflight':shlex.join([sys.executable,str(ROOT/'scripts/aws_deploy.py'),'preflight','--plan',str(packet/'plan.json'),*(['--profile',profile] if profile else [])]),
        'createChangeSet':shlex.join([*base,'cloudformation','create-change-set',*scope,'--change-set-type','CREATE',
            '--capabilities','CAPABILITY_NAMED_IAM','--template-body','file://'+str(packet/'workspace.json'),
            '--parameters','file://'+str(packet/'parameters.json')]),
        'reviewChangeSet':shlex.join([*base,'cloudformation','describe-change-set',*scope]),
    }


def prepare(*, region='us-east-1', domain, image_uri, output, instance_type='g6.2xlarge', availability_zone=None,
            existing_volume_id=None, workspace_gib=100, root_gib=80, ami_id=None,
            public_editor_url='https://gesso-studio-gold.vercel.app', stack_name='gesso-workspace', root=ROOT):
    require(bool(REGION.fullmatch(region)), 'Choose a standard commercial AWS region.')
    domain=domain.lower()
    label=r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    require(len(domain)<=253 and bool(re.fullmatch(label+r'(?:\.'+label+r')+',domain))
            and not re.fullmatch(r'[0-9.]+',domain), 'Backend domain must be an exact DNS hostname, without a scheme, port or wildcard.')
    image=ECR.fullmatch(image_uri)
    require(image is not None and image['region']==region, 'Image must be a same-region private ECR URI pinned with @sha256:<digest>.')
    require(instance_type in INSTANCE_TYPES, 'Unsupported GPU instance type.')
    require(type(workspace_gib) is int and 20<=workspace_gib<=4096, 'Workspace size must be 20–4096 GiB.')
    require(type(root_gib) is int and 60<=root_gib<=1024, 'Root size must be 60–1024 GiB.')
    require(bool(re.fullmatch(r'[A-Za-z][A-Za-z0-9-]{0,127}',stack_name)), 'Invalid CloudFormation stack name.')
    if availability_zone:
        require(bool(re.fullmatch(re.escape(region)+r'[a-z]{1,3}',availability_zone)), 'Availability zone must be a normal AZ in the selected region.')
    if existing_volume_id:
        require(availability_zone and bool(re.fullmatch(r'vol-(?:[a-f0-9]{8}|[a-f0-9]{17})',existing_volume_id)), 'An existing EBS volume requires its availability zone and a valid volume ID.')
    if ami_id:
        require(bool(re.fullmatch(r'ami-(?:[a-f0-9]{8}|[a-f0-9]{17})',ami_id)), 'Invalid AMI ID.')
    public_editor_url=https_origin(public_editor_url)
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    require(bool(re.fullmatch(r'[a-f0-9]{40}',commit)), 'Cannot identify the source commit.')
    sources={name:(root/'infra/aws'/name).read_bytes() for name in FILES}
    source_committed=True
    for name,content in sources.items():
        try:
            source_committed &= committed_bytes(root,commit,name)==content
        except subprocess.CalledProcessError:
            source_committed=False
    packet=Path(output).resolve()
    require(not packet.exists() or packet.is_dir() and not any(packet.iterdir()), 'Choose a new or empty output directory; existing review packets are preserved.')
    packet.mkdir(parents=True,exist_ok=True)
    for name,content in sources.items():
        (packet/name).write_bytes(content)
    plan={'schemaVersion':1,'preparedAt':datetime.now(timezone.utc).isoformat(),'sourceCommit':commit,
          'sourceCommitted':bool(source_committed),'region':region,'backendDomain':domain,'publicEditorUrl':public_editor_url,
          'imageUri':image_uri,'image':image.groupdict(),'instanceType':instance_type,'availabilityZone':availability_zone,
          'existingWorkspaceVolumeId':existing_volume_id or '', 'workspaceGiB':workspace_gib,'rootGiB':root_gib,'amiId':ami_id,
          'stackName':stack_name,'bootstrapUrl':bootstrap_url(commit),'bootstrapSha256':sha(sources['bootstrap.sh']),
          'files':{name:sha(content) for name,content in sources.items()},
          'limits':['One shared workspace and one serial queue; no horizontal replicas.',
                    'On-demand GPU charges start only if a reviewed change set is executed.',
                    'Prepare and preflight do not launch, stop, upload or modify cloud resources.']}
    plan['planSha256']=sha(json_bytes(plan))
    write_json(packet/'plan.json',plan)
    return plan,commands(packet,plan)


class AwsRead:
    def __init__(self,region,profile=None):
        self.base=['aws','--no-cli-pager','--region',region]
        if profile:self.base += ['--profile',profile]

    def call(self,*args):
        # This wrapper has no mutation operation. All permitted calls are below.
        result=subprocess.run([*self.base,*args,'--output','json'],capture_output=True,text=True,timeout=90,
            env={**os.environ,'AWS_PAGER':'','AWS_CLI_AUTO_PROMPT':'off','AWS_MAX_ATTEMPTS':'3'})
        if result.returncode:
            raise RuntimeError((result.stderr or 'AWS read failed').strip()[-2000:])
        return json.loads(result.stdout)


def public_bootstrap(url):
    with urlopen(url,timeout=30) as response:
        content=response.read(512*1024+1)
    require(len(content)<=512*1024,'Published bootstrap exceeds the supported size.')
    return content


def validate_packet(path,root=ROOT):
    packet=Path(path).resolve().parent
    plan=json.loads(Path(path).read_text())
    digest=plan.get('planSha256')
    require(digest==sha(json_bytes({key:value for key,value in plan.items() if key!='planSha256'})), 'Review plan changed; prepare a new packet.')
    require(plan.get('schemaVersion')==1 and plan.get('sourceCommitted') is True,'This is an uncommitted draft. Commit the deployment files, then prepare a fresh packet before preflight.')
    commit=plan['sourceCommit']
    require(bool(re.fullmatch(r'[a-f0-9]{40}',commit)), 'Invalid source commit.')
    require(plan['bootstrapUrl']==bootstrap_url(commit),'Bootstrap URL must point to the exact reviewed source commit.')
    for name in FILES:
        content=(packet/name).read_bytes()
        require(sha(content)==plan['files'][name],f'{name} differs from the review packet.')
        require(content==committed_bytes(root,commit,name),f'{name} does not match the pinned source commit.')
    require(plan['bootstrapSha256']==plan['files']['bootstrap.sh'],'Bootstrap hash differs from the reviewed file.')
    require(bool(REGION.fullmatch(plan['region'])),'Unsupported region.')
    match=ECR.fullmatch(plan['imageUri'])
    require(match is not None and match.groupdict()==plan['image'] and match['region']==plan['region'],'Private ECR image identity changed.')
    return packet,plan


def preflight(plan_path,*,profile=None,root=ROOT,reader=None,fetch=public_bootstrap):
    packet=Path(plan_path).resolve().parent
    report={'schemaVersion':1,'checkedAt':datetime.now(timezone.utc).isoformat(),'status':'failed','checks':{},'errors':[]}
    try:
        # A repeat check cannot leave launch parameters from an earlier pass at
        # the printed command's path. Preserve that regenerable file as evidence.
        initial=json.loads(Path(plan_path).read_text())
        require(initial.get('schemaVersion')==1 and set(initial.get('files',{}))==set(FILES),'This is not a generated deployment review packet.')
        previous=packet/'parameters.json'
        if previous.exists() or previous.is_symlink():
            require(previous.is_file() and not previous.is_symlink(),'Generated parameters must be a regular packet file.')
            stale='parameters.stale-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')+'.json'
            previous.rename(packet/stale)
            report['previousParameters']=stale
        packet,plan=validate_packet(plan_path,root)
        report['planSha256']=plan['planSha256']
        require(sha(fetch(plan['bootstrapUrl']))==plan['bootstrapSha256'],'The published bootstrap does not match the pinned source. Push the reviewed commit before preflight.')
        report['checks']['publishedSource']={'commit':plan['sourceCommit'],'bootstrapSha256':plan['bootstrapSha256']}
        aws=reader or AwsRead(plan['region'],profile)
        identity=aws.call('sts','get-caller-identity')
        require(identity['Account']==plan['image']['account'],'AWS credentials and private ECR image must belong to the same account.')
        report['checks']['account']={'account':identity['Account'],'arn':identity['Arn']}
        instance=aws.call('ec2','describe-instance-types','--instance-types',plan['instanceType'])['InstanceTypes'][0]
        require('x86_64' in instance['ProcessorInfo']['SupportedArchitectures'] and instance.get('GpuInfo',{}).get('Gpus'),'The selected instance must support x86_64 and a GPU.')
        required=instance['VCpuInfo']['DefaultVCpus']
        quota=aws.call('service-quotas','get-service-quota','--service-code','ec2','--quota-code',GPU_QUOTA)['Quota']['Value']
        usage=aws.call('ec2','describe-instances','--filters','Name=instance-state-name,Values=pending,running','Name=instance-type,Values=g*,vt*')
        active=[item for reservation in usage['Reservations'] for item in reservation['Instances'] if item.get('InstanceLifecycle') in (None,'on-demand')]
        used=0
        if active:
            types=sorted({item['InstanceType'] for item in active})
            counts={item['InstanceType']:item['VCpuInfo']['DefaultVCpus'] for item in aws.call('ec2','describe-instance-types','--instance-types',*types)['InstanceTypes']}
            used=sum(counts[item['InstanceType']] for item in active)
        require(quota-used>=required,f'G/VT On-Demand quota has {quota-used:g} vCPUs available; this instance requires {required}. Request quota {GPU_QUOTA} or free capacity first.')
        report['checks']['quota']={'code':GPU_QUOTA,'quotaVcpus':quota,'observedActiveVcpus':used,'requiredVcpus':required,
            'limit':'Running/pending On-Demand instance usage only; quota and offerings do not reserve launch capacity.'}
        ami_id=plan['amiId'] or aws.call('ssm','get-parameter','--name',AMI_PARAMETER)['Parameter']['Value']
        ami_args=['ec2','describe-images','--image-ids',ami_id]
        if not plan['amiId']:ami_args += ['--owners','amazon']
        images=aws.call(*ami_args)['Images']
        require(len(images)==1 and images[0]['Architecture']=='x86_64' and images[0]['State']=='available','The pinned GPU AMI must be available and x86_64.')
        ami=images[0];device=ami['RootDeviceName']
        require(device in ('/dev/sda1','/dev/xvda'),'The AMI uses an unsupported root device.')
        root_ebs=next(item['Ebs'] for item in ami['BlockDeviceMappings'] if item['DeviceName']==device and 'Ebs' in item)
        root_size=root_ebs.get('VolumeSize',0)
        if root_ebs.get('SnapshotId'):
            snapshots=aws.call('ec2','describe-snapshots','--snapshot-ids',root_ebs['SnapshotId'])['Snapshots']
            require(len(snapshots)==1 and snapshots[0]['State']=='completed','The AMI root snapshot is unavailable.')
            root_size=max(root_size,snapshots[0]['VolumeSize'])
        require(type(root_size) is int and root_size>0,'Cannot establish the AMI root disk minimum size.')
        require(plan['rootGiB']>=root_size,f'The AMI needs at least {root_size} GiB for its root disk; prepare again with --root-gib {root_size}.')
        report['checks']['ami']={'id':ami_id,'owner':ami.get('OwnerId'),'name':ami.get('Name'),'rootDeviceName':device,'minimumRootGiB':root_size,
            'source':'explicit AMI' if plan['amiId'] else AMI_PARAMETER}
        offerings=aws.call('ec2','describe-instance-type-offerings','--location-type','availability-zone','--filters','Name=instance-type,Values='+plan['instanceType'])['InstanceTypeOfferings']
        zones=sorted({item['Location'] for item in offerings})
        zone=plan['availabilityZone'] or (zones[0] if zones else None)
        require(zone in zones,'The requested GPU instance is not offered in this availability zone.')
        states=aws.call('ec2','describe-availability-zones','--zone-names',zone)['AvailabilityZones']
        require(len(states)==1 and states[0]['State']=='available','The selected availability zone is unavailable.')
        report['checks']['availabilityZone']={'name':zone,'zoneId':states[0]['ZoneId'],'instanceType':plan['instanceType']}
        if plan['existingWorkspaceVolumeId']:
            volumes=aws.call('ec2','describe-volumes','--volume-ids',plan['existingWorkspaceVolumeId'])['Volumes']
            require(len(volumes)==1,'Existing workspace volume is missing.')
            volume=volumes[0]
            require(volume['AvailabilityZone']==zone and volume['State']=='available' and volume['Encrypted'] is True,
                'The existing workspace must be encrypted, unattached/available, and in the chosen availability zone.')
            report['checks']['workspaceVolume']={'id':volume['VolumeId'],'availabilityZone':zone,'sizeGiB':volume['Size'],'encrypted':True,'format':'never format an existing volume'}
        details=aws.call('ecr','describe-images','--registry-id',identity['Account'],'--repository-name',plan['image']['repository'],'--image-ids','imageDigest='+plan['image']['digest'])['imageDetails']
        require(len(details)==1 and details[0]['imageDigest']==plan['image']['digest'],'The private release image digest is not present.')
        report['checks']['image']={'uri':plan['imageUri'],'digest':details[0]['imageDigest'],'sizeBytes':details[0].get('imageSizeInBytes'),
            'limit':'Digest existence is checked; the release workflow and host runtime proof validate execution.'}
        values={'AmiId':ami_id,'RootDeviceName':device,'AvailabilityZone':zone,'InstanceType':plan['instanceType'],
            'BackendDomain':plan['backendDomain'],'PublicEditorUrl':plan['publicEditorUrl'],'ImageUri':plan['imageUri'],
            'RepositoryName':plan['image']['repository'],'WorkspaceGiB':plan['workspaceGiB'],'RootGiB':plan['rootGiB'],
            'ExistingWorkspaceVolumeId':plan['existingWorkspaceVolumeId'],'BootstrapUrl':plan['bootstrapUrl'],'BootstrapSha256':plan['bootstrapSha256']}
        write_json(packet/'parameters.json',[{'ParameterKey':key,'ParameterValue':str(value)} for key,value in values.items()])
        report['status']='ok'
        report['commands']=commands(packet,plan,profile)
    except Exception as error:
        report['errors'].append(str(error))
    write_json(packet/'preflight.json',report)
    return report


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    create=sub.add_parser('prepare',help='Create an offline review packet; no AWS calls.')
    create.add_argument('--region',default='us-east-1');create.add_argument('--domain',required=True)
    create.add_argument('--image-uri',required=True);create.add_argument('--output',type=Path,required=True)
    create.add_argument('--instance-type',choices=INSTANCE_TYPES,default='g6.2xlarge')
    create.add_argument('--availability-zone');create.add_argument('--existing-volume-id')
    create.add_argument('--workspace-gib',type=int,default=100);create.add_argument('--root-gib',type=int,default=80)
    create.add_argument('--ami-id');create.add_argument('--public-editor-url',default='https://gesso-studio-gold.vercel.app')
    create.add_argument('--stack-name',default='gesso-workspace')
    check=sub.add_parser('preflight',help='Read-only AWS, source and storage checks; never launch resources.')
    check.add_argument('--plan',type=Path,required=True);check.add_argument('--profile')
    args=vars(parser.parse_args(argv));mode=args.pop('command')
    try:
        if mode=='prepare':
            plan,instructions=prepare(**{key.replace('-','_'):value for key,value in args.items()})
            print(json.dumps({'status':'prepared','sourceCommitted':plan['sourceCommitted'],'plan':str(args['output'].resolve()/'plan.json'),'commands':instructions},indent=2))
            return 0
        report=preflight(args.pop('plan'),**args)
        print(json.dumps(report,indent=2))
        return 0 if report['status']=='ok' else 1
    except (OSError,ValueError,subprocess.SubprocessError) as error:
        parser.error(str(error))


if __name__=='__main__':
    sys.exit(main())
