"""Soundtrack validation, byte sniffing, ffprobe measurement, bundling and the import endpoint."""
import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import wave

from film import audio
from film.scene import evaluate, scene_digest, validate_scene
from film.worlds import bundle_assets
from tests import test_editor_api
from tests.test_scene import EXAMPLE

FFPROBE = audio.ffprobe_command("/opt/homebrew/opt/ffmpeg@7/bin/ffmpeg")
HAVE_FFPROBE = Path(FFPROBE).is_file() or shutil.which(FFPROBE) is not None


def wav_bytes(seconds=0.5, rate=8000):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\0\0" * int(seconds * rate))
    return buffer.getvalue()


def audio_record(payload, format_="wav", **overrides):
    digest = hashlib.sha256(payload).hexdigest()
    record = {"asset": {"path": f"assets/{digest}.{format_}", "sha256": digest, "format": format_},
              "offsetS": 0, "gain": 1, "durationS": 0.5}
    record.update(overrides)
    return record


class SceneAudioTests(unittest.TestCase):
    def setUp(self):
        self.scene = json.loads(EXAMPLE.read_text())
        self.payload = wav_bytes()

    def test_audio_validates_without_changing_the_document_or_evaluation(self):
        silent = copy.deepcopy(self.scene)
        self.scene["audio"] = audio_record(self.payload, bpm=120, offsetS=-1.5, gain=0.8)
        before = copy.deepcopy(self.scene)
        self.assertIs(validate_scene(self.scene), self.scene)
        self.assertEqual(self.scene, before)
        self.assertEqual(scene_digest(self.scene), scene_digest(before))
        self.assertNotEqual(scene_digest(self.scene), scene_digest(silent))
        self.assertEqual(evaluate(self.scene, 7), evaluate(silent, 7))
        del self.scene["audio"]["bpm"]
        validate_scene(self.scene)

    def test_invalid_audio_is_rejected(self):
        cases = {"bpm low": {"bpm": 29}, "bpm high": {"bpm": 301}, "bpm bool": {"bpm": True}, "gain high": {"gain": 4.5},
                 "gain negative": {"gain": -0.1}, "offset high": {"offsetS": 601}, "offset low": {"offsetS": -600.5},
                 "duration zero": {"durationS": 0}, "duration text": {"durationS": "10"}, "offset nan": {"offsetS": float("nan")}}
        for name, patch_ in cases.items():
            with self.subTest(name):
                self.scene["audio"] = audio_record(self.payload, **patch_)
                with self.assertRaises(ValueError):
                    validate_scene(self.scene)
        digest = hashlib.sha256(self.payload).hexdigest()
        for name, asset in {"path": {"path": "assets/other.wav", "sha256": digest, "format": "wav"},
                            "format": {"path": f"assets/{digest}.ogg", "sha256": digest, "format": "ogg"},
                            "digest": {"path": "assets/abc.wav", "sha256": "abc", "format": "wav"},
                            "missing": None}.items():
            with self.subTest(name):
                self.scene["audio"] = audio_record(self.payload)
                self.scene["audio"]["asset"] = asset
                with self.assertRaises(ValueError):
                    validate_scene(self.scene)
        self.scene["audio"] = "song.mp3"
        with self.assertRaises(ValueError):
            validate_scene(self.scene)

    def test_formats_are_recognized_from_their_leading_bytes(self):
        self.assertEqual(audio.sniff_audio_format(self.payload), "wav")
        self.assertEqual(audio.sniff_audio_format(b"ID3\x04\x00" + b"\0" * 20), "mp3")
        self.assertEqual(audio.sniff_audio_format(b"\xff\xfb\x90\x00" + b"\0" * 20), "mp3")
        self.assertEqual(audio.sniff_audio_format(b"\x00\x00\x00\x20ftypM4A " + b"\0" * 20), "m4a")
        self.assertIsNone(audio.sniff_audio_format(b"RIFF\0\0\0\0AVI " + b"\0" * 20))
        self.assertIsNone(audio.sniff_audio_format(b"OggS" + b"\0" * 20))
        self.assertIsNone(audio.sniff_audio_format(b""))

    def test_ffprobe_is_derived_from_the_configured_ffmpeg(self):
        with tempfile.TemporaryDirectory() as directory:
            ffmpeg = Path(directory) / "ffmpeg"
            ffmpeg.write_text("")
            self.assertEqual(audio.ffprobe_command(ffmpeg), shutil.which("ffprobe") or "ffprobe")
            (Path(directory) / "ffprobe").write_text("")
            self.assertEqual(audio.ffprobe_command(ffmpeg), str(Path(directory) / "ffprobe"))
        self.assertEqual(audio.ffprobe_command("ffmpeg"), shutil.which("ffprobe") or "ffprobe")

    @unittest.skipUnless(HAVE_FFPROBE, "ffprobe is not installed")
    def test_real_ffprobe_measures_duration_and_import_stores_the_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "click.wav"
            source.write_bytes(wav_bytes(1.25))
            self.assertAlmostEqual(audio.measure_duration(source, FFPROBE), 1.25, places=2)
            result = audio.import_audio(source.read_bytes(), "click.wav", directory, ffprobe=FFPROBE)
            self.assertAlmostEqual(result["durationS"], 1.25, places=2)
            self.assertEqual((Path(directory) / result["asset"]["path"]).read_bytes(), source.read_bytes())
            self.assertEqual(result["asset"]["format"], "wav")
            self.assertEqual([path.name for path in (Path(directory) / "assets").iterdir()], [Path(result["asset"]["path"]).name])
            with self.assertRaisesRegex(ValueError, "no audio stream"):
                audio.import_audio(b"\xff\xfb" + b"\0" * 64, "noise.mp3", directory, ffprobe=FFPROBE)
            self.assertEqual(len(list((Path(directory) / "assets").iterdir())), 1)

    def test_import_rejects_unknown_extensions_and_unrecognized_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "MP3, WAV or M4A"):
                audio.import_audio(self.payload, "song.ogg", directory)
            with self.assertRaisesRegex(ValueError, "could not be recognized"):
                audio.import_audio(b"OggS" + b"\0" * 64, "song.wav", directory)
            with self.assertRaisesRegex(ValueError, "64 MiB"):
                audio.import_audio(b"", "song.wav", directory)
            self.assertFalse((Path(directory) / "assets").exists() and any((Path(directory) / "assets").iterdir()))

    def test_bundle_copies_the_soundtrack_and_rejects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root, destination = Path(directory) / "source", Path(directory) / "job"
            self.scene["audio"] = audio_record(self.payload)
            (root / "assets").mkdir(parents=True)
            (root / self.scene["audio"]["asset"]["path"]).write_bytes(self.payload)
            records = bundle_assets(self.scene, root, destination)
            self.assertIn({"path": self.scene["audio"]["asset"]["path"], "sha256": self.scene["audio"]["asset"]["sha256"],
                           "format": "wav", "bytes": len(self.payload)}, records)
            self.assertEqual((destination / self.scene["audio"]["asset"]["path"]).read_bytes(), self.payload)
            (root / self.scene["audio"]["asset"]["path"]).write_bytes(self.payload + b"\0")
            with self.assertRaisesRegex(ValueError, "hash does not match"):
                bundle_assets(self.scene, root, Path(directory) / "job2")
            self.scene["audio"]["asset"]["format"] = "mp3"
            self.scene["audio"]["asset"]["path"] = self.scene["audio"]["asset"]["path"][:-3] + "mp3"
            with self.assertRaises(ValueError):
                bundle_assets(self.scene, root, Path(directory) / "job3")


