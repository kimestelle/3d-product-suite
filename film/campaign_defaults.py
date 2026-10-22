"""A fixed studio with a proportionally fitted product, in canonical scene state.

This is an explicit starter-campaign operation, never a load-time migration.
Source geometry, source units and part-local motion remain untouched.
"""

import copy
import math


# Match the existing 320 mm Nessino campaign's display envelope. This is a
# composition size, not a claim that every imported product is physically 320 mm.
STUDIO_SIZE_M = .32
PLINTH_SIZE_M = (.48, .08, .48)


def resize_campaign_defaults(scene, *, reference_size_m=None):
    """Return a new starter revision in the shared studio.

    Legacy starter cameras/supports were built from raw product dimensions,
    even when somebody later changed placement.scale. Repair those together.
    A marked campaign is already migrated and keeps subsequent manual edits.
    Imports pass reference_size_m because their fresh cameras use raw bounds.
    """
    from .scene import validate_scene

    validate_scene(scene)
    next_scene = copy.deepcopy(scene)
    if reference_size_m is None and scene['environment'].get('studioSizeM') == STUDIO_SIZE_M:
        return next_scene
    raw_size = max(scene['product']['dimensionsM'])
    reference = reference_size_m if reference_size_m is not None else scene['environment'].get('studioSizeM', raw_size)
    if not math.isfinite(reference) or reference <= 0:
        raise ValueError('Campaign reference size must be positive and finite')
    ratio = STUDIO_SIZE_M / reference
    next_scale = STUDIO_SIZE_M / raw_size
    scale_ratio = next_scale / scene['placement'].get('scale', 1)
    next_scene['placement']['scale'] = next_scale
    next_scene['placement']['translationM'] = [value * ratio for value in scene['placement']['translationM']]
    environment = next_scene['environment']
    environment['studioSizeM'] = STUDIO_SIZE_M
    plinth = environment['plinth']
    old_top = plinth['translationM'][1] + plinth['sizeM'][1] / 2
    plinth['sizeM'] = list(PLINTH_SIZE_M)
    plinth['translationM'] = [plinth['translationM'][0] * ratio,
                              old_top * ratio - PLINTH_SIZE_M[1] / 2,
                              plinth['translationM'][2] * ratio]
    # Near-field props and explicit lighting remain authored; rescale their
    # metre coordinates with the starter, leaving the imported room unchanged.
    for prop in environment.get('props', []):
        for field in ('sizeM', 'translationM'):
            prop[field] = [value * ratio for value in prop[field]]
        if 'bevelM' in prop:
            prop['bevelM'] *= ratio
    for light in next_scene.get('lighting', {}).get('lights', []):
        for field in ('positionM', 'targetM'):
            light[field] = [value * ratio for value in light[field]]
        light['diameterM'] *= ratio
        light['powerW'] *= ratio * ratio
    for shot in next_scene['shots']:
        if shot.get('kind') == 'image':
            continue
        camera = shot['camera']
        for end in ('from', 'to'):
            for field in ('positionM', 'targetM'):
                camera[end][field] = [value * ratio for value in camera[end][field]]
        optics = camera.get('depthOfField', {})
        if 'focusDistanceM' in optics:
            optics['focusDistanceM'] *= ratio
    for track in next_scene.get('animation', {}).get('tracks', []):
        if track['componentId'] != '$product':
            continue
        multiplier = scale_ratio if track['property'] == 'scale' else ratio if track['property'].startswith('position.') else 1
        for key in track['keys']:
            key['value'] *= multiplier
    for scope in [next_scene, *next_scene['shots']]:
        for motion in scope.get('motions', []):
            if (motion['target'] == '$product' and motion['kind'] == 'move'
                    or motion['target'] == '$camera' and motion['kind'] == 'dolly'
                    or motion['target'].startswith('$light:') and motion['kind'] == 'move'):
                motion['amount'] *= ratio
    validate_scene(next_scene)
    return next_scene
