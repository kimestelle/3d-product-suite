import * as THREE from 'three';
import {createSurfaceMaterial, loadMaterialTextures, type MaterialSpecification} from './materials';
import {PLINTH_MATERIAL} from './world';
import {createComponentGeometry, disposeSceneObject, loadVerifiedGlb, prepareImportedMesh, sceneAssetUrl} from './sceneObjects';

export interface WorldObjectPreviewItem {
  id: string;
  name: string;
  object: any;
  isPlinth?: boolean;
  description?: string;
}

/** Names, visibility and world translation do not change the isolated specimen. */
export function worldObjectPreviewKey(item: WorldObjectPreviewItem): string {
  const object = item.object;
  return JSON.stringify([!!item.isPlinth, object.shape, object.sizeM, object.rotationXyzw,
    object.bevelM, object.asset, object.materialOverride, object.material]);
}

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Object preview superseded.', 'AbortError');
}

/** Uses the same verified asset bytes, geometry and physical materials as the scene. */
export async function createWorldObjectPreview(item: WorldObjectPreviewItem, signal: AbortSignal): Promise<THREE.Object3D> {
  const specification = item.object;
  let object: THREE.Object3D | undefined;
  try {
    abortIfNeeded(signal);
    if (!item.isPlinth && specification.shape === 'mesh') {
      const imported = await loadVerifiedGlb(specification.asset, signal);
      object = imported;
      abortIfNeeded(signal);
      prepareImportedMesh(imported);
      const dimensions = specification.asset.sourceDimensionsM;
      if (!Array.isArray(dimensions) || dimensions.length !== 3 || dimensions.some(value => !Number.isFinite(value) || value <= 0)) {
        throw new Error('Imported props must declare their original dimensions in meters.');
      }
      imported.updateWorldMatrix(true, true);
      const measured = new THREE.Box3().setFromObject(imported, true).getSize(new THREE.Vector3()).toArray();
      if (measured.some((value, axis) => Math.abs(value - dimensions[axis]) > Math.max(.00001, dimensions[axis] * .001))) {
        throw new Error('Imported prop dimensions do not match its verified GLB geometry.');
      }
      if (specification.materialOverride === true) {
        const replacement = createSurfaceMaterial(specification.material);
        // Detach the original material resources from geometry before disposing.
        const originals = new THREE.Group();
        imported.traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          originals.add(new THREE.Mesh(undefined, node.material));
          node.material = replacement;
        });
        disposeSceneObject(originals);
      }
      const wrapper = new THREE.Group();
      wrapper.add(imported);
      wrapper.scale.fromArray(specification.sizeM.map((value: number, axis: number) => value / dimensions[axis]));
      wrapper.quaternion.fromArray(specification.rotationXyzw || [0, 0, 0, 1]);
      object = wrapper;
    } else {
      const shape = item.isPlinth ? 'box' : specification.shape;
      const bevel = item.isPlinth ? Math.min(.004, ...specification.sizeM.map((value: number) => value / 2)) : specification.bevelM;
      const material = createSurfaceMaterial((specification.material || PLINTH_MATERIAL) as MaterialSpecification);
      object = new THREE.Mesh(createComponentGeometry(shape, specification.sizeM, bevel), material);
      if (!item.isPlinth) object.quaternion.fromArray(specification.rotationXyzw || [0, 0, 0, 1]);
    }
    if (item.isPlinth || specification.shape !== 'mesh' || specification.materialOverride === true) {
      const specificationMaterial = (specification.material || PLINTH_MATERIAL) as MaterialSpecification;
      const surfaces = new Set<THREE.MeshPhysicalMaterial>();
      object.traverse(node => {
        if (node instanceof THREE.Mesh) for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (material instanceof THREE.MeshPhysicalMaterial) surfaces.add(material);
        }
      });
      await Promise.all([...surfaces].map(material => loadMaterialTextures(material, specificationMaterial, sceneAssetUrl, {signal})));
    }
    abortIfNeeded(signal);
    return object;
  } catch (error) {
    if (object) disposeSceneObject(object);
    throw error;
  }
}

/** Fit every transformed corner, including very flat/wide objects, with equal padding. */
export function fitWorldObjectPreview(camera: THREE.PerspectiveCamera, object: THREE.Object3D, aspect: number): void {
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object, true);
  if (bounds.isEmpty()) throw new Error('The object has no preview geometry.');
  const center = bounds.getCenter(new THREE.Vector3());
  const view = new THREE.Vector3(1, .72, 1.3).normalize();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), view).normalize();
  const up = new THREE.Vector3().crossVectors(view, right).normalize();
  camera.aspect = aspect;
  const tangentY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tangentX = tangentY * aspect;
  let distance = 0;
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const corner = new THREE.Vector3(x, y, z).sub(center);
    distance = Math.max(distance, corner.dot(view) + Math.max(Math.abs(corner.dot(right)) / tangentX, Math.abs(corner.dot(up)) / tangentY) / .78);
  }
  distance = Math.max(distance, .001);
  const extent = bounds.getSize(new THREE.Vector3()).length();
  camera.near = Math.max(.000001, (distance - extent) * .1);
  camera.far = Math.max(distance + extent * 2, camera.near * 100);
  camera.position.copy(center).addScaledVector(view, distance);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
