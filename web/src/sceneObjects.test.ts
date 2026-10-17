import { describe, expect, it } from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import { addSceneProp, canPropSupportProduct, productSupportTargets, relationshipTargets, removeSceneProp, sceneFloorY, sceneTree,
  setPlinthVisible, setProductSupport, setPropRelationship, setPropSize, usePropAsSupport, yawDegrees, yawQuaternion } from './sceneObjects';

function scene(): any { return structuredClone(fixture); }

describe('explicit scene object editing', () => {
  it('adds only the requested primitive beside the product, without enabling a plinth or changing assets', () => {
    const current = scene();
    current.environment.plinth.visible = false;
    const asset = current.environment.asset = { sha256: 'original-world', url: '/world.glb' };
    const product = JSON.stringify(current.product);
    const id = addSceneProp(current, 'cylinder');
    const prop = current.environment.props[0];
    expect(prop.id).toBe(id);
    expect(prop.shape).toBe('cylinder');
    expect(prop.sizeM[0]).toBe(prop.sizeM[2]);
    expect(prop.relationship).toEqual({ type: 'beside', targetId: 'product', gapM: .137 * .25, offsetM: [0, 0, 0] });
    expect(prop.sizeM[0]).toBeCloseTo(.137 * .6);
    expect(current.environment.plinth.visible).toBe(false);
    expect(current.environment.asset).toBe(asset);
    expect(JSON.stringify(current.product)).toBe(product);
  });

  it('uses stable distinct IDs even when existing components occupy primitive names', () => {
    const current = scene();
    current.product.components[0].id = 'prop-1';
    expect(addSceneProp(current, 'box')).toBe('prop-2');
    expect(addSceneProp(current, 'cylinder')).toBe('prop-3');
    removeSceneProp(current, 'prop-2');
    expect(current.environment.props.map((prop: any) => prop.id)).toEqual(['prop-3']);
  });

  it('rests the product on a new prop without creating a cycle or changing the prop world pose', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    const prop = current.environment.props[0];
    const sourceMaterial = prop.material;
    const position = [.35, .12, -.4];
    const resolved = { props: { [id]: { translationM: position } } };
    expect(productSupportTargets(current).some(target => target.id === id)).toBe(false);
    expect(usePropAsSupport(current, id, resolved)).toBe(true);
    expect(prop.translationM).toEqual(position);
    expect(prop.translationM).not.toBe(position);
    expect(prop.relationship).toBeUndefined();
    expect(prop.material).toBe(sourceMaterial);
    expect(current.placement).toMatchObject({ restsOn: id, translationM: [0, 0, 0] });
    expect(productSupportTargets(current).some(target => target.id === id)).toBe(true);
    expect(relationshipTargets(current, id).map(target => target.id)).not.toContain('product');
  });

  it('breaks a transitive product dependency while leaving its other objects intact', () => {
    const current = scene();
    const a = addSceneProp(current, 'box');
    const b = addSceneProp(current, 'cylinder');
    setPropRelationship(current, b, 'on', a);
    const parentRelation = structuredClone(current.environment.props[0].relationship);
    expect(usePropAsSupport(current, b, { props: { [b]: { translationM: [.2, .8, -.1] } } })).toBe(true);
    expect(current.environment.props[1].relationship).toBeUndefined();
    expect(current.environment.props[1].translationM).toEqual([.2, .8, -.1]);
    expect(current.environment.props[0].relationship).toEqual(parentRelation);
    expect(current.placement.restsOn).toBe(b);
  });

  it('retains an independent floor relationship when using a prop as a support', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    setPropRelationship(current, id, 'on', 'floor');
    const relation = structuredClone(current.environment.props[0].relationship);
    expect(usePropAsSupport(current, id)).toBe(true);
    expect(current.environment.props[0].relationship).toEqual(relation);
    expect(current.placement).toMatchObject({ restsOn: id, translationM: [0, 0, 0] });
  });

  it('uses authored position as a fallback and rejects hidden or tilted supports without mutations', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    const prop = current.environment.props[0];
    const authored = [...prop.translationM];
    expect(usePropAsSupport(current, id)).toBe(true);
    expect(prop.translationM).toEqual(authored);
    prop.rotationXyzw = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
    expect(canPropSupportProduct(prop)).toBe(false);
    current.placement.restsOn = 'floor';
    const before = JSON.stringify(current);
    expect(usePropAsSupport(current, id)).toBe(false);
    expect(JSON.stringify(current)).toBe(before);
    prop.rotationXyzw = yawQuaternion(37);
    expect(canPropSupportProduct(prop)).toBe(true);
    prop.visible = false;
    expect(canPropSupportProduct(prop)).toBe(false);
    expect(usePropAsSupport(current, id)).toBe(false);
    expect(current.placement.restsOn).toBe('floor');
  });

  it('keeps cylinder diameters coupled and clamps bevels when dimensions shrink', () => {
    const prop = { shape: 'cylinder', sizeM: [1, 1, 1], bevelM: .1 };
    setPropSize(prop, 2, .06);
    expect(prop.sizeM).toEqual([.06, 1, .06]);
    expect(prop.bevelM).toBe(.03);
    setPropSize(prop, 1, .01);
    expect(prop.sizeM).toEqual([.06, .01, .06]);
    expect(prop.bevelM).toBe(.005);
  });

  it('filters both direct and transitive cycles, including dependencies through product support', () => {
    const current = scene();
    const a = addSceneProp(current, 'box');
    const b = addSceneProp(current, 'box');
    setPropRelationship(current, a, 'free');
    setPropRelationship(current, b, 'on', a);
    current.placement.restsOn = b;
    const forA = relationshipTargets(current, a).map(target => target.id);
    expect(forA).not.toContain(a);
    expect(forA).not.toContain(b);
    expect(forA).not.toContain('product');
    expect(forA).toContain('floor');
    expect(productSupportTargets(current).map(target => target.id)).toContain(a);
  });

  it('offers floor only for an on-top relationship and switches to a valid target when changing type', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    setPropRelationship(current, id, 'on', 'floor');
    expect(current.environment.props[0].relationship.targetId).toBe('floor');
    expect(relationshipTargets(current, id, 'behind').map(target => target.id)).not.toContain('floor');
    setPropRelationship(current, id, 'behind', 'floor');
    expect(current.environment.props[0].relationship).toMatchObject({ type: 'behind', targetId: 'product' });
  });

  it('removes a support safely and freezes dependent props at the last resolved position', () => {
    const current = scene();
    const support = addSceneProp(current, 'box');
    const dependent = addSceneProp(current, 'cylinder');
    setPropRelationship(current, support, 'free');
    setPropRelationship(current, dependent, 'on', support);
    current.placement.restsOn = support;
    const resolved = { product: { translationM: [.4, .9, -.3] }, props: { [dependent]: { translationM: [.2, .5, -.7] } } };
    removeSceneProp(current, support, resolved);
    expect(current.environment.props).toHaveLength(1);
    expect(current.environment.props[0]).toMatchObject({ id: dependent, translationM: [.2, .5, -.7] });
    expect(current.environment.props[0].relationship).toBeUndefined();
    expect(current.placement).toMatchObject({ restsOn: 'floor', translationM: [.4, 0, -.3] });
  });

  it('can remove a relationship without losing source geometry, materials, or absolute placement', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    const before = structuredClone(current.environment.props[0]);
    setPropRelationship(current, id, 'free');
    const prop = current.environment.props[0];
    expect(prop.relationship).toBeUndefined();
    expect(prop.sizeM).toEqual(before.sizeM);
    expect(prop.material).toEqual(before.material);
    expect(prop.translationM).toEqual(before.translationM);
  });

  it('preserves the legacy floor when the optional plinth is removed and severs its links', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    setPropRelationship(current, id, 'on', 'plinth');
    expect(sceneFloorY(current)).toBeCloseTo(-.07);
    setPlinthVisible(current, false);
    expect(current.environment.floorY).toBeCloseTo(-.07);
    expect(sceneFloorY(current)).toBeCloseTo(-.07);
    expect(current.environment.plinth.visible).toBe(false);
    expect(current.placement.restsOn).toBe('floor');
    expect(current.environment.props[0].relationship).toBeUndefined();
    expect(productSupportTargets(current).map(target => target.id)).not.toContain('plinth');
    setPlinthVisible(current, true);
    expect(current.placement.restsOn).toBe('floor');
    expect(productSupportTargets(current).map(target => target.id)).toContain('plinth');
  });

  it('only enables world surface support after a mesh contact point has been picked', () => {
    const current = scene();
    current.environment.kind = 'mesh';
    expect(productSupportTargets(current).some(target => target.id === 'world-surface')).toBe(false);
    current.placement.contactPointM = [.2, 1, -.7];
    expect(productSupportTargets(current).some(target => target.id === 'world-surface')).toBe(true);
    setProductSupport(current, 'world-surface');
    expect(current.placement).toMatchObject({ restsOn: 'world-surface', translationM: [0, 0, 0], contactPointM: [.2, 1, -.7] });
    current.environment.kind = 'splat';
    expect(productSupportTargets(current).some(target => target.id === 'world-surface')).toBe(false);
  });

  it('declines invalid product support and starts valid support changes in direct contact', () => {
    const current = scene();
    const id = addSceneProp(current, 'box'); // Related to product, so it cannot support it.
    const placement = structuredClone(current.placement);
    setProductSupport(current, id);
    expect(current.placement).toEqual(placement);
    current.placement.translationM = [1, 2, 3];
    setProductSupport(current, 'floor');
    expect(current.placement).toMatchObject({ restsOn: 'floor', translationM: [0, 0, 0] });
  });

  it('represents the real hierarchy and actions without inventing world segmentation', () => {
    const current = scene();
    current.environment.kind = 'mesh';
    current.environment.displayName = 'Imported room';
    current.environment.plinth.visible = false;
    const prop = addSceneProp(current, 'box');
    const tree = sceneTree(current);
    expect(tree[0].id).toBe('product-root');
    expect(tree[0].children?.map(node => node.id)).toEqual(current.product.components.map((component: any) => component.id));
    expect(tree[0].children?.find(node => node.id === 'cap')?.children?.[0]).toMatchObject({ id: 'action:cap-lift-v1', label: 'Lift action' });
    const world = tree[1].children?.find(node => node.id === 'world');
    expect(world).toEqual({ id: 'world', label: 'Imported room', detail: 'World mesh' });
    expect(tree[1].children?.some(node => node.id === 'plinth:plinth')).toBe(false);
    expect(tree[1].children?.find(node => node.id === `prop:${prop}`)?.detail).toBe('Beside Product');
    expect(tree[2].children?.map(node => node.id)).toEqual(current.shots.map((shot: any) => `camera:${shot.id}`));
  });

  it('round-trips yaw rotations used by the object controls', () => {
    for (const angle of [-170, -90, 0, 45, 150]) expect(yawDegrees(yawQuaternion(angle))).toBeCloseTo(angle);
  });
});
