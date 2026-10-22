"""Artwork is normalized once and remains the same immutable asset through revisions."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from film.artwork import (import_artwork, validate_artwork_asset, validate_product_artwork,
                          validate_artwork_nodes, verify_artwork)
from film.scene import validate_scene
from film.store import ProjectStore
from film.worlds import bundle_assets
from tests.test_film_images import image_bytes
from tests.test_products import product_glb
from tests.test_scene import EXAMPLE
from tests.test_worlds import PROVENANCE


def replacement(asset, part='label', component='label', finish='paper'):
    return {'partId': part, 'componentId': component, 'finish': finish, 'asset': asset}


class ArtworkTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.scene = json.loads(EXAMPLE.read_text())
        self.asset = import_artwork(image_bytes(color=(230, 100, 20, 128)), 'revision.png', self.root)

    def test_decode_profile_bounds_and_alpha(self):
        with Image.open(self.root / self.asset['path']) as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((0, 0)), (230, 100, 20, 128))
        self.assertEqual(import_artwork(image_bytes(color=(230, 100, 20, 128)), 'same.png', self.root), self.asset)
        for format_, suffix in [('JPEG', 'jpg'), ('WEBP', 'webp')]:
            asset = import_artwork(image_bytes(format_), 'label.' + suffix, self.root)
            self.assertEqual(asset['format'], 'png')
            verify_artwork((self.root / asset['path']).read_bytes(), asset)
        large = import_artwork(image_bytes(size=(5000, 1000)), 'large.png', self.root)
        self.assertEqual((large['width'], large['height']), (4096, 819))
        self.assertEqual(hashlib.sha256((self.root / self.asset['path']).read_bytes()).hexdigest(), self.asset['sha256'])

    def test_invalid_artwork_never_overwrites_an_existing_asset(self):
        before = (self.root / self.asset['path']).read_bytes()
        for payload, name in [(b'bad', 'x.png'), (before[:25], 'x.png'), (before, 'x.svg')]:
            with self.subTest(name=name, count=len(payload)), self.assertRaises(ValueError):
                import_artwork(payload, name, self.root)
        self.assertEqual((self.root / self.asset['path']).read_bytes(), before)
        for patch in [{'format': 'jpeg'}, {'path': '../image.png'}, {'width': 4097}]:
            with self.assertRaises(ValueError):
                validate_artwork_asset({**self.asset, **patch})

    def test_replacement_and_decal_assets_bundle_and_reopen(self):
        self.scene['product']['artwork'] = [replacement(self.asset)]
        self.scene['product']['decals'] = [{'id': 'print', 'componentId': 'cap', 'partId': 'cap', 'text': 'TEST', 'subtitle': '',
            'centerUv': [.5, .5], 'sizeUv': [.25, .25], 'rotationDeg': 0, 'heightM': 0, 'bevelM': 0, 'artwork': self.asset}]
        validate_scene(self.scene)
        records = bundle_assets(self.scene, self.root, self.root / 'bundle')
        self.assertEqual(len(records), 1)
        self.assertEqual((self.root / 'bundle' / self.asset['path']).read_bytes(), (self.root / self.asset['path']).read_bytes())
        store = ProjectStore(self.root / 'projects-store')
        saved = store.create('Label revision', self.scene, source_dir=self.root)
        reopened = store.get(saved['id'])
        self.assertEqual(reopened['scene']['product']['artwork'], self.scene['product']['artwork'])
        self.assertEqual(reopened['scene']['product']['decals'][0]['artwork'], self.asset)
        self.scene['product']['artwork'] = []
        restored = store.save(saved['id'], self.scene, saved['revisionId'])
        self.assertEqual(restored['scene']['product']['artwork'], [])
        self.assertEqual(store.get(saved['id'], saved['revisionId'])['scene']['product']['artwork'], [replacement(self.asset)])

    def test_targets_finish_duplicates_and_bad_assets_are_rejected(self):
        for entries in [[replacement(self.asset, part='missing')], [replacement(self.asset, finish='glossy')],
                        [replacement(self.asset), replacement(self.asset)], [replacement({**self.asset, 'sha256': 'bad'})]]:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                validate_product_artwork({'product': {**self.scene['product'], 'artwork': entries}})

    def test_imported_exact_mesh_and_uv_validation(self):
        def mutate(doc):
            doc['nodes'] = [{'name': 'Assembly', 'children': [1]}, {'name': 'Label', 'mesh': 0}]
            doc['scenes'][0]['nodes'] = [0]
            doc['meshes'][0]['primitives'][0]['attributes']['TEXCOORD_0'] = 1
            doc['accessors'].append({'bufferView': 0, 'componentType': 5126, 'count': 6, 'type': 'VEC2'})
        payload = product_glb(change=mutate)
        component = {'id': 'product', 'shape': 'mesh'}
        scene = {'product': {'components': [component], 'artwork': [replacement(self.asset, 'product::node:1', 'product')]}}
        validate_product_artwork(scene)
        validate_artwork_nodes(scene, component, payload)
        for target in ['product::node:0', 'product::node:12']:
            scene['product']['artwork'][0]['partId'] = target
            with self.assertRaisesRegex(ValueError, 'existing mesh'):
                validate_artwork_nodes(scene, component, payload)
        scene['product']['artwork'][0]['partId'] = 'product::node:0'
        component['sourceNodes'] = [{'nodeIndex': 0, 'hasMesh': False}]
        with self.assertRaisesRegex(ValueError, 'assembly group'):
            validate_product_artwork(scene)
        scene['product']['artwork'][0]['partId'] = 'product::node:0'
        with self.assertRaisesRegex(ValueError, 'original UV'):
            validate_artwork_nodes(scene, component, product_glb())

    def test_changed_pixels_are_rejected_when_bundling(self):
        self.scene['product']['artwork'] = [replacement(self.asset)]
        (self.root / self.asset['path']).write_bytes(image_bytes(color=(1, 2, 3, 255)))
        with self.assertRaisesRegex(ValueError, 'hash'):
            bundle_assets(self.scene, self.root, self.root / 'bad-bundle')


class ArtworkApiTests(unittest.TestCase):
    from tests.test_editor_api import EditorApiTests as _Harness
    setUp = _Harness.setUp
    stop_server = _Harness.stop_server
    request = _Harness.request
    bootstrap = _Harness.bootstrap

    def test_upload_download_save_reopen_and_local_boundary(self):
        project = self.bootstrap()['project']
        status, asset, _ = self.request('POST', '/api/artwork/import', raw=image_bytes(),
              headers={'Content-Type': 'application/octet-stream', 'X-Asset-Filename': 'label.png'})
        self.assertEqual(status, 201, asset)
        status, downloaded, _ = self.request('GET', '/api/assets/' + Path(asset['path']).name)
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(downloaded).hexdigest(), asset['sha256'])
        scene = copy.deepcopy(project['scene'])
        scene['product']['artwork'] = [replacement(asset)]
        route = f"/api/projects/{project['id']}"
        status, saved, _ = self.request('PUT', route, {'scene': scene, 'expectedRevisionId': project['revisionId']})
        self.assertEqual(status, 200, saved)
        status, reopened, _ = self.request('GET', route)
        self.assertEqual(reopened['scene']['product']['artwork'], scene['product']['artwork'])
        status, _, _ = self.request('POST', '/api/artwork/import', raw=image_bytes(), mutate=False,
              headers={'Content-Type': 'application/octet-stream', 'X-Asset-Filename': 'label.png'})
        self.assertEqual(status, 403)

    def test_invalid_upload_leaves_scene_unchanged(self):
        project = self.bootstrap()['project']
        status, result, _ = self.request('POST', '/api/artwork/import', raw=b'<svg/>',
              headers={'Content-Type': 'application/octet-stream', 'X-Asset-Filename': 'label.png'})
        self.assertEqual(status, 400, result)
        _, reopened, _ = self.request('GET', f"/api/projects/{project['id']}")
        self.assertEqual(reopened['scene'], project['scene'])
