"""Run inside pinned Blender; render a small real Cycles frame for host checks."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from film.render_devices import configure_cycles_device


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    if bpy.app.version != (4, 3, 2):
        raise RuntimeError('Runtime proof requires Blender 4.3.2')
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 1
    scene.render.resolution_x = 32
    scene.render.resolution_y = 32
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = str(args.output.with_suffix('.png'))
    preferences = bpy.context.preferences.addons['cycles'].preferences
    execution = configure_cycles_device(scene, preferences, 'AUTO', denoising=False)
    # Selection alone is insufficient: missing kernels/driver features fail here.
    bpy.ops.render.render(write_still=True)
    payload = Path(scene.render.filepath).read_bytes()
    if not payload.startswith(b'\x89PNG\r\n\x1a\n'):
        raise RuntimeError('Cycles runtime proof did not produce a PNG')
    args.output.write_text(json.dumps({'engine': 'CYCLES', 'blenderVersion': bpy.app.version_string,
        'rendered': True, 'width': 32, 'height': 32, 'samples': 1, 'execution': execution,
        'imageSha256': hashlib.sha256(payload).hexdigest(), 'imageBytes': len(payload)})+'\n')


if __name__ == '__main__':
    main()
