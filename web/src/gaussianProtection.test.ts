import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import {clampGaussianPose, protectedGaussianPose, type GaussianProtection} from './gaussianProtection';
import {StudioViewport} from './viewport';

const bounds: GaussianProtection = {
  positionMinM: [-2, 0, -4], positionMaxM: [2, 3, 1],
  targetMinM: [-3, 0, -5], targetMaxM: [3, 3, 1], outside: 'black',
};

describe('protected room inspection', () => {
  it('keeps orbit and pan inside the room and rejects a collapsed or invalid camera', () => {
    const pose = clampGaussianPose(bounds, {positionM: [4, -1, 1], targetM: [-8, 2, -7]});
    expect(pose).toEqual({positionM: [2, 0, 1], targetM: [-3, 2, -5]});
    expect(protectedGaussianPose(bounds, pose!)).toBe(true);
    expect(clampGaussianPose(bounds, {positionM: [0, 1, 0], targetM: [0, 1, 0]})).toBeNull();
    expect(clampGaussianPose(bounds, {positionM: [NaN, 1, 0], targetM: [0, 1, -1]})).toBeNull();
  });

  it('enables real viewport inspection and constrains its camera without editing the sampled shot', () => {
    const view = Object.create(StudioViewport.prototype) as any;
    const source = {position: new THREE.Vector3(0, 1, 1), target: new THREE.Vector3(0, 1, -2)};
    Object.assign(view, {
      gaussianProtection: bounds, productPreview: false, camera: new THREE.PerspectiveCamera(),
      sampledCamera: source, controls: {enabled: false, target: new THREE.Vector3(-7, 1, -8)},
      inspectionEnabled: true, parts: new Map([['product', {}]]), options: {},
      canvas: {style: {}}, syncPropTransform: vi.fn(), invalidate: vi.fn(),
    });
    view.updateControlsEnabled();
    expect(view.controls.enabled).toBe(true);
    view.camera.position.set(8, 1, 5);
    view.onControlsStart();
    view.onControlsChange();
    expect(view.inspectingCamera).toBe(true);
    expect(view.camera.position.toArray()).toEqual([2, 1, 1]);
    expect(view.controls.target.toArray()).toEqual([-3, 1, -5]);
    expect(source.position.toArray()).toEqual([0, 1, 1]);
    expect(source.target.toArray()).toEqual([0, 1, -2]);
  });
});
