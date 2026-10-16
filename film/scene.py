"""Versioned, canonical Y-up scenes evaluated from absolute frame time."""

import hashlib
import json
import math
from pathlib import Path

from .worlds import validate_asset_record


def scene_digest(scene):
    return hashlib.sha256(json.dumps(scene, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _number(value, name, *, minimum=None, maximum=None):
    _require(type(value) in (int, float) and math.isfinite(value), f"{name} must be finite")
    _require(minimum is None or value >= minimum, f"{name} is below its minimum")
    _require(maximum is None or value <= maximum, f"{name} exceeds its maximum")


def _vector(value, name, length=3):
    _require(isinstance(value, list) and len(value) == length, f"{name} must have {length} values")
    for x in value:
        _number(x, name)


def _positive_size(value, name):
    _vector(value, name)
    _require(all(x > 0 for x in value), f"{name} must be positive")


def _provenance(value, name):
    _require(isinstance(value, dict), f"{name} provenance is required")
    for key in ("source", "reuseBasis", "owner"):
        _require(isinstance(value.get(key), str) and value[key].strip(), f"{name}.{key} is required")
    destinations = value.get("allowedExternalDestinations")
    _require(isinstance(destinations, list) and all(isinstance(x, str) for x in destinations), f"{name} must declare external destinations")


def _material(value):
    _require(isinstance(value, dict), "Material must be an object")
    _vector(value["baseColor"], "baseColor", 4)
    _require(all(0 <= x <= 1 for x in value["baseColor"]), "Color channels must be in [0,1]")
    for key in ("roughness", "metallic"):
        _number(value[key], key, minimum=0, maximum=1)
    if "transmission" in value:
        _number(value["transmission"], "transmission", minimum=0, maximum=1)
    if "ior" in value:
        _number(value["ior"], "ior", minimum=1, maximum=3)


def _quaternion(value, name):
    _vector(value, name, 4)
    _require(abs(sum(x*x for x in value) - 1) < 1e-6, f"{name} must be normalized")


def validate_scene(scene):
    """Reject unsupported state rather than guessing mechanics or coordinates."""
    try:
        _require(isinstance(scene, dict) and type(scene.get("schemaVersion")) is int and scene["schemaVersion"] == 1, "Unsupported scene schemaVersion")
        _require(isinstance(scene["sceneId"], str) and scene["sceneId"], "sceneId is required")
        _require(scene["coordinates"] == {"units": "meters", "handedness": "right", "up": "Y"}, "Only right-handed Y-up meters are supported")
        r = scene["render"]
        _require(r["blenderVersion"] == "4.3.2" and r["ffmpegVersion"] == "7.1.5" and r["engine"] == "CYCLES", "Unsupported renderer versions or engine")
        for key in ("fps", "width", "height", "samples", "seed"):
            _require(type(r[key]) is int and r[key] >= (0 if key == "seed" else 1), f"render.{key} must be an integer in range")
        _require(r["width"] % 2 == r["height"] % 2 == 0, "H.264 requires even dimensions")
        p = scene["product"]
        _require(bool(p["revisionId"]), "Product revision is required")
        _provenance(p["provenance"], "product")
        _positive_size(p["dimensionsM"], "product dimensions")
        _require(isinstance(p["components"], list) and p["components"], "Product components are required")
        ids = set()
        for c in p["components"]:
            _require(isinstance(c["id"], str) and c["id"] and c["id"] not in ids, "Component IDs must be nonempty and unique")
            ids.add(c["id"])
            _require(c["shape"] in ("box", "cylinder"), "This milestone accepts synthetic box/cylinder fixtures only")
            _positive_size(c["sizeM"], "component size")
            if c["shape"] == "cylinder":
                _require(abs(c["sizeM"][0] - c["sizeM"][2]) < 1e-9, "Cylinder X/Z diameters must match")
            _vector(c["assembly"]["translationM"], "assembly translation")
            q = c["assembly"]["rotationXyzw"]
            _vector(q, "assembly quaternion", 4)
            _require(abs(sum(x*x for x in q) - 1) < 1e-6, "Assembly quaternion must be normalized")
            _material(c["material"])
            _number(c.get("bevelM", 0), "bevelM", minimum=0, maximum=min(c["sizeM"])/2)
        if "label" in p:
            _require(p["label"]["componentId"] in ids, "Label component does not exist")
            for key in ("text", "subtitle"):
                _require(isinstance(p["label"][key], str), "Label text must be a string")
        env = scene["environment"]
        _require(env["kind"] in ("authored", "mesh", "splat") and isinstance(env["revisionId"], str) and env["revisionId"].strip(), "Environment kind and revision are required")
        if env["kind"] != "authored":
            validate_asset_record(env.get("asset"), kind=env["kind"])
            _require(env.get("reviewStatus") in ("unreviewed", "reviewed", "approved", "rejected"), "World reviewStatus is required")
            _require(isinstance(env.get("displayName"), str) and env["displayName"].strip(), "World displayName is required")
        else:
            _require("asset" not in env, "Authored environments must not hide an unused world asset")
        if "fixture" in env:
            _require(type(env["fixture"]) is bool, "World fixture must be boolean")
        _provenance(env["provenance"], "environment")
        _vector(env["worldColor"], "worldColor")
        _require(all(0 <= x <= 1 for x in env["worldColor"]), "World color must be in [0,1]")
        _require(isinstance(env["plinth"]["id"], str) and env["plinth"]["id"].strip() and env["plinth"]["id"] not in ids, "Plinth ID must be nonempty and distinct from product IDs")
        _positive_size(env["plinth"]["sizeM"], "plinth size")
        _vector(env["plinth"]["translationM"], "plinth translation")
        prop_ids = set(ids) | {env["plinth"]["id"]}
        _require(isinstance(env.get("props", []), list), "Environment props must be a list")
        for prop in env.get("props", []):
            _require(isinstance(prop["id"], str) and prop["id"].strip() and prop["id"] not in prop_ids, "Prop IDs must be unique and distinct from product/plinth IDs")
            prop_ids.add(prop["id"])
            _require(prop["shape"] in ("box", "cylinder"), "Only rigid box/cylinder props are supported")
            _positive_size(prop["sizeM"], "prop size")
            if prop["shape"] == "cylinder":
                _require(abs(prop["sizeM"][0] - prop["sizeM"][2]) < 1e-9, "Cylinder X/Z diameters must match")
            _vector(prop["translationM"], "prop translation")
            _quaternion(prop["rotationXyzw"], "prop quaternion")
            _material(prop["material"])
            _number(prop.get("bevelM", 0), "prop bevelM", minimum=0, maximum=min(prop["sizeM"])/2)
        _require(scene["placement"]["restsOn"] == env["plinth"]["id"], "Unknown contact surface")
        _vector(scene["placement"]["translationM"], "product placement")
        _require(isinstance(scene["evidence"], list), "Evidence list is required")
        evidence_ids = [x["id"] for x in scene["evidence"]]
        _require(len(evidence_ids) == len(set(evidence_ids)), "Evidence IDs must be unique")
        for e in scene["evidence"]:
            _require(isinstance(e["id"], str) and e["id"].strip(), "Evidence IDs must be nonempty strings")
            _require(isinstance(e["description"], str) and e["description"].strip(), "Evidence description is required")
        _require(isinstance(scene["actions"], list), "Actions must be a list")
        action_ids, moving = set(), set()
        for a in scene["actions"]:
            _require(isinstance(a["actionId"], str) and a["actionId"].strip() and a["actionId"] not in action_ids, "Action IDs must be nonempty strings and unique")
            action_ids.add(a["actionId"])
            _require(a["componentId"] in ids and a["relativeTo"] in ids and a["componentId"] != a["relativeTo"], "Action components must match this revision")
            _require(a["componentId"] not in moving, "One action per component is supported in this milestone")
            moving.add(a["componentId"])
            _require(a["approval"] == "confirmed", "Proposed actions must be confirmed before rendering")
            _require(isinstance(a["evidenceIds"], list) and a["evidenceIds"] and all(isinstance(x, str) and x in evidence_ids for x in a["evidenceIds"]), "Action evidence must be a nonempty list of known evidence IDs")
            _require(a["axisSpace"] == "component-local", "Action axis must be component-local")
            _vector(a["axis"], "axis")
            _require(abs(sum(x*x for x in a["axis"]) - 1) < 1e-6, "Action axis must be normalized")
            _vector(a["pivotM"], "pivot")
            _number(a["startSeconds"], "action start", minimum=0)
            _number(a["durationSeconds"], "action duration", minimum=1e-9)
            _require(a["type"] in ("lift", "screw"), "Unsupported action type")
            if a["type"] == "lift":
                _number(a["distanceM"], "lift distance", minimum=0)
            else:
                _number(a["turns"], "turns", minimum=0)
                _number(a["axialTravelPerRevolutionM"], "screw lead", minimum=1e-12)
                _require(type(a["directionSign"]) is int and a["directionSign"] in (-1, 1), "Screw direction must be -1 or 1")
        _require(not any(a["relativeTo"] in moving for a in scene["actions"]), "Animated parent relationships are not supported")
        _require(isinstance(scene["shots"], list) and scene["shots"], "Shots are required")
        next_frame, shot_ids = 1, set()
        for shot in scene["shots"]:
            _require(isinstance(shot["id"], str) and shot["id"].strip() and shot["id"] not in shot_ids, "Shot IDs must be nonempty strings and unique")
            shot_ids.add(shot["id"])
            _require(type(shot["startFrame"]) is int and type(shot["endFrame"]) is int, "Shot frames must be integers")
            _require(shot["startFrame"] == next_frame and shot["endFrame"] >= next_frame, "Shot ranges must be contiguous from frame 1")
            next_frame = shot["endFrame"] + 1
            for pose in (shot["camera"]["from"], shot["camera"]["to"]):
                _vector(pose["positionM"], "camera position")
                _vector(pose["targetM"], "camera target")
                delta = [x-y for x,y in zip(pose["positionM"], pose["targetM"])]
                _require(sum(x*x for x in delta) > 1e-10 and delta[0]**2 + delta[2]**2 > 1e-10, "Camera must have a nonvertical viewing direction")
                _number(pose["focalLengthMm"], "focal length", minimum=1)
            # The interpolated viewing vector must remain valid throughout the move.
            start, end = shot["camera"]["from"], shot["camera"]["to"]
            d0 = [start["positionM"][i]-start["targetM"][i] for i in (0,2)]
            d1 = [end["positionM"][i]-end["targetM"][i] for i in (0,2)]
            dv = [y-x for x,y in zip(d0,d1)]
            denominator = sum(x*x for x in dv)
            u = max(0, min(1, -sum(x*y for x,y in zip(d0,dv))/denominator)) if denominator else 0
            _require(sum((x+u*y)**2 for x,y in zip(d0,dv)) > 1e-10, "Camera move crosses a vertical or zero viewing direction")
        for a in scene["actions"]:
            _require(a["startSeconds"] + a["durationSeconds"] <= (next_frame-2)/r["fps"], "Action must finish within the reel")
        scene_digest(scene)  # rejects non-finite numbers even in additional metadata
    except (KeyError, TypeError, IndexError, OverflowError) as exc:
        raise ValueError(f"Malformed scene: {exc}") from exc
    return scene


def load_scene(path):
    return validate_scene(json.loads(Path(path).read_text()))


def _add(a, b):
    return [x+y for x,y in zip(a,b)]


def _mul(a, b):
    x,y,z,w = a
    X,Y,Z,W = b
    return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z]


def _rotate(q, v):
    return _mul(_mul(q, [*v,0]), [-q[0],-q[1],-q[2],q[3]])[:3]


def _smooth(u):
    u = max(0., min(1., u))
    return u*u*(3-2*u)


def evaluate(scene, frame):
    """Evaluate a validated scene without mutable playback or accumulated deltas."""
    total = scene["shots"][-1]["endFrame"]
    _require(type(frame) is int and 1 <= frame <= total, f"Frame must be in 1..{total}")
    t = (frame-1) / scene["render"]["fps"]
    components = {}
    # Product placement is relative to the top-center of its explicit support.
    # The baseline plinth top-center is [0,0,0], preserving original poses.
    plinth = scene["environment"]["plinth"]
    contact_origin = list(plinth["translationM"])
    contact_origin[1] += plinth["sizeM"][1] / 2
    placement = _add(scene["placement"]["translationM"], contact_origin)
    for c in scene["product"]["components"]:
        pose = c["assembly"]
        components[c["id"]] = {"translationM": _add(pose["translationM"], placement), "rotationXyzw": list(pose["rotationXyzw"])}
    for a in scene["actions"]:
        pose = components[a["componentId"]]
        u = _smooth((t-a["startSeconds"])/a["durationSeconds"])
        theta = 0 if a["type"] == "lift" else 2*math.pi*a["turns"]*a["directionSign"]*u
        distance = a["distanceM"]*u if a["type"] == "lift" else a["axialTravelPerRevolutionM"]*a["turns"]*u
        q = [*(x*math.sin(theta/2) for x in a["axis"]), math.cos(theta/2)]
        # Pivot and translation are in the component's original local frame.
        rotated_pivot = _rotate(q, a["pivotM"])
        offset = [p-r+x*distance for p,r,x in zip(a["pivotM"],rotated_pivot,a["axis"])]
        pose["translationM"] = _add(pose["translationM"], _rotate(pose["rotationXyzw"],offset))
        pose["rotationXyzw"] = _mul(pose["rotationXyzw"],q)
    shot = next(s for s in scene["shots"] if s["startFrame"] <= frame <= s["endFrame"])
    u = _smooth((frame-shot["startFrame"])/max(1,shot["endFrame"]-shot["startFrame"]))
    before, after = shot["camera"]["from"], shot["camera"]["to"]
    camera = {key: [x+(y-x)*u for x,y in zip(before[key],after[key])] for key in ("positionM","targetM")}
    camera["focalLengthMm"] = before["focalLengthMm"] + (after["focalLengthMm"]-before["focalLengthMm"])*u
    return {"frame":frame,"timeSeconds":t,"shotId":shot["id"],"components":components,"camera":camera}


def sample_scene(scene):
    validate_scene(scene)
    return {"scene":scene,"frames":[evaluate(scene,f) for f in range(1,scene["shots"][-1]["endFrame"]+1)]}
