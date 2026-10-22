"""Deterministic source-node motion in canonical Y-up metres.

Delta acts in the source parent's coordinates around the measured part centre.
Editorial grouping never changes physical inheritance.
"""
import math

IDENTITY = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]


def multiply(a, b):
    return [sum(a[k * 4 + row] * b[column * 4 + k] for k in range(4))
            for column in range(4) for row in range(4)]


def point(matrix, value):
    return [sum(matrix[column * 4 + row] * value[column] for column in range(3)) + matrix[12 + row]
            for row in range(3)]


def pose_matrix(translation, quaternion, scale=1):
    x, y, z, w = quaternion
    return [(1-2*y*y-2*z*z)*scale, (2*x*y+2*z*w)*scale, (2*x*z-2*y*w)*scale, 0.,
            (2*x*y-2*z*w)*scale, (1-2*x*x-2*z*z)*scale, (2*y*z+2*x*w)*scale, 0.,
            (2*x*z+2*y*w)*scale, (2*y*z-2*x*w)*scale, (1-2*x*x-2*y*y)*scale, 0.,
            *translation, 1.]


def node_id(component_id, node_index):
    return f"{component_id}::node:{node_index}"


def source_targets(scene):
    return {node_id(component['id'], node['nodeIndex']): (component, node)
            for component in scene['product']['components'] for node in component.get('sourceNodes', [])
            if node['drawable']}


def base_pose(component, node):
    return component.get('partTransforms', {}).get(str(node['nodeIndex']),
            {'translationM': [0., 0., 0.], 'rotationXyzw': [0., 0., 0., 1.], 'scale': 1.})


def validate_source_nodes(component):
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    def vector(value, size, name):
        require(isinstance(value, list) and len(value) == size and
                all(type(x) in (int, float) and math.isfinite(x) for x in value), f'{name} must contain finite values')
    nodes = component.get('sourceNodes', [])
    require(isinstance(nodes, list) and len(nodes) <= 100000, 'Source nodes must be a bounded list')
    require(not nodes or component['shape'] == 'mesh', 'Source nodes require an imported mesh product')
    ids = set()
    for node in nodes:
        require(isinstance(node, dict), 'Source node must be an object')
        index = node.get('nodeIndex')
        require(type(index) is int and 0 <= index < 100000 and index not in ids, 'Source node index must be unique and bounded')
        ids.add(index)
        require(isinstance(node.get('name'), str) and len(node['name']) <= 1000, 'Source node name must be bounded')
        require(node.get('parentIndex') is None or type(node['parentIndex']) is int, 'Source node parent must be a node index')
        require(type(node.get('drawable')) is bool, 'Source node drawable must be boolean')
        require(type(node.get('hasMesh')) is bool, 'Source node hasMesh must be boolean')
        vector(node.get('localMatrix'), 16, 'Source node matrix')
        require(all(abs(node['localMatrix'][i] - IDENTITY[i]) < 1e-8 for i in (3, 7, 11, 15)), 'Source node matrix must be affine')
        bounds = node.get('boundsM')
        require(isinstance(bounds, list) and len(bounds) == 2, 'Source node bounds must contain two points')
        for bound in bounds:
            vector(bound, 3, 'Source node bounds')
        require(all(a <= b for a, b in zip(*bounds)), 'Source node bounds must be ordered')
    by_id = {node['nodeIndex']: node for node in nodes}
    for node in nodes:
        seen = {node['nodeIndex']}
        parent = node['parentIndex']
        while parent is not None:
            require(parent in by_id and parent not in seen and len(seen) <= 80, 'Source node hierarchy is invalid')
            seen.add(parent)
            parent = by_id[parent]['parentIndex']
    transforms = component.get('partTransforms', {})
    require(isinstance(transforms, dict) and len(transforms) <= len(nodes), 'Part transforms must reference source nodes')
    for key, pose in transforms.items():
        require(isinstance(key, str) and key.isdigit() and str(int(key)) == key and int(key) in by_id
                and by_id[int(key)]['drawable'], 'Part transform target does not exist')
        require(isinstance(pose, dict) and set(pose) <= {'translationM', 'rotationXyzw', 'scale', 'pivotM'}, 'Part transform fields are unsupported')
        vector(pose.get('translationM'), 3, 'Part translation')
        vector(pose.get('rotationXyzw'), 4, 'Part rotation')
        require(abs(sum(x*x for x in pose['rotationXyzw']) - 1) < 1e-6, 'Part quaternion must be normalized')
        scale = pose.get('scale', 1)
        require(type(scale) in (float, int) and math.isfinite(scale) and .01 <= scale <= 100, 'Part scale must be in 0.01..100')
        if 'pivotM' in pose:
            vector(pose['pivotM'], 3, 'Part pivot')


def evaluate_parts(scene, components, animated, euler, quaternion):
    result = {}
    for component in scene['product']['components']:
        nodes = component.get('sourceNodes', [])
        if not nodes:
            continue
        by_id = {node['nodeIndex']: node for node in nodes}
        root = components[component['id']]
        root_matrix = pose_matrix(root['translationM'], root['rotationXyzw'], root.get('scale', 1))
        local_results = {}
        def visit(index):
            if index in local_results:
                return local_results[index]
            node = by_id[index]
            identifier = node_id(component['id'], index)
            pose = base_pose(component, node)
            values = animated.get(identifier, {})
            translation = [values.get(f'position.{axis}', value) for axis, value in zip('xyz', pose['translationM'])]
            rotation = pose['rotationXyzw']
            if any(f'rotation.{axis}' in values for axis in 'xyz'):
                rotation = quaternion([values.get(f'rotation.{axis}', value) for axis, value in zip('xyz', euler(rotation))])
            scale = values.get('scale', pose.get('scale', 1))
            centre = [(a+b)/2 for a, b in zip(*node['boundsM'])]
            pivot = pose.get('pivotM', point(node['localMatrix'], centre))
            delta = pose_matrix(translation, rotation, scale)
            rotated_pivot = [sum(delta[c * 4 + r] * pivot[c] for c in range(3)) for r in range(3)]
            delta[12:15] = [translation[i] + pivot[i] - rotated_pivot[i] for i in range(3)]
            local = multiply(delta, node['localMatrix'])
            parent = visit(node['parentIndex'])['componentMatrix'] if node['parentIndex'] is not None else IDENTITY
            matrix = multiply(parent, local)
            world = multiply(root_matrix, matrix)
            sample = {'componentId': component['id'], 'nodeIndex': index, 'localMatrix': local,
                      'deltaMatrix': delta, 'componentMatrix': matrix, 'worldMatrix': world,
                      'pivotM': pivot, 'centerM': point(world, centre)}
            local_results[index] = sample
            if node['drawable']:
                result[identifier] = sample
            return sample
        for node in nodes:
            visit(node['nodeIndex'])
    return result
