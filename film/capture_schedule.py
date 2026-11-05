"""Frame-boundary GPU handoff for the canonical Spark export capture."""
import json
import os
from pathlib import Path
import uuid

from . import jobs
from .proof_inputs import digest
from .render_arbitration import background_render_slot


def _validated_yield(output, token, requested):
    path = output/'capture-yield.json'
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 512*1024:
            raise ValueError()
        value = json.loads(path.read_text())
        payload = json.loads((output/'samples.json').read_text())
        job = jobs._read_job(output)
        manifest = json.loads((output/'plate'/'capture-manifest.json').read_text())
        completed = value['completed']
        numbers = [item['frame'] for item in completed]
        if (value.get('schemaVersion') != 1 or value.get('token') != token
                or value.get('sourceDigest') != job['sceneDigest']
                or value.get('samplesDigest') != digest(payload)
                or manifest.get('sourceDigest') != job['sceneDigest']
                or manifest.get('samplesDigest') != value['samplesDigest']
                or manifest.get('profile', {}).get('frameNumbers') != requested
                or len(set(numbers)) != len(numbers) or numbers != sorted(numbers)
                or any(type(number) is not int or number not in requested for number in numbers)
                or len(numbers) >= len(requested)):
            raise ValueError()
        if not numbers and (value.get('retainedFullSource') is not True
                            or manifest.get('profile', {}).get('worldCopy', {}).get('status') != 'full-source'):
            raise ValueError()
        profile = job['renderProfile']
        for item in completed:
            frame = item['frame']
            actual = jobs._inspect_png(output/'plate'/f'{frame:06d}.png',profile['width'],profile['height'])
            if actual is None or actual != item.get('sha256') or manifest['frames'].get(str(frame)) != actual:
                raise ValueError()
        path.unlink()
        return numbers
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError) as error:
        raise RuntimeError('Gaussian capture yield does not match its pinned source and completed plates.') from error


def run_scheduled_capture(command, output, log_name, *, worker_fd=None):
    """Release the GPU after a complete Spark draw when a current proof waits.

    The unchanged command resumes against its immutable manifest. A pending
    camera-copy quality gate yields to full-source rendering; it cannot approve
    fewer test frames or substitute an unverified derivative.
    """
    output = Path(output)
    requested = sorted(int(value) for value in command[command.index('--frames')+1].split(','))
    previous = None
    while True:
        jobs._check_cancel(output)
        with background_render_slot(output, cancel=lambda:jobs._check_cancel(output)) as scheduling:
            token = uuid.uuid4().hex
            (output/'capture-yield.json').unlink(missing_ok=True)
            environment = {**os.environ, 'GESSO_CAPTURE_BATCH_TOKEN':token,
                           'GESSO_PROOF_DEMAND_PATH':scheduling['proofDemandPath']}
            jobs._run_process_unlocked(command, output, log_name, worker_fd=worker_fd,
                environment=environment, extra_fds=(scheduling['gpuLockFd'],))
            receipt = output/'capture-yield.json'
            if not receipt.exists() and not receipt.is_symlink():
                return
            completed = _validated_yield(output, token, requested)
            if previous is not None and len(completed) <= previous:
                raise RuntimeError('Gaussian capture yielded without making progress. Resume the export after proofs finish.')
            previous = len(completed)
