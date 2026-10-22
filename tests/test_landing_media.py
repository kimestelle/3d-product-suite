"""Check the shipped MP4s, including declarations phone decoders actually read."""

from fractions import Fraction
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
MEDIA = ROOT / "web/public/media"
SPEC = json.loads((ROOT / "web/src/assets/gesso/landing-reel.json").read_text())


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg media inspection is optional")
class LandingMediaTests(unittest.TestCase):
    def test_shipped_reels_have_phone_compatible_codec_clock_and_fast_start(self):
        for filename, spec in (("gesso-landing-reel.mp4", SPEC), ("gesso-landing-reel-mobile.mp4", SPEC["mobile"])):
            with self.subTest(filename=filename):
                path = MEDIA / filename
                probe = json.loads(subprocess.check_output([
                    "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path),
                ], timeout=15))
                self.assertEqual(len(probe["streams"]), 1, "Autoplay reels must not contain an audio track")
                video = probe["streams"][0]
                self.assertEqual(video["codec_name"], "h264")
                self.assertEqual(video["pix_fmt"], "yuv420p")
                self.assertEqual((video["width"], video["height"]), (spec["width"], spec["height"]))
                self.assertEqual(video["level"], round(float(spec["level"]) * 10))
                self.assertIn(spec["profile"].lower(), video["profile"].lower())
                self.assertEqual(Fraction(video["avg_frame_rate"]), SPEC["fps"])
                frames = sum(shot["frameCount"] for shot in SPEC["shots"])
                self.assertEqual(int(video["nb_frames"]), frames)
                self.assertAlmostEqual(float(probe["format"]["duration"]), frames / SPEC["fps"], places=3)

                # Container fps alone misses the old SPS's 1,000,000 fps clock.
                headers = subprocess.run([
                    "ffmpeg", "-hide_banner", "-loglevel", "verbose", "-i", str(path),
                    "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "trace_headers",
                    "-frames:v", "1", "-f", "null", "-",
                ], capture_output=True, text=True, check=True, timeout=15).stderr
                tick = re.search(r"\bnum_units_in_tick\b[^\n]*=\s*(\d+)", headers)
                scale = re.search(r"\btime_scale\b[^\n]*=\s*(\d+)", headers)
                self.assertIsNotNone(tick)
                self.assertIsNotNone(scale)
                self.assertEqual(Fraction(int(scale[1]), 2 * int(tick[1])), SPEC["fps"])

                atoms = {}
                with path.open("rb") as handle:
                    while header := handle.read(8):
                        size, kind = struct.unpack(">I4s", header)
                        self.assertGreaterEqual(size, 8)
                        atoms[kind] = handle.tell() - 8
                        handle.seek(size - 8, 1)
                self.assertLess(atoms[b"moov"], atoms[b"mdat"], "Phones should not download the full file before playback")

    def test_mobile_transfer_is_less_than_half_the_desktop_reel(self):
        self.assertLess((MEDIA / "gesso-landing-reel-mobile.mp4").stat().st_size,
                        (MEDIA / "gesso-landing-reel.mp4").stat().st_size / 2)
