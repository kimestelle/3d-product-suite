"""Persistent pinned Cycles process. Only the trusted service writes requests.

    blender --background --factory-startup --python blender_proof_worker.py -- --root WORKSPACE

    The private socket receives a bounded request path and its GPU lease FD.
    Rendering and construction use blender_scene.py, the final export adapter.
"""
import argparse
import array
import importlib.util
import json
import os
from pathlib import Path
import sys
import socket
import struct
import time
import traceback

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from film.proof_inputs import digest, warm_scene_key, non_optical_sample

spec = importlib.util.spec_from_file_location('gesso_native_proof_renderer', ROOT / 'scripts/blender_scene.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def atomic_json(path, value):
    temporary = path.with_suffix('.partial')
    temporary.write_text(json.dumps(value, allow_nan=False)+'\n')
    temporary.replace(path)


def camera_pose(camera, values):
    camera.animation_data_clear()
    camera.data.animation_data_clear()
    camera.location = renderer.blender_position(values['positionM'])
    direction = Vector(renderer.blender_position(values['targetM'])) - camera.location
    if direction.length < 1e-8:
        raise ValueError('Proof camera target equals its position')
    camera.rotation_mode = 'QUATERNION'
    camera.rotation_quaternion = direction.to_track_quat('-Z', 'Y')
    camera.data.lens = values['focalLengthMm']
    renderer.keyframe_camera_optics(camera.data, values, bpy.context.scene.frame_current)


def release_unused_inputs():
    # Replaced camera actions and prior compositor plates have no users. Their
    # original immutable bundle stays on disk; retain only the live GPU scene.
    for action in list(bpy.data.actions):
        if action.users == 0:
            bpy.data.actions.remove(action)
    for image in list(bpy.data.images):
        if image.users == 0 and image.type not in ('RENDER_RESULT', 'COMPOSITING'):
            bpy.data.images.remove(image)


def refresh_lighting(source, previous_source, frames, sample, directory, profile, execution):
    scene = bpy.context.scene
    old_world = scene.world
    def world_key(value):
        return digest({'worldColor':value['environment']['worldColor'],
            'lighting':{key:item for key,item in value.get('lighting', {}).items() if key != 'lights'}})
    world_changed = world_key(source) != world_key(previous_source)
    lights_changed = source.get('lighting', {}).get('lights') != previous_source.get('lighting', {}).get('lights')
    old_world_images = {node.image for node in old_world.node_tree.nodes if node.type == 'TEX_ENVIRONMENT' and node.image} if old_world and old_world.use_nodes else set()
    scene.world = bpy.data.worlds.new('Proof / native lighting')
    renderer.configure_scene(source, profile['width'], profile['height'], profile['samples'], directory, frames)
    current_execution = json.loads(scene['gesso_execution_json'])
    if any(current_execution.get(key) != execution.get(key) for key in ('backend', 'devices', 'system', 'denoiser')):
        raise ValueError('Proof rendering device changed. Retry in a fresh proof session.')
    if world_changed:
        if old_world:
            bpy.data.worlds.remove(old_world)
        for image in old_world_images:
            if image.users == 0:
                bpy.data.images.remove(image)
        if source.get('lighting', {}).get('hdri'):
            renderer.hdri_lighting(source, directory)
    else:
        temporary_world = scene.world
        scene.world = old_world
        bpy.data.worlds.remove(temporary_world)
    if lights_changed:
        for light in list(scene.objects):
            if light.type == 'LIGHT' and light.get('gesso_studio_light'):
                data = light.data
                bpy.data.objects.remove(light, do_unlink=True)
                if data.users == 0:
                    bpy.data.lights.remove(data)
        renderer.studio_lights(source, frames[0])
    lights = {obj.get('gesso_light_id'):obj for obj in scene.objects if obj.type == 'LIGHT' and obj.get('gesso_light_id')}
    for pose in sample.get('lights', []):
        light = lights.get(pose['id'])
        if light is not None:
            light.location = renderer.blender_position(pose['positionM'])
            direction = Vector(renderer.blender_position(pose['targetM'])) - light.location
            light.rotation_mode = 'QUATERNION'
            light.rotation_quaternion = direction.to_track_quat('-Z', 'Y')
    return current_execution


class ProofWorker:
    def __init__(self):
        self.loaded = None
        self.build_count = 0

    def render(self, request):
        started = time.monotonic()
        directory = Path(request['directory']).resolve()
        payload = json.loads((directory / 'samples.json').read_text())
        source, frames = payload['scene'], payload['frames']
        if digest(source) != request['renderSourceDigest'] or digest(payload) != request['samplesDigest']:
            raise ValueError('Proof source or samples changed after submission')
        frame, profile = request['frame'], request['profile']
        sample = next(item for item in frames if item['frame'] == frame)
        if sample.get('clip', {}).get('kind', 'scene') != 'scene':
            raise ValueError('Native proofs require a 3D scene frame')
        key = warm_scene_key(source)
        reusable = (self.loaded is not None and self.loaded['key'] == key
                    and non_optical_sample(self.loaded['frames'][frame-1]) == non_optical_sample(sample))
        destination = directory / 'frames' / f'{frame:06d}.png'
        destination.parent.mkdir(exist_ok=True)
        if not reusable:
            bpy.ops.wm.read_factory_settings(use_empty=False)
            previous_argv = sys.argv
            try:
                sys.argv = [str(ROOT/'scripts/blender_scene.py'), '--', '--samples', str(directory/'samples.json'),
                    '--output', str(directory), '--frames', str(frame), '--width', str(profile['width']),
                    '--height', str(profile['height']), '--samples-per-pixel', str(profile['samples']), '--proof-session']
                context = renderer.main()
            finally:
                sys.argv = previous_argv
            self.build_count += 1
            execution = json.loads(context['scene']['gesso_execution_json'])
            self.loaded = {'key':key, 'frames':frames, 'source':source, 'context':context, 'execution':execution, 'directory':str(directory)}
        else:
            scene = self.loaded['context']['scene']
            scene.frame_set(frame)
            execution = refresh_lighting(source, self.loaded['source'], frames, sample, directory, profile, self.loaded['execution'])
            camera_pose(scene.camera, sample['camera'])
            if source['environment']['kind'] == 'splat':
                renderer.plate_compositor(source, frames, [frame], directory, directory, scene, relative_paths=False)
            release_unused_inputs()
            scene.render.filepath = str(destination)
            bpy.ops.render.render(write_still=True)
            self.loaded['source'] = source
        return {'ok':True, 'warmSceneReused':bool(reusable), 'buildCount':self.build_count,
                'workerPid':os.getpid(), 'loadedDirectory':self.loaded['directory'], 'execution':execution,
                'renderSeconds':time.monotonic()-started, 'rawPath':str(destination)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--control-fd', type=int, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    root = (args.root.resolve()/'proofs').resolve()
    worker = ProofWorker()
    control = socket.socket(fileno=args.control_fd)
    print('PROOF_WORKER_READY', flush=True)
    while True:
        header, ancillary, flags, address = control.recvmsg(4, socket.CMSG_SPACE(array.array('i').itemsize))
        if not header:
            break
        descriptors = array.array('i')
        for level, kind, values in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                descriptors.frombytes(values[:len(values)//descriptors.itemsize*descriptors.itemsize])
        if len(descriptors) != 1 or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            for descriptor in descriptors:
                os.close(descriptor)
            raise ValueError('A proof request must transfer its exact GPU lease')
        def receive_rest(initial, length):
            value = initial
            while len(value) < length:
                part = control.recv(length-len(value))
                if not part:
                    os.close(descriptors[0])
                    raise ValueError('The proof controller disconnected during a request')
                value += part
            return value
        header = receive_rest(header, 4)
        length = struct.unpack('!I', header)[0]
        if not 1 <= length <= 8192:
            os.close(descriptors[0])
            raise ValueError('Proof request path exceeded its protocol bound')
        message = receive_rest(b'', length)
        request_path = Path(json.loads(message)).resolve()
        if not request_path.is_relative_to(root) or request_path.name != 'worker-request.json':
            os.close(descriptors[0])
            raise ValueError('Proof request is outside the workspace')
        try:
            request = json.loads(request_path.read_text())
            if Path(request['directory']).resolve() != request_path.parent:
                raise ValueError('Proof destination differs from its request')
            result = worker.render(request)
        except BaseException as error:
            traceback.print_exc()
            worker.loaded = None
            result = {'ok':False, 'error':f'{type(error).__name__}: {error}'}
        finally:
            os.close(descriptors[0])
        atomic_json(request_path.with_name('worker-result.json'), result)
        print('PROOF_RESULT '+request_path.parent.name, flush=True)


if __name__ == '__main__':
    main()
