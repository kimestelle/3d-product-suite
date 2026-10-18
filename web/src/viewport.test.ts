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
  Object.assign(view, { canvas: { style: {} }, scene: new THREE.Scene(), content: new THREE.Group(), components: new Map(), loadVersion: 1, disposed: false,
    camera: new THREE.PerspectiveCamera(), options: {}, frameQueue: Promise.resolve(), frameRequest: 0, selection: null, loading: false,
    parts: new Map(), originalVisibility: new Map(), focusMaterials: new Map(), previewMaterials: new Set(), hiddenParts: new Set(),
    partFocus: false, focusPartIds: [], framedSelection: false, inspectingCamera: false, inspectionEnabled: true,
    controls: null, controlListeners: null, interactionSurface: null, controlSurface: null, sampledCamera: null, loadedProductKey: null,
    environmentObjects: new Map(), environmentBackground: null, productPreview: false, productGround: null,
    loadFailed: false, awaitingSample: false, pendingSize: null, renderedSize: null, liveRender: null });
  vi.spyOn(view, 'scheduleRender').mockImplementation(() => {});
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
  it('waits for verified material maps before publishing the new part tree', async () => {
    const bytes = new ArrayBuffer(33), header = new DataView(bytes);
    header.setUint32(0, 0x89504e47); header.setUint32(4, 0x0d0a1a0a); header.setUint32(8, 13);
    header.setUint32(12, 0x49484452); header.setUint32(16, 2); header.setUint32(20, 2);
    const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
    const scene: any = source(undefined); scene.product.components[0].shape = 'box';
    scene.product.components[0].material.textures = { basecolor: { path: `assets/${sha256}.png`, sha256, format: 'png' } };
    vi.stubGlobal('fetch', async () => new Response(bytes));
    let finish!: (bitmap: ImageBitmap) => void;
    const decode = vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve; })); vi.stubGlobal('createImageBitmap', decode);
    const view = viewport(), onParts = vi.fn(); view.options.onParts = onParts;
    const pending = view.makeProduct(scene, 1, new AbortController().signal);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(onParts).not.toHaveBeenCalled(); expect(view.parts.size).toBe(0);
    const image = { width: 2, height: 2, close: vi.fn() } as unknown as ImageBitmap;
    finish(image); await pending;
    expect(onParts).toHaveBeenCalledOnce();
    expect(view.components.get('real-component').children[0].material.map.image).toBe(image);
  });

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

  it('exposes immutable source node indices, original names and material slots across repeated imports', async () => {
    const fixture = glb({ nodes: [
      { name: 'Assembly / Original', children: [1, 2] },
      { name: 'Repeated part', mesh: 0 }, { name: 'Repeated part', mesh: 0, translation: [.1, 0, 0] },
    ] });
    vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    const first = viewport(); first.options.onParts = vi.fn();
    const second = viewport(); second.options.onParts = vi.fn();
    await first.makeProduct(source(fixture.asset), 1, new AbortController().signal);
    await second.makeProduct(source(fixture.asset), 1, new AbortController().signal);
    const records = first.options.onParts.mock.calls[0][0];
    expect(records).toEqual(second.options.onParts.mock.calls[0][0]);
    expect(records.map((record: any) => [record.id, record.parentId, record.name])).toEqual([
      ['real-component', null, 'real-component'],
      ['real-component::node:0', 'real-component', 'Assembly / Original'],
      ['real-component::node:1', 'real-component::node:0', 'Repeated part'],
      ['real-component::node:2', 'real-component::node:0', 'Repeated part'],
    ]);
    expect(records[2].sourcePath).toBe('nodes[1]');
    expect(records[2].materialSlots).toEqual([{ id: 'real-component::material:0', name: 'Original red material' }]);
    expect(records[2].dimensionsM[1]).toBeCloseTo(.04);
    expect(first.parts.get('real-component::node:2').position.x).toBe(.1);
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

function studioViewport() {
  const view = pickingViewport();
  view.options.studioMode = true;
  view.setWorldPickEnabled(false);
  vi.spyOn(view, 'invalidate').mockImplementation(() => {});
  const body = new THREE.Group(); const cap = new THREE.Group();
  const texture = new THREE.Texture();
  const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(.04, .08, .04), new THREE.MeshStandardMaterial({ map: texture }));
  const label = new THREE.Mesh(new THREE.PlaneGeometry(.03, .05), new THREE.MeshBasicMaterial({ transparent: true, opacity: .8, map: texture }));
  label.position.z = .021; bodyMesh.castShadow = true;
  body.add(bodyMesh, label);
  cap.add(new THREE.Mesh(new THREE.BoxGeometry(.02, .02, .02), new THREE.MeshStandardMaterial()));
  cap.position.y = .06;
  view.components.set('body', body); view.components.set('cap', cap);
  view.content.add(body, cap);
  view.parts.set('body', body); view.parts.set('cap', cap);
  body.traverse((object: THREE.Object3D) => view.originalVisibility.set(object, object.visible));
  cap.traverse((object: THREE.Object3D) => view.originalVisibility.set(object, object.visible));
  return { view, body, bodyMesh, label, cap, texture };
}

describe('Product presentation lifecycle', () => {
  it('retains the white view across asset reloads and restores the imported World without changing the document', async () => {
    const { view } = studioViewport();
    const fixture = glb();
    vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    vi.stubGlobal('document', { hidden: true, fonts: { load: vi.fn(async () => []) } });
    const scene = { ...source(fixture.asset),
      product: { ...source(fixture.asset).product, dimensionsM: [.02, .04, .006] },
      environment: { kind: 'mesh', worldColor: [.1, .2, .3], asset: fixture.asset,
        plinth: { sizeM: [.3, .07, .2], translationM: [.1, .165, .3] } },
    };
    const before = structuredClone(scene);
    view.setProductPreview(true);
    await view.load(scene);
    expect(view.scene.background.getHex()).toBe(0xffffff);
    expect(view.worldRoot.visible).toBe(false);
    expect(view.worldRoot.parent).toBe(view.content);
    expect(view.productGround.visible).toBe(true);
    expect(view.productGround.position.y).toBeCloseTo(.1999);
    const oldGround = view.productGround;
    const disposeGround = vi.spyOn(oldGround.geometry, 'dispose');
    const revised = structuredClone(scene); revised.product.components[0].material.roughness = .2;
    await view.load(revised);
    expect(disposeGround).toHaveBeenCalledOnce();
    expect(view.productGround).not.toBe(oldGround);
    expect(view.scene.background.getHex()).toBe(0xffffff);
    expect(view.worldRoot.visible).toBe(false);
    expect(view.productGround.visible).toBe(true);
    view.setProductPreview(false);
    expect(view.scene.background.toArray()).toEqual(scene.environment.worldColor);
    expect(view.worldRoot.visible).toBe(true);
    expect(view.worldRoot.parent).toBe(view.content);
    expect(view.worldReady).toBe(true);
    expect(view.productGround.visible).toBe(false);
    expect(scene).toEqual(before);
    view.setProductPreview(true);
    view.clearScene();
    expect(view.environmentObjects.size).toBe(0);
    expect(view.productGround).toBeNull();
    expect(view.scene.background).toBeNull();
    expect(view.productPreview).toBe(true);
  });
});

describe('studio part editing preview', () => {
  it('makes other parts and label ink translucent, restoring original materials without disposing shared textures', () => {
    const { view, bodyMesh, label, cap, texture } = studioViewport();
    const originalBody = bodyMesh.material; const originalLabel = label.material;
    const textureDispose = vi.spyOn(texture, 'dispose');
    view.setSelection('cap'); view.setPartFocus(true);
    expect(view.selection).toBeNull();
    expect(bodyMesh.material).not.toBe(originalBody);
    expect(bodyMesh.material.opacity).toBe(.18);
    expect(label.material.opacity).toBeCloseTo(.144);
    expect(bodyMesh.castShadow).toBe(false);
    expect(((cap.children[0] as THREE.Mesh).material as THREE.Material).opacity).toBe(1);
    expect(originalBody.opacity).toBe(1); expect(originalLabel.opacity).toBe(.8);
    expect(bodyMesh.material.map).toBe(texture);
    const cloneDispose = vi.spyOn(bodyMesh.material, 'dispose');
    view.setPartFocus(false);
    expect(bodyMesh.material).toBe(originalBody); expect(label.material).toBe(originalLabel);
    expect(bodyMesh.castShadow).toBe(true);
    expect(cloneDispose).toHaveBeenCalledOnce(); expect(textureDispose).not.toHaveBeenCalled();
  });

  it('allows selecting and hiding an imported subtree without changing its source transforms or sibling visibility', async () => {
    const fixture = glb({ nodes: [
      { name: 'Assembly', children: [1, 2] },
      { name: 'Shell', mesh: 0 }, { name: 'Insert', mesh: 0, translation: [.1, 0, 0] },
    ] });
    const { view } = studioViewport();
    vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    await view.makeProduct(source(fixture.asset), 1, new AbortController().signal);
    const shell = view.parts.get('real-component::node:1');
    const insert = view.parts.get('real-component::node:2');
    const insertMaterial = insert.material;
    view.setSelection('real-component::node:1'); view.setPartFocus(true);
    expect(shell.material.opacity).toBe(1); expect(insert.material.opacity).toBe(.18);
    view.setHiddenParts(['real-component::node:2']);
    expect(insert.visible).toBe(false); expect(shell.visible).toBe(true);
    view.setHiddenParts([]); view.setPartFocus(false);
    expect(insert.visible).toBe(true); expect(insert.material).toBe(insertMaterial);
    expect(insert.position.x).toBe(.1);
  });

  it('ignores specimen selection clicks while preserving world calibration', () => {
    const { view, body } = studioViewport();
    body.userData.componentId = 'body';
    pick(view);
    expect(view.options.onSelect).not.toHaveBeenCalled();
    view.worldRoot.add(plane()); view.setWorldPickEnabled(true); pick(view);
    expect(view.options.onWorldPoint).toHaveBeenCalledOnce();
    expect(view.options.onSelect).not.toHaveBeenCalled();
  });

  it('focuses and frames semantic members together without reparenting source objects', () => {
    const { view, body, bodyMesh, label, cap } = studioViewport();
    const originalBody = bodyMesh.material; const originalLabel = label.material;
    const sourceParent = body.parent;
    const sourcePosition = body.position.clone();
    view.setSelection('cap'); view.setPartFocus(true); view.frameSelection();
    const capDistance = view.camera.position.z;
    expect(bodyMesh.material).not.toBe(originalBody);
    view.setFocusParts(['cap', 'body', 'cap']);
    expect(bodyMesh.material).toBe(originalBody); expect(label.material).toBe(originalLabel);
    expect(view.camera.position.z).toBeGreaterThan(capDistance);
    expect(view.camera.position.y).toBeCloseTo(.015);
    expect(body.parent).toBe(sourceParent); expect(cap.parent).toBe(sourceParent);
    expect(body.position.equals(sourcePosition)).toBe(true);
    view.setFocusParts([]);
    expect(bodyMesh.material.opacity).toBe(.18);
    expect(view.camera.position.z).toBeCloseTo(capDistance);
    expect(view.camera.position.y).toBeCloseTo(.06);
    view.setFocusParts(['missing-source-id']);
    expect(bodyMesh.material.opacity).toBe(.18);
    expect(view.camera.position.z).toBeCloseTo(capDistance);
  });

  it('excludes hidden members from semantic group framing', () => {
    const { view } = studioViewport();
    view.setSelection('cap'); view.setFocusParts(['cap', 'body']); view.setHiddenParts(['body']);
    view.frameSelection();
    expect(view.camera.position.y).toBeCloseTo(.06);
  });

  it('frames a part and resets to the latest sampled camera without mutating the sample or output aspect', async () => {
    const { view } = studioViewport();
    vi.stubGlobal('document', { hidden: true });
    view.canvas.clientWidth = 1000; view.canvas.clientHeight = 700; view.resize();
    const sample = { components: {}, camera: { positionM: [0, 0, 1], targetM: [0, 0, 0], focalLengthMm: 50 } };
    const unchanged = structuredClone(sample);
    await view.frame(sample); view.setSelection('cap'); view.frameSelection();
    expect(view.camera.position.z).toBeLessThan(1);
    expect(view.camera.position.y).toBeCloseTo(.06);
    expect(view.camera.aspect).toBe(1000 / 700);
    const nextSample = { ...sample, camera: { ...sample.camera, positionM: [0, 0, 2] } };
    await view.frame(nextSample);
    expect(view.camera.position.z).toBeLessThan(1);
    view.resetFraming();
    expect(view.camera.position.toArray()).toEqual([0, 0, 2]);
    expect(sample).toEqual(unchanged);
  });

  it('releases focused material clones and original resources once when clearing the scene', () => {
    const { view, bodyMesh, label, texture } = studioViewport();
    const originalBody = bodyMesh.material; const originalLabel = label.material;
    const sourceDispose = vi.spyOn(originalBody, 'dispose'); const labelDispose = vi.spyOn(originalLabel, 'dispose');
    const textureDispose = vi.spyOn(texture, 'dispose');
    view.setSelection('cap'); view.setPartFocus(true);
    const cloneDispose = vi.spyOn(bodyMesh.material, 'dispose');
    view.clearContent();
    expect(cloneDispose).toHaveBeenCalledOnce(); expect(sourceDispose).toHaveBeenCalledOnce();
    expect(labelDispose).toHaveBeenCalledOnce(); expect(textureDispose).toHaveBeenCalledOnce();
    expect(view.parts.size).toBe(0); expect(view.previewMaterials.size).toBe(0);
  });

  it('keeps studio-only visibility, focus and framing out of capture', () => {
    const { view, bodyMesh, body } = studioViewport(); view.options.capture = true;
    const material = bodyMesh.material; const camera = view.camera.position.clone();
    view.setSelection('cap'); view.setPartFocus(true); view.setHiddenParts(['body']); view.frameSelection();
    expect(bodyMesh.material).toBe(material); expect(body.visible).toBe(true);
    expect(view.camera.position.equals(camera)).toBe(true);
  });
});

function orbitViewport(capture = false) {
  const setup = studioViewport();
  const documentEvents = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    style: { cursor: '', touchAction: '' } as Record<string, string>, clientWidth: 1000, clientHeight: 700,
    getRootNode: () => documentEvents,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
    setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
  });
  setup.view.canvas = canvas;
  setup.view.options.capture = capture;
  setup.view.options.onInteract = vi.fn();
  const add = vi.spyOn(canvas, 'addEventListener'); const remove = vi.spyOn(canvas, 'removeEventListener');
  const removeDocument = vi.spyOn(documentEvents, 'removeEventListener');
  setup.view.createControls();
  const emit = (type: string, properties: Record<string, unknown> = {}, target: EventTarget = canvas) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 500, clientY: 350,
      pageX: 500, pageY: 350, ctrlKey: false, metaKey: false, shiftKey: false, deltaMode: 0, deltaY: 0 }, properties);
    target.dispatchEvent(event);
    return event;
  };
  return { ...setup, canvas, emit, add, remove, removeDocument };
}

