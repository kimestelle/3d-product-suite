"""Rebuild the three stills from the saved Auden material example and Gesso worlds.

Run after building web/dist, using the project's native dependencies:
.venv/bin/python web/src/assets/gesso/landing-worlds/render.py --handoff /path/to/gesso-video-handoff

No generation request or saved-project edit. Product source: native-blue-saved.json
(the same scene as the Materials example). Velvet and Atrium are Ximing Luo's
existing World Labs generations supplied with the five-film showcase.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from PIL import Image

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parents[4]
STORYBOARD = ROOT / 'outputs/gesso-storyboard-figma'
sys.path.insert(0, str(ROOT))
from film.scene import evaluate

# Saved showcase scene, original placement of the display, material for its new foreground plinth.
WORLDS = {
    'velvet': ('d014846739fbf827a4ff837a848376bea9fa9ef6a6537a9f3ca6a30b5a3a50ac',
               [.05, .53, -.75], [.17, .072, .055, 1]),
    'atrium': ('14abf434b2837c781086602f686e8382c1240b816875818722ed9b09b5bfa688',
               [-.1, .21, -.9], [.42, .38, .31, 1]),
}


def source_scene(stage, handoff, size, samples):
    scene = json.loads((STORYBOARD / 'current-ui/native-blue-saved.json').read_text())['scene']
    view = {'focalLengthMm': 50, 'positionM': [.16, .245, .66], 'targetM': [-.009, .152, 0]}
    scene['shots'] = [{'id': 'hero', 'name': 'World comparison', 'startFrame': 1, 'endFrame': 1,
                       'camera': {'from': view, 'to': copy.deepcopy(view)}}]
    scene['render'].update(width=size, height=size, durationFrames=1, samples=samples)
    if stage == 'studio':
        scene['environment']['worldColor'] = [.024, .071, .21]
    else:
        revision, placement, color = WORLDS[stage]
        world = json.loads((handoff / (revision + '.scene.json')).read_text())['environment']
        scene['environment'] = world
        # Put the new support's top at the product datum. The original world and
        # its matching collider both sit .16 m below that top.
        offset = [placement[0], placement[1] + .16, placement[2]]
        for asset in [world['asset'], world['collider']['asset']]:
            asset['translationM'] = [value - origin for value, origin in zip(asset['translationM'], offset)]
        world['studioSizeM'] = .32
        world['plinth'] = {'id': 'plinth', 'visible': True, 'sizeM': [.42, .16, .32],
                           'translationM': [0, -.08, 0],
                           'material': {'baseColor': color, 'roughness': .76, 'metallic': 0}}
    # Light the face from the sides to leave the type visible through the crystal.
    lighting = scene['lighting']
    lighting.pop('hdri', None)
    lighting.update(ambientStrength=.65, ambientColor=[.50, .57, .72])
    key, fill, rim = lighting['lights']
    key.update(positionM=[-.52, .63, .09], diameterM=.24, powerW=11)
    fill.update(positionM=[.60, .28, .12], diameterM=.26, powerW=4)
    rim.update(positionM=[-.08, .40, -.33], diameterM=.22, powerW=7)
    return scene


def asset_paths(value):
    if isinstance(value, dict):
        if 'path' in value and 'sha256' in value:
            yield Path(value['path'])
        for child in value.values():
            yield from asset_paths(child)
    elif isinstance(value, list):
        for child in value:
            yield from asset_paths(child)


def local_copy(source, destination):
    if destination.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copyfile(source, destination)


def surroundings_strip(folder):
    # Extract a real piece of set clear of the watch. Each crop stays square;
    # the studio shows the sweep, the theatre two folds, the atrium a wall joint.
    crops = {'studio': (.01, .45, .28), 'velvet': (.035, .17, .25), 'atrium': (.015, .19, .265)}
    strip = Image.new('RGB', (144, 48))
    for index, (stage, (x, y, extent)) in enumerate(crops.items()):
        with Image.open(folder / (stage + '.webp')) as plate:
            size = plate.width
            box = tuple(round(size * value) for value in (x, y, x + extent, y + extent))
            swatch = plate.crop(box).resize((48, 48), Image.Resampling.LANCZOS)
            strip.paste(swatch, (index * 48, 0))
    strip.save(folder / 'surroundings.webp', lossless=True, method=6)


def bake(args, job_root, server_port):
    capture_workspace = job_root / 'capture-workspace'
    capture_workspace.mkdir()
    env = dict(os.environ, GESSO_CYCLES_DENOISE='1', GESSO_CYCLES_DEVICE='AUTO')
    env.setdefault('PLAYWRIGHT_BROWSERS_PATH', str(ROOT / '.cache/playwright'))
    with (job_root / 'server.log').open('w') as log:
        server = subprocess.Popen([sys.executable, '-m', 'film', 'serve', '--host', '127.0.0.1',
                                   '--port', str(server_port), '--data-dir', str(capture_workspace)],
                                  cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(80):
                if server.poll() is not None:
                    raise RuntimeError('The temporary capture server failed to start.')
                try:
                    with socket.create_connection(('127.0.0.1', server_port), .2):
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError('Timed out waiting for the local capture server.')
            handoff = args.handoff / 'repo-extras/workspace-data'
            reference_frame = None
            for stage in ('studio', 'velvet', 'atrium'):
                job = job_root / stage
                scene = source_scene(stage, handoff, args.size, args.samples)
                for path in set(asset_paths(scene)):
                    source = STORYBOARD / 'ui-workspace' / path
                    if not source.exists():
                        source = handoff / path
                    local_copy(source, job / path)
                    local_copy(source, capture_workspace / path)
                samples = job / 'samples.json'
                frame = evaluate(scene, 1, include_placement=True)
                # A visible support can translate its dependent product. Verify
                # the resolved pose and lens before a single frame is rendered.
                registration = [frame[k] for k in ('components', 'parts', 'productPlacement', 'camera')]
                if reference_frame is None:
                    reference_frame = registration
                elif reference_frame != registration:
                    raise ValueError(f'{stage}: subject or camera moved between worlds')
                samples.write_text(json.dumps({'scene': scene, 'frames': [frame]}))
                if stage in WORLDS:
                    asset = scene['environment']['asset']['path']
                    subprocess.run(['node', 'scripts/capture_splats.mjs', '--url', f'http://127.0.0.1:{server_port}',
                                    '--asset-url', '/api/' + asset, '--samples', str(samples), '--output', str(job / 'plate'),
                                    '--width', str(args.size), '--height', str(args.size), '--frames', '1'],
                                   env=env, cwd=ROOT, check=True)
                subprocess.run([str(args.blender), '-b', '-t', '4', '--python-exit-code', '3',
                                '-P', str(ROOT / 'scripts/blender_scene.py'), '--', '--samples', str(samples),
                                '--output', str(job / 'render'), '--proof-session', '--frames', '1'],
                               env=env, cwd=ROOT, check=True)
                with Image.open(job / 'render/frames/000001.png') as image:
                    image.convert('RGB').save(job_root / (stage + '.webp'), quality=90, method=6)
            surroundings_strip(job_root)
            args.output.mkdir(exist_ok=True, parents=True)
            for image in job_root.glob('*.webp'):
                shutil.copyfile(image, args.output / image.name)
        finally:
            server.terminate()
            server.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--handoff', type=Path, default=Path.home() / 'Downloads/gesso-video-handoff')
    parser.add_argument('--blender', type=Path, default=ROOT / '.cache/blender/Blender-4.3.2.app/Contents/MacOS/Blender')
    parser.add_argument('--size', type=int, default=960)
    parser.add_argument('--samples', type=int, default=128)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    options = parser.parse_args()
    with socket.socket() as finder:
        finder.bind(('127.0.0.1', 0))
        port = finder.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='gesso-auden-worlds-') as directory:
        bake(options, Path(directory), port)
