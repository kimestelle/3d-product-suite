"""Latest-view native proofs, isolated from saved campaigns and final exports.

The persistent Cycles process uses the actual export adapter. Camera, light and
grade revisions may retain its scene; physical source changes rebuild safely.
"""
from collections import OrderedDict
import array
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import struct
import subprocess
import threading
import time
import uuid

from . import jobs
from .post_processing import apply_post_processing, has_post_processing
from .proof_inputs import digest
from .render_arbitration import arbiter, foreground_render_slot
from .scene import evaluate, film_duration, sample_scene, scene_digest, validate_scene
from .store import ConflictError, identifier
from .worlds import safe_asset_path, verify_scene_assets

ROOT = Path(__file__).resolve().parents[1]
TERMINAL = {'succeeded', 'failed', 'cancelled', 'superseded'}
SESSION = re.compile(r'[a-zA-Z0-9_-]{8,80}\Z')
MAX_SESSIONS = 16
MAX_RECORDS = 64
MAX_AGE_SECONDS = 300
IDLE_SECONDS = 30


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _session(value):
    _require(isinstance(value, str) and bool(SESSION.fullmatch(value)), 'Proof session must be an opaque 8–80 character identifier.')
    return value


def _sequence(value):
    _require(type(value) is int and 0 < value < 2**53, 'Proof sequence must be a positive safe integer.')
    return value


def _camera(value):
    if value is None:
        return None
    _require(isinstance(value, dict) and set(value) <= {'positionM', 'targetM', 'focalLengthMm', 'depthOfField'}, 'Unsupported proof camera field.')
    for name in ('positionM', 'targetM'):
        data = value.get(name)
        _require(isinstance(data, list) and len(data) == 3 and all(type(x) in (float, int) and math.isfinite(x) and abs(x) <= 10000 for x in data), 'Proof camera vectors must be finite scene coordinates.')
    _require(math.dist(value['positionM'], value['targetM']) > 1e-8, 'Proof camera target cannot equal its position.')
    focal = value.get('focalLengthMm')
    _require(type(focal) in (int, float) and math.isfinite(focal) and 1 <= focal <= 2000, 'Proof focal length must be 1–2000 mm.')
    optics = value.get('depthOfField')
    if optics is not None:
        _require(isinstance(optics, dict) and set(optics) <= {'enabled', 'fStop', 'focusDistanceM'} and type(optics.get('enabled')) is bool, 'Proof optical settings must describe the sampled lens.')
        for key, low, high in [('fStop', .7, 32), ('focusDistanceM', .001, 1000)]:
            x = optics.get(key)
            _require(type(x) in (int, float) and math.isfinite(x) and low <= x <= high, f'Proof {key} is outside the physical camera bounds.')
        _require(not optics['enabled'] or optics['focusDistanceM'] > focal/1000, 'Focus must be beyond the lens focal length.')
    return copy.deepcopy(value)


def proof_profile(scene, data):
    width, height = data.get('width'), data.get('height')
    if width is None and height is None:
        scale = min(1, 960/max(scene['render']['width'], scene['render']['height']))
        width = max(2, round(scene['render']['width']*scale/2)*2)
        height = max(2, round(scene['render']['height']*scale/2)*2)
    _require(all(type(x) is int and 2 <= x <= 1536 and x % 2 == 0 for x in (width, height))
             and width*height <= 1536*1024, 'Proof dimensions must be even, within 1536 px and 1.5 Mi pixels.')
    expected = scene['render']['width']/scene['render']['height']
    _require(data.get('cameraOverride') is not None or abs(width/height-expected) <= 2/min(width, height), 'Saved-shot proof dimensions must retain the composition aspect ratio.')
    samples = data.get('samples', 32)
    _require(type(samples) is int and 8 <= samples <= 128, 'Proof samples must be 8–128.')
    return {'width':width, 'height':height, 'samples':samples}


