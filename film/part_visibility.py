"""Scene-owned removal of product geometry without rewriting the source asset.

Removed identities stay in the authored graph so motion, camera targets and Undo
can recover them. Only the rendered geometry and its attached surfaces disappear.
Editorial groups are resolved by the editor into explicit IDs at removal time;
physical source descendants always inherit removal.
"""


def validate_removed_parts(scene):
    product = scene['product']
    removed = product.get('removedPartIds', [])
    if not isinstance(removed, list) or len(removed) > 100000:
        raise ValueError('Removed parts must be a list of at most 100000 IDs')
    valid = {component['id'] for component in product['components']}
    valid.update(f"{component['id']}::node:{node['nodeIndex']}"
                 for component in product['components'] for node in component.get('sourceNodes', [])
                 if node['drawable'])
    seen = set()
    for identifier in removed:
        if not isinstance(identifier, str) or identifier not in valid:
            raise ValueError('Removed part target does not exist')
        if identifier in seen:
            raise ValueError('Removed part IDs must be unique')
        seen.add(identifier)


def removed_part_ids(scene):
    """Expand a validated removal list in component/source catalog order.

    Native parents determine physical inheritance, independent of editable tree
    grouping. Include the component itself when removed so renderers suppress
    procedural text and any attachments as well as imported mesh nodes.
    """
    requested = set(scene['product'].get('removedPartIds', []))
    if not requested:
        return []
    result = []
    for component in scene['product']['components']:
        component_id = component['id']
        whole = component_id in requested
        if whole:
            result.append(component_id)
        nodes = component.get('sourceNodes', [])
        children = {}
        for node in nodes:
            children.setdefault(node['parentIndex'], []).append(node['nodeIndex'])
        removed_nodes = {node['nodeIndex'] for node in nodes} if whole else set()
        pending = [] if whole else [node['nodeIndex'] for node in nodes
                                   if f"{component_id}::node:{node['nodeIndex']}" in requested]
        while pending:
            index = pending.pop()
            if index in removed_nodes:
                continue
            removed_nodes.add(index)
            pending.extend(children.get(index, ()))
        for node in nodes:
            if node['drawable'] and node['nodeIndex'] in removed_nodes:
                result.append(f"{component_id}::node:{node['nodeIndex']}")
    return result
