"""Workspace presets store only selected setup scopes and never save a campaign."""
import copy
import hashlib
import json
from pathlib import Path
import threading

from .jobs import _atomic_json
from .scene import validate_scene
from .store import identifier, now
from .worlds import verify_scene_assets

SCOPES = ('product', 'materials', 'stage', 'lighting', 'film', 'finish')
COMPONENT_FINISH = ('material', 'materialOverride', 'materialPresetId', 'materialBindings', 'labelTexture')
PRODUCT_FINISH = ('materialPresets', 'label', 'decals')
FILM_FIELDS = ('shots', 'motions', 'animation', 'actions', 'audio', 'filmAudio')
FRAME_FIELDS = ('width', 'height', 'fps', 'durationFrames')
MAX_RECORD_BYTES = 4 * 1024 * 1024


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def _scopes(values):
    if (not isinstance(values, list) or not values or any(not isinstance(value, str) or value not in SCOPES for value in values)
            or len(values) != len(set(values))):
        raise ValueError('Choose at least one supported preset section.')
    if 'product' in values and 'materials' not in values:
        raise ValueError('Saving or loading the product also includes its materials and artwork.')
    return [scope for scope in SCOPES if scope in values]


def product_key(scene):
    # Materials may be reused after renaming, posing or regrouping this geometry.
    geometry = [{key: component.get(key) for key in ('id', 'shape', 'asset', 'sizeM', 'sourceNodes')}
                for component in scene['product']['components']]
    return hashlib.sha256(_canonical(geometry)).hexdigest()


def _pick(source, keys):
    return {key: copy.deepcopy(source[key]) for key in keys if key in source}


def _replace_fields(destination, saved, keys):
    for key in keys:
        if key in saved:
            destination[key] = copy.deepcopy(saved[key])
        else:
            destination.pop(key, None)


def capture_values(scene, scopes):
    values = {}
    if 'product' in scopes:
        values['product'] = {'product': copy.deepcopy(scene['product']), 'placement': copy.deepcopy(scene['placement']),
                             'evidence': copy.deepcopy(scene.get('evidence', []))}
    if 'materials' in scopes:
        values['materials'] = {'product': _pick(scene['product'], PRODUCT_FINISH),
                               'components': {component['id']: _pick(component, COMPONENT_FINISH)
                                              for component in scene['product']['components']}}
    if 'stage' in scopes:
        values['stage'] = copy.deepcopy(scene['environment'])
        if 'comparison' in scene:
            values['comparison'] = copy.deepcopy(scene['comparison'])
    if 'lighting' in scopes:
        values['lighting'] = copy.deepcopy(scene.get('lighting'))
    if 'film' in scopes:
        values['film'] = {'fields': _pick(scene, FILM_FIELDS), 'render': _pick(scene['render'], FRAME_FIELDS)}
    if 'finish' in scopes:
        values['finish'] = copy.deepcopy(scene.get('postProcessing'))
    return values


def _identity(record):
    return {key: record[key] for key in ('schemaVersion', 'name', 'scopes', 'productKey', 'productName', 'values')}


class PresetLibrary:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.directory = self.root / 'presets'
        self.directory.mkdir(exist_ok=True)
        self.lock = threading.RLock()

    def get(self, preset_id):
        path = self.directory / (identifier(preset_id) + '.json')
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RECORD_BYTES:
            raise ValueError('Preset is missing or invalid.')
        record = json.loads(path.read_text())
        if record.get('schemaVersion') != 1 or record.get('id') != preset_id:
            raise ValueError('Preset record is invalid.')
        _scopes(record['scopes'])
        expected = 'preset-' + hashlib.sha256(_canonical(_identity(record))).hexdigest()[:24]
        if expected != preset_id:
            raise ValueError('The saved preset was modified.')
        return record

    @staticmethod
    def summary(record, scene=None):
        result = {key: record[key] for key in ('id', 'name', 'createdAt', 'scopes', 'productName')}
        if scene is not None:
            result['sameProduct'] = product_key(scene) == record['productKey']
        return result

    def list(self, scene=None):
        if scene is not None:
            validate_scene(scene)
        entries = []
        for path in self.directory.glob('preset-*.json'):
            record = self.get(path.stem)
            entries.append(self.summary(record, scene))
        return sorted(entries, key=lambda value: (value['createdAt'], value['id']), reverse=True)

    def create(self, name, scopes, scene):
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
            raise ValueError('Name the preset using 1–120 characters.')
        scopes = _scopes(scopes)
        validate_scene(scene)
        verify_scene_assets(scene, self.root)
        record = {'schemaVersion': 1, 'name': name.strip(), 'scopes': scopes, 'productKey': product_key(scene),
                  'productName': str(scene['product'].get('displayName', 'Product'))[:160],
                  'values': capture_values(scene, scopes)}
        preset_id = 'preset-' + hashlib.sha256(_canonical(record)).hexdigest()[:24]
        record.update(id=preset_id, createdAt=now())
        if len(_canonical(record)) > MAX_RECORD_BYTES:
            raise ValueError('This preset is too large. Save fewer sections.')
        with self.lock:
            path = self.directory / (preset_id + '.json')
            if path.exists():
                return self.summary(self.get(preset_id), scene)
            _atomic_json(path, record)
        return self.summary(record, scene)

    def apply(self, preset_id, scopes, scene):
        validate_scene(scene)
        record = self.get(preset_id)
        scopes = _scopes(scopes)
        if any(scope not in record['scopes'] for scope in scopes):
            raise ValueError('The preset does not contain one of the selected sections.')
        if 'materials' in scopes and 'product' not in scopes and product_key(scene) != record['productKey']:
            raise ValueError('These materials belong to a different product. Include its saved product, or load other sections.')
        result = copy.deepcopy(scene)
        values = record['values']
        if 'product' in scopes:
            result.update(copy.deepcopy(values['product']))
        if 'materials' in scopes:
            _replace_fields(result['product'], values['materials']['product'], PRODUCT_FINISH)
            for component in result['product']['components']:
                saved = values['materials']['components'].get(component['id'])
                if saved is None:
                    raise ValueError('A material target no longer exists in this product.')
                _replace_fields(component, saved, COMPONENT_FINISH)
        if 'stage' in scopes:
            result['environment'] = copy.deepcopy(values['stage'])
            if 'comparison' in values:
                result['comparison'] = copy.deepcopy(values['comparison'])
            else:
                result.pop('comparison', None)
        for scope, key in (('lighting', 'lighting'), ('finish', 'postProcessing')):
            if scope in scopes:
                if values[scope] is None:
                    result.pop(key, None)
                else:
                    result[key] = copy.deepcopy(values[scope])
        if 'film' in scopes:
            _replace_fields(result, values['film']['fields'], FILM_FIELDS)
            _replace_fields(result['render'], values['film']['render'], FRAME_FIELDS)
        try:
            validate_scene(result)
            verify_scene_assets(result, self.root)
        except ValueError as error:
            raise ValueError(f'These sections do not fit the current setup: {error}. Include their related sections or keep the current setup.') from error
        return {'scene': result, 'appliedScopes': scopes, 'preset': self.summary(record, result)}
