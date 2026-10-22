/** Edits to the explicit scene graph. Imported world geometry remains one asset. */
export type Vec3 = [number, number, number];
export type RelationType = 'on' | 'beside' | 'inFrontOf' | 'behind';
export type SceneTreeNode = { id: string; label: string; detail?: string; children?: SceneTreeNode[] };
export type ResolvedObjects = { props?: Record<string, { translationM: number[] }>; product?: { translationM: number[] } };

export const relationLabels: Record<RelationType, string> = {
  on: 'On top of', beside: 'Beside', inFrontOf: 'In front of', behind: 'Behind',
};
export const isVisible = (object: any) => object?.visible !== false;
/** World-space half height of a rotated box; matches film/scene_objects.py bounds. */
export function verticalHalfExtent(sizeM: number[], rotationXyzw: number[] = [0, 0, 0, 1]): number {
  const [x, y, z, w] = rotationXyzw;
  return [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)]
    .reduce((sum, coefficient, axis) => sum + Math.abs(coefficient) * sizeM[axis] / 2, 0);
}
/** Top of the plinth, where a product resting on it touches down. */
export function plinthTopY(scene: any): number {
  const plinth = scene.environment.plinth;
  return plinth.translationM[1] + verticalHalfExtent(plinth.sizeM, plinth.rotationXyzw);
}
/**
 * The declared floor, a visible plinth's bottom, or a hidden plinth's top. A
 * hidden plinth (D93) is where the product touches down, so the authored sweep
 * and contact shadow meet the product instead of sitting a plinth below it (D160).
 */
export function sceneFloorY(scene: any): number {
  if (Number.isFinite(scene.environment.floorY)) return scene.environment.floorY;
  const plinth = scene.environment.plinth;
  if (!isVisible(plinth)) return plinthTopY(scene);
  return plinth.translationM[1] - verticalHalfExtent(plinth.sizeM, plinth.rotationXyzw);
}

/**
 * Top-centre of the product's support, as film/scene_objects.py resolves it:
 * the plinth (shown or hidden), the floor, a picked world contact or a prop.
 * A related prop's resolved pose comes from the sample (`sample.props`); without
 * one its authored pose is used.
 */
export function productSupportOrigin(scene: any, props?: Record<string, { translationM: number[]; rotationXyzw?: number[] }>): [number, number, number] {
  const environment = scene.environment;
  const placement = scene.placement;
  if (!environment?.plinth) return [0, 0, 0]; // Product-only previews have no support.
  const support = placement?.restsOn ?? environment.plinth.id;
  if (support === 'floor') return [0, sceneFloorY(scene), 0];
  if (support === 'world-surface' && Array.isArray(placement.contactPointM)) return [...placement.contactPointM] as [number, number, number];
  if (support === environment.plinth.id) {
    const plinth = environment.plinth;
    return [plinth.translationM[0], plinthTopY(scene), plinth.translationM[2]];
  }
  const prop = (environment.props || []).find((item: any) => item.id === support);
  if (!prop) return [0, sceneFloorY(scene), 0];
  const pose = props?.[prop.id] ?? prop;
  return [pose.translationM[0], pose.translationM[1] + verticalHalfExtent(prop.sizeM, pose.rotationXyzw ?? prop.rotationXyzw), pose.translationM[2]];
}

export function objectName(scene: any, id: string): string {
  if (id === 'product') return scene.product.displayName || 'Product';
  if (id === 'floor') return 'Floor';
  if (id === 'world-surface') return 'Picked world surface';
  if (id === scene.environment.plinth.id) return 'Plinth';
  const prop = (scene.environment.props || []).find((item: any) => item.id === id);
  return prop?.name || prop?.id || id;
}

function dependency(scene: any, id: string): string | undefined {
  if (id === 'product') return scene.placement.restsOn;
  return (scene.environment.props || []).find((prop: any) => prop.id === id)?.relationship?.targetId;
}

/** Exclude targets that would introduce a dependency cycle, including via product support. */
export function relationshipTargets(scene: any, forId?: string, relationType?: RelationType): { id: string; label: string }[] {
  const targets = [
    { id: 'floor', label: 'Floor' },
    { id: 'product', label: objectName(scene, 'product') },
    ...(isVisible(scene.environment.plinth) ? [{ id: scene.environment.plinth.id, label: 'Plinth' }] : []),
    ...(scene.environment.props || []).filter(isVisible).map((prop: any) => ({ id: prop.id, label: objectName(scene, prop.id) })),
  ];
  return targets.filter(target => {
    if (relationType && relationType !== 'on' && target.id === 'floor') return false;
    const visited = new Set<string>();
    let id: string | undefined = target.id;
    while (id) {
      if (id === forId || visited.has(id)) return false;
      visited.add(id);
      id = dependency(scene, id);
    }
    return true;
  });
}

export function productSupportTargets(scene: any) {
  const targets = relationshipTargets(scene, 'product');
  if (scene.environment.kind === 'mesh' && Array.isArray(scene.placement.contactPointM))
    targets.splice(1, 0, { id: 'world-surface', label: 'Picked world surface' });
  return targets;
}

