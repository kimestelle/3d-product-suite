"""Conservative warm-scene boundaries shared with the native proof worker."""
import copy
import hashlib
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def warm_scene_key(scene):
    """Only camera, finish and rebuilt lighting may differ in a retained scene.

    Product/material/geometry, source units, support placement, source animation,
    world alignment, stage geometry and all unknown fields remain in the key.
    """
    value = copy.deepcopy(scene)
    value.pop('postProcessing', None)
    value.pop('lighting', None)
    value['motions'] = [item for item in value.get('motions', []) if item.get('target') != '$camera']
    for shot in value['shots']:
        shot.pop('camera', None)
        shot['motions'] = [item for item in shot.get('motions', []) if item.get('target') != '$camera']
    return digest(value)


def non_optical_sample(sample):
    return {key:value for key,value in sample.items() if key not in ('camera', 'lights')}
