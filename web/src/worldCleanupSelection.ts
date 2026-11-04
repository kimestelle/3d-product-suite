import * as THREE from 'three';

export type WorldCleanupFaceGroup = {
  nodeIndex: number;
  meshIndex: number;
  primitiveIndex: number;
  /** Immutable source TRIANGLES primitive IDs, before any repair or split. */
  faceIndices: number[];
};
export type WorldCleanupSelection = {sourceSha256: string; groups: WorldCleanupFaceGroup[]};
export const MAX_CLEANUP_SELECTION_FACES = 500_000;

/** Snapshot owned input once. A stale or malicious response cannot select an
 * unbounded allocation or mutate the displayed selection behind the renderer. */
export function normalizeWorldCleanupSelection(value: WorldCleanupSelection): WorldCleanupSelection {
  if (!value || !/^[a-f0-9]{64}$/.test(value.sourceSha256) || !Array.isArray(value.groups)
      || !value.groups.length || value.groups.length > 256) throw new Error('Cleanup selection needs a verified source and bounded face groups.');
  let count = 0;
  const grouped = new Map<string, WorldCleanupFaceGroup>();
  for (const group of value.groups) {
    if (!group || !['nodeIndex', 'meshIndex', 'primitiveIndex'].every(key => Number.isSafeInteger(group[key as keyof WorldCleanupFaceGroup])
        && (group[key as keyof WorldCleanupFaceGroup] as number) >= 0) || !Array.isArray(group.faceIndices) || !group.faceIndices.length) {
      throw new Error('Cleanup selection has an invalid source primitive.');
    }
    count += group.faceIndices.length;
    if (count > MAX_CLEANUP_SELECTION_FACES) throw new Error('Cleanup selection exceeds the face preview budget. Choose a smaller region.');
    if (group.faceIndices.some(face => !Number.isSafeInteger(face) || face < 0)) throw new Error('Cleanup selection has an invalid source face.');
    const key = `${group.nodeIndex}:${group.meshIndex}:${group.primitiveIndex}`, existing = grouped.get(key);
    if (existing) existing.faceIndices = existing.faceIndices.concat(group.faceIndices);
    else grouped.set(key, {...group, faceIndices: [...group.faceIndices]});
  }
  for (const group of grouped.values()) group.faceIndices = [...new Set(group.faceIndices)].sort((a, b) => a - b);
  return {sourceSha256: value.sourceSha256, groups: [...grouped.values()]};
}

export type WorldCleanupOverlay = {
  readonly meshes: readonly THREE.Mesh[];
  readonly triangleCount: number;
  bounds(): THREE.Box3;
  dispose(): void;
};

function sourceNode(object: THREE.Object3D, root: THREE.Object3D): number | undefined {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    const index = current.userData.gessoSourceNode?.index;
    if (Number.isSafeInteger(index)) return index;
    if (current === root) break;
  }
  return undefined;
}

/** A separate neutral tint follows the actual imported mesh hierarchy. It has
 * no raycast/shadow ownership and never edits source attributes or materials. */
export function createWorldCleanupOverlay(root: THREE.Object3D, input: WorldCleanupSelection, activeSha256: string): WorldCleanupOverlay | null {
  if (input.sourceSha256 !== activeSha256) return null;
  const selection = normalizeWorldCleanupSelection(input), sources = new Map<string, THREE.Mesh>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.gessoWorldCleanupOverlay) return;
    const node = sourceNode(object, root), primitive = object.userData.gessoSourcePrimitive;
    if (node === undefined || !primitive) return;
    const key = `${node}:${primitive.meshIndex}:${primitive.primitiveIndex}`;
    if (sources.has(key)) throw new Error('Cleanup selection cannot identify this mesh instance uniquely.');
    sources.set(key, object);
  });
  const material = new THREE.MeshBasicMaterial({color: 0xffffff, opacity: .27, transparent: true,
    depthTest: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1});
  const staged: {source: THREE.Mesh; overlay: THREE.Mesh}[] = [];
  let disposed = false, triangles = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const {overlay} of staged) {overlay.removeFromParent(); overlay.geometry.dispose();}
    material.dispose();
  };
  try {
    for (const group of selection.groups) {
      const mesh = sources.get(`${group.nodeIndex}:${group.meshIndex}:${group.primitiveIndex}`);
      if (!mesh) throw new Error('Cleanup region does not belong to the displayed source mesh.');
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh
          || Object.values(mesh.geometry.morphAttributes).some(values => values.length)
          || mesh.userData.gessoSourcePrimitive.mode !== 4) throw new Error('Cleanup selection requires a static triangle mesh.');
      const geometry = mesh.geometry, position = geometry.getAttribute('position'), index = geometry.index;
      const count = index?.count ?? position?.count ?? 0;
      if (!position || count % 3 || group.faceIndices.some(face => face >= count / 3)) throw new Error('Cleanup region contains a face outside its source primitive.');
      const positions = new Float32Array(group.faceIndices.length * 9);
      for (let face = 0; face < group.faceIndices.length; face++) for (let corner = 0; corner < 3; corner++) {
        const source = index ? index.getX(group.faceIndices[face] * 3 + corner) : group.faceIndices[face] * 3 + corner;
        if (!Number.isSafeInteger(source) || source < 0 || source >= position.count) throw new Error('Cleanup source face has an invalid vertex index.');
        const values = [position.getX(source), position.getY(source), position.getZ(source)];
        if (!values.every(Number.isFinite)) throw new Error('Cleanup source face has a non-finite vertex.');
        positions.set(values, face * 9 + corner * 3);
      }
      const preview = new THREE.BufferGeometry();
      preview.setAttribute('position', new THREE.BufferAttribute(positions, 3)); preview.computeBoundingBox();
      const overlay = new THREE.Mesh(preview, material);
      overlay.name = 'Cleanup region highlight'; overlay.userData.gessoWorldCleanupOverlay = true;
      overlay.renderOrder = 10; overlay.castShadow = false; overlay.receiveShadow = false;
      overlay.raycast = () => {}; // Calibration/product picking retains the original surface.
      staged.push({source: mesh, overlay}); triangles += group.faceIndices.length;
    }
    // No partial overlay becomes visible when a later group fails validation.
    for (const {source, overlay} of staged) source.add(overlay);
    return {meshes: staged.map(value => value.overlay), triangleCount: triangles,
      bounds: () => {
        const bounds = new THREE.Box3();
        if (disposed) return bounds;
        for (const {overlay} of staged) {
          overlay.updateWorldMatrix(true, false);
          if (overlay.geometry.boundingBox) bounds.union(overlay.geometry.boundingBox.clone().applyMatrix4(overlay.matrixWorld));
        }
        return bounds;
      }, dispose};
  } catch (error) {dispose(); throw error;}
}
