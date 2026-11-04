import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from film.post_processing import (DEFAULT_POST_PROCESSING, apply_post_processing,
                                  grade_image, has_post_processing, validate_post_processing)
from film.scene import validate_scene

ROOT = Path(__file__).resolve().parents[1]


def reference(rgb, s):
    c = [value / 255 * 2 ** s['exposureEV'] * gain for value, gain in zip(rgb,
         [1 + .12*s['temperature'], 1 + .06*s['tint'], 1 - .12*s['temperature']])]
    y = sum(k * min(1, max(0, value)) for k, value in zip([.2126, .7152, .0722], c))
    adjustment = .18 * (s['shadows']*(1-y)**2+s['highlights']*y*y)
    c = [(value+adjustment-.5)*s['contrast']+.5 for value in c]
    y = sum(k * value for k, value in zip([.2126, .7152, .0722], c))
    return tuple(round(255*min(1,max(0,y+(value-y)*s['saturation']))) for value in c)


class PostProcessingTests(unittest.TestCase):
    def test_optional_defaults_and_neutral_fast_path_do_not_open_any_file(self):
        self.assertEqual(validate_post_processing(), DEFAULT_POST_PROCESSING)
        self.assertFalse(has_post_processing())
        self.assertFalse(apply_post_processing('/missing/file.png', None))
        self.assertFalse(apply_post_processing('/missing/file.png', {'enabled': True}))
        self.assertFalse(apply_post_processing('/missing/file.png', {'enabled': False, 'exposureEV': 2}))

    def test_invalid_schema_is_rejected_at_scene_boundary(self):
        for value in [[], True, {'enabled': 1}, {'exposureEV': True}, {'grain': .2},
                      {'contrast': float('nan')}, {'bloom': float('inf')}, {'mystery': 1}]:
            scene = json.loads((ROOT/'examples/bottle.scene.json').read_text())
            scene['postProcessing'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_scene(scene)

    def test_grade_matches_scalar_contract_and_preserves_input_alpha(self):
        image = Image.new('RGBA', (12, 600), (83, 121, 204, 127))
        before = image.tobytes()
        settings = validate_post_processing({'enabled': True, 'exposureEV': .4, 'temperature': .4, 'tint': -.2,
                 'shadows': .2, 'highlights': -.4, 'contrast': 1.13, 'saturation': .9})
        graded = grade_image(image, settings)
        expected = reference((83, 121, 204), settings)
        self.assertEqual(image.tobytes(), before)
        for y in (0, 255, 256, 599):
            value = graded.getpixel((5, y))
            self.assertEqual(value[3], 127)
            self.assertTrue(all(abs(a-b)<=1 for a,b in zip(value[:3],expected)))

    def test_vignette_and_grain_are_stable_and_optional(self):
        image = Image.new('RGB', (300, 200), (150, 150, 150))
        vignette = grade_image(image, {'enabled': True, 'vignette': 1})
        self.assertLess(vignette.getpixel((0, 0))[0], vignette.getpixel((150, 100))[0])
        settings = {'enabled': True, 'grain': .1}
        a, b = grade_image(image, settings), grade_image(image, settings)
        self.assertEqual(a.tobytes(), b.tobytes())
        self.assertEqual(a.getpixel((20,20)), a.getpixel((148,148)))
        self.assertNotEqual(a.tobytes(), image.tobytes())

    def test_bloom_spreads_only_bright_pixel_energy(self):
        image = Image.new('RGB', (100, 100), (0, 0, 0))
        for x in range(48, 53):
            for y in range(48, 53): image.putpixel((x,y), (255,255,255))
        graded = grade_image(image, {'enabled': True, 'bloom': 1})
        self.assertGreater(graded.getpixel((47,50))[0], 0)
        self.assertEqual(graded.getpixel((0,0)), (0,0,0))

    def test_all_effects_keep_alpha_and_bound_display_values(self):
        image = Image.new('RGBA', (160, 300), (242, 13, 170, 91))
        settings = {'enabled': True, 'exposureEV': 3, 'temperature': 1, 'tint': -1,
                    'contrast': 1.5, 'saturation': 2, 'highlights': 1, 'shadows': -1,
                    'bloom': 1, 'vignette': 1, 'grain': .15}
        with grade_image(image, settings) as graded:
            self.assertEqual(graded.getchannel('A').getextrema(), (91, 91))
            self.assertTrue(all(0 <= low <= high <= 255 for low, high in graded.getextrema()))
        self.assertEqual(image.getpixel((0, 0)), (242, 13, 170, 91))

    def test_effects_only_neutral_color_stage_preserves_every_byte(self):
        values = bytes(value for r in range(256) for g in range(256)
                       for value in (r, g, (r * 37 + g * 19) % 256))
        with Image.frombytes('RGB', (256, 256), values) as image:
            # This nonzero effect activates finishing but stays below one byte.
            with grade_image(image, {'enabled': True, 'grain': 1e-7}) as graded:
                self.assertEqual(graded.tobytes(), values)

    def test_file_write_is_atomic_and_cancel_keeps_raw_file(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'frame.png';Image.new('RGB',(8,8),(60,60,60)).save(path)
            before=path.read_bytes()
            with self.assertRaisesRegex(RuntimeError,'cancelled'):
                apply_post_processing(path, {'enabled':True,'exposureEV':1},cancel=lambda:(_ for _ in ()).throw(RuntimeError('cancelled')))
            self.assertEqual(path.read_bytes(),before)
            self.assertTrue(apply_post_processing(path, {'enabled':True,'exposureEV':1}))
            with Image.open(path) as image: self.assertEqual(image.getpixel((0,0)),(120,120,120))
            self.assertEqual(list(Path(root).glob('.grade-*')),[])


if __name__=='__main__':unittest.main()
