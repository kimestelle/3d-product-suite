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
  Object.assign(view, { content: new THREE.Group(), components: new Map(), props: new Map(), plinths: new Map(), propSourcePoses: new Map(), loadVersion: 1, disposed: false,
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
    options: { onSelect: vi.fn(), onWorldPoint: vi.fn(), onSurfacePoint: vi.fn() },
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

function studioSource() {
  const scene = source(null) as any;
  scene.product.components = [];
  scene.product.dimensionsM = [.12, .24, .08];
  scene.environment = {
    kind: 'authored', worldColor: [.2, .2, .2],
    plinth: { id: 'support', visible: false, sizeM: [1, .2, 1], translationM: [0, 1, 0] },
    props: [],
  };
  return scene;
}

function sceneProp(id = 'table') {
  return { id, shape: 'box', sizeM: [.5, .1, .4], translationM: [0, .3, 0], rotationXyzw: [0, 0, 0, 1],
    material: { baseColor: [.2, .2, .2, 1], roughness: .6, metallic: 0 } };
}

describe('scene objects and solved relationships', () => {
  it('does not allocate hidden plinth or prop geometry and anchors the authored sweep at floorY', () => {
    const view = viewport(); const scene = studioSource();
    scene.environment.floorY = .35;
    scene.environment.props.push({ ...sceneProp(), visible: false });
    const factory = vi.spyOn(view, 'geometry');
    view.makeStudio(scene);
    expect(factory).not.toHaveBeenCalled();
    expect(view.plinths.size).toBe(0); expect(view.props.size).toBe(0);
    const floor = view.content.getObjectByName('Authored environment sweep');
    floor.geometry.computeBoundingBox();
    expect(floor.geometry.boundingBox.min.y).toBeCloseTo(.35);
    expect(view.content.getObjectByName('Explicit contact plinth')).toBeUndefined();
  });

  it('keeps legacy visible plinths and uses their bottom only when no finite floor is declared', () => {
    const view = viewport(); const scene = studioSource();
    delete scene.environment.plinth.visible;
    scene.environment.floorY = NaN;
    view.makeStudio(scene);
    expect(view.plinths.get('support').userData.objectId).toBe('plinth:support');
    const floor = view.content.getObjectByName('Authored environment sweep');
    floor.geometry.computeBoundingBox();
    expect(floor.geometry.boundingBox.min.y).toBeCloseTo(.9);
    const bare = viewport(); const bareScene = studioSource();
    bare.makeStudio(bareScene);
    const bareFloor = bare.content.getObjectByName('Authored environment sweep');
    bareFloor.geometry.computeBoundingBox();
    expect(bareFloor.geometry.boundingBox.min.y).toBe(0);
  });

  it('applies authoritative prop poses, restores source fallback, and keeps props outside component state', async () => {
    const view = viewport(); const scene = studioSource();
    scene.environment.props.push(sceneProp());
    view.makeStudio(scene);
    vi.stubGlobal('document', { hidden: true });
    const prop = view.props.get('table');
    expect(prop.userData.objectId).toBe('prop:table');
    expect(view.components.has('table')).toBe(false);
    await view.frame({ props: { table: { translationM: [1, 2, 3], rotationXyzw: [0, 1, 0, 0] } } });
    expect(prop.position.toArray()).toEqual([1, 2, 3]);
    expect(prop.quaternion.toArray()).toEqual([0, 1, 0, 0]);
    await view.frame({});
    expect(prop.position.toArray()).toEqual([0, .3, 0]);
    expect(prop.quaternion.toArray()).toEqual([0, 0, 0, 1]);
  });

  it('renders authored plinth rotation and derives the floor from its complete rotated bounds', () => {
    const view = viewport(); const scene = studioSource();
    scene.environment.plinth.visible = true;
    scene.environment.plinth.rotationXyzw = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    view.makeStudio(scene);
    const plinth = view.plinths.get('support');
    expect(plinth.quaternion.toArray()).toEqual(scene.environment.plinth.rotationXyzw);
    const floor = view.content.getObjectByName('Authored environment sweep');
    floor.geometry.computeBoundingBox();
    const expected = 1 - (1 + .2) * Math.SQRT1_2 / 2;
    expect(floor.geometry.boundingBox.min.y).toBeCloseTo(expected);
    expect(new THREE.Box3().setFromObject(plinth).min.y).toBeCloseTo(expected);
  });

  it('selects props and plinths by scene-tree IDs and tracks aggregate product bounds across frames', async () => {
    const view = pickingViewport(); view.setWorldPickEnabled(false);
    const scene = studioSource(); scene.environment.plinth.visible = true;
    scene.environment.props.push(sceneProp());
    view.makeStudio(scene);
    vi.spyOn(view, 'invalidate').mockImplementation(() => {});
    view.setSelection('prop:table');
    expect(view.selection.box.getCenter(new THREE.Vector3()).toArray()).toEqual([0, .3, 0]);
    view.setSelection('plinth:support');
    expect(view.selection.box.getCenter(new THREE.Vector3()).y).toBe(1);
    const component = new THREE.Group(); component.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    view.components.set('body', component); view.content.add(component);
    view.setSelection('product-root');
    expect(view.selection.box.getCenter(new THREE.Vector3()).toArray()).toEqual([0, 0, 0]);
    vi.stubGlobal('document', { hidden: true });
    await view.frame({ components: { body: { translationM: [2, 3, 4], rotationXyzw: [0, 0, 0, 1] } } });
    expect(view.selection.box.getCenter(new THREE.Vector3()).toArray()).toEqual([2, 3, 4]);
    expect(view.components.size).toBe(1);
    view.worldRoot.add(plane());
    view.setSelection('world');
    expect(view.selection.box.isEmpty()).toBe(false);
  });

  it('picks the nearest visible prop or plinth without changing component IDs', () => {
    const view = pickingViewport(); view.setWorldPickEnabled(false);
    const product = new THREE.Group(); product.userData.componentId = 'body'; product.add(plane());
    view.components.set('body', product); view.content.add(product);
    const plinth = plane(); plinth.position.z = 1; plinth.userData.objectId = 'plinth:support';
    const prop = plane(); prop.position.z = 2; prop.userData.objectId = 'prop:table';
    view.plinths.set('support', plinth); view.props.set('table', prop); view.content.add(plinth, prop);
    pick(view); expect(view.options.onSelect).toHaveBeenLastCalledWith('prop:table');
    prop.visible = false;
    pick(view); expect(view.options.onSelect).toHaveBeenLastCalledWith('plinth:support');
    plinth.visible = false;
    pick(view); expect(view.options.onSelect).toHaveBeenLastCalledWith('body');
  });

  it.each([
    ['on-prop', [1.5, .6, -.8]],
    ['world-surface', [2, .9, .3]],
  ])('anchors lights and shadow targets to resolved %s placement with yaw and off-center assemblies', (_kind, origin) => {
    const view = viewport(); const scene = studioSource();
    scene.placement.restsOn = _kind === 'on-prop' ? 'table' : 'world-surface';
    const root = new THREE.Vector3().fromArray(origin);
    const rootRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .63);
    const assemblyRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .3);
    scene.product.components = [
      { id: 'cap', assembly: { translationM: [.04, .14, .03], rotationXyzw: [0, 0, 0, 1] } },
      { id: 'body', assembly: { translationM: [.04, .052, .03], rotationXyzw: assemblyRotation.toArray() } },
    ];
    scene.actions = [{ componentId: 'cap' }];
    const bodyPosition = new THREE.Vector3(.04, .052, .03).applyQuaternion(rootRotation).add(root);
    const bodyRotation = rootRotation.clone().multiply(assemblyRotation);
    view.latestSample = { components: {
      cap: { translationM: [8, 9, 10], rotationXyzw: [0, 1, 0, 0] },
      body: { translationM: bodyPosition.toArray(), rotationXyzw: bodyRotation.toArray() },
    } };
    view.makeStudio(scene);
    const lights = view.content.children.filter((object: THREE.Object3D) => object instanceof THREE.DirectionalLight);
    expect(lights).toHaveLength(3);
    const size = Math.max(...scene.product.dimensionsM);
    const offsets = [[-.19, .32, .24], [.22, .19, .07], [.06, .30, -.19]];
    lights.forEach((light: THREE.DirectionalLight, index: number) => {
      const expected = new THREE.Vector3().fromArray(offsets[index]).multiplyScalar(size / .12).add(root);
      expect(light.position.distanceTo(expected)).toBeLessThan(1e-10);
      expect(light.target.position.distanceTo(root.clone().add(new THREE.Vector3(0, size * .52, 0)))).toBeLessThan(1e-10);
    });
  });

  it('installs solved product and prop poses before the first render invalidation', async () => {
    const view = pickingViewport(); const scene = studioSource();
    const component = { ...sceneProp('body'), assembly: { translationM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1] } };
    scene.product.components = [component]; scene.environment.props.push(sceneProp());
    vi.stubGlobal('document', { hidden: false, fonts: { load: async () => {} } });
    const seen: number[][] = [];
    vi.spyOn(view, 'invalidate').mockImplementation(() => {
      seen.push([...view.components.get('body').position.toArray(), ...view.props.get('table').position.toArray()]);
    });
    const initial = { components: { body: { translationM: [4, 5, 6], rotationXyzw: [0, 1, 0, 0] } },
      props: { table: { translationM: [1, 2, 3], rotationXyzw: [0, 0, 0, 1] } } };
    await view.load(scene, undefined, initial);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(pose => JSON.stringify(pose) === JSON.stringify([4, 5, 6, 1, 2, 3]))).toBe(true);
    expect(view.components.get('body').quaternion.toArray()).toEqual([0, 1, 0, 0]);
  });
});

