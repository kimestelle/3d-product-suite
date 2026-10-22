import {Box3, Matrix4, Quaternion, Vector3} from 'three';
import type {CameraPose, DepthOfFieldSettings} from './camera';
import {removedPartIds, sourcePartId, type SourceNode} from './partTargets';

export type RandomCameraView = 'front' | 'three-quarter' | 'detail';
export const MAX_RANDOM_ORBIT_DEGREES = 32;
export const MAX_RANDOM_PUSH_FRACTION = .2;
export const RANDOM_FULL_FRAME_INSET = .76;
export const RANDOM_DETAIL_OCCUPANCY = 1.4;
// Match the production preview near plane; closer geometry cannot be shown.
const NEAR_M = .001;
const radians = (degrees: number) => degrees * Math.PI / 180;

/** Conservative source bounds, including placement, assembly and static part edits.
 * Imported metadata is already measured in metres; no meshes or authored motion are evaluated. */
export function productBounds(scene: any): Box3 {
  const bounds = new Box3(), removed = removedPartIds(scene), support = scene.environment.plinth;
  const origin = new Vector3().fromArray(support.translationM);
  origin.y += support.sizeM[1] / 2;
  origin.add(new Vector3().fromArray(scene.placement.translationM));
  for (const part of scene.product.components) {
    if (removed.has(part.id)) continue;
    const rotation = new Quaternion().fromArray(part.assembly.rotationXyzw);
    const componentMatrix = new Matrix4().compose(
      new Vector3().fromArray(part.assembly.translationM).multiplyScalar(scene.placement.scale ?? 1).add(origin),
      rotation, new Vector3().setScalar((part.assembly.scale ?? 1) * (scene.placement.scale ?? 1)));
    if (part.sourceNodes?.length) {
      const nodes: SourceNode[] = part.sourceNodes, byId = new Map(nodes.map(node => [node.nodeIndex, node]));
      const matrices = new Map<number, Matrix4>();
      const matrixFor = (index: number): Matrix4 => {
        const existing = matrices.get(index); if (existing) return existing;
        const node = byId.get(index)!, source = new Matrix4().fromArray(node.localMatrix), pose = part.partTransforms?.[String(index)];
        const local = source.clone();
        if (pose) {
          // Same source-parent-space pivot delta as film.part_motion.evaluate_parts.
          const centre = new Vector3().fromArray(node.boundsM[0]).add(new Vector3().fromArray(node.boundsM[1])).multiplyScalar(.5);
          const pivot = pose.pivotM ? new Vector3().fromArray(pose.pivotM) : centre.applyMatrix4(source);
          const delta = new Matrix4().compose(new Vector3(), new Quaternion().fromArray(pose.rotationXyzw), new Vector3().setScalar(pose.scale ?? 1));
          delta.setPosition(new Vector3().fromArray(pose.translationM).add(pivot).sub(pivot.clone().applyMatrix4(delta)));
          local.premultiply(delta);
        }
        const matrix = (node.parentIndex === null ? componentMatrix : matrixFor(node.parentIndex)).clone().multiply(local);
        matrices.set(index, matrix); return matrix;
      };
      for (const node of nodes) {
        if (!node.hasMesh || removed.has(sourcePartId(part.id, node.nodeIndex))) continue;
        const nodeBounds = new Box3(new Vector3().fromArray(node.boundsM[0]), new Vector3().fromArray(node.boundsM[1]));
        for (const corner of corners(nodeBounds)) bounds.expandByPoint(corner.applyMatrix4(matrixFor(node.nodeIndex)));
      }
      continue;
    }
    for (const x of [-.5, .5]) for (const y of [-.5, .5]) for (const z of [-.5, .5]) {
      const point = new Vector3(x * part.sizeM[0], y * part.sizeM[1], z * part.sizeM[2]);
      bounds.expandByPoint(point.applyMatrix4(componentMatrix));
    }
  }
  if (bounds.isEmpty() || !bounds.min.toArray().concat(bounds.max.toArray()).every(Number.isFinite)
    || bounds.getSize(new Vector3()).lengthSq() === 0) throw new Error('Keep at least one visible product part before generating shots.');
  return bounds;
}

function corners(bounds: Box3): Vector3[] {
  return Array.from({length: 8}, (_, i) => new Vector3(i & 1 ? bounds.max.x : bounds.min.x,
    i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z));
}
function backward(yaw: number, elevation: number) {
  return new Vector3(Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation), Math.cos(yaw) * Math.cos(elevation));
}

/** Maximum of a*sin(yaw)+b*cos(yaw)+c over the complete orbit interval. */
function arcMaximum(a: number, b: number, c: number, start: number, end: number): number {
  const values = [a * Math.sin(start) + b * Math.cos(start) + c, a * Math.sin(end) + b * Math.cos(end) + c];
  const peak = Math.atan2(a, b);
  if (Math.ceil((start - peak) / (2 * Math.PI)) <= Math.floor((end - peak) / (2 * Math.PI))) values.push(Math.hypot(a, b) + c);
  return Math.max(...values);
}

function fitDistance(points: Vector3[], yaw: number, elevation: number, tanH: number, tanV: number, sweep = 0): number {
  const se = Math.sin(elevation), ce = Math.cos(elevation), margin = RANDOM_FULL_FRAME_INSET;
  let distance = 0;
  for (const q of points) {
    // depth >= |projected coordinate| / FOV. Both signs give analytic orbit bounds.
    for (const sign of [-1, 1]) distance = Math.max(distance,
      arcMaximum(q.x * ce - sign * q.z / (margin * tanH), q.z * ce + sign * q.x / (margin * tanH), q.y * se, yaw - sweep, yaw + sweep),
      arcMaximum(q.x * (ce - sign * se / (margin * tanV)), q.z * (ce - sign * se / (margin * tanV)), q.y * (se + sign * ce / (margin * tanV)), yaw - sweep, yaw + sweep));
    distance = Math.max(distance, arcMaximum(q.x * ce, q.z * ce, q.y * se + NEAR_M * 1.05, yaw - sweep, yaw + sweep));
  }
  return distance;
}

