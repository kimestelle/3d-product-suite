import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioViewport } from './viewport';
import {materializeAnimatedPose, toggleTrack, writeProperty, PRODUCT_TARGET} from './keyframes';

function viewport(capture = false) {
  // Exercise the actual product hierarchy and frame application without WebGL.
  const view = Object.create(StudioViewport.prototype) as any;
  const scene = new THREE.Scene(), content = new THREE.Group(); scene.add(content);
  Object.assign(view, {
    scene, content, camera: new THREE.PerspectiveCamera(40, 1.4, .001, 100),
    canvas: { style: {}, clientHeight: 800, clientWidth: 1120 },
    options: { studioMode: true, capture, onParts: vi.fn() },
    parts: new Map(), components: new Map(), environmentObjects: new Map(),
    originalVisibility: new Map(), focusMaterials: new Map(), previewMaterials: new Set(),
    hiddenParts: new Set(), focusPartIds: [], partFocus: false, selectedId: null,
    selection: null, framedSelection: false, inspectingCamera: false, controls: null,
    sampledCamera: null, disposed: false, loading: false, loadFailed: false, awaitingSample: false,
    loadVersion: 1, frameRequest: 0, frameQueue: Promise.resolve(), liveRender: null,
    dirty: false, visible: false,
  });
  view.invalidate = vi.fn(); view.render = vi.fn(async () => {});
  vi.stubGlobal('document', { hidden: true });
  return view;
}

function source(productScale?: number, partScale?: number): any {
  return {
    placement: { translationM: [.1, .2, .3], ...(productScale === undefined ? {} : { scale: productScale }) },
    product: { dimensionsM: [.2, .4, .1], components: [{
      id: 'body', name: 'Body', shape: 'box', sizeM: [.2, .4, .1], bevelM: 0,
      assembly: { translationM: [.02, .2, 0], rotationXyzw: [0, 0, 0, 1], ...(partScale === undefined ? {} : { scale: partScale }) },
      material: { baseColor: [.5, .4, .3, 1], roughness: .6, metallic: 0 },
    }] },
  };
}

function sample(scale?: number) {
  return {
    components: { body: { translationM: [.4, .5, .6], rotationXyzw: [0, 0, 0, 1], ...(scale === undefined ? {} : { scale }) } },
    camera: { positionM: [0, 0, 2], targetM: [0, 0, 0], focalLengthMm: 50 },
  };
}

