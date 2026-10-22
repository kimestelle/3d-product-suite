import {Box3, Matrix4, PerspectiveCamera, Vector3, Vector4, type Object3D} from 'three';
import {PRODUCT_SCALE_MAX, PRODUCT_SCALE_MIN, PRODUCT_SCALE_RANGE_MESSAGE} from './transforms';

export interface ProductFitRect {left: number; right: number; bottom: number; top: number}
export interface ProductWorldFit {
  /** Multiplies the current pose; source geometry and dimensions stay unchanged. */
  multiplier: number;
  targetRect: ProductFitRect;
  scaledDimensions: [number, number, number];
}

const FIT_INSET = .1;
const EPSILON = 1e-10;
const SCALE_MESSAGE = PRODUCT_SCALE_RANGE_MESSAGE;
const SUPPORT_MESSAGE = 'Move the product support into the visible world before fitting its size.';

function finiteVector(value: Vector3): boolean {
  return !!value && [value.x, value.y, value.z].every(Number.isFinite);
}

function checkedBox(box: Box3 | null, name: string): Box3 {
  if (!box || !finiteVector(box.min) || !finiteVector(box.max) || box.isEmpty()
      || !finiteVector(box.getSize(new Vector3())) || box.getSize(new Vector3()).lengthSq() === 0) throw new Error(`${name} has no finite bounds to fit.`);
  return box;
}

function corners(box: Box3): Vector3[] {
  return Array.from({length: 8}, (_, index) => new Vector3(
    index & 1 ? box.max.x : box.min.x,
    index & 2 ? box.max.y : box.min.y,
    index & 4 ? box.max.z : box.min.z,
  ));
}

/** Resolve fresh transforms without calling updateWorldMatrix on the live camera. */
function worldMatrix(object: Object3D): Matrix4 {
  if (!object.matrixWorldAutoUpdate) return object.matrixWorld.clone();
  const local = object.matrixAutoUpdate
    ? new Matrix4().compose(object.position, object.quaternion, object.scale) : object.matrix.clone();
  return object.parent ? worldMatrix(object.parent).multiply(local) : local;
}

function cameraMatrices(camera: PerspectiveCamera): {view: Matrix4; projection: Matrix4; position: Vector3} {
  if (!camera?.isPerspectiveCamera || ![camera.near, camera.far, camera.fov, camera.aspect, camera.zoom].every(Number.isFinite)
      || camera.near <= 0 || camera.far <= camera.near || camera.fov <= 0 || camera.fov >= 180 || camera.aspect <= 0 || camera.zoom <= 0) {
    throw new Error('Wait for a valid perspective camera before fitting the product.');
  }
  const world = worldMatrix(camera);
  if (!world.elements.every(Number.isFinite) || !Number.isFinite(world.determinant()) || world.determinant() === 0) {
    throw new Error('The camera transform cannot be used to fit the product.');
  }
  const frozen = camera.clone(false);
  frozen.updateProjectionMatrix();
  if (!frozen.projectionMatrix.elements.every(Number.isFinite)) throw new Error('The camera projection is invalid.');
  return {view: world.clone().invert(), projection: frozen.projectionMatrix.clone(), position: new Vector3().setFromMatrixPosition(world)};
}

/** Project only the part of the box between the near and far planes. Edges
 * crossing the near plane contribute their intersection, never an infinite NDC. */
function projectedWorldRect(world: Box3, camera: PerspectiveCamera, view: Matrix4, projection: Matrix4, position: Vector3): ProductFitRect {
  const points = corners(world).map(point => point.applyMatrix4(view));
  const visible = points.filter(point => point.z <= -camera.near && point.z >= -camera.far);
  for (let index = 0; index < 8; index++) for (const bit of [1, 2, 4]) {
    if (index & bit) continue;
    const a = points[index], b = points[index | bit];
    for (const depth of [-camera.near, -camera.far]) {
      if ((a.z < depth && b.z > depth) || (b.z < depth && a.z > depth)) {
        const t = (depth - a.z) / (b.z - a.z);
        visible.push(a.clone().lerp(b, t));
      }
    }
  }
  if (!visible.length) throw new Error('The generated world is outside the camera view.');
  if (world.containsPoint(position)) return {left: -1, right: 1, bottom: -1, top: 1};
  const rect = {left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity};
  for (const point of visible) {
    const clip = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(projection);
    if (![clip.x, clip.y, clip.w].every(Number.isFinite) || clip.w <= 0) throw new Error('The generated world cannot be projected into this view.');
    const x = clip.x / clip.w, y = clip.y / clip.w;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('The generated world cannot be projected into this view.');
    rect.left = Math.min(rect.left, x); rect.right = Math.max(rect.right, x);
    rect.bottom = Math.min(rect.bottom, y); rect.top = Math.max(rect.top, y);
  }
  rect.left = Math.max(-1, rect.left); rect.right = Math.min(1, rect.right);
  rect.bottom = Math.max(-1, rect.bottom); rect.top = Math.min(1, rect.top);
  if (rect.right <= rect.left || rect.top <= rect.bottom) throw new Error('The generated world is outside the camera view.');
  return rect;
}

/** Fit the posed product into the visible world's projected rectangle, with a
 * 10% inset on each edge. Every corner follows pivot + multiplier * (corner -
 * pivot), so each camera-frustum constraint is linear in the multiplier.
 * Solving those inequalities avoids a binary-search ceiling and stays
 * idempotent for very small, large, deep, or off-axis products. */
