import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {StudioViewport} from './viewport';

vi.mock('@sparkjsdev/spark', async () => {
  const {Group} = await import('three');
  return {
    SparkRenderer: class extends Group { dispose = vi.fn(); },
    SplatMesh: class extends Group { initialized = Promise.resolve(); dispose = vi.fn(); },
  };
});

function worldFixture() {
  const positions = new Float32Array([-.5, 0, 0, .5, 0, 0, 0, 1, 0]);
  const document = {
    asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0]}],
    nodes: [{name: 'Room', mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0}}]}],
    buffers: [{byteLength: positions.byteLength}],
    bufferViews: [{buffer: 0, byteLength: positions.byteLength}],
    accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-.5, 0, 0], max: [.5, 1, 0]}],
  };
  const json = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(28 + jsonLength + positions.byteLength);
  const header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true);
  header.setUint32(8, bytes.byteLength, true); header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, jsonLength).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  header.setUint32(20 + jsonLength, positions.byteLength, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(bytes, 28 + jsonLength).set(new Uint8Array(positions.buffer));
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const asset = {format: 'glb', sourceUp: 'Y', sha256, path: `assets/${sha256}.glb`};
  return {bytes, scene: {
    product: {components: []},
    environment: {kind: 'mesh', worldColor: [.1, .2, .3], asset},
  }};
}

