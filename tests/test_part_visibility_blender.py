"""Native export retains removed geometry for recovery but excludes it from rendering."""
import os
import tempfile
import unittest
from pathlib import Path

from film.scene import load_scene, sample_scene, validate_scene
from tests import test_product_mesh_blender as mesh_tests
from tests.test_bottle_workflow_blender import bottle_scene

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('RUN_BLENDER_TESTS') == '1',
                     'Set RUN_BLENDER_TESTS=1 for native removed-part export checks')
class PartVisibilityBlenderTests(unittest.TestCase):
    run_blender = mesh_tests.ProductMeshBlenderTests.run_blender
    build = mesh_tests.ProductMeshBlenderTests.build
    verify_native = mesh_tests.ProductMeshBlenderTests.verify_native

    def test_imported_part_removal_carries_child_and_decal_through_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = bottle_scene(root)
            scene['product']['removedPartIds'] = ['product::node:2']
            source = root / scene['product']['components'][0]['asset']['path']
            original = source.read_bytes()
            payload = sample_scene(validate_scene(scene))
            payload['frames'] = [frame for frame in payload['frames'] if frame['frame'] in (1, 13)]
            self.assertEqual(payload['frames'][0]['removedPartIds'], ['product::node:2', 'product::node:4'])
            samples = self.build(root, payload)
            self.assertEqual(source.read_bytes(), original)
            self.verify_native(root, samples, r'''
parts = {obj['source_part_id']: obj for obj in bpy.data.objects if 'gesso_source_node_index' in obj}
assert len(parts) == 5, list(parts)
for frame in (1, 13):
    bpy.context.scene.frame_set(frame)
    for part_id in ('product::node:2', 'product::node:4'):
        root = parts[part_id]
        for obj in (root, *root.children_recursive):
            assert obj.hide_render and obj.hide_viewport, (part_id, obj.name)
    sibling = parts['product::node:3']
    assert not sibling.hide_render and not sibling.hide_viewport
    root = bpy.data.objects['product']
    assert not root.hide_render and not root.hide_viewport
    patches = [obj for obj in bpy.data.objects if obj.name.startswith('Decal / ')]
    assert patches, 'Expected attached decal geometry to remain recoverable'
    assert all(obj.hide_render and obj.hide_viewport for obj in patches)
assert parts['product::node:2'].data, 'Removed source geometry is retained'
''')

    def test_procedural_label_removal_also_suppresses_attached_type(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = load_scene(ROOT / 'examples/bottle.scene.json')
            scene['product']['removedPartIds'] = [scene['product']['label']['componentId']]
            payload = sample_scene(validate_scene(scene))
            payload['frames'] = [payload['frames'][0]]
            samples = self.build(root, payload)
            self.verify_native(root, samples, r'''
label_id = payload['scene']['product']['label']['componentId']
label = bpy.data.objects[label_id]
assert label.hide_render and label.hide_viewport
text = [obj for obj in label.children_recursive if obj.type == 'FONT']
assert text, 'Expected original label text to remain recoverable'
assert all(obj.hide_render and obj.hide_viewport for obj in text)
for component in payload['scene']['product']['components']:
    if component['id'] != label_id:
        obj = bpy.data.objects[component['id']]
        assert not obj.hide_render and not obj.hide_viewport, obj.name
''')
