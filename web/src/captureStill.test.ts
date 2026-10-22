import * as THREE from 'three';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {StudioViewport} from './viewport';
import {filmGuideZoom} from './filmGuides';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}

function viewport(width = 800, height = 400) {
  const view = Object.create(StudioViewport.prototype) as any;
  const camera = new THREE.PerspectiveCamera(40, width / height, .001, 100);
  camera.position.set(.2, .1, .5); camera.lookAt(0, .08, 0);
  const scene = new THREE.Scene(), content = new THREE.Group();
  const material = new THREE.MeshPhysicalMaterial({transmission: 1, roughness: .1});
  const product = new THREE.Mesh(new THREE.BoxGeometry(), material);
  content.add(product); scene.add(content);
  const canvas = {style: {}, clientWidth: width, clientHeight: height, width, height};
  let ratio = 1, cssWidth = width, cssHeight = height;
  const events: string[] = [];
  const frames: {camera: THREE.PerspectiveCamera; pose: THREE.PerspectiveCamera; ratio: number; material: THREE.Material | THREE.Material[]; x: number}[] = [];
  const renderer = {
    getPixelRatio: () => ratio,
    setPixelRatio: vi.fn((value: number) => {
      ratio = value; canvas.width = Math.floor(cssWidth * ratio); canvas.height = Math.floor(cssHeight * ratio);
    }),
    setSize: vi.fn((w: number, h: number) => {
      cssWidth = w; cssHeight = h; canvas.width = Math.floor(w * ratio); canvas.height = Math.floor(h * ratio);
    }),
    render: vi.fn((_scene: THREE.Scene, cam: THREE.PerspectiveCamera) => {
      events.push(`render:${canvas.width}x${canvas.height}`);
      frames.push({camera: cam, pose: cam.clone(), ratio, material: product.material, x: product.position.x});
    }),
  };
  const png = new Blob(['pixels'], {type: 'image/png'});
  const copies: any[] = [];
  const createElement = vi.fn(() => {
    const copy = {width: 0, height: 0,
      getContext: vi.fn(() => ({drawImage: vi.fn((source: any, _x: number, _y: number, w: number, h: number) => {
        expect([source.width, source.height]).toEqual([w, h]);
        events.push('copy');
      })})),
      toBlob: vi.fn((callback: (blob: Blob | null) => void, type: string) => {
        expect(type).toBe('image/png'); events.push('encode'); queueMicrotask(() => callback(png));
      }),
    };
    copies.push(copy); return copy;
  });
  vi.stubGlobal('document', {hidden: false, createElement});
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  Object.assign(view, {
    camera, scene, content, canvas, renderer, options: {studioMode: true}, components: new Map([['product', product]]),
    controls: null, selection: null, parts: new Map([['product', product]]), selectedId: null,
    disposed: false, visible: true, suspended: false, loading: false, loadFailed: false, awaitingSample: false,
    loadVersion: 1, sampledLoadVersion: 1, unpresentedLoadVersion: null, frameRequest: 0,
    presentationVersion: 0, invalidationVersion: 0, pendingRender: 0, dirty: false,
    liveRender: null, frameQueue: Promise.resolve(), renderQueue: Promise.resolve(),
    pendingSize: {width, height}, renderedSize: {width, height}, renderedPixelRatio: 1,
    presentationCamera: null, stillCapture: null, stillRendering: false,
    filmContent: false, filmClip: {kind: 'scene'}, filmGuides: false, filmOutputAspect: 9 / 16,
    productPreview: false, sampledOptics: null, depthOfFieldPreview: null, spark: null,
    inspectingCamera: true, framedSelection: false, sampledCamera: null, materialPreviewState: null,
  });
  return {view, camera, product, canvas, renderer, frames, events, copies, png, createElement};
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('current viewport still capture', () => {
  it('makes a 320px PNG cover through the same render path and restores the live buffer', async () => {
    const {view,canvas,events,png,product,renderer}=viewport(1200,800);
    const visible:boolean[]=[];renderer.render.mockImplementation(()=>visible.push(product.visible));
    const cover=await view.capturePreview();
    expect(cover).toEqual({blob:png,width:320,height:213});
    expect(visible).toEqual([false,true]);
    expect(product.visible).toBe(true);
    expect([canvas.width,canvas.height]).toEqual([1175,783]);
    expect(view.stillCapture).toBeNull();expect(view.stillRendering).toBe(false);
  });

  it('copies one larger pass before clearing it, restores low pixels and reuses the same scene/camera identity', async () => {
    const {view, camera, product, canvas, renderer, frames, events, copies, png} = viewport();
    const position = camera.position.clone(), material = product.material;
    const still = await view.captureStill();
    expect(still).toEqual({blob: png, width: 2048, height: 1024});
    expect(events).toEqual(['render:2048x1024', 'copy', 'render:800x400', 'encode']);
    expect(renderer.render.mock.calls.every(([scene]) => scene === view.scene)).toBe(true);
    expect(frames[0].camera).toBe(frames[1].camera);
    expect(frames[0].camera).not.toBe(camera);
    expect(frames[0].pose.position).toEqual(position);
    expect(frames.every(frame => frame.material === material)).toBe(true);
    expect(camera.position).toEqual(position);
    expect([canvas.width, canvas.height, renderer.getPixelRatio()]).toEqual([800, 400, 1]);
    expect([copies[0].width, copies[0].height]).toEqual([1, 1]);
    expect(view.stillCapture).toBeNull(); expect(view.stillRendering).toBe(false);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    await view.captureStill();
    expect(new Set(frames.map(frame => frame.camera.id)).size).toBe(1);
  });

  it('preserves portrait aspect and the existing Film projection rather than recomputing an output crop', async () => {
    const {view, frames} = viewport(480, 960);
    view.filmContent = true; view.filmGuides = true;
    const still = await view.captureStill();
    expect([still.width, still.height]).toEqual([1024, 2048]);
    expect(frames[0].pose.aspect).toBe(.5);
    expect(frames[0].pose.zoom).toBe(filmGuideZoom(480, 960, 9 / 16));
    expect(frames[1].pose.projectionMatrix).toEqual(frames[0].pose.projectionMatrix);
  });

  it('uses the real optical path at both resolutions without changing focus or aperture', async () => {
    const {view, renderer, events} = viewport();
    const optics = {enabled: true, focusDistanceM: .5, fStop: 2.8};
    view.sampledOptics = optics;
    const preview = {render: vi.fn(() => events.push(`optics:${renderer.getPixelRatio()}`)), dispose: vi.fn()};
    view.depthOfFieldPreview = preview;
    await view.captureStill();
    expect(preview.render).toHaveBeenCalledTimes(2);
    expect(preview.render.mock.calls[0].slice(3, 6)).toEqual([800, 400, optics]);
    expect(preview.render.mock.calls[1].slice(3, 6)).toEqual([800, 400, optics]);
    expect(view.sampledOptics).toBe(optics);
    expect(events).toEqual(['optics:2.56', 'copy', 'optics:1', 'encode']);
    expect(preview.dispose).not.toHaveBeenCalled(); expect(renderer.render).not.toHaveBeenCalled();
  });

  it('waits for the existing material draft and captures its assigned material without reloading it', async () => {
    const {view, product, frames, renderer} = viewport();
    const ready = deferred();
    view.materialPreviewState = {revision: 3, pending: {promise: ready.promise}};
    const still = view.captureStill();
    await flush(); expect(renderer.render).not.toHaveBeenCalled();
    const draft = new THREE.MeshPhysicalMaterial({color: 'red'});
    product.material = draft; view.invalidate(); ready.resolve();
    await still;
    expect(frames.every(frame => frame.material === draft)).toBe(true);
    expect(product.material).toBe(draft);
  });

  it('cancels a wait for material maps without cancelling or replacing the shared draft', async () => {
    const {view, renderer} = viewport();
    const ready = deferred(), abort = new AbortController();
    const pending = {promise: ready.promise};
    view.materialPreviewState = {revision: 3, pending};
    const still = view.captureStill(abort.signal);
    const cancelled = expect(still).rejects.toMatchObject({name: 'AbortError'});
    await flush(); abort.abort(); await cancelled;
    expect(renderer.render).not.toHaveBeenCalled();
    expect(view.materialPreviewState.pending).toBe(pending);
    expect(view.stillCapture).toBeNull(); expect(view.stillRendering).toBe(false);
    ready.resolve();
  });

  it('finishes an in-flight live sort before starting the still sort', async () => {
    const {view, frames, events} = viewport();
    const first = deferred(), second = deferred();
    view.spark = {visible: true, renderSize: new THREE.Vector2(),
      update: vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)};
    const live = view.render(false); await flush();
    const still = view.captureStill(); await flush();
    expect(view.spark.update).toHaveBeenCalledOnce();
    first.resolve(); await live; await flush();
    expect(view.spark.update).toHaveBeenCalledTimes(2);
    expect(view.spark.renderSize.toArray()).toEqual([2048, 1024]);
    expect(frames).toHaveLength(1);
    second.resolve(); await still;
    expect(events).toEqual(['render:800x400', 'render:2048x1024', 'copy', 'render:800x400', 'encode']);
    expect(new Set(frames.map(frame => frame.camera.id)).size).toBe(1);
    expect(view.spark.renderSize.toArray()).toEqual([800, 400]);
  });

  it.each(['abort', 'resize', 'replacement', 'disposal', 'presentation', 'material'] as const)(
    'rejects %s during sorting without committing a stale high-resolution frame', async change => {
      const {view, renderer, createElement, canvas} = viewport();
      const sort = deferred(), abort = new AbortController();
      view.spark = {visible: true, renderSize: new THREE.Vector2(), update: vi.fn(() => sort.promise)};
      const task = view.captureStill(abort.signal);
      const failure = expect(task).rejects.toThrow();
      await flush();
      expect(view.spark.update).toHaveBeenCalledOnce();
      if (change === 'abort') abort.abort();
      if (change === 'resize') {canvas.clientWidth = 900; view.resize();}
      if (change === 'replacement') {view.loadVersion++; view.loading = true;}
      if (change === 'disposal') view.disposed = true;
      if (change === 'presentation') view.presentationVersion++;
      if (change === 'material') view.materialPreviewState = {revision: 1};
      sort.resolve(); await failure;
      expect(renderer.render).not.toHaveBeenCalled();
      expect(renderer.setPixelRatio).not.toHaveBeenCalled();
      expect(createElement).not.toHaveBeenCalled();
      expect(view.stillCapture).toBeNull(); expect(view.stillRendering).toBe(false);
      if (change === 'abort') expect(view.spark.renderSize.toArray()).toEqual([800, 400]);
    });

  it('restores the Gaussian render-size hint after a sort failure and permits a retry', async () => {
    const {view, renderer} = viewport();
    view.spark = {visible: true, renderSize: new THREE.Vector2(),
      update: vi.fn().mockRejectedValueOnce(new Error('sort failed')).mockResolvedValue(undefined)};
    await expect(view.captureStill()).rejects.toThrow('sort failed');
    expect(view.spark.renderSize.toArray()).toEqual([800, 400]);
    expect(renderer.render).not.toHaveBeenCalled();
    await expect(view.captureStill()).resolves.toMatchObject({width: 2048, height: 1024});
  });

  it('rejects a still cancelled during PNG encoding after restoring the preview', async () => {
    const {view, renderer, canvas, copies, createElement} = viewport();
    const encoded = deferred<Blob>(), abort = new AbortController();
    const makeCanvas = createElement.getMockImplementation()!;
    createElement.mockImplementation(() => {
      const copy = makeCanvas();
      copy.toBlob.mockImplementation((done: (blob: Blob) => void) => {void encoded.promise.then(done);});
      return copy;
    });
    const still = view.captureStill(abort.signal);
    const cancelled = expect(still).rejects.toMatchObject({name: 'AbortError'});
    await flush();
    expect([canvas.width, canvas.height, renderer.getPixelRatio()]).toEqual([800, 400, 1]);
    abort.abort(); encoded.resolve(new Blob(['pixels'], {type: 'image/png'}));
    await cancelled;
    expect([copies[0].width, copies[0].height]).toEqual([1, 1]);
  });

  it('rejects concurrent captures and keeps new samples behind the still until encoding settles', async () => {
    const {view, frames, createElement} = viewport();
    const encoded = deferred<Blob>();
    const makeCanvas = createElement.getMockImplementation()!;
    createElement.mockImplementation(() => {
      const copy = makeCanvas();
      copy.toBlob.mockImplementation((done: (blob: Blob) => void) => {void encoded.promise.then(done);});
      return copy;
    });
    const still = view.captureStill(), stale = expect(still).rejects.toThrow('The view changed');
    await flush();
    await expect(view.captureStill()).rejects.toThrow('already rendering');
    const sample = view.frame({components: {product: {translationM: [.8, 0, 0], rotationXyzw: [0, 0, 0, 1]}},
      camera: {positionM: [0, 0, 2], targetM: [0, 0, 0], focalLengthMm: 50}});
    await flush(); expect(frames.every(frame => frame.x === 0)).toBe(true);
    encoded.resolve(new Blob(['pixels'], {type: 'image/png'}));
    await stale; await sample;
    expect(frames.at(-1)!.x).toBe(.8);
  });

  it.each(['render', 'copy', 'encode'] as const)('restores the preview and releases temporary pixels on %s failure', async failure => {
    const {view, canvas, renderer, createElement, copies} = viewport();
    if (failure === 'render') renderer.render.mockImplementationOnce(() => {throw new Error('render failed');});
    const makeCanvas = createElement.getMockImplementation()!;
    createElement.mockImplementation(() => {
      const copy = makeCanvas();
      if (failure === 'copy') copy.getContext.mockImplementation(() => {throw new Error('copy failed');});
      if (failure === 'encode') copy.toBlob.mockImplementation((done: (blob: Blob | null) => void) => done(null));
      return copy;
    });
    await expect(view.captureStill()).rejects.toThrow();
    expect([canvas.width, canvas.height, renderer.getPixelRatio()]).toEqual([800, 400, 1]);
    expect(view.stillCapture).toBeNull(); expect(view.stillRendering).toBe(false);
    if (copies.length) expect([copies[0].width, copies[0].height]).toEqual([1, 1]);
  });

  it('does not change the separate export-capture path', async () => {
    const {view, renderer} = viewport();
    view.options.capture = true;
    await expect(view.captureStill()).rejects.toThrow('export viewport');
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
