"""Immutable product artwork, shared by the viewport and the render bundle."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import re
import struct

from .film_images import (MAX_IMAGE_BYTES, _decode, _pillow, validate_film_image_asset,
                          verify_film_image)

MAX_ARTWORK_SIDE = 4096
MAX_ARTWORK_BYTES = 16 * 1024 * 1024


def _require(value, message):
    if not value:
        raise ValueError(message)


def validate_artwork_asset(asset):
    validate_film_image_asset(asset)
    _require(asset['format'] == 'png', 'Artwork must use a normalized PNG asset')
    _require(max(asset['width'], asset['height']) <= MAX_ARTWORK_SIDE, 'Artwork exceeds 4096 pixels per side')
    return asset


def import_artwork(payload, filename, root):
    """Decode once, apply orientation/profile and keep exact RGBA pixels thereafter."""
    from .worlds import _immutable_write
    _require(Path(filename).suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'), 'Upload a PNG, JPEG or WebP image')
    image, _ = _decode(payload)
    try:
        Image, _, _, _ = _pillow()
        image.thumbnail((MAX_ARTWORK_SIDE, MAX_ARTWORK_SIDE), Image.Resampling.LANCZOS)
        image.info.clear()
        output = io.BytesIO()
        image.save(output, format='PNG', compress_level=6)
        encoded = output.getvalue()
        _require(len(encoded) <= MAX_ARTWORK_BYTES, 'Artwork exceeds 16 MiB after decoding; resize the image first')
        digest = hashlib.sha256(encoded).hexdigest()
        asset = {'path': f'assets/{digest}.png', 'sha256': digest, 'format': 'png',
                 'width': image.width, 'height': image.height}
        _immutable_write(Path(root) / asset['path'], encoded)
        return asset
    finally:
        image.close()


def verify_artwork(payload, asset):
    validate_artwork_asset(asset)
    _require(len(payload) <= MAX_ARTWORK_BYTES, 'Artwork exceeds 16 MiB')
    return verify_film_image(payload, asset)


def validate_product_artwork(scene):
    product = scene.get('product', {})
    components = {item['id']: item for item in product.get('components', [])}
    replacements = product.get('artwork', [])
    _require(isinstance(replacements, list) and len(replacements) <= 256,
             'Product artwork must be a list of at most 256 replacements')
    seen = set()
    for entry in replacements:
        _require(isinstance(entry, dict), 'Artwork replacement must be an object')
        component_id, part_id = entry.get('componentId'), entry.get('partId')
        _require(isinstance(component_id, str) and component_id in components,
                 'Artwork component does not exist')
        component = components[component_id]
        _require(isinstance(part_id, str) and part_id not in seen, 'Artwork part must be unique')
        if component['shape'] == 'mesh':
            _require(re.fullmatch(re.escape(component_id) + r'::node:(0|[1-9][0-9]*)', part_id),
                     'Artwork must reference an exact imported mesh node')
            if 'sourceNodes' in component:
                index = int(part_id.rsplit(':', 1)[1])
                node = next((item for item in component['sourceNodes'] if item['nodeIndex'] == index), None)
                _require(node is not None and node.get('hasMesh'), 'Artwork needs a mesh, not an assembly group')
        else:
            _require(part_id == component_id, 'Artwork must reference its component')
        seen.add(part_id)
        _require(entry.get('finish') in ('paper', 'original'), 'Artwork finish must be paper or original')
        validate_artwork_asset(entry.get('asset'))
    for decal in product.get('decals', []):
        if 'artwork' in decal:
            validate_artwork_asset(decal['artwork'])
    return scene


def iter_artwork_assets(scene):
    validate_product_artwork(scene)
    for entry in scene.get('product', {}).get('artwork', []):
        yield entry['asset']
    for decal in scene.get('product', {}).get('decals', []):
        if 'artwork' in decal:
            yield decal['artwork']


def validate_artwork_nodes(scene, component, payload):
    """Do not accept a guessed node, empty group, missing UVs or hidden primitive."""
    entries = [item for item in scene.get('product', {}).get('artwork', [])
               if item['componentId'] == component.get('id')]
    if not entries:
        return
    size = struct.unpack_from('<I', payload, 12)[0]
    document = json.loads(payload[20:20 + size])
    nodes = document.get('nodes', [])
    active = set()
    def visit(index):
        if index in active:
            return
        active.add(index)
        for child in nodes[index].get('children', []):
            visit(child)
    for root in document['scenes'][document.get('scene', 0)]['nodes']:
        visit(root)
    for entry in entries:
        index = int(entry['partId'].rsplit(':', 1)[1])
        _require(index in active and 'mesh' in nodes[index],
                 'Artwork must reference an existing mesh in the active source scene')
        primitives = document['meshes'][nodes[index]['mesh']]['primitives']
        _require(primitives and all('TEXCOORD_0' in item.get('attributes', {}) for item in primitives),
                 'Artwork replacement needs original UV coordinates on every selected mesh surface')
