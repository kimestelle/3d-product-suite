"""Versioned, canonical Y-up scenes evaluated from absolute frame time."""

import hashlib
import json
import math
import re
from pathlib import Path

from .worlds import validate_asset_record, validate_product_asset_record
from .material_assets import validate_material_textures, validate_hdri_asset
from .film_images import validate_film_image_asset
from .audio import validate_scene_audio


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

    validate_material_textures(value)


def _quaternion(value, name):
    _vector(value, name, 4)
    _require(abs(sum(x*x for x in value) - 1) < 1e-6, f"{name} must be normalized")


def _validate_animation(animation, component_ids, moving, motion_parents, total_frames):
    """Tracks are absolute reel-frame values; disabling retains authored keys."""
    _require(isinstance(animation, dict), "Animation must be an object")
    tracks = animation.get("tracks")
    _require(isinstance(tracks, list), "Animation tracks must be a list")
    _require("$product" not in component_ids, "$product is reserved for placement animation")
    properties = {f"{kind}.{axis}" for kind in ("position", "rotation") for axis in "xyz"} | {"scale", "motion"}
    track_ids, channels = set(), set()
    for track in tracks:
        _require(isinstance(track, dict), "Animation track must be an object")
        track_id = track.get("id")
        _require(isinstance(track_id, str) and 0 < len(track_id.strip()) <= 120 and track_id not in track_ids,
                 "Animation track IDs must be nonempty, bounded and unique")
        track_ids.add(track_id)
        target, prop = track.get("componentId"), track.get("property")
        _require(isinstance(target, str) and (target == "$product" or target in component_ids),
                 "Animation component does not exist")
        _require(isinstance(prop, str) and prop in properties, "Animation property is unsupported")
        _require(target != "$product" or prop == "scale" or prop.startswith("position."),
                 "Product animation supports position and scale only")
        _require(prop != "motion" or target in moving, "Motion animation requires an existing action")
        _require((target, prop) not in channels, "Animation component/property tracks must be unique")
        channels.add((target, prop))
        _require(type(track.get("enabled")) is bool, "Animation track enabled must be boolean")
        _require(not track["enabled"] or target not in motion_parents,
                 f"Cannot animate {target}: it is the reference for another part's movement. "
                 "Animate the whole product or a part with no dependent movement.")
        keys = track.get("keys")
        _require(isinstance(keys, list) and keys, "Animation track requires at least one key")
        previous = 0
        for key in keys:
            _require(isinstance(key, dict), "Animation key must be an object")
            frame = key.get("frame")
            _require(type(frame) is int and previous < frame <= total_frames,
                     "Animation key frames must be sorted, unique and within the reel")
            previous = frame
            minimum, maximum = (.01, 100) if prop == "scale" else (-100, 100) if prop == "motion" else (None, None)
            _number(key.get("value"), f"Animation {prop} value", minimum=minimum, maximum=maximum)
            _require(key.get("interpolation") in ("linear", "ease", "hold"), "Animation key interpolation is unsupported")


def _validate_depth_of_field(camera):
    """Aperture is per shot; omitted distance focuses the evaluated aim target."""
    if "depthOfField" not in camera:
        return
    optics = camera["depthOfField"]
    _require(isinstance(optics, dict), "Camera depthOfField must be an object")
    _require(type(optics.get("enabled")) is bool, "Camera depthOfField.enabled must be boolean")
    _number(optics.get("fStop"), "Camera f-stop", minimum=.7, maximum=32)
    if "focusDistanceM" in optics:
        _number(optics["focusDistanceM"], "Camera focus distance", minimum=.001, maximum=1000)
    if not optics["enabled"]:
        return
    before, after = camera["from"], camera["to"]
    focal0, focal1 = before["focalLengthMm"] / 1000, after["focalLengthMm"] / 1000
    if "focusDistanceM" in optics:
        _require(optics["focusDistanceM"] > max(focal0, focal1),
                 "Camera focus distance must be beyond the focal length throughout the shot")
        return
    # Smoothstep traverses all u in [0,1]. Check the minimum of distance^2 -
    # focal_length^2, not just endpoints, so a dolly cannot cross the lens plane.
    start = [p-t for p, t in zip(before["positionM"], before["targetM"])]
    end = [p-t for p, t in zip(after["positionM"], after["targetM"])]
    delta = [b-a for a, b in zip(start, end)]
    focal_delta = focal1 - focal0
    a = sum(x*x for x in delta) - focal_delta*focal_delta
    b = 2 * (sum(x*y for x, y in zip(start, delta)) - focal0*focal_delta)
    c = sum(x*x for x in start) - focal0*focal0
    candidates = [0., 1.]
    if a > 0:
        candidates.append(max(0., min(1., -b / (2*a))))
    _require(min(a*u*u + b*u + c for u in candidates) > 0,
             "Camera focus target must remain beyond the focal length throughout the shot")


