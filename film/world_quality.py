"""Measured visual-world diagnostics; never regenerate or rewrite an asset.

Resolution alone is not a quality score. These facts reveal an absent visual
texture, lost UVs or a preview memory cost without inventing usable room detail.
"""
from __future__ import annotations

import io
import json
import struct
import warnings

from PIL import Image

from . import worlds

MAX_SOURCE_TEXTURE_EDGE = 16384
MAX_SOURCE_TEXTURE_PIXELS = 128 * 1024 * 1024


def inspect_visual_world(payload, *, source_name=""):
    """Return bounded, deterministic metadata from a validated self-contained GLB.

    Read image headers rather than decoding large textures. Provider exports can
    have broken images despite syntactically valid glTF: report that explicitly.
    Referenced surface maps count only when the primitive has their UV channel.
    """
    worlds._validate_content(payload, "glb", source_name)
    size = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20 + size])
    binary_offset = 20 + size
    # Avoid copying the entire geometry/texture BIN chunk just to read image
    # headers. Pillow gets a short-lived byte stream for each encoded image.
    binary = memoryview(payload)[binary_offset + 8:] if binary_offset + 8 <= len(payload) else b""
    buffers = [worlds._data_uri(buffer["uri"]) if "uri" in buffer else binary
               for buffer in document.get("buffers", [])]
    images, image_warnings, total_pixels = [], [], 0
    for index, image in enumerate(document.get("images", [])):
        try:
            if "bufferView" in image:
                view = document["bufferViews"][image["bufferView"]]
                start = view.get("byteOffset", 0)
                encoded = buffers[view["buffer"]][start:start + view["byteLength"]]
            else:
                encoded = worlds._data_uri(image["uri"])
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(encoded), formats=("PNG", "JPEG", "WEBP")) as decoded:
                    width, height = decoded.size
        except Image.DecompressionBombError as error:
            raise ValueError("World source texture exceeds the supported decoder budget") from error
        except (OSError, ValueError, KeyError, IndexError, TypeError):
            images.append({"index": index, "readable": False})
            image_warnings.append(f"Image {index + 1} could not be inspected; verify its texture before close views.")
            continue
        total_pixels += width * height
        # GLTFLoader decodes originals before a preview can be resized. Reject
        # pathological new imports here; retaining a bounded preview afterward
        # cannot undo a decoder allocation. Existing archived assets stay intact.
        worlds._require(0 < width <= MAX_SOURCE_TEXTURE_EDGE and 0 < height <= MAX_SOURCE_TEXTURE_EDGE
                        and total_pixels <= MAX_SOURCE_TEXTURE_PIXELS,
                        "World source texture exceeds the supported decoder budget (16384px edge, 128 Mi pixels combined)")
        images.append({"index": index, "width": width, "height": height, "encodedBytes": len(encoded),
                       "decodedRgbaBytes": width * height * 4})
    accessors = document.get("accessors", [])
    materials = document.get("materials", [])
    textures = document.get("textures", [])
    triangles = textured_triangles = coloured_triangles = 0
    referenced_images = set()
    missing_uvs = False
    primitives = 0
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            primitives += 1
            attributes = primitive["attributes"]
            index = primitive.get("indices", attributes["POSITION"])
            worlds._require(type(index) is int and 0 <= index < len(accessors),
                            "GLB primitive references an unknown index accessor")
            count = accessors[index]["count"]
            mode = primitive.get("mode", 4)
            count = count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
            triangles += count
            if "COLOR_0" in attributes:
                coloured_triangles += count
            material_index = primitive.get("material")
            material = materials[material_index] if type(material_index) is int and 0 <= material_index < len(materials) else {}
            colour_maps = [material.get("pbrMetallicRoughness", {}).get("baseColorTexture"), material.get("emissiveTexture")]
            mapped = False
            for record in colour_maps:
                if not isinstance(record, dict):
                    continue
                texture_index = record.get("index")
                if type(texture_index) is not int or not 0 <= texture_index < len(textures):
                    continue
                source = textures[texture_index].get("source")
                texcoord = record.get("extensions", {}).get("KHR_texture_transform", {}).get("texCoord", record.get("texCoord", 0))
                if f"TEXCOORD_{texcoord}" not in attributes:
                    missing_uvs = True
                    continue
                if type(source) is int and 0 <= source < len(images) and "width" in images[source]:
                    referenced_images.add(source)
                    mapped = True
            if mapped:
                textured_triangles += count
    used = [image for image in images if image["index"] in referenced_images]
    notes = list(image_warnings)
    if not textured_triangles:
        notes.append("No readable UV-mapped colour texture is used by the room geometry; grading cannot restore missing surface detail.")
    if missing_uvs:
        notes.append("A colour texture has no matching UV channel on its geometry; that surface cannot display the map correctly.")
    max_edge = max((max(image["width"], image["height"]) for image in used), default=0)
    if max_edge and max_edge < 2048:
        notes.append("The largest used colour texture is below 2048px; close views may expose limited source detail.")
    rgba_bytes = sum(image["decodedRgbaBytes"] for image in used)
    if rgba_bytes > 256 * 1024 * 1024:
        notes.append("Used colour textures exceed 256 MiB decoded; use a bounded preview while preserving source assets for export.")
    return {"schemaVersion": 1, "basis": "source-glb-inspection", "triangleCount": triangles,
            "primitiveCount": primitives, "materialCount": len(materials), "imageCount": len(images),
            "usedColourImageCount": len(used), "maxColourTextureEdge": max_edge,
            "usedColourDecodedRgbaBytes": rgba_bytes, "texturedTriangleCount": textured_triangles,
            "vertexColouredTriangleCount": coloured_triangles, "images": images, "warnings": notes}
