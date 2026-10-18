"""Bounded, immutable PNG maps used by live materials and offline exports."""
import math
import re
import struct
import zlib

MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_IMAGE_PIXELS = 4096 * 4096
MAP_TYPES = ("basecolor", "normal", "roughness", "metalness", "height")


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_image_asset(asset):
    _require(isinstance(asset, dict), "Material image asset must be an object")
    digest = asset.get("sha256")
    _require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "Material image SHA256 is invalid")
    _require(asset.get("format") == "png" and asset.get("path") == f"assets/{digest}.png",
             "Material image must use assets/<sha256>.png")
    return asset


def validate_material_textures(material):
    if "textures" in material:
        maps = material["textures"]
        _require(isinstance(maps, dict) and 0 < len(maps) <= len(MAP_TYPES)
                 and set(maps).issubset(MAP_TYPES), "Material textures must contain named PBR maps")
        for asset in maps.values():
            validate_image_asset(asset)
    if "textureRepeat" in material:
        values = material["textureRepeat"]
        _require(isinstance(values, list) and len(values) == 2
                 and all(type(v) in (int, float) and math.isfinite(v) and .01 <= v <= 100 for v in values),
                 "Material textureRepeat must contain two values in [0.01,100]")
    for name, maximum in (("normalScale", 4), ("heightScaleM", .01)):
        if name in material:
            value = material[name]
            _require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum,
                     f"Material {name} is outside its supported range")


def iter_material_assets(scene):
    environment = scene.get("environment", {})
    product = scene.get("product", {})
    targets = [*product.get("components", []), *product.get("materialPresets", []),
               environment.get("plinth", {}), *environment.get("props", [])]
    for target in targets:
        material = target.get("material", {})
        validate_material_textures(material)
        for asset in material.get("textures", {}).values():
            yield validate_image_asset(asset)


def validate_png(payload):
    """Validate structure, checksums and bounded scanline decompression, without decoding pixels."""
    _require(isinstance(payload, bytes) and 0 < len(payload) <= MAX_IMAGE_BYTES, "Material PNG exceeds the 16 MiB limit")
    _require(payload[:8] == b"\x89PNG\r\n\x1a\n", "Material map must be a PNG image")
    offset, header, image_data, ended, saw_palette, closed_idat = 8, None, bytearray(), False, False, False
    while offset < len(payload):
        _require(offset + 12 <= len(payload), "Material PNG has a truncated chunk")
        length = struct.unpack_from(">I", payload, offset)[0]
        kind = payload[offset+4:offset+8]
        end = offset+12+length
        _require(end <= len(payload), "Material PNG chunk escapes its file")
        data = payload[offset+8:end-4]
        checksum = struct.unpack_from(">I", payload, end-4)[0]
        _require(zlib.crc32(kind+data) & 0xffffffff == checksum, "Material PNG checksum is invalid")
        _require(kind not in (b"acTL", b"fcTL", b"fdAT"), "Animated material PNG maps are unsupported")
        if header is None:
            _require(kind == b"IHDR" and length == 13, "Material PNG must begin with IHDR")
            width,height,depth,color,compression,filter_,interlace = struct.unpack(">IIBBBBB", data)
            _require(0 < width <= 4096 and 0 < height <= 4096 and width*height <= MAX_IMAGE_PIXELS,
                     "Material PNG dimensions exceed 4096 pixels")
            allowed = {0:(1,2,4,8,16), 2:(8,16), 3:(1,2,4,8), 4:(8,16), 6:(8,16)}
            _require(color in allowed and depth in allowed[color] and compression == filter_ == interlace == 0,
                     "Material PNG uses an unsupported pixel format or interlace")
            channels = {0:1,2:3,3:1,4:2,6:4}[color]
            header = {"width":width,"height":height,"bitDepth":depth,"channels":channels}
        elif kind == b"IHDR":
            raise ValueError("Material PNG repeats IHDR")
        elif kind == b"PLTE":
            _require(not image_data and not saw_palette and length % 3 == 0 and 0 < length <= 768,
                     "Material PNG palette is invalid")
            saw_palette = True
        elif kind == b"IDAT":
            _require(not closed_idat and (color != 3 or saw_palette), "Material PNG image data is out of order")
            image_data.extend(data)
        elif kind == b"IEND":
            _require(length == 0 and end == len(payload) and image_data, "Material PNG ending is invalid")
            ended = True
        elif kind[0] & 32 == 0:
            raise ValueError("Material PNG contains an unsupported critical chunk")
        if image_data and kind not in (b"IDAT", b"IEND"):
            closed_idat = True
        offset = end
    _require(ended and header is not None, "Material PNG is incomplete")
    row_size = (width*channels*depth+7)//8 + 1
    expected = row_size*height
    decompressor = zlib.decompressobj()
    try:
        raw = decompressor.decompress(bytes(image_data), expected+1)
    except zlib.error:
        raise ValueError("Material PNG pixel data is corrupt") from None
    _require(len(raw) == expected and decompressor.eof and not decompressor.unused_data and not decompressor.unconsumed_tail,
             "Material PNG decoded size does not match its dimensions")
    _require(all(raw[row_size*row] <= 4 for row in range(height)), "Material PNG scanline filter is invalid")
    return header


def validate_hdri_asset(asset):
    _require(isinstance(asset, dict), "HDRI asset must be an object")
    digest = asset.get("sha256")
    _require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)
             and asset.get("format") == "hdr" and asset.get("path") == f"assets/{digest}.hdr",
             "HDRI must use assets/<sha256>.hdr")
    return asset
