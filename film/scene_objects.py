"""Resolve the static scene-object graph in canonical Y-up meters.

Relationships describe rigid placement, not inferred physics or mechanisms. Bounds
are conservative world-axis-aligned boxes, computed from transformed box corners.
The product is one rigid assembly here; animated component actions are evaluated
separately and never move objects related to the product.
"""

import itertools
import math


IDENTITY = [0, 0, 0, 1]
RESERVED_IDS = {"product", "floor", "world-surface"}
RELATION_TYPES = {"on", "beside", "inFrontOf", "behind"}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _number(value, name, *, minimum=None):
    _require(type(value) in (int, float) and math.isfinite(value), f"{name} must be finite")
    _require(minimum is None or value >= minimum, f"{name} must be nonnegative")


def _vector(value, name, length=3):
    _require(isinstance(value, list) and len(value) == length, f"{name} must have {length} values")
    for item in value:
        _number(item, name)


def _quaternion(value, name):
    _vector(value, name, 4)
    _require(abs(sum(x*x for x in value) - 1) < 1e-6, f"{name} must be normalized")


def _add(a, b):
    return [x+y for x, y in zip(a, b)]


def _mul(a, b):
    x, y, z, w = a
    X, Y, Z, W = b
    return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X,
            w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z]


def _rotate(q, v):
    return _mul(_mul(q, [*v, 0]), [-q[0], -q[1], -q[2], q[3]])[:3]


def _bounds(points):
    _require(points and all(math.isfinite(value) for point in points for value in point),
             "Resolved scene bounds must be finite")
    return [[min(p[i] for p in points) for i in range(3)],
            [max(p[i] for p in points) for i in range(3)]]


def _corners(size, translation, rotation):
    return [_add(translation, _rotate(rotation, corner))
            for corner in itertools.product(*[(-v/2, v/2) for v in size])]


def _pose(size, translation, rotation):
    return {"translationM": list(translation), "rotationXyzw": list(rotation),
            "boundsM": _bounds(_corners(size, translation, rotation))}


def _top_center(pose):
    low, high = pose["boundsM"]
    return [(low[0]+high[0])/2, high[1], (low[2]+high[2])/2]


def _horizontal(pose):
    normal = _rotate(pose["rotationXyzw"], [0, 1, 0])
    return abs(normal[0]) < 1e-6 and abs(normal[2]) < 1e-6 and abs(abs(normal[1])-1) < 1e-6


