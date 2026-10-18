import {afterEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import {StudioViewport} from './viewport';
import {DepthOfFieldPreview} from './DepthOfFieldPreview';
import {circleOfConfusionRadiusPx, sparkApertureAngle} from './focusOptics';

function viewport(capture = false) {
  const view = Object.create(StudioViewport.prototype) as any;
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(18 / 50) * 180 / Math.PI, 2, .001, 100);
  camera.position.set(0, 0, .5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  const renderer = {setSize: vi.fn(), render: vi.fn(), getPixelRatio: () => 1, getContext: () => ({finish: vi.fn()})};
  Object.assign(view, {camera, scene, content, renderer, options: {studioMode: true, capture},
    canvas: {style: {}}, components: new Map(), controls: null, selection: null,
    frameQueue: Promise.resolve(), frameRequest: 0, filmGuides: false, filmOutputAspect: 9 / 16, presentedFilm: null,
    sampledCamera: {position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov, target: new THREE.Vector3()},
    sampledOptics: null, depthOfFieldPreview: null, productPreview: false,
    pendingSize: {width: 800, height: 400}, renderedSize: {width: 800, height: 400},
    disposed: false, loading: false, loadFailed: false, awaitingSample: false, visible: true, loadVersion: 1,
    pendingRender: 0, dirty: false, liveRender: null, spark: null, framedSelection: false, inspectingCamera: false});
  vi.spyOn(view, 'scheduleRender').mockImplementation(() => {});
  vi.stubGlobal('document', {hidden: false}); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return {view, camera, renderer};
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('Viewport optical presentation', () => {
  it('ingests sampled optics while keeping absent values disabled', async () => {
    const {view} = viewport(); vi.stubGlobal('document', {hidden: true});
    const camera = {positionM: [0, 0, .5], targetM: [0, 0, 0], focalLengthMm: 50};
    await view.frame({components: {}, camera});
    expect(view.sampledOptics).toEqual({enabled: false, fStop: 2.8, focusDistanceM: .5});
    await view.frame({components: {}, camera: {...camera, depthOfField: {enabled: true, fStop: 4, focusDistanceM: .6}}});
    expect(view.sampledOptics).toEqual({enabled: true, fStop: 4, focusDistanceM: .6});
  });
  it('keeps the sharp path free of postprocess allocations and releases a disabled effect', async () => {
    const {view, renderer} = viewport();
    await view.draw(false, 1); expect(view.depthOfFieldPreview).toBeNull(); expect(renderer.render).toHaveBeenCalledOnce();
    const previous = {dispose: vi.fn()}; view.depthOfFieldPreview = previous;
    await view.draw(false, 1); expect(previous.dispose).toHaveBeenCalledOnce(); expect(view.depthOfFieldPreview).toBeNull();
  });
  it('freezes focus/aperture alongside the camera during Gaussian sorting', async () => {
    const {view, renderer} = viewport();
    let resolve!: () => void; const waiting = new Promise<void>(done => {resolve = done;});
    view.spark = {visible: true, renderSize: new THREE.Vector2(), update: vi.fn(() => waiting)};
    const preview = {render: vi.fn(), dispose: vi.fn()}; view.depthOfFieldPreview = preview;
    view.sampledOptics = {enabled: true, fStop: 2.8, focusDistanceM: .5};
    const draw = view.draw(false, 1);
    expect(view.spark.focalDistance).toBe(.5); expect(view.spark.apertureAngle).toBeCloseTo(sparkApertureAngle(50, .5, 2.8));
    view.sampledOptics = {enabled: true, fStop: 16, focusDistanceM: 4};
    resolve(); await draw;
    expect(preview.render.mock.calls[0][5]).toEqual({enabled: true, fStop: 2.8, focusDistanceM: .5});
    expect(renderer.render).not.toHaveBeenCalled();
  });
  it('keeps Product and Material inspection sharp without changing the shot optics', async () => {
    const {view, camera, renderer} = viewport();
    const optics = {enabled: true, fStop: 2, focusDistanceM: .5}; view.sampledOptics = optics;
    const preview = {render: vi.fn(), dispose: vi.fn()}; view.depthOfFieldPreview = preview;
    view.spark = {visible: false, renderSize: new THREE.Vector2(), update: vi.fn()};
    vi.spyOn(view, 'applyProductPreview').mockImplementation(() => {});
    view.setFilmGuides(true); expect(camera.zoom).toBeLessThan(1);
    view.setFilmGuides(false); view.setProductPreview(true);
    await view.draw(false, 1);
    expect(camera.zoom).toBe(1); expect(preview.render).not.toHaveBeenCalled();
    expect(preview.dispose).toHaveBeenCalledOnce(); expect(renderer.render).toHaveBeenCalledOnce();
    expect(view.spark.apertureAngle).toBe(0); expect(view.sampledOptics).toEqual(optics);
  });
  it('keeps the previous image when a workspace changes during Gaussian sorting', async () => {
    const {view, renderer} = viewport();
    let resolve!: () => void; const waiting = new Promise<void>(done => {resolve = done;});
    view.spark = {visible: true, renderSize: new THREE.Vector2(), update: vi.fn(() => waiting)};
    const preview = {render: vi.fn(), dispose: vi.fn()}; view.depthOfFieldPreview = preview;
    view.sampledOptics = {enabled: true, fStop: 2.8, focusDistanceM: .5};
    vi.spyOn(view, 'applyProductPreview').mockImplementation(() => {view.spark.visible = false;});
    view.setFilmGuides(true); const draw = view.draw(false, 1);
    view.setFilmGuides(false); view.setProductPreview(true);
    resolve(); await draw;
    expect(renderer.render).not.toHaveBeenCalled(); expect(renderer.setSize).not.toHaveBeenCalled();
    expect(preview.render).not.toHaveBeenCalled(); expect(view.dirty).toBe(true);
    await view.draw(false, 1);
    expect(renderer.render).toHaveBeenCalledOnce(); expect(view.depthOfFieldPreview).toBeNull();
  });
  it('uses native per-splat aperture for capture without postprocessing or tone-map duplication', async () => {
    const {view, renderer} = viewport(true);
    view.sampledOptics = {enabled: true, fStop: 2, focusDistanceM: .5};
    view.spark = {visible: true, renderSize: new THREE.Vector2(), update: vi.fn(async () => {})};
    await view.draw(true, 1);
    expect(view.spark.focalDistance).toBe(.5); expect(view.spark.apertureAngle).toBeCloseTo(sparkApertureAngle(50, .5, 2));
    expect(view.depthOfFieldPreview).toBeNull(); expect(renderer.render).toHaveBeenCalledOnce();
    view.sampledOptics.enabled = false; await view.draw(true, 1);
    expect(view.spark.apertureAngle).toBe(0); expect(view.spark.focalDistance).toBe(0);
  });
  it('uses linear color plus real mesh depth and restores the renderer target', () => {
    const preview = new DepthOfFieldPreview() as any;
    const camera = new THREE.PerspectiveCamera(40, 2, .001, 100); camera.zoom = .6;
    const target = {name: 'original'};
    const renderer = {getPixelRatio: () => 2, getRenderTarget: () => target, setRenderTarget: vi.fn(), render: vi.fn()} as any;
    preview.render(renderer, new THREE.Scene(), camera, 800, 400, {enabled: true, fStop: 2.8, focusDistanceM: .5}, 50, true);
    expect(preview.target.depthTexture.isDepthTexture).toBe(true);
    expect(preview.target.width).toBe(1600); expect(preview.target.height).toBe(800);
    expect(preview.material.uniforms.cocScale.value / 2).toBeCloseTo(circleOfConfusionRadiusPx(1, 50, .5, 2.8, 800 * .6));
    expect(preview.material.uniforms.splatBackground.value).toBe(true);
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(target);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    preview.dispose();
  });
});
