"""Conservative, source-bound surface proposals and immutable mesh derivatives.

No object recognition or surface completion occurs here. Candidates are connected
near-planar face sets. A person supplies the role; separate preserves geometry,
and flatten moves only the selected patch's interior within an explicit budget.
"""
from __future__ import annotations

from array import array
import copy
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import threading

from .jobs import _atomic_json
from . import worlds

ENGINE = 'connected-plane-interior-v2'
MAX_FACES = 1_000_000
MAX_VERTICES = 3_000_000
MAX_CANDIDATE_FACES = 300_000
MAX_EDGE_STRAIN = .05
MAX_NORMAL_ROTATION_DEGREES = 10.
ROLES = ('floor', 'wall', 'pool-rim', 'other')
_ID = re.compile(r'[a-z0-9-]{1,80}\Z')
_WIDTH = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
_COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _dot(a, b):
    return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]


def _cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def _sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def _normal(value):
    length = math.sqrt(_dot(value, value))
    return tuple(v/length for v in value) if length > 1e-18 else (0., 0., 0.)


IDENTITY = (1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.)


def _multiply(a, b):
    return tuple(sum(a[k*4+r] * b[c*4+k] for k in range(4)) for c in range(4) for r in range(4))


def _transform(matrix, point):
    return tuple(sum(matrix[c*4+r] * point[c] for c in range(3)) + matrix[12+r] for r in range(3))


def _inverse(matrix):
    a, b, c = matrix[0], matrix[4], matrix[8]
    d, e, f = matrix[1], matrix[5], matrix[9]
    g, h, i = matrix[2], matrix[6], matrix[10]
    determinant = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g)
    _require(abs(determinant) > 1e-12, 'World cleanup cannot operate on a singular node transform.')
    rows = ((e*i-f*h, c*h-b*i, b*f-c*e),
            (f*g-d*i, a*i-c*g, c*d-a*f),
            (d*h-e*g, b*g-a*h, a*e-b*d))
    rows = tuple(tuple(v/determinant for v in row) for row in rows)
    t = matrix[12:15]
    return tuple(rows[r][c] if c < 3 and r < 3 else
                 -sum(rows[r][k]*t[k] for k in range(3)) if c == 3 and r < 3 else
                 1. if r == c == 3 else 0. for c in range(4) for r in range(4))


def _node_matrix(node):
    if 'matrix' in node:
        value = node['matrix']
        _require(len(value) == 16 and all(math.isfinite(v) for v in value), 'Invalid world node matrix.')
        _require(all(abs(value[i]) < 1e-12 for i in (3,7,11)) and abs(value[15]-1) < 1e-12,
                 'Projective node transforms cannot use surface cleanup.')
        return tuple(value)
    x, y, z, w = node.get('rotation', (0., 0., 0., 1.))
    _require(all(math.isfinite(v) for v in (x, y, z, w)), 'Invalid world node rotation.')
    qlength = math.sqrt(x*x+y*y+z*z+w*w)
    _require(abs(qlength-1) < 1e-4, 'World node rotation must be a normalized quaternion.')
    sx, sy, sz = node.get('scale', (1., 1., 1.))
    tx, ty, tz = node.get('translation', (0., 0., 0.))
    return ((1-2*y*y-2*z*z)*sx, (2*x*y+2*w*z)*sx, (2*x*z-2*w*y)*sx, 0.,
            (2*x*y-2*w*z)*sy, (1-2*x*x-2*z*z)*sy, (2*y*z+2*w*x)*sy, 0.,
            (2*x*z+2*w*y)*sz, (2*y*z-2*w*x)*sz, (1-2*x*x-2*y*y)*sz, 0., tx, ty, tz, 1.)


