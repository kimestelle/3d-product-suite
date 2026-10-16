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

function pickingViewport() {
  const view = viewport();
  const world = new THREE.Group();
  const scene = new THREE.Scene();
  scene.add(view.content);
  view.content.add(world);
  view.camera = new THREE.PerspectiveCamera(40, 9 / 16, .001, 100);
  view.camera.position.set(0, 0, 5);
  view.camera.lookAt(0, 0, 0);
  Object.assign(view, {
    scene, worldRoot: world, worldLoadVersion: 1, worldReady: true,
    worldPickEnabled: false, visible: true, raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(),
    canvas: { style: {}, clientWidth: 180, clientHeight: 320,
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 180, height: 320 }) },
    renderer: { setSize: vi.fn() },
    options: { onSelect: vi.fn(), onWorldPoint: vi.fn() },
  });
  vi.stubGlobal('document', { hidden: false });
  view.setWorldPickEnabled(true);
  return view;
}

function plane() {
  return new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

function pick(view: any) {
  view.content.updateMatrixWorld(true);
  view.pickAtPointer({ button: 0, clientX: 100, clientY: 180 });
}

describe('world calibration picking', () => {
  it('returns raw GLB scene coordinates retaining embedded transforms and undoes the complete alignment root', () => {
    const view = pickingViewport();
    const embedded = new THREE.Group();
    embedded.position.set(.4, .5, .6);
    embedded.rotation.z = Math.PI / 2;
    const mesh = plane();
    mesh.position.set(.2, .3, .1);
    embedded.add(mesh);
    view.worldRoot.add(embedded);
    // Embedded transforms give source [.1, .7, .7]. Alignment maps it to
    // world [2.75, 3.75, 2.75], without changing the embedded hierarchy.
    view.alignWorld(view.worldRoot, { sourceUp: 'Y', scaleToMeters: 2.5,
      rotationXyzw: [0, Math.SQRT1_2, 0, Math.SQRT1_2], translationM: [1, 2, 3] });
    view.camera.position.set(6.75, 3.75, 2.75);
    view.camera.lookAt(2.75, 3.75, 2.75);
    pick(view);
    expect(view.options.onWorldPoint).toHaveBeenCalledOnce();
    const result = view.options.onWorldPoint.mock.calls[0][0];
    [.1, .7, .7].forEach((value, i) => expect(result.sourcePoint[i]).toBeCloseTo(value, 10));
    [2.75, 3.75, 2.75].forEach((value, i) => expect(result.worldPoint[i]).toBeCloseTo(value, 10));
    expect(view.options.onSelect).not.toHaveBeenCalled();
    expect(mesh.position.toArray()).toEqual([.2, .3, .1]);
  });

  it('excludes product, plinth and props even when they are in front, then preserves normal product selection', () => {
    const view = pickingViewport();
    view.worldRoot.add(plane());
    const product = new THREE.Group(); product.userData.componentId = 'product';
    const productMesh = plane(); productMesh.position.z = 2; product.add(productMesh);
    view.components.set('product', product);
    const plinth = plane(); plinth.position.z = 3;
    const prop = plane(); prop.position.z = 4;
    view.content.add(product, plinth, prop);
    pick(view);
    expect(view.options.onWorldPoint).toHaveBeenCalledOnce();
    expect(view.options.onWorldPoint.mock.calls[0][0]).toEqual({ sourcePoint: [0, 0, 0], worldPoint: [0, 0, 0] });
    expect(view.options.onSelect).not.toHaveBeenCalled();
    view.setWorldPickEnabled(false);
    pick(view);
    expect(view.options.onSelect).toHaveBeenCalledExactlyOnceWith('product');
    expect(view.options.onWorldPoint).toHaveBeenCalledOnce();
  });

  it.each([
    ['loading', (view: any) => { view.loading = true; }],
    ['not ready', (view: any) => { view.worldReady = false; }],
    ['superseded load', (view: any) => { view.loadVersion++; }],
    ['disposed', (view: any) => { view.disposed = true; }],
    ['offscreen viewport', (view: any) => { view.visible = false; }],
    ['hidden tab', () => { vi.stubGlobal('document', { hidden: true }); }],
    ['capture viewport', (view: any) => { view.options.capture = true; }],
    ['detached world', (view: any) => { view.content.remove(view.worldRoot); }],
    ['hidden world', (view: any) => { view.worldRoot.visible = false; }],
    ['hidden content', (view: any) => { view.content.visible = false; }],
    ['singular alignment', (view: any) => { view.worldRoot.scale.setScalar(0); }],
  ])('ignores a %s without falling through to product selection', (_name, change) => {
    const view = pickingViewport(); view.worldRoot.add(plane());
    const product = new THREE.Group(); product.userData.componentId = 'product'; product.add(plane());
    view.content.add(product); view.components.set('product', product);
    change(view);
    pick(view);
    expect(view.options.onWorldPoint).not.toHaveBeenCalled();
    expect(view.options.onSelect).not.toHaveBeenCalled();
  });

  it('skips hidden world surfaces and ignores a ray miss', () => {
    const view = pickingViewport();
    const hidden = new THREE.Group(); hidden.visible = false; hidden.add(plane());
    const invisible = plane(); invisible.material.visible = false;
    const transparent = plane(); transparent.material.transparent = true; transparent.material.opacity = 0;
    const away = plane(); away.position.x = 5;
    view.worldRoot.add(hidden, invisible, transparent, away);
    pick(view);
    expect(view.options.onWorldPoint).not.toHaveBeenCalled();
    expect(view.options.onSelect).not.toHaveBeenCalled();
  });

  it('releases the world reference when content is cleared, blocking stale picks', () => {
    const view = pickingViewport(); const mesh = plane(); view.worldRoot.add(mesh);
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    pick(view);
    view.clearContent();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(view.worldRoot).toBeNull();
    pick(view);
    expect(view.options.onWorldPoint).toHaveBeenCalledOnce();
    expect(view.options.onSelect).not.toHaveBeenCalled();
  });

  it('aborts pending work and releases a hidden paired world without destroying its context', () => {
    const view = pickingViewport(); view.worldRoot.add(plane());
    const controller = new AbortController(); view.assetAbort = controller;
    view.loading = true; view.frameRequest = 4; view.pendingRender = 0;
    const invalidate = vi.spyOn(view, 'invalidate').mockImplementation(() => {});
    view.clearScene();
    expect(controller.signal.aborted).toBe(true);
    expect(view.assetAbort).toBeNull(); expect(view.loading).toBe(false);
    expect(view.loadVersion).toBe(2); expect(view.frameRequest).toBe(5);
    expect(view.worldRoot).toBeNull(); expect(view.content.children).toHaveLength(0);
    expect(view.disposed).toBe(false); expect(view.renderer).toBeDefined();
    expect(invalidate).toHaveBeenCalledOnce();
    pick(view);
    expect(view.options.onWorldPoint).not.toHaveBeenCalled();
  });

  it('keeps paired viewport picking and portrait projection independent', () => {
    const first = pickingViewport(); const second = pickingViewport();
    first.worldRoot.add(plane()); second.worldRoot.add(plane());
    second.worldRoot.position.z = -1;
    second.canvas.clientWidth = 270; second.canvas.clientHeight = 480;
    first.resize(); second.resize();
    expect(first.camera.aspect).toBe(9 / 16); expect(second.camera.aspect).toBe(9 / 16);
    first.setWorldPickEnabled(false);
    pick(first); pick(second);
    expect(first.options.onWorldPoint).not.toHaveBeenCalled();
    expect(second.options.onWorldPoint).toHaveBeenCalledExactlyOnceWith({ sourcePoint: [0, 0, 0], worldPoint: [0, 0, -1] });
    expect(first.canvas.style.cursor).toBe(''); expect(second.canvas.style.cursor).toBe('crosshair');
  });
});
