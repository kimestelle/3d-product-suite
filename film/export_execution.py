"""Small, optional summaries of the renderer's actual execution receipts."""
import json
from pathlib import Path


def _record(path):
    try:
        path = Path(path)
        if path.is_symlink() or path.stat().st_size > 2 * 1024 * 1024:
            return {}
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def execution_summary(output):
    """Report measured backends only; an AUTO request is not evidence of a GPU."""
    output = Path(output)
    result = {}
    cycles = _record(output / 'render-config.json').get('execution')
    if isinstance(cycles, dict) and cycles.get('backend') in ('CPU', 'METAL', 'OPTIX', 'CUDA', 'HIP', 'ONEAPI'):
        result['cycles'] = {'backend': cycles['backend']}
        devices = cycles.get('devices', [])
        if isinstance(devices, list):
            result['cycles']['devices'] = [
                {'name': device['name'][:256], 'type': str(device.get('type', ''))[:32]}
                for device in devices if isinstance(device, dict) and isinstance(device.get('name'), str)
            ][:16]
        reason = cycles.get('fallbackReason')
        if isinstance(reason, str) and reason:
            result['cycles']['fallbackReason'] = reason[:1024]
    profile = _record(output / 'plate' / 'capture-manifest.json').get('profile', {})
    capture = profile.get('execution') if isinstance(profile, dict) else None
    if isinstance(capture, dict) and capture.get('backend') in ('hardware', 'software'):
        result['gaussian'] = {'backend': capture['backend']}
        renderer = capture.get('unmaskedRenderer') or capture.get('renderer')
        if isinstance(renderer, str):
            result['gaussian']['renderer'] = renderer[:256]
    return result
