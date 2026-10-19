import {describe, expect, it} from 'vitest';
import {cameraPoseAtFrame, cameraSourceEndFrame, offsetCameraFraming} from './cameraFraming';
import {editCamera} from './camera';

const shot = {id: 'one', startFrame: 11, endFrame: 111, camera: {
  from: {positionM: [1, 2, 3], targetM: [0, 1, 0], focalLengthMm: 35},
  to: {positionM: [3, 4, 5], targetM: [2, 1, 0], focalLengthMm: 85},
}};

describe('Still framing on the existing video camera', () => {
  it('shows the same smoothstep camera as the shared sampler at an intermediate frame', () => {
    expect(cameraPoseAtFrame(shot, 11)).toEqual(shot.camera.from);
    expect(cameraPoseAtFrame(shot, 111)).toEqual(shot.camera.to);
    expect(cameraPoseAtFrame(shot, 61)).toEqual({positionM: [2, 3, 4], targetM: [1, 1, 0], focalLengthMm: 60});
    // A quarter of the time is 0.15625 of the eased path, not 0.25.
    expect(cameraPoseAtFrame(shot, 36).positionM[0]).toBe(1.3125);
  });
  it('reports the source end independently of the editorial trim', () => {
    expect(cameraSourceEndFrame(shot)).toBe(111);
    expect(cameraSourceEndFrame({...shot, endFrame: 61, camera: {...shot.camera, durationFrames: 101}})).toBe(111);
    expect(cameraSourceEndFrame({...shot, camera: {...shot.camera, durationFrames: 1}})).toBe(11);
  });
  it('retains the source camera timing when the shot is trimmed or extended', () => {
    const trimmed = {...structuredClone(shot), endFrame: 61, camera: {...structuredClone(shot.camera), durationFrames: 101}};
    expect(cameraPoseAtFrame(trimmed, 61)).toEqual(cameraPoseAtFrame(shot, 61));
    expect(cameraPoseAtFrame(trimmed, 61)).not.toEqual(trimmed.camera.to);
    const extended = {...trimmed, endFrame: 211};
    expect(cameraPoseAtFrame(extended, 111)).toEqual(shot.camera.to);
    expect(cameraPoseAtFrame(extended, 211)).toEqual(shot.camera.to);
  });
  it('holds a one-frame source camera when its shot is extended', () => {
    const held = {...structuredClone(shot), camera: {...structuredClone(shot.camera), durationFrames: 1}};
    expect(cameraPoseAtFrame(held, 61)).toEqual(shot.camera.from);
    expect(cameraPoseAtFrame(held, 111)).toEqual(shot.camera.from);
  });
  it('uses the authored duration after the shot is reordered', () => {
    const moved = {...structuredClone(shot), startFrame: 201, endFrame: 251, camera: {...structuredClone(shot.camera), durationFrames: 101}};
    expect(cameraPoseAtFrame(moved, 251)).toEqual(cameraPoseAtFrame(shot, 61));
  });
  it('sets the selected frame while retaining endpoint differences in position, aim, and lens', () => {
    const next = structuredClone(shot), pose = cameraPoseAtFrame(next, 36);
    offsetCameraFraming(next.camera, pose, value => {value.positionM[0] = 10; value.targetM[1] = 3; value.focalLengthMm = 50;});
    const current = cameraPoseAtFrame(next, 36);
    expect(current.positionM[0]).toBeCloseTo(10);
    expect(current.targetM[1]).toBe(3);
    expect(current.focalLengthMm).toBeCloseTo(50);
    expect(next.camera.to.positionM.map((value, index) => value - next.camera.from.positionM[index])).toEqual([2, 2, 2]);
    expect(next.camera.to.targetM.map((value, index) => value - next.camera.from.targetM[index])).toEqual([2, 0, 0]);
    expect(next.camera.to.focalLengthMm - next.camera.from.focalLengthMm).toBe(50);
  });
  it('does not flatten a moving shot when reframing a still', () => {
    const next = structuredClone(shot), before = structuredClone(next.camera);
    offsetCameraFraming(next.camera, cameraPoseAtFrame(next, 61), value => {value.positionM[2] += .2;});
    expect(next.camera.from.targetM).toEqual(before.from.targetM);
    expect(next.camera.to.targetM).toEqual(before.to.targetM);
    expect(next.camera.from.focalLengthMm).toBe(35);
    expect(next.camera.to.focalLengthMm).toBe(85);
    expect(next.camera.from.positionM).not.toEqual(next.camera.to.positionM);
  });
  it('rejects an offset that makes another endpoint invalid, preserving the original camera', () => {
    const scene = {shots: [structuredClone(shot)]}, before = structuredClone(scene);
    expect(() => editCamera(scene, 'one', camera => offsetCameraFraming(camera, cameraPoseAtFrame(shot, 61), value => {value.focalLengthMm = 1;}))).toThrow('Focal length must be at least 1 mm');
    expect(scene).toEqual(before);
  });
});
