"""Locked mesh A/B scenes and explicit, persisted world calibration.

Only the distant-world record differs between sides. Product state, contact
geometry, ambient colour and sampled cameras remain shared document data.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re

from .worlds import validate_asset_record

_SHARED_ENVIRONMENT = ("plinth", "props", "worldColor", "studioSizeM")
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_CALIBRATION_FIELDS = {"sourceFloorPoint", "measurement", "yawDeltaDegrees"}


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _side(side):
    _require(isinstance(side, str) and side in ("a", "b"), "Comparison side must be a or b")
    return side


def _finite(value, name):
    _require(type(value) in (int, float) and math.isfinite(value), f"{name} must be finite")
    return value


def _point(value, name):
    _require(isinstance(value, list) and len(value) == 3, f"{name} must contain three finite coordinates")
    for number in value:
        _finite(number, name)
    return value


def world_only(environment):
    """Copy an environment's distant-world fields, omitting all shared state."""
    _require(isinstance(environment, dict), "Comparison world must be an environment record")
    return {key: copy.deepcopy(value) for key, value in environment.items() if key not in _SHARED_ENVIRONMENT}


def _materialize(scene, side):
    result = copy.deepcopy(scene)
    comparison = result.pop("comparison")
    if side == "b":
        shared = {key: result["environment"][key] for key in _SHARED_ENVIRONMENT if key in result["environment"]}
        result["environment"] = copy.deepcopy(comparison["alternative"])
        result["environment"].update(shared)
    return result


def _world_id(environment):
    provenance = environment.get("provenance", {})
    values = [container["providerWorldId"] for container in (environment, provenance)
              if isinstance(container, dict) and "providerWorldId" in container and container["providerWorldId"] is not None]
    for value in values:
        _require(isinstance(value, str) and value.strip(), "providerWorldId must be a nonempty string when known")
    _require(not values or all(value == values[0] for value in values), "World record has conflicting providerWorldId values")
    return values[0] if values else None


def _pairing(scene):
    left = _world_id(scene["environment"])
    right = _world_id(scene["comparison"]["alternative"])
    _require(left is None or right is None or left == right,
             "Comparison worlds have different providerWorldId values; select representations of the same source world")
    return {"sameWorld": left is not None and left == right, "worldId": left if left is not None and left == right else None}


def validate_comparison(scene):
    """Validate optional A/B state without recursively validating comparison."""
    if "comparison" not in scene:
        return scene
    comparison = scene["comparison"]
    _require(isinstance(comparison, dict) and type(comparison.get("schemaVersion")) is int
             and comparison["schemaVersion"] == 1, "Unsupported comparison schemaVersion")
    _require(not (set(comparison) - {"schemaVersion", "alternative", "calibration", "reviewedAlignmentDigest"}),
             "Comparison contains unsupported fields")
    _require(scene["environment"]["kind"] == "mesh", "Comparison A must be a visual mesh environment")
    alternative = comparison.get("alternative")
    _require(isinstance(alternative, dict) and alternative.get("kind") == "mesh",
             "Comparison B must be a visual mesh environment")
    _require(not any(key in alternative for key in _SHARED_ENVIRONMENT),
             "Comparison alternative must omit shared plinth, props, worldColor and studioSizeM")
    validate_asset_record(alternative.get("asset"), kind="mesh")
    _pairing(scene)
    if "calibration" in comparison:
        records = comparison["calibration"]
        _require(isinstance(records, dict) and not (set(records) - {"a", "b"})
                 and all(isinstance(record, dict) for record in records.values()),
                 "Comparison calibration must contain per-side evidence records")
    if "reviewedAlignmentDigest" in comparison:
        value = comparison["reviewedAlignmentDigest"]
        _require(isinstance(value, str) and _SHA.fullmatch(value), "Reviewed alignment digest must be SHA256")
    # B receives only the already-validated A contact/ambient state. Its ordinary
    # scene validation cannot recurse because the comparison field is stripped.
    from .scene import validate_scene
    validate_scene(_materialize(scene, "b"))
    return scene


def _validated(scene):
    from .scene import validate_scene
    validate_scene(scene)
    _require("comparison" in scene, "Select a comparison alternative first")


def materialize(scene, side):
    """Return a renderable side with comparison bookkeeping removed."""
    _side(side)
    _validated(scene)
    return _materialize(scene, side)


def _shared_digest(scene):
    shared = _materialize(scene, "a")
    shared["environment"] = {key: copy.deepcopy(scene["environment"][key])
                             for key in _SHARED_ENVIRONMENT if key in scene["environment"]}
    return _digest(shared)


def _alignment_digest(scene):
    from .scene import film_duration
    def geometry(environment):
        asset = environment["asset"]
        return {"revisionId": environment["revisionId"], "asset": {
            key: asset[key] for key in ("sha256", "format", "sourceUp", "scaleToMeters", "translationM", "rotationXyzw")}}
    product = scene["product"]
    product_geometry = {"revisionId": product["revisionId"], "dimensionsM": product["dimensionsM"],
                        "components": [{key: component[key]
                                        for key in ("id", "shape", "sizeM", "assembly", "asset", "bevelM")
                                        if key in component} for component in product["components"]]}
    # Review covers spatial registration and the complete sampled product motion.
    # Camera framing and ambient colour have their own shared digest; neither can
    # renew or remove placement review. Product geometry/poses, action parameters
    # and time sampling can change contact even when world transforms stay fixed.
    return _digest({"schemaVersion": 1, "a": geometry(scene["environment"]),
                    "b": geometry(scene["comparison"]["alternative"]),
                    "contact": {key: copy.deepcopy(scene["environment"][key])
                                for key in ("plinth", "props") if key in scene["environment"]},
                    "placement": scene["placement"], "productGeometry": product_geometry,
                    "actions": scene["actions"],
                    "timeSampling": {"fps": scene["render"]["fps"], "lastFrame": film_duration(scene)}})


