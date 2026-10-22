import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {addMotion, changeMotionScope, filmCameraPoseAtFrame, setMotionKeys, updateMotion} from './filmMotion';
import {cameraMotionSelection, effectiveCameraMotion, isCameraHoldMotion, setCameraMotionPreset} from './cameraMotionPresets';

const source = (): any => structuredClone(fixture);
const expectPose = (actual: any, expected: any) => {
  for (const key of ['positionM', 'targetM']) actual[key].forEach((value: number, index: number) => expect(value).toBeCloseTo(expected[key][index], 10));
  expect(actual.focalLengthMm).toBeCloseTo(expected.focalLengthMm, 10);
};
const activeLocal = (shot: any) => (shot.motions ?? []).filter((motion: any) => motion.target === '$camera' && motion.enabled);

describe('camera motion presets in an existing scene', () => {
  it('reads imported endpoint motion without modifying it or calling it Still', () => {
    const scene = source(), shot = scene.shots[0], before = structuredClone(scene);
    expect(cameraMotionSelection(scene, shot.id)).toBe('custom');
    expect(scene).toEqual(before);
    shot.camera.durationFrames = 1;
    expect(cameraMotionSelection(scene, shot.id)).toBe('still');
    delete shot.camera.durationFrames;
    shot.camera.to = structuredClone(shot.camera.from);
    expect(cameraMotionSelection(scene, shot.id)).toBe('still');
    shot.camera.to.focalLengthMm += 10;
    expect(cameraMotionSelection(scene, shot.id)).toBe('custom');
  });

  it('holds the edited image, including lens, while preserving optics and unrelated authored work', () => {
    const scene = source(), shot = scene.shots[0], frame = 60;
    shot.camera.depthOfField = {enabled: true, fStop: 4, focusDistanceM: 1};
    shot.camera.to.focalLengthMm += 20;
    const partId = addMotion(scene, shot.id, 'cap', 'move');
    scene.animation = {tracks: [{id: 'imported', componentId: '$product', property: 'position.x', enabled: true,
      keys: [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 100, value: .1, interpolation: 'ease'}]}]};
    const before = structuredClone(scene), pose = filmCameraPoseAtFrame(scene, shot, frame);
    expect(setCameraMotionPreset(scene, shot.id, 'still', frame)).toBeNull();
    expect(shot.camera.durationFrames).toBe(1);
    expect(shot.camera.depthOfField).toEqual(before.shots[0].camera.depthOfField);
    for (const sampleFrame of [shot.startFrame, frame, shot.endFrame]) expectPose(filmCameraPoseAtFrame(scene, shot, sampleFrame), pose);
    expect(shot.motions.find((motion: any) => motion.id === partId)).toEqual(before.shots[0].motions[0]);
    expect(scene.product).toEqual(before.product); expect(scene.actions).toEqual(before.actions); expect(scene.animation).toEqual(before.animation);
    expect(scene.shots.slice(1)).toEqual(before.shots.slice(1));
    const held = structuredClone(scene);
    setCameraMotionPreset(scene, shot.id, 'still', frame);
    expect(scene).toEqual(held);
  });

  it.each(['orbit', 'dolly'] as const)('holds a shared %s with custom progress locally and agrees with the export sampler', kind => {
    const scene = source(), first = scene.shots[0], shot = scene.shots[1];
    const id = addMotion(scene, first.id, '$camera', kind);
    updateMotion(scene, first.id, id, {amount: kind === 'orbit' ? 65 : .03, durationFrames: 300});
    setMotionKeys(scene, first.id, id, [{frame: 1, value: .2, interpolation: 'linear'}, {frame: 300, value: .9, interpolation: 'linear'}]);
    changeMotionScope(scene, first.id, id, 'film');
    const before = structuredClone(scene), frame = shot.startFrame + 20, pose = filmCameraPoseAtFrame(scene, shot, frame);
    setCameraMotionPreset(scene, shot.id, 'still', frame);
    expect(cameraMotionSelection(scene, shot.id)).toBe('still');
    expect(isCameraHoldMotion(effectiveCameraMotion(scene, shot.id))).toBe(true);
    expect(activeLocal(shot)).toHaveLength(1);
    expect(scene.motions).toEqual(before.motions);
    expect(scene.shots[0]).toEqual(before.shots[0]); expect(scene.shots[2]).toEqual(before.shots[2]);
    for (const sampleFrame of [shot.startFrame, frame, shot.endFrame]) expectPose(filmCameraPoseAtFrame(scene, shot, sampleFrame), pose);
    const sampled = JSON.parse(execFileSync('python3', ['-c', 'import json,sys; from film.scene import validate_scene,evaluate; s=json.load(sys.stdin); validate_scene(s); print(json.dumps([evaluate(s,f)["camera"] for f in [s["shots"][1]["startFrame"],s["shots"][1]["endFrame"]]]))'], {
      input: JSON.stringify(scene), cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8',
    }));
    sampled.forEach((camera: any) => expectPose(camera, pose));
  });

  it('preserves an existing local curve and amount when Still disables it', () => {
    const scene = source(), shot = scene.shots[0], id = addMotion(scene, shot.id, '$camera', 'orbit');
    setMotionKeys(scene, shot.id, id, [{frame: 1, value: .4, interpolation: 'linear'}, {frame: 49, value: 1, interpolation: 'ease'}]);
    const authored = structuredClone(effectiveCameraMotion(scene, shot.id)), pose = filmCameraPoseAtFrame(scene, shot, 20);
    setCameraMotionPreset(scene, shot.id, 'still', 20);
    expect(shot.motions.find((motion: any) => motion.id === id)).toEqual({...authored, enabled: false});
    expect(activeLocal(shot)).toHaveLength(0);
    expectPose(filmCameraPoseAtFrame(scene, shot, shot.endFrame), pose);
  });

  it('switches presets in place while retaining local timing and curve and the edited image', () => {
    const scene = source(), shot = scene.shots[0], id = addMotion(scene, shot.id, '$camera', 'orbit');
    updateMotion(scene, shot.id, id, {durationFrames: 60, startFrame: 4});
    setMotionKeys(scene, shot.id, id, [{frame: 1, value: .4, interpolation: 'linear'}, {frame: 60, value: 1, interpolation: 'ease'}]);
    const frame = 30, before = structuredClone(scene), pose = filmCameraPoseAtFrame(scene, shot, frame);
    expect(setCameraMotionPreset(scene, shot.id, 'orbit', frame)).toBe(id);
    expect(scene).toEqual(before);
    expect(setCameraMotionPreset(scene, shot.id, 'dolly', frame)).toBe(id);
    expect(activeLocal(shot)).toHaveLength(1);
    expect(effectiveCameraMotion(scene, shot.id)).toMatchObject({id, kind: 'dolly', durationFrames: 60, startFrame: 4, keys: before.shots[0].motions[0].keys});
    expectPose(filmCameraPoseAtFrame(scene, shot, frame), pose);
    const changed = structuredClone(scene);
    setCameraMotionPreset(scene, shot.id, 'dolly', frame);
    expect(scene).toEqual(changed);
  });

  it('replaces inherited custom-key movement with a local preset without moving the current view', () => {
    const scene = source(), first = scene.shots[0], shot = scene.shots[1];
    const id = addMotion(scene, first.id, '$camera', 'orbit');
    updateMotion(scene, first.id, id, {amount: 100, durationFrames: 300});
    setMotionKeys(scene, first.id, id, [{frame: 1, value: .3, interpolation: 'linear'}, {frame: 300, value: 1, interpolation: 'linear'}]);
    changeMotionScope(scene, first.id, id, 'film');
    const before = structuredClone(scene), frame = shot.startFrame + 20, pose = filmCameraPoseAtFrame(scene, shot, frame);
    expect(setCameraMotionPreset(scene, shot.id, 'orbit', frame)).toBe(id);
    expect(scene).toEqual(before);
    const localId = setCameraMotionPreset(scene, shot.id, 'dolly', frame);
    expect(localId).not.toBe(id); expect(activeLocal(shot)).toHaveLength(1);
    expect(scene.motions).toEqual(before.motions); expect(scene.shots[0]).toEqual(before.shots[0]);
    expectPose(filmCameraPoseAtFrame(scene, shot, frame), pose);
  });

  it('leaves a shared hold with one moving local owner and restores endpoint access', () => {
    const scene = source(), shot = scene.shots[0], id = addMotion(scene, shot.id, '$camera', 'orbit');
    changeMotionScope(scene, shot.id, id, 'film');
    setCameraMotionPreset(scene, shot.id, 'still', 30);
    const holdId = effectiveCameraMotion(scene, shot.id)!.id, held = filmCameraPoseAtFrame(scene, shot, 1);
    expect(setCameraMotionPreset(scene, shot.id, 'dolly', 1)).toBe(holdId);
    expect(shot.camera.durationFrames).toBeUndefined();
    expect(activeLocal(shot)).toHaveLength(1);
    expect(cameraMotionSelection(scene, shot.id)).toBe('dolly');
    expectPose(filmCameraPoseAtFrame(scene, shot, 1), held);
    expect(filmCameraPoseAtFrame(scene, shot, shot.endFrame).positionM).not.toEqual(held.positionM);
  });

  it('bounds Push in for a close focus plane and rejects invalid results atomically', () => {
    const scene = source(), shot = scene.shots[0];
    shot.camera.from = {positionM: [.011, .5, 0], targetM: [0, .5, 0], focalLengthMm: 10};
    shot.camera.to = structuredClone(shot.camera.from);
    shot.camera.depthOfField = {enabled: true, fStop: 4};
    setCameraMotionPreset(scene, shot.id, 'dolly', 1);
    expect(effectiveCameraMotion(scene, shot.id)!.amount).toBeCloseTo(.0005, 10);
    const untouched = structuredClone(scene);
    expect(() => setCameraMotionPreset(scene, shot.id, 'still', NaN)).toThrow('valid frame');
    expect(scene).toEqual(untouched);
    shot.camera.from.positionM = [0, 1, 0]; shot.camera.to.positionM = [0, 1, 0];
    const invalid = structuredClone(scene);
    expect(() => setCameraMotionPreset(scene, shot.id, 'orbit', 1)).toThrow();
    expect(scene).toEqual(invalid);
  });
});
