import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioViewport } from './viewport';

function glb(extra: Record<string, unknown> = {}) {
  const coordinates = new Float32Array([-.01, -.02, -.003, .01, -.02, .003, 0, .02, 0]);
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Original hierarchy', translation: [.001, 0, 0], children: [1] }, { name: 'Original mesh', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ name: 'Original red material', pbrMetallicRoughness: { baseColorFactor: [.8, .1, .05, 1], metallicFactor: .3, roughnessFactor: .2 } }],
    buffers: [{ byteLength: coordinates.byteLength }], bufferViews: [{ buffer: 0, byteLength: coordinates.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-.01, -.02, -.003], max: [.01, .02, .003] }],
    ...extra,
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(28 + jsonLength + coordinates.byteLength);
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, jsonLength).fill(32); new Uint8Array(bytes, 20, json.length).set(json);
  header.setUint32(20 + jsonLength, coordinates.byteLength, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(bytes, 28 + jsonLength).set(new Uint8Array(coordinates.buffer));
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  return { bytes, asset: { format: 'glb', sourceUp: 'Y', sha256, path: `assets/${sha256}.glb` } };
}

function viewport() {
  // Exercise real Three/GLTF hierarchy loading without creating a WebGL context.
  const view = Object.create(StudioViewport.prototype) as any;
  Object.assign(view, { content: new THREE.Group(), components: new Map(), loadVersion: 1, disposed: false,
    camera: new THREE.PerspectiveCamera(), options: {}, frameQueue: Promise.resolve(), frameRequest: 0, selection: null, loading: false });
  return view;
}

function source(asset: unknown, materialOverride = false) {
  return { placement: { translationM: [.1, .2, .3] }, product: { components: [{
    id: 'real-component', shape: 'mesh', sizeM: [.02, .04, .006], asset, materialOverride,
    assembly: { translationM: [.01, .02, .03], rotationXyzw: [0, 0, 0, 1] },
    material: { baseColor: [.2, .7, .3, 1], roughness: .6, metallic: 0 },
  }] } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('real product component meshes', () => {
  it('loads verified bytes with original hierarchy/materials and applies exact rigid sampled poses', async () => {
    const fixture = glb(); const view = viewport(); const signal = new AbortController().signal;
    const fetch = vi.fn(async () => new Response(fixture.bytes)); vi.stubGlobal('fetch', fetch);
    await view.makeProduct(source(fixture.asset), 1, signal);
    expect(fetch).toHaveBeenCalledWith(`/api/assets/${fixture.asset.sha256}.glb`, { signal, credentials: 'same-origin' });
    const component = view.components.get('real-component');
    expect(component.userData.componentId).toBe('real-component');
    expect(component.position.toArray()).toEqual([.11, .22, .32999999999999996]);
    expect(component.scale.toArray()).toEqual([1, 1, 1]);
    const mesh = component.getObjectByName('Original_mesh') || component.getObjectByName('Original mesh');
    expect(mesh.material.name).toBe('Original red material');
    expect(mesh.material.color.toArray()).toEqual([.8, .1, .05]);
    expect(mesh.castShadow && mesh.receiveShadow).toBe(true);
    expect(mesh.parent.position.x).toBe(.001);
    vi.stubGlobal('document', { hidden: true });
    await view.frame({ components: { 'real-component': { translationM: [.4, .5, .6], rotationXyzw: [0, 0, 1, 0] } },
      camera: { positionM: [0, 0, 1], targetM: [0, 0, 0], focalLengthMm: 50 } });
    expect(component.position.toArray()).toEqual([.4, .5, .6]);
    expect(component.quaternion.toArray()).toEqual([0, 0, 1, 0]);
    expect(mesh.parent.position.x).toBe(.001);
  });

  it('replaces materials only for explicit overrides and releases replaced textures/materials', async () => {
    const fixture = glb(); const view = viewport(); vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    await view.makeProduct(source(fixture.asset, true), 1, new AbortController().signal);
    const component = view.components.get('real-component');
    const mesh = component.getObjectByName('Original_mesh') || component.getObjectByName('Original mesh');
    expect(mesh.material.color.toArray()).toEqual([.2, .7, .3]);
    expect(mesh.material.roughness).toBe(.6);
    const old = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
    const materialDispose = vi.spyOn(old, 'dispose'); const textureDispose = vi.spyOn(old.map!, 'dispose');
    mesh.material = old;
    view.overrideMaterial(component, source(fixture.asset).product.components[0].material);
    expect(materialDispose).toHaveBeenCalledOnce(); expect(textureDispose).toHaveBeenCalledOnce();
  });

  it('rejects modified bytes and external dependencies before the GLTF parser can request them', async () => {
    const fixture = glb(); const view = viewport(); const parser = vi.spyOn(GLTFLoader.prototype, 'parseAsync');
    vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    await expect(view.loadVerifiedGlb({ ...fixture.asset, sha256: '0'.repeat(64), path: `assets/${'0'.repeat(64)}.glb` }, new AbortController().signal)).rejects.toThrow('SHA-256');
    const external = glb({ images: [{ uri: 'https://external.example/private.png' }] });
    vi.stubGlobal('fetch', async () => new Response(external.bytes));
    await expect(view.loadVerifiedGlb(external.asset, new AbortController().signal)).rejects.toThrow('self-contained');
    expect(parser).not.toHaveBeenCalled();
  });

  it('rejects unsafe paths before fetching and discards meshes from superseded loads', async () => {
    const fixture = glb(); const view = viewport(); const fetch = vi.fn(async () => new Response(fixture.bytes));
    vi.stubGlobal('fetch', fetch);
    await expect(view.loadVerifiedGlb({ ...fixture.asset, path: `assets/../${fixture.asset.sha256}.glb` }, new AbortController().signal)).rejects.toThrow('safe');
    expect(fetch).not.toHaveBeenCalled();
    const dispose = vi.spyOn(view, 'disposeObject');
    fetch.mockImplementationOnce(async () => { view.loadVersion = 2; return new Response(fixture.bytes); });
    await view.makeProduct(source(fixture.asset), 1, new AbortController().signal);
    expect(view.components.size).toBe(0); expect(view.content.children).toHaveLength(0); expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains product geometry beneath embedded cameras while removing the camera', () => {
    const view = viewport(); const hierarchy = new THREE.Group(); const camera = new THREE.PerspectiveCamera();
    camera.position.set(.1, .2, .3);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.02, .04, .006), new THREE.MeshStandardMaterial());
    mesh.position.set(.01, .02, .03); camera.add(mesh); hierarchy.add(camera);
    hierarchy.updateMatrixWorld(true); const original = mesh.matrixWorld.clone();
    view.prepareImportedMesh(hierarchy);
    expect(camera.parent).toBeNull(); expect(mesh.parent).toBe(hierarchy);
    hierarchy.updateMatrixWorld(true); expect(mesh.matrixWorld.equals(original)).toBe(true);
  });
});
