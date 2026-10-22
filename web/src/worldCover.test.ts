import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import sceneFixture from '../../examples/bottle.scene.json';
import {alignWorldCover, boundedWorldCoverBytes, captureWorldCoverWithRetry, createWorldCoverObject, fitWorldCover, worldCoverKey, WORLD_COVER_BYTES} from './worldCover';
import {createStudioSweepGeometry, disposeSceneObject} from './sceneObjects';

const asset = {sha256: 'a'.repeat(64), path: `assets/${'a'.repeat(64)}.glb`, format: 'glb', sourceUp: 'Y', scaleToMeters: 1, translationM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1]};
const world = {kind: 'mesh', asset, worldColor: [.1, .2, .3]};
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();});

describe('world PNG covers', () => {
  it('coalesces renderer conflicts into bounded sequential retries and publishes the eventual PNG', async () => {
    vi.useFakeTimers();
    const png = new Blob(['png'], {type: 'image/png'});
    const capture = vi.fn().mockRejectedValueOnce(new Error('A still is already rendering.'))
      .mockRejectedValueOnce(new Error('The view changed. Render a new still.')).mockResolvedValue(png);
    const result = captureWorldCoverWithRetry(capture, new AbortController().signal);
    expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249); expect(capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(capture).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe(png); expect(capture).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops retrying a persistently busy renderer instead of polling forever', async () => {
    vi.useFakeTimers();
    const error = new Error('Wait for the current preview to finish loading.');
    const capture = vi.fn().mockRejectedValue(error);
    const result = captureWorldCoverWithRetry(capture, new AbortController().signal).catch(value => value);
    await vi.runAllTimersAsync();
    expect(await result).toBe(error); expect(capture).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels pending retries and discards a capture completed after cancellation', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const capture = vi.fn().mockRejectedValue(new Error('A still is already rendering.'));
    const result = captureWorldCoverWithRetry(capture, abort.signal).catch(value => value);
    await vi.advanceTimersByTimeAsync(10); abort.abort();
    expect(await result).toMatchObject({name: 'AbortError'});
    await vi.runAllTimersAsync(); expect(capture).toHaveBeenCalledTimes(1);
    let complete!: (blob: Blob) => void;
    const lateAbort = new AbortController();
    const late = captureWorldCoverWithRetry(() => new Promise(resolve => {complete = resolve;}), lateAbort.signal).catch(value => value);
    lateAbort.abort(); complete(new Blob(['stale']));
    expect(await late).toMatchObject({name: 'AbortError'});
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not retry a real encoding or graphics failure', async () => {
    vi.useFakeTimers();
    const error = new Error('The still could not be encoded.');
    const capture = vi.fn().mockRejectedValue(error);
    await expect(captureWorldCoverWithRetry(capture, new AbortController().signal)).rejects.toBe(error);
    expect(capture).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps identity through names and product edits, but invalidates the actual set geometry and alignment', () => {
    const key = worldCoverKey(world);
    expect(worldCoverKey({...world, displayName: 'Renamed', product: {id: 'bottle'}})).toBe(key);
    expect(worldCoverKey({...world, plinth: {visible: false}})).not.toBe(key);
    expect(worldCoverKey({...world, props: [{id: 'box'}]})).not.toBe(key);
    const authored = {...world, kind: 'authored', asset: undefined};
    expect(worldCoverKey({...authored, plinth: {sizeM: [1, 2, 3]}})).not.toBe(worldCoverKey(authored));
    expect(worldCoverKey({...world, asset: {...asset, scaleToMeters: .1}})).not.toBe(key);
    expect(worldCoverKey({...world, asset: {...asset, translationM: [1, 0, 0]}})).not.toBe(key);
    expect(worldCoverKey({...world, asset: {...asset, sha256: 'b'.repeat(64)}})).not.toBe(key);
    expect(worldCoverKey({...world, worldColor: [0, 0, 0]})).not.toBe(key);
  });
  it('converts Z-up before applying the saved rotation, matching the live world', () => {
    const root = new THREE.Group();
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .7);
    alignWorldCover(root, {...asset, sourceUp: 'Z', rotationXyzw: rotation.toArray(), scaleToMeters: 2, translationM: [4, 5, 6]});
    const expected = rotation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    expect(root.quaternion.angleTo(expected)).toBeLessThan(1e-7);
    expect(root.scale.toArray()).toEqual([2, 2, 2]);
    expect(root.position.toArray()).toEqual([4, 5, 6]);
    const up = new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion);
    expect(up.distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-7);
  });
  it('cancels oversized responses before reading any body bytes', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({cancel}), {headers: {'Content-Length': String(WORLD_COVER_BYTES + 1)}});
    vi.stubGlobal('fetch', vi.fn(async () => response));
    expect(await boundedWorldCoverBytes(asset, new AbortController().signal)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds chunked responses too, without trusting absent Content-Length', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(WORLD_COVER_BYTES + 1));}, cancel}));
    vi.stubGlobal('fetch', vi.fn(async () => response));
    expect(await boundedWorldCoverBytes(asset, new AbortController().signal)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('never loads splats or imported props into another renderer', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await createWorldCoverObject({...world, kind: 'splat'}, new AbortController().signal)).toBeNull();
    expect(await createWorldCoverObject({...sceneFixture.environment, props: [{shape: 'mesh'}]}, new AbortController().signal)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('renders the authored contact surface and exact shared sweep geometry before it is selected', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const environment = structuredClone(sceneFixture.environment);
    const object = await createWorldCoverObject(environment, new AbortController().signal, sceneFixture.product.dimensionsM);
    expect(object).not.toBeNull();
    try {
      const floor = object!.getObjectByName('Studio sweep') as THREE.Mesh<THREE.BufferGeometry>;
      const height = environment.plinth.translationM[1] - environment.plinth.sizeM[1] / 2 - .0001;
      const expected = createStudioSweepGeometry(height, Math.max(...sceneFixture.product.dimensionsM) * 3);
      expect(Array.from(floor.geometry.getAttribute('position').array)).toEqual(Array.from(expected.getAttribute('position').array));
      expected.dispose();
      expect(object!.children).toHaveLength(2);
      const focus = object!.userData.gessoCoverBounds as THREE.Box3;
      expect(focus.getSize(new THREE.Vector3()).x).toBeCloseTo(environment.plinth.sizeM[0]);
      const camera = new THREE.PerspectiveCamera(40, 16 / 9); fitWorldCover(camera, object!);
      expect(camera.position.y).toBeGreaterThan(focus.getCenter(new THREE.Vector3()).y);
      expect(fetch).not.toHaveBeenCalled();
      expect(environment).toEqual(sceneFixture.environment);
    } finally {disposeSceneObject(object!);}
  });
  it('keys and renders a fixed authored studio independently of raw product dimensions', async () => {
    const environment = {...structuredClone(sceneFixture.environment), studioSizeM: .32};
    const small = [.32, .16, .24], large = [320, 160, 240];
    expect(worldCoverKey(environment, small)).toBe(worldCoverKey(environment, large));
    expect(worldCoverKey({...environment, studioSizeM: .64}, small)).not.toBe(worldCoverKey(environment, small));
    expect(worldCoverKey(sceneFixture.environment, small)).not.toBe(worldCoverKey(sceneFixture.environment, large));
    const objects = await Promise.all([small, large].map(dimensions => createWorldCoverObject(environment, new AbortController().signal, dimensions)));
    try {
      const geometry = (object: THREE.Object3D | null) => (object!.getObjectByName('Studio sweep') as THREE.Mesh).geometry.getAttribute('position').array;
      expect(Array.from(geometry(objects[0]))).toEqual(Array.from(geometry(objects[1])));
      const floorHeight = environment.plinth.translationM[1] - environment.plinth.sizeM[1] / 2 - .0001;
      const expected = createStudioSweepGeometry(floorHeight, .32 * 3);
      expect(Array.from(geometry(objects[0]))).toEqual(Array.from(expected.getAttribute('position').array));
      expected.dispose();
    } finally {objects.forEach(object => disposeSceneObject(object!));}
  });
  it('uses the actual gallery GLB with its authored materials and source transform', async () => {
    const bytes = readFileSync(new URL('../../examples/worlds/default-gallery.glb', import.meta.url));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const data = new Uint8Array(bytes);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .2).toArray();
    const environment = {...world, asset: {...asset, sha256, path: `assets/${sha256}.glb`, scaleToMeters: 2, translationM: [1, 2, 3], rotationXyzw: rotation}};
    const before = structuredClone(environment);
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith('blob:') ? originalFetch(input, init) : new Response(data)));
    const object = await createWorldCoverObject(environment, new AbortController().signal);
    expect(object).not.toBeNull();
    try {
      expect(object!.scale.toArray()).toEqual([2, 2, 2]);
      expect(object!.position.toArray()).toEqual([1, 2, 3]);
      expect(object!.quaternion.toArray()).toEqual(rotation);
      expect(object!.getObjectByProperty('isMesh', true)).toBeDefined();
      expect(environment).toEqual(before);
    } finally {disposeSceneObject(object!);}
  });
  it.each([[10, .1, .2], [.1, 10, 2], [2, 1, 20]])('frames all world corners for bounds %j', (x, y, z) => {
    const object = new THREE.Mesh(new THREE.BoxGeometry(x, y, z), new THREE.MeshStandardMaterial());
    object.rotation.y = .4; object.position.set(40, -12, 5);
    const camera = new THREE.PerspectiveCamera(40, 16 / 9);
    fitWorldCover(camera, object);
    const bounds = new THREE.Box3().setFromObject(object, true);
    for (const xx of [bounds.min.x, bounds.max.x]) for (const yy of [bounds.min.y, bounds.max.y]) for (const zz of [bounds.min.z, bounds.max.z]) {
      const point = new THREE.Vector3(xx, yy, zz).project(camera);
      expect(Math.abs(point.x)).toBeLessThanOrEqual(.880001);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(.880001);
      expect(point.z).toBeGreaterThan(-1); expect(point.z).toBeLessThan(1);
    }
    disposeSceneObject(object);
  });
});
