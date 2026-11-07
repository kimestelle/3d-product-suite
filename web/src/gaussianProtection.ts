type Point = [number, number, number];

export type GaussianProtection = {
  positionMinM: Point;
  positionMaxM: Point;
  targetMinM: Point;
  targetMaxM: Point;
  outside: 'black' | 'white';
};

function inside(value: readonly number[] | undefined, min: Point, max: Point): boolean {
  return value?.length === 3 && value.every((axis, i) => Number.isFinite(axis) && axis >= min[i] && axis <= max[i]);
}

export function protectedGaussianPose(protection: GaussianProtection,
  camera?: {positionM?: readonly number[]; targetM?: readonly number[]}): boolean {
  return inside(camera?.positionM, protection.positionMinM, protection.positionMaxM)
    && inside(camera?.targetM, protection.targetMinM, protection.targetMaxM);
}

export function clampGaussianTarget(protection: GaussianProtection, target: Point | null): Point | null {
  if (!target) return null;
  const clamp = (axis: number) => Math.min(protection.targetMaxM[axis], Math.max(protection.targetMinM[axis], target[axis]));
  return [clamp(0), clamp(1), clamp(2)];
}

/** Bound presentation-only orbit, pan and zoom to the reviewed room volume. */
export function clampGaussianPose(protection: GaussianProtection,
  camera: {positionM: readonly number[]; targetM: readonly number[]}): {positionM: Point; targetM: Point} | null {
  if (![camera.positionM, camera.targetM].every(point => point.length === 3 && point.every(Number.isFinite))) return null;
  const clamp = (point: readonly number[], minimum: Point, maximum: Point): Point =>
    point.map((value, axis) => Math.max(minimum[axis], Math.min(maximum[axis], value))) as Point;
  const positionM = clamp(camera.positionM, protection.positionMinM, protection.positionMaxM);
  const targetM = clamp(camera.targetM, protection.targetMinM, protection.targetMaxM);
  if (Math.hypot(...positionM.map((value, axis) => value - targetM[axis])) < .001) return null;
  return {positionM, targetM};
}