def _motion_channels(motion):
    kind = motion['kind']
    if kind in ('orbit', 'dolly'):
        return {'camera.position'}
    if kind == 'mechanical':
        return {'motion'} | {f'{prop}.{axis}' for prop in ('position', 'rotation') for axis in 'xyz'}
    return {'scale'} if kind == 'scale' else {f"{'position' if kind == 'move' else 'rotation'}.{motion['axis']}"}


def _effective_motions(scene, shot):
    """A shot owner replaces a conflicting shared action as a whole."""
    local = [motion for motion in shot.get('motions', []) if motion['enabled']]
    owned = {(motion['target'], channel) for motion in local for channel in _motion_channels(motion)}
    shared = [motion for motion in scene.get('motions', []) if motion['enabled'] and
              not any((motion['target'], channel) in owned for channel in _motion_channels(motion))]
    return [(motion, False) for motion in shared] + [(motion, True) for motion in local]


def _validate_film_motions(scene, component_ids, moving, motion_parents):
    if 'motions' not in scene and not any('motions' in shot for shot in scene['shots']):
        return
    _require(not {'$camera', '$product'} & component_ids, 'Reserved Film target ID')
    for source in [scene, *scene['shots']]:
        motions = source.get('motions', [])
        _require(isinstance(motions, list), 'Film motions must be a list')
        ids, owners = set(), set()
        for motion in motions:
            _require(isinstance(motion, dict), 'Film motion must be an object')
            identifier = motion.get('id')
            _require(isinstance(identifier, str) and 0 < len(identifier.strip()) <= 120 and identifier not in ids,
                     'Film motion IDs must be nonempty, bounded and unique within their scope')
            ids.add(identifier)
            target, kind = motion.get('target'), motion.get('kind')
            _require(isinstance(target, str) and (target in component_ids or target in ('$camera', '$product')),
                     'Film motion target does not exist')
            _require(kind in ('move', 'rotate', 'scale', 'mechanical', 'orbit', 'dolly'), 'Unsupported Film motion')
            _require((target == '$camera') == (kind in ('orbit', 'dolly')), 'Camera actions require a camera target')
            _require(kind != 'mechanical' or target in moving, 'Mechanism requires an existing confirmed action')
            _require(target not in motion_parents, 'Cannot animate a part used as another mechanism reference')
            _require(motion.get('axis') in ('x', 'y', 'z'), 'Film motion axis must be x, y or z')
            _require(kind != 'orbit' or motion['axis'] == 'y', 'Orbit uses the vertical Y axis')
            _number(motion.get('amount'), 'Film motion amount',
                    minimum=.01 if kind == 'scale' else 0 if kind == 'mechanical' else None,
                    maximum=100 if kind == 'scale' else 1 if kind == 'mechanical' else None)
            for field, minimum in (('startFrame', 1), ('durationFrames', 2)):
                _require(type(motion.get(field)) is int and minimum <= motion[field] <= 9007199254740991,
                         f'Film motion {field} must be an integer at least {minimum}')
            _require(motion.get('easing') in ('linear', 'ease', 'hold'), 'Unsupported Film motion easing')
            _require(type(motion.get('enabled')) is bool, 'Film motion enabled must be boolean')
            if 'keys' in motion:
                keys = motion['keys']
                _require(isinstance(keys, list) and keys, 'Film motion curve needs at least one key')
                previous = 0
                for key in keys:
                    _require(isinstance(key, dict), 'Film motion key must be an object')
                    frame = key.get('frame')
                    _require(type(frame) is int and previous < frame <= motion['durationFrames'],
                             'Film motion keys must be ordered, distinct and inside the motion')
                    previous = frame
                    _number(key.get('value'), 'Film motion progress', minimum=0, maximum=1)
                    _require(key.get('interpolation') in ('linear', 'ease', 'hold'), 'Unsupported Film curve interpolation')
            if motion['enabled']:
                channels = {(target, channel) for channel in _motion_channels(motion)}
                _require(not channels & owners, 'Film motion channels have competing owners within one scope')
                owners.update(channels)
    shared_ids = {motion['id'] for motion in scene.get('motions', [])}
    for shot in scene['shots']:
        _require(not shared_ids & {motion['id'] for motion in shot.get('motions', [])},
                 'Local and across-cuts motions need distinct IDs in the same shot')
        for motion, _ in _effective_motions(scene, shot):
            if motion['kind'] in ('dolly', 'orbit'):
                camera = shot['camera']
                distance = math.dist(camera['from']['positionM'], camera['from']['targetM'])
                # Progress is bounded [0,1], so the minimum occurs at an endpoint.
                remaining = distance - (max(0, motion['amount']) if motion['kind'] == 'dolly' else 0)
                optics = camera.get('depthOfField', {})
                minimum = max(camera['from']['focalLengthMm'], camera['to']['focalLengthMm']) / 1000 if optics.get('enabled') and 'focusDistanceM' not in optics else 1e-5
                _require(remaining > minimum, 'Camera motion must stop before its target and focus plane')


