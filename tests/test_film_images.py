"""Real image decoding, editorial gaps, immutable bundles and flat exports."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from film import jobs
from film.film_images import import_film_image, render_clip, validate_film_image_asset, verify_film_image
from film.scene import evaluate, film_duration, sample_scene, validate_scene
from film.worlds import bundle_assets
from tests.test_scene import EXAMPLE
from tests import test_editor_api


def image_bytes(format_="PNG", size=(8, 4), color=(210, 60, 20, 255), **kwargs):
    image = Image.new("RGBA", size, color)
    if format_ == "JPEG":
        image = image.convert("RGB")
    payload = io.BytesIO()
    image.save(payload, format=format_, **kwargs)
    return payload.getvalue()


class FilmImageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.scene = json.loads(EXAMPLE.read_text())
        self.scene["actions"] = []
        self.scene["shots"] = [copy.deepcopy(self.scene["shots"][0])]
        self.scene["shots"][0].update(startFrame=3, endFrame=5)
        self.scene["render"].update(width=8, height=8, samples=1, durationFrames=8)

    def image_shot(self, fit="contain"):
        asset = import_film_image(image_bytes(), "photo.png", self.root)
        self.scene["shots"][0].update(kind="image", image={"asset": asset, "fit": fit})
        return asset

    def test_duration_includes_leading_internal_and_trailing_gaps(self):
        other = copy.deepcopy(self.scene["shots"][0])
        other.update(id="second", startFrame=7, endFrame=7)
        self.scene["shots"].append(other)
        sampled = sample_scene(self.scene)["frames"]
        self.assertEqual(film_duration(self.scene), 8)
        self.assertEqual([sample["clip"]["kind"] for sample in sampled],
                         ["black", "black", "scene", "scene", "scene", "black", "scene", "black"])
        self.assertEqual([sample["shotId"] for sample in sampled if sample["clip"]["kind"] == "black"], [None] * 4)
        for sample in sampled:
            self.assertEqual(len(sample["camera"]["positionM"]), 3)
            self.assertEqual(set(sample["components"]), {part["id"] for part in self.scene["product"]["components"]})
        self.scene["render"].pop("durationFrames")
        self.assertEqual(film_duration(self.scene), 7)

    def test_explicit_empty_movie_is_black_and_evaluable(self):
        self.scene["shots"] = []
        self.assertEqual([sample["clip"] for sample in sample_scene(self.scene)["frames"]], [{"kind": "black"}] * 8)
        self.scene["render"].pop("durationFrames")
        with self.assertRaisesRegex(ValueError, "explicit duration"):
            validate_scene(self.scene)

    def test_overlaps_invalid_duration_and_hidden_image_rejected(self):
        for change in (lambda s: s["render"].update(durationFrames=4),
                       lambda s: s["render"].update(durationFrames=True),
                       lambda s: s["render"].update(durationFrames=0),
                       lambda s: s["shots"].append({**s["shots"][0], "id": "overlap", "startFrame": 5}),
                       lambda s: s["shots"][0].update(image={})):
            with self.subTest(change=change):
                scene = copy.deepcopy(self.scene)
                change(scene)
                with self.assertRaises(ValueError):
                    validate_scene(scene)

    def test_png_jpeg_and_webp_decode_to_immutable_canonical_png(self):
        for format_, suffix in (("PNG", "png"), ("JPEG", "jpg"), ("WEBP", "webp")):
            with self.subTest(format=format_):
                asset = import_film_image(image_bytes(format_), f"photo.{suffix}", self.root)
                self.assertEqual(asset["format"], "png")
                self.assertEqual((asset["width"], asset["height"]), (8, 4))
                self.assertEqual(asset["path"], f"assets/{asset['sha256']}.png")
                payload = (self.root / asset["path"]).read_bytes()
                self.assertEqual(hashlib.sha256(payload).hexdigest(), asset["sha256"])
                verify_film_image(payload, asset)
                self.assertEqual(import_film_image(image_bytes(format_), f"photo.{suffix}", self.root), asset)

    def test_orientation_is_baked_and_metadata_removed(self):
        exif = Image.Exif()
        exif[274] = 6
        exif[270] = "private source note"
        asset = import_film_image(image_bytes("JPEG", exif=exif), "rotated.jpg", self.root)
        self.assertEqual((asset["width"], asset["height"]), (4, 8))
        with Image.open(self.root / asset["path"]) as image:
            self.assertEqual(dict(image.getexif()), {})
            self.assertNotIn("exif", image.info)

    def test_invalid_animated_truncated_and_oversized_images_rejected(self):
        animated = io.BytesIO()
        Image.new("RGB", (4, 4), "red").save(animated, format="PNG", save_all=True,
                       append_images=[Image.new("RGB", (4, 4), "blue")], duration=200, loop=0)
        for payload in (b"not an image", image_bytes()[:30], animated.getvalue(), image_bytes(size=(8193, 1))):
            with self.subTest(size=len(payload)), self.assertRaises(ValueError):
                import_film_image(payload, "file.png", self.root)
        with self.assertRaises(ValueError):
            import_film_image(image_bytes(), "payload.svg", self.root)
        self.assertFalse((self.root / "assets").exists())

    def test_asset_validation_and_bundling_checks_actual_bytes(self):
        asset = self.image_shot()
        self.assertIs(validate_film_image_asset(asset), asset)
        sampled = sample_scene(self.scene)
        self.assertEqual(sampled["frames"][2]["clip"], {"kind": "image", "asset": asset, "fit": "contain"})
        records = bundle_assets(self.scene, self.root, self.root / "bundle")
        self.assertEqual(records[0]["sha256"], asset["sha256"])
        self.assertEqual((self.root / "bundle" / asset["path"]).read_bytes(), (self.root / asset["path"]).read_bytes())
        for field, value in (("width", 7), ("format", "jpeg"), ("path", "../escape.png")):
            altered = {**asset, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_film_image((self.root / asset["path"]).read_bytes(), altered)
        (self.root / asset["path"]).write_bytes(image_bytes(color=(0, 0, 0, 255)))
        with self.assertRaisesRegex(ValueError, "hash"):
            bundle_assets(self.scene, self.root, self.root / "changed")

    def test_fit_black_letterboxing_cover_and_srgb_color(self):
        asset = self.image_shot()
        for fit in ("contain", "cover"):
            destination = self.root / f"{fit}.png"
            render_clip({"kind": "image", "asset": asset, "fit": fit}, self.root, 8, 8, destination)
            with Image.open(destination) as rendered:
                self.assertEqual(rendered.getpixel((4, 4)), (210, 60, 20))
                self.assertEqual(rendered.getpixel((4, 0)), (0, 0, 0) if fit == "contain" else (210, 60, 20))
        render_clip({"kind": "black"}, self.root, 8, 8, self.root / "black.png")
        with Image.open(self.root / "black.png") as image:
            self.assertEqual(image.getextrema(), ((0, 0),) * 3)

    def test_alpha_composites_over_black(self):
        asset = import_film_image(image_bytes(color=(200, 100, 50, 128)), "alpha.png", self.root)
        render_clip({"kind": "image", "asset": asset, "fit": "cover"}, self.root, 8, 8, self.root / "alpha-frame.png")
        with Image.open(self.root / "alpha-frame.png") as image:
            self.assertEqual(image.mode, "RGB")
            self.assertEqual(image.getpixel((4, 4)), (100, 50, 25))

    def test_render_worker_bundles_images_and_materializes_flat_frames(self):
        self.image_shot()
        scene_shot = copy.deepcopy(self.scene["shots"][0])
        scene_shot.pop("image")
        scene_shot.update(id="live", kind="scene", startFrame=7, endFrame=7)
        self.scene["shots"].append(scene_shot)
        source = self.root / "scene.json"
        source.write_text(json.dumps(self.scene))
        output = self.root / "job"
        job = jobs.create_job(source, output)
        self.assertEqual(job["renderProfile"]["frameCount"], 8)
        self.assertIn("film_images.py", job["rendererDependencies"])
        remaining = jobs._render_non_scene_frames(output, job["renderProfile"], list(range(1, 9)))
        self.assertEqual(remaining, [7])
        self.assertFalse((output / "frames" / "000007.png").exists())
        with Image.open(output / "frames" / "000002.png") as image:
            self.assertEqual(image.getextrema(), ((0, 0),) * 3)
        with Image.open(output / "frames" / "000003.png") as image:
            self.assertEqual(image.getpixel((4, 4)), (210, 60, 20))
        self.assertEqual((output / "frames" / "000003.png").read_bytes(), (output / "frames" / "000005.png").read_bytes())

    def test_text_card_metadata_uses_the_same_canonical_pixels_for_export(self):
        asset = self.image_shot()
        card = {"version": 1, "text": "Made with gesso", "color": "#ffffff", "background": "#181818"}
        self.scene["shots"][0]["image"]["textCard"] = card
        # The browser-generated card is an immutable image; export must not
        # reinterpret its editable source or substitute a server-side font.
        self.scene["render"].update(width=asset["width"], height=asset["height"])
        clip = evaluate(self.scene, 3)["clip"]
        self.assertEqual(clip["textCard"], card)
        self.assertEqual(clip["asset"], asset)
        source = self.root / "text-card.scene.json"
        source.write_text(json.dumps(self.scene))
        output = self.root / "text-card-job"
        job = jobs.create_job(source, output)
        bundled_clip = json.loads((output / "samples.json").read_text())["frames"][2]["clip"]
        self.assertEqual(bundled_clip, clip)
        self.assertEqual((output / asset["path"]).read_bytes(), (self.root / asset["path"]).read_bytes())
        self.assertEqual(jobs._render_non_scene_frames(output, job["renderProfile"], [3, 4, 5]), [])
        with Image.open(self.root / asset["path"]) as approved, Image.open(output / "frames" / "000003.png") as rendered:
            self.assertEqual(rendered.size, approved.size)
            self.assertEqual(rendered.tobytes(), approved.convert("RGB").tobytes())
        self.assertEqual((output / "frames" / "000003.png").read_bytes(), (output / "frames" / "000005.png").read_bytes())


class FilmImageApiTests(unittest.TestCase):
    # Reuse only the real HTTP harness, not its unrelated test cases.
    setUp = test_editor_api.EditorApiTests.setUp
    stop_server = test_editor_api.EditorApiTests.stop_server
    request = test_editor_api.EditorApiTests.request
    bootstrap = test_editor_api.EditorApiTests.bootstrap

    def test_import_image_save_reload_sample_and_download(self):
        project = self.bootstrap()["project"]
        status, asset, _ = self.request("POST", "/api/film/images/import", raw=image_bytes(),
              headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": "photo.png"})
        self.assertEqual(status, 201, asset)
        status, downloaded, headers = self.request("GET", "/api/assets/" + Path(asset["path"]).name)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(hashlib.sha256(downloaded).hexdigest(), asset["sha256"])
        scene = copy.deepcopy(project["scene"])
        scene["shots"][0].update(kind="image", image={"asset": asset, "fit": "contain"})
        scene["render"]["durationFrames"] = scene["shots"][-1]["endFrame"] + 24
        route = f"/api/projects/{project['id']}"
        status, saved, _ = self.request("PUT", route, {"scene": scene, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200, saved)
        status, reloaded, _ = self.request("GET", route)
        self.assertEqual(reloaded["scene"]["shots"][0]["image"]["asset"], asset)
        status, sampled, _ = self.request("POST", "/api/evaluate", {"scene": scene, "frame": scene["render"]["durationFrames"]})
        self.assertEqual(status, 200, sampled)
        self.assertEqual(sampled["sample"]["clip"], {"kind": "black"})

    def test_invalid_upload_does_not_create_asset(self):
        status, response, _ = self.request("POST", "/api/film/images/import", raw=b"<svg></svg>",
              headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": "photo.png"})
        self.assertEqual(status, 400, response)

    def test_text_card_source_and_asset_survive_save_reload_and_sampling(self):
        project = self.bootstrap()["project"]
        status, asset, _ = self.request("POST", "/api/film/images/import", raw=image_bytes(),
              headers={"Content-Type": "application/octet-stream", "X-Asset-Filename": "title.png"})
        self.assertEqual(status, 201, asset)
        card = {"version": 1, "text": "Made with gesso\nA new finish.", "color": "#ffffff", "background": "#181818"}
        scene = copy.deepcopy(project["scene"])
        scene["shots"][0].update(kind="image", image={"asset": asset, "fit": "contain", "textCard": card})
        route = f"/api/projects/{project['id']}"
        status, saved, _ = self.request("PUT", route, {"scene": scene, "expectedRevisionId": project["revisionId"]})
        self.assertEqual(status, 200, saved)
        status, reloaded, _ = self.request("GET", route)
        self.assertEqual(status, 200, reloaded)
        self.assertEqual(reloaded["scene"]["shots"][0]["image"], scene["shots"][0]["image"])
        status, sampled, _ = self.request("POST", "/api/evaluate", {"scene": reloaded["scene"], "frame": 1})
        self.assertEqual(status, 200, sampled)
        self.assertEqual(sampled["sample"]["clip"], {"kind": "image", **scene["shots"][0]["image"]})
