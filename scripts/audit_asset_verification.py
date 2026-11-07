#!/usr/bin/env python3
"""Measure repeated verification of an existing project's actual immutable assets."""
import argparse
import json
from pathlib import Path
import statistics
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from film.store import ProjectStore
from film.worlds import verify_scene_assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.data_dir.is_dir() or not 3 <= args.iterations <= 20:
        parser.error("Use an existing workspace and 3–20 iterations.")
    project = ProjectStore(args.data_dir).get(args.project)
    elapsed = []
    for _ in range(args.iterations):
        start = time.perf_counter()
        records = verify_scene_assets(project["scene"], args.data_dir)
        elapsed.append((time.perf_counter() - start) * 1000)
    result = {"schemaVersion": 1, "projectId": project["id"], "revisionId": project["revisionId"],
              "assetCount": len(records), "assetBytes": sum(record["bytes"] for record in records),
              "warmVerificationMs": elapsed, "medianMs": statistics.median(elapsed),
              "scope": "Repeated file reads, hashes and scene validation; no render or network timing."}
    output = json.dumps(result, indent=2, allow_nan=False) + "\n"
    if args.output:
        args.output.write_text(output)
    print(output, end="")


if __name__ == "__main__":
    main()