def _motion_progress(motion, frame):
    local = frame - motion['startFrame'] + 1
    if motion.get('keys'):
        return _track_value(motion, local)
    progress = max(0., min(1., (local - 1) / (motion['durationFrames'] - 1)))
    if motion['easing'] == 'ease':
        return _smooth(progress)
    if motion['easing'] == 'hold':
        return 1. if progress >= 1 else 0.
    return progress


def _film_values(scene, shot, frame, animated):
    """Evaluate authored actions into the same canonical component channels."""
    components = {part['id']: part for part in scene['product']['components']}
    for motion, local in _effective_motions(scene, shot):
        target = motion['target']
        if target == '$camera':
            continue
        clock = frame - shot['startFrame'] + 1 if local else frame
        progress = _motion_progress(motion, clock)
        value, kind, axis = motion['amount'] * progress, motion['kind'], motion['axis']
        pose = scene['placement'] if target == '$product' else components[target]['assembly']
        values = animated.setdefault(target, {})
        if kind in ('move', 'rotate') and any(action['componentId'] == target for action in scene['actions']):
            # An explicit spatial owner must not secretly resume the legacy
            # mechanism after replacing a shared mechanical action.
            values['motion'] = 0
        if kind == 'move':
            values[f'position.{axis}'] = pose['translationM']['xyz'.index(axis)] + value
        elif kind == 'rotate':
            rotation = [0, 0, 0] if target == '$product' else _euler_xyz_degrees(pose['rotationXyzw'])
            values[f'rotation.{axis}'] = rotation['xyz'.index(axis)] + value
        elif kind == 'scale':
            values['scale'] = pose.get('scale', 1) * (1 + (motion['amount'] - 1) * progress)
        elif kind == 'mechanical':
            for index, component_axis in enumerate('xyz'):
                values[f'position.{component_axis}'] = pose['translationM'][index]
                values[f'rotation.{component_axis}'] = _euler_xyz_degrees(pose['rotationXyzw'])[index]
            values['motion'] = value