class BlenderProofProcess:
    def __init__(self, root, blender):
        self.root, self.blender = Path(root), blender
        self.process = None
        self.log = None
        self.loaded_directory = None
        self.implementation = None
        self.last_used = 0
        self.control = None

    def close(self):
        process, self.process = self.process, None
        if process and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        if self.log:
            self.log.close()
            self.log = None
        if self.control:
            self.control.close()
            self.control = None
        self.loaded_directory = None

    def render(self, request_path, cancel, gpu_fd):
        implementation = digest({name:jobs._sha256(ROOT/name) for name in
            ['scripts/blender_proof_worker.py', 'scripts/blender_scene.py', 'film/proof_inputs.py', *['film/'+name for name in jobs._RENDERER_DEPENDENCIES]]})
        if self.process is not None and (self.process.poll() is not None or self.implementation != implementation):
            self.close()
        if self.process is None:
            jobs._check_tool(self.blender, 'blender', jobs.BLENDER_VERSION)
            self.log = (self.root/'proofs'/'worker.log').open('wb')
            self.control, child_control = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                self.process = subprocess.Popen([self.blender, '--background', '--factory-startup', '--python-exit-code', '1',
                    '--python', str(ROOT/'scripts/blender_proof_worker.py'), '--', '--root', str(self.root),
                    '--control-fd', str(child_control.fileno())], stdin=subprocess.DEVNULL,
                    stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True,
                    pass_fds=(child_control.fileno(),), env={**os.environ, 'GESSO_ROOT':str(ROOT)})
            except BaseException:
                self.close()
                raise
            finally:
                child_control.close()
            self.implementation = implementation
        result_path = request_path.with_name('worker-result.json')
        result_path.unlink(missing_ok=True)
        # Each request transfers this *same open GPU lease*. The child closes
        # its copy after the completed frame. Warm idle workers hold no lease;
        # a parent crash cannot release a still-rendering child's ownership.
        message = json.dumps(str(request_path)).encode()
        packet = struct.pack('!I', len(message))+message
        sent = self.control.sendmsg([packet], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [gpu_fd]))])
        if sent != len(packet):
            self.control.sendall(packet[sent:])
        deadline = time.monotonic()+MAX_AGE_SECONDS
        try:
            while not result_path.is_file():
                cancel()
                if self.process.poll() is not None:
                    raise RuntimeError('Native proof worker stopped. Check the configured Blender runtime and retry.')
                if time.monotonic() > deadline:
                    raise RuntimeError('Native proof exceeded its time budget. Use Export for this scene.')
                time.sleep(.05)
            result = json.loads(result_path.read_text())
            if result.get('ok') is not True:
                raise RuntimeError(result.get('error', 'The native proof could not be rendered.'))
            self.loaded_directory = result['loadedDirectory']
            self.last_used = time.monotonic()
            if self.log.tell() > 8*1024*1024:
                # Restart between requests instead of allowing verbose native
                # logs to grow throughout an indefinitely active session.
                self.implementation = None
            return result
        except BaseException:
            self.close()
            raise