class AudioApiTests(unittest.TestCase):
    # Reuse only the real HTTP harness, not its unrelated test cases.
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_import_stream_and_save_soundtrack(self):
        project = self.bootstrap()["project"]
        payload = wav_bytes()
        with patch.object(audio, "measure_duration", return_value=10.0) as measure:
            status, result, _ = self.request("POST", "/api/audio/import", raw=payload,
                                             headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": "click.wav"})
        self.assertEqual(status, 201, result)
        self.assertEqual(measure.call_args.args[1], audio.ffprobe_command(self.app.renders.ffmpeg))
        self.assertEqual(result["durationS"], 10.0)
        asset = result["asset"]
        self.assertEqual(asset, {"path": f"assets/{hashlib.sha256(payload).hexdigest()}.wav",
                                 "sha256": hashlib.sha256(payload).hexdigest(), "format": "wav"})
        status, downloaded, headers = self.request("GET", "/api/assets/" + Path(asset["path"]).name)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(downloaded, payload)
        scene = copy.deepcopy(project["scene"])
        scene["audio"] = {"asset": asset, "offsetS": 0.25, "gain": 1.2, "bpm": 120, "durationS": 10.0}
        route = f"/api/projects/{project['id']}"
        status, saved, _ = self.request("PUT", route, {"scene": scene, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200, saved)
        status, opened, _ = self.request("GET", route)
        self.assertEqual(status, 200)
        self.assertEqual(opened["scene"]["audio"], scene["audio"])
        scene["audio"]["bpm"] = 500
        status, rejected, _ = self.request("PUT", route, {"scene": scene, "expectedRevisionId": saved["revisionId"]})
        self.assertEqual(status, 400, rejected)

    def test_unrecognized_upload_creates_no_asset(self):
        status, response, _ = self.request("POST", "/api/audio/import", raw=b"OggS" + b"\0" * 64,
                                           headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": "song.wav"})
        self.assertEqual(status, 400, response)
        status, response, _ = self.request("POST", "/api/audio/import", raw=wav_bytes(),
                                           headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": "song.ogg"})
        self.assertEqual(status, 400, response)
        assets = self.app.store.root / "assets"
        self.assertFalse(assets.exists() and any(path.suffix in (".wav", ".mp3", ".m4a") for path in assets.iterdir()))
        status, response, _ = self.request("POST", "/api/audio/import", raw=wav_bytes(),
                                           headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": "song.wav"}, mutate=False)
        self.assertEqual(status, 403, response)


if __name__ == "__main__":
    unittest.main()