class _Glb:
    def __init__(self, payload):
        _require(payload[:4] == b'glTF' and len(payload) >= 28, 'Cleanup requires a valid GLB.')
        version, length = struct.unpack_from('<II', payload, 4)
        size, kind = struct.unpack_from('<II', payload, 12)
        _require(version == 2 and length == len(payload) and kind == 0x4e4f534a, 'Unsupported world GLB header.')
        self.document = json.loads(payload[20:20+size])
        start = 20+size
        _require(start+8 <= len(payload), 'Cleanup requires an embedded GLB buffer.')
        binary_size, binary_kind = struct.unpack_from('<II', payload, start)
        _require(binary_kind == 0x004e4942 and start+8+binary_size == len(payload), 'Cleanup requires one embedded GLB BIN chunk.')
        self.binary = payload[start+8:]
        d = self.document
        _require(len(d.get('buffers', [])) == 1 and 'uri' not in d['buffers'][0], 'Cleanup requires one embedded world buffer.')
        _require(not d.get('animations') and not d.get('skins'), 'Animated or skinned worlds cannot use static surface cleanup.')
        _require(not d.get('extensionsRequired'), 'Required GLB extensions are not supported by surface cleanup.')
        self.instances = []
        seen = set()
        _require(isinstance(d.get('nodes'), list) and isinstance(d.get('meshes'), list)
                 and isinstance(d.get('scenes'), list) and d['scenes'], 'World cleanup needs an explicit static GLB scene.')

        def visit(index, parent, ancestors):
            _require(type(index) is int and 0 <= index < len(d.get('nodes', [])) and index not in ancestors, 'Invalid world node hierarchy.')
            _require(index not in seen, 'Instanced scene nodes require separate cleanup review.')
            seen.add(index)
            node = d['nodes'][index]
            matrix = _multiply(parent, _node_matrix(node))
            if 'mesh' in node:
                _require('skin' not in node and 'weights' not in node, 'Deformed worlds cannot use static surface cleanup.')
                mesh = d['meshes'][node['mesh']]
                for primitive_index, primitive in enumerate(mesh['primitives']):
                    _require(primitive.get('mode', 4) == 4 and not primitive.get('targets') and not primitive.get('extensions'),
                             'Cleanup currently supports static, uncompressed TRIANGLES primitives.')
                    self.instances.append({'nodeIndex': index, 'meshIndex': node['mesh'], 'primitiveIndex': primitive_index,
                                           'primitive': primitive, 'matrix': matrix, 'inverse': _inverse(matrix)})
            for child in node.get('children', []):
                visit(child, matrix, {*ancestors, index})
        active = d.get('scene', 0)
        _require(type(active) is int and 0 <= active < len(d['scenes']), 'World has no valid active scene.')
        for index in d.get('scenes', [])[active]['nodes']:
            visit(index, IDENTITY, set())
        _require(self.instances, 'World has no active visual mesh surfaces.')

    def attribute(self, accessor_index):
        d = self.document
        _require(type(accessor_index) is int and 0 <= accessor_index < len(d.get('accessors', [])), 'World references an unknown accessor.')
        accessor = d['accessors'][accessor_index]
        _require('sparse' not in accessor and 'bufferView' in accessor, 'Sparse accessors cannot use surface cleanup.')
        _require(type(accessor['bufferView']) is int and 0 <= accessor['bufferView'] < len(d.get('bufferViews', [])), 'World references an unknown buffer view.')
        view = d['bufferViews'][accessor['bufferView']]
        _require(view.get('buffer', 0) == 0, 'Cleanup requires one embedded world buffer.')
        _require(accessor.get('componentType') in _WIDTH and accessor.get('type') in _COMPONENTS, 'World attribute representation is unsupported.')
        width = _WIDTH[accessor['componentType']] * _COMPONENTS[accessor['type']]
        stride = view.get('byteStride', width)
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        count = accessor['count']
        _require(type(count) is int and 0 <= count <= MAX_VERTICES and stride >= width
                 and start >= 0 and start + max(0, count-1)*stride + (width if count else 0) <= len(self.binary),
                 'World accessor exceeds the supported cleanup bounds.')
        return accessor, start, stride, width

    def triangles(self, instance):
        primitive = instance['primitive']
        accessor, _, _, _ = self.attribute(primitive['attributes']['POSITION'])
        _require(accessor['componentType'] == 5126 and accessor['type'] == 'VEC3' and not accessor.get('normalized'),
                 'World cleanup requires float32 position attributes.')
        count = accessor['count']
        if 'indices' in primitive:
            idx, start, step, width = self.attribute(primitive['indices'])
            _require(idx['type'] == 'SCALAR' and idx['componentType'] in (5121, 5123, 5125) and idx['count'] % 3 == 0,
                     'World triangle indices are unsupported.')
            _require(idx['count'] // 3 <= MAX_FACES, 'World exceeds the one-million-face cleanup budget.')
            fmt = {1: '<B', 2: '<H', 4: '<I'}[width]
            indices = array('I', (struct.unpack_from(fmt, self.binary, start+i*step)[0] for i in range(idx['count'])))
        else:
            _require(count % 3 == 0 and count // 3 <= MAX_FACES, 'World triangle count is unsupported.')
            indices = array('I', range(count))
        _require(not indices or max(indices) < count, 'World indices reference missing positions.')
        return indices, count

    def geometry(self, instance):
        indices, count = self.triangles(instance)
        _, offset, stride, _ = self.attribute(instance['primitive']['attributes']['POSITION'])
        # Welding is only a detection map. Original vertex attributes are never
        # merged, so UV seams and the exact split-only appearance remain intact.
        positions = array('d')
        original_to_weld = array('I')
        welds = {}
        local = memoryview(self.binary)
        for index in range(count):
            point = _transform(instance['matrix'], struct.unpack_from('<fff', local, offset+index*stride))
            _require(all(math.isfinite(value) for value in point), 'World positions must be finite.')
            key = tuple(round(value, 6) for value in point)
            identity = welds.get(key)
            if identity is None:
                identity = len(positions)//3
                welds[key] = identity
                positions.extend(point)
            original_to_weld.append(identity)
        return _Geometry(indices, original_to_weld, positions)


class _Geometry:
    def __init__(self, indices, original_to_weld, positions):
        self.indices, self.original_to_weld, self.positions = indices, original_to_weld, positions
        self.faces = len(indices)//3
        self.weld_indices = array('I', (original_to_weld[i] for i in indices))
        self.normals, self.centers, self.areas = array('f'), array('f'), array('d')
        self.adjacent = array('i', [-1]) * len(indices)
        edge_map = {}
        self.references = array('I', [0]) * (len(positions)//3)
        for face in range(self.faces):
            ids = self.weld_indices[face*3:face*3+3]
            points = [self.point(i) for i in ids]
            cross = _cross(_sub(points[1], points[0]), _sub(points[2], points[0]))
            length = math.sqrt(_dot(cross, cross))
            self.normals.extend(tuple(v/length for v in cross) if length > 1e-18 else (0., 0., 0.))
            self.centers.extend(tuple(sum(p[axis] for p in points)/3 for axis in range(3)))
            self.areas.append(length*.5)
            for identity in ids:
                self.references[identity] += 1
            for edge in range(3):
                a, b = ids[edge], ids[(edge+1)%3]
                if a == b:
                    continue
                key = (min(a, b) << 32) | max(a, b)
                prior = edge_map.pop(key, None)
                slot = face*3+edge
                if prior is None:
                    edge_map[key] = slot
                else:
                    self.adjacent[slot] = prior//3
                    self.adjacent[prior] = face

    def point(self, identity):
        return self.positions[identity*3:identity*3+3]

    def face_vertices(self, face):
        return self.weld_indices[face*3:face*3+3]


def _plane(geometry, faces):
    # An area-weighted normal avoids dense tiny triangles dominating the fit.
    anchor = geometry.normals[faces[0]*3:faces[0]*3+3]
    normal, center, area = [0., 0., 0.], [0., 0., 0.], 0.
    for face in faces:
        weight = geometry.areas[face]
        n = geometry.normals[face*3:face*3+3]
        sign = 1 if _dot(anchor, n) >= 0 else -1
        for axis in range(3):
            normal[axis] += n[axis]*weight*sign
            center[axis] += geometry.centers[face*3+axis]*weight
        area += weight
    normal = _normal(normal)
    center = tuple(value/area for value in center)
    return normal, -_dot(normal, center), area


def _deviations(geometry, identities, normal, offset):
    errors = [abs(_dot(normal, geometry.point(i))+offset) for i in identities]
    return max(errors, default=0.), math.sqrt(sum(e*e for e in errors)/max(1, len(errors)))


def _detect(geometry, distance, angle, minimum, maximum):
    used = bytearray(geometry.faces)
    threshold = math.cos(math.radians(angle))
    # Deterministic seeds privilege well-supported faces; region growth is
    # bounded by the seed's global plane, not a chain of locally similar angles.
    seeds = sorted(range(geometry.faces), key=lambda f: (-geometry.areas[f], f))
    candidates = []
    for seed in seeds:
        if used[seed] or geometry.areas[seed] < 1e-14:
            continue
        normal = geometry.normals[seed*3:seed*3+3]
        offset = -_dot(normal, geometry.centers[seed*3:seed*3+3])
        queue = [seed]
        used[seed] = 1
        found = []
        while queue:
            face = queue.pop()
            found.append(face)
            for neighbor in geometry.adjacent[face*3:face*3+3]:
                if neighbor < 0 or used[neighbor] or geometry.areas[neighbor] < 1e-14:
                    continue
                n = geometry.normals[neighbor*3:neighbor*3+3]
                if abs(_dot(normal, n)) < threshold:
                    continue
                if any(abs(_dot(normal, geometry.point(identity))+offset) > distance for identity in geometry.face_vertices(neighbor)):
                    continue
                used[neighbor] = 1
                queue.append(neighbor)
        if len(found) < minimum or len(found) > MAX_CANDIDATE_FACES:
            continue
        found.sort()
        fitted, constant, area = _plane(geometry, found)
        identities = {v for face in found for v in geometry.face_vertices(face)}
        maximum_error, rms = _deviations(geometry, identities, fitted, constant)
        if maximum_error > distance*1.5:
            continue
        minimum_point = [min(geometry.positions[i*3+axis] for i in identities) for axis in range(3)]
        maximum_point = [max(geometry.positions[i*3+axis] for i in identities) for axis in range(3)]
        orientation = 'horizontal' if abs(fitted[1]) >= math.cos(math.radians(20)) else 'vertical' if abs(fitted[1]) <= math.sin(math.radians(20)) else 'oblique'
        candidates.append({'faces': found, 'plane': {'normal': list(fitted), 'offset': constant}, 'areaSourceUnits2': area,
                           'maxDeviationSourceUnits': maximum_error, 'rmsDeviationSourceUnits': rms,
                           'bounds': {'min': minimum_point, 'max': maximum_point}, 'orientation': orientation})
    return sorted(candidates, key=_candidate_rank)[:maximum]


def _candidate_rank(candidate):
    # Start near the source origin rather than offering distant reconstruction
    # skirts just because a few giant triangles give them a large area. This
    # is a review ordering, not a floor label or a metric calibration claim.
    bounds = candidate['bounds']
    distance2 = sum((lower if lower > 0 else -upper if upper < 0 else 0.)**2
                    for lower, upper in zip(bounds['min'], bounds['max']))
    return (distance2/max(math.sqrt(candidate['areaSourceUnits2']), .05), -candidate['areaSourceUnits2'])


def _append(binary, document, data, accessor):
    while len(binary) % 4:
        binary.append(0)
    view = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data)}
    document.setdefault('bufferViews', []).append(view)
    binary.extend(data)
    value = {**accessor, 'bufferView': len(document['bufferViews'])-1}
    document.setdefault('accessors', []).append(value)
    return len(document['accessors'])-1


def _encode(document, binary):
    document['buffers'][0]['byteLength'] = len(binary)
    encoded = json.dumps(document, separators=(',', ':'), allow_nan=False).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary += b'\0' * (-len(binary) % 4)
    length = 12+8+len(encoded)+8+len(binary)
    _require(length <= worlds.MAX_ASSET_BYTES, 'Repaired asset exceeds the 128 MiB world limit; choose a smaller patch.')
    return b'glTF'+struct.pack('<II', 2, length)+struct.pack('<II', len(encoded), 0x4e4f534a)+encoded+struct.pack('<II', len(binary), 0x004e4942)+binary


class WorldCleanup:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.directory = self.root / 'world-cleanup'
        self.directory.mkdir(exist_ok=True)
        self.lock = threading.Lock()

    def _source(self, environment):
        _require(isinstance(environment, dict) and environment.get('kind') == 'mesh', 'Choose a textured mesh before reviewing its structure.')
        asset = worlds.validate_asset_record(environment.get('asset'), kind='mesh')
        path = worlds.safe_asset_path(self.root, asset['path'])
        payload = worlds._read_asset(path)
        _require(hashlib.sha256(payload).hexdigest() == asset['sha256'], 'World cleanup source asset changed.')
        worlds._validate_content(payload, 'glb', path.name)
        return asset, payload, _Glb(payload)

    @staticmethod
    def _public(analysis):
        return {**{key: copy.deepcopy(value) for key, value in analysis.items() if key != 'candidates'},
                'candidates': [{key: copy.deepcopy(value) for key, value in candidate.items() if key != 'groups'} for candidate in analysis['candidates']]}

    def _load(self, analysis_id):
        _require(isinstance(analysis_id, str) and bool(_ID.fullmatch(analysis_id)), 'Cleanup analysis ID is invalid.')
        path = self.directory / f'{analysis_id}.json'
        _require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 32*1024*1024, 'Cleanup analysis is missing or too large.')
        value = json.loads(path.read_text())
        _require(value.get('id') == analysis_id and value.get('engine') == ENGINE, 'Cleanup analysis has a different engine identity.')
        _require(value.get('contentDigest') == _digest({key: item for key, item in value.items() if key != 'contentDigest'}),
                 'Cleanup analysis evidence changed after detection. Analyze the original again.')
        return value

    def analyze(self, environment, options=None):
        asset, _payload, glb = self._source(environment)
        options = dict(options or {})
        _require(not set(options)-{'distanceThresholdSourceUnits', 'normalAngleDegrees', 'minFaces', 'maxCandidates'}, 'Unsupported cleanup analysis option.')
        distance = options.get('distanceThresholdSourceUnits', .04)
        angle = options.get('normalAngleDegrees', 18.)
        minimum, maximum = options.get('minFaces', 64), options.get('maxCandidates', 12)
        _require(type(distance) in (int, float) and math.isfinite(distance) and .00001 <= distance <= .2, 'Plane distance must be between 0.00001 and 0.2 source units.')
        _require(type(angle) in (int, float) and math.isfinite(angle) and 1 <= angle <= 30, 'Plane normal angle must be between 1 and 30 degrees.')
        _require(type(minimum) is int and 4 <= minimum <= 10000 and type(maximum) is int and 1 <= maximum <= 16, 'Cleanup region limits are invalid.')
        parameters = {'distanceThresholdSourceUnits': distance, 'normalAngleDegrees': angle, 'minFaces': minimum, 'maxCandidates': maximum}
        analysis_id = 'cleanup-' + _digest({'source': asset['sha256'], 'sourceUp': asset['sourceUp'], 'engine': ENGINE, 'parameters': parameters})[:24]
        path = self.directory / f'{analysis_id}.json'
        with self.lock:
            if path.exists():
                return self._public(self._load(analysis_id))
            candidates, total = [], 0
            for instance in glb.instances:
                geometry = glb.geometry(instance)
                total += geometry.faces
                _require(total <= MAX_FACES, 'World exceeds the one-million-face cleanup budget.')
                for candidate in _detect(geometry, distance, angle, minimum, maximum):
                    faces = candidate.pop('faces')
                    location = {key: instance[key] for key in ('nodeIndex', 'meshIndex', 'primitiveIndex')}
                    identity = 'region-' + _digest({'source': asset['sha256'], 'location': location, 'faces': faces})[:20]
                    candidates.append({**candidate, 'id': identity, 'faceCount': len(faces), 'labelHint': candidate['orientation'].capitalize()+' surface',
                                       'suggestedRole': None, 'labelBasis': 'geometry only; role unconfirmed',
                                       'groups': [{**location, 'faceIndices': faces}]})
                del geometry
            candidates = sorted(candidates, key=_candidate_rank)[:maximum]
            result = {'id': analysis_id, 'analysisId': analysis_id, 'engine': ENGINE, 'sourceSha256': asset['sha256'],
                      'sourceUp': asset['sourceUp'],
                      'triangleCount': total, 'candidates': candidates, 'units': 'source units', 'method': 'geometric-only',
                      'parameters': parameters, 'warnings': ['Surface roles are unconfirmed geometric proposals, not object recognition.',
                         'Source units and mesh/Gaussian alignment are not calibrated by this analysis.',
                         'Unassigned geometry, baked texture and original assets remain unchanged.']}
            result['contentDigest'] = _digest(result)
            _atomic_json(path, result)
            return self._public(result)

    def selection(self, analysis_id, candidate_id):
        analysis = self._load(analysis_id)
        candidate = next((item for item in analysis['candidates'] if item['id'] == candidate_id), None)
        _require(candidate is not None, 'Cleanup region is unavailable in this analysis.')
        return {'sourceSha256': analysis['sourceSha256'], 'groups': copy.deepcopy(candidate['groups'])}

    def preview(self, environment, request):
        asset, payload, glb = self._source(environment)
        analysis = self._load(request.get('analysisId'))
        _require(analysis['sourceSha256'] == asset['sha256'], 'Cleanup analysis belongs to a different world asset.')
        _require(analysis.get('sourceUp') == asset['sourceUp'], 'Cleanup source axis differs from its analysis.')
        selections = request.get('selections')
        if selections is not None:
            _require(isinstance(selections, list) and len(selections) == 1, 'Preview one confirmed region at a time.')
            selection = selections[0]
            request = {**request, **selection, 'regionId': selection.get('candidateId', selection.get('regionId'))}
        candidate = next((item for item in analysis['candidates'] if item['id'] == request.get('regionId')), None)
        _require(candidate is not None, 'Choose a region from this source analysis.')
        role, operation = request.get('role'), request.get('operation')
        _require(role in ROLES, 'Confirm the surface role before separating it.')
        _require(operation in ('separate', 'flatten'), 'Choose separate or flatten interior.')
        budget = request.get('maxDisplacementSourceUnits', .01)
        _require(type(budget) in (int, float) and math.isfinite(budget) and .000001 <= budget <= .2,
                 'Maximum displacement must be between 0.000001 and 0.2 source units.')
        group = candidate['groups'][0]
        instance = next((item for item in glb.instances if all(item[key] == group[key] for key in ('nodeIndex', 'meshIndex', 'primitiveIndex'))), None)
        _require(instance is not None, 'Cleanup source primitive is unavailable.')
        # Separation only partitions index buffers. It does not need to weld
        # or analyze the source's millions of vertex records a second time.
        geometry = glb.geometry(instance) if operation == 'flatten' else None
        indices = geometry.indices if geometry else glb.triangles(instance)[0]
        face_count = len(indices)//3
        faces = group['faceIndices']
        chosen = set(faces)
        selected_indices = array('I', (indices[face*3+corner] for face in faces for corner in range(3)))
        remaining = array('I', (indices[face*3+corner] for face in range(face_count) if face not in chosen for corner in range(3)))
        document, binary = copy.deepcopy(glb.document), bytearray(glb.binary)
        original = copy.deepcopy(instance['primitive'])
        selected_primitive = copy.deepcopy(original)
        moved, required, boundary_count, edge_change, normal_rotation = 0, 0., 0, 0., 0.
        after_max, after_rms = candidate['maxDeviationSourceUnits'], candidate['rmsDeviationSourceUnits']
        if operation == 'flatten':
            _require('TANGENT' not in original['attributes'], 'Tangent-mapped patches require a reviewed tangent rebake; use separate only.')
            selected_references, boundary = {}, set()
            for face in faces:
                ids = geometry.face_vertices(face)
                for identity in ids:
                    selected_references[identity] = selected_references.get(identity, 0)+1
                for corner, neighbor in enumerate(geometry.adjacent[face*3:face*3+3]):
                    if neighbor not in chosen:
                        boundary.update((ids[corner], ids[(corner+1)%3]))
            boundary.update(identity for identity, count in selected_references.items() if count != geometry.references[identity])
            boundary_count = len(boundary)
            n, constant = candidate['plane']['normal'], candidate['plane']['offset']
            targets = {}
            for identity in selected_references:
                if identity in boundary:
                    continue
                point = geometry.point(identity)
                distance = _dot(n, point)+constant
                required = max(required, abs(distance))
                targets[identity] = tuple(point[axis]-distance*n[axis] for axis in range(3))
            _require(targets, 'This region has no movable interior. Separate it without repair or choose a larger patch.')
            _require(required <= budget+1e-9, f'Flattening needs {required:.6g} source units of movement; the limit is {budget:.6g}. Increase the explicit limit or keep the original.')
            mapping = {}
            ordered = []
            compact = array('I')
            for identity in selected_indices:
                if identity not in mapping:
                    mapping[identity] = len(ordered)
                    ordered.append(identity)
                compact.append(mapping[identity])
            positions = bytearray()
            position_accessor, position_start, position_stride, _ = glb.attribute(original['attributes']['POSITION'])
            for identity in ordered:
                welded = geometry.original_to_weld[identity]
                original_bytes = glb.binary[position_start+identity*position_stride:position_start+identity*position_stride+12]
                if welded not in targets:
                    # The weld map is a detection aid only. Never perturb a
                    # retained boundary by round-tripping transforms or welds.
                    positions.extend(original_bytes)
                    continue
                point = _transform(instance['matrix'], struct.unpack('<fff', original_bytes))
                distance = _dot(n, point)+constant
                required = max(required, abs(distance))
                target = tuple(point[axis]-distance*n[axis] for axis in range(3))
                positions.extend(struct.pack('<fff', *_transform(instance['inverse'], target)))
            _require(required <= budget+1e-9, f'Flattening needs {required:.6g} source units of movement; the limit is {budget:.6g}.')
            points = list(struct.iter_unpack('<fff', positions))
            original_points = [struct.unpack_from('<fff', glb.binary, position_start+identity*position_stride) for identity in ordered]
            source_points = [_transform(instance['matrix'], point) for point in points]
            original_source_points = [_transform(instance['matrix'], point) for point in original_points]
            required = max(math.sqrt(_dot(_sub(after, before), _sub(after, before)))
                           for before, after in zip(original_source_points, source_points))
            _require(required <= budget+1e-9, 'Float32 position precision would exceed the explicit movement limit. Keep separate only.')
            normals = array('d', [0.]) * (len(ordered)*3)
            for face in range(len(compact)//3):
                a, b, c = compact[face*3:face*3+3]
                face_normal = _cross(_sub(points[b], points[a]), _sub(points[c], points[a]))
                before_normal = _cross(_sub(original_source_points[b], original_source_points[a]), _sub(original_source_points[c], original_source_points[a]))
                source_normal = _cross(_sub(source_points[b], source_points[a]), _sub(source_points[c], source_points[a]))
                before_area2, after_area2 = _dot(before_normal, before_normal), _dot(source_normal, source_normal)
                alignment = _dot(before_normal, source_normal)
                _require(after_area2 > max(1e-28, before_area2*1e-12) and alignment > 0,
                         'This repair would collapse or invert a selected triangle. Keep separate only or choose a different region.')
                normal_rotation = max(normal_rotation, math.degrees(math.acos(max(-1., min(1., alignment/math.sqrt(before_area2*after_area2))))))
                for first, second in ((a,b),(b,c),(c,a)):
                    before_edge = _sub(original_source_points[first], original_source_points[second])
                    after_edge = _sub(source_points[first], source_points[second])
                    before_length = math.sqrt(_dot(before_edge, before_edge))
                    if before_length > 1e-12:
                        edge_change = max(edge_change, abs(math.sqrt(_dot(after_edge, after_edge))/before_length-1))
                for vertex in (a, b, c):
                    for axis in range(3):
                        normals[vertex*3+axis] += face_normal[axis]
            _require(edge_change <= MAX_EDGE_STRAIN and normal_rotation <= MAX_NORMAL_ROTATION_DEGREES,
                     f'This repair would distort the retained boundary band (edge strain {edge_change:.1%}, normal rotation {normal_rotation:.1f}°). '
                     f'Limits are {MAX_EDGE_STRAIN:.0%} and {MAX_NORMAL_ROTATION_DEGREES:.0f}°. Keep separate only or choose a different region.')
            normal_bytes = b''.join(struct.pack('<fff', *_normal(normals[index*3:index*3+3])) for index in range(len(ordered)))
            attributes = {}
            for name, accessor_index in original['attributes'].items():
                accessor, start, stride, width = glb.attribute(accessor_index)
                data = positions if name == 'POSITION' else normal_bytes if name == 'NORMAL' else b''.join(glb.binary[start+i*stride:start+i*stride+width] for i in ordered)
                descriptor = {key: value for key, value in accessor.items() if key not in ('bufferView', 'byteOffset', 'min', 'max')}
                descriptor['count'] = len(ordered)
                if name == 'NORMAL':
                    descriptor.update(componentType=5126, type='VEC3')
                    descriptor.pop('normalized', None)
                if name == 'POSITION':
                    descriptor['min'] = [min(point[a] for point in points) for a in range(3)]
                    descriptor['max'] = [max(point[a] for point in points) for a in range(3)]
                attributes[name] = _append(binary, document, data, descriptor)
            if 'NORMAL' not in attributes:
                attributes['NORMAL'] = _append(binary, document, normal_bytes, {'componentType': 5126, 'type': 'VEC3', 'count': len(ordered)})
            selected_primitive['attributes'] = attributes
            selected_indices = compact
            moved = sum(abs(_dot(n, geometry.point(identity))+constant) > 1e-8 for identity in targets)
            # Report the stored float32 result, including retained boundaries,
            # rather than the ideal double-precision projection targets.
            error_by_weld = {}
            for identity, point in zip(ordered, source_points):
                weld = geometry.original_to_weld[identity]
                error_by_weld[weld] = max(error_by_weld.get(weld, 0.), abs(_dot(n, point)+constant))
            errors = list(error_by_weld.values())
            after_max = max(errors, default=0.)
            after_rms = math.sqrt(sum(error*error for error in errors)/max(1, len(errors)))
        # A split-only derivative references the original attribute accessors.
        # All original buffers (including the texture atlas) remain byte-exact.
        selected_primitive['indices'] = _append(binary, document, selected_indices.tobytes(), {'componentType': 5125, 'count': len(selected_indices), 'type': 'SCALAR'})
        others = copy.deepcopy(document['meshes'][instance['meshIndex']]['primitives'])
        if remaining:
            original['indices'] = _append(binary, document, remaining.tobytes(), {'componentType': 5125, 'count': len(remaining), 'type': 'SCALAR'})
            others[instance['primitiveIndex']] = original
        else:
            others.pop(instance['primitiveIndex'])
        node = document['nodes'][instance['nodeIndex']]
        node.pop('mesh', None)
        children = list(node.get('children', []))
        if others:
            document['meshes'].append({'name': 'Unassigned surroundings', 'primitives': others})
            children.append(len(document['nodes']))
            document['nodes'].append({'name': 'Unassigned surroundings', 'mesh': len(document['meshes'])-1})
        selected_node = len(document['nodes'])
        selected_mesh = len(document['meshes'])
        document['meshes'].append({'name': f'{role} · confirmed surface', 'primitives': [selected_primitive]})
        document['nodes'].append({'name': f'{role} · confirmed surface', 'mesh': selected_mesh,
                                  'extras': {'gessoCleanup': {'sourceSha256': asset['sha256'], 'regionId': candidate['id'], 'roleConfirmed': role}}})
        children.append(selected_node)
        node['children'] = children
        report = {'schemaVersion': 1, 'sourceSha256': asset['sha256'], 'analysisId': analysis['id'], 'regionId': candidate['id'],
                  'role': role, 'roleBasis': 'user-confirmed', 'operation': operation, 'selectedFaces': len(faces),
                  'sourceTriangles': analysis['triangleCount'], 'outputTriangles': analysis['triangleCount'],
                  'movedVertices': moved, 'boundaryVerticesPreserved': boundary_count, 'maxDisplacementSourceUnits': required,
                  'requestedMaxDisplacementSourceUnits': budget, 'requiredMaxDisplacementSourceUnits': required,
                  'initialMaxDeviationSourceUnits': candidate['maxDeviationSourceUnits'], 'finalMaxDeviationSourceUnits': after_max,
                  'initialRmsDeviationSourceUnits': candidate['rmsDeviationSourceUnits'], 'finalRmsDeviationSourceUnits': after_rms,
                  'geometryChanged': bool(moved), 'sourceAttributeBytesPreserved': operation == 'separate',
                  'maxEdgeLengthChangeRatio': edge_change, 'maxNormalRotationDegrees': normal_rotation,
                  'edgeLengthChangeRatioLimit': MAX_EDGE_STRAIN, 'normalRotationDegreesLimit': MAX_NORMAL_ROTATION_DEGREES,
                  'newBoundaryGapsSourceUnits': 0.,
                  'units': 'source units', 'appearanceTransfer': 'Original UVs and texture retained; baked details may still look warped.',
                  'limitations': ['No missing surface completion, PBR recovery or automatic semantic recognition.',
                                  'Flatten interior preserves boundary positions; the transition band can remain nonplanar.']}
        result_bytes = _encode(document, binary)
        digest = hashlib.sha256(result_bytes).hexdigest()
        destination = self.root / 'assets' / f'{digest}.glb'
        worlds._immutable_write(destination, result_bytes)
        derived = copy.deepcopy(environment)
        derived['asset'] = {**derived['asset'], 'path': f'assets/{digest}.glb', 'sha256': digest}
        derived['revisionId'] = 'world-cleanup-'+digest[:24]
        derived['reviewStatus'] = 'unreviewed'
        derived.setdefault('provenance', {})['cleanup'] = {'sourceSha256': asset['sha256'], 'engine': ENGINE, 'regionId': candidate['id'], 'role': role,
                                                         'operation': operation, 'maxDisplacementSourceUnits': required}
        report['derivedSha256'] = digest
        _atomic_json(self.directory / f'derivative-{digest}.json', report)
        return {'environment': derived, 'report': report, 'analysisId': analysis['id'], 'regionId': candidate['id'],
                'sourceSha256': asset['sha256'], 'selection': {'sourceSha256': digest, 'groups': [
                    {'nodeIndex': selected_node, 'meshIndex': selected_mesh, 'primitiveIndex': 0, 'faceIndices': list(range(len(faces)))}]}}
