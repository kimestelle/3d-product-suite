"""Scene-object editing operations shared by the editor and saved scenes."""

import copy
import itertools
import math

from .scene import validate_scene
from .scene_objects import resolve_scene_objects


def _plinth_bounds(plinth):
    """Use the same world-axis bounds as object graph support resolution."""
    x, y, z, w = plinth.get("rotationXyzw", [0, 0, 0, 1])
    points = []
    for corner in itertools.product(*[(-size/2, size/2) for size in plinth["sizeM"]]):
        # q*v*q^-1 in expanded form, without importing private graph helpers.
        vx, vy, vz = corner
        tx, ty, tz = 2*(y*vz-z*vy), 2*(z*vx-x*vz), 2*(x*vy-y*vx)
        rotated = [vx+w*tx+y*tz-z*ty, vy+w*ty+z*tx-x*tz, vz+w*tz+x*ty-y*tx]
        points.append([a+b for a, b in zip(plinth["translationM"], rotated)])
    return [[min(point[axis] for point in points) for axis in range(3)],
            [max(point[axis] for point in points) for axis in range(3)]]


def frame_scene_objects(scene, include_props=True):
    """Copy a scene and frame its editable objects in every shot endpoint.

    The fit uses the sphere around the union of static world-axis bounds, with
    a 15% margin. A 36 mm vertical sensor matches both rendering and preview.
    Each camera keeps its original viewing direction and focal length. Imported
    world geometry and the unbounded floor are deliberately excluded from the
    fit. ``include_props=False`` frames only the rigid product assembly.
    """
    if type(include_props) is not bool:
        raise ValueError("include_props must be boolean")
    result = copy.deepcopy(scene)
    validate_scene(result)
    resolved = resolve_scene_objects(result)
    bounds = [resolved["product"]["boundsM"]]
    if include_props:
        environment = result["environment"]
        bounds.extend(resolved["props"][prop["id"]]["boundsM"]
                      for prop in environment.get("props", []) if prop.get("visible", True))
        if environment["plinth"].get("visible", True):
            bounds.append(_plinth_bounds(environment["plinth"]))
    low = [min(bound[0][axis] for bound in bounds) for axis in range(3)]
    high = [max(bound[1][axis] for bound in bounds) for axis in range(3)]
    # Halving before adding avoids overflowing a valid large coordinate pair.
    center = [minimum/2+maximum/2 for minimum, maximum in zip(low, high)]
    radius = math.hypot(*(maximum/2-minimum/2 for minimum, maximum in zip(low, high)))
    aspect = result["render"]["width"]/result["render"]["height"]
    for shot in result["shots"]:
        for endpoint in ("from", "to"):
            camera = shot["camera"][endpoint]
            direction = [position-target for position, target in zip(camera["positionM"], camera["targetM"])]
            length = math.hypot(*direction)
            direction = [value/length for value in direction]
            vertical_half_fov = math.atan(18/camera["focalLengthMm"])
            horizontal_half_fov = math.atan(aspect*math.tan(vertical_half_fov))
            distance = radius*1.15/math.sin(min(vertical_half_fov, horizontal_half_fov))
            camera["targetM"] = list(center)
            camera["positionM"] = [value+axis*distance for value, axis in zip(center, direction)]
    return validate_scene(result)
