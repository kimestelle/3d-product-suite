"""Small local CLI; no uploads, provider calls, or paid generations."""

import argparse
import json
from pathlib import Path
import sys

from .scene import load_scene, sample_scene, scene_digest


def main(argv=None):
    parser = argparse.ArgumentParser(description="Deterministic product-film prototype")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("init", help="Copy the fictional bottle fixture to a new scene")
    p.add_argument("path", type=Path)
    for command in ("validate", "sample", "render", "still"):
        p = sub.add_parser(command)
        p.add_argument("scene", type=Path)
        if command == "sample":
            p.add_argument("--output", type=Path, required=True)
        if command in ("render", "still"):
            p.add_argument("--output", type=Path, required=True)
            p.add_argument("--width", type=int)
            p.add_argument("--height", type=int)
            p.add_argument("--samples", type=int)
            p.add_argument("--blender", default="blender")
            p.add_argument("--ffmpeg", default="ffmpeg")
            if command == "still":
                p.add_argument("--frame", type=int, default=1)
    for command in ("resume", "cancel", "status"):
        p = sub.add_parser(command)
        p.add_argument("output", type=Path)
        if command == "resume":
            p.add_argument("--blender", default="blender")
            p.add_argument("--ffmpeg", default="ffmpeg")
    p = sub.add_parser("serve", help="Run the local browser editor and render queue")
    p.add_argument("--data-dir", type=Path, default=Path("workspace-data"))
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--blender", default="blender")
    p.add_argument("--ffmpeg", default="ffmpeg")
    p = sub.add_parser("world-import", help="Import a self-contained visual GLB or Gaussian SPZ/PLY")
    p.add_argument("asset", type=Path)
    p.add_argument("--library", type=Path, default=Path("workspace-data"))
    p.add_argument("--name", required=True)
    p.add_argument("--owner", required=True)
    p.add_argument("--reuse-basis", required=True)
    p.add_argument("--source-up", choices=("Y", "Z"), default="Y")
    p.add_argument("--scale-to-meters", type=float, default=1)
    p = sub.add_parser("worlds", help="List imported world revisions")
    p.add_argument("--library", type=Path, default=Path("workspace-data"))
    p = sub.add_parser("product-import", help="Prepare a centered, meter-scale, self-contained static product GLB")
    p.add_argument("asset", type=Path)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--owner", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--reuse-basis", required=True)
    p.add_argument("--workspace", type=Path, help="Also open the prepared scene as a local editor project")
    p = sub.add_parser("compare", help="Create the five-probe authored/mesh/Gaussian comparison")
    p.add_argument("scene", type=Path)
    p.add_argument("--library", type=Path, default=Path("workspace-data"))
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--mesh-id", required=True)
    p.add_argument("--splat-id", required=True)
    p.add_argument("--world-id")
    args = parser.parse_args(argv)
    try:
        if args.command == "serve":
            from .server import serve
            serve(args.data_dir, port=args.port, blender=args.blender, ffmpeg=args.ffmpeg)
        elif args.command == "world-import":
            from .worlds import import_world
            provenance = {"source": str(args.asset.name), "owner": args.owner, "reuseBasis": args.reuse_basis,
                          "allowedExternalDestinations": []}
            print(json.dumps(import_world(args.asset, args.library, name=args.name, provenance=provenance,
                                          source_up=args.source_up, scale_to_meters=args.scale_to_meters), indent=2))
        elif args.command == "worlds":
            from .worlds import list_worlds
            print(json.dumps(list_worlds(args.library), indent=2))
        elif args.command == "product-import":
            from .products import create_product_scene
            provenance = {"source": args.source, "owner": args.owner, "reuseBasis": args.reuse_basis,
                          "allowedExternalDestinations": []}
            scene = create_product_scene(args.asset, args.output, name=args.name, provenance=provenance)
            result = {"scene": str(args.output / "scene.json"), "sceneDigest": scene_digest(scene)}
            if args.workspace:
                from .store import ProjectStore
                project = ProjectStore(args.workspace).create(args.name, scene, source_dir=args.output)
                result["project"] = {key: project[key] for key in ("id", "name", "revisionId")}
            print(json.dumps(result, indent=2))
        elif args.command == "compare":
            from .probes import create_comparison
            manifest = create_comparison(args.scene, args.library, args.output, mesh_id=args.mesh_id,
                                         splat_id=args.splat_id, world_id=args.world_id)
            print(f"Created {len(manifest['results'])} comparison scenes in {args.output}")
        elif args.command == "init":
            fixture = Path(__file__).resolve().parents[1] / "examples" / "bottle.scene.json"
            args.path.parent.mkdir(parents=True, exist_ok=True)
            with args.path.open("x") as output:
                output.write(fixture.read_text())
            print(f"Created {args.path}")
        elif args.command == "validate":
            scene = load_scene(args.scene)
            print(f"Valid: {scene['sceneId']}; {scene['shots'][-1]['endFrame']} frames; SHA256 {scene_digest(scene)}")
        elif args.command == "sample":
            scene = load_scene(args.scene)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x") as output:
                json.dump(sample_scene(scene), output, indent=2, allow_nan=False)
                output.write("\n")
            print(f"Wrote {args.output}")
        else:
            from .jobs import cancel_job, create_job, run_job
            from .stills import create_still_job, run_still_job
            if args.command == "still":
                create_still_job(args.scene, args.output, frame=args.frame, width=args.width or 540,
                                 height=args.height or 960, samples=args.samples or 32)
                print(json.dumps(run_still_job(args.output, blender=args.blender, ffmpeg=args.ffmpeg), indent=2))
            elif args.command == "render":
                create_job(args.scene, args.output, width=args.width, height=args.height, samples=args.samples)
                job = run_job(args.output, blender=args.blender, ffmpeg=args.ffmpeg)
                print(json.dumps(job, indent=2))
            elif args.command == "resume":
                saved = json.loads((args.output / "job.json").read_text())
                runner = run_still_job if saved.get("kind") == "still" else run_job
                print(json.dumps(runner(args.output, blender=args.blender, ffmpeg=args.ffmpeg), indent=2))
            elif args.command == "cancel":
                cancel_job(args.output)
                print(f"Cancellation requested for {args.output}")
            else:
                print((args.output / "job.json").read_text())
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Interrupted. Resume the same output directory to recover completed frames.", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
