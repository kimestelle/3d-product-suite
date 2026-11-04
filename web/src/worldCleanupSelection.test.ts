import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {createWorldCleanupOverlay, normalizeWorldCleanupSelection, MAX_CLEANUP_SELECTION_FACES, type WorldCleanupSelection} from './worldCleanupSelection';
import {StudioViewport} from './viewport';

const sha = 'a'.repeat(64);
const select = (faces = [1]): WorldCleanupSelection => ({sourceSha256: sha,
  groups: [{nodeIndex: 3, meshIndex: 0, primitiveIndex: 0, faceIndices: faces}]});
function room() {
  const root = new THREE.Group(), node = new THREE.Group();
  node.userData.gessoSourceNode = {index: 3}; node.position.set(2, 3, 4); root.add(node);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new THREE.MeshBasicMaterial({color: '#456789'}), mesh = new THREE.Mesh(geometry, material);
  mesh.userData.gessoSourcePrimitive = {meshIndex: 0, primitiveIndex: 0, mode: 4}; node.add(mesh);
  return {root, node, mesh, geometry, material};
}

describe('source-owned world cleanup highlight', () => {
  it('uses selected source faces and actual transforms without changing source positions, UVs or material', () => {
    const {root, mesh, geometry, material} = room();
    const before = [...geometry.getAttribute('position').array], uv = [...geometry.getAttribute('uv').array];
    const overlay = createWorldCleanupOverlay(root, select(), sha)!;
    expect(overlay.triangleCount).toBe(1);
    expect([...overlay.meshes[0].geometry.getAttribute('position').array]).toEqual([0, 0, 0, 1, 0, 1, 0, 0, 1]);
    expect(overlay.bounds().min.toArray()).toEqual([2, 3, 4]);
    expect(overlay.bounds().max.toArray()).toEqual([3, 3, 5]);
    expect([...geometry.getAttribute('position').array]).toEqual(before);
    expect([...geometry.getAttribute('uv').array]).toEqual(uv); expect(mesh.material).toBe(material);
    const intersections: THREE.Intersection[] = []; overlay.meshes[0].raycast(new THREE.Raycaster(), intersections);
    expect(intersections).toEqual([]); expect(overlay.meshes[0].castShadow).toBe(false);
    overlay.dispose(); expect(mesh.children).toEqual([]);
  });

  it('refuses a stale source and invalid source-face references without publishing partial overlays', () => {
    const {root, mesh} = room();
    expect(createWorldCleanupOverlay(root, select(), 'b'.repeat(64))).toBeNull();
    const selection = select(); selection.groups.push({...selection.groups[0], primitiveIndex: 1});
    expect(() => createWorldCleanupOverlay(root, selection, sha)).toThrow('displayed source');
    expect(mesh.children).toEqual([]);
    expect(() => createWorldCleanupOverlay(root, select([2]), sha)).toThrow('outside');
    expect(mesh.children).toEqual([]);
  });

  it('disposes only its own buffers and material once', () => {
    const {root, geometry, material} = room(), sourceDispose = vi.spyOn(geometry, 'dispose'), materialDispose = vi.spyOn(material, 'dispose');
    const overlay = createWorldCleanupOverlay(root, select(), sha)!;
    const bufferDispose = vi.spyOn(overlay.meshes[0].geometry, 'dispose'), previewDispose = vi.spyOn(overlay.meshes[0].material as THREE.Material, 'dispose');
    overlay.dispose(); overlay.dispose();
    expect(bufferDispose).toHaveBeenCalledOnce(); expect(previewDispose).toHaveBeenCalledOnce();
    expect(sourceDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
    expect(overlay.bounds().isEmpty()).toBe(true);
  });

  it('owns its input, merges repeated primitive groups and bounds allocation', () => {
    const input = select([1, 0, 1]); input.groups.push({...input.groups[0], faceIndices: [0]});
    const normalized = normalizeWorldCleanupSelection(input); input.groups[0].faceIndices[0] = 99;
    expect(normalized.groups[0].faceIndices).toEqual([0, 1]);
    expect(() => normalizeWorldCleanupSelection(select(new Array(MAX_CLEANUP_SELECTION_FACES + 1).fill(0)))).toThrow('budget');
    expect(() => normalizeWorldCleanupSelection(select([-1]))).toThrow('invalid source face');
  });

  it('handles repeated mesh instances by immutable node identity', () => {
    const {root, mesh} = room(), other = mesh.clone();
    other.userData.gessoSourceNode = {index: 4}; other.position.set(10, 0, 0); root.add(other);
    const input = select(); input.groups[0].nodeIndex = 4;
    const overlay = createWorldCleanupOverlay(root, input, sha)!;
    expect(overlay.meshes[0].parent).toBe(other); expect(mesh.children).toEqual([]); overlay.dispose();
  });
});

describe('world cleanup viewport lifetime', () => {
  function viewport() {
    const view = Object.create(StudioViewport.prototype) as any;
    Object.assign(view, {disposed: false, options: {studioMode: true}, presentationVersion: 0,
      deferredWorld: {ready: false, environment: {kind: 'mesh', asset: {sha256: sha}}}, worldRoot: null,
      worldCleanupOverlay: null, worldCleanupSelection: null, invalidate: vi.fn(), camera: new THREE.PerspectiveCamera(40, 1, .001, 100),
      loading: false, loadFailed: false, awaitingSample: false, productPreview: false, controls: null});
    view.camera.position.set(0, 1, 5); view.camera.lookAt(0, 0, 0); view.camera.updateMatrixWorld(true);
    return view;
  }

  it('queues selection until the matching mesh is ready, and releases it on source replacement', () => {
    const view = viewport(), {root} = room();
    view.setWorldCleanupSelection(select()); expect(view.worldCleanupOverlay).toBeNull();
    view.worldRoot = root; view.deferredWorld.ready = true; view.refreshWorldCleanupSelection();
    expect(view.worldCleanupOverlay?.triangleCount).toBe(1);
    const overlay = view.worldCleanupOverlay, dispose = vi.spyOn(overlay, 'dispose');
    view.deferredWorld.environment.asset.sha256 = 'b'.repeat(64); view.refreshWorldCleanupSelection();
    expect(dispose).toHaveBeenCalledOnce(); expect(view.worldCleanupOverlay).toBeNull();
  });

  it('leaves the verified source usable when a queued region has an invalid face', () => {
    const view = viewport(), {root, mesh} = room(), onError = vi.fn(), onWorldCleanupError = vi.fn();
    view.options.onError = onError; view.options.onWorldCleanupError = onWorldCleanupError;
    view.setWorldCleanupSelection(select([2])); view.worldRoot = root; view.deferredWorld.ready = true;
    expect(() => view.refreshWorldCleanupSelection()).not.toThrow();
    expect(view.worldCleanupSelection).toBeNull(); expect(view.worldCleanupOverlay).toBeNull();
    expect(view.deferredWorld.ready).toBe(true); expect(view.worldRoot).toBe(root); expect(mesh.children).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(onWorldCleanupError).toHaveBeenCalledWith(expect.stringContaining('outside its source primitive'));
  });

  it('does not move the camera on selection; explicit frame is recoverable by the existing reset', () => {
    const view = viewport(), {root} = room(); view.worldRoot = root; view.deferredWorld.ready = true;
    const position = view.camera.position.clone(), quaternion = view.camera.quaternion.clone();
    view.setWorldCleanupSelection(select());
    expect(view.camera.position.equals(position)).toBe(true); expect(view.camera.quaternion.equals(quaternion)).toBe(true);
    expect(view.frameWorldCleanupSelection()).toBe(true); expect(view.camera.position.equals(position)).toBe(false);
    view.resetFraming();
    expect(view.camera.position.equals(position)).toBe(true); expect(view.camera.quaternion.equals(quaternion)).toBe(true);
  });

  it('does not create or frame overlays in export capture or product inspection', () => {
    const view = viewport(), {root} = room(); view.worldRoot = root; view.deferredWorld.ready = true;
    view.options.capture = true; view.setWorldCleanupSelection(select()); expect(view.worldCleanupSelection).toBeNull();
    view.options.capture = false; view.setWorldCleanupSelection(select()); view.productPreview = true;
    expect(view.frameWorldCleanupSelection()).toBe(false);
    view.setWorldCleanupSelection(null); expect(view.worldCleanupOverlay).toBeNull();
  });
});
