"""Source UV triangles shared by deterministic decal/export calculations.

Procedural positions and UVs follow the editor's Three.js box/rounded-box and
lathe construction. Imported geometry uses the GLB's original TEXCOORD_0; no
unwrap, camera projection, or synthesized UV coordinates are substituted.
"""
from __future__ import annotations

import base64
import json
import math
import struct


def normalized(vector):
    length = math.sqrt(sum(value * value for value in vector))
    return tuple(value / length for value in vector) if length > 1e-16 else (0., 0., 0.)


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def vertex(position, normal, uv):
    return tuple(position) + tuple(normal) + tuple(uv)


def primitive_triangles(component):
    """Yield (position.xyz, normal.xyz, uv.xy) vertices in Y-up local metres."""
    size = component["sizeM"]
    radius = min(component.get("bevelM", 0), min(size) * .45)
    if component["shape"] == "box":
        faces = ((2, 1, 0, -1, -1, size[2], size[1], size[0]),
                 (2, 1, 0, 1, -1, size[2], size[1], -size[0]),
                 (0, 2, 1, 1, 1, size[0], size[2], size[1]),
                 (0, 2, 1, 1, -1, size[0], size[2], -size[1]),
                 (0, 1, 2, 1, -1, size[0], size[1], size[2]),
                 (0, 1, 2, -1, -1, size[0], size[1], -size[2]))
        segments = 11 if radius else 1
        sign = lambda value: 1 if value > 0 else -1 if value < 0 else 0

        def rounded_uv(direction, normal, uv_axis, projection_axis, length):
            arc = math.pi * radius / 2
            center = max(length - 2 * radius, 0)
            projected = list(normal)
            projected[projection_axis] = 0
            projected = normalized(projected)
            angle = math.acos(max(-1, min(1, sum(a*b for a, b in zip(projected, direction)))))
            ratio = 1 - angle / (math.pi / 4)
            arc_uv = .5 * arc / (arc + center)
            return ratio * arc_uv if projected[uv_axis] > 0 else center / (arc + center) + arc_uv * (2-ratio)

        for face, (u, v, w, udir, vdir, width, height, depth) in enumerate(faces):
            points = []
            for iy in range(segments + 1):
                for ix in range(segments + 1):
                    position, normal = [0., 0., 0.], [0., 0., 0.]
                    position[u] = (ix / segments - .5) * udir * (1 if radius else width)
                    position[v] = (iy / segments - .5) * vdir * (1 if radius else height)
                    position[w] = sign(depth) * (.5 if radius else abs(depth) / 2)
                    normal[w] = sign(depth)
                    uv = (ix / segments, 1 - iy / segments)
                    if radius:
                        # Three stores its unit BoxGeometry in Float32 before rounding.
                        # Preserve tiny signs at the central edge: they choose UV arcs.
                        position = [struct.unpack("<f", struct.pack("<f", value))[0] for value in position]
                        normal = normalized([value - sign(value) * .5 / segments for value in position])
                        position = [(size[axis] / 2 - radius) * sign(value) + normal[axis] * radius
                                    for axis, value in enumerate(position)]
                        direction = [0., 0., 0.]
                        direction[w] = sign(depth)
                        if face in (0, 1):
                            x = rounded_uv(direction, normal, 2, 1, size[2])
                            uv = (x if face == 0 else 1-x, 1-rounded_uv(direction, normal, 1, 2, size[1]))
                        elif face in (2, 3):
                            y = rounded_uv(direction, normal, 2, 0, size[2])
                            uv = (1-rounded_uv(direction, normal, 0, 2, size[0]), y if face == 2 else 1-y)
                        else:
                            x = rounded_uv(direction, normal, 0, 1, size[0])
                            uv = (1-x if face == 4 else x, 1-rounded_uv(direction, normal, 1, 0, size[1]))
                    uv = ((uv[0] + face % 3) / 3, (uv[1] + face // 3) / 2)
                    points.append(vertex(position, normal, uv))
            for iy in range(segments):
                for ix in range(segments):
                    a = ix + (segments+1) * iy
                    b, c, d = a+segments+1, a+segments+2, a+1
                    yield (points[a], points[b], points[d])
                    yield (points[b], points[c], points[d])
        return
    if component["shape"] != "cylinder":
        raise ValueError("Decal procedural target must be a box or cylinder")
    r, half, b = size[0] / 2, size[1] / 2, min(radius, size[0] * .45)
    profile = [(0, -half), (r-b, -half)]
    profile += [(r-b+b*math.sin(step*math.pi/10), -half+b-b*math.cos(step*math.pi/10)) for step in range(6)]
    profile += [(r, half-b)]
    profile += [(r-b+b*math.cos(step*math.pi/10), half-b+b*math.sin(step*math.pi/10)) for step in range(6)]
    profile += [(0, half)]
    normals = []
    previous = (0., 0., 0.)
    for j, point in enumerate(profile):
        if j == len(profile)-1:
            normal = previous
        else:
            following = profile[j+1]
            current = (following[1]-point[1], point[0]-following[0], 0)
            normal = normalized(current if j == 0 else [a+b for a, b in zip(current, previous)])
            previous = current
        normals.append(normal)
    points = []
    ratio = size[2] / size[0]
    for i in range(129):
        sine, cosine = math.sin(i * math.tau / 128), math.cos(i * math.tau / 128)
        for j, (x, y) in enumerate(profile):
            normal = normals[j]
            points.append(vertex((x*sine, y, x*cosine*ratio),
                                 normalized((normal[0]*sine, normal[1], normal[0]*cosine/ratio)),
                                 (i/128, j/(len(profile)-1))))
    count = len(profile)
    for i in range(128):
        for j in range(count-1):
            a = j+i*count
            b, c, d = a+count, a+count+1, a+1
            yield (points[a], points[b], points[d])
            yield (points[c], points[d], points[b])


def imported_triangles(payload, part_id, component_id):
    """Read the exact source node (plus descendants), including UV seams."""
    from .products import _IDENTITY, _multiply, _node_matrix
    json_size = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20+json_size])
    offset = 20+json_size
    binary = payload[offset+8:] if offset < len(payload) else b""
    buffers = [base64.b64decode(buffer["uri"].partition(",")[2]) if "uri" in buffer else binary
               for buffer in document.get("buffers", [])]
    selected = None if part_id == component_id else int(part_id.removeprefix(component_id + "::node:"))
    nodes = document["nodes"]
    if selected is not None and selected >= len(nodes):
        raise ValueError("Decal source node does not exist in its product GLB")

    def accessor(index, dimension):
        item = document["accessors"][index]
        dimensions = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
        types = {5120: ("b", 127), 5121: ("B", 255), 5122: ("h", 32767), 5123: ("H", 65535), 5125: ("I", 4294967295), 5126: ("f", 1)}
        if dimensions.get(item["type"]) != dimension or "sparse" in item or "bufferView" not in item:
            raise ValueError("Decal UV geometry needs dense source accessors")
        code, divisor = types[item["componentType"]]
        format_ = "<" + str(dimension) + code
        view = document["bufferViews"][item["bufferView"]]
        stride = view.get("byteStride", struct.calcsize(format_))
        start = view.get("byteOffset", 0) + item.get("byteOffset", 0)
        result = []
        for number in range(item["count"]):
            row = struct.unpack_from(format_, buffers[view["buffer"]], start+number*stride)
            if item.get("normalized"):
                row = tuple(max(-1, value/divisor) for value in row)
            if not all(math.isfinite(value) for value in row):
                raise ValueError("Decal source UV/normal data must be finite")
            result.append(row)
        return result

    def transform_normal(matrix, normal):
        # Cofactor inverse-transpose: preserves supplied normals under scale.
        cols = [tuple(matrix[row][column] for row in range(3)) for column in range(3)]
        cofactors = (cross(cols[1], cols[2]), cross(cols[2], cols[0]), cross(cols[0], cols[1]))
        determinant = sum(a*b for a, b in zip(cols[0], cofactors[0]))
        return normalized(tuple(sum(cofactors[column][axis]*normal[column] for column in range(3)) / determinant
                                for axis in range(3)))

    found = False
    stack = [(index, _IDENTITY, selected is None) for index in document["scenes"][0]["nodes"]]
    while stack:
        index, parent, inside = stack.pop()
        node = nodes[index]
        matrix = _multiply(parent, _node_matrix(node))
        inside = inside or index == selected
        stack += [(child, matrix, inside) for child in node.get("children", [])]
        if not inside or "mesh" not in node:
            continue
        for primitive in document["meshes"][node["mesh"]]["primitives"]:
            attributes = primitive["attributes"]
            if "TEXCOORD_0" not in attributes:
                raise ValueError("Selected decal mesh has no source UV map")
            positions = accessor(attributes["POSITION"], 3)
            positions = [tuple(sum(matrix[row][axis]*point[axis] for axis in range(3))+matrix[row][3]
                               for row in range(3)) for point in positions]
            uvs = accessor(attributes["TEXCOORD_0"], 2)
            normals = accessor(attributes["NORMAL"], 3) if "NORMAL" in attributes else None
            normals = [transform_normal(matrix, normal) for normal in normals] if normals else None
            indices = [row[0] for row in accessor(primitive["indices"], 1)] if "indices" in primitive else list(range(len(positions)))
            for first in range(0, len(indices), 3):
                selected_indices = indices[first:first+3]
                if len(selected_indices) != 3:
                    continue
                if not normals:
                    a, b, c = [positions[i] for i in selected_indices]
                    normal = normalized(cross([x-y for x,y in zip(b,a)], [x-y for x,y in zip(c,a)]))
                found = True
                yield tuple(vertex(positions[i], normals[i] if normals else normal, uvs[i]) for i in selected_indices)
    if not found:
        raise ValueError("Selected decal source node has no UV-mapped mesh")


