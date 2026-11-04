"""A camera-specific source cannot enter export without its exact-frame proof."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest

from film.gaussian_receipts import COPY_POLICY, validate_world_copy


def digest(value):
    return hashlib.sha256(value).hexdigest()


def spz(count):
    return gzip.compress(struct.pack('<IIIBBBB', 0x5053474e, 2, count, 0, 12, 0, 0) + bytes(count * 19), mtime=0)


class GaussianReceiptTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'assets').mkdir()
        (self.root / 'plate').mkdir()
        source, subset = spz(3), spz(2)
        self.asset = {'sha256': digest(source), 'format': 'spz', 'path': f'assets/{digest(source)}.spz'}
        (self.root / self.asset['path']).write_bytes(source)
        (self.root / 'plate/world-copy.spz').write_bytes(subset)
        self.receipt = {'status': 'verified', 'policy': COPY_POLICY, 'key': 'a' * 64,
                        'sourceSha256': digest(source), 'copySha256': digest(subset),
                        'sourcePoints': 3, 'copyPoints': 2, 'sourceBytes': len(source), 'copyBytes': len(subset),
                        'frameNumbers': [1, 2], 'width': 4, 'height': 6}
        self.proof = {key: self.receipt[key] for key in ('status', 'policy', 'key', 'sourceSha256', 'copySha256')}
        self.proof.update(schemaVersion=1, frameProofs=[{'frame': number, 'reference': 'b' * 64, 'copy': 'b' * 64} for number in (1, 2)])
        self.profile = {'width': 4, 'height': 6, 'frameNumbers': [1, 2], 'worldCopy': self.receipt}
        self.write_proof()

    def write_proof(self):
        value = json.dumps(self.proof).encode()
        (self.root / 'plate/world-copy-quality.json').write_bytes(value)
        self.receipt['qualityDigest'] = digest(value)

    def test_accepts_complete_exact_frame_proof_without_changing_original(self):
        before = (self.root / self.asset['path']).read_bytes()
        validate_world_copy(self.root, self.asset, self.profile)
        self.assertEqual((self.root / self.asset['path']).read_bytes(), before)

    def test_rejects_missing_frame_and_any_pixel_mismatch_even_with_updated_report_hash(self):
        for mutation in ('missing', 'mismatch'):
            with self.subTest(mutation=mutation):
                original = copy.deepcopy(self.proof)
                if mutation == 'missing':
                    self.proof['frameProofs'].pop()
                else:
                    self.proof['frameProofs'][1]['copy'] = 'c' * 64
                self.write_proof()
                with self.assertRaisesRegex(ValueError, 'every.*frame'):
                    validate_world_copy(self.root, self.asset, self.profile)
                self.proof = original

    def test_rejects_changed_copy_or_quality_file_before_foreground_rendering(self):
        (self.root / 'plate/world-copy.spz').write_bytes(spz(1))
        with self.assertRaisesRegex(ValueError, 'bytes or original'):
            validate_world_copy(self.root, self.asset, self.profile)
        (self.root / 'plate/world-copy.spz').write_bytes(spz(2))
        (self.root / 'plate/world-copy-quality.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'proof changed'):
            validate_world_copy(self.root, self.asset, self.profile)

    def test_full_source_fallback_and_legacy_capture_never_require_a_subset(self):
        validate_world_copy(self.root, self.asset, {key: value for key, value in self.profile.items() if key != 'worldCopy'})
        self.profile['worldCopy'] = {'status': 'full-source', 'policy': COPY_POLICY,
                                     'sourceSha256': self.asset['sha256'], 'reason': 'Unsupported source; using original.'}
        validate_world_copy(self.root, self.asset, self.profile)

    def test_rejects_unapproved_candidate_and_different_frame_range(self):
        self.receipt['status'] = 'candidate'
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            validate_world_copy(self.root, self.asset, self.profile)
        self.receipt['status'] = 'verified'
        self.profile['frameNumbers'] = [1]
        with self.assertRaisesRegex(ValueError, 'different camera frames'):
            validate_world_copy(self.root, self.asset, self.profile)