class NativeProofService:
    def __init__(self, root, *, base_url, blender='blender'):
        self.root = Path(root).resolve()
        self.directory = self.root/'proofs'
        self.directory.mkdir(exist_ok=True)
        self.base_url, self.blender = base_url, blender
        self.condition = threading.Condition(threading.RLock())
        self.records = {}
        self.sessions = OrderedDict()
        self.pending = OrderedDict()
        self.closed = False
        self.thread = None
        self.native = BlenderProofProcess(self.root, blender)
        self.cache_bytes = 256*1024*1024
        self.warm_lock = threading.RLock()
        arbiter(self.root).release_warm_worker = self._release_warm_worker

    def _release_warm_worker(self):
        with self.warm_lock:
            self.native.close()

    def close(self):
        with self.condition:
            self.closed = True
            for record in self.records.values():
                if record['state'] not in TERMINAL:
                    self._cancel(record, 'cancelled')
            self.condition.notify_all()
        self._release_warm_worker()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=2)
        gate = arbiter(self.root)
        if gate.release_warm_worker == self._release_warm_worker:
            gate.release_warm_worker = None

    def _save(self, record):
        public = {key:value for key,value in record.items() if not key.startswith('_')}
        jobs._atomic_json(self.directory/record['id']/'proof.json', public)

    def _cancel(self, record, state):
        if record['state'] in TERMINAL:
            return
        record['_cancel'].set()
        (self.directory/record['id']/'cancel.requested').touch()
        record['state'] = state
        self.pending.pop(record['id'], None)
        self._save(record)

    def cancel_session(self, session_id, sequence):
        session_id, sequence = _session(session_id), _sequence(sequence)
        with self.condition:
            self._expire_sessions()
            session = self.sessions.get(session_id)
            if session and sequence < session['sequence']:
                return {'sessionId':session_id, 'sequence':session['sequence'], 'cancelled':False}
            if session is None:
                _require(len(self.sessions) < MAX_SESSIONS, 'Too many proof sessions. Close another studio session first.')
                session = self.sessions[session_id] = {'sequence':sequence, 'current':None, 'lastGood':None}
            session['sequence'] = sequence
            session['touched'] = time.monotonic()
            record = self.records.get(session.get('current'))
            if record:
                self._cancel(record, 'cancelled')
            self.condition.notify_all()
            return {'sessionId':session_id, 'sequence':sequence, 'cancelled':bool(record)}

    def cancel(self, proof_id):
        with self.condition:
            record = self.records.get(identifier(proof_id))
            if record:
                self._cancel(record, 'cancelled')
                self.condition.notify_all()
            return self.summary(proof_id)

    def submit(self, data):
        _require(isinstance(data, dict), 'Proof request must be an object.')
        session_id, sequence = _session(data.get('sessionId')), _sequence(data.get('sequence'))
        scene = copy.deepcopy(validate_scene(data['scene']))
        _require(not scene.get('comparison'), 'Use Export for a paired comparison proof.')
        frame = data.get('frame', 1)
        _require(type(frame) is int and 1 <= frame <= film_duration(scene) <= 3600, 'Proof frame must belong to a film of at most 3600 frames.')
        sample = evaluate(scene, frame)
        _require(sample.get('clip', {}).get('kind', 'scene') == 'scene', 'Choose a 3D film frame for a native proof.')
        profile, camera = proof_profile(scene, data), _camera(data.get('cameraOverride'))
        verify_scene_assets(scene, self.root)
        with self.condition:
            _require(not self.closed, 'The proof service is stopping.')
            self._expire_sessions()
            session = self.sessions.get(session_id)
            if session and sequence <= session['sequence']:
                raise ConflictError('A newer proof request already owns this view.')
            if session is None:
                _require(len(self.sessions) < MAX_SESSIONS, 'Too many proof sessions. Close another studio session first.')
                session = self.sessions[session_id] = {'sequence':0, 'current':None, 'lastGood':None}
            previous = self.records.get(session.get('current'))
            if previous:
                self._cancel(previous, 'superseded')
            self._prune()
            _require(shutil.disk_usage(self.root).free >= 32*1024*1024, 'The workspace needs 32 MiB free before preparing a native proof.')
            proof_id = uuid.uuid4().hex
            directory = self.directory/proof_id
            directory.mkdir()
            record = {'id':proof_id, 'state':'queued', 'sessionId':session_id, 'sequence':sequence,
                'sourceDigest':scene_digest(scene), 'frame':frame, **profile,
                'cameraScope':'explicit-view' if camera else 'saved-shot', 'cameraOverride':camera,
                'createdAt':jobs._now(), 'imageUrl':None, 'error':None,
                '_cancel':threading.Event(), '_created':time.monotonic()}
            jobs._atomic_json(directory/'scene.json', scene)
            self.records[proof_id] = record
            session.update(sequence=sequence, current=proof_id, touched=time.monotonic())
            self.sessions.move_to_end(session_id)
            self.pending[proof_id] = record
            self._save(record)
            if self.thread is None:
                self.thread = threading.Thread(target=self._worker, name='native-proof', daemon=True)
                self.thread.start()
            self.condition.notify_all()
            return self.summary(proof_id)

    def summary(self, proof_id):
        proof_id = identifier(proof_id)
        with self.condition:
            record = self.records.get(proof_id)
            if record is None:
                path = self.directory/proof_id/'proof.json'
                _require(path.is_file() and not path.is_symlink(), 'Proof is unavailable.')
                record = json.loads(path.read_text())
                if record.get('state') not in TERMINAL:
                    record.update(state='failed', error='Proof was interrupted. Request the current view again.', imageUrl=None)
            return {key:copy.deepcopy(value) for key,value in record.items() if not key.startswith('_')}

    def artifact(self, proof_id):
        record = self.summary(proof_id)
        path = self.directory/identifier(proof_id)/'image.png'
        _require(record['state'] == 'succeeded' and not path.is_symlink()
                 and jobs.validate_png(path, record['width'], record['height'])
                 and jobs._sha256(path) == record.get('imageSha256'), 'The native proof image is unavailable or changed.')
        return path

    image = artifact

    def _expire_sessions(self):
        # Cancellation watermarks outlive every possible request. Abandoned
        # browser tabs cannot occupy the bounded session pool indefinitely.
        for session_id, session in list(self.sessions.items()):
            current = self.records.get(session.get('current'))
            if time.monotonic()-session.get('touched', time.monotonic()) > MAX_AGE_SECONDS*2 and (
                    current is None or current['state'] in TERMINAL):
                del self.sessions[session_id]

    def _prune(self):
        protected = {item.get(key) for item in self.sessions.values() for key in ('current', 'lastGood')}
        if self.native.loaded_directory:
            protected.add(Path(self.native.loaded_directory).name)
        directories = [path for path in self.directory.iterdir() if path.is_dir() and not path.is_symlink()]
        sizes = {path:self._used_bytes(path) for path in directories}
        total = sum(sizes.values())
        for path in sorted(directories, key=lambda p:p.stat().st_mtime):
            if len(directories) <= MAX_RECORDS and total < self.cache_bytes:
                break
            record = self.records.get(path.name)
            if path.name not in protected and (not record or record['state'] in TERMINAL):
                shutil.rmtree(path)
                self.records.pop(path.name, None)
                directories.remove(path)
                total -= sizes[path]
        _require(total < self.cache_bytes, 'Proof storage is full. Return from older proofs before preparing more.')

    @staticmethod
    def _used_bytes(path):
        total = 0
        for item in path.rglob('*'):
            if item.is_file():
                stat = item.stat()
                # The shared original owns hardlinked immutable asset bytes;
                # cross-device fallback copies belong to this proof's budget.
                if 'assets' not in item.relative_to(path).parts or stat.st_nlink == 1:
                    total += stat.st_size
        return total

    def _check(self, record):
        if self.closed or record['_cancel'].is_set():
            raise jobs._Cancelled()
        if time.monotonic()-record['_created'] > MAX_AGE_SECONDS:
            raise RuntimeError('This proof expired while waiting or rendering. Request the current view again.')

    def _stage(self, record, state):
        with self.condition:
            self._check(record)
            if record['state'] != state:
                record['state'] = state
                self._save(record)

    def _bundle(self, record, scene):
        directory = self.directory/record['id']
        records = verify_scene_assets(scene, self.root)
        for asset in records:
            self._check(record)
            source = safe_asset_path(self.root, asset['path'])
            target = directory/asset['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(source, target)
            except OSError:
                size = source.stat().st_size
                with self.condition:
                    self._prune()
                    used = sum(self._used_bytes(path) for path in self.directory.iterdir() if path.is_dir() and not path.is_symlink())
                    _require(used+size < self.cache_bytes and shutil.disk_usage(self.root).free > size+32*1024*1024,
                             'Not enough proof storage to copy this source safely. Free workspace space and retry.')
                shutil.copyfile(source, target)
        sampled = sample_scene(scene)
        if record['cameraOverride']:
            sampled['frames'][record['frame']-1]['camera'] = record['cameraOverride']
        jobs._atomic_json(directory/'samples.json', sampled)
        jobs._atomic_json(directory/'worker-request.json', {'directory':str(directory), 'frame':record['frame'],
            'profile':{key:record[key] for key in ('width', 'height', 'samples')},
            'renderSourceDigest':scene_digest(scene), 'samplesDigest':digest(sampled)})
        return directory, sampled

    def _execute(self, record):
        scene = json.loads((self.directory/record['id']/'scene.json').read_text())
        directory, sampled = self._bundle(record, scene)
        self._stage(record, 'waiting')
        with foreground_render_slot(self.root, cancel=lambda:self._check(record), waiting=lambda:self._stage(record, 'waiting')) as scheduling:
            self._stage(record, 'rendering')
            began = time.monotonic()
            capture_execution = None
            if scene['environment']['kind'] == 'splat':
                asset = scene['environment']['asset']
                origin = self.base_url() if callable(self.base_url) else self.base_url
                command = ['node', str(ROOT/'scripts/capture_splats.mjs'), '--url', origin,
                    '--samples', str(directory/'samples.json'), '--output', str(directory/'plate'),
                    '--asset-url', f"/api/assets/{Path(asset['path']).name}", '--width', str(record['width']),
                    '--height', str(record['height']), '--frames', str(record['frame']), '--device',
                    jobs.execution_policy()['capture'], '--source-digest', record['sourceDigest']]
                jobs._run_process_unlocked(command, directory, 'capture.log', extra_fds=(scheduling['gpuLockFd'],))
                manifest = json.loads((directory/'plate'/'capture-manifest.json').read_text())
                capture_execution = manifest['profile'].get('execution')
            self._check(record)
            with self.warm_lock:
                result = self.native.render(directory/'worker-request.json', lambda:self._check(record), scheduling['gpuLockFd'])
            raw = directory/'frames'/f"{record['frame']:06d}.png"
            _require(jobs.validate_png(raw, record['width'], record['height']), 'Native renderer returned an invalid proof image.')
            destination = directory/'image.png'
            shutil.copyfile(raw, destination)
            if has_post_processing(scene.get('postProcessing')):
                apply_post_processing(destination, scene['postProcessing'], cancel=lambda:self._check(record))
            self._check(record)
            _require(jobs.validate_png(destination, record['width'], record['height']), 'Finished proof image is invalid.')
            return {'imageUrl':f"/api/proofs/{record['id']}/image.png", 'imageSha256':jobs._sha256(destination),
                'imageBytes':destination.stat().st_size, 'warmSceneReused':result['warmSceneReused'],
                'workerPid':result['workerPid'], 'nativeBuildCount':result['buildCount'],
                'execution':{'cycles':result['execution'], 'capture':capture_execution},
                'timings':{'nativeSeconds':result['renderSeconds'], 'gpuSeconds':time.monotonic()-began}}

    def _worker(self):
        while True:
            with self.condition:
                while not self.pending and not self.closed:
                    self.condition.wait(IDLE_SECONDS)
                    if not self.pending and self.native.process is not None:
                        self._release_warm_worker()
                if self.closed:
                    return
                _, record = self.pending.popitem(last=False)
            try:
                self._check(record)
                result = self._execute(record)
                with self.condition:
                    self._check(record)
                    record.update(result, state='succeeded', completedAt=jobs._now())
                    self.sessions[record['sessionId']]['lastGood'] = record['id']
                    self._save(record)
            except jobs._Cancelled:
                with self.condition:
                    if record['state'] not in ('cancelled', 'superseded'):
                        record['state'] = 'cancelled'
                    self._save(record)
            except BaseException as error:
                with self.condition:
                    if record['state'] not in ('cancelled', 'superseded'):
                        record.update(state='failed', error=str(error), imageUrl=None)
                    self._save(record)