def decal_coordinate(uv, decal):
    angle = math.radians(decal["rotationDeg"])
    c, s = math.cos(angle), math.sin(angle)
    u, v = uv[0]-decal["centerUv"][0], uv[1]-decal["centerUv"][1]
    return ((u*c+v*s)/decal["sizeUv"][0]+.5, (-u*s+v*c)/decal["sizeUv"][1]+.5)


def decal_surface_height(distance, height, bevel):
    bevel = min(max(0, bevel), max(0, height)/2)
    if bevel <= 1e-10 or distance >= bevel:
        return max(0, height)
    return height-bevel+math.sqrt(max(0, bevel*bevel-(bevel-max(0, distance))**2))


def project_triangle(triangle, decal):
    """Match the live editor's UV clipping, physical bevel, and side walls."""
    eps = 1e-10
    points = [tuple(p[:6])+decal_coordinate(p[6:8], decal) for p in triangle]
    a, b, c = points
    du1, dv1, du2, dv2 = b[6]-a[6], b[7]-a[7], c[6]-a[6], c[7]-a[7]
    determinant = du1*dv2-du2*dv1
    if abs(determinant) <= eps:
        return []
    dp1, dp2 = [b[i]-a[i] for i in range(3)], [c[i]-a[i] for i in range(3)]
    derivative_u = [(dp1[i]*dv2-dp2[i]*dv1)/determinant for i in range(3)]
    derivative_v = [(dp2[i]*du1-dp1[i]*du2)/determinant for i in range(3)]
    area = math.sqrt(sum(x*x for x in cross(derivative_u, derivative_v)))
    meters_u = area/max(eps, math.sqrt(sum(x*x for x in derivative_v)))
    meters_v = area/max(eps, math.sqrt(sum(x*x for x in derivative_u)))
    if min(meters_u, meters_v) <= eps:
        return []

    def clip(polygon, axis, edge, sign):
        out = []
        for i, a in enumerate(polygon):
            b = polygon[(i+1) % len(polygon)]
            da, db = (a[6+axis]-edge)*sign, (b[6+axis]-edge)*sign
            if da >= -eps:
                out.append(a)
            if (da > eps and db < -eps) or (da < -eps and db > eps):
                t = da/(da-db)
                out.append(tuple(x+(y-x)*t for x,y in zip(a,b)))
        return out

    def rectangle(polygon, x0, x1, y0, y1):
        return clip(clip(clip(clip(polygon, 0, x0, 1), 0, x1, -1), 1, y0, 1), 1, y1, -1)

    bounded = rectangle(points, 0, 1, 0, 1)
    if len(bounded) < 3:
        return []
    bevel = min(decal["bevelM"], decal["heightM"]/2, meters_u/2, meters_v/2)

    def stops(meters):
        if bevel <= eps:
            return [0, 1]
        w = bevel/meters
        return sorted(set([0, w*.25, w*.5, w*.75, w, 1-w, 1-w*.75, 1-w*.5, 1-w*.25, 1]))

    def distance(p):
        return max(0, min(p[6]*meters_u, (1-p[6])*meters_u, p[7]*meters_v, (1-p[7])*meters_v))

    out = []

    def emit(vertices, heights, wall=False):
        positions = [tuple(p[i]+normalized(p[3:6])[i]*height for i in range(3)) for p, height in zip(vertices, heights)]
        face = cross([positions[1][i]-positions[0][i] for i in range(3)],
                     [positions[2][i]-positions[0][i] for i in range(3)])
        if math.sqrt(sum(x*x for x in face)) <= eps*eps:
            return
        flat = normalized(face)
        out.append(tuple(vertex(positions[i], flat if wall or distance(p) < bevel-eps else normalized(p[3:6]), p[6:8])
                         for i, p in enumerate(vertices)))

    x_stops, y_stops = stops(meters_u), stops(meters_v)
    xmin, xmax = min(p[6] for p in bounded), max(p[6] for p in bounded)
    ymin, ymax = min(p[7] for p in bounded), max(p[7] for p in bounded)
    for x0,x1 in zip(x_stops,x_stops[1:]):
        for y0,y1 in zip(y_stops,y_stops[1:]):
            if x0 > xmax or x1 < xmin or y0 > ymax or y1 < ymin:
                continue
            polygon = rectangle(bounded, x0, x1, y0, y1)
            for i in range(1, len(polygon)-1):
                vertices = (polygon[0], polygon[i], polygon[i+1])
                emit(vertices, [decal_surface_height(distance(p), decal["heightM"], bevel) for p in vertices])
    if decal["heightM"] > eps:
        edge_height = decal_surface_height(0, decal["heightM"], bevel)
        for i, p in enumerate(bounded):
            q = bounded[(i+1) % len(bounded)]
            if not any(abs(p[6+axis]-edge)<eps and abs(q[6+axis]-edge)<eps for axis in (0,1) for edge in (0,1)):
                continue
            emit((q,p,p), (edge_height,edge_height,0), True)
            emit((q,p,q), (edge_height,0,0), True)
    return out