function closeVector(actual: number[], expected: number[]) {
  expected.forEach((value, axis) => expect(actual[axis]).toBeCloseTo(value));
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('uniform product scale in the real viewport', () => {
  it('combines product and part scales while keeping source dimensions, UVs and geometry unchanged', async () => {
    const view = viewport(), scene = source(2, 1.5), original = structuredClone(scene);
    await view.makeProduct(scene, 1, new AbortController().signal);
    const root = view.components.get('body') as THREE.Group, mesh = root.children[0] as THREE.Mesh;
    expect(root.scale.toArray()).toEqual([3, 3, 3]);
    closeVector(root.position.toArray(), [.14, .6, .3]);
    mesh.geometry.computeBoundingBox();
    closeVector(mesh.geometry.boundingBox!.getSize(new THREE.Vector3()).toArray(), [.2, .4, .1]);
    closeVector(view.options.onParts.mock.calls[0][0][0].dimensionsM, [.6, 1.2, .3]);
    const layout = view.getUvLayout('body');
    await view.frame(sample(.5));
    expect(view.getUvLayout('body')).toEqual(layout);
    expect(scene).toEqual(original);
  });

  it('preserves nested imported transforms and keeps artwork attached as sampled scale changes', async () => {
    const view = viewport(), scene = source(2, .75), imported = new THREE.Group();
    imported.position.set(.01, .02, .03); imported.rotation.y = .3; imported.scale.set(1.2, .8, 1.1);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(.2, .4, .1), new THREE.MeshStandardMaterial());
    mesh.position.set(.01, .03, -.02); imported.add(mesh);
    const ink = new THREE.Mesh(new THREE.PlaneGeometry(.02, .02), new THREE.MeshBasicMaterial());
    ink.userData.gessoArtwork = true; ink.position.set(.02, .04, .051); mesh.add(ink);
    imported.updateWorldMatrix(true, true);
    const originalImported = imported.matrix.clone(), originalMesh = mesh.matrix.clone(), originalInk = ink.matrix.clone();
    const geometry = mesh.geometry, uv = geometry.getAttribute('uv').array.slice();
    view.loadVerifiedGlb = vi.fn(async () => imported); scene.product.components[0].shape = 'mesh';
    await view.makeProduct(scene, 1, new AbortController().signal);
    await view.frame(sample(2.5));
    const root = view.components.get('body') as THREE.Group;
    root.updateWorldMatrix(true, true);
    expect(root.scale.toArray()).toEqual([2.5, 2.5, 2.5]);
    expect(imported.matrix.equals(originalImported)).toBe(true);
    expect(mesh.matrix.equals(originalMesh)).toBe(true); expect(ink.matrix.equals(originalInk)).toBe(true);
    expect(mesh.geometry).toBe(geometry); expect(geometry.getAttribute('uv').array).toEqual(uv);
    expect(ink.parent).toBe(mesh);
    const expected = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld.clone().multiply(originalImported).multiply(originalMesh).multiply(originalInk));
    closeVector(ink.getWorldPosition(new THREE.Vector3()).toArray(), expected.toArray());
  });

  it.each([false, true])('applies canonical sampled scale, including legacy default reset, in capture=%s', async capture => {
    const view = viewport(capture);
    await view.makeProduct(source(), 1, new AbortController().signal);
    const root = view.components.get('body') as THREE.Group;
    await view.frame(sample(4)); expect(root.scale.toArray()).toEqual([4, 4, 4]);
    closeVector(root.position.toArray(), [.4, .5, .6]);
    await view.frame(sample()); expect(root.scale.toArray()).toEqual([1, 1, 1]);
    if (capture) expect(view.render).toHaveBeenCalledTimes(2);
  });

  it('moves the UV surface point with scale while retaining its 18 pixel screen size and inspection camera', async () => {
    const view = viewport();
    await view.makeProduct(source(), 1, new AbortController().signal);
    view.setUvProbePart('body'); view.setUvProbe([.5, .75]);
    expect(view.uvProbeSprites).toHaveLength(1);
    const sprite = view.uvProbeSprites[0] as THREE.Sprite;
    const local = sprite.getWorldPosition(new THREE.Vector3()).sub(view.components.get('body').position);
    view.inspectingCamera = true; view.camera.position.set(1, 2, 3); view.camera.lookAt(.1, .2, .3);
    const cameraPosition = view.camera.position.clone(), cameraRotation = view.camera.quaternion.clone();
    await view.frame(sample(3));
    closeVector(sprite.getWorldPosition(new THREE.Vector3()).toArray(), local.multiplyScalar(3).add(new THREE.Vector3(.4, .5, .6)).toArray());
    const parentScale = sprite.parent!.getWorldScale(new THREE.Vector3());
    expect(sprite.scale.x * parentScale.x * view.camera.projectionMatrix.elements[5] * 800 / 2).toBeCloseTo(18);
    expect(view.camera.position.equals(cameraPosition)).toBe(true); expect(view.camera.quaternion.equals(cameraRotation)).toBe(true);
  });

  it('freezes automatic framing for direct transforms without moving the inspection camera', async () => {
    const view = viewport();
    await view.makeProduct(source(), 1, new AbortController().signal);
    view.setSelection('body'); await view.frame(sample()); view.frameSelection();
    const position = view.camera.position.clone(), rotation = view.camera.quaternion.clone();
    const authoredCamera = view.sampledCamera.position.clone();
    view.freezeSelectionFraming();
    expect(view.inspectingCamera).toBe(true); expect(view.framedSelection).toBe(false);
    expect(view.framedWorldObjectId).toBeNull();
    expect(view.camera.position.equals(position)).toBe(true); expect(view.sampledCamera.position.equals(authoredCamera)).toBe(true);
    await view.frame(sample(2));
    expect(view.components.get('body').scale.toArray()).toEqual([2, 2, 2]);
    expect(view.camera.position.equals(position)).toBe(true); expect(view.camera.quaternion.equals(rotation)).toBe(true);
  });

  it('frames the scaled geometry rather than its unscaled source dimensions', async () => {
    const view = viewport();
    await view.makeProduct(source(), 1, new AbortController().signal);
    view.setSelection('body');
    await view.frame(sample()); view.frameSelection();
    const root = view.components.get('body') as THREE.Group;
    const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    const firstDistance = view.camera.position.distanceTo(center);
    await view.frame(sample(2));
    const scaledCenter = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    expect(view.camera.position.distanceTo(scaledCenter)).toBeCloseTo(firstDistance * 2);
  });
  it('uses the keyed product scale for pointer translation without rescaling the rendered geometry', async () => {
    const view = viewport(), scene = source();
    scene.render = {fps:24}; scene.shots = [{startFrame:1,endFrame:121}]; scene.actions = [];
    toggleTrack(scene, PRODUCT_TARGET, 'scale', 1); writeProperty(scene, PRODUCT_TARGET, 'scale', 121, 2);
    await view.makeProduct(scene, 1, new AbortController().signal);
    await view.frame(sample(2));
    const root = view.components.get('body') as THREE.Group, pivot = root.getWorldPosition(new THREE.Vector3());
    const bounds = {left:0,top:0,width:1120,height:800}; view.canvas.getBoundingClientRect = () => bounds;
    view.camera.position.copy(pivot).add(new THREE.Vector3(0,0,3)); view.camera.lookAt(pivot); view.camera.updateMatrixWorld(true);
    const project = (point: THREE.Vector3) => {const p=point.clone().project(view.camera);return {x:(p.x+1)*bounds.width/2,y:(1-p.y)*bounds.height/2};};
    const start = project(pivot), end = project(pivot.clone().add(new THREE.Vector3(.04,0,0)));
    const posed = materializeAnimatedPose(scene,121), before = structuredClone(posed);
    const gesture = view.createTransformGesture({kind:'part',componentId:'body'},start,posed);
    expect(gesture.sample('translate','x',end)).toBeCloseTo(.02);
    expect(root.scale.toArray()).toEqual([2,2,2]); expect(posed).toEqual(before);
    // Omitting the override retains the legacy static contract.
    expect(view.createTransformGesture({kind:'part',componentId:'body'},start).sample('translate','x',end)).toBeCloseTo(.04);
  });

  it('uses keyed assembly rotation for pointer axes while keeping the rendered mechanical pivot', async () => {
    const view = viewport(), scene = source();
    scene.render = {fps:24}; scene.shots = [{startFrame:1,endFrame:121}]; scene.actions = [];
    toggleTrack(scene,'body','rotation.x',1); writeProperty(scene,'body','rotation.x',121,90);
    await view.makeProduct(scene,1,new AbortController().signal);
    await view.frame(sample());
    const pivot = view.components.get('body').getWorldPosition(new THREE.Vector3());
    const bounds = {left:0,top:0,width:1120,height:800}; view.canvas.getBoundingClientRect = () => bounds;
    view.camera.position.copy(pivot).add(new THREE.Vector3(0,0,3)); view.camera.lookAt(pivot); view.camera.updateMatrixWorld(true);
    const project = (point: THREE.Vector3) => {const p=point.clone().project(view.camera);return {x:(p.x+1)*bounds.width/2,y:(1-p.y)*bounds.height/2};};
    const start = project(pivot.clone().add(new THREE.Vector3(.2,0,0))), end = project(pivot.clone().add(new THREE.Vector3(0,.2,0)));
    const gesture = view.createTransformGesture({kind:'part',componentId:'body'},start,materializeAnimatedPose(scene,121));
    // X=90 degrees makes the authored Euler Y axis align with world Z.
    expect(gesture.sample('rotate','y',end)).toBeCloseTo(90);
    expect(view.createTransformGesture({kind:'part',componentId:'body'},start).sample('rotate','y',end)).toBeNull();
  });

  it('centers whole-product scaling on the keyed placement plus its contact surface', async () => {
    const view = viewport(), scene = source();
    scene.render = {fps:24}; scene.shots = [{startFrame:1,endFrame:121}]; scene.actions = [];
    scene.environment = {plinth:{translationM:[.1,.1,0],sizeM:[1,.2,1]}};
    toggleTrack(scene,PRODUCT_TARGET,'position.x',1); writeProperty(scene,PRODUCT_TARGET,'position.x',121,.4);
    await view.makeProduct(scene,1,new AbortController().signal);
    const pivot = new THREE.Vector3(.5,.4,.3);
    const bounds = {left:0,top:0,width:1120,height:800}; view.canvas.getBoundingClientRect = () => bounds;
    view.camera.position.copy(pivot).add(new THREE.Vector3(0,0,3)); view.camera.lookAt(pivot); view.camera.updateMatrixWorld(true);
    const project = (point: THREE.Vector3) => {const p=point.clone().project(view.camera);return {x:(p.x+1)*bounds.width/2,y:(1-p.y)*bounds.height/2};};
    const start = project(pivot.clone().add(new THREE.Vector3(.2,0,0))), end = project(pivot.clone().add(new THREE.Vector3(.4,0,0)));
    const gesture = view.createTransformGesture({kind:'product'},start,materializeAnimatedPose(scene,121));
    expect(gesture.sample('scale','x',end)).toBeCloseTo(2);
  });

});
