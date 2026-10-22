import {describe, expect, it} from 'vitest';
import {Box3, Group, Matrix4, PerspectiveCamera, Vector3} from 'three';
import {applyProductWorldFit, fitProductToWorld, type ProductWorldFit} from './productWorldFit';

const box = (min: number[], max: number[]) => new Box3(new Vector3().fromArray(min), new Vector3().fromArray(max));
const points = (bounds: Box3) => Array.from({length: 8}, (_, index) => new Vector3(
  index & 1 ? bounds.max.x : bounds.min.x, index & 2 ? bounds.max.y : bounds.min.y, index & 4 ? bounds.max.z : bounds.min.z));
const scaled = (bounds: Box3, pivot: Vector3, multiplier: number) => new Box3().setFromPoints(points(bounds).map(point => point.sub(pivot).multiplyScalar(multiplier).add(pivot)));
function camera() {
  const result = new PerspectiveCamera(60, 16 / 9, .1, 100);
  result.position.set(0, 0, 10); result.lookAt(0, 0, 0); result.updateMatrixWorld(true);
  return result;
}
const world = () => box([-4, -4, -4], [4, 4, 4]);
const product = () => box([-.5, 0, -.5], [.5, 2, .5]);

function expectInside(view: PerspectiveCamera, bounds: Box3, pivot: Vector3, result: ProductWorldFit) {
  view.updateMatrixWorld(true); view.updateProjectionMatrix();
  for (const point of points(scaled(bounds, pivot, result.multiplier))) {
    const ndc = point.clone().project(view), depth = -point.clone().applyMatrix4(view.matrixWorldInverse).z;
    expect(ndc.x).toBeGreaterThanOrEqual(result.targetRect.left - 1e-9);
    expect(ndc.x).toBeLessThanOrEqual(result.targetRect.right + 1e-9);
    expect(ndc.y).toBeGreaterThanOrEqual(result.targetRect.bottom - 1e-9);
    expect(ndc.y).toBeLessThanOrEqual(result.targetRect.top + 1e-9);
    expect(depth).toBeGreaterThanOrEqual(view.near - 1e-9);
    expect(depth).toBeLessThanOrEqual(view.far + 1e-9);
  }
}

