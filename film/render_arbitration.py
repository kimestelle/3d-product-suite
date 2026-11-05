"""One GPU owner per workspace, with bounded priority for current-frame proofs.

A proof can overtake the next export batch, never interrupt a batch already
rendering. Three consecutive proofs yield to a waiting export, so unattended
finals continue making progress while someone directs another view.
"""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import threading
import time


class RenderArbiter:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.condition = threading.Condition()
        self.active = False
        self.active_foreground = False
        self.foreground_waiters = 0
        self.background_waiters = 0
        self.foreground_streak = 0
        self.release_warm_worker = None

    def _publish_demand(self):
        path = self.root / '.proof-demand.json'
        if self.foreground_waiters or self.active_foreground:
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps({'pid':os.getpid(), 'updatedAt':time.time(),
                'waiting':self.foreground_waiters, 'active':self.active_foreground}))
            temporary.replace(path)
        else:
            path.unlink(missing_ok=True)

    @contextmanager
    def slot(self, foreground=False, cancel=None, waiting=None):
        counter = 'foreground_waiters' if foreground else 'background_waiters'
        with self.condition:
            setattr(self, counter, getattr(self, counter) + 1)
            self._publish_demand()
            try:
                while self.active or (foreground and self.background_waiters and self.foreground_streak >= 3) or (
                        not foreground and self.foreground_waiters and self.foreground_streak < 3):
                    if cancel:
                        cancel()
                    if waiting:
                        waiting()
                    self.condition.wait(.1)
                self.active = True
                self.active_foreground = foreground
            finally:
                setattr(self, counter, getattr(self, counter) - 1)
                self._publish_demand()
        try:
            with (self.root / '.render-gpu.lock').open('a+') as handle:
                while True:
                    if cancel:
                        cancel()
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if waiting:
                            waiting()
                        time.sleep(.1)
                if not foreground and self.release_warm_worker:
                    self.release_warm_worker()
                # Native children inherit this open descriptor. If the parent
                # stops unexpectedly, the GPU remains owned until they exit.
                yield {'proofDemandPath':str(self.root / '.proof-demand.json'), 'gpuLockFd':handle.fileno()}
        finally:
            with self.condition:
                self.foreground_streak = self.foreground_streak + 1 if foreground else 0
                self.active = False
                self.active_foreground = False
                self._publish_demand()
                self.condition.notify_all()


_arbiters = {}
_lock = threading.Lock()


def arbiter(root):
    key = str(Path(root).resolve())
    with _lock:
        if key not in _arbiters:
            _arbiters[key] = RenderArbiter(key)
        return _arbiters[key]


def foreground_render_slot(root, cancel=None, waiting=None):
    return arbiter(root).slot(True, cancel, waiting)


def background_render_slot(output, cancel=None):
    # Normal jobs live at <workspace>/renders/<job>; proofs use their own gate.
    output = Path(output).resolve()
    root = next((parent.parent for parent in output.parents if parent.name == 'renders'), output.parent)
    return arbiter(root).slot(False, cancel)


def proof_demand_path(output):
    output = Path(output).resolve()
    root = next((parent.parent for parent in output.parents if parent.name == 'renders'), output.parent)
    return root / '.proof-demand.json'