export function setProductSupport(scene: any, targetId: string) {
  if (!productSupportTargets(scene).some(target => target.id === targetId)) return;
  scene.placement.restsOn = targetId;
  // Offsets belong to the chosen surface. Start in direct contact when switching.
  scene.placement.translationM = [0, 0, 0];
}

/** A rigid support must have a horizontal top and be visible. */
export function canPropSupportProduct(prop: any): boolean {
  if (!prop || !isVisible(prop)) return false;
  const quaternion = prop.rotationXyzw || [0, 0, 0, 1];
  if (!Array.isArray(quaternion) || quaternion.length !== 4 || !quaternion.every(Number.isFinite)) return false;
  const [x, y, z, w] = quaternion;
  if (Math.abs(x * x + y * y + z * z + w * w - 1) >= 1e-6) return false;
  return Math.abs(2 * (x * y - z * w)) < 1e-6 && Math.abs(2 * (y * z + x * w)) < 1e-6
    && Math.abs(Math.abs(1 - 2 * (x * x + z * z)) - 1) < 1e-6;
}

/** Explicitly reparent the product, breaking a prop's dependency on it first. */
export function usePropAsSupport(scene: any, id: string, resolved?: ResolvedObjects): boolean {
  const prop = (scene.environment.props || []).find((item: any) => item.id === id);
  if (!canPropSupportProduct(prop)) return false;
  const position = resolved?.props?.[id]?.translationM;
  if (Array.isArray(position) && position.length === 3 && position.every(Number.isFinite))
    prop.translationM = [...position];
  const visited = new Set<string>();
  let target: string | undefined = dependency(scene, id);
  while (target && !visited.has(target)) {
    if (target === 'product') {
      // The free prop keeps its world pose while the product moves onto it.
      delete prop.relationship;
      break;
    }
    visited.add(target);
    target = dependency(scene, target);
  }
  setProductSupport(scene, id);
  return scene.placement.restsOn === id;
}

export function setPlinthVisible(scene: any, visible: boolean, resolved?: ResolvedObjects) {
  // Save the old floor before changing the legacy default for visibility.
  scene.environment.floorY = sceneFloorY(scene);
  scene.environment.plinth.visible = visible;
  if (!visible) detachFrom(scene, scene.environment.plinth.id, resolved);
}

/**
 * Stage → Objects "Show plinth" (D93, D160). Hiding keeps the product where it
 * is: a plinth that supports the product becomes an invisible floor at its top.
 * Showing a plinth under a product that rests on the floor stands the plinth
 * on that floor and rests the product on it. Unlike setPlinthVisible (main's
 * add/remove), the product never drops by the plinth's height.
 */
export function setPlinthShown(scene: any, shown: boolean, resolved?: ResolvedObjects) {
  const environment = scene.environment;
  const plinth = environment.plinth;
  if (isVisible(plinth) === shown) return;
  const restsOnPlinth = scene.placement.restsOn === plinth.id;
  if (!shown) {
    // A hidden plinth cannot anchor other objects; they keep their resolved pose.
    for (const prop of environment.props || []) {
      if (prop.relationship?.targetId !== plinth.id) continue;
      const position = resolved?.props?.[prop.id]?.translationM;
      if (position) prop.translationM = [...position];
      delete prop.relationship;
    }
    if (restsOnPlinth) {
      // The floor meets the product's contact height (the default when undeclared).
      if (Number.isFinite(environment.floorY)) environment.floorY = plinthTopY(scene);
    } else if (!Number.isFinite(environment.floorY)) {
      environment.floorY = sceneFloorY(scene); // Nothing else moves.
    }
    plinth.visible = false;
    return;
  }
  if (!restsOnPlinth && scene.placement.restsOn === 'floor') {
    const floor = sceneFloorY(scene);
    const height = verticalHalfExtent(plinth.sizeM, plinth.rotationXyzw);
    const [x, , z] = scene.placement.translationM;
    environment.floorY = floor;
    plinth.translationM = [x, floor + height, z];
    scene.placement.restsOn = plinth.id;
    scene.placement.translationM = [0, scene.placement.translationM[1], 0];
  } else if (restsOnPlinth && Number.isFinite(environment.floorY)
      && Math.abs(environment.floorY - plinthTopY(scene)) < 1e-9) {
    // Undo a hide: the floor returns beneath the plinth.
    delete environment.floorY;
  }
  plinth.visible = true;
}

function detachFrom(scene: any, targetId: string, resolved?: ResolvedObjects) {
  for (const prop of scene.environment.props || []) {
    if (prop.relationship?.targetId !== targetId) continue;
    const position = resolved?.props?.[prop.id]?.translationM;
    if (position) prop.translationM = [...position];
    delete prop.relationship;
  }
  if (scene.placement.restsOn === targetId) {
    scene.placement.restsOn = 'floor';
    const position = resolved?.product?.translationM;
    // A removed support returns the product to the floor without a dangling reference.
    scene.placement.translationM = [position?.[0] ?? scene.placement.translationM[0], 0,
      position?.[2] ?? scene.placement.translationM[2]];
  }
}

