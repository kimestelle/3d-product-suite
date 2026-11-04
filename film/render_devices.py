"""Choose an available Cycles device without changing the requested image profile.

This helper has no bpy dependency so device selection and resume rules can be
tested without starting Blender. Jobs freeze this module beside their renderer.
"""
import os
import platform as system_platform
import sys
import json
from pathlib import Path

POLICIES = ('AUTO', 'CPU', 'METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI')


def normalize_policy(value):
    policy = str(value).upper()
    if policy not in POLICIES:
        raise ValueError('GESSO_CYCLES_DEVICE must be AUTO, CPU, METAL, OPTIX, CUDA, HIP or ONEAPI')
    return policy


def execution_policy(output, environ=None):
    """A job's frozen policy wins over a later server environment change."""
    environ = os.environ if environ is None else environ
    job = Path(output) / 'job.json'
    if job.is_file():
        profile = json.loads(job.read_text())['renderProfile']
        # Historical jobs were created with the portable CPU reference profile.
        frozen = profile.get('executionPolicy', {'cycles': 'CPU', 'denoising': False})
        return {'cycles': normalize_policy(frozen['cycles']), 'denoising': frozen['denoising'] is True}
    return {'cycles': normalize_policy(environ.get('GESSO_CYCLES_DEVICE', 'AUTO')),
            'denoising': environ.get('GESSO_CYCLES_DENOISE', '') == '1'}


def _valid_execution(value):
    if (not isinstance(value, dict) or value.get('policy') not in POLICIES
            or value.get('backend') not in POLICIES[1:] or not isinstance(value.get('devices'), list)
            or not isinstance(value.get('system'), dict)
            or any(not isinstance(value['system'].get(key), str) or not value['system'][key]
                   for key in ('platform', 'release', 'version', 'architecture'))):
        return False
    if value['backend'] == 'CPU':
        if value['devices']:
            return False
    elif not value['devices'] or any(not isinstance(device, dict)
            or any(not isinstance(device.get(key), str) or not device[key] for key in ('id', 'name', 'type'))
            or device['type'] != value['backend'] for device in value['devices']):
        return False
    denoiser = value.get('denoiser')
    return (isinstance(denoiser, dict) and type(denoiser.get('enabled')) is bool
            and denoiser == ({'enabled': True, 'algorithm': 'OPENIMAGEDENOISE', 'backend': 'CPU'}
                             if denoiser['enabled'] else {'enabled': False, 'algorithm': None, 'backend': None}))


def previous_execution(output, frames):
    """A lost receipt cannot authorize another backend over existing 3D pixels."""
    output = Path(output)
    has_pixels = any((output / 'frames' / f"{sample['frame']:06d}.png").exists() for sample in frames
                     if sample.get('clip', {}).get('kind', 'scene') == 'scene')
    has_pixels = has_pixels or (output / 'raw-frame-digests.json').exists()
    config = output / 'render-config.json'
    try:
        if config.is_symlink():
            raise ValueError('Execution receipt must be a regular job file')
        value = json.loads(config.read_text())['execution']
        if not _valid_execution(value):
            raise ValueError('Execution receipt is invalid')
        return value
    except (OSError, ValueError, KeyError, TypeError) as error:
        if has_pixels:
            raise ValueError('Existing scene frames require their valid Cycles execution receipt; create a new job directory') from error
        return None


def configure_cycles_device(scene, preferences, policy='AUTO', previous=None, platform=None, denoising=False):
    policy = normalize_policy(policy)
    platform = sys.platform if platform is None else platform
    candidates = (['METAL'] if platform == 'darwin' else ['OPTIX', 'CUDA', 'HIP', 'ONEAPI']) if policy == 'AUTO' else [policy]
    record = {'policy': policy, 'backend': 'CPU', 'devices': [],
              'system': {'platform': sys.platform, 'release': system_platform.release(),
                         'version': system_platform.version(), 'architecture': system_platform.machine()},
              # OIDN can silently fall back from a requested GPU to CPU. Pin CPU
              # explicitly so the recorded denoiser device is the actual one.
              'denoiser': {'enabled': bool(denoising), 'algorithm': 'OPENIMAGEDENOISE' if denoising else None,
                           'backend': 'CPU' if denoising else None}}
    failures = []
    scene.cycles.device = 'CPU'
    if policy != 'CPU' and preferences is not None:
        for backend in candidates:
            try:
                preferences.compute_device_type = backend
                preferences.get_devices()
                available = [device for device in preferences.devices if device.type == backend]
                if not available:
                    failures.append(f'{backend}: no available device')
                    continue
                for device in preferences.devices:
                    device.use = device.type == backend
                scene.cycles.device = 'GPU'
                record.update(backend=backend, devices=sorted([
                    {'id': device.id, 'name': device.name, 'type': device.type} for device in available
                ], key=lambda value: value['id']))
                break
            except Exception as error:
                failures.append(f'{backend}: {type(error).__name__}: {error}')
    if record['backend'] == 'CPU':
        if preferences is not None:
            for device in preferences.devices:
                device.use = device.type == 'CPU'
        if policy != 'CPU':
            record['fallbackReason'] = '; '.join(failures) or 'Cycles GPU preferences unavailable'
    # Once frames may exist, a different backend/device requires a fresh job.
    # This also prevents a temporary GPU outage from silently mixing CPU frames.
    if previous is not None and any(previous.get(key) != record[key] for key in ('policy', 'backend', 'devices', 'system', 'denoiser')):
        raise ValueError('Cycles execution device changed after this job started; create a new job directory')
    return record