describe('product fit within the projected world', () => {
  it.each([
    ['tall', [-.1, 0, -.1], [.1, 4, .1]],
    ['wide', [-4, 0, -.1], [4, .2, .1]],
    ['deep', [-.1, 0, -4], [.1, .2, 4]],
    ['small', [-.02, 0, -.03], [.02, .06, .03]],
    ['large', [-20, 0, -10], [20, 30, 10]],
    ['216m source', [-20, 0, -10], [20, 216, 10]],
  ])('fits %s products uniformly and is exactly idempotent', (_, min, max) => {
    const view = camera(), bounds = box(min as number[], max as number[]), pivot = new Vector3();
    const result = fitProductToWorld(view, world(), bounds, pivot, 1);
    expectInside(view, bounds, pivot, result);
    const fittedBounds = scaled(bounds, pivot, result.multiplier);
    const again = fitProductToWorld(view, world(), fittedBounds, pivot, result.multiplier);
    expect(again.multiplier).toBe(1);
    expect(result.scaledDimensions).toEqual(bounds.getSize(new Vector3()).multiplyScalar(result.multiplier).toArray());
  });

  it('uses the visible generated world rather than the whole viewport when it is smaller', () => {
    const view = camera(); view.fov = 90; view.aspect = 1; view.updateProjectionMatrix();
    const result = fitProductToWorld(view, box([-2, -3, 0], [2, 3, 0]), product(), new Vector3(), 1);
    expect(result.targetRect.left).toBeCloseTo(-.16, 12);
    expect(result.targetRect.right).toBeCloseTo(.16, 12);
    expect(result.targetRect.bottom).toBeCloseTo(-.24, 12);
    expect(result.targetRect.top).toBeCloseTo(.24, 12);
    expectInside(view, product(), new Vector3(), result);
  });

  it('stops at an actual projected edge rather than an arbitrary approximate scale', () => {
    const view = camera(), bounds = product();
    const result = fitProductToWorld(view, world(), bounds, new Vector3(), 1);
    const top = Math.max(...points(scaled(bounds, new Vector3(), result.multiplier)).map(point => point.project(view).y));
    expect(top).toBeCloseTo(result.targetRect.top, 12);
    const largerTop = Math.max(...points(scaled(bounds, new Vector3(), result.multiplier * 1.0001)).map(point => point.project(view).y));
    expect(largerTop).toBeGreaterThan(result.targetRect.top);
  });

  it('uses the viewport when the camera is inside the world', () => {
    const view = camera();
    const result = fitProductToWorld(view, box([-30, -30, -30], [30, 30, 30]), product(), new Vector3(), 1);
    expect(result.targetRect).toEqual({left: -.8, right: .8, bottom: -.8, top: .8});
    expectInside(view, product(), new Vector3(), result);
  });

  it('clips generated-world edges at the near plane instead of projecting behind-camera corners', () => {
    const view = camera(); view.fov = 90; view.aspect = 1; view.near = 1; view.updateProjectionMatrix();
    // The camera is outside the x extent. Four edges straddle its near plane.
    const bounds = box([.1, -1, 8], [.4, 1, 11]);
    const pivot = new Vector3(.4, 0, 8);
    const object = box([.35, -.1, 7.95], [.45, .1, 8.05]);
    const result = fitProductToWorld(view, bounds, object, pivot, 1);
    expect(result.targetRect.left).toBeCloseTo(.085, 12);
    expect(result.targetRect.right).toBeCloseTo(.365, 12);
    expectInside(view, object, pivot, result);
  });

  it('clips world bounds to the viewport before applying the inset', () => {
    const view = camera(); view.fov = 90; view.aspect = 1; view.updateProjectionMatrix();
    const result = fitProductToWorld(view, box([-20, -20, 0], [2, 20, 0]), product(), new Vector3(), 1);
    expect(result.targetRect.left).toBeCloseTo(-.88, 12);
    expect(result.targetRect.right).toBeCloseTo(.08, 12);
    expect(result.targetRect.bottom).toBeCloseTo(-.8, 12);
    expect(result.targetRect.top).toBeCloseTo(.8, 12);
    expectInside(view, product(), new Vector3(), result);
  });

  it('limits depth against the near and far planes', () => {
    const view = camera(); view.near = 1; view.updateProjectionMatrix();
    const surroundings = box([-30, -30, -30], [30, 30, 30]);
    const nearBounds = box([-1e-7, -1e-7, 0], [1e-7, 1e-7, 20]);
    const nearFit = fitProductToWorld(view, surroundings, nearBounds, new Vector3(), 1);
    expect(nearFit.multiplier).toBeCloseTo(.45, 12);
    expectInside(view, nearBounds, new Vector3(), nearFit);
    const farBounds = box([-1e-7, -1e-7, -200], [1e-7, 1e-7, 0]);
    const farFit = fitProductToWorld(view, surroundings, farBounds, new Vector3(), 1);
    expect(farFit.multiplier).toBeCloseTo(.45, 12);
    expectInside(view, farBounds, new Vector3(), farFit);
  });

  it('handles a translated and rotated camera without recentering the product', () => {
    const view = camera(); view.position.set(8, 5, 12); view.lookAt(2, 1, -1); view.updateMatrixWorld(true);
    const pivot = new Vector3(2, 0, -1), bounds = product().translate(pivot);
    const result = fitProductToWorld(view, box([-10, -10, -10], [10, 10, 10]), bounds, pivot, 1);
    expectInside(view, bounds, pivot, result);
    expect(scaled(bounds, pivot, result.multiplier).min.y).toBe(0);
  });

  it('resolves camera parents and pending transforms without mutating any input', () => {
    const view = camera(), parent = new Group(); parent.position.set(3, 0, 0); parent.add(view);
    view.position.set(0, 0, 10); view.quaternion.identity();
    const pivot = new Vector3(3, 0, 0), bounds = product().translate(pivot), surroundings = world().translate(pivot);
    const before = {camera: view.toJSON(), parentMatrix: parent.matrix.toArray(), parentWorld: parent.matrixWorld.toArray(),
      product: bounds.clone(), world: surroundings.clone(), pivot: pivot.clone()};
    const result = fitProductToWorld(view, surroundings, bounds, pivot, 1);
    expect(view.toJSON()).toEqual(before.camera);
    expect(parent.matrix.toArray()).toEqual(before.parentMatrix);
    expect(parent.matrixWorld.toArray()).toEqual(before.parentWorld);
    expect(bounds).toEqual(before.product); expect(surroundings).toEqual(before.world); expect(pivot).toEqual(before.pivot);
    parent.updateMatrixWorld(true);
    expectInside(view, bounds, pivot, result);
  });

  it('supports an off-axis camera projection', () => {
    const view = camera(); view.setViewOffset(1600, 900, 200, 0, 1200, 900);
    const result = fitProductToWorld(view, world(), product(), new Vector3(), 1);
    expectInside(view, product(), new Vector3(), result);
  });

  it('reaches the allowed maximum for a tiny product without an arbitrary search ceiling', () => {
    const view = camera(), bounds = box([-1e-14, 0, -1e-14], [1e-14, 2e-14, 1e-14]);
    const result = fitProductToWorld(view, world(), bounds, new Vector3(), .01);
    expect(result.multiplier).toBe(1e8);
    expectInside(view, bounds, new Vector3(), result);
    expect(fitProductToWorld(view, world(), scaled(bounds, new Vector3(), result.multiplier), new Vector3(), 1e6).multiplier).toBe(1);
  });

  it('rejects a huge object that cannot fit within the supported scale range', () => {
    expect(() => fitProductToWorld(camera(), world(), box([-1e9, 0, -1e9], [1e9, 1e9, 1e9]), new Vector3(), 1))
      .toThrow('between 0.000001× and 1000000×');
  });

  it.each([
    ['missing world', null], ['empty world', new Box3()],
    ['behind camera', box([-1, -1, 12], [1, 1, 15])], ['past far plane', box([-1, -1, -200], [1, 1, -150])],
    ['behind camera touching its boundary', box([-1, -1, 10], [1, 1, 12])],
    ['offscreen world', box([200, 0, -1], [201, 1, 1])],
  ])('rejects %s instead of inventing a visible fit box', (_, bounds) => {
    expect(() => fitProductToWorld(camera(), bounds, product(), new Vector3(), 1)).toThrow(/world/i);
  });

  it.each([new Vector3(20, 0, 0), new Vector3(0, 0, 11), new Vector3(0, 0, -100), new Vector3(NaN, 0, 0)])('rejects an invalid or outside support %j', pivot => {
    expect(() => fitProductToWorld(camera(), world(), product(), pivot, 1)).toThrow(/support/);
  });

  it('rejects a support on the boundary if the product extends outside it at every positive size', () => {
    const view = camera(); view.fov = 90; view.aspect = 1; view.updateProjectionMatrix();
    const pivot = new Vector3(8, 0, 0), bounds = product().translate(pivot);
    expect(() => fitProductToWorld(view, box([-30, -30, -30], [30, 30, 30]), bounds, pivot, 1)).toThrow(/support|scale/);
  });

  it.each([0, -.1, Infinity, NaN, 1e7, 1e-7])('rejects invalid current scale %s', value => {
    expect(() => fitProductToWorld(camera(), world(), product(), new Vector3(), value)).toThrow('scale');
  });

  it('rejects degenerate product bounds and invalid cameras', () => {
    expect(() => fitProductToWorld(camera(), world(), new Box3(), new Vector3(), 1)).toThrow('product');
    expect(() => fitProductToWorld(camera(), world(), box([0, 0, 0], [0, 0, 0]), new Vector3(), 1)).toThrow('product');
    const invalid = camera(); invalid.near = 0;
    expect(() => fitProductToWorld(invalid, world(), product(), new Vector3(), 1)).toThrow('camera');
    invalid.near = .1; invalid.scale.set(0, 1, 1);
    expect(() => fitProductToWorld(invalid, world(), product(), new Vector3(), 1)).toThrow('camera');
    invalid.scale.set(1, 1, 1); invalid.matrixAutoUpdate = false; invalid.matrix = new Matrix4().makeScale(1, 0, 1);
    expect(() => fitProductToWorld(invalid, world(), product(), new Vector3(), 1)).toThrow('camera');
  });
});

