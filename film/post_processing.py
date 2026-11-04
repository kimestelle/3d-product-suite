"""Bounded display-sRGB finishing for 3D renders, after the renderer's tone map.

Settings are frozen in the scene/job. Analysis never runs during export, and the
same deterministic grade is applied to every 3D frame. Image shots bypass it.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile

DEFAULT_POST_PROCESSING = {
    "enabled": False, "exposureEV": 0., "contrast": 1., "saturation": 1.,
    "temperature": 0., "tint": 0., "highlights": 0., "shadows": 0.,
    "vignette": 0., "grain": 0., "bloom": 0.,
}
_LIMITS = {"exposureEV": (-3, 3), "contrast": (.5, 1.5), "saturation": (0, 2),
           "temperature": (-1, 1), "tint": (-1, 1), "highlights": (-1, 1), "shadows": (-1, 1),
           "vignette": (0, 1), "grain": (0, .15), "bloom": (0, 1)}


def validate_post_processing(value=None):
    if value is None:
        return dict(DEFAULT_POST_PROCESSING)
    if not isinstance(value, dict) or set(value) - set(DEFAULT_POST_PROCESSING):
        raise ValueError("Post processing must contain supported image controls")
    if "enabled" in value and type(value["enabled"]) is not bool:
        raise ValueError("Post processing enabled must be boolean")
    result = {**DEFAULT_POST_PROCESSING, **value}
    for key, (minimum, maximum) in _LIMITS.items():
        x = result[key]
        if type(x) not in (int, float) or not math.isfinite(x) or not minimum <= x <= maximum:
            raise ValueError(f"postProcessing.{key} must be a finite number in {minimum}..{maximum}")
    return result


def has_post_processing(value=None):
    settings = validate_post_processing(value)
    return settings["enabled"] and any(settings[key] != DEFAULT_POST_PROCESSING[key] for key in _LIMITS)


def raw_frame_identity(job):
    """Bind renderer receipts to the immutable source and requested render."""
    return {"schemaVersion": 1, **{key: job[key] for key in
            ("jobId", "sceneDigest", "renderProfileDigest", "rendererDigest")}}


def read_raw_frame_receipts(output, identity):
    try:
        value = json.loads((Path(output) / "raw-frame-digests.json").read_text())
        return value["frames"] if value.get("identity") == identity and isinstance(value.get("frames"), dict) else {}
    except (OSError, ValueError, TypeError, AttributeError):
        return {}


def _write_raw_receipts(output, identity, frames):
    output = Path(output)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=output, prefix=".raw-frames-", suffix=".tmp",
                                         encoding="utf-8", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump({"identity": identity, "frames": frames}, handle, sort_keys=True, allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, output / "raw-frame-digests.json")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def record_raw_frame_receipt(output, identity, number):
    """Called by Blender immediately after a complete raw PNG write (stdlib only)."""
    path = Path(output) / "frames" / f"{number:06d}.png"
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    frames = read_raw_frame_receipts(output, identity)
    frames[str(number)] = digest.hexdigest()
    _write_raw_receipts(output, identity, frames)


def prune_raw_frame_receipts(output, identity, numbers):
    """Final receipts commit first; stale raw entries are safe after a kill."""
    frames = read_raw_frame_receipts(output, identity)
    removed = set(map(str, numbers)) & frames.keys()
    if not removed:
        return
    remaining = {key: digest for key, digest in frames.items() if key not in removed}
    if remaining:
        _write_raw_receipts(output, identity, remaining)
    else:
        (Path(output) / "raw-frame-digests.json").unlink(missing_ok=True)


def _math(expression, **images):
    from PIL import ImageMath
    # Expressions are constant application code. No user text is evaluated.
    return ImageMath.unsafe_eval(expression, **images)


@lru_cache(maxsize=8)
def _vignette_tile(aspect_key):
    from PIL import Image
    side = 256
    values = bytearray(side * side)
    for y in range(side):
        for x in range(side):
            r = math.hypot(((x + .5) / side - .5) * aspect_key, (y + .5) / side - .5)
            u = max(0., min(1., (r - .2) / .65))
            values[y * side + x] = round(u * u * (3 - 2 * u) * 255)
    return Image.frombytes("L", (side, side), bytes(values))


@lru_cache(maxsize=1)
def _grain_tile():
    from PIL import Image
    side = 128
    return Image.frombytes("L", (side, side), bytes(
        (x * 73 + y * 151 + (x * y * 19) % 251) % 256 for y in range(side) for x in range(side)))


def _check(cancel):
    if cancel:
        cancel()


def _grade_float_strip(rgb, settings):
    from PIL import Image
    channels = []
    for channel, gain in zip(rgb.split(), [1 + .12 * settings["temperature"],
                            1 + .06 * settings["tint"], 1 - .12 * settings["temperature"]]):
        factor = 2 ** settings["exposureEV"] * gain / 255
        channels.append(channel.convert("F").point(lambda x: x * factor))
    r, g, b = channels
    y = _math(".2126*max(min(r,1),0)+.7152*max(min(g,1),0)+.0722*max(min(b,1),0)", r=r, g=g, b=b)
    lift = _math(".18*(s*(1-y)**2+h*y**2)", y=y, s=settings["shadows"], h=settings["highlights"])
    channels = [_math("(c+a-.5)*k+.5", c=c, a=lift, k=settings["contrast"]) for c in channels]
    y = _math(".2126*r+.7152*g+.0722*b", r=channels[0], g=channels[1], b=channels[2])
    channels = [_math("max(min(y+(c-y)*s,1),0)", c=c, y=y, s=settings["saturation"]) for c in channels]
    return Image.merge("RGB", tuple(_math("max(min(c*255+.5,255),0)", c=c).convert("L") for c in channels))


def _grade_strip(rgb, settings):
    if all(settings[key] == DEFAULT_POST_PROCESSING[key] for key in
           ("exposureEV", "contrast", "saturation", "temperature", "tint", "highlights", "shadows")):
        return rgb.copy()
    return _grade_float_strip(rgb, settings)


def grade_image(image, value, *, cancel=None):
    """Finish display pixels with bounded float scratch space (256-row strips).

    Bloom is an approximate display-space Gaussian of RGB excess above .7,
    radius .008 × longest edge, added at bloom × .35. The vignette smooth mask
    comes from a cached 256px grid; deterministic grain repeats a 128px tile.
    """
    from PIL import Image, ImageChops, ImageFilter
    settings = validate_post_processing(value)
    if not has_post_processing(settings):
        return image.copy()
    _check(cancel)
    alpha = image.getchannel("A") if image.mode == "RGBA" else None
    output = Image.new("RGB", image.size)
    try:
        for y0 in range(0, image.height, 256):
            _check(cancel)
            region = (0, y0, image.width, min(image.height, y0 + 256))
            with image.crop(region) as crop, crop.convert("RGB") as strip:
                with _grade_strip(strip, settings) as graded:
                    output.paste(graded, (0, y0))
        _check(cancel)
        if settings["bloom"]:
            with output.point([round(max(0, value - .7 * 255)) for value in range(256)] * 3) as threshold:
                with threshold.filter(ImageFilter.GaussianBlur(max(image.size) * .008)) as blur:
                    with blur.point([round(value * settings["bloom"] * .35) for value in range(256)] * 3) as scaled:
                        finished = ImageChops.add(output, scaled)
            output.close()
            output = finished
        _check(cancel)
        if settings["vignette"]:
            with _vignette_tile(round(image.width / image.height, 6)).resize(image.size, Image.Resampling.BILINEAR) as mask:
                with mask.point([round(255 - value * settings["vignette"] * .65) for value in range(256)]) as factor:
                    with Image.merge("RGB", (factor, factor, factor)) as rgb_factor:
                        finished = ImageChops.multiply(output, rgb_factor)
            output.close()
            output = finished
        _check(cancel)
        if settings["grain"]:
            with Image.new("L", image.size) as noise:
                tile = _grain_tile()
                for y0 in range(0, image.height, tile.height):
                    _check(cancel)
                    for x0 in range(0, image.width, tile.width):
                        noise.paste(tile, (x0, y0))
                with noise.point([round(max(0, value - 127.5) * settings["grain"]) for value in range(256)]) as add:
                    with noise.point([round(max(0, 127.5 - value) * settings["grain"]) for value in range(256)]) as subtract:
                        with Image.merge("RGB", (add, add, add)) as add_rgb, Image.merge("RGB", (subtract, subtract, subtract)) as subtract_rgb:
                            with ImageChops.add(output, add_rgb) as added:
                                finished = ImageChops.subtract(added, subtract_rgb)
            output.close()
            output = finished
        _check(cancel)
        if alpha is not None:
            output.putalpha(alpha)
        result, output = output, None
        return result
    finally:
        if output is not None:
            output.close()
        if alpha is not None:
            alpha.close()


def apply_post_processing(path, value, *, cancel=None):
    """Atomically finish a rendered PNG; neutral/disabled performs zero file I/O."""
    settings = validate_post_processing(value)
    if not has_post_processing(settings):
        return False
    from PIL import Image
    path = Path(path)
    temporary = None
    try:
        _check(cancel)
        with Image.open(path) as source:
            source.load()
            output = grade_image(source, settings, cancel=cancel)
            try:
                with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".grade-", suffix=".png", delete=False) as handle:
                    temporary = Path(handle.name)
                output.save(temporary, format="PNG", compress_level=4,
                            **({"icc_profile": source.info["icc_profile"]} if source.info.get("icc_profile") else {}))
                _check(cancel)
                os.replace(temporary, path)
                temporary = None
            finally:
                output.close()
        return True
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)
