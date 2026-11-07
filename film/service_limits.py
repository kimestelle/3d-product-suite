"""Bound admission for the current single-process workspace server."""

from dataclasses import dataclass
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat


def _integer(name, default, low, high):
    value = os.environ.get(name, str(default))
    if not value.isascii() or not value.isdecimal() or not low <= int(value) <= high:
        raise ValueError(f"{name} must be an integer from {low} to {high}")
    return int(value)


@dataclass(frozen=True)
class ServiceLimits:
    connections: int = 32
    socket_timeout: int = 30
    heavy_requests: int = 2
    render_jobs: int = 8
    sampled_frames: int = 3600
    sampled_part_frames: int = 500000

    @classmethod
    def from_environment(cls):
        return cls(connections=_integer("GESSO_HTTP_MAX_CONNECTIONS", 32, 4, 128),
                   socket_timeout=_integer("GESSO_HTTP_TIMEOUT_SECONDS", 30, 5, 120),
                   heavy_requests=_integer("GESSO_HEAVY_REQUESTS", 2, 1, 4),
                   render_jobs=_integer("GESSO_RENDER_QUEUE_LIMIT", 8, 1, 64),
                   sampled_frames=_integer("GESSO_MAX_SAMPLED_FRAMES", 3600, 360, 14400),
                   sampled_part_frames=_integer("GESSO_MAX_SAMPLED_PART_FRAMES", 500000, 10000, 2000000))

    def check_sampling(self, scene):
        from .scene import film_duration
        frames = film_duration(scene)
        parts = (sum(1 + len(component.get("sourceNodes", [])) for component in scene["product"]["components"])
                 + len(scene["environment"].get("props", [])))
        if frames > self.sampled_frames:
            raise ValueError(f"This server prepares at most {self.sampled_frames} frames per film. Shorten the film or split it into clips.")
        if frames * max(1, parts) > self.sampled_part_frames:
            raise ValueError("This film exceeds the server's sampled part budget. Shorten the film or use a simpler product hierarchy.")


class ServiceBusyError(Exception):
    pass


@contextmanager
def workspace_server_lock(root):
    """Only one API process may own a file-backed workspace at a time."""
    directory = Path(root).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(directory / ".server.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError("The workspace server lock must be a regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another server owns this workspace. Stop it before starting this server.") from None
        yield
    finally:
        os.close(descriptor)
