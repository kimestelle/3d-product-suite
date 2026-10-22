"""Bounded, content-addressed PNG/JPEG artwork for product label coatings."""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
import stat
import struct
import zlib


MAX_TEXTURE_BYTES = 8 * 1024 * 1024
MAX_TEXTURE_DIMENSION = 8192
MAX_TEXTURE_PIXELS = 32_000_000
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _dimensions(width, height):
    _require(type(width) is int and type(height) is int and 1 <= width <= MAX_TEXTURE_DIMENSION
             and 1 <= height <= MAX_TEXTURE_DIMENSION,
             f"Texture dimensions must be 1–{MAX_TEXTURE_DIMENSION} pixels")
    _require(width * height <= MAX_TEXTURE_PIXELS, "Texture must contain at most 32 million pixels")
    return {"widthPx": width, "heightPx": height}


def validate_texture_asset_record(asset):
    _require(isinstance(asset, dict), "Label texture asset record is required")
    sha = asset.get("sha256")
    _require(isinstance(sha, str) and _SHA.fullmatch(sha), "Texture sha256 must be 64 lowercase hexadecimal characters")
    format_ = asset.get("format")
    _require(format_ in ("png", "jpg"), "Texture format must be png or jpg")
    _require(asset.get("path") == f"assets/{sha}.{format_}", "Texture path must be assets/<sha256>.<format>")
    _dimensions(asset.get("widthPx"), asset.get("heightPx"))
    return asset


def _exif(data):
    """Keep browser and offline artwork orientation identical without rewriting bytes."""
    _require(len(data) >= 8 and data[:2] in (b"II", b"MM"), "Artwork EXIF header is malformed")
    endian = "<" if data[:2] == b"II" else ">"
    _require(struct.unpack_from(endian + "H", data, 2)[0] == 42, "Artwork EXIF TIFF header is malformed")
    pending = [struct.unpack_from(endian + "I", data, 4)[0]]
    _require(pending[0] >= 8, "Artwork EXIF directory offset is malformed")
    visited, entries = set(), 0
    sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4}
    while pending:
        offset = pending.pop()
        _require(offset >= 8 and offset + 2 <= len(data) and offset not in visited and len(visited) < 64,
                 "Artwork EXIF directory is malformed or recursive")
        visited.add(offset)
        count = struct.unpack_from(endian + "H", data, offset)[0]
        entries += count
        _require(entries <= 16384 and offset + 2 + count * 12 + 4 <= len(data), "Artwork EXIF entries are malformed")
        tags = set()
        for index in range(count):
            entry = offset + 2 + index * 12
            tag, type_, values = struct.unpack_from(endian + "HHI", data, entry)
            _require(type_ in sizes and tag not in tags, "Artwork EXIF tag definition is malformed")
            tags.add(tag)
            length = sizes[type_] * values
            if length > 4:
                value_offset = struct.unpack_from(endian + "I", data, entry + 8)[0]
                _require(value_offset >= 8 and value_offset + length <= len(data), "Artwork EXIF value is malformed")
            if tag == 0x0112:
                _require(type_ == 3 and values == 1, "Artwork EXIF orientation is malformed")
                orientation = struct.unpack_from(endian + "H", data, entry + 8)[0]
                _require(orientation == 1,
                         "Export artwork without EXIF rotation (orientation must be 1) so preview and render match")
            if tag in (0x8769, 0x8825, 0xA005):
                _require(type_ in (4, 13) and values == 1, "Artwork EXIF subdirectory is malformed")
                pending.append(struct.unpack_from(endian + "I", data, entry + 8)[0])
        next_offset = struct.unpack_from(endian + "I", data, offset + 2 + count * 12)[0]
        if next_offset:
            pending.append(next_offset)


