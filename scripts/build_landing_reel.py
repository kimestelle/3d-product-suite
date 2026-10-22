"""Cut the supplied Gesso motion renders using the homepage's timing manifest.

python scripts/build_landing_reel.py --source-dir <handoff>/media/03-renders/loops --ffmpeg <ffmpeg>
The original renders remain untouched; CSS mirrors their website presentation.
"""

import argparse
import json
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    assets = root / "web/src/assets/gesso"
    spec = json.loads((assets / "landing-reel.json").read_text())
    output = root / "web/public/media/gesso-landing-reel.mp4"
    inputs, filters, names = [], [], []
    for index, shot in enumerate(spec["shots"]):
        source = args.source_dir / f"{shot['slug']}.mp4"
        if not source.is_file():
            raise SystemExit(f"Missing render: {source}")
        inputs += ["-i", str(source)]
        start = shot["sourceInFrame"]
        end = start + shot["frameCount"]
        filters.append(
            f"[{index}:v]fps={spec['fps']},trim=start_frame={start}:end_frame={end},"
            f"setpts=PTS-STARTPTS,scale={spec['width']}:{spec['height']},setsar=1[v{index}]"
        )
        names.append(f"[v{index}]")
    filters.append(f"{''.join(names)}concat=n={len(names)}:v=1:a=0[out]")
    subprocess.run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *inputs,
                    "-filter_complex", ";".join(filters), "-map", "[out]", "-an",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(output)], check=True)
    subprocess.run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(output),
                    "-frames:v", "1", "-c:v", "libwebp", "-quality", "92",
                    str(assets / "landing-showcase-poster.webp")], check=True)
    print(f"{output}: {sum(shot['frameCount'] for shot in spec['shots'])} frames, {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
