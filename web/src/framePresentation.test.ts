import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioViewport } from './viewport';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function viewport(capture = false) {
  // Keep the real presentation path and camera math, without a WebGL context.
  const view = Object.create(StudioViewport.prototype) as any;
  const scene = new THREE.Scene();
  const content = new THREE.Group();
  scene.add(content);
  const camera = new THREE.PerspectiveCamera(40, 2, .001, 100);
  camera.position.set(0, 0, 2);
  const canvas = { style: {}, clientWidth: 800, clientHeight: 400, width: 800, height: 400 };
  const events: string[] = [];
  const presented: THREE.PerspectiveCamera[] = [];
  let pixelRatio = 1;
  const renderer = {
    setSize: vi.fn((width: number, height: number) => {
      events.push(`size:${width}x${height}`);
      canvas.width = Math.floor(width * pixelRatio); canvas.height = Math.floor(height * pixelRatio);
    }),
    setPixelRatio: vi.fn((ratio: number) => { pixelRatio = ratio; }),
    render: vi.fn((_scene: THREE.Scene, renderedCamera: THREE.PerspectiveCamera) => {
      events.push('render'); presented.push(renderedCamera.clone());
    }),
    getPixelRatio: vi.fn(() => pixelRatio),
    getDrawingBufferSize: vi.fn((size: THREE.Vector2) => size.set(canvas.width, canvas.height)),
    getContext: vi.fn(() => ({ finish })),
  };
  const finish = vi.fn();
  Object.assign(view, {
    scene, content, camera, canvas, renderer, options: { capture }, disposed: false, visible: true,
    dirty: false, pendingRender: 0, loadVersion: 1, unpresentedLoadVersion: 1, sampledLoadVersion: -1, loading: false, loadFailed: false, awaitingSample: false,
    pendingSize: { width: 800, height: 400 }, renderedSize: { width: 800, height: 400 },
    liveRender: null, renderQueue: Promise.resolve(), frameQueue: Promise.resolve(), frameRequest: 0,
    spark: null, components: new Map(), controls: null, selection: null,
    inspectingCamera: false, framedSelection: false, sampledCamera: null,
  });
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return { view, canvas, renderer, events, presented, finish };
}

function splats(view: any, update: (...args: any[]) => Promise<void>) {
  const spark = { visible: true, renderSize: new THREE.Vector2(), update: vi.fn(update),
    sorting: false, sortDirty: false, sortTimeoutId: undefined };
  view.spark = spark;
  return spark;
}

