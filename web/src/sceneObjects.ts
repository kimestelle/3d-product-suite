import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';

// Shared by the live viewport and object previews. Asset verification, geometry
// and ownership must agree before either view presents a scene object.
export function createComponentGeometry(shape: string, size: number[], bevel = 0): THREE.BufferGeometry {
  const radius = Math.min(bevel, Math.min(...size) * 0.45);
  if (shape === 'box') {
    const geometry = radius > 0
      ? new RoundedBoxGeometry(size[0], size[1], size[2], 5, radius)
      : new THREE.BoxGeometry(size[0], size[1], size[2]);
    // A true six-island atlas prevents one UV placement stamping every face.
    // Three's group order is +X, -X, +Y, -Y, +Z (front), -Z.
    const uv = geometry.getAttribute('uv');
    geometry.groups.forEach((group, face) => {
      const visited = new Set<number>();
      for (let i = group.start; i < group.start + group.count; i++) {
        const index = geometry.index?.getX(i) ?? i;
        if (visited.has(index)) continue;
        visited.add(index);
        uv.setXY(index, (uv.getX(index) + face % 3) / 3, (uv.getY(index) + Math.floor(face / 3)) / 2);
      }
    });
    return geometry;
  }
  if (shape !== 'cylinder') throw new Error(`Unsupported component shape: ${shape}`);
  // Lathe is Y-up. Keep the exact declared dimensions, including elliptical
  // cylinders, and apply bevel to geometry rather than changing the pose.
  const halfHeight = size[1] / 2;
  const r = size[0] / 2;
  const b = Math.min(radius, r * 0.9);
  const profile = [new THREE.Vector2(0, -halfHeight), new THREE.Vector2(r - b, -halfHeight)];
  for (let step = 0; step <= 5; step++) {
    const angle = step * Math.PI / 10;
    profile.push(new THREE.Vector2(r - b + b * Math.sin(angle), -halfHeight + b - b * Math.cos(angle)));
  }
  profile.push(new THREE.Vector2(r, halfHeight - b));
  for (let step = 0; step <= 5; step++) {
    const angle = step * Math.PI / 10;
    profile.push(new THREE.Vector2(r - b + b * Math.cos(angle), halfHeight - b + b * Math.sin(angle)));
  }
  profile.push(new THREE.Vector2(0, halfHeight));
  const geometry = new THREE.LatheGeometry(profile, 128);
  geometry.scale(1, 1, size[2] / size[0]);
  return geometry;
}

export function sceneAssetUrl(asset: any): string {
  const filename = String(asset?.path || '').split('/').pop();
  if (!filename || !/^[a-f0-9]{64}\.(glb|ply|spz|png|hdr)$/.test(filename)) throw new Error('The world asset path is invalid.');
  return `/api/assets/${filename}`;
}

export async function loadVerifiedGlb(asset: any, signal: AbortSignal, url?: string): Promise<THREE.Group> {
  const path = asset?.path;
  if (asset?.format !== 'glb' || asset?.sourceUp !== 'Y' || !/^[a-f0-9]{64}$/.test(asset?.sha256 || '')
      || typeof path !== 'string' || /[\\:\0]/.test(path) || path.startsWith('/')
      || path.split('/').some((part: string) => !part || part === '.' || part === '..')
      || path.split('/').at(-1) !== `${asset.sha256}.glb`) {
    throw new Error('The mesh asset must declare a safe, content-addressed Y-up GLB.');
  }
  const response = await fetch(url || sceneAssetUrl(asset), { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load mesh asset (${response.status}).`);
  const limit = 128 * 1024 * 1024;
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('The mesh asset exceeds the 128 MiB limit.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 20 || bytes.byteLength > limit) throw new Error('The mesh asset is empty, truncated, or exceeds 128 MiB.');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== asset.sha256) throw new Error('The mesh asset SHA-256 does not match its immutable scene revision.');
  const header = new DataView(bytes);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2
      || header.getUint32(8, true) !== bytes.byteLength) throw new Error('Expected a complete GLB version 2 mesh asset.');
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 || jsonLength > 16 * 1024 * 1024
      || 20 + jsonLength > bytes.byteLength) throw new Error('The mesh GLB JSON chunk is invalid.');
  const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, 20, jsonLength)));
  if (document?.asset?.version !== '2.0') throw new Error('The mesh asset must declare glTF version 2.0.');
  const embeddedOnly = (value: any, depth = 0): void => {
    if (depth > 80) throw new Error('The mesh GLB JSON nesting exceeds the limit.');
    if (Array.isArray(value)) { value.forEach(child => embeddedOnly(child, depth + 1)); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['script', 'scripts', 'javascript'].includes(key.toLowerCase())) throw new Error('Scripts are forbidden in mesh assets.');
        if (['uri', 'url', 'href'].includes(key.toLowerCase())
            && (typeof child !== 'string' || !/^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg|webp));base64,[a-z0-9+/]*={0,2}$/i.test(child))) {
          throw new Error('Mesh GLBs must be self-contained; external asset references are forbidden.');
        }
        embeddedOnly(child, depth + 1);
      }
    } else if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Mesh GLB values must be finite.');
  };
  embeddedOnly(document);
  if (signal.aborted) throw new DOMException('Mesh loading was superseded.', 'AbortError');
  // Parsing verified bytes, rather than loadAsync(url), prevents a second
  // fetch or a change between hash verification and the rendered hierarchy.
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  // Index against immutable glTF node indices, never UUIDs or sanitized Three
  // names. Repeated mesh instances retain distinct node handles on reload.
  gltf.scene.traverse(object => {
    delete object.userData.gessoSourceNode;
    const association = gltf.parser.associations.get(object);
    if (association?.nodes !== undefined) {
      const index = association.nodes;
      object.userData.gessoSourceNode = { index, name: document.nodes?.[index]?.name || `Node ${index + 1}` };
    }
    if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      delete material.userData.gessoSourceMaterial;
      delete material.userData.gessoSourceMaterialName;
      const materialAssociation = gltf.parser.associations.get(material);
      if (materialAssociation?.materials !== undefined) material.userData.gessoSourceMaterial = materialAssociation.materials;
    }
  });
  return gltf.scene;
}

export function prepareImportedMesh(root: THREE.Object3D): void {
  const excluded: THREE.Object3D[] = [];
  let meshes = 0;
  root.traverse(object => {
    if (object instanceof THREE.Camera || object instanceof THREE.Light) excluded.push(object);
    if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; meshes++; }
  });
  root.updateMatrixWorld(true);
  for (const object of excluded) {
    // A glTF camera/light node can also parent real product geometry. Remove
    // its authored illumination/camera while retaining those child transforms.
    const parent = object.parent;
    if (parent) for (const child of [...object.children]) parent.attach(child);
    object.removeFromParent();
    disposeSceneObject(object);
  }
  if (!meshes) { disposeSceneObject(root); throw new Error('The GLB contains no visible mesh geometry.'); }
}

export function disposeSceneObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const skeletons = new Set<THREE.Skeleton>();
  root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    if (mesh.geometry) geometries.add(mesh.geometry);
    const values = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of values) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
    if (object instanceof THREE.DirectionalLight) object.shadow.dispose();
  });
  textures.forEach(texture => texture.dispose());
  const images = new Set(Array.from(textures, texture => texture.image));
  images.forEach(image => { if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close(); });
  skeletons.forEach(skeleton => skeleton.dispose());
  materials.forEach(material => material.dispose());
  geometries.forEach(geometry => geometry.dispose());
}