export function fitProductToWorld(camera: PerspectiveCamera, worldBounds: Box3 | null, productBounds: Box3,
  pivot: Vector3, currentScale: number): ProductWorldFit {
  const world = checkedBox(worldBounds, 'The generated world');
  const product = checkedBox(productBounds, 'The product');
  if (!finiteVector(pivot)) throw new Error('The product support position is invalid.');
  if (!Number.isFinite(currentScale) || currentScale < PRODUCT_SCALE_MIN || currentScale > PRODUCT_SCALE_MAX) throw new Error(SCALE_MESSAGE);
  const {view, projection, position} = cameraMatrices(camera);
  const visible = projectedWorldRect(world, camera, view, projection, position);
  const insetX = (visible.right - visible.left) * FIT_INSET, insetY = (visible.top - visible.bottom) * FIT_INSET;
  const targetRect = {left: visible.left + insetX, right: visible.right - insetX,
    bottom: visible.bottom + insetY, top: visible.top - insetY};
  const pivotView = pivot.clone().applyMatrix4(view);
  const pivotClip = new Vector4(pivotView.x, pivotView.y, pivotView.z, 1).applyMatrix4(projection);
  if (!finiteVector(pivotView) || !pivotClip.toArray().every(Number.isFinite) || pivotView.z > -camera.near || pivotView.z < -camera.far || pivotClip.w <= 0
      || pivotClip.x / pivotClip.w < targetRect.left - EPSILON || pivotClip.x / pivotClip.w > targetRect.right + EPSILON
      || pivotClip.y / pivotClip.w < targetRect.bottom - EPSILON || pivotClip.y / pivotClip.w > targetRect.top + EPSILON) throw new Error(SUPPORT_MESSAGE);

  let maximum = PRODUCT_SCALE_MAX / currentScale;
  const minimum = PRODUCT_SCALE_MIN / currentScale;
  const constrain = (atPivot: number, atCorner: number) => {
    // Pivot was checked above. Remove only its subpixel floating-point residue.
    const b = Math.min(0, atPivot);
    const a = atCorner - atPivot;
    if (a > 0) maximum = Math.min(maximum, -b / a);
  };
  for (const corner of corners(product)) {
    const point = corner.applyMatrix4(view);
    const clip = new Vector4(point.x, point.y, point.z, 1).applyMatrix4(projection);
    if (!finiteVector(point) || !clip.toArray().every(Number.isFinite)) throw new Error('The product bounds cannot be projected into this view.');
    constrain(targetRect.left * pivotClip.w - pivotClip.x, targetRect.left * clip.w - clip.x);
    constrain(pivotClip.x - targetRect.right * pivotClip.w, clip.x - targetRect.right * clip.w);
    constrain(targetRect.bottom * pivotClip.w - pivotClip.y, targetRect.bottom * clip.w - clip.y);
    constrain(pivotClip.y - targetRect.top * pivotClip.w, clip.y - targetRect.top * clip.w);
    constrain(camera.near + pivotView.z, camera.near + point.z);
    constrain(-camera.far - pivotView.z, -camera.far - point.z);
  }
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error(SUPPORT_MESSAGE);
  if (maximum < minimum * (1 - EPSILON)) throw new Error(SCALE_MESSAGE);
  const multiplier = Math.abs(maximum - 1) <= EPSILON ? 1 : Math.max(minimum, maximum);
  return {multiplier, targetRect, scaledDimensions: product.getSize(new Vector3()).multiplyScalar(multiplier).toArray() as [number, number, number]};
}

function fittedScale(value: number, multiplier: number): number {
  if (!Number.isFinite(value) || value < PRODUCT_SCALE_MIN || value > PRODUCT_SCALE_MAX) throw new Error(SCALE_MESSAGE);
  const next = value * multiplier;
  if (!Number.isFinite(next) || next < PRODUCT_SCALE_MIN * (1 - EPSILON) || next > PRODUCT_SCALE_MAX * (1 + EPSILON)) throw new Error(SCALE_MESSAGE);
  return Math.min(PRODUCT_SCALE_MAX, Math.max(PRODUCT_SCALE_MIN, next));
}

/** Commit the fit to authored state, including disabled absolute scale keys so
 * enabling one later does not restore the old size. Film scale motion amounts
 * are relative multipliers and deliberately keep their authored values. */
export function applyProductWorldFit<T>(scene: T, multiplier: number): T {
  const source = scene as any;
  if (!source?.placement || !Number.isFinite(multiplier) || multiplier <= 0) throw new Error('The product fit must be a positive finite scale.');
  const scale = fittedScale(source.placement.scale ?? 1, multiplier);
  const tracks = source.animation?.tracks ?? [];
  if (!Array.isArray(tracks)) throw new Error('The product animation tracks are invalid.');
  const updates = tracks.flatMap((track: any, index: number) => {
    if (track?.componentId !== '$product' || track.property !== 'scale') return [];
    if (!Array.isArray(track.keys)) throw new Error('The product scale keys are invalid.');
    return [{index, values: track.keys.map((key: any) => fittedScale(key?.value, multiplier))}];
  });
  const next = structuredClone(scene) as any;
  if (multiplier !== 1) {
    next.placement.scale = scale;
    for (const update of updates) update.values.forEach((value: number, index: number) => {next.animation.tracks[update.index].keys[index].value = value;});
  }
  return next;
}
