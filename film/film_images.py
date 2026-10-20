"""Local still-image clips, normalized once to bounded, display-ready sRGB PNGs."""
from __future__ import annotations

import hashlib
import io
from pathlib import Path
import re
import warnings

MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_IMAGE_PIXELS = 24 * 1024 * 1024
MAX_IMAGE_SIDE = 8192


def _require(value, message):
    if not value:
        raise ValueError(message)


def validate_film_image_asset(asset):
    _require(isinstance(asset, dict), "Film image asset must be an object")
    digest = asset.get("sha256")
    _require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "Film image SHA256 is invalid")
    _require(asset.get("format") in ("png", "jpeg", "webp"), "Film image must be PNG, JPEG or WebP")
    _require(asset.get("path") == f"assets/{digest}.{asset['format']}", "Film image path must be content-addressed")
    for key in ("width", "height"):
        _require(type(asset.get(key)) is int and 0 < asset[key] <= MAX_IMAGE_SIDE, "Film image dimensions exceed 8192 pixels")
    _require(asset["width"] * asset["height"] <= MAX_IMAGE_PIXELS, "Film image exceeds 24 megapixels")
    return asset


def _pillow():
    try:
        from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError
    except ImportError as error:
        raise ValueError("Image shots need Pillow; install the project's Python dependencies and restart the server") from error
    return Image, ImageCms, ImageOps, UnidentifiedImageError


def _decode(payload):
    Image, ImageCms, ImageOps, UnidentifiedImageError = _pillow()
    _require(isinstance(payload, bytes) and 0 < len(payload) <= MAX_IMAGE_BYTES, "Film image must be at most 32 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload)) as source:
                format_ = (source.format or "").lower()
                _require(format_ in ("png", "jpeg", "webp"), "Upload a PNG, JPEG or WebP image")
                width, height = source.size
                _require(0 < width <= MAX_IMAGE_SIDE and 0 < height <= MAX_IMAGE_SIDE and width * height <= MAX_IMAGE_PIXELS,
                         "Film image must fit within 8192 pixels per side and 24 megapixels")
                _require(getattr(source, "n_frames", 1) == 1, "Use a still image; animated image files are unsupported")
                source.load()  # Full decode rejects incomplete/corrupt files, not just malformed headers.
                profile = source.info.get("icc_profile")
                oriented = ImageOps.exif_transpose(source)
                alpha = oriented.convert("RGBA").getchannel("A")
                if profile:
                    _require(len(profile) <= 1024 * 1024, "Image color profile exceeds 1 MiB")
                    # Honor embedded photography/print profiles once. Browser and export
                    # subsequently read the same stripped, sRGB image without applying AgX.
                    color = ImageCms.profileToProfile(oriented.convert("CMYK" if oriented.mode == "CMYK" else "RGB"),
                              ImageCms.ImageCmsProfile(io.BytesIO(profile)), ImageCms.createProfile("sRGB"), outputMode="RGB")
                    result = color.convert("RGBA")
                    result.putalpha(alpha)
                else:
                    result = oriented.convert("RGBA")
                return result, format_
    except (OSError, SyntaxError, UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning, ImageCms.PyCMSError) as error:
        raise ValueError("Image could not be decoded safely; use a complete PNG, JPEG or WebP file") from error


def verify_film_image(payload, asset):
    validate_film_image_asset(asset)
    _require(hashlib.sha256(payload).hexdigest() == asset["sha256"], "Film image changed after import")
    image, format_ = _decode(payload)
    try:
        _require(format_ == asset["format"] and image.size == (asset["width"], asset["height"]),
                 "Film image bytes do not match their declared format or dimensions")
        return {"width": image.width, "height": image.height}
    finally:
        image.close()


def import_film_image(payload, filename, root):
    from .worlds import _immutable_write
    _require(Path(filename).suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"), "Upload a PNG, JPEG or WebP image")
    image, _ = _decode(payload)
    try:
        result = io.BytesIO()
        image.info.clear()
        image.save(result, format="PNG", compress_level=6)
        encoded = result.getvalue()
        _require(len(encoded) <= MAX_IMAGE_BYTES, "Decoded image exceeds the 32 MiB PNG limit; resize it first")
        digest = hashlib.sha256(encoded).hexdigest()
        asset = {"path": f"assets/{digest}.png", "sha256": digest, "format": "png",
                 "width": image.width, "height": image.height}
        _immutable_write(Path(root) / asset["path"], encoded)
        return asset
    finally:
        image.close()


def render_clip(clip, root, width, height, destination):
    """Write non-scene frames directly; black gaps and alpha stay opaque black."""
    Image, _, ImageOps, _ = _pillow()
    from .worlds import safe_asset_path
    _require(type(width) is int and type(height) is int and 0 < width <= 16384 and 0 < height <= 16384,
             "Film output dimensions are invalid")
    output = Image.new("RGB", (width, height), "black")
    try:
        if clip["kind"] == "image":
            asset = validate_film_image_asset(clip["asset"])
            path = safe_asset_path(root, asset["path"])
            _require(path.stat().st_size <= MAX_IMAGE_BYTES, "Film image exceeds 32 MiB")
            payload = path.read_bytes()
            verify_film_image(payload, asset)
            source, _ = _decode(payload)
            try:
                fit = clip.get("fit")
                _require(fit in ("contain", "cover"), "Image fit must be contain or cover")
                resized = (ImageOps.contain(source, output.size, Image.Resampling.LANCZOS) if fit == "contain"
                           else ImageOps.fit(source, output.size, Image.Resampling.LANCZOS))
                try:
                    output.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2), resized)
                finally:
                    resized.close()
            finally:
                source.close()
        else:
            _require(clip["kind"] == "black", "Only image and black clips can bypass the scene renderer")
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".partial.png")
        output.save(temporary, format="PNG")
        temporary.replace(destination)
    finally:
        output.close()
