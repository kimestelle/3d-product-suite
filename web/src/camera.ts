import {Box3, Matrix4, Quaternion, Vector3} from 'three';
import {sourcePart} from './partTargets';
import {validateFilmMotions} from './filmMotion';

export type CameraEnd = 'from' | 'to';
export type CameraPose = {positionM: number[]; targetM: number[]; focalLengthMm: number};

export type DepthOfFieldSettings = {enabled: boolean; fStop: number; focusDistanceM?: number};
export type CameraDefinition = {from: CameraPose; to: CameraPose; depthOfField?: DepthOfFieldSettings};

function validateDepthOfField(camera: CameraDefinition) {
  if (camera.depthOfField === undefined) return;
  const optics = camera.depthOfField;
  if (!optics || typeof optics.enabled !== 'boolean') throw new Error('Depth of field must have an enabled state.');
  if (!Number.isFinite(optics.fStop) || optics.fStop < .7 || optics.fStop > 32) throw new Error('Aperture must be between f/0.7 and f/32.');
  if (optics.focusDistanceM !== undefined && (!Number.isFinite(optics.focusDistanceM) || optics.focusDistanceM < .001 || optics.focusDistanceM > 1000)) {
    throw new Error('Focus distance must be between 0.001 and 1000 m.');
  }
  if (!optics.enabled) return;
  const focal0 = camera.from.focalLengthMm / 1000, focal1 = camera.to.focalLengthMm / 1000;
  if (optics.focusDistanceM !== undefined) {
    if (optics.focusDistanceM <= Math.max(focal0, focal1)) throw new Error('Focus distance must stay beyond the focal length throughout the shot.');
    return;
  }
  // The full move, including its closest interior point, must remain focusable.
  const start = camera.from.positionM.map((value, i) => value - camera.from.targetM[i]);
  const delta = camera.to.positionM.map((value, i) => value - camera.to.targetM[i] - start[i]);
  const focalDelta = focal1 - focal0;
  const a = delta.reduce((sum, x) => sum + x*x, 0) - focalDelta*focalDelta;
  const b = 2 * (start.reduce((sum, x, i) => sum + x*delta[i], 0) - focal0*focalDelta);
  const c = start.reduce((sum, x) => sum + x*x, 0) - focal0*focal0;
  const candidates = [0, 1];
  if (a > 0) candidates.push(Math.max(0, Math.min(1, -b / (2*a))));
  if (Math.min(...candidates.map(u => a*u*u + b*u + c)) <= 0) {
    throw new Error('Focus target must stay beyond the focal length throughout the shot.');
  }
}

export function validateCamera(camera: CameraDefinition) {
  for (const pose of [camera.from, camera.to]) {
    if (![...pose.positionM, ...pose.targetM, pose.focalLengthMm].every(Number.isFinite)) throw new Error('Camera values must be finite numbers.');
    if (pose.focalLengthMm < 1) throw new Error('Focal length must be at least 1 mm.');
  }
  validateDepthOfField(camera);
  const start = [0, 2].map(index => camera.from.positionM[index] - camera.from.targetM[index]);
  const end = [0, 2].map(index => camera.to.positionM[index] - camera.to.targetM[index]);
  const delta = end.map((value, index) => value - start[index]);
  const length = delta.reduce((sum, value) => sum + value * value, 0);
  const u = length ? Math.max(0, Math.min(1, -start.reduce((sum, value, index) => sum + value * delta[index], 0) / length)) : 0;
  if (start.reduce((sum, value, index) => sum + (value + u * delta[index]) ** 2, 0) <= 1e-10) {
    throw new Error('This path points straight up, straight down, or through its target. Move X or Z to keep a viewing direction.');
  }
}

export function editCamera(scene: any, id: string, edit: (camera: CameraDefinition) => void) {
  const shot = scene.shots.find((item: any) => item.id === id);
  if (!shot) throw new Error('This shot is no longer in the film.');
  const next = structuredClone(shot.camera);
  edit(next);
  validateCamera(next);
  // Optical changes must also remain valid along the evaluated motion path.
  // Preflight a replacement camera without mutating the scene on rejection.
  if (scene.motions !== undefined || scene.shots.some((item: any) => item.motions !== undefined)) {
    validateFilmMotions({...scene, shots: scene.shots.map((item: any) => item.id === id ? {...item, camera: next} : item)});
  }
  shot.camera = next;
}

// Evaluated transforms are supplied by the shared scene engine, including actions.
export function cameraTarget(scene: any, sample: any, componentId?: string): number[] {
  if (!sample?.components) throw new Error('Wait for the scene to update before choosing a target.');
  if(componentId&&sourcePart(scene,componentId)) {
    const part=sourcePart(scene,componentId)!;
    const pose=sample.parts?.[componentId];
    if(!pose)throw new Error('Wait for the selected part to update before choosing a target.');
    const bounds=new Box3(),matrix=new Matrix4().fromArray(pose.worldMatrix);
    for(const x of [part.node.boundsM[0][0],part.node.boundsM[1][0]])for(const y of [part.node.boundsM[0][1],part.node.boundsM[1][1]])for(const z of [part.node.boundsM[0][2],part.node.boundsM[1][2]])
      bounds.expandByPoint(new Vector3(x,y,z).applyMatrix4(matrix));
    return bounds.getCenter(new Vector3()).toArray();
  }
  const components = scene.product.components.filter((component: any) => !componentId || component.id === componentId);
  if (!components.length) throw new Error('This part is no longer in the product.');
  const bounds = new Box3();
  for (const component of components) {
    const pose = sample.components[component.id];
    if (!pose) throw new Error('Wait for the scene to update before choosing a target.');
    const rotation = new Quaternion().fromArray(pose.rotationXyzw);
    const translation = new Vector3().fromArray(pose.translationM);
    for (const x of [-.5, .5]) for (const y of [-.5, .5]) for (const z of [-.5, .5]) {
      bounds.expandByPoint(new Vector3(component.sizeM[0] * x, component.sizeM[1] * y, component.sizeM[2] * z).multiplyScalar(pose.scale ?? 1).applyQuaternion(rotation).add(translation));
    }
  }
  return bounds.getCenter(new Vector3()).toArray();
}
