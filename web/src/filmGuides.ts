import {PerspectiveCamera, Plane, Raycaster, Vector2, Vector3} from 'three';

export type FilmGateRect = {x: number; y: number; width: number; height: number};
export type FilmGuideProjection = {
  gate: FilmGateRect;
  viewportWidth: number;
  viewportHeight: number;
  target: {x: number; y: number; visible: boolean};
  targetM: [number, number, number];
  distanceM: number;
  focalLengthMm: number;
  inspecting: boolean;
};
export type CameraTargetPointer = {clientX: number; clientY: number};
export type CameraTargetGesture = {
  /** World-space aim point on the initial camera-facing plane, in metres. */
  move(pointer: CameraTargetPointer): [number, number, number] | null;
  /** Pixel offset from the initial pointer, for keyboard operation. */
  nudge(dx: number, dy: number): [number, number, number] | null;
};
type ViewportRect = {left: number; top: number; width: number; height: number};

/** The output gate and rendered overscan use one measured rectangle. */
export function filmGateRect(width: number, height: number, aspect: number): FilmGateRect {
  if (![width, height, aspect].every(Number.isFinite) || width <= 0 || height <= 0 || aspect <= 0) {
    return {x: 0, y: 0, width: 0, height: 0};
  }
  const availableWidth = Math.max(width * .4, width - 96);
  const availableHeight = Math.max(height * .4, height - 128);
  const gateHeight = Math.min(availableHeight, availableWidth / aspect);
  const gateWidth = gateHeight * aspect;
  return {x: (width - gateWidth) / 2, y: (height - gateHeight) / 2, width: gateWidth, height: gateHeight};
}

/** A 36 mm vertical gate must keep its authored FOV inside the inset frame. */
export function filmGuideZoom(width: number, height: number, aspect: number): number {
  const gate = filmGateRect(width, height, aspect);
  return gate.height > 0 ? gate.height / height : 1;
}

export function projectFilmGuide(camera: PerspectiveCamera, width: number, height: number, aspect: number,
  target: Vector3, shotPosition: Vector3, focalLengthMm: number, inspecting: boolean): FilmGuideProjection {
  camera.updateMatrixWorld(true);
  const projected = target.clone().project(camera);
  const inFront = target.clone().applyMatrix4(camera.matrixWorldInverse).z < -camera.near;
  const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
  return {
    gate: filmGateRect(width, height, aspect), viewportWidth: width, viewportHeight: height,
    target: {x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0,
      visible: inFront && [x, y, projected.z].every(Number.isFinite) && projected.z <= 1 && x >= 0 && x <= width && y >= 0 && y <= height},
    targetM: target.toArray() as [number, number, number],
    distanceM: shotPosition.distanceTo(target), focalLengthMm, inspecting,
  };
}

/** Freeze the presented image's projection so a moving camera never moves the drag plane. */
export function createCameraTargetPointerGesture(camera: PerspectiveCamera, rect: ViewportRect,
  target: Vector3, start: CameraTargetPointer): CameraTargetGesture | null {
  if (![rect.left, rect.top, rect.width, rect.height, target.x, target.y, target.z, start.clientX, start.clientY].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0) return null;
  const frozen = camera.clone(); frozen.updateMatrixWorld(true);
  const origin = target.clone();
  if (origin.clone().applyMatrix4(frozen.matrixWorldInverse).z >= -frozen.near) return null;
  const bounds = {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  const pointer = {...start};
  const plane = new Plane().setFromNormalAndCoplanarPoint(frozen.getWorldDirection(new Vector3()), origin);
  const raycaster = new Raycaster();
  const hit = (point: CameraTargetPointer) => {
    if (![point.clientX, point.clientY].every(Number.isFinite)) return null;
    raycaster.setFromCamera(new Vector2((point.clientX - bounds.left) / bounds.width * 2 - 1,
      1 - (point.clientY - bounds.top) / bounds.height * 2), frozen);
    return raycaster.ray.intersectPlane(plane, new Vector3());
  };
  const initial = hit(pointer);
  if (!initial) return null;
  const move = (point: CameraTargetPointer): [number, number, number] | null => {
    const next = hit(point);
    return next ? next.sub(initial).add(origin).toArray() as [number, number, number] : null;
  };
  return {move, nudge: (dx, dy) => move({clientX: pointer.clientX + dx, clientY: pointer.clientY + dy})};
}