def comparison_payload(scene):
    """Expose two locked scenes plus immutable shared/alignment identities."""
    _validated(scene)
    alignment = _alignment_digest(scene)
    return {"a": _materialize(scene, "a"), "b": _materialize(scene, "b"),
            "sharedDigest": _shared_digest(scene), "alignmentDigest": alignment,
            "alignmentStatus": "reviewed" if scene["comparison"].get("reviewedAlignmentDigest") == alignment else "draft",
            "pairing": _pairing(scene)}


def set_alternative(scene, environment):
    """Attach/replace a B world while preserving the primary shared scene."""
    from .scene import validate_scene
    validate_scene(scene)
    result = copy.deepcopy(scene)
    comparison = result.setdefault("comparison", {"schemaVersion": 1})
    previous = comparison.get("alternative")
    comparison["alternative"] = world_only(environment)
    if previous != comparison["alternative"] and "calibration" in comparison:
        comparison["calibration"].pop("b", None)
    validate_scene(result)
    return result


def _multiply(left, right):
    x, y, z, w = left
    X, Y, Z, W = right
    return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z]


def _rotate(quaternion, point):
    x, y, z, w = quaternion
    return _multiply(_multiply(quaternion, [*point, 0]), [-x, -y, -z, w])[:3]


def _transform(asset):
    return {key: copy.deepcopy(asset[key]) for key in ("scaleToMeters", "translationM", "rotationXyzw")}


def calibrate_scene(scene, side, data):
    """Apply measured scale, canonical-Y yaw and a picked raw-GLB floor point.

    Scale uses the full 3D source distance. Yaw pre-multiplies the current world
    rotation around canonical Y. Floor fitting changes translation Y only, so
    horizontal registration, product poses and camera settings remain untouched.
    """
    _side(side)
    _validated(scene)
    _require(isinstance(data, dict) and data and not (set(data) - _CALIBRATION_FIELDS),
             "Calibration requires sourceFloorPoint, measurement or yawDeltaDegrees")
    result = copy.deepcopy(scene)
    environment = result["environment"] if side == "a" else result["comparison"]["alternative"]
    asset = environment["asset"]
    before = _transform(asset)
    records = result["comparison"].setdefault("calibration", {})
    previous = records.get(side, {})
    if previous.get("sourceAssetSha256") != asset["sha256"]:
        previous = {}
    record = copy.deepcopy(previous)
    record.update(schemaVersion=1, sourceAssetSha256=asset["sha256"])
    if "sourceFloorPoint" in data:
        record["sourceFloorPoint"] = copy.deepcopy(_point(data["sourceFloorPoint"], "Source floor point"))
    if "measurement" in data:
        measurement = data["measurement"]
        _require(isinstance(measurement, dict) and set(measurement) == {"sourcePoints", "realDistanceM"},
                 "Measurement requires sourcePoints and realDistanceM")
        points = measurement["sourcePoints"]
        _require(isinstance(points, list) and len(points) == 2, "Measurement needs two source points")
        first, second = [_point(point, "Measurement source point") for point in points]
        distance = math.dist(first, second)
        real_distance = _finite(measurement["realDistanceM"], "Measured real distance")
        _require(math.isfinite(distance) and distance > 1e-12 and real_distance > 0,
                 "Measurement source points must be distinct and realDistanceM must be positive")
        scale = real_distance / distance
        _require(math.isfinite(scale) and scale > 0, "Measured metric scale must be positive and finite")
        asset["scaleToMeters"] = scale
        record["measurement"] = copy.deepcopy(measurement)
        record["sourceDistance"] = distance
    if "yawDeltaDegrees" in data:
        yaw = _finite(data["yawDeltaDegrees"], "Yaw delta")
        angle = math.radians(math.remainder(yaw, 360))
        if angle:
            rotation = _multiply([0, math.sin(angle / 2), 0, math.cos(angle / 2)], asset["rotationXyzw"])
            norm = math.sqrt(sum(value * value for value in rotation))
            rotation = [value / norm for value in rotation]
            # q and -q encode the same orientation; retain a stable representative.
            if rotation[3] < 0:
                rotation = [-value for value in rotation]
            asset["rotationXyzw"] = rotation
        record["yawDeltaDegrees"] = yaw
    floor = record.get("sourceFloorPoint")
    if floor is not None:
        floor = _point(floor, "Saved source floor point")
        rotated = _rotate(asset["rotationXyzw"], floor)
        plinth = result["environment"]["plinth"]
        target = plinth["translationM"][1] - plinth["sizeM"][1] / 2
        translation = target - rotated[1] * asset["scaleToMeters"]
        _require(math.isfinite(translation), "Floor calibration produced a nonfinite translation")
        asset["translationM"][1] = translation
        record["floorTargetY"] = target
    validate_asset_record(asset, kind="mesh")
    history = record.setdefault("history", [])
    _require(isinstance(history, list) and len(history) < 1000, "Calibration history is malformed or exceeds 1000 steps")
    history.append({"inputs": copy.deepcopy(data), "before": before, "result": _transform(asset)})
    record["result"] = _transform(asset)
    record["alignmentDigest"] = _alignment_digest(result)
    records[side] = record
    from .scene import validate_scene
    validate_scene(result)
    return result


def review_alignment(scene):
    """Save approval of this exact world/contact alignment, without altering it."""
    _validated(scene)
    result = copy.deepcopy(scene)
    result["comparison"]["reviewedAlignmentDigest"] = _alignment_digest(result)
    return result