describe('studio camera inspection', () => {
  it.each(['orbit', 'framed'])('keeps %s inspection through a material revision and resets to the revised shot', async mode => {
    const { view, emit } = orbitViewport();
    const fixture = glb();
    vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    vi.stubGlobal('document', { hidden: true, fonts: { load: vi.fn(async () => []) } });
    vi.spyOn(view, 'makeStudio').mockImplementation(() => {});
    const scene = { ...source(fixture.asset, true), environment: { kind: 'authored', worldColor: [.1, .1, .1] } };
    const sample = { components: {}, camera: { positionM: [.17, .15, .35], targetM: [0, .073, 0], focalLengthMm: 50 } };
    await view.load(scene); await view.frame(sample); view.setSelection('real-component');
    if (mode === 'orbit') {
      emit('pointerdown'); emit('pointermove', { clientX: 580, pageX: 580 }); emit('pointerup');
    } else view.frameSelection();
    const inspectingPosition = view.camera.position.clone();
    const revised = structuredClone(scene); revised.product.components[0].material.roughness = .15;
    await view.load(revised);
    const nextSample = { ...sample, camera: { ...sample.camera, positionM: [.1, .2, .8] } };
    await view.frame(nextSample);
    expect(view.inspectingCamera).toBe(true); expect(view.framedSelection).toBe(mode === 'framed');
    expect(view.camera.position.distanceTo(inspectingPosition)).toBeLessThan(1e-10);
    let material: THREE.MeshStandardMaterial | undefined;
    view.components.get('real-component').traverse((object: THREE.Object3D) => {
      if (object instanceof THREE.Mesh) material = object.material as THREE.MeshStandardMaterial;
    });
    expect(material?.roughness).toBe(.15);
    view.resetFraming();
    expect(view.camera.position.toArray()).toEqual([.1, .2, .8]);
    expect(view.controls.target.toArray()).toEqual([0, .073, 0]);
  });

  it('resets inspection for a different source asset and after explicit clearScene', async () => {
    const { view } = orbitViewport();
    const first = glb(); const second = glb({ nodes: [{ name: 'Replacement geometry', mesh: 0 }] });
    vi.stubGlobal('fetch', async (url: string) => new Response(url.includes(first.asset.sha256) ? first.bytes : second.bytes));
    vi.stubGlobal('document', { hidden: true, fonts: { load: vi.fn(async () => []) } });
    vi.spyOn(view, 'makeStudio').mockImplementation(() => {});
    const scene = { ...source(first.asset), environment: { kind: 'authored', worldColor: [.1, .1, .1] } };
    await view.load(scene); view.setSelection('real-component'); view.frameSelection();
    expect(view.inspectingCamera).toBe(true);
    await view.load({ ...scene, product: source(second.asset).product });
    expect(view.inspectingCamera).toBe(false); expect(view.framedSelection).toBe(false);
    view.frameSelection(); expect(view.inspectingCamera).toBe(true);
    view.clearScene();
    expect(view.inspectingCamera).toBe(false); expect(view.loadedProductKey).toBeNull();
  });

  it('orbits, pans and zooms the preview while restoring the exact latest sampled camera', async () => {
    const { view, emit } = orbitViewport();
    vi.stubGlobal('document', { hidden: true });
    const sample = { components: {}, camera: { positionM: [.17, .15, .35], targetM: [0, .073, 0], focalLengthMm: 50 } };
    const unchanged = structuredClone(sample);
    await view.frame(sample);
    const initialPosition = view.camera.position.clone();
    emit('pointerdown'); emit('pointermove', { clientX: 580, pageX: 580 }); emit('pointerup');
    expect(view.camera.position.equals(initialPosition)).toBe(false);
    expect(view.options.onInteract).toHaveBeenCalledOnce();
    expect(view.inspectingCamera).toBe(true); expect(view.framedSelection).toBe(false);
    const orbitPosition = view.camera.position.clone();
    const nextSample = { ...sample, camera: { ...sample.camera, positionM: [.1, .2, .8] } };
    await view.frame(nextSample);
    expect(view.camera.position.equals(orbitPosition)).toBe(true);
    const originalTarget = view.controls.target.clone();
    emit('pointerdown', { shiftKey: true });
    emit('pointermove', { shiftKey: true, clientX: 550, pageX: 550 }); emit('pointerup');
    expect(view.controls.target.equals(originalTarget)).toBe(false);
    const beforeZoom = view.camera.position.distanceTo(view.controls.target);
    expect(emit('wheel', { deltaY: 120 }).defaultPrevented).toBe(true);
    expect(view.camera.position.distanceTo(view.controls.target)).toBeGreaterThan(beforeZoom);
    expect(view.controls.enableDamping).toBe(false); expect(view.controls.autoRotate).toBe(false);
    const expectedQuaternion = view.sampledCamera.quaternion.clone();
    view.resetFraming();
    expect(view.camera.position.toArray()).toEqual([.1, .2, .8]);
    expect(view.camera.quaternion.equals(expectedQuaternion)).toBe(true);
    expect(view.controls.target.toArray()).toEqual([0, .073, 0]);
    expect(view.inspectingCamera).toBe(false); expect(sample).toEqual(unchanged);
  });

  it('disables orbit during calibration, comparison and loading without consuming wheel events', () => {
    const { view, emit } = orbitViewport();
    const position = view.camera.position.clone();
    view.setWorldPickEnabled(true);
    expect(view.controls.enabled).toBe(false);
    expect(emit('wheel', { deltaY: 120 }).defaultPrevented).toBe(false);
    expect(view.camera.position.equals(position)).toBe(true);
    expect(view.options.onInteract).not.toHaveBeenCalled();
    view.setWorldPickEnabled(false);
    expect(view.controls.enabled).toBe(true);
    view.setInspectionEnabled(false);
    expect(view.controls.enabled).toBe(false);
    expect(emit('wheel', { deltaY: 120 }).defaultPrevented).toBe(false);
    view.setWorldPickEnabled(true); expect(view.worldPickEnabled).toBe(true);
    view.setWorldPickEnabled(false); view.setInspectionEnabled(true);
    view.loading = true; view.updateControlsEnabled();
    expect(view.controls.enabled).toBe(false);
  });

  it('routes native orbit, modifier pan and wheel to an overlay without changing the camera pose', () => {
    const { view, canvas, emit } = orbitViewport();
    emit('pointerdown'); emit('pointermove', { clientX: 580, pageX: 580 }); emit('pointerup');
    const position = view.camera.position.clone(), quaternion = view.camera.quaternion.clone();
    const target = view.controls.target.clone();
    const interactCount = view.options.onInteract.mock.calls.length;
    const documentEvents = new EventTarget();
    const overlay = Object.assign(new EventTarget(), {
      style: { cursor: 'crosshair', touchAction: 'pan-y' }, clientWidth: 1000, clientHeight: 700,
      getRootNode: () => documentEvents,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
      setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
    });
    view.setInteractionSurface(overlay);
    expect(view.controls.domElement).toBe(overlay);
    expect(view.camera.position.equals(position)).toBe(true);
    expect(view.camera.quaternion.equals(quaternion)).toBe(true);
    expect(view.controls.target.equals(target)).toBe(true);
    expect(view.inspectingCamera).toBe(true);
    expect(view.options.onInteract).toHaveBeenCalledTimes(interactCount);
    expect(canvas.style.cursor).toBe(''); expect(canvas.style.touchAction).toBe('');
    expect(overlay.style.cursor).toBe('grab'); expect(overlay.style.touchAction).toBe('none');
    expect(emit('wheel', { deltaY: 120 }).defaultPrevented).toBe(false);
    expect(view.camera.position.equals(position)).toBe(true);
    emit('pointerdown', {}, overlay);
    emit('pointermove', { clientX: 620, pageX: 620 }, overlay); emit('pointerup', {}, overlay);
    expect(view.camera.position.equals(position)).toBe(false);
    const panTarget = view.controls.target.clone();
    emit('pointerdown', { shiftKey: true }, overlay);
    emit('pointermove', { shiftKey: true, clientX: 550, pageX: 550 }, overlay); emit('pointerup', {}, overlay);
    expect(view.controls.target.equals(panTarget)).toBe(false);
    const distance = view.camera.position.distanceTo(view.controls.target);
    expect(emit('wheel', { deltaY: 120 }, overlay).defaultPrevented).toBe(true);
    expect(view.camera.position.distanceTo(view.controls.target)).toBeGreaterThan(distance);
    const pinchDistance = view.camera.position.distanceTo(view.controls.target);
    emit('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 400, pageX: 400 }, overlay);
    emit('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 600, pageX: 600 }, overlay);
    emit('pointermove', { pointerType: 'touch', pointerId: 3, clientX: 700, pageX: 700 }, overlay);
    expect(view.camera.position.distanceTo(view.controls.target)).toBeLessThan(pinchDistance);
    emit('pointerup', { pointerType: 'touch', pointerId: 3 }, overlay);
    emit('pointerup', { pointerType: 'touch', pointerId: 2 }, overlay);
    view.setInteractionSurface(null);
    expect(overlay.style.cursor).toBe('crosshair'); expect(overlay.style.touchAction).toBe('pan-y');
    expect(view.controls.domElement).toBe(canvas);
    expect(emit('wheel', { deltaY: 120 }, overlay).defaultPrevented).toBe(false);
    expect(emit('wheel', { deltaY: 120 }).defaultPrevented).toBe(true);
  });

  it('releases an overlay gesture on collapse and starts clean on the canvas', () => {
    const { view, canvas, emit } = orbitViewport();
    const documentEvents = new EventTarget();
    const captured = new Set<number>();
    const overlay = Object.assign(new EventTarget(), {
      style: { cursor: 'crosshair', touchAction: 'auto' }, clientWidth: 1000, clientHeight: 700,
      getRootNode: () => documentEvents,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
      setPointerCapture: vi.fn((id: number) => captured.add(id)),
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
    });
    const remove = vi.spyOn(overlay, 'removeEventListener');
    view.setInteractionSurface(overlay);
    emit('pointerdown', { pointerId: 9 }, overlay);
    emit('pointermove', { pointerId: 9, clientX: 580, pageX: 580 }, overlay);
    expect(captured.has(9)).toBe(true);
    const position = view.camera.position.clone(), target = view.controls.target.clone();
    view.setInteractionSurface(null);
    expect(overlay.releasePointerCapture).toHaveBeenCalledWith(9);
    expect(captured.size).toBe(0);
    expect(remove.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture', 'wheel']));
    expect(view.camera.position.equals(position)).toBe(true);
    expect(view.controls.target.equals(target)).toBe(true);
    emit('pointermove', { pointerId: 9, clientX: 700, pageX: 700 }, overlay);
    expect(view.camera.position.equals(position)).toBe(true);
    emit('pointerdown', { pointerId: 9 });
    emit('pointermove', { pointerId: 9, clientX: 560, pageX: 560 }); emit('pointerup', { pointerId: 9 });
    expect(view.camera.position.equals(position)).toBe(false);
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(9);
    expect(view.controls.domElement).toBe(canvas);
  });

  it('removes canvas/document listeners and has no orbit listener on capture', () => {
    const { view, emit, remove, removeDocument } = orbitViewport();
    const controls = view.controls;
    const dispose = vi.spyOn(controls, 'dispose');
    view.disposeControls();
    expect(dispose).toHaveBeenCalledOnce(); expect(view.controls).toBeNull();
    expect(remove.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'contextmenu']));
    expect(removeDocument).toHaveBeenCalledWith('keydown', expect.any(Function), { capture: true });
    emit('wheel', { deltaY: 120 }); expect(view.options.onInteract).not.toHaveBeenCalled();
    const capture = orbitViewport(true);
    expect(capture.view.controls).toBeNull(); expect(capture.add).not.toHaveBeenCalled();
  });
});


describe('Poly Haven world assets', () => {
  it('frames a large prop after loading and restores the latest authored shot exactly', async () => {
    const view = viewport(); view.options.studioMode = true; view.camera.aspect = 1.4;
    vi.stubGlobal('document', { hidden: true });
    const sample = { components: {}, camera: { positionM: [0, 0, 1], targetM: [0, 0, 0], focalLengthMm: 50 } };
    const original = structuredClone(sample); await view.frame(sample);
    view.frameWorldObject('large-vase');
    expect(view.camera.position.toArray()).toEqual([0, 0, 1]); // pending import leaves the current view intact
    view.clearContent(true); expect(view.framedWorldObjectId).toBe('large-vase');
    const prop = new THREE.Group(); prop.name = 'large-vase'; prop.position.set(.4, .2, 0);
    prop.add(new THREE.Mesh(new THREE.BoxGeometry(.2, .4, .2))); view.addEnvironmentObject(prop);
    const nextSample = { ...sample, camera: { ...sample.camera, positionM: [0, 0, 2] } };
    await view.frame(nextSample);
    expect(view.camera.position.x).toBeCloseTo(.4); expect(view.camera.position.y).toBeCloseTo(.2);
    const bounds = new THREE.Box3().setFromObject(prop);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const ndc = new THREE.Vector3(x, y, z).project(view.camera);
      expect(Math.abs(ndc.x)).toBeLessThan(1); expect(Math.abs(ndc.y)).toBeLessThan(1);
    }
    view.resetFraming(); expect(view.camera.position.toArray()).toEqual([0, 0, 2]);
    expect(sample).toEqual(original); expect(view.framedWorldObjectId).toBeNull();
    view.options.capture = true; view.frameWorldObject('large-vase');
    expect(view.camera.position.toArray()).toEqual([0, 0, 2]);
  });

  it('keeps imported prop hierarchy and source materials while sizing its instance', async () => {
    const fixture = glb(); const view = viewport(); vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    const scene = { environment: { props: [{ id: 'prop-library', shape: 'mesh',
      asset: { ...fixture.asset, sourceDimensionsM: [.02, .04, .006] }, sizeM: [.04, .12, .024],
      translationM: [.4, .5, .6], rotationXyzw: [0, 0, 0, 1], materialOverride: false }] } };
    await view.loadMeshProps(scene, 1, new AbortController().signal);
    const prop = view.content.getObjectByName('prop-library');
    expect(prop.scale.toArray()).toEqual([2, 3, 4]); expect(prop.position.toArray()).toEqual([.4, .5, .6]);
    const mesh = prop.getObjectByName('Original_mesh') || prop.getObjectByName('Original mesh');
    expect(mesh.material.name).toBe('Original red material'); expect(mesh.parent.position.x).toBe(.001);
    const originalMaterial = mesh.material, originalOpacity = mesh.material.opacity;
    const product = new THREE.Group(); product.add(new THREE.Mesh(new THREE.BoxGeometry(.01, .01, .01)));
    view.parts.set('product', product); view.components.set('product', product); view.content.add(product);
    view.options.studioMode = true; view.focusPartIds = ['product']; view.setPartFocus(true);
    expect(mesh.material).toBe(originalMaterial); expect(mesh.material.opacity).toBe(originalOpacity);
    expect(view.environmentObjects.has(prop)).toBe(true);
    const dimensions = new THREE.Box3().setFromObject(prop).getSize(new THREE.Vector3()).toArray();
    dimensions.forEach((value, i) => expect(value).toBeCloseTo(scene.environment.props[0].sizeM[i], 7));
    view.options.studioMode = true; view.setProductPreview(true); expect(prop.visible).toBe(false);
  });

  it('rejects prop metadata that differs from verified geometry', async () => {
    const fixture = glb(); const view = viewport(); vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    const dispose = vi.spyOn(view, 'disposeObject');
    await expect(view.loadMeshProps({ environment: { props: [{ id: 'bad', shape: 'mesh',
      asset: { ...fixture.asset, sourceDimensionsM: [1, 1, 1] }, sizeM: [1, 1, 1] }] } }, 1, new AbortController().signal)).rejects.toThrow('dimensions');
    expect(dispose).toHaveBeenCalledOnce(); expect(view.environmentObjects.size).toBe(0);
  });

  it('verifies HDR bytes and installs rotated image lighting without replacing the background', async () => {
    const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n');
    const bytes = new Uint8Array(header.length + 8); bytes.set(header); bytes.set([128, 64, 32, 129, 128, 64, 32, 129], header.length);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const view = viewport(), target = new THREE.WebGLRenderTarget(4, 4);
    view.scene.background = new THREE.Color(0xffffff);
    const prefilter = vi.spyOn(view, 'prefilterEnvironment').mockReturnValue(target);
    vi.stubGlobal('fetch', async () => new Response(bytes));
    const hdri = { asset: { format: 'hdr', path: `assets/${sha256}.hdr`, sha256 }, intensity: 1.7, rotationDeg: 30 };
    await view.loadHdri({ lighting: { hdri } }, 1, new AbortController().signal);
    const texture = prefilter.mock.calls[0][0] as THREE.DataTexture;
    expect(texture.image.width).toBe(2); expect(texture.image.height).toBe(1);
    expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace); expect(texture.flipY).toBe(true);
    expect(view.scene.environment).toBe(target.texture); expect(view.scene.background.getHex()).toBe(0xffffff);
    expect(view.scene.environmentIntensity).toBe(1.7); expect(view.scene.environmentRotation.y).toBeCloseTo(Math.PI / 6);
    const release = vi.spyOn(target, 'dispose'); view.clearContent();
    expect(release).toHaveBeenCalledOnce(); expect(view.scene.environment).toBeNull();
    await expect(view.loadHdri({ lighting: { hdri: { ...hdri, asset: { ...hdri.asset, sha256: '0'.repeat(64), path: `assets/${'0'.repeat(64)}.hdr` } } } }, 1, new AbortController().signal)).rejects.toThrow('SHA-256');
    expect(prefilter).toHaveBeenCalledOnce();
  });
});