def resolve_scene_objects(scene):
    """Return product/prop world poses, bounds, floorY and supportOriginM.

    ``boundsM`` is ``[minimum_xyz, maximum_xyz]``. The product root preserves
    the scene's existing support-origin convention, including off-center CAD
    assemblies. Relationship offsets and placement translations use world axes.
    Objects without a relationship retain their absolute authored translation.
    Hidden objects are resolved for editing, but cannot be relationship targets.
    This function validates the graph; normal scene validation checks materials,
    asset records, component geometry and animation independently.
    """
    try:
        environment = scene["environment"]
        plinth = environment["plinth"]
        placement = scene["placement"]
        props = environment.get("props", [])
        _require(isinstance(props, list), "Environment props must be a list")
        _require(isinstance(plinth, dict), "Plinth must be an object")
        component_ids = {c["id"] for c in scene["product"]["components"]}
        plinth_id = plinth["id"]
        _require(isinstance(plinth_id, str) and plinth_id.strip() and
                 plinth_id not in RESERVED_IDS | component_ids,
                 "Plinth ID must be distinct from product and reserved object IDs")
        _require(type(plinth.get("visible", True)) is bool, "Plinth visible must be boolean")
        _vector(plinth["translationM"], "plinth translation")
        _vector(plinth["sizeM"], "plinth size")
        _require(all(x > 0 for x in plinth["sizeM"]), "plinth size must be positive")
        _quaternion(plinth.get("rotationXyzw", IDENTITY), "plinth quaternion")
        plinth_pose = _pose(plinth["sizeM"], plinth["translationM"], plinth.get("rotationXyzw", IDENTITY))
        floor_y = environment.get("floorY", plinth_pose["boundsM"][0][1] if plinth.get("visible", True) else 0)
        _number(floor_y, "environment.floorY")
        records = {}
        for prop in props:
            _require(isinstance(prop, dict), "Prop must be an object")
            identity = prop["id"]
            _require(isinstance(identity, str) and identity.strip() and
                     identity not in RESERVED_IDS | component_ids | {plinth_id} | set(records),
                     "Prop IDs must be unique and distinct from reserved, product and plinth IDs")
            records[identity] = prop
            _require(type(prop.get("visible", True)) is bool, "Prop visible must be boolean")
            if "name" in prop:
                _require(isinstance(prop["name"], str) and prop["name"].strip(), "Prop name must be nonempty")
            _vector(prop["translationM"], "prop translation")
            _vector(prop["sizeM"], "prop size")
            _require(all(x > 0 for x in prop["sizeM"]), "prop size must be positive")
            _quaternion(prop["rotationXyzw"], "prop quaternion")
            if "relationship" in prop:
                relation = prop["relationship"]
                _require(isinstance(relation, dict), "Prop relationship must be an object")
                _require(relation.get("type") in RELATION_TYPES, "Unknown prop relationship type")
                _require(isinstance(relation.get("targetId"), str), "Relationship targetId is required")
                _number(relation.get("gapM", 0), "relationship gapM", minimum=0)
                _vector(relation.get("offsetM", [0, 0, 0]), "relationship offsetM")
                if relation["targetId"] == "floor":
                    _require(relation["type"] == "on", "Floor supports only the on relationship")
        _vector(placement["translationM"], "product placement")
        _number(placement.get("rotationYDegrees", 0), "placement rotationYDegrees")
        _require(isinstance(placement["restsOn"], str), "Product restsOn must be an object ID")
        if placement["restsOn"] == "world-surface":
            _require(environment["kind"] == "mesh", "World-surface contact requires a mesh environment")
            _vector(placement.get("contactPointM"), "placement contactPointM")
        elif "contactPointM" in placement:
            _vector(placement["contactPointM"], "placement contactPointM")

        resolved, visiting = {}, set()
        support_origin_m = None
        floor_pose = {"translationM": [0, floor_y, 0], "rotationXyzw": list(IDENTITY),
                      "boundsM": [[0, floor_y, 0], [0, floor_y, 0]]}

        def target(identity):
            _require(identity in {"product", "floor", plinth_id} | set(records), f"Unknown relationship target: {identity}")
            if identity == "floor":
                return floor_pose
            if identity == plinth_id:
                _require(plinth.get("visible", True), "Hidden plinth cannot be a contact or relationship target")
                return plinth_pose
            if identity in records:
                _require(records[identity].get("visible", True), f"Hidden prop cannot be a relationship target: {identity}")
            return resolve(identity)

        def resolve(identity):
            nonlocal support_origin_m
            if identity in resolved:
                return resolved[identity]
            _require(identity not in visiting, f"Scene object relationship cycle at {identity}")
            visiting.add(identity)
            if identity == "product":
                support_id = placement["restsOn"]
                _require(support_id != "product", "Product cannot rest on itself")
                if support_id == "world-surface":
                    support_origin = list(placement["contactPointM"])
                else:
                    support = target(support_id)
                    _require(_horizontal(support), "Contact target must have a horizontal support surface")
                    support_origin = _top_center(support)
                translation = _add(support_origin, placement["translationM"])
                angle = math.radians(placement.get("rotationYDegrees", 0))/2
                rotation = [0, math.sin(angle), 0, math.cos(angle)]
                points = []
                for component in scene["product"]["components"]:
                    assembly = component["assembly"]
                    component_translation = _add(translation, _rotate(rotation, assembly["translationM"]))
                    component_rotation = _mul(rotation, assembly["rotationXyzw"])
                    points.extend(_corners(component["sizeM"], component_translation, component_rotation))
                result = {"translationM": translation, "rotationXyzw": rotation, "boundsM": _bounds(points)}
                support_origin_m = support_origin
            else:
                prop = records[identity]
                rotation = prop["rotationXyzw"]
                translation = list(prop["translationM"])
                if "relationship" in prop:
                    relation = prop["relationship"]
                    target_id = relation["targetId"]
                    _require(target_id != identity, "Prop cannot target itself")
                    support = target(target_id)
                    low, high = support["boundsM"]
                    own_low, own_high = _pose(prop["sizeM"], [0, 0, 0], rotation)["boundsM"]
                    gap = relation.get("gapM", 0)
                    kind = relation["type"]
                    if kind == "on":
                        _require(_horizontal(support), "On relationship target must have a horizontal support surface")
                        translation = [(low[0]+high[0])/2, high[1]-own_low[1]+gap, (low[2]+high[2])/2]
                    else:
                        # Side placement aligns bottoms and clears the target's
                        # complete world AABB, including rotated assemblies.
                        translation = [(low[0]+high[0])/2, low[1]-own_low[1], (low[2]+high[2])/2]
                        if kind == "beside":
                            translation[0] = high[0]-own_low[0]+gap
                        elif kind == "inFrontOf":
                            translation[2] = high[2]-own_low[2]+gap
                        else:
                            translation[2] = low[2]-own_high[2]-gap
                    translation = _add(translation, relation.get("offsetM", [0, 0, 0]))
                result = _pose(prop["sizeM"], translation, rotation)
            visiting.remove(identity)
            resolved[identity] = result
            return result

        product_pose = resolve("product")
        prop_poses = {identity: resolve(identity) for identity in records}
        return {"product": product_pose, "props": prop_poses, "floorY": floor_y,
                "supportOriginM": support_origin_m}
    except (KeyError, TypeError, IndexError, OverflowError, RecursionError) as exc:
        raise ValueError(f"Malformed scene object graph: {exc}") from exc
