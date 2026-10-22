import * as THREE from 'three';
import {describe, expect, it} from 'vitest';
import {StudioViewport} from './viewport';

const rect = {left: 80, top: 60, width: 960, height: 600};
function fixture(customPivot?: number[]) {
  const camera = new THREE.PerspectiveCamera(40, rect.width / rect.height, .001, 100);
  camera.position.set(3, 2, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const sourceLocal = new THREE.Matrix4().makeTranslation(.4, .2, -.1)
    .multiply(new THREE.Matrix4().makeRotationZ(.2)).multiply(new THREE.Matrix4().makeScale(2, 1, 1));
  const centre = new THREE.Vector3(.15, .3, 0).applyMatrix4(sourceLocal);
  const pivot = customPivot ? new THREE.Vector3().fromArray(customPivot) : centre;
  const translation = new THREE.Vector3(.1, .4, .2);
  const delta = new THREE.Matrix4().makeTranslation(...translation.toArray())
    .multiply(new THREE.Matrix4().makeTranslation(...pivot.toArray()))
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    .multiply(new THREE.Matrix4().makeScale(1.2, 1.2, 1.2))
    .multiply(new THREE.Matrix4().makeTranslation(...pivot.clone().negate().toArray()));
  const parent = new THREE.Object3D(); parent.matrixAutoUpdate = false;
  parent.matrix.makeRotationY(.3).multiply(new THREE.Matrix4().makeScale(2, .5, 1.5)); parent.matrix.elements[4] += .3;
  const object = new THREE.Object3D(); object.matrixAutoUpdate = false; object.matrix.copy(delta).multiply(sourceLocal); parent.add(object);
  parent.updateMatrixWorld(true);
  const posedScene = {placement: {translationM: [0, 0, 0], scale: 1}, product: {components: [{id: 'bottle',
    sourceNodes: [{nodeIndex: 7, parentIndex: null, name: 'Cap', drawable: true, hasMesh: true,
      localMatrix: sourceLocal.toArray(), boundsM: [[0, 0, -.1], [.3, .6, .1]]}],
    partTransforms: {'7': {translationM: translation.toArray(), rotationXyzw: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)).toArray(),
      scale: 1.2, ...(customPivot ? {pivotM: customPivot} : {})}},
  }]}};
  const view = Object.create(StudioViewport.prototype) as any;
  Object.assign(view, {disposed: false, loading: false, loadFailed: false, awaitingSample: false, options: {},
    transformPlacement: {pivot: new THREE.Vector3(), scale: 1}, camera, parts: new Map([['bottle::node:7', object]]), components: new Map(),
    canvas: {getBoundingClientRect: () => rect}});
  const projected = (point: THREE.Vector3) => {
    const p = point.clone().applyMatrix4(parent.matrixWorld).project(camera);
    return {x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2};
  };
  return {view, posedScene, pivot: pivot.clone().add(translation), projected};
}

describe('imported part viewport gestures', () => {
  it.each([undefined, [.7, -.2, .3]])('uses the rendered source pivot, including a custom pivot %j', customPivot => {
    const {view, posedScene, pivot, projected} = fixture(customPivot);
    const target = {kind: 'part', componentId: 'bottle::node:7'} as const;
    const before = structuredClone(posedScene);
    const move = view.createTransformGesture(target, projected(pivot), posedScene);
    expect(move.sample('translate', 'y', projected(pivot.clone().add(new THREE.Vector3(0, .25, 0))))).toBeCloseTo(.25);
    const rotate = view.createTransformGesture(target, projected(pivot.clone().add(new THREE.Vector3(1, 0, 0))), posedScene);
    expect(rotate.sample('rotate', 'y', projected(pivot.clone().add(new THREE.Vector3(0, 1, 0))))).toBeCloseTo(90);
    const start = projected(pivot.clone().add(new THREE.Vector3(.5, 0, 0))), centre = projected(pivot);
    const scale = view.createTransformGesture(target, start, posedScene);
    expect(scale.sample('scale', 'x', {x: centre.x + 2 * (start.x - centre.x), y: centre.y + 2 * (start.y - centre.y)})).toBeCloseTo(2);
    expect(posedScene).toEqual(before);
  });

  it('rejects a missing source node rather than moving the entire product', () => {
    const {view, posedScene, pivot, projected} = fixture();
    expect(view.createTransformGesture({kind: 'part', componentId: 'bottle::node:99'}, projected(pivot), posedScene)).toBeNull();
    expect(view.createTransformGesture({kind: 'part', componentId: 'bottle::node:7'}, projected(pivot))).toBeNull();
  });
});