def _film_camera(scene, shot, frame, camera):
    for motion, local in _effective_motions(scene, shot):
        if motion['target'] != '$camera':
            continue
        clock = frame - shot['startFrame'] + 1 if local else frame
        value = motion['amount'] * _motion_progress(motion, clock)
        start = shot['camera']['from']
        offset = [position-target for position, target in zip(start['positionM'], start['targetM'])]
        if motion['kind'] == 'orbit':
            angle = math.radians(value)
            quaternion = [0, math.sin(angle/2), 0, math.cos(angle/2)]
            offset = _rotate(quaternion, offset)
        else:
            radius = math.sqrt(sum(value*value for value in offset))
            offset = [component * (1 - value/radius) for component in offset]
        camera['positionM'] = _add(start['targetM'], offset)
        camera['targetM'] = list(start['targetM'])


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
        presets = p.get("materialPresets", [])
        _require(isinstance(presets, list), "Product materialPresets must be a list")
        presets_by_id = {}
        for preset in presets:
            _require(isinstance(preset, dict), "Material preset must be an object")
            preset_id = preset.get("id")
            _require(isinstance(preset_id, str) and preset_id.strip() and len(preset_id) <= 120
                     and preset_id not in presets_by_id, "Material preset IDs must be nonempty, bounded and unique")
            name = preset.get("name")
            _require(isinstance(name, str) and 0 < len(name) <= 140 and name == name.strip(),
                     "Material preset name must contain 1–140 characters without surrounding whitespace")
            _require(preset.get("type") in ("glass", "plastic", "metal", "ceramic", "rubber", "paper", "custom"),
                     "Material preset type is unsupported")
            _material(preset["material"])
            presets_by_id[preset_id] = preset
        ids = set()
        for c in p["components"]:
            _require(isinstance(c["id"], str) and c["id"] and c["id"] not in ids, "Component IDs must be nonempty and unique")
            ids.add(c["id"])
            _require(c["shape"] in ("box", "cylinder", "mesh"), "Product components must be box, cylinder or normalized GLB mesh")
            _positive_size(c["sizeM"], "component size")
            if c["shape"] == "mesh":
                validate_product_asset_record(c.get("asset"))
                _require(type(c.get("materialOverride", False)) is bool, "materialOverride must be boolean")
                _require(c.get("bevelM", 0) == 0, "Mesh geometry is preserved; mesh bevelM must be zero")
            else:
                _require("asset" not in c and "materialOverride" not in c, "Primitive components must not hide mesh assets or overrides")
            if c["shape"] == "cylinder":
                _require(abs(c["sizeM"][0] - c["sizeM"][2]) < 1e-9, "Cylinder X/Z diameters must match")
            _vector(c["assembly"]["translationM"], "assembly translation")
            _number(c["assembly"].get("scale", 1), "component scale", minimum=.01, maximum=100)
            q = c["assembly"]["rotationXyzw"]
            _vector(q, "assembly quaternion", 4)
            _require(abs(sum(x*x for x in q) - 1) < 1e-6, "Assembly quaternion must be normalized")
            _material(c["material"])
            if "materialPresetId" in c:
                preset_id = c["materialPresetId"]
                _require(isinstance(preset_id, str) and preset_id in presets_by_id,
                         "Component material preset does not exist")
                _require(c["shape"] != "mesh" or c.get("materialOverride") is True,
                         "Mesh material preset requires materialOverride")
                _require(c["material"] == presets_by_id[preset_id]["material"],
                         "Component material must match its referenced preset")
            if "materialBindings" in c:
                _require(c["shape"] == "mesh", "Material section bindings require an imported mesh")
                bindings = c["materialBindings"]
                _require(isinstance(bindings, list) and len(bindings) <= 100000,
                         "Material section bindings must be a bounded list")
                bound_nodes = set()
                for binding in bindings:
                    _require(isinstance(binding, dict) and set(binding) == {"nodeIndex", "materialPresetId"},
                             "Material section binding must contain nodeIndex and materialPresetId")
                    node_index = binding["nodeIndex"]
                    _require(type(node_index) is int and 0 <= node_index < 100000 and node_index not in bound_nodes,
                             "Material section node indices must be nonnegative and unique")
                    bound_nodes.add(node_index)
                    preset_id = binding["materialPresetId"]
                    _require(isinstance(preset_id, str) and preset_id in presets_by_id,
                             "Material section preset does not exist")
            _number(c.get("bevelM", 0), "bevelM", minimum=0, maximum=min(c["sizeM"])/2)
        if "label" in p:
            _require(p["label"]["componentId"] in ids, "Label component does not exist")
            _require(next(c for c in p["components"] if c["id"] == p["label"]["componentId"])["shape"] != "mesh",
                     "Procedural label text must not replace imported product artwork")
            for key in ("text", "subtitle"):
                _require(isinstance(p["label"][key], str), "Label text must be a string")
        decals = p.get("decals", [])
        _require(isinstance(decals, list) and len(decals) <= 32, "Product decals must be a list of at most 32 decals")
        decal_ids = set()
        components = {component["id"]: component for component in p["components"]}
        for decal in decals:
            _require(isinstance(decal, dict), "Decal must be an object")
            _require(isinstance(decal.get("id"), str) and 0 < len(decal["id"].strip()) <= 120
                     and decal["id"] not in decal_ids, "Decal IDs must be nonempty, bounded and unique")
            decal_ids.add(decal["id"])
            component_id = decal.get("componentId")
            _require(isinstance(component_id, str) and component_id in components, "Decal component does not exist")
            part_id = decal.get("partId")
            _require(isinstance(part_id, str) and (part_id == component_id or
                     (components[component_id]["shape"] == "mesh" and
                      re.fullmatch(re.escape(component_id) + r"::node:(?:0|[1-9][0-9]{0,5})", part_id))),
                     "Decal part must be its component or a source mesh node")
            for key in ("text", "subtitle"):
                _require(isinstance(decal.get(key), str) and len(decal[key]) <= 200,
                         f"Decal {key} must be a string of at most 200 characters")
            for key, minimum, maximum in (("centerUv", 0, 1), ("sizeUv", .01, 1)):
                _vector(decal.get(key), f"Decal {key}", 2)
                for value in decal[key]:
                    _number(value, f"Decal {key}", minimum=minimum, maximum=maximum)
            _number(decal.get("rotationDeg"), "Decal rotation", minimum=-180, maximum=180)
            _number(decal.get("heightM"), "Decal height", minimum=0, maximum=.01)
            _number(decal.get("bevelM"), "Decal bevel", minimum=0, maximum=decal["heightM"] / 2)
        env = scene["environment"]
        _require(env["kind"] in ("authored", "mesh", "splat") and isinstance(env["revisionId"], str) and env["revisionId"].strip(), "Environment kind and revision are required")
        if env["kind"] != "authored":
            validate_asset_record(env.get("asset"), kind=env["kind"])
            _require(env.get("reviewStatus") in ("unreviewed", "reviewed", "approved", "rejected"), "World reviewStatus is required")
            _require(isinstance(env.get("displayName"), str) and env["displayName"].strip(), "World displayName is required")
            if "collider" in env:
                _require(isinstance(env["collider"], dict), "World collider must be an object")
                validate_asset_record(env["collider"].get("asset"), kind="mesh")
        else:
            _require("asset" not in env and "collider" not in env, "Authored environments must not hide an unused world asset")
        if "fixture" in env:
            _require(type(env["fixture"]) is bool, "World fixture must be boolean")
        _provenance(env["provenance"], "environment")
        _vector(env["worldColor"], "worldColor")
        _require(all(0 <= x <= 1 for x in env["worldColor"]), "World color must be in [0,1]")
        _require(isinstance(env["plinth"]["id"], str) and env["plinth"]["id"].strip() and env["plinth"]["id"] not in ids, "Plinth ID must be nonempty and distinct from product IDs")
        _positive_size(env["plinth"]["sizeM"], "plinth size")
        _vector(env["plinth"]["translationM"], "plinth translation")
        if "visible" in env["plinth"]:
            _require(type(env["plinth"]["visible"]) is bool, "Plinth visible must be boolean")
        if "material" in env["plinth"]:
            _material(env["plinth"]["material"])
        prop_ids = set(ids) | {env["plinth"]["id"]}
        _require(isinstance(env.get("props", []), list), "Environment props must be a list")
        for prop in env.get("props", []):
            _require(isinstance(prop["id"], str) and prop["id"].strip() and prop["id"] not in prop_ids, "Prop IDs must be unique and distinct from product/plinth IDs")
            prop_ids.add(prop["id"])
            _require(prop["shape"] in ("box", "cylinder", "mesh"), "Props must be box, cylinder or normalized GLB mesh")
            if prop["shape"] == "mesh":
                validate_product_asset_record(prop.get("asset"))
                _positive_size(prop["asset"].get("sourceDimensionsM"), "Prop source dimensions")
                _require(type(prop.get("materialOverride", False)) is bool, "Prop materialOverride must be boolean")
                _require(prop.get("bevelM", 0) == 0, "Imported prop geometry cannot be beveled")
            else:
                _require("asset" not in prop and "materialOverride" not in prop, "Primitive props cannot hide mesh assets or overrides")
            _positive_size(prop["sizeM"], "prop size")
            if prop["shape"] == "cylinder":
                _require(abs(prop["sizeM"][0] - prop["sizeM"][2]) < 1e-9, "Cylinder X/Z diameters must match")
            _vector(prop["translationM"], "prop translation")
            _quaternion(prop["rotationXyzw"], "prop quaternion")
            _material(prop["material"])
            _number(prop.get("bevelM", 0), "prop bevelM", minimum=0, maximum=min(prop["sizeM"])/2)
        if "lighting" in scene:
            lighting = scene["lighting"]
            _require(isinstance(lighting, dict), "Lighting must be an object")
            _number(lighting["ambientStrength"], "ambient strength", minimum=0, maximum=10)
            _require(isinstance(lighting["lights"], list) and len(lighting["lights"]) <= 8 and (lighting["lights"] or "hdri" in lighting), "Lighting must contain 1 to 8 lights or an HDRI")
            if "hdri" in lighting:
                hdri = lighting["hdri"]
                _require(isinstance(hdri, dict), "HDRI lighting must be an object")
                validate_hdri_asset(hdri.get("asset"))
                _require(isinstance(hdri.get("name"), str) and 0 < len(hdri["name"].strip()) <= 140, "HDRI name is required")
                _require(isinstance(hdri.get("sourceUrl", ""), str) and len(hdri.get("sourceUrl", "")) <= 2048, "HDRI source URL is invalid")
                _number(hdri.get("intensity"), "HDRI intensity", minimum=0, maximum=10)
                _number(hdri.get("rotationDeg"), "HDRI rotation", minimum=-180, maximum=180)
            light_ids = set()
            for light in lighting["lights"]:
                _require(isinstance(light["id"], str) and light["id"].strip() and light["id"] not in light_ids, "Light IDs must be nonempty and unique")
                light_ids.add(light["id"])
                _require(isinstance(light["name"], str) and light["name"].strip(), "Light name is required")
                _require(type(light["enabled"]) is bool, "Light enabled must be boolean")
                _vector(light["positionM"], "light position")
                _vector(light["targetM"], "light target")
                _require(sum((a-b)**2 for a,b in zip(light["positionM"], light["targetM"])) > 1e-10, "Light position must differ from its target")
                _number(light["powerW"], "light power", minimum=0, maximum=100000)
                _number(light["diameterM"], "light diameter", minimum=.001, maximum=1000)
                _vector(light["color"], "light color")
                _require(all(0 <= x <= 1 for x in light["color"]), "Light color must be in [0,1]")
        _require(scene["placement"]["restsOn"] == env["plinth"]["id"], "Unknown contact surface")
        _vector(scene["placement"]["translationM"], "product placement")
        _number(scene["placement"].get("scale", 1), "product scale", minimum=.01, maximum=100)
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
        _require(isinstance(scene["shots"], list), "Shots must be a list")
        _require(scene["shots"] or "durationFrames" in r, "An empty movie needs an explicit duration")
        if "durationFrames" in r:
            _require(type(r["durationFrames"]) is int and 1 <= r["durationFrames"] <= 9007199254740991,
                     "Movie duration must be a positive integer number of frames")
        next_frame, shot_ids = 1, set()
        for shot in scene["shots"]:
            _require(isinstance(shot["id"], str) and shot["id"].strip() and shot["id"] not in shot_ids, "Shot IDs must be nonempty strings and unique")
            shot_ids.add(shot["id"])
            _require(type(shot["startFrame"]) is int and type(shot["endFrame"]) is int, "Shot frames must be integers")
            _require(shot["startFrame"] >= next_frame and shot["endFrame"] >= shot["startFrame"],
                     "Shot ranges must be ordered, non-overlapping and start at frame 1 or later")
            _require(shot.get("kind", "scene") in ("scene", "image"), "Shot kind must be scene or image")
            if shot.get("kind") == "image":
                _require(isinstance(shot.get("image"), dict), "Image shot needs an image")
                validate_film_image_asset(shot["image"].get("asset"))
                _require(shot["image"].get("fit") in ("contain", "cover"), "Image fit must be contain or cover")
            else:
                _require("image" not in shot, "Scene shots cannot hide image content")
            next_frame = shot["endFrame"] + 1
            for pose in (shot["camera"]["from"], shot["camera"]["to"]):
                _vector(pose["positionM"], "camera position")
                _vector(pose["targetM"], "camera target")
                delta = [x-y for x,y in zip(pose["positionM"], pose["targetM"])]
                _require(sum(x*x for x in delta) > 1e-10 and delta[0]**2 + delta[2]**2 > 1e-10, "Camera must have a nonvertical viewing direction")
                _number(pose["focalLengthMm"], "focal length", minimum=1)
            if 'durationFrames' in shot['camera']:
                _require(type(shot['camera']['durationFrames']) is int and 1 <= shot['camera']['durationFrames'] <= 9007199254740991,
                         'Camera source duration must be a positive integer')
            _validate_depth_of_field(shot["camera"])
            # The interpolated viewing vector must remain valid throughout the move.
            start, end = shot["camera"]["from"], shot["camera"]["to"]
            d0 = [start["positionM"][i]-start["targetM"][i] for i in (0,2)]
            d1 = [end["positionM"][i]-end["targetM"][i] for i in (0,2)]
            dv = [y-x for x,y in zip(d0,d1)]
            denominator = sum(x*x for x in dv)
            u = max(0, min(1, -sum(x*y for x,y in zip(d0,dv))/denominator)) if denominator else 0
            _require(sum((x+u*y)**2 for x,y in zip(d0,dv)) > 1e-10, "Camera move crosses a vertical or zero viewing direction")
        total = film_duration(scene)
        _require(total >= next_frame - 1, "Movie duration must include every shot")
        for a in scene["actions"]:
            _require(a["startSeconds"] + a["durationSeconds"] <= (total-1)/r["fps"], "Action must finish within the reel")
        if "animation" in scene:
            _validate_animation(scene["animation"], ids, moving,
                                {action["relativeTo"] for action in scene["actions"]}, total)
        _validate_film_motions(scene, ids, moving, {action['relativeTo'] for action in scene['actions']})
        if "comparison" in scene:
            from .comparison import validate_comparison
            validate_comparison(scene)
        if "audio" in scene:
            validate_scene_audio(scene["audio"])
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