def _png(payload):
    _require(payload.startswith(_PNG_SIGNATURE), "Expected a PNG image")
    position, chunks, idat = 8, [], []
    header, palette, transparency, exif, ended, data_finished = None, None, False, False, False, False
    while position < len(payload):
        _require(position + 12 <= len(payload), "PNG chunk header is truncated")
        length, kind = struct.unpack_from(">I4s", payload, position)
        _require(re.fullmatch(b"[A-Za-z]{4}", kind) and kind[2] & 32 == 0, "PNG chunk type is invalid")
        position += 8
        _require(position + length + 4 <= len(payload), "PNG chunk is truncated")
        data = payload[position:position + length]
        checksum = struct.unpack_from(">I", payload, position + length)[0]
        _require(zlib.crc32(kind + data) & 0xffffffff == checksum, "PNG chunk checksum is invalid")
        position += length + 4
        _require(chunks or kind == b"IHDR", "PNG must begin with IHDR")
        _require(kind not in (b"acTL", b"fcTL", b"fdAT"), "Upload a static PNG, not an animated PNG")
        if kind == b"IHDR":
            _require(header is None and length == 13 and not chunks, "PNG IHDR is invalid")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", data)
            metadata = _dimensions(width, height)
            _require(color in (0, 2, 3, 4, 6) and depth in {0: (1, 2, 4, 8, 16), 2: (8, 16),
                     3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}[color], "PNG color format is unsupported")
            _require(compression == filtering == 0 and interlace in (0, 1), "PNG compression/filter/interlace is invalid")
            header = (width, height, depth, color, interlace)
        elif kind == b"PLTE":
            _require(palette is None and not idat and length > 0 and length % 3 == 0 and length <= 768,
                     "PNG palette is invalid")
            _require(header[3] not in (0, 4), "Grayscale PNG must not contain a palette")
            if header[3] == 3:
                _require(length // 3 <= 2 ** header[2], "PNG palette exceeds its bit depth")
            palette = data
        elif kind == b"tRNS":
            _require(not transparency and not idat, "PNG transparency must precede its pixels")
            color = header[3]
            _require((color == 0 and length == 2) or (color == 2 and length == 6)
                     or (color == 3 and palette is not None and 0 < length <= len(palette) // 3),
                     "PNG transparency is inconsistent with its color format")
            transparency = True
        elif kind == b"eXIf":
            _require(not exif, "PNG contains duplicate EXIF metadata")
            _exif(data)
            exif = True
            if idat:
                data_finished = True
        elif kind == b"IDAT":
            _require(not data_finished, "PNG IDAT chunks must be consecutive")
            _require(header[3] != 3 or palette is not None, "Indexed PNG requires a palette")
            idat.append(data)
        elif kind == b"IEND":
            _require(length == 0 and idat and position == len(payload), "PNG IEND or trailing data is invalid")
            ended = True
            break
        else:
            _require(kind[0] & 32, "PNG contains an unsupported critical chunk")
            if idat:
                data_finished = True
        chunks.append(kind)
    _require(ended and header is not None and idat, "PNG image is incomplete")
    width, height, depth, color, interlace = header
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = [(0, 0, 1, 1)] if not interlace else [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8),
              (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]
    row_starts, expected = [], 0
    for left, top, step_x, step_y in passes:
        pass_width = max(0, (width - left + step_x - 1) // step_x)
        pass_height = max(0, (height - top + step_y - 1) // step_y)
        if not pass_width:
            continue
        row_bytes = (pass_width * channels * depth + 7) // 8
        for _ in range(pass_height):
            row_starts.append(expected)
            expected += row_bytes + 1
    inflater, decoded, row = zlib.decompressobj(), 0, 0
    try:
        for compressed in idat:
            while compressed:
                block = inflater.decompress(compressed, 65536)
                compressed = inflater.unconsumed_tail
                _require(not inflater.unused_data, "PNG contains trailing compressed data")
                _require(decoded + len(block) <= expected, "PNG decoded pixels exceed its dimensions")
                while row < len(row_starts) and row_starts[row] < decoded + len(block):
                    _require(block[row_starts[row] - decoded] <= 4, "PNG scanline filter is invalid")
                    row += 1
                decoded += len(block)
        _require(inflater.eof and decoded == expected, "PNG pixel data is truncated or inconsistent")
    except zlib.error as error:
        raise ValueError("PNG compressed pixels are invalid") from error
    return metadata


def _jpeg(payload):
    _require(payload.startswith(b"\xff\xd8"), "Expected a JPEG image")
    position, metadata, components, scans = 2, None, set(), 0
    quantization, huffman, exif = False, False, False
    while position < len(payload):
        _require(payload[position] == 0xff, "JPEG marker is invalid")
        while position < len(payload) and payload[position] == 0xff:
            position += 1
        _require(position < len(payload), "JPEG marker is truncated")
        marker = payload[position]
        position += 1
        if marker == 0xd9:
            _require(metadata is not None and scans and quantization and huffman and position == len(payload),
                     "JPEG image is incomplete or contains trailing data")
            return metadata
        _require(marker not in (0, 1, 0xd8) and not 0xd0 <= marker <= 0xd7, "JPEG marker is out of place")
        _require(position + 2 <= len(payload), "JPEG segment header is truncated")
        length = struct.unpack_from(">H", payload, position)[0]
        _require(length >= 2 and position + length <= len(payload), "JPEG segment is truncated")
        data = payload[position + 2:position + length]
        position += length
        if marker == 0xe1 and data.startswith(b"Exif"):
            _require(data.startswith(b"Exif\0\0") and not exif, "JPEG EXIF metadata is malformed or duplicated")
            _exif(data[6:])
            exif = True
        elif marker in (0xc0, 0xc2):
            _require(metadata is None and len(data) >= 6 and data[0] == 8, "JPEG frame is unsupported")
            height, width, count = struct.unpack_from(">HHB", data, 1)
            metadata = _dimensions(width, height)
            _require(count in (1, 3, 4) and len(data) == 6 + count * 3, "JPEG component table is invalid")
            for index in range(count):
                identifier, sampling, table = data[6 + index * 3:9 + index * 3]
                _require(identifier not in components and 1 <= sampling >> 4 <= 4 and 1 <= sampling & 15 <= 4
                         and table <= 3, "JPEG component definition is invalid")
                components.add(identifier)
        elif marker in (0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
            raise ValueError("Use a standard baseline or progressive JPEG")
        elif marker == 0xdb:
            offset = 0
            while offset < len(data):
                definition = data[offset]
                _require(definition >> 4 in (0, 1) and definition & 15 <= 3, "JPEG quantization table is invalid")
                offset += 1 + (128 if definition >> 4 else 64)
            _require(offset == len(data) and offset > 0, "JPEG quantization table is truncated")
            quantization = True
        elif marker == 0xc4:
            offset = 0
            while offset < len(data):
                _require(offset + 17 <= len(data), "JPEG Huffman table is truncated")
                definition = data[offset]
                _require(definition >> 4 in (0, 1) and definition & 15 <= 3, "JPEG Huffman table is invalid")
                counts = data[offset + 1:offset + 17]
                symbols = sum(counts)
                _require(0 < symbols <= 256, "JPEG Huffman table has invalid symbols")
                available = 1
                for count in counts:
                    available = available * 2 - count
                    _require(available >= 0, "JPEG Huffman code lengths are inconsistent")
                offset += 17 + symbols
            _require(offset == len(data) and offset > 0, "JPEG Huffman symbols are truncated")
            huffman = True
        elif marker == 0xda:
            _require(metadata is not None and quantization and huffman and len(data) >= 4, "JPEG scan precedes its image tables")
            count = data[0]
            _require(1 <= count <= len(components) and len(data) == 1 + count * 2 + 3,
                     "JPEG scan component table is invalid")
            scan_ids = set()
            for index in range(count):
                identifier, tables = data[1 + index * 2:3 + index * 2]
                _require(identifier in components and identifier not in scan_ids and tables >> 4 <= 3 and tables & 15 <= 3,
                         "JPEG scan references invalid components or tables")
                scan_ids.add(identifier)
            _require(data[-3] <= data[-2] <= 63 and data[-1] >> 4 <= 13 and data[-1] & 15 <= 13,
                     "JPEG spectral scan parameters are invalid")
            start = position
            while position < len(payload):
                if payload[position] != 0xff:
                    position += 1
                    continue
                boundary = position
                while position < len(payload) and payload[position] == 0xff:
                    position += 1
                _require(position < len(payload), "JPEG scan is truncated")
                if payload[position] == 0 or 0xd0 <= payload[position] <= 0xd7:
                    position += 1
                    continue
                position = boundary
                break
            _require(position > start, "JPEG scan contains no image data")
            scans += 1
        elif marker == 0xdd:
            _require(len(data) == 2, "JPEG restart interval is invalid")
        else:
            _require(0xe0 <= marker <= 0xef or marker == 0xfe, "JPEG contains an unsupported marker")
    raise ValueError("JPEG image is missing its end marker")


def inspect_texture(payload, format_):
    _require(isinstance(payload, bytes) and 0 < len(payload) <= MAX_TEXTURE_BYTES,
             "Texture must be nonempty and at most 8 MiB")
    _require(format_ in ("png", "jpg"), "Upload a PNG or JPEG label image")
    return _png(payload) if format_ == "png" else _jpeg(payload)


def read_texture_bytes(path):
    try:
        path = Path(path)
        info = path.stat()
        _require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_TEXTURE_BYTES,
                 "Texture must be a regular file of at most 8 MiB")
        with path.open("rb") as handle:
            payload = handle.read(MAX_TEXTURE_BYTES + 1)
        _require(0 < len(payload) <= MAX_TEXTURE_BYTES, "Texture exceeds the 8 MiB limit")
        return payload
    except OSError as error:
        raise ValueError(f"Cannot read texture asset: {error.strerror or type(error).__name__}") from error


def verify_texture_asset(asset, source_dir):
    from .worlds import safe_asset_path
    validate_texture_asset_record(asset)
    payload = read_texture_bytes(safe_asset_path(source_dir, asset["path"]))
    _require(hashlib.sha256(payload).hexdigest() == asset["sha256"], "Texture hash does not match the immutable scene revision")
    metadata = inspect_texture(payload, asset["format"])
    _require(all(metadata[key] == asset[key] for key in ("widthPx", "heightPx")),
             "Texture dimensions do not match the immutable scene revision")
    return {"path": asset["path"], "sha256": asset["sha256"], "format": asset["format"], "bytes": len(payload), **metadata}


def import_texture(payload, library_root, *, filename):
    from .worlds import _immutable_write, safe_asset_path
    _require(isinstance(filename, str) and filename and len(filename) <= 255
             and not any(char in filename for char in ("/", "\\", "\0", ":")), "Texture filename must be a local filename")
    suffix = Path(filename).suffix.lower()
    _require(suffix in (".png", ".jpg", ".jpeg"), "Upload a PNG or JPEG label image")
    format_ = "png" if suffix == ".png" else "jpg"
    metadata = inspect_texture(payload, format_)
    digest = hashlib.sha256(payload).hexdigest()
    asset = {"format": format_, "path": f"assets/{digest}.{format_}", "sha256": digest, **metadata}
    _immutable_write(safe_asset_path(library_root, asset["path"]), payload)
    return {"asset": asset, "name": filename}
