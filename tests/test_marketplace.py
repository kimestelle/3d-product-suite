"""Community submissions stay private until a reviewer approves verified assets."""
import copy
from datetime import datetime, timedelta, timezone
import gzip
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest

from PIL import Image

from film.marketplace import Marketplace
from film.store import ConflictError
from film.textures import import_texture
from film.worlds import import_world


def world_fixture(root, *, cover=True):
    source = root / "source.spz"
    raw = bytearray(struct.pack("<III4B", 0x5053474E, 2, 2, 0, 12, 0, 0) + bytes(38))
    raw[25:28] = (4096).to_bytes(3, "little", signed=True)
    source.write_bytes(gzip.compress(raw, mtime=0))
    world = import_world(source, root, name="Fixture room", provenance={"source": "Original test room", "owner": "Fixture creator",
                         "reuseBasis": "Original synthetic geometry", "allowedExternalDestinations": []})
    if cover:
        image = io.BytesIO()
        Image.new("RGB", (4, 4), (20, 40, 60)).save(image, format="PNG")
        world["previewAsset"] = import_texture(image.getvalue(), root, filename="cover.png")["asset"]
    return world


class MarketplaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.service = Marketplace(self.root)
        self.world = world_fixture(self.root)

    def subscribe(self, status="active", delta=timedelta(days=1)):
        self.service.directory.mkdir(exist_ok=True)
        (self.service.directory / "membership.json").write_text(json.dumps({"schemaVersion": 1,
             "subscriptionStatus": status, "expiresAt": (datetime.now(timezone.utc) + delta).isoformat()}))

    def approve(self):
        submitted = self.service.submit(self.world, {"description": "An original fixture room.", "tags": ["studio"]})
        self.service.review(submitted["id"], "approved", reviewer="Fixture reviewer")
        return submitted["id"]

    def test_audited_submissions_wait_for_an_explicit_reviewer_and_deduplicate(self):
        before = copy.deepcopy(self.world)
        result = self.service.submit(self.world)
        self.assertEqual(result["state"], "pending_review")
        self.assertTrue(result["audit"]["passed"])
        self.assertEqual(result["audit"]["facts"]["pointCount"], 2)
        self.assertEqual(self.service.submit(self.world), result)
        self.assertEqual(self.service.list()["listings"], [])
        with self.assertRaises(FileNotFoundError):
            self.service.detail(result["id"])
        self.service.review(result["id"], "approved", reviewer="Fixture reviewer")
        listing = self.service.list()["listings"][0]
        self.assertEqual(listing["splatCount"], 2)
        self.assertEqual(listing["creator"], "Fixture creator")
        public = json.dumps(listing)
        self.assertNotIn("assets/", public)
        self.assertNotIn("worldSha256", public)
        self.assertNotIn("environment", public)
        self.assertEqual(self.world, before)

    def test_missing_cover_and_bad_asset_never_publish(self):
        missing = copy.deepcopy(self.world)
        missing.pop("previewAsset")
        result = self.service.submit(missing)
        self.assertEqual(result["state"], "changes_needed")
        with self.assertRaises(ConflictError):
            self.service.review(result["id"], "approved", reviewer="Fixture reviewer")
        invalid = copy.deepcopy(self.world)
        invalid["environment"]["asset"]["sha256"] = "a" * 64
        rejected = self.service.submit(invalid)
        self.assertFalse(rejected["audit"]["passed"])
        self.assertEqual(self.service.list()["listings"], [])

    def test_membership_is_explicit_expiring_and_server_owned(self):
        listing_id = self.approve()
        self.assertEqual(self.service.membership(), {"active": False, "configured": False})
        with self.assertRaises(PermissionError):
            self.service.download(listing_id)
        for status, delta in (("canceled", timedelta(days=1)), ("active", timedelta(days=-1)), ("trialing", timedelta(days=1))):
            self.subscribe(status, delta)
            self.assertEqual(self.service.membership(), {"active": False, "configured": True})
            with self.assertRaises(PermissionError):
                self.service.download(listing_id)
        self.subscribe()
        source = self.service.download(listing_id)
        self.assertEqual(source, (self.root / self.world["environment"]["asset"]["path"]).resolve())
        source.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            self.service.download(listing_id)

    def test_approved_snapshot_and_cover_stay_bound_to_verified_bytes(self):
        listing_id = self.approve()
        self.assertTrue(self.service.preview(listing_id).is_file())
        snapshot_path = self.service._folder(listing_id) / "snapshot.json"
        snapshot = json.loads(snapshot_path.read_text())
        snapshot["world"]["name"] = "Changed world"
        snapshot_path.write_text(json.dumps(snapshot))
        with self.assertRaisesRegex(ValueError, "snapshot changed"):
            self.service.detail(listing_id)

    def test_withdrawal_hides_the_listing_and_keeps_the_submission_history(self):
        listing_id = self.approve()
        self.assertEqual(self.service.withdraw(listing_id)["state"], "withdrawn")
        self.assertEqual(self.service.list()["listings"], [])
        with self.assertRaises(FileNotFoundError):
            self.service.preview(listing_id)
        with self.assertRaises(ConflictError):
            self.service.review(listing_id, "approved", reviewer="Fixture reviewer")
        self.assertEqual(self.service.submission(listing_id)["state"], "withdrawn")

    def test_client_flags_cannot_establish_a_subscription_or_approval(self):
        with self.assertRaisesRegex(ValueError, "explicit opt-in"):
            self.service.submit_saved({"worldId": self.world["id"], "active": True})
        result = self.service.submit_saved({"worldId": self.world["id"], "communityOptIn": True,
                                            "approved": True, "subscriptionStatus": "active"})
        self.assertEqual(result["state"], "changes_needed")
        self.assertFalse(self.service.membership()["active"])

    def test_fresh_opt_in_reopens_review_without_restoring_old_approval(self):
        listing_id = self.approve()
        self.service.withdraw(listing_id)
        reopened = self.service.resubmit(listing_id)
        self.assertEqual(reopened["state"], "pending_review")
        self.assertTrue(reopened["audit"]["passed"])
        self.assertEqual(self.service.list()["listings"], [])
        with self.assertRaises(FileNotFoundError):
            self.service.preview(listing_id)
        self.service.review(listing_id, "approved", reviewer="New reviewer")
        self.assertEqual(self.service.list()["listings"][0]["id"], listing_id)
