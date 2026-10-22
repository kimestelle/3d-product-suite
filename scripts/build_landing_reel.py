"""Cut the supplied Gesso motion renders using the homepage's timing manifest.

python scripts/build_landing_reel.py --source-dir <handoff>/media/03-renders/loops --ffmpeg <ffmpeg>
python scripts/build_landing_reel.py --from-existing --ffmpeg <ffmpeg>
The original renders remain untouched; CSS mirrors their website presentation.
"""

import argparse
import json
import subprocess
from pathlib import Path
import tempfile


def compatible_desktop(ffmpeg, output, spec):
    """Correct AVC declarations without re-encoding the existing picture data.

    The 720p/30 desktop cut fits level 3.1. Its previous level 6.2 declaration
    unnecessarily excludes phone decoders even though they can play this stream.
    Also align VUI timing with the actual constant-rate MP4 timestamps.
    """
    with tempfile.TemporaryDirectory(dir=output.parent) as directory:
        normalized = Path(directory) / output.name
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(output),
                        "-map", "0:v:0", "-c:v", "copy", "-an",
                        "-bsf:v", f"h264_metadata=level={spec['level']}:tick_rate={2 * spec['fps']}/1",
                        "-movflags", "+faststart", str(normalized)], check=True)
        normalized.replace(output)


def mobile_reel(ffmpeg, source, output, spec):
    mobile = spec["mobile"]
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                    "-map", "0:v:0", "-vf", f"scale={mobile['width']}:{mobile['height']}:flags=lanczos,setsar=1",
                    "-an", "-c:v", "libx264", "-preset", "slow", "-crf", str(mobile["crf"]),
                    "-r", str(spec["fps"]), "-fps_mode", "cfr",
                    "-profile:v", mobile["profile"], "-level:v", mobile["level"],
                    "-maxrate", f"{mobile['maxRateKbps']}k", "-bufsize", f"{mobile['bufferKbits']}k",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--source-dir", type=Path)
    source.add_argument("--from-existing", action="store_true", help="Correct the checked-in desktop codec level and rebuild its mobile copy")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    assets = root / "web/src/assets/gesso"
    spec = json.loads((assets / "landing-reel.json").read_text())
    output = root / "web/public/media/gesso-landing-reel.mp4"
    mobile_output = output.with_name("gesso-landing-reel-mobile.mp4")
    if args.from_existing:
        if not output.is_file():
            parser.error("The existing desktop reel is missing; use --source-dir")
        compatible_desktop(args.ffmpeg, output, spec)
        mobile_reel(args.ffmpeg, output, mobile_output, spec)
        print(f"{mobile_output}: {mobile_output.stat().st_size} bytes")
        return
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
                    "-r", str(spec["fps"]), "-fps_mode", "cfr",
                    "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
                    "-profile:v", spec["profile"], "-level:v", spec["level"],
                    "-movflags", "+faststart", str(output)], check=True)
    mobile_reel(args.ffmpeg, output, mobile_output, spec)
    subprocess.run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(output),
                    "-frames:v", "1", "-c:v", "libwebp", "-quality", "92",
                    str(assets / "landing-showcase-poster.webp")], check=True)
    print(f"{output}: {sum(shot['frameCount'] for shot in spec['shots'])} frames, {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
