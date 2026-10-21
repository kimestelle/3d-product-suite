"""Turn a World Labs collider GLB (vertex-coloured, unlit) into an importable Gesso mesh world.

The provider collider ships with per-vertex colours and normals but no material.
Attach one KHR_materials_unlit vertex-colour material so the browser and Cycles
show the baked colours directly, then import it with the same metric alignment
as the world's splat (OpenCV->OpenGL flip, scale, ground offset).
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from film import worlds  # noqa: E402
from scripts.prep_demo_glb import read_glb, write_glb  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("world_set", type=Path, help="world-set.json from worldlabs_generate.py")
    parser.add_argument("--library", type=Path, default=ROOT / "workspace-data")
    parser.add_argument("--owner", default="Ximing Luo")
    args = parser.parse_args()
    summary = json.loads(args.world_set.read_text())
    source = Path(summary["files"]["collider"])
    document, binary = read_glb(source.read_bytes())
    document.setdefault("extensionsUsed", [])
    if "KHR_materials_unlit" not in document["extensionsUsed"]:
        document["extensionsUsed"].append("KHR_materials_unlit")
    document["materials"] = [{"name": "World / baked vertex colour", "doubleSided": True,
                              "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0, "roughnessFactor": 1},
                              "extensions": {"KHR_materials_unlit": {}}}]
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            primitive["material"] = 0
    document["asset"] = dict(document.get("asset", {}), generator="gesso collider_world")
    output = source.with_name("world-mesh.glb")
    output.write_bytes(write_glb(document, binary))
    provenance = {"source": "World Labs generated world " + summary["worldId"] + " (provider collider geometry with baked vertex colours)",
                  "owner": args.owner, "reuseBasis": "Generated on the user's own World Labs API account for the Gesso demo",
                  "allowedExternalDestinations": [], "provider": "worldlabs", "providerWorldId": summary["worldId"],
                  "representation": "collider-vertex-colour-glb", "axisConvention": "marble_raw_opencv",
                  "alignmentBasis": "World Labs SPZ metric semantics, ground offset, then OpenCV-to-OpenGL rotation (shared with the splat)",
                  "alignmentReview": "Unreviewed initial alignment from provider metadata.", "panoFile": summary["files"].get("pano", "")}
    worlds.validate_provenance(provenance)
    entry = worlds.import_world(output, args.library, name=summary["name"] + " · Mesh", provenance=provenance, source_up="Y",
                                scale_to_meters=summary["scale"], rotation_xyzw=[1, 0, 0, 0], translation_m=[0, summary["ground"], 0])
    summary["meshWorldId"] = entry["id"]
    summary["files"]["mesh"] = str(output)
    args.world_set.write_text(json.dumps(summary, indent=2))
    print(entry["id"], entry["name"], output.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
