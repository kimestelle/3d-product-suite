import { Euler, PerspectiveCamera, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { TransformAxis, TransformMode } from './transforms';

export type TransformPointer = { x: number; y: number };
export type TransformGesture = {
  /** Metres, degrees, or a uniform scale factor, relative to the initial pointer. */
  sample(mode: TransformMode, axis: TransformAxis, pointer: TransformPointer): number | null;
};
type ViewportRect = { left: number; top: number; width: number; height: number };
type GestureOptions = { translationScale?: number; rotationXyzw?: number[] };
const axes = { x: new Vector3(1, 0, 0), y: new Vector3(0, 1, 0), z: new Vector3(0, 0, 1) };

/** Freeze the real inspection projection; no pixel-to-world sensitivity constant. */
export function createTransformPointerGesture(
  camera: PerspectiveCamera, rect: ViewportRect, pivot: Vector3, start: TransformPointer, options: GestureOptions = {},
): TransformGesture | null {
  if (![rect.left, rect.top, rect.width, rect.height, pivot.x, pivot.y, pivot.z, start.x, start.y].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) return null;
  const translationScale = options.translationScale ?? 1;
  if (!Number.isFinite(translationScale) || translationScale <= 0) return null;
  const frozenCamera = camera.clone(); frozenCamera.updateMatrixWorld(true);
  const origin = pivot.clone(), initial = { x: start.x, y: start.y };
  // DOMRect exposes these as prototype getters, not enumerable own fields.
  const bounds = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  if (origin.clone().applyMatrix4(frozenCamera.matrixWorldInverse).z >= 0) return null;
  const direction = frozenCamera.getWorldDirection(new Vector3());
  const projected = origin.clone().project(frozenCamera);
  const center = new Vector2(bounds.left + (projected.x + 1) * bounds.width / 2, bounds.top + (1 - projected.y) * bounds.height / 2);
  const initialRadius = Math.hypot(initial.x - center.x, initial.y - center.y);
  const rotationAxes = { x: axes.x.clone(), y: axes.y.clone(), z: axes.z.clone() };
  if (options.rotationXyzw) {
    const euler = new Euler().setFromQuaternion(new Quaternion().fromArray(options.rotationXyzw), 'XYZ');
    const x = new Quaternion().setFromAxisAngle(axes.x, euler.x), y = new Quaternion().setFromAxisAngle(axes.y, euler.y);
    // These are the exact axes of the existing XYZ Euler controls.
    rotationAxes.y.applyQuaternion(x);
    rotationAxes.z.applyQuaternion(x.clone().multiply(y));
  }
  const raycaster = new Raycaster();
  const hit = (point: TransformPointer, normal: Vector3): Vector3 | null => {
    raycaster.setFromCamera(new Vector2((point.x - bounds.left) / bounds.width * 2 - 1, 1 - (point.y - bounds.top) / bounds.height * 2), frozenCamera);
    if (Math.abs(raycaster.ray.direction.dot(normal)) < 1e-5) return null;
    const intersection = raycaster.ray.intersectPlane(new Plane().setFromNormalAndCoplanarPoint(normal, origin), new Vector3());
    // A plane through the camera collapses every ray to its origin.
    return intersection && intersection.distanceToSquared(raycaster.ray.origin) > 1e-16 ? intersection : null;
  };
  return {
    sample(mode, axis, point) {
      if (![point.x, point.y].every(Number.isFinite)) return null;
      if (mode === 'scale') {
        if (initialRadius < 4) return null;
        const factor = Math.hypot(point.x - center.x, point.y - center.y) / initialRadius;
        return factor > 0 && Number.isFinite(factor) ? factor : null;
      }
      const normal = mode === 'rotate' ? rotationAxes[axis]
        : direction.clone().addScaledVector(axes[axis], -direction.dot(axes[axis]));
      if (normal.lengthSq() < 1e-8) return null;
      normal.normalize();
      const from = hit(initial, normal), to = hit(point, normal);
      if (!from || !to) return null;
      if (mode === 'translate') return to.sub(from).dot(axes[axis]) / translationScale;
      const before = from.sub(origin), after = to.sub(origin);
      if (before.lengthSq() < 1e-16 || after.lengthSq() < 1e-16) return null;
      return Math.atan2(normal.dot(before.clone().cross(after)), before.dot(after)) * 180 / Math.PI;
    },
  };
}