function authoredScene() {
  return {placement: {translationM: [1, 2, 3], scale: 2, restsOn: 'plinth'},
    product: {dimensionsM: [.1, .2, .3], components: [{id: 'body', sizeM: [.1, .2, .3], assembly: {scale: 1.2}, asset: {sha256: 'original'}}]},
    environment: {asset: {scaleToMeters: 3}},
    animation: {tracks: [
      {id: 'active', componentId: '$product', property: 'scale', enabled: true, keys: [{frame: 1, value: 2, interpolation: 'ease'}, {frame: 48, value: 4, interpolation: 'hold'}]},
      {id: 'disabled', componentId: '$product', property: 'scale', enabled: false, keys: [{frame: 1, value: .5, interpolation: 'linear'}]},
      {id: 'move', componentId: '$product', property: 'position.x', enabled: true, keys: [{frame: 1, value: .1, interpolation: 'ease'}]},
      {id: 'part', componentId: 'body', property: 'scale', enabled: true, keys: [{frame: 1, value: .2, interpolation: 'ease'}]},
    ]},
    motions: [{id: 'shared-scale', kind: 'scale', target: '$product', amount: 1.5}],
    shots: [{camera: {from: {positionM: [0, 1, 3]}}, motions: [{id: 'shot-scale', kind: 'scale', target: '$product', amount: 2}]}]};
}

