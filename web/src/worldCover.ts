import * as THREE from 'three';
import {createStudioSweepGeometry, disposeSceneObject} from './sceneObjects';
import {createWorldObjectPreview} from './worldObjectPreview';
import {assetUrl} from './runtime';

export interface WorldPreviewAsset {path: string; sha256: string; format: 'png' | 'jpg' | 'jpeg' | 'webp'}
export interface WorldCoverItem {id: string; name: string; environment: any; productDimensionsM?: number[]; previewAsset?: WorldPreviewAsset}
export interface WorldCover {state: 'ready' | 'loading' | 'open' | 'failed'; url?: string}
const TRANSIENT_CAPTURE_ERRORS = new Set([
  'A still is already rendering.',
  'Wait for the current preview to finish loading.',
  'The view changed. Render a new still.',
]);
const CAPTURE_RETRY_DELAYS = [250, 500, 1000, 2000, 2000];

function assertCaptureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('World preview superseded.', 'AbortError');
}
function waitToCapture(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    assertCaptureActive(signal);
    const aborted = () => {clearTimeout(timer); reject(new DOMException('World preview superseded.', 'AbortError'));};
    const timer = setTimeout(() => {signal.removeEventListener('abort', aborted); resolve();}, delay);
    signal.addEventListener('abort', aborted, {once: true});
  });
}

/** Camera settling and another still are temporary conflicts. Keep only one
 * request in flight; stop after a short bounded backoff or any real failure. */
export async function captureWorldCoverWithRetry(capture: (signal: AbortSignal) => Promise<Blob>, signal: AbortSignal): Promise<Blob> {
  for (let attempt = 0; ; attempt++) {
    assertCaptureActive(signal);
    try {
      const blob = await capture(signal);
      assertCaptureActive(signal);
      return blob;
    } catch (error) {
      assertCaptureActive(signal);
      if (!(error instanceof Error) || !TRANSIENT_CAPTURE_ERRORS.has(error.message) || attempt >= CAPTURE_RETRY_DELAYS.length) throw error;
      await waitToCapture(CAPTURE_RETRY_DELAYS[attempt], signal);
    }
  }
}

/** A cover belongs to the full set, independent of the product and world label. */
export function worldCoverKey(environment: any, productDimensionsM?: number[]): string {
  const asset = environment?.asset;
  return JSON.stringify([environment?.kind, asset?.sha256, asset?.sourceUp,
    asset?.scaleToMeters, asset?.translationM, asset?.rotationXyzw, environment?.worldColor,
    environment?.plinth, environment?.props ?? [],
    environment?.kind === 'authored' ? environment.studioSizeM ?? (productDimensionsM ? Math.max(...productDimensionsM) : null) : null]);
}

/** Resolve only declared image covers. The native image loads lazily; no mesh
 * request, HEAD request, or size probe is needed to display a library card. */
export function worldPreviewAssetUrl(preview?: WorldPreviewAsset): string | undefined {
  if (!preview || !/^[a-f0-9]{64}$/.test(preview.sha256)) return;
  const extensions = preview.format === 'jpeg' || preview.format === 'jpg' ? ['jpeg', 'jpg']
    : preview.format === 'png' || preview.format === 'webp' ? [preview.format] : [];
  if (!extensions.some(extension => preview.path === `assets/${preview.sha256}.${extension}`)) return;
  return assetUrl(preview.path);
}

/** A captured current scene wins over its catalog image. Thumbnail revisions
 * do not invalidate the scene cache or cause another world load. */
export function worldCoverForItem(item: WorldCoverItem, cached?: WorldCover): WorldCover {
  if (cached?.state === 'ready') return cached;
  const url = worldPreviewAssetUrl(item.previewAsset);
  if (url) return {state: 'ready', url};
  return cached ?? {state: item.environment?.kind === 'authored' ? 'loading' : 'open'};
}

/** Only local authored geometry gets a separate cover renderer. Imported mesh
 * and splat covers come from a small image or the already-loaded main viewport. */
export async function createWorldCoverObject(environment: any, signal: AbortSignal, productDimensionsM?: number[]): Promise<THREE.Object3D | null> {
  if (environment.kind === 'authored') return createAuthoredWorldCover(environment, signal, productDimensionsM);
  return null;
}

async function createAuthoredWorldCover(environment: any, signal: AbortSignal, productDimensionsM?: number[]): Promise<THREE.Object3D | null> {
  const plinth = environment.plinth;
  if (!plinth || environment.props?.some((prop: any) => prop.shape === 'mesh')) return null;
  const root = new THREE.Group();
  try {
    const objects = [plinth, ...(environment.props ?? [])];
    for (const specification of objects) {
      if (specification.visible === false) continue;
      const object = await createWorldObjectPreview({id: specification.id, name: specification.id, object: specification, isPlinth: specification === plinth}, signal);
      object.position.fromArray(specification.translationM);
      root.add(object);
    }
    root.updateWorldMatrix(true, true);
    const focus = new THREE.Box3().setFromObject(root, true);
    if (focus.isEmpty()) focus.setFromCenterAndSize(new THREE.Vector3().fromArray(plinth.translationM), new THREE.Vector3().fromArray(plinth.sizeM));
    // Frame the editable set; the effectively unbounded sweep stays behind it.
    root.userData.gessoCoverBounds = focus;
    const floorHeight = plinth.translationM[1] + (plinth.visible === false ? 1 : -1) * plinth.sizeM[1] / 2 - .0001;
    const radius = (environment.studioSizeM ?? Math.max(...(productDimensionsM ?? plinth.sizeM))) * 3;
    const floor = new THREE.Mesh(createStudioSweepGeometry(floorHeight, radius), new THREE.MeshStandardMaterial({
      color: new THREE.Color().fromArray(environment.worldColor ?? [.26, .28, .26]), roughness: .72, side: THREE.DoubleSide,
    }));
    floor.name = 'Studio sweep'; root.add(floor);
    return root;
  } catch (error) {disposeSceneObject(root); throw error;}
}

/** View the set from its open front, fitting every aligned bounds corner. */
export function fitWorldCover(camera: THREE.PerspectiveCamera, object: THREE.Object3D): void {
  object.updateWorldMatrix(true, true);
  const box = object.userData.gessoCoverBounds instanceof THREE.Box3 ? object.userData.gessoCoverBounds : new THREE.Box3().setFromObject(object, true);
  if (box.isEmpty()) throw new Error('The world contains no preview geometry.');
  const center = box.getCenter(new THREE.Vector3());
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const size = box.getSize(new THREE.Vector3());
  const view = new THREE.Vector3(0, object.userData.gessoCoverBounds ? .55 : 0, 1).normalize();
  const right = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3().crossVectors(view, right).normalize();
  let distance = .001;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const corner = new THREE.Vector3(x, y, z).sub(center);
    distance = Math.max(distance, corner.dot(view) + Math.max(Math.abs(corner.dot(up)) / tangent, Math.abs(corner.dot(right)) / (tangent * camera.aspect)) / .88);
  }
  camera.position.copy(center).addScaledVector(view, distance);
  camera.near = Math.max(.00001, distance * .001);
  const fullExtent = object.userData.gessoCoverBounds ? new THREE.Box3().setFromObject(object, true).getSize(new THREE.Vector3()).length() : size.length();
  camera.far = Math.max(1, distance + fullExtent * 2);
  camera.lookAt(center); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
}