export type ProjectedProductBounds = {left: number; right: number; bottom: number; top: number; minDepth: number; width: number; height: number; occupancy: number};

/** Edges are NDC; width/height/occupancy are fractions of the final output frame. */
export function projectedProductBounds(bounds: Box3, pose: CameraPose, aspect: number): ProjectedProductBounds {
  const position = new Vector3().fromArray(pose.positionM), target = new Vector3().fromArray(pose.targetM);
  const back = position.clone().sub(target).normalize(), right = new Vector3(0, 1, 0).cross(back).normalize(), up = back.clone().cross(right);
  const tanV = 18 / pose.focalLengthMm, tanH = tanV * aspect;
  let left = Infinity, bottom = Infinity, rightEdge = -Infinity, top = -Infinity, minDepth = Infinity;
  for (const point of corners(bounds)) {
    const delta = point.sub(position), depth = -delta.dot(back);
    minDepth = Math.min(minDepth, depth);
    const x = delta.dot(right) / (depth * tanH), y = delta.dot(up) / (depth * tanV);
    left = Math.min(left, x); rightEdge = Math.max(rightEdge, x); bottom = Math.min(bottom, y); top = Math.max(top, y);
  }
  const width = (rightEdge - left) / 2, height = (top - bottom) / 2;
  return {left, right: rightEdge, bottom, top, minDepth, width, height, occupancy: Math.max(width, height)};
}

/** A push may stop before its target while still crossing the product's near face. */
export function isRandomCameraPoseSafe(bounds: Box3, pose: CameraPose, aspect: number, camera?: {depthOfField?: DepthOfFieldSettings}): boolean {
  const projection = projectedProductBounds(bounds, pose, aspect);
  if (!Object.values(projection).every(Number.isFinite) || projection.minDepth <= NEAR_M) return false;
  const optics = camera?.depthOfField;
  if (!optics?.enabled) return true;
  const focusDistance = optics.focusDistanceM ?? new Vector3().fromArray(pose.positionM).distanceTo(new Vector3().fromArray(pose.targetM));
  return focusDistance > pose.focalLengthMm / 1000;
}

/** Use the real 36mm vertical camera gate. Full shots retain a margin through
 * a ±32° orbit OR a 20% push. Close-ups target 140% frame occupancy. */
export function randomCameraPose(scene: any, view: RandomCameraView, camera?: {depthOfField?: DepthOfFieldSettings}): CameraPose {
  const bounds = productBounds(scene), size = bounds.getSize(new Vector3()), target = bounds.getCenter(new Vector3());
  const aspect = scene.render.width / scene.render.height;
  if (!(Number.isFinite(aspect) && aspect > 0)) throw new Error('Choose a valid output size before generating shots.');
  const focalLengthMm = view === 'detail' ? 70 : 50, tanV = 18 / focalLengthMm, tanH = tanV * aspect;
  const yaw = view === 'three-quarter' ? Math.PI / 5 : view === 'detail' ? Math.PI / 8 : 0;
  const elevation = view === 'front' ? 0 : Math.atan(.12);
  if (view === 'detail') target.y += size.y * .12;
  const points = corners(bounds).map(point => point.sub(target)), direction = backward(yaw, elevation), optics = camera?.depthOfField;
  if (optics?.enabled && optics.focusDistanceM !== undefined && optics.focusDistanceM <= focalLengthMm / 1000) {
    throw new Error('Move the focus distance beyond the lens focal length, or turn off depth of field before generating this shot.');
  }
  const opticalMinimum = optics?.enabled && optics.focusDistanceM === undefined ? focalLengthMm / 1000 * 1.001 : 0;
  const minimum = Math.max(opticalMinimum, ...points.map(point => point.dot(direction) + NEAR_M * 1.05));
  const poseAt = (distance: number): CameraPose => ({positionM: target.clone().addScaledVector(direction, distance).toArray(), targetM: target.toArray(), focalLengthMm});
  if (view !== 'detail') {
    const orbitFit = fitDistance(points, yaw, elevation, tanH, tanV, radians(MAX_RANDOM_ORBIT_DEGREES));
    const pushFit = Math.max(fitDistance(points, yaw, elevation, tanH, tanV), opticalMinimum) / (1 - MAX_RANDOM_PUSH_FRACTION);
    return poseAt(Math.max(orbitFit, pushFit, minimum) * 1.001);
  }
  if (projectedProductBounds(bounds, poseAt(minimum), aspect).occupancy < RANDOM_DETAIL_OCCUPANCY) {
    throw new Error('This product is too small for a close-up at the current near or focus plane. Scale it up in the studio or turn off depth of field.');
  }
  let near = minimum, far = Math.max(minimum * 2, fitDistance(points, yaw, elevation, tanH, tanV));
  while (projectedProductBounds(bounds, poseAt(far), aspect).occupancy > RANDOM_DETAIL_OCCUPANCY) far *= 2;
  for (let i = 0; i < 48; i++) {
    const middle = (near + far) / 2;
    if (projectedProductBounds(bounds, poseAt(middle), aspect).occupancy > RANDOM_DETAIL_OCCUPANCY) near = middle; else far = middle;
  }
  return poseAt(far);
}