function sample(x: number) {
  return { components: {}, camera: { positionM: [x, 0, 2], targetM: [0, 0, 0], focalLengthMm: 50 } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('viewport frame presentation', () => {
  it('keeps the current buffer during resize, commits immediately before drawing, and ignores repeated or hidden sizes', async () => {
    const { view, canvas, renderer, events } = viewport();
    canvas.clientWidth = 960; canvas.clientHeight = 540;
    view.resize();
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(view.camera.aspect).toBeCloseTo(16 / 9);
    await view.draw(false, 1);
    expect(events).toEqual(['size:960x540', 'render']);
    expect(renderer.setSize).toHaveBeenCalledWith(960, 540, false);

    view.resize();
    await view.draw(false, 1);
    expect(renderer.setSize).toHaveBeenCalledOnce();
    canvas.clientWidth = 0; canvas.clientHeight = 0;
    view.resize();
    expect(view.pendingSize).toEqual({ width: 960, height: 540 });
    expect(view.camera.aspect).toBeCloseTo(16 / 9);
    await view.draw(false, 1);
    expect(renderer.setSize).toHaveBeenCalledOnce();
  });

  it('waits for Gaussian sorting without clearing the old buffer and presents the same camera and size that were sorted', async () => {
    const { view, canvas, renderer, events, presented } = viewport();
    const sort = deferred();
    const spark = splats(view, () => sort.promise);
    canvas.clientWidth = 900; canvas.clientHeight = 600;
    view.resize();
    const draw = view.draw(false, 1);
    await flush();
    expect(spark.renderSize.toArray()).toEqual([900, 600]);
    const sortedCamera = spark.update.mock.calls[0][0].camera;
    expect(sortedCamera).not.toBe(view.camera);
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();

    // A concurrent layout change and orbit must not alter the in-flight sort.
    canvas.clientWidth = 600; canvas.clientHeight = 600;
    view.resize();
    view.camera.position.x = 4;
    sort.resolve();
    await draw;
    expect(events).toEqual(['size:900x600', 'render']);
    expect(presented[0].aspect).toBe(1.5);
    expect(presented[0].position.x).toBe(0);
    expect(renderer.render.mock.calls[0][1]).toBe(sortedCamera);
    expect(view.pendingSize).toEqual({ width: 600, height: 600 });
    expect(view.dirty).toBe(true);
  });

  it('sorts and presents large live viewports within the preview budget while retaining their CSS aspect', async () => {
    const { view, canvas, renderer, presented } = viewport();
    const sort = deferred();
    const spark = splats(view, () => sort.promise);
    canvas.clientWidth = 1920; canvas.clientHeight = 1080;
    view.resize();
    const draw = view.draw(false, 1);
    await flush();
    expect(spark.renderSize.toArray()).toEqual([1280, 720]);
    expect(renderer.setPixelRatio).not.toHaveBeenCalled();
    expect(renderer.setSize).not.toHaveBeenCalled();
    sort.resolve();
    await draw;
    expect(renderer.setPixelRatio).toHaveBeenCalledExactlyOnceWith(2 / 3);
    expect(renderer.setSize).toHaveBeenCalledExactlyOnceWith(1920, 1080, false);
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(presented[0].aspect).toBeCloseTo(16 / 9);
  });

  it('does not commit a sorted frame after a replacement load begins or while its first sample is missing', async () => {
    const { view, canvas, renderer } = viewport();
    const sort = deferred();
    const spark = splats(view, () => sort.promise);
    canvas.clientWidth = 1000;
    view.resize();
    const draw = view.draw(false, 1);
    await flush();
    view.loadVersion = 2; view.loading = true; view.awaitingSample = true;
    sort.resolve();
    await draw;
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    await view.draw(false, 2);
    view.loading = false;
    await view.draw(false, 2);
    view.awaitingSample = false; view.loadFailed = true;
    await view.draw(false, 2);
    expect(spark.update).toHaveBeenCalledOnce();
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('ignores obsolete worker rejections after replacement or disposal but propagates a current sorting failure', async () => {
    for (const state of ['superseded', 'disposed', 'current'] as const) {
      const { view, canvas, renderer } = viewport();
      const sort = deferred();
      const failure = new Error('Gaussian worker stopped');
      splats(view, () => sort.promise);
      canvas.clientWidth = 1000;
      view.resize();
      const draw = view.draw(false, 1);
      await flush();
      if (state === 'superseded') view.loadVersion++;
      if (state === 'disposed') view.disposed = true;
      const outcome = state === 'current'
        ? expect(draw).rejects.toBe(failure)
        : expect(draw).resolves.toBeUndefined();
      sort.reject(failure);
      await outcome;
      expect(renderer.setSize).not.toHaveBeenCalled();
      expect(renderer.render).not.toHaveBeenCalled();
    }
  });

  it('coalesces live invalidations during a sort and drains one latest view without a stale render backlog', async () => {
    const { view, canvas, renderer, presented } = viewport();
    const first = deferred(); const second = deferred();
    const spark = splats(view, () => first.promise);
    spark.update.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const initial = view.render(false);
    await flush();
    canvas.clientWidth = 1200; canvas.clientHeight = 600;
    view.resize();
    view.camera.position.x = 3;
    const pending = [view.render(false), view.render(false), view.render(false)];
    await flush();
    expect(spark.update).toHaveBeenCalledOnce();
    first.resolve();
    await flush();
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(spark.update).toHaveBeenCalledTimes(2);
    expect(spark.update.mock.calls[1][0].camera.position.x).toBe(3);
    second.resolve();
    await Promise.all([initial, ...pending]);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    expect(spark.update).toHaveBeenCalledTimes(2);
    expect(presented[1].position.x).toBe(3);
    expect(view.dirty).toBe(false);
  });

  it('finishes an in-flight camera and pose pair before applying the next evaluated sample', async () => {
    const { view, renderer, presented } = viewport();
    const product = new THREE.Group();
    product.position.set(.1, .2, 0);
    view.content.add(product);
    view.components.set('product', product);
    const poses: number[][] = [];
    const present = renderer.render.getMockImplementation()!;
    renderer.render.mockImplementation((scene, camera) => {
      poses.push(product.position.toArray());
      present(scene, camera);
    });
    const first = deferred(); const second = deferred();
    const spark = splats(view, () => first.promise);
    spark.update.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const initial = view.render(false);
    await flush();
    const next = view.frame({ ...sample(2), components: { product: {
      translationM: [.6, .8, 0], rotationXyzw: [0, 0, 0, 1],
    } } });
    await flush();
    expect(spark.update).toHaveBeenCalledOnce();
    expect(product.position.toArray()).toEqual([.1, .2, 0]);
    expect(view.camera.position.x).toBe(0);
    expect(renderer.render).not.toHaveBeenCalled();

    first.resolve();
    await initial;
    await flush();
    expect(poses).toEqual([[.1, .2, 0]]);
    expect(presented[0].position.x).toBe(0);
    expect(spark.update).toHaveBeenCalledTimes(2);
    expect(product.position.toArray()).toEqual([.6, .8, 0]);
    expect(spark.update.mock.calls[1][0].camera.position.x).toBe(2);
    second.resolve();
    await next;
    expect(poses).toEqual([[.1, .2, 0], [.6, .8, 0]]);
    expect(presented.map(camera => camera.position.x)).toEqual([0, 2]);
  });

  it('keeps an incomplete live scene hidden until a complete evaluated sample is applied', async () => {
    const { view, renderer, presented } = viewport();
    const product = new THREE.Group();
    view.content.add(product);
    view.components.set('product', product);
    view.awaitingSample = true;
    await view.render(false);
    expect(renderer.render).not.toHaveBeenCalled();
    const present = renderer.render.getMockImplementation()!;
    renderer.render.mockImplementationOnce((scene, camera) => {
      // The first visible frame must contain both the evaluated pose and camera.
      expect(view.awaitingSample).toBe(false);
      expect(product.position.toArray()).toEqual([.25, .5, 0]);
      expect(product.quaternion.toArray()).toEqual([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
      present(scene, camera);
    });
    await view.frame({ ...sample(1), components: { product: {
      translationM: [.25, .5, 0], rotationXyzw: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    } } });
    expect(view.awaitingSample).toBe(false);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(presented[0].position.toArray()).toEqual([1, 0, 2]);
  });

  it('retains exact serial capture frames and native pixel dimensions independently of CSS size', async () => {
    const { view, canvas, renderer, presented, finish } = viewport(true);
    canvas.width = 1920; canvas.height = 1080;
    canvas.clientWidth = 320; canvas.clientHeight = 180;
    view.resize();
    expect(renderer.setSize).not.toHaveBeenCalled();
    const first = deferred(); const second = deferred();
    const spark = splats(view, () => first.promise);
    spark.update.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const a = view.frame(sample(1));
    const b = view.frame(sample(2));
    await flush();
    expect(spark.update).toHaveBeenCalledOnce();
    expect(spark.renderSize.toArray()).toEqual([1920, 1080]);
    first.resolve();
    await a;
    await flush();
    expect(presented[0].position.x).toBe(1);
    expect(spark.update).toHaveBeenCalledTimes(2);
    expect(presented).toHaveLength(1);
    second.resolve();
    await b;
    expect(presented.map(camera => camera.position.x)).toEqual([1, 2]);
    expect(renderer.setSize).toHaveBeenCalledExactlyOnceWith(1920, 1080, false);
    expect(finish).toHaveBeenCalledTimes(2);
  });
});


describe('first sampled scene presentation', () => {
  it('notifies after the sampled frame renders, once per load, never for the initial empty canvas', async () => {
    const { view, events } = viewport();
    const onPresented = vi.fn(() => events.push('presented'));
    view.options.onPresented = onPresented;
    view.unpresentedLoadVersion = null;
    await view.draw(false, 1);
    expect(onPresented).not.toHaveBeenCalled();

    view.unpresentedLoadVersion = 1;
    view.awaitingSample = true;
    await view.draw(false, 1);
    expect(onPresented).not.toHaveBeenCalled();
    await view.frame(sample(1));
    expect(events.slice(-2)).toEqual(['render', 'presented']);
    await view.frame(sample(2));
    await view.draw(false, 1);
    expect(onPresented).toHaveBeenCalledOnce();

    view.loadVersion = 2; view.unpresentedLoadVersion = 2; view.awaitingSample = true;
    await view.draw(false, 2);
    expect(onPresented).toHaveBeenCalledOnce();
    await view.frame(sample(3));
    expect(onPresented).toHaveBeenCalledTimes(2);
  });

  it('waits for the Gaussian sort and draw rather than sample submission', async () => {
    const { view, renderer, events } = viewport();
    const sort = deferred();
    splats(view, () => sort.promise);
    const onPresented = vi.fn(() => events.push('presented'));
    view.options.onPresented = onPresented;
    const frame = view.frame(sample(1));
    await flush();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(onPresented).not.toHaveBeenCalled();
    sort.resolve();
    await frame;
    expect(events).toEqual(['render', 'presented']);
  });

  it('keeps readiness pending while the sampled scene cannot be displayed', async () => {
    const { view, renderer } = viewport();
    const onPresented = vi.fn(); view.options.onPresented = onPresented;
    view.visible = false;
    await view.frame(sample(1));
    expect(onPresented).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    view.visible = true;
    await view.draw(false, 1);
    expect(onPresented).toHaveBeenCalledOnce();
  });

  it('does not report failed sorting or drawing, and permits a successful retry', async () => {
    for (const failureAt of ['sort', 'render'] as const) {
      const { view, renderer } = viewport();
      const onPresented = vi.fn(); view.options.onPresented = onPresented;
      view.sampledLoadVersion = 1;
      const failure = new Error('presentation failed');
      if (failureAt === 'sort') splats(view, async () => { throw failure; });
      else renderer.render.mockImplementationOnce(() => { throw failure; });
      await expect(view.draw(false, 1)).rejects.toBe(failure);
      expect(onPresented).not.toHaveBeenCalled();
      view.spark = null;
      await view.draw(false, 1);
      expect(onPresented).toHaveBeenCalledOnce();
    }
  });

  it('does not report an obsolete load or presentation after an asynchronous sort', async () => {
    for (const state of ['load', 'presentation', 'disposed'] as const) {
      const { view, renderer } = viewport();
      const sort = deferred();
      splats(view, () => sort.promise);
      const onPresented = vi.fn(); view.options.onPresented = onPresented;
      view.sampledLoadVersion = 1;
      const draw = view.draw(false, 1);
      await flush();
      if (state === 'load') view.loadVersion = 2;
      if (state === 'presentation') view.presentationVersion = 1;
      if (state === 'disposed') view.disposed = true;
      sort.resolve();
      await draw;
      expect(renderer.render).not.toHaveBeenCalled();
      expect(onPresented).not.toHaveBeenCalled();
    }
  });
});

describe('viewport loading presentation', () => {
  it('keeps loading until the replacement Gaussian sample reaches the canvas', async () => {
    const { view, renderer, events } = viewport();
    const sort = deferred();
    splats(view, () => sort.promise);
    const onLoading = vi.fn((loading: boolean) => events.push(`loading:${loading}`));
    view.options.onLoading = onLoading;
    const frame = view.frame(sample(1));
    await flush();
    expect(renderer.render).not.toHaveBeenCalled();
    expect(onLoading).not.toHaveBeenCalled();
    sort.resolve();
    await frame;
    expect(events).toEqual(['render', 'loading:false']);
    await view.frame(sample(2));
    expect(onLoading).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('does not let a superseded Gaussian sort dismiss the replacement loading state', async () => {
    const { view, renderer } = viewport();
    const sort = deferred();
    splats(view, () => sort.promise);
    const onLoading = vi.fn(); view.options.onLoading = onLoading;
    const obsoleteFrame = view.frame(sample(1));
    await flush();
    view.loadVersion = 2; view.unpresentedLoadVersion = 2; view.awaitingSample = true;
    sort.reject(new Error('The old world worker was disposed.'));
    await obsoleteFrame;
    expect(renderer.render).not.toHaveBeenCalled();
    expect(onLoading).not.toHaveBeenCalled();
    view.spark = null;
    await view.frame(sample(2));
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(onLoading).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each(['sort', 'render'] as const)('ends loading on a current %s failure without reporting a presented frame', async failureAt => {
    const { view, renderer } = viewport();
    const onLoading = vi.fn(), onPresented = vi.fn();
    view.options.onLoading = onLoading; view.options.onPresented = onPresented;
    const failure = new Error('The new world could not be displayed.');
    if (failureAt === 'sort') splats(view, async () => { throw failure; });
    else renderer.render.mockImplementationOnce(() => { throw failure; });
    await expect(view.frame(sample(1))).rejects.toBe(failure);
    expect(onLoading).toHaveBeenCalledExactlyOnceWith(false);
    expect(onPresented).not.toHaveBeenCalled();
  });

  it('waits for a hidden comparison pane to become visible before ending its loading state', async () => {
    const { view, renderer } = viewport();
    const onLoading = vi.fn(); view.options.onLoading = onLoading;
    view.visible = false;
    await view.frame(sample(1));
    expect(onLoading).not.toHaveBeenCalled();
    expect(renderer.render).not.toHaveBeenCalled();
    view.visible = true;
    await view.draw(false, 1);
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(onLoading).toHaveBeenCalledExactlyOnceWith(false);
  });
});