describe('saved product fit', () => {
  it('scales base and all absolute product keys, preserving geometry, positions, and relative motions', () => {
    const scene = authoredScene(), before = structuredClone(scene);
    const fitted = applyProductWorldFit(scene, 3);
    expect(scene).toEqual(before); expect(fitted).not.toBe(scene);
    expect(fitted.placement.scale).toBe(6);
    expect(fitted.animation.tracks[0].keys.map(key => key.value)).toEqual([6, 12]);
    expect(fitted.animation.tracks[1].keys[0].value).toBe(1.5);
    for (const index of [0, 1]) {
      expect(fitted.animation.tracks[index].keys.map(({value: _, ...key}) => key))
        .toEqual(scene.animation.tracks[index].keys.map(({value: _, ...key}) => key));
    }
    expect(fitted.animation.tracks.slice(2)).toEqual(scene.animation.tracks.slice(2));
    expect(fitted.product).toEqual(scene.product); expect(fitted.environment).toEqual(scene.environment);
    expect(fitted.shots).toEqual(scene.shots); expect(fitted.motions).toEqual(scene.motions);
    expect(fitted.placement.translationM).toEqual(scene.placement.translationM);
  });

  it('fits and persists a product below the old part-scale minimum', () => {
    const scene = authoredScene();
    const fitted = applyProductWorldFit(scene, .00148 / scene.placement.scale);
    expect(fitted.placement.scale).toBe(.00148);
    expect(fitted.animation.tracks[0].keys[0].value).toBe(.00148);
    expect(fitted.product).toEqual(scene.product);
    const bounds = product();
    const result = fitProductToWorld(camera(), world(), bounds, new Vector3(), .00148);
    expectInside(camera(), bounds, new Vector3(), result);
    expect(() => applyProductWorldFit(fitted, result.multiplier)).not.toThrow();
  });

  it('treats missing placement scale as identity and leaves an identity fit unchanged', () => {
    const scene = {placement: {translationM: [0, 0, 0]}, product: {dimensionsM: [1, 2, 3]}};
    expect(applyProductWorldFit(scene, 1)).toEqual(scene);
    expect((applyProductWorldFit(scene, 2).placement as any).scale).toBe(2);
  });

  it.each([0, -1, NaN, Infinity, 1e-8, 1e6])('rejects invalid multiplier %s before returning any edited state', multiplier => {
    const scene = authoredScene(), before = structuredClone(scene);
    expect(() => applyProductWorldFit(scene, multiplier)).toThrow();
    expect(scene).toEqual(before);
  });

  it('checks disabled absolute keys before changing even a valid base scale', () => {
    const scene = authoredScene(); scene.animation.tracks[1].keys[0].value = 8e5;
    const before = structuredClone(scene);
    expect(() => applyProductWorldFit(scene, 2)).toThrow('between 0.000001× and 1000000×');
    expect(scene).toEqual(before);
  });

  it('rejects malformed absolute scale keys without modifying source', () => {
    const scene = authoredScene(); scene.animation.tracks[0].keys[0].value = NaN;
    expect(() => applyProductWorldFit(scene, 1)).toThrow('scale');
  });
});