function surfaceViewport() {
  const view = pickingViewport();
  view.setSurfacePickEnabled(true);
  view.camera.up.set(0, 0, -1);
  view.camera.position.set(0, 5, 0);
  view.camera.lookAt(0, 0, 0);
  return view;
}

function horizontalPlane() {
  const mesh = plane(); mesh.rotation.x = -Math.PI / 2; return mesh;
}

describe('product placement surface picking', () => {
  it('transforms the face normal through embedded and alignment transforms into normalized world space', () => {
    const view = surfaceViewport();
    const embedded = new THREE.Group(); embedded.rotation.x = .2; embedded.scale.set(2, 3, 1);
    embedded.add(plane()); view.worldRoot.add(embedded);
    view.alignWorld(view.worldRoot, { sourceUp: 'Z', scaleToMeters: 2.5, translationM: [1, 2, 3] });
    view.worldRoot.updateWorldMatrix(true, true);
    const expected = new THREE.Vector3(0, 0, 1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(embedded.matrixWorld)).normalize();
    view.camera.position.set(1, 8, 3); view.camera.lookAt(1, 2, 3);
    pick(view);
    expect(view.options.onSurfacePoint).toHaveBeenCalledOnce();
    const result = view.options.onSurfacePoint.mock.calls[0][0];
    [1, 2, 3].forEach((n, i) => expect(result.worldPoint[i]).toBeCloseTo(n));
    expected.toArray().forEach((n, i) => expect(result.normal[i]).toBeCloseTo(n));
    expect(new THREE.Vector3().fromArray(result.normal).length()).toBeCloseTo(1);
    expect(view.options.onWorldPoint).not.toHaveBeenCalled();
    expect(view.options.onSelect).not.toHaveBeenCalled();
  });

  it('ignores props/product/plinth geometry and skips invisible or transparent world surfaces', () => {
    const view = surfaceViewport();
    const floor = horizontalPlane();
    const glass = horizontalPlane(); glass.position.y = 1; glass.material.transparent = true; glass.material.opacity = .5;
    const invisible = horizontalPlane(); invisible.position.y = 2; invisible.material.visible = false;
    view.worldRoot.add(floor, glass, invisible);
    for (const id of ['product', 'prop:table', 'plinth:support']) {
      const blocker = horizontalPlane(); blocker.position.y = 3; blocker.userData.objectId = id; view.content.add(blocker);
    }
    pick(view);
    expect(view.options.onSurfacePoint).toHaveBeenCalledOnce();
    const point = view.options.onSurfacePoint.mock.calls[0][0];
    expect(point.worldPoint[1]).toBeCloseTo(0); expect(point.normal[1]).toBeCloseTo(1);
  });

  it.each(['wall', 'underside', 'miss'])('rejects a %s without selecting a product or placing through it', kind => {
    const view = surfaceViewport(); const floor = horizontalPlane(); view.worldRoot.add(floor);
    if (kind === 'wall') {
      // A steep opaque surface is hit before the valid horizontal floor.
      const wall = horizontalPlane(); wall.rotation.x = -.3; wall.position.y = 1; view.worldRoot.add(wall);
    } else if (kind === 'underside') {
      floor.rotation.x = Math.PI / 2;
    } else floor.position.x = 5;
    pick(view);
    expect(view.options.onSurfacePoint).not.toHaveBeenCalled();
    expect(view.options.onSelect).not.toHaveBeenCalled();
    expect(view.options.onWorldPoint).not.toHaveBeenCalled();
  });

  it.each([
    ['loading', (view: any) => { view.loading = true; }],
    ['not ready', (view: any) => { view.worldReady = false; }],
    ['superseded', (view: any) => { view.loadVersion++; }],
    ['disposed', (view: any) => { view.disposed = true; }],
    ['offscreen', (view: any) => { view.visible = false; }],
    ['hidden tab', () => { vi.stubGlobal('document', { hidden: true }); }],
    ['capture', (view: any) => { view.options.capture = true; }],
    ['detached', (view: any) => { view.content.remove(view.worldRoot); }],
    ['hidden world', (view: any) => { view.worldRoot.visible = false; }],
    ['hidden content', (view: any) => { view.content.visible = false; }],
    ['singular alignment', (view: any) => { view.worldRoot.scale.setScalar(0); }],
  ])('rejects %s surface placement without selection fallthrough', (_name, change) => {
    const view = surfaceViewport(); view.worldRoot.add(horizontalPlane()); change(view); pick(view);
    expect(view.options.onSurfacePoint).not.toHaveBeenCalled();
    expect(view.options.onSelect).not.toHaveBeenCalled();
  });

  it('keeps calibration and placement modes mutually exclusive and clears both cursors', () => {
    const view = surfaceViewport();
    expect(view.surfacePickEnabled).toBe(true); expect(view.worldPickEnabled).toBe(false);
    view.setWorldPickEnabled(true);
    expect(view.surfacePickEnabled).toBe(false); expect(view.worldPickEnabled).toBe(true);
    view.setSurfacePickEnabled(true);
    expect(view.worldPickEnabled).toBe(false); expect(view.canvas.style.cursor).toBe('crosshair');
    view.setSurfacePickEnabled(false); expect(view.canvas.style.cursor).toBe('');
  });
});
