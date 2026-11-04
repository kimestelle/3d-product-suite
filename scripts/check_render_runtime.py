#!/usr/bin/env python3
"""Read-only deployment check: real Cycles frame + production WebGL2 context.

Run in the application container, as its normal gesso user, while the backend is
healthy: python scripts/check_render_runtime.py --url http://127.0.0.1:8787 --require-gpu
No source assets, campaigns, provider requests or render-queue jobs are created.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from film.jobs import BLENDER_VERSION, FFMPEG_VERSION, _check_tool


def subprocess_json(command, *, timeout):
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-4000:].strip() or 'Runtime subprocess failed')
    return json.loads(result.stdout)


def load_access_key_file():
    """docker exec does not inherit the entrypoint's process environment."""
    path = os.environ.get('GESSO_ACCESS_KEY_FILE')
    if not path:
        return
    if 'GESSO_ACCESS_KEY' in os.environ:
        raise ValueError('Set only GESSO_ACCESS_KEY or GESSO_ACCESS_KEY_FILE, not both.')
    value = Path(path).read_text().rstrip('\n')
    if len(value) < 32:
        raise ValueError('The workspace access-key file must contain at least 32 characters.')
    os.environ['GESSO_ACCESS_KEY'] = value
    os.environ.pop('GESSO_ACCESS_KEY_FILE')


def verify_runtime(*, blender='blender', ffmpeg='ffmpeg', node='node', url='http://127.0.0.1:8787', require_gpu=False, capture_device='auto'):
    result = {'schemaVersion':1, 'checkedAt':datetime.now(timezone.utc).isoformat(),
              'requireGpu':require_gpu, 'checks':{}, 'errors':[]}
    for name, command, expected in [('blender',blender,BLENDER_VERSION),('ffmpeg',ffmpeg,FFMPEG_VERSION)]:
        try:
            result['checks'][name] = _check_tool(command, name, expected)
        except Exception as error:
            result['errors'].append(f'{name}: {error}')
    try:
        with tempfile.TemporaryDirectory(prefix='gesso-runtime-') as directory:
            receipt = Path(directory)/'cycles.json'
            subprocess.run([blender,'--background','--factory-startup','--python-exit-code','1',
                            '--python',str(ROOT/'scripts/blender_runtime_probe.py'),'--','--output',str(receipt)],
                           cwd=ROOT, capture_output=True, text=True, check=True, timeout=300)
            cycles = json.loads(receipt.read_text())
            if not cycles.get('rendered') or cycles.get('engine') != 'CYCLES':
                raise ValueError('Cycles frame proof is incomplete')
            result['checks']['cycles'] = cycles
            if require_gpu and cycles['execution']['backend'] == 'CPU':
                result['errors'].append('Cycles rendered on CPU; NVIDIA/CUDA/OptiX is not verified.')
    except subprocess.CalledProcessError as error:
        result['errors'].append('Cycles test render failed: '+(error.stderr or error.stdout or '')[-4000:].strip())
    except Exception as error:
        result['errors'].append(f'Cycles test render: {error}')
    try:
        capture = subprocess_json([node,str(ROOT/'scripts/probe_capture_runtime.mjs'),url,capture_device],timeout=150)
        result['checks']['capture'] = capture
        if require_gpu and (not capture.get('contextVerified') or capture['execution']['backend'] != 'hardware'):
            result['errors'].append('Gaussian capture has no verified hardware WebGL2 context.')
    except Exception as error:
        result['errors'].append(f'Gaussian capture: {error}')
    result['status'] = 'failed' if result['errors'] else 'ok'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blender',default='blender')
    parser.add_argument('--ffmpeg',default='ffmpeg')
    parser.add_argument('--node',default='node')
    parser.add_argument('--url',default='http://127.0.0.1:8787')
    parser.add_argument('--require-gpu',action='store_true')
    parser.add_argument('--capture-device',choices=['auto','hardware','software'],default=os.environ.get('GESSO_CAPTURE_DEVICE','auto'))
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    try:
        load_access_key_file()
        result=verify_runtime(blender=args.blender,ffmpeg=args.ffmpeg,node=args.node,url=args.url,require_gpu=args.require_gpu,capture_device=args.capture_device)
    except Exception:
        # A mounted secret path/value is not diagnostic output.
        result={'schemaVersion':1,'status':'failed','checks':{},'errors':['Cannot load the workspace access-key file; check file ownership and key configuration.']}
    text=json.dumps(result,indent=2)+'\n'
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(text)
    print(text,end='')
    return 0 if result['status']=='ok' else 1


if __name__ == '__main__':
    sys.exit(main())