def _track_value(track, frame):
    """Outgoing interpolation belongs to the left key; endpoints hold."""
    keys = track["keys"]
    if frame <= keys[0]["frame"]:
        return keys[0]["value"]
    for before, after in zip(keys, keys[1:]):
        if frame < after["frame"]:
            if before["interpolation"] == "hold":
                return before["value"]
            u = (frame - before["frame"]) / (after["frame"] - before["frame"])
            if before["interpolation"] == "ease":
                u = _smooth(u)
            return before["value"] + (after["value"] - before["value"]) * u
    return keys[-1]["value"]


def _euler_xyz_degrees(q):
    # Match Three.js Euler.setFromQuaternion(..., 'XYZ'), including its
    # gimbal-lock convention, so an untouched channel keeps the UI's value.
    x, y, z, w = q
    m13 = 2 * (x*z + y*w)
    ry = math.asin(max(-1, min(1, m13)))
    if abs(m13) < .9999999:
        rx = math.atan2(2 * (x*w - y*z), 1 - 2 * (x*x + y*y))
        rz = math.atan2(2 * (z*w - x*y), 1 - 2 * (y*y + z*z))
    else:
        rx = math.atan2(2 * (y*z + x*w), 1 - 2 * (x*x + z*z))
        rz = 0
    return [math.degrees(angle) for angle in (rx, ry, rz)]