function viewport(studioMode = true) {
  const view = Object.create(StudioViewport.prototype) as any;
  const scene = new THREE.Scene(), content = new THREE.Group();
  scene.add(content);
  Object.assign(view, {
    canvas: {style: {}, clientWidth: 256, clientHeight: 256},
    camera: new THREE.PerspectiveCamera(), scene, content,
    renderer: {setSize: vi.fn()},
    options: {studioMode, onLoading: vi.fn(), onError: vi.fn()},
    components: new Map(), parts: new Map(), environmentObjects: new Map(),
    originalVisibility: new Map(), focusMaterials: new Map(), previewMaterials: new Set(),
    hiddenParts: new Set(), focusPartIds: [], uvProbeSprites: [],
    loadVersion: 0, frameRequest: 0, disposed: false, visible: true,
    loading: false, loadFailed: false, awaitingSample: false,
    productPreview: false, inspectionEnabled: true, pendingSize: null,
    worldRoot: null, deferredWorld: null, worldReady: false, worldLoadVersion: -1,
    pendingRender: 0, controls: null,
  });
  vi.spyOn(view, 'scheduleRender').mockImplementation(() => {});
  // These tests exercise real world loading, GLB parsing, disposal and
  // presentation transitions; unrelated product/lighting creation is omitted.
  vi.spyOn(view, 'makeProduct').mockResolvedValue(undefined);
  vi.spyOn(view, 'makeStudio').mockImplementation(() => {});
  vi.spyOn(view, 'loadMeshProps').mockResolvedValue(undefined);
  vi.spyOn(view, 'loadSurfaceTextures').mockResolvedValue(undefined);
  vi.spyOn(view, 'loadHdri').mockResolvedValue(undefined);
  vi.stubGlobal('document', {hidden: false, fonts: {load: vi.fn(async () => [])}});
  return view;
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('deferred world lifetime', () => {
  it('defers a splat and its shadow collider together, then hides and disposes both with the room', async () => {
    const {bytes, scene} = worldFixture();
    const splatScene = {...scene, environment: {...scene.environment, kind: 'splat',
      asset: {...scene.environment.asset, format: 'spz', path: `assets/${'b'.repeat(64)}.spz`, sha256: 'b'.repeat(64)},
      collider: {asset: scene.environment.asset}}};
    const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
    const view = viewport(); view.setProductPreview(true); await view.load(splatScene);
    expect(fetch).not.toHaveBeenCalled(); expect(view.spark).toBeFalsy();
    view.setProductPreview(false); await view.deferredWorld.task;
    expect(fetch).toHaveBeenCalledOnce(); expect(view.deferredWorld.ready).toBe(true);
    const receiverRoot = [...view.environmentObjects.keys()].find((root: any) => root.children[0] !== view.splat) as THREE.Group;
    let receiver!: THREE.Mesh;
    receiverRoot.traverse(object => {if (object instanceof THREE.Mesh) receiver = object;});
    expect(receiver.material).toBeInstanceOf(THREE.ShadowMaterial);
    expect(receiver.receiveShadow).toBe(true); expect(receiver.castShadow).toBe(false);
    const disposeMaterial = vi.spyOn(receiver.material as THREE.Material, 'dispose');
    const spark = view.spark, splat = view.splat;
    view.setProductPreview(true);
    expect(receiverRoot.visible).toBe(false); expect(spark.visible).toBe(false);
    view.clearContent();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(spark.dispose).toHaveBeenCalledOnce(); expect(splat.dispose).toHaveBeenCalledOnce();
  });

  it('cleans up a splat if its collider fails, so retry creates only one world', async () => {
    const {bytes, scene} = worldFixture();
    const splatScene = {...scene, environment: {...scene.environment, kind: 'splat',
      collider: {asset: scene.environment.asset}}};
    const fetch = vi.fn().mockRejectedValueOnce(new Error('Collider unavailable'))
      .mockImplementation(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
    const view = viewport(); view.setProductPreview(true); await view.load(splatScene);
    view.setProductPreview(false);
    await expect(view.deferredWorld.task).rejects.toThrow('Collider unavailable');
    expect(view.spark).toBeNull(); expect(view.splat).toBeNull(); expect(view.environmentObjects.size).toBe(0);
    view.setProductPreview(true); view.setProductPreview(false); await view.deferredWorld.task;
    expect(view.deferredWorld.ready).toBe(true); expect(view.environmentObjects.size).toBe(2);
    view.clearContent();
  });

  it('does not fetch an invisible room in Product, then loads it once when entering World', async () => {
    const {bytes, scene} = worldFixture(), before = structuredClone(scene);
    const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
    const view = viewport(); view.setProductPreview(true);
    await view.load(scene);
    expect(fetch).not.toHaveBeenCalled();
    expect(view.worldRoot).toBeNull(); expect(view.worldReady).toBe(false);
    expect(view.scene.background.getHex()).toBe(0xffffff);
    view.setProductPreview(false);
    const firstTask = view.deferredWorld.task;
    view.setProductPreview(true);
    view.setProductPreview(false);
    expect(view.deferredWorld.task).toBe(firstTask);
    await firstTask;
    expect(fetch).toHaveBeenCalledOnce();
    expect(view.worldRoot.parent).toBe(view.content);
    expect(view.worldRoot.visible).toBe(true); expect(view.worldReady).toBe(true);
    view.setProductPreview(true); view.setProductPreview(false);
    await view.ensureWorld();
    expect(fetch).toHaveBeenCalledOnce();
    expect(scene).toEqual(before);
    view.clearContent();
  });

  it('keeps Product drawable if the user returns before the room finishes', async () => {
    const {bytes, scene} = worldFixture();
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => {resolve = done;})));
    const view = viewport(); view.setProductPreview(true); await view.load(scene);
    view.awaitingSample = false;
    view.setProductPreview(false);
    const pending = view.deferredWorld.task;
    await Promise.resolve();
    expect(view.canDraw()).toBe(false);
    expect(view.options.onLoading).toHaveBeenLastCalledWith(true);
    view.setProductPreview(true);
    expect(view.canDraw()).toBe(true);
    expect(view.options.onLoading).toHaveBeenLastCalledWith(false);
    resolve(new Response(bytes)); await pending;
    expect(view.worldRoot.visible).toBe(false);
    expect(view.scene.background.getHex()).toBe(0xffffff);
    expect(view.canDraw()).toBe(true);
    expect(view.options.onError).not.toHaveBeenCalled();
    view.clearContent();
  });

  it('disposes a decoded old room that finishes after a replacement scene loads', async () => {
    const {scene} = worldFixture();
    const view = viewport(); view.setProductPreview(true); await view.load(scene);
    const imported = new THREE.Group();
    const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
    imported.add(new THREE.Mesh(geometry, material));
    const disposeGeometry = vi.spyOn(geometry, 'dispose'), disposeMaterial = vi.spyOn(material, 'dispose');
    let resolve!: (root: THREE.Group) => void;
    vi.spyOn(view, 'loadVerifiedGlb').mockImplementation(() => new Promise<THREE.Group>(done => {resolve = done;}));
    view.setProductPreview(false);
    const pending = view.deferredWorld.task;
    await Promise.resolve();
    await view.load({...scene, environment: {kind: 'authored', worldColor: [.2, .2, .2]}});
    resolve(imported); await pending;
    expect(disposeGeometry).toHaveBeenCalledOnce(); expect(disposeMaterial).toHaveBeenCalledOnce();
    expect(view.worldRoot).toBeNull(); expect(view.worldReady).toBe(false);
    expect(view.deferredWorld).toBeNull(); expect(imported.parent).toBeNull();
    expect(view.options.onError).not.toHaveBeenCalled();
  });

  it('ignores a failed request belonging to a replaced scene', async () => {
    const {scene} = worldFixture();
    let reject!: (error: Error) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_done, fail) => {reject = fail;})));
    const view = viewport(); view.setProductPreview(true); await view.load(scene);
    view.setProductPreview(false);
    const pending = view.deferredWorld.task;
    await Promise.resolve();
    await view.load({...scene, environment: {kind: 'authored', worldColor: [.3, .3, .3]}});
    reject(new Error('Old room failed'));
    await expect(pending).rejects.toThrow('Old room failed');
    expect(view.options.onError).not.toHaveBeenCalled();
    expect(view.loadFailed).toBe(false); expect(view.worldRoot).toBeNull();
  });

  it('reports a current room failure and retries on the next visit', async () => {
    const {bytes, scene} = worldFixture();
    const fetch = vi.fn().mockRejectedValueOnce(new Error('Room unavailable'))
      .mockImplementation(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const view = viewport(); view.setProductPreview(true); await view.load(scene);
    view.setProductPreview(false);
    await expect(view.deferredWorld.task).rejects.toThrow('Room unavailable');
    expect(view.options.onError).toHaveBeenCalledExactlyOnceWith('Room unavailable');
    expect(view.options.onLoading).toHaveBeenLastCalledWith(false);
    expect(view.deferredWorld.ready).toBe(false); expect(view.deferredWorld.loading).toBe(false);
    view.setProductPreview(true); view.setProductPreview(false);
    await view.deferredWorld.task;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(view.worldReady).toBe(true);
    view.clearContent();
  });

  it.each([true, false])('loads the full world immediately for studioMode=%s when Product preview is off', async studioMode => {
    const {bytes, scene} = worldFixture();
    const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
    const view = viewport(studioMode);
    await view.load(scene);
    expect(fetch).toHaveBeenCalledOnce();
    expect(view.worldReady).toBe(true); expect(view.worldRoot.visible).toBe(true);
    view.clearContent();
  });
});
