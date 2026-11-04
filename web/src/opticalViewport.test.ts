import {afterEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import {StudioViewport} from './viewport';
import {DepthOfFieldPreview} from './DepthOfFieldPreview';
import {circleOfConfusionRadiusPx, sparkApertureAngle} from './focusOptics';
import {resolvePostProcessing} from './postProcessing';
import {filmGateRect} from './filmGuides';

function viewport(capture = false) {
  const view = Object.create(StudioViewport.prototype) as any;
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(18 / 50) * 180 / Math.PI, 2, .001, 100);
  camera.position.set(0, 0, .5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  const renderer = {setSize: vi.fn(), setPixelRatio: vi.fn(), render: vi.fn(), getPixelRatio: () => 1, getContext: () => ({finish: vi.fn()})};
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
  it('keeps one transmission-cache identity while presenting each updated camera pose', async () => {
    const {view, camera, renderer} = viewport();
    const presented: THREE.PerspectiveCamera[] = [], positions: number[][] = [];
    renderer.render.mockImplementation((_scene, drawnCamera) => {
      presented.push(drawnCamera); positions.push(drawnCamera.position.toArray());
    });
    for (let frame = 0; frame < 60; frame++) {
      camera.position.x = frame / 10;
      await view.draw(false, 1);
    }
    expect(new Set(presented.map(value => value.id)).size).toBe(1);
    expect(presented[0]).not.toBe(camera);
    expect(positions).toEqual(Array.from({length: 60}, (_, frame) => [frame / 10, 0, .5]));
    camera.position.x = 100;
    expect(presented[0].position.x).toBe(5.9);
  });
  it('bounds only live pixels, keeping camera framing and capture resolution intact', async () => {
    for (const capture of [false, true]) {
      const {view, renderer} = viewport(capture);
      view.pendingSize = {width: 2560, height: 1440};
      await view.draw(false, 1);
      expect(renderer.setSize).toHaveBeenCalledWith(2560, 1440, false);
      expect(renderer.render.mock.calls[0][1].aspect).toBe(2560 / 1440);
      if (capture) expect(renderer.setPixelRatio).not.toHaveBeenCalled();
      else expect(renderer.setPixelRatio).toHaveBeenCalledWith(.5);
    }
  });
  it('pauses drawing under a completed still and resumes with the current view', async () => {
    const {view, renderer} = viewport();
    await view.draw(false, 1);
    view.setSuspended(true); await view.draw(false, 1);
    expect(renderer.render).toHaveBeenCalledOnce();
    view.setSuspended(false); await view.draw(false, 1);
    expect(renderer.render).toHaveBeenCalledTimes(2);
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
    const {view, camera, renderer} = viewport(true);
    view.sampledOptics = {enabled: true, fStop: 2, focusDistanceM: .5};
    view.spark = {visible: true, renderSize: new THREE.Vector2(), update: vi.fn(async () => {})};
    await view.draw(true, 1);
    expect(view.spark.focalDistance).toBe(.5); expect(view.spark.apertureAngle).toBeCloseTo(sparkApertureAngle(50, .5, 2));
    expect(view.depthOfFieldPreview).toBeNull(); expect(renderer.render).toHaveBeenCalledOnce();
    expect(renderer.render.mock.calls[0][1]).toBe(camera);
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
  it('reuses the optical pass for grading and keeps effects aligned with the film gate', async () => {
    const {view,renderer}=viewport();
    const pass={render:vi.fn(),dispose:vi.fn()};view.depthOfFieldPreview=pass;
    view.setImageFinish({enabled:true,exposureEV:.5,vignette:.2});view.filmGuides=true;
    await view.draw(false,1);
    expect(pass.render).toHaveBeenCalledOnce();expect(renderer.render).not.toHaveBeenCalled();
    expect(pass.render.mock.calls[0][8]).toEqual(resolvePostProcessing({enabled:true,exposureEV:.5,vignette:.2}));
    expect(pass.render.mock.calls[0][9]).toEqual(filmGateRect(800,400,9/16));
    view.setImageFinish({enabled:false,exposureEV:.5});await view.draw(false,1);
    expect(pass.dispose).toHaveBeenCalledOnce();expect(renderer.render).toHaveBeenCalledOnce();
  });
  it('keeps product inspection and splat plate capture ungraded', async () => {
    for(const mode of ['product','plate']){
      const {view,renderer}=viewport(mode==='plate');view.productPreview=mode==='product';
      view.setImageFinish({enabled:true,exposureEV:1});await view.draw(false,1);
      expect(view.depthOfFieldPreview).toBeNull();expect(renderer.render).toHaveBeenCalledOnce();
    }
  });
  it('sets grade-only uniforms without depth blur and restores the target on a failed pass', () => {
    const preview=new DepthOfFieldPreview() as any;
    const target={name:'old'},renderer={getPixelRatio:()=>1,getRenderTarget:()=>target,setRenderTarget:vi.fn(),render:vi.fn()};
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();
    preview.render(renderer,scene,camera,800,400,null,50,false,{enabled:true,exposureEV:.25},{x:300,y:0,width:200,height:400});
    expect(preview.material.uniforms.cocScale.value).toBe(0);
    expect(preview.material.uniforms.gradeA.value.toArray()).toEqual([.25,1,1,1]);
    expect(preview.material.uniforms.gradeC.value.w).toBe(.5);
    expect(preview.material.uniforms.finishGate.value.toArray()).toEqual([.375,0,.25,1]);
    renderer.render.mockImplementation(()=>{throw new Error('lost context');});
    expect(()=>preview.render(renderer,scene,camera,800,400,null,50,false)).toThrow('lost context');
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(target);preview.dispose();
  });
  it('keeps bounded attachment MSAA through grading and releases it under data saving',()=>{
    const preview=new DepthOfFieldPreview() as any;
    const gl={RENDERBUFFER:1,RGBA16F:2,DEPTH_COMPONENT24:3,SAMPLES:4,getInternalformatParameter:vi.fn(()=>new Int32Array([4,2]))};
    const renderer={capabilities:{maxSamples:4},getContext:()=>gl,getPixelRatio:()=>1,getRenderTarget:()=>null,setRenderTarget:vi.fn(),render:vi.fn()} as any;
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();
    preview.render(renderer,scene,camera,800,400,null,50,false,{enabled:true,contrast:1.1});
    expect(preview.target.samples).toBe(2);expect(gl.getInternalformatParameter).toHaveBeenCalledTimes(2);
    preview.render(renderer,scene,camera,800,400,null,50,false,undefined,undefined,false);
    expect(preview.target.samples).toBe(0);
    preview.render(renderer,scene,camera,800,400,null,50,false,undefined,undefined,true);
    expect(preview.target.samples).toBe(2);expect(gl.getInternalformatParameter).toHaveBeenCalledTimes(4);
    preview.dispose();
  });
  it('measures an ungraded film crop and restores grading after capture failure', async () => {
    const {view}=viewport();view.filmGuides=true;
    const pixels=new Uint8ClampedArray(64).fill(128);for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
    const context={drawImage:vi.fn(),getImageData:vi.fn(()=>({data:pixels}))},bitmap={width:320,height:160,close:vi.fn()};
    vi.stubGlobal('document',{hidden:false,createElement:()=>({getContext:()=>context})});
    vi.stubGlobal('createImageBitmap',vi.fn(async()=>bitmap));
    const capture=vi.spyOn(view,'captureImage').mockImplementation(async()=>{expect(view.bypassImageFinish).toBe(true);return {blob:new Blob()};});
    expect((await view.analyzeImageFinish()).sampleCount).toBe(16);
    expect(capture).toHaveBeenCalledWith(undefined,320);
    const gate=filmGateRect(320,160,9/16);
    expect(context.getImageData).toHaveBeenCalledWith(Math.floor(gate.x),Math.floor(gate.y),Math.floor(gate.width),Math.floor(gate.height));
    expect(bitmap.close).toHaveBeenCalledOnce();expect(view.bypassImageFinish).toBe(false);
    capture.mockRejectedValue(new Error('cancelled'));
    await expect(view.analyzeImageFinish()).rejects.toThrow('cancelled');expect(view.bypassImageFinish).toBe(false);
  });
});
