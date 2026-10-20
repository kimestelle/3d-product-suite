import {Quaternion, Vector3} from 'three';

/** Rotate in camera axes, with half a turn across the specimen's shortest edge. */
export function rotateMaterialSample(orientation: Quaternion, dx: number, dy: number, size: number): void {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(size) || size <= 0) return;
  const distance = Math.hypot(dx, dy);
  if (!distance) return;
  const axis = new Vector3(dy / distance, dx / distance, 0);
  orientation.premultiply(new Quaternion().setFromAxisAngle(axis, distance * Math.PI / size)).normalize();
}
