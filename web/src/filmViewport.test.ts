import {afterEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import {StudioViewport} from './viewport';
import {filmGateRect, filmGuideZoom, type FilmGuideProjection} from './filmGuides';

function viewport(capture = false) {
  const view = Object.create(StudioViewport.prototype) as any;
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(18 / 50) * 180 / Math.PI, 2, .001, 100);
  camera.position.set(0, 0, 2); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  const canvas = {clientWidth: 800, clientHeight: 400, width: 800, height: 400,
    getBoundingClientRect: () => ({left: 10, top: 20, width: 800, height: 400}), style: {}};
  const events: string[] = [];
  const onFilmGuide = vi.fn((_guide: FilmGuideProjection | null) => {events.push('guide');});
  const renderer = {setSize: vi.fn(() => {events.push('resize');}), render: vi.fn((_scene: THREE.Scene, _camera: THREE.PerspectiveCamera) => {events.push('render');}),
    getPixelRatio: () => 1, getContext: () => ({finish: () => {}})};
  Object.assign(view, {camera, scene, content, canvas, renderer, options: {studioMode: true, capture, onFilmGuide},
    filmGuides: false, filmOutputAspect: 9 / 16, presentedFilm: null,
    sampledCamera: {position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov, target: new THREE.Vector3()},
    pendingSize: {width: 800, height: 400}, renderedSize: {width: 800, height: 400},
    disposed: false, loading: false, loadFailed: false, awaitingSample: false, visible: true, loadVersion: 1,
    pendingRender: 0, dirty: false, liveRender: null, spark: null, framedSelection: false, inspectingCamera: false});
  vi.spyOn(view, 'scheduleRender').mockImplementation(() => {});
  vi.stubGlobal('document', {hidden: false}); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return {view, camera, canvas, renderer, onFilmGuide, events};
}

afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('Film viewport presentation', () => {
  it('applies overscan once and publishes only after the matching render', async () => {
    const {view, camera, canvas, renderer, onFilmGuide, events} = viewport();
    view.setFilmGuides(true);
    expect(camera.zoom).toBe(filmGuideZoom(800, 400, 9 / 16)); expect(onFilmGuide).not.toHaveBeenCalled();
    await view.draw(false, 1);
    expect(events).toEqual(['render', 'guide']);
    expect(renderer.render.mock.calls[0][1].zoom).toBe(camera.zoom);
    expect(onFilmGuide.mock.calls[0][0]!.target).toEqual({x: 400, y: 200, visible: true});
    expect(onFilmGuide.mock.calls[0][0]!.focalLengthMm).toBeCloseTo(50);
    expect(view.createCameraTargetGesture({clientX: 410, clientY: 220})).not.toBeNull();
    canvas.clientWidth = 960; canvas.clientHeight = 540; view.resize();
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(camera.zoom).toBe(filmGuideZoom(960, 540, 9 / 16));
    await view.draw(false, 1); await view.draw(false, 1);
    expect(camera.zoom).toBe(filmGuideZoom(960, 540, 9 / 16));
    expect(events.slice(2)).toEqual(['resize', 'render', 'guide', 'render', 'guide']);
    view.setFilmGuides(false); expect(camera.zoom).toBe(1); expect(onFilmGuide).toHaveBeenLastCalledWith(null);
    expect(view.createCameraTargetGesture({clientX: 410, clientY: 220})).toBeNull();
  });
  it('sorts and presents the same frozen overscan and guides during a resize', async () => {
    const {view, camera, canvas, renderer, onFilmGuide, events} = viewport();
    let complete!: () => void;
    const waiting = new Promise<void>(resolve => {complete = resolve;});
    view.spark = {visible: true, renderSize: new THREE.Vector2(), update: vi.fn(() => waiting), sorting: false, sortDirty: false};
    view.setFilmGuides(true);
    const draw = view.draw(false, 1);
    expect(onFilmGuide).not.toHaveBeenCalled(); expect(renderer.render).not.toHaveBeenCalled();
    const frozen = view.spark.update.mock.calls[0][0].camera;
    canvas.clientHeight = 600; view.resize(); camera.position.x = 1; view.sampledCamera.target.x = .2;
    complete(); await draw;
    expect(renderer.render.mock.calls[0][1]).toBe(frozen);
    expect(frozen.zoom).toBe(filmGuideZoom(800, 400, 9 / 16));
    expect(onFilmGuide.mock.calls[0][0]!.viewportHeight).toBe(400);
    expect(onFilmGuide.mock.calls[0][0]!.targetM).toEqual([0, 0, 0]);
    expect(events).toEqual(['render', 'guide']);
  });
  it('publishes the flat-content gate after drawing and clears the previous 3D gesture', async () => {
    const {view,onFilmGuide,events}=viewport();view.setFilmGuides(true);
    view.filmContent=true;view.filmClip={kind:'black'};
    view.imageRenderer={draw:vi.fn(()=>events.push('image'))};
    view.presentedFilm={camera:view.camera,target:new THREE.Vector3()};
    await view.draw(false,1);
    expect(events).toEqual(['image','guide']);
    expect(onFilmGuide).toHaveBeenLastCalledWith({gate:filmGateRect(800,400,9/16),viewportWidth:800,viewportHeight:400});
    expect(view.createCameraTargetGesture({clientX:410,clientY:220})).toBeNull();
  });
  it('leaves capture projection unchanged and emits no editing guides', async () => {
    const {view, camera, renderer, onFilmGuide} = viewport(true);
    view.setFilmGuides(true); await view.draw(false, 1);
    expect(camera.zoom).toBe(1); expect(view.filmGuides).toBe(false);
    expect(renderer.render).toHaveBeenCalledOnce(); expect(onFilmGuide).not.toHaveBeenCalled();
    expect(view.createCameraTargetGesture({clientX: 410, clientY: 220})).toBeNull();
  });
});
