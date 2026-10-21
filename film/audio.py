"""Local soundtrack assets: content-addressed MP3/WAV/M4A files measured once with ffprobe."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

MAX_AUDIO_BYTES = 64 * 1024 * 1024
MAX_AUDIO_SECONDS = 24 * 60 * 60
MIME_TYPES = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4"}
_SUFFIXES = {".mp3": "mp3", ".wav": "wav", ".m4a": "m4a"}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _number(value, name, minimum, maximum):
    _require(type(value) in (int, float) and math.isfinite(value), f"{name} must be a finite number")
    _require(minimum <= value <= maximum, f"{name} must be between {minimum} and {maximum}")


def validate_audio_asset(asset):
    _require(isinstance(asset, dict), "Audio asset must be an object")
    digest = asset.get("sha256")
    _require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "Audio SHA256 is invalid")
    _require(asset.get("format") in MIME_TYPES, "Audio must be MP3, WAV or M4A")
    _require(asset.get("path") == f"assets/{digest}.{asset['format']}", "Audio path must be content-addressed")
    return asset


def validate_scene_audio(audio):
    """Validate scene.audio without inserting defaults; documents without sound stay byte-identical."""
    _require(isinstance(audio, dict), "Scene audio must be an object")
    validate_audio_asset(audio.get("asset"))
    _number(audio.get("offsetS"), "Audio offset", -600, 600)
    _number(audio.get("gain"), "Audio gain", 0, 4)
    if "bpm" in audio:
        _number(audio["bpm"], "Audio BPM", 30, 300)
    _number(audio.get("durationS"), "Audio duration", 0, MAX_AUDIO_SECONDS)
    _require(audio["durationS"] > 0, "Audio duration must be positive")
    return audio


def sniff_audio_format(payload):
    """Container from the leading bytes: ID3/MPEG sync, RIFF WAVE or an ISO base-media ftyp box."""
    head = bytes(payload[:12])
    if head.startswith(b"RIFF") and head[8:12] == b"WAVE":
        return "wav"
    if head[4:8] == b"ftyp":
        return "m4a"
    if head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "mp3"
    return None


def ffprobe_command(ffmpeg="ffmpeg"):
    """ffprobe ships beside the configured ffmpeg; otherwise use the one on PATH."""
    ffmpeg = Path(str(ffmpeg))
    if ffmpeg.parent != Path("."):
        candidate = ffmpeg.with_name("ffprobe.exe" if ffmpeg.suffix.lower() == ".exe" else "ffprobe")
        if candidate.is_file():
            return str(candidate)
    return shutil.which("ffprobe") or "ffprobe"


def measure_duration(path, ffprobe="ffprobe"):
    """Seconds reported by ffprobe for the first audio stream's container."""
    command = [str(ffprobe), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type:format=duration",
               "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f"Cannot run ffprobe to measure the soundtrack: {error}") from error
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    _require(result.returncode == 0 and "audio" in lines, "ffprobe found no audio stream in the file")
    try:
        duration = float(lines[-1])
    except ValueError as error:
        raise ValueError("ffprobe did not report an audio duration") from error
    _require(math.isfinite(duration) and 0 < duration <= MAX_AUDIO_SECONDS, "Audio duration must be positive and at most 24 hours")
    return round(duration, 3)


def verify_audio(payload, asset):
    validate_audio_asset(asset)
    _require(isinstance(payload, bytes) and 0 < len(payload) <= MAX_AUDIO_BYTES, "Audio must be at most 64 MiB")
    _require(hashlib.sha256(payload).hexdigest() == asset["sha256"], "Audio changed after import")
    _require(sniff_audio_format(payload) == asset["format"], "Audio bytes do not match their declared format")
    return {}


def import_audio(payload, filename, root, *, ffprobe="ffprobe"):
    """Store the bytes unchanged under their hash and return the asset record with its measured duration."""
    from .worlds import _immutable_write
    _require(Path(filename).suffix.lower() in _SUFFIXES, "Upload an MP3, WAV or M4A file")
    _require(isinstance(payload, bytes) and 0 < len(payload) <= MAX_AUDIO_BYTES, "Audio must be at most 64 MiB")
    format_ = sniff_audio_format(payload)
    _require(format_ is not None, "Audio could not be recognized; use a complete MP3, WAV or M4A file")
    digest = hashlib.sha256(payload).hexdigest()
    asset = {"path": f"assets/{digest}.{format_}", "sha256": digest, "format": format_}
    assets = Path(root) / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=assets, prefix=".probe-", suffix=f".{format_}", delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(payload)
    try:
        duration = measure_duration(temporary, ffprobe)
    finally:
        temporary.unlink(missing_ok=True)
    _immutable_write(Path(root) / asset["path"], payload)
    return {"asset": asset, "durationS": duration}
