import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createTransformPointerGesture } from './transformPointer';

const rect = { left: 120, top: 80, width: 960, height: 600 };
function camera(position = new Vector3(0, 0, 10)) {
  const result = new PerspectiveCamera(40, rect.width / rect.height, .001, 100);
  result.position.copy(position); result.lookAt(0, 0, 0); result.updateMatrixWorld(true);
  return result;
}
function project(view: PerspectiveCamera, point: Vector3) {
  const p = point.clone().project(view);
  return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 };
}

describe('pointer transform projection', () => {
  it.each([new Vector3(0, 0, 10), new Vector3(4, 3, 6)])('moves exactly along an axis using the current perspective camera at %j', position => {
    const view = camera(position), pivot = new Vector3(.1, .2, .3);
    const start = project(view, pivot), end = project(view, pivot.clone().add(new Vector3(2, 0, 0)));
    const gesture = createTransformPointerGesture(view, rect, pivot, start)!;
    expect(gesture.sample('translate', 'x', end)).toBeCloseTo(2);
    const part = createTransformPointerGesture(view, rect, pivot, start, { translationScale: 4 })!;
    expect(part.sample('translate', 'x', end)).toBeCloseTo(.5);
  });

  it('reads non-enumerable DOMRect prototype getters from the live canvas', () => {
    const bounds = Object.create(Object.defineProperties({}, {
      left: { get: () => rect.left }, top: { get: () => rect.top },
      width: { get: () => rect.width }, height: { get: () => rect.height },
    }));
    expect({ ...bounds }).toEqual({});
    const view = camera(), pivot = new Vector3(), start = project(view, pivot);
    const gesture = createTransformPointerGesture(view, bounds, pivot, start)!;
    expect(gesture.sample('translate', 'x', project(view, new Vector3(2, 0, 0)))).toBeCloseTo(2);
  });

  it('measures signed rotation around the selected axis', () => {
    const view = camera(), pivot = new Vector3(), start = project(view, new Vector3(1, 0, 0));
    const gesture = createTransformPointerGesture(view, rect, pivot, start)!;
    expect(gesture.sample('rotate', 'z', project(view, new Vector3(0, 1, 0)))).toBeCloseTo(90);
    expect(gesture.sample('rotate', 'z', project(view, new Vector3(0, -1, 0)))).toBeCloseTo(-90);
  });

  it('matches the existing XYZ Euler controls after prior rotations', () => {
    const view = camera(), pivot = new Vector3(), start = project(view, new Vector3(1, 0, 0));
    const quaternion = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0, 'XYZ'));
    const gesture = createTransformPointerGesture(view, rect, pivot, start, { rotationXyzw: quaternion.toArray() })!;
    // After X=90°, changing Euler Y rotates around world Z.
    expect(gesture.sample('rotate', 'y', project(view, new Vector3(0, 1, 0)))).toBeCloseTo(90);
  });

  it('measures source-parent axes through inherited rotation, nonuniform scale and shear', () => {
    const view = camera(new Vector3(4, 3, 10));
    const parent = new Matrix4().makeRotationZ(.4).multiply(new Matrix4().makeScale(2, .5, 1.5));
    parent.elements[4] += .3; parent.setPosition(.5, -.3, .2);
    const localPivot = new Vector3(.2, .4, -.1), pivot = localPivot.clone().applyMatrix4(parent);
    const start = project(view, pivot), end = project(view, localPivot.clone().add(new Vector3(0, .75, 0)).applyMatrix4(parent));
    const gesture = createTransformPointerGesture(view, rect, pivot, start, {parentToWorld: parent})!;
    expect(gesture.sample('translate', 'y', end)).toBeCloseTo(.75);
    // The coordinate frame is frozen even while its parent animates afterwards.
    parent.identity();
    expect(gesture.sample('translate', 'y', end)).toBeCloseTo(.75);
  });

  it('uses authored Euler rotation angles rather than the sheared world silhouette', () => {
    const view = camera(new Vector3(4, 3, 10));
    const parent = new Matrix4().makeRotationY(.4).multiply(new Matrix4().makeScale(2, .5, 1));
    parent.elements[4] += .7;
    const localPivot = new Vector3(.2, .4, 0), pivot = localPivot.clone().applyMatrix4(parent);
    const start = project(view, localPivot.clone().add(new Vector3(1, 0, 0)).applyMatrix4(parent));
    const end = project(view, localPivot.clone().add(new Vector3(0, 1, 0)).applyMatrix4(parent));
    const quaternion = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0, 'XYZ'));
    const gesture = createTransformPointerGesture(view, rect, pivot, start, {parentToWorld: parent, rotationXyzw: quaternion.toArray()})!;
    expect(gesture.sample('rotate', 'y', end)).toBeCloseTo(90);
    expect(createTransformPointerGesture(view, rect, pivot, start, {parentToWorld: new Matrix4().makeScale(1, 0, 1)})).toBeNull();
  });

  it('uses a radial scale ratio and rejects the center instead of inventing a sensitivity', () => {
    const view = camera(), pivot = new Vector3(), start = project(view, new Vector3(1, 0, 0));
    const gesture = createTransformPointerGesture(view, rect, pivot, start)!;
    expect(gesture.sample('scale', 'x', project(view, new Vector3(2, 0, 0)))).toBeCloseTo(2);
    expect(gesture.sample('scale', 'z', project(view, new Vector3(.25, 0, 0)))).toBeCloseTo(.25);
    expect(gesture.sample('scale', 'x', project(view, pivot))).toBeNull();
    const centered = createTransformPointerGesture(view, rect, pivot, project(view, pivot))!;
    expect(centered.sample('scale', 'x', start)).toBeNull();
  });

  it('keeps camera, bounds and pointer origin frozen for the gesture', () => {
    const view = camera(), bounds = { ...rect }, pivot = new Vector3(), start = project(view, pivot);
    const end = project(view, new Vector3(2, 0, 0));
    const gesture = createTransformPointerGesture(view, bounds, pivot, start)!;
    view.position.set(8, 3, 2); view.lookAt(0, 0, 0); view.updateMatrixWorld(true);
    bounds.width = 200; pivot.x = 10; start.x = 0;
    expect(gesture.sample('translate', 'x', end)).toBeCloseTo(2);
  });

  it('rejects unresolved depth-axis movement, edge-on rotation, invalid input and a hidden viewport', () => {
    const view = camera(), pivot = new Vector3(), start = project(view, new Vector3(1, 0, 0));
    const gesture = createTransformPointerGesture(view, rect, pivot, start)!;
    expect(gesture.sample('translate', 'z', { x: start.x + 10, y: start.y })).toBeNull();
    expect(gesture.sample('rotate', 'x', { x: start.x, y: start.y + 10 })).toBeNull();
    expect(gesture.sample('translate', 'x', { x: NaN, y: 0 })).toBeNull();
    expect(createTransformPointerGesture(view, { ...rect, width: 0 }, pivot, start)).toBeNull();
    expect(createTransformPointerGesture(view, rect, new Vector3(0, 0, 11), start)).toBeNull();
    expect(createTransformPointerGesture(view, rect, pivot, start, { translationScale: 0 })).toBeNull();
  });
});
