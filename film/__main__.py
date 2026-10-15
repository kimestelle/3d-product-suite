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
    for command in ("validate", "sample", "render"):
        p = sub.add_parser(command)
        p.add_argument("scene", type=Path)
        if command == "sample":
            p.add_argument("--output", type=Path, required=True)
        if command == "render":
            p.add_argument("--output", type=Path, required=True)
            p.add_argument("--width", type=int)
            p.add_argument("--height", type=int)
            p.add_argument("--samples", type=int)
            p.add_argument("--blender", default="blender")
            p.add_argument("--ffmpeg", default="ffmpeg")
    for command in ("resume", "cancel", "status"):
        p = sub.add_parser(command)
        p.add_argument("output", type=Path)
        if command == "resume":
            p.add_argument("--blender", default="blender")
            p.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
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
            if args.command == "render":
                create_job(args.scene, args.output, width=args.width, height=args.height, samples=args.samples)
                job = run_job(args.output, blender=args.blender, ffmpeg=args.ffmpeg)
                print(json.dumps(job, indent=2))
            elif args.command == "resume":
                print(json.dumps(run_job(args.output, blender=args.blender, ffmpeg=args.ffmpeg), indent=2))
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