def _quaternion_from_xyz_degrees(angles):
    x, y, z = (math.radians(angle) / 2 for angle in angles)
    c1, c2, c3 = math.cos(x), math.cos(y), math.cos(z)
    s1, s2, s3 = math.sin(x), math.sin(y), math.sin(z)
    return [s1*c2*c3 + c1*s2*s3, c1*s2*c3 - s1*c2*s3,
            c1*c2*s3 + s1*s2*c3, c1*c2*c3 - s1*s2*s3]


def film_duration(scene):
    """Explicit movie length includes black time before, between and after clips."""
    return scene["render"].get("durationFrames", max((shot["endFrame"] for shot in scene["shots"]), default=1))


def evaluate(scene, frame):
    """Evaluate a validated scene without mutable playback or accumulated deltas.

    Uniform placement scale expands the assembly around the support origin;
    placement translation remains in world metres. Each component's optional
    assembly scale acts around its own origin, including local action pivots and
    travel. Neither scale rewrites source dimensions, geometry, or action values.
    Enabled tracks replace base placement/assembly values before local actions;
    a motion track replaces the action's timed progress. Legacy keys keep one reel
    clock. Bounded Film motions own selected channels; shot-local owners replace
    shared motions on those channels. Their untouched source survives trimming.
    """
    total = film_duration(scene)
    _require(type(frame) is int and 1 <= frame <= total, f"Frame must be in 1..{total}")
    t = (frame-1) / scene["render"]["fps"]
    selected = next((s for s in scene["shots"] if s["startFrame"] <= frame <= s["endFrame"]), None)
    # Black time remains evaluable by camera/geometry tools, but does not borrow
    # another shot's local motion or claim that shot is on screen.
    fallback = {"positionM": [0, .2, 1], "targetM": [0, .1, 0], "focalLengthMm": 50}
    camera_source = next((s["camera"] for s in reversed(scene["shots"]) if s["endFrame"] < frame),
                         scene["shots"][0]["camera"] if scene["shots"] else {"from": fallback, "to": fallback})
    shot = selected or {"startFrame": frame, "endFrame": frame, "camera": camera_source}
    components = {}
    animated = {}
    for track in scene.get("animation", {}).get("tracks", []):
        if track["enabled"]:
            animated.setdefault(track["componentId"], {})[track["property"]] = _track_value(track, frame)
    _film_values(scene, shot, frame, animated)
    # Product placement is relative to the top-center of its explicit support.
    # The baseline plinth top-center is [0,0,0], preserving original poses.
    plinth = scene["environment"]["plinth"]
    contact_origin = list(plinth["translationM"])
    contact_origin[1] += plinth["sizeM"][1] / 2
    product_values = animated.get("$product", {})
    placement = _add([product_values.get(f"position.{axis}", value)
                      for axis, value in zip("xyz", scene["placement"]["translationM"])], contact_origin)
    product_scale = product_values.get("scale", scene["placement"].get("scale", 1))
    product_rotation = (_quaternion_from_xyz_degrees([product_values.get(f'rotation.{axis}', 0) for axis in 'xyz'])
                        if any(f'rotation.{axis}' in product_values for axis in 'xyz') else None)
    for c in scene["product"]["components"]:
        pose = c["assembly"]
        values = animated.get(c["id"], {})
        position = [values.get(f"position.{axis}", value) for axis, value in zip("xyz", pose["translationM"])]
        rotation = list(pose["rotationXyzw"])
        if any(f"rotation.{axis}" in values for axis in "xyz"):
            rotation = _quaternion_from_xyz_degrees([
                values.get(f"rotation.{axis}", value)
                for axis, value in zip("xyz", _euler_xyz_degrees(rotation))
            ])
        components[c["id"]] = {
            "translationM": _add(_rotate(product_rotation, [x * product_scale for x in position]) if product_rotation else [x * product_scale for x in position], placement),
            "rotationXyzw": _mul(product_rotation, rotation) if product_rotation else rotation,
            "scale": product_scale * values.get("scale", pose.get("scale", 1)),
        }
    for a in scene["actions"]:
        pose = components[a["componentId"]]
        u = animated.get(a["componentId"], {}).get("motion", _smooth((t-a["startSeconds"])/a["durationSeconds"]))
        theta = 0 if a["type"] == "lift" else 2*math.pi*a["turns"]*a["directionSign"]*u
        distance = a["distanceM"]*u if a["type"] == "lift" else a["axialTravelPerRevolutionM"]*a["turns"]*u
        q = [*(x*math.sin(theta/2) for x in a["axis"]), math.cos(theta/2)]
        # Pivot and travel are in unscaled component-local metres. Uniform
        # component and product scales carry both into the posed world frame.
        rotated_pivot = _rotate(q, a["pivotM"])
        offset = [(p-r+x*distance) * pose["scale"] for p,r,x in zip(a["pivotM"],rotated_pivot,a["axis"])]
        pose["translationM"] = _add(pose["translationM"], _rotate(pose["rotationXyzw"],offset))
        pose["rotationXyzw"] = _mul(pose["rotationXyzw"],q)
    camera_duration = shot['camera'].get('durationFrames', shot['endFrame'] - shot['startFrame'] + 1)
    u = _smooth((frame-shot["startFrame"])/(camera_duration-1)) if camera_duration > 1 else 0.
    before, after = shot["camera"]["from"], shot["camera"]["to"]
    camera = {key: [x+(y-x)*u for x,y in zip(before[key],after[key])] for key in ("positionM","targetM")}
    camera["focalLengthMm"] = before["focalLengthMm"] + (after["focalLengthMm"]-before["focalLengthMm"])*u
    _film_camera(scene, shot, frame, camera)
    optics = shot["camera"].get("depthOfField", {})
    camera["depthOfField"] = {
        "enabled": optics.get("enabled", False),
        "fStop": optics.get("fStop", 2.8),
        "focusDistanceM": optics.get("focusDistanceM", math.dist(camera["positionM"], camera["targetM"])),
    }
    clip = {"kind": "black"} if selected is None else ({"kind": "image", **selected["image"]} if selected.get("kind") == "image" else {"kind": "scene"})
    return {"frame":frame,"timeSeconds":t,"shotId":selected["id"] if selected else None,
            "clip":clip,"components":components,"camera":camera}


def sample_scene(scene):
    validate_scene(scene)
    return {"scene":scene,"frames":[evaluate(scene,f) for f in range(1,film_duration(scene)+1)]}
