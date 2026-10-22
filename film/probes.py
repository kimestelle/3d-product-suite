"""Controlled authored/mesh/Gaussian comparison documents, with no provider calls."""

import copy
from pathlib import Path

from .jobs import _atomic_json
from .scene import film_duration, load_scene, scene_digest, validate_scene
from .worlds import bundle_assets, list_worlds


def make_probe(scene, name):
    result = copy.deepcopy(scene)
    result["sceneId"] = f"{scene['sceneId']}-{name}"
    if name == "contact":
        for shot in result["shots"]:
            shot["camera"]["to"] = copy.deepcopy(shot["camera"]["from"])
    elif name == "lateral":
        camera = result["shots"][0]["camera"]
        camera["from"]["positionM"][0] = -0.08
        camera["to"]["positionM"][0] = 0.08
    elif name == "occlusion":
        props = result["environment"].setdefault("props", [])
        ids = {x["id"] for x in props} | {x["id"] for x in result["product"]["components"]} | {result["environment"]["plinth"]["id"]}
        occluder_id, suffix = "foreground-probe", 1
        while occluder_id in ids:
            suffix += 1
            occluder_id = f"foreground-probe-{suffix}"
        props.append({"id": occluder_id, "shape": "box", "sizeM": [0.022, 0.09, 0.018],
                "translationM": [0.025, 0.045, 0.068], "rotationXyzw": [0, 0, 0, 1], "bevelM": 0.001,
                "material": {"baseColor": [0.28, 0.25, 0.20, 1], "roughness": 0.6, "metallic": 0}})
    elif name == "glossy":
        for component in result["product"]["components"]:
            if component["id"] == "cap":
                component["material"].update(metallic=1, roughness=0.06)
        result["product"]["revisionId"] += "-gloss-probe"
    elif name == "glass":
        for component in result["product"]["components"]:
            if component["id"] in ("bottle-body", "neck"):
                component["material"].update(baseColor=[0.96, 0.99, 0.97, 1], roughness=0.07, transmission=1, ior=1.47)
        result["product"]["revisionId"] += "-glass-probe"
    else:
        raise ValueError("Unknown comparison probe")
    validate_scene(result)
    return result


def create_comparison(scene_path, library_root, output_dir, *, mesh_id, splat_id, world_id=None):
    source = load_scene(scene_path)
    entries = {entry["id"]: entry for entry in list_worlds(library_root)}
    if mesh_id not in entries or splat_id not in entries:
        raise ValueError("Unknown world revision; import both exports before comparing")
    mesh, splat = entries[mesh_id], entries[splat_id]
    reconstructed = (splat["environment"]["kind"] == "mesh" and
                     splat["environment"]["provenance"].get("representation") == "gaussian-reconstructed-mesh")
    if mesh["environment"]["kind"] != "mesh" or (splat["environment"]["kind"] != "splat" and not reconstructed):
        raise ValueError("Choose one visual mesh and one Gaussian splat")
    output = Path(output_dir).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError("Comparison output must be a new or empty directory")
    output.mkdir(parents=True, exist_ok=True)
    fixture_flags = {"mesh": bool(mesh["environment"].get("fixture")), "splat": bool(splat["environment"].get("fixture"))}
    fixtures = any(fixture_flags.values())
    manifest = {"schemaVersion": 1, "sourceDigest": scene_digest(source),
                "pairing": {"worldId": world_id, "basis": "User-selected pair; inspect provider world ID or export provenance",
                            "syntheticFixtures": fixtures, "fixtureConditions": fixture_flags}, "conditions": {"mesh": mesh_id, "splat": splat_id},
                "qualityGate": "unreviewed", "results": []}
    gaussian_condition = "gaussianMesh" if reconstructed else "splat"
    manifest["conditions"] = {"mesh": mesh_id, gaussian_condition: splat_id}
    manifest["gaussianFinalRepresentation"] = "mesh" if reconstructed else "native-splat-diagnostic"
    for probe_name in ("contact", "lateral", "occlusion", "glossy", "glass"):
        base = make_probe(source, probe_name)
        for condition in ("authored", "mesh", gaussian_condition):
            scene = copy.deepcopy(base)
            if condition != "authored":
                replacement = copy.deepcopy(entries[mesh_id if condition == "mesh" else splat_id]["environment"])
                replacement["plinth"] = copy.deepcopy(base["environment"]["plinth"])
                if "floorY" in base["environment"]:
                    replacement["floorY"] = base["environment"]["floorY"]
                if "props" in base["environment"]:
                    replacement["props"] = copy.deepcopy(base["environment"]["props"])
                scene["environment"] = replacement
            elif scene["environment"]["kind"] != "authored":
                # An explicit authored baseline always keeps the same near field.
                scene["environment"] = {k: copy.deepcopy(v) for k, v in source["environment"].items() if k not in ("asset", "fixture")}
                scene["environment"].update(kind="authored", revisionId="authored-comparison-baseline")
                if "props" in base["environment"]:
                    scene["environment"]["props"] = copy.deepcopy(base["environment"]["props"])
            scene["sceneId"] += f"-{condition}"
            validate_scene(scene)
            bundle_assets(scene, library_root, output)
            filename = f"{probe_name}-{condition}.scene.json"
            _atomic_json(output / filename, scene)
            manifest["results"].append({"probe": probe_name, "condition": condition, "scene": filename,
                    "sceneDigest": scene_digest(scene), "productDigest": scene_digest(scene["product"]),
                    "cameraDigest": scene_digest(scene["shots"]), "actionDigest": scene_digest(scene["actions"]),
                    "reviewFrames": sorted({min(frame, film_duration(scene)) for frame in
                                            ([1, 60, 120] if probe_name == "lateral" else [180 if probe_name == "glass" else 1])}),
                    "review": None, "handsOnMinutes": None, "waitingMinutes": None, "cost": None})
    _atomic_json(output / "comparison.json", manifest)
    return manifest