export function removeSceneProp(scene: any, id: string, resolved?: ResolvedObjects) {
  detachFrom(scene, id, resolved);
  scene.environment.props = (scene.environment.props || []).filter((prop: any) => prop.id !== id);
}

export function addSceneProp(scene: any, shape: 'box' | 'cylinder'): string {
  const props = scene.environment.props ??= [];
  const taken = new Set(['product', 'floor', 'world-surface', scene.environment.plinth.id,
    ...scene.product.components.map((component: any) => component.id), ...props.map((prop: any) => prop.id)]);
  let suffix = 1;
  while (taken.has(`prop-${suffix}`)) suffix++;
  const id = `prop-${suffix}`;
  const scale = Math.max(...scene.product.dimensionsM);
  const width = Math.max(.005, scale * .6);
  const height = Math.max(.005, scale * .4);
  props.push({ id, name: `${shape === 'box' ? 'Box' : 'Cylinder'} ${suffix}`, shape,
    sizeM: [width, height, width], translationM: [0, sceneFloorY(scene) + height / 2, 0],
    rotationXyzw: [0, 0, 0, 1], material: { baseColor: [.55, .55, .55, 1], roughness: .65, metallic: 0 },
    relationship: { type: 'beside', targetId: 'product', gapM: scale * .25, offsetM: [0, 0, 0] },
  });
  return id;
}

export function setPropRelationship(scene: any, id: string, type: RelationType | 'free', targetId?: string) {
  const prop = (scene.environment.props || []).find((item: any) => item.id === id);
  if (!prop) return;
  if (type === 'free') { delete prop.relationship; return; }
  const targets = relationshipTargets(scene, id, type);
  const target = targets.find(item => item.id === targetId) ?? targets[0];
  if (!target) return;
  prop.relationship = { type, targetId: target.id, gapM: prop.relationship?.gapM ?? 0,
    offsetM: [...(prop.relationship?.offsetM ?? [0, 0, 0])] };
}

export function setPropSize(prop: any, axis: number, value: number) {
  prop.sizeM[axis] = value;
  if (prop.shape === 'cylinder' && (axis === 0 || axis === 2)) prop.sizeM[axis === 0 ? 2 : 0] = value;
  if (prop.bevelM !== undefined) prop.bevelM = Math.min(prop.bevelM, Math.min(...prop.sizeM) / 2);
}

export const yawDegrees = (quaternion: number[] = [0, 0, 0, 1]) =>
  Math.atan2(2 * (quaternion[3] * quaternion[1] + quaternion[0] * quaternion[2]),
    1 - 2 * (quaternion[1] ** 2 + quaternion[2] ** 2)) * 180 / Math.PI;
export const yawQuaternion = (degrees: number) => [0, Math.sin(degrees * Math.PI / 360), 0, Math.cos(degrees * Math.PI / 360)];

export function sceneTree(scene: any): SceneTreeNode[] {
  const props = scene.environment.props || [];
  return [
    { id: 'product-root', label: scene.product.displayName || 'Product',
      detail: `On ${objectName(scene, scene.placement.restsOn)}`,
      children: scene.product.components.map((component: any) => ({ id: component.id,
        label: component.name || component.id, detail: component.shape === 'mesh' ? 'Imported mesh' : component.shape,
        children: (scene.actions || []).filter((action: any) => action.componentId === component.id).map((action: any) => ({
          id: `action:${action.actionId}`, label: action.type === 'lift' ? 'Lift action' : `${action.type} action`,
          detail: `${action.startSeconds}s · ${action.durationSeconds}s`,
        })),
      })) },
    { id: 'environment-root', label: 'Environment', children: [
      { id: 'world', label: scene.environment.displayName || 'Authored studio',
        detail: scene.environment.kind === 'mesh' ? 'World mesh' : scene.environment.kind === 'splat' ? 'Gaussian world' : 'Studio' },
      { id: 'floor', label: 'Floor', detail: `${Number(sceneFloorY(scene).toFixed(4))} m` },
      ...(isVisible(scene.environment.plinth) ? [{ id: `plinth:${scene.environment.plinth.id}`, label: 'Plinth', detail: 'Optional support' }] : []),
      ...props.map((prop: any) => ({ id: `prop:${prop.id}`, label: objectName(scene, prop.id),
        detail: !isVisible(prop) ? 'Hidden' : prop.relationship
          ? `${relationLabels[prop.relationship.type as RelationType] || prop.relationship.type} ${objectName(scene, prop.relationship.targetId)}`
          : 'Free placement' })),
    ] },
    { id: 'cameras-root', label: 'Cameras', children: scene.shots.map((shot: any) => ({
      id: `camera:${shot.id}`, label: shot.name, detail: `Frames ${shot.startFrame}–${shot.endFrame}`,
    })) },
  ];
}
