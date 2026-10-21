import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {addMotion, filmCameraPoseAtFrame, availableMotionKinds, changeMotionScope, listMotions, motionChannels, removeMotion, setMotionKeys, updateMotion, validateFilmMotions} from './filmMotion';
import {cameraPoseAtFrame} from './cameraFraming';
import {addShot, duplicateShot, moveShot, setFrameRate, setShotFrames, stretchShotFrames} from './sequence';
import {defaultLighting} from './world';
const source = () => structuredClone(fixture) as any;
const get = (scene: any, shotId = scene.shots[0].id) => listMotions(scene, shotId)[0].motion;

describe('light motions', () => {
  it('offers orbit, move and aim on enabled rig lights and persists a legacy rig when animating it', () => {
    const scene = source(), shot = scene.shots[0].id;
    expect(scene.lighting).toBeUndefined();
    expect(availableMotionKinds(scene, '$light:key')).toEqual(['orbit', 'move', 'aim']);
    expect(availableMotionKinds(scene, '$light:missing')).toEqual([]);
    const id = addMotion(scene, shot, '$light:key', 'orbit');
    expect(scene.lighting.lights.map((light: any) => light.id)).toEqual(['key', 'fill', 'rim']);
    expect(get(scene)).toMatchObject({id, target: '$light:key', kind: 'orbit', axis: 'y', amount: 60, startFrame: 1, durationFrames: 120, easing: 'ease', enabled: true});
    addMotion(scene, shot, '$light:key', 'move'); addMotion(scene, shot, '$light:key', 'aim');
    expect(listMotions(scene, shot).map(entry => entry.motion.amount)).toEqual([60, .1, .05]);
    expect(() => addMotion(scene, shot, '$light:key', 'orbit')).toThrow('already has a motion');
    expect(() => addMotion(scene, shot, '$light:key', 'aim')).toThrow('already has a motion');
    expect(addMotion(scene, shot, '$light:rim', 'orbit')).toBeTruthy();
  });
  it('rejects disabled or missing lights, unsupported kinds and unsaved rigs like the sampler', () => {
    const scene = source(), shot = scene.shots[0].id;
    scene.lighting = defaultLighting(scene); scene.lighting.lights[1].enabled = false;
    expect(availableMotionKinds(scene, '$light:fill')).toEqual([]);
    expect(() => addMotion(scene, shot, '$light:fill', 'orbit')).toThrow('unavailable');
    expect(() => addMotion(scene, shot, '$product', 'aim')).toThrow('unavailable');
    expect(() => addMotion(scene, shot, '$camera', 'aim')).toThrow('unavailable');
    expect(() => addMotion(scene, shot, 'cap', 'aim')).toThrow('unavailable');
    const id = addMotion(scene, shot, '$light:key', 'orbit');
    expect(() => updateMotion(scene, shot, id, {kind: 'rotate'})).toThrow('unavailable');
    expect(() => updateMotion(scene, shot, id, {axis: 'x'})).toThrow('vertical Y axis');
    const unsaved = source(); unsaved.shots[0].motions = [structuredClone(get(scene))];
    expect(() => validateFilmMotions(unsaved)).toThrow('Save the studio rig');
  });
  it('light orbits ignore the camera distance rule and own channels like the sampler', () => {
    const scene = source(), shot = scene.shots[0];
    shot.camera.from = {positionM: [.001, .5, 0], targetM: [0, .5, 0], focalLengthMm: 50};
    shot.camera.to = structuredClone(shot.camera.from);
    expect(() => addMotion(scene, shot.id, '$light:key', 'orbit')).not.toThrow();
    expect(() => addMotion(scene, shot.id, '$camera', 'dolly')).toThrow('stop before');
    expect(motionChannels({kind: 'orbit', axis: 'y', target: '$light:key'})).toEqual(['position']);
    expect(motionChannels({kind: 'move', axis: 'x', target: '$light:key'})).toEqual(['position.x']);
    expect(motionChannels({kind: 'aim', axis: 'z', target: '$light:key'})).toEqual(['target.z']);
    expect(motionChannels({kind: 'orbit', axis: 'y', target: '$camera'})).toEqual(['camera.position']);
    expect(motionChannels({kind: 'orbit', axis: 'y'})).toEqual(['camera.position']);
  });
});

describe('bounded Film motions', () => {
  it('offers only supported actions and existing confirmed mechanics', () => {
    const scene = source();
    expect(availableMotionKinds(scene, '$camera')).toEqual(['orbit', 'dolly']);
    expect(availableMotionKinds(scene, '$product')).toEqual(['move', 'rotate', 'scale']);
    expect(availableMotionKinds(scene, 'cap')).toContain('mechanical');
    expect(availableMotionKinds(scene, 'neck')).not.toContain('mechanical');
    expect(availableMotionKinds(scene, 'bottle-body')).toEqual([]);
    expect(availableMotionKinds(scene, 'missing')).toEqual([]);
  });
  it('adds a local action without changing legacy animation or cameras', () => {
    const scene = source(), before = structuredClone(scene);
    const id = addMotion(scene, scene.shots[0].id, '$product', 'move');
    expect(get(scene)).toMatchObject({id, startFrame: 1, durationFrames: 49, enabled: true});
    expect(scene.actions).toEqual(before.actions); expect(scene.shots[0].camera).toEqual(before.shots[0].camera);
    expect(scene.motions).toBeUndefined();
  });
  it('rejects competing owners atomically, while different axes can coexist', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, '$product', 'move');
    const before = structuredClone(scene);
    expect(() => addMotion(scene, shot, '$product', 'move')).toThrow('already has a motion');
    expect(scene).toEqual(before);
    updateMotion(scene, shot, id, {axis: 'x'});
    addMotion(scene, shot, '$product', 'move');
    expect(listMotions(scene, shot)).toHaveLength(2);
    const enabled = structuredClone(scene);
    expect(() => updateMotion(scene, shot, id, {axis: 'y'})).toThrow('already has a motion');
    expect(scene).toEqual(enabled);
  });
  it('disabling frees ownership without deleting the authored action', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, '$camera', 'orbit');
    updateMotion(scene, shot, id, {enabled: false}); addMotion(scene, shot, '$camera', 'dolly');
    expect(listMotions(scene, shot)).toHaveLength(2);
    expect(() => updateMotion(scene, shot, id, {enabled: true})).toThrow('already has a motion');
  });
  it('scope changes preserve absolute timing and reject negative shot-local starts', () => {
    const scene = source(), shot = scene.shots[1].id;
    const id = addMotion(scene, shot, '$product', 'move');
    updateMotion(scene, shot, id, {startFrame: 7}); changeMotionScope(scene, shot, id, 'film');
    expect(listMotions(scene, shot)[0].scope).toBe('film'); expect(get(scene, shot).startFrame).toBe(127);
    changeMotionScope(scene, shot, id, 'shot'); expect(get(scene, shot).startFrame).toBe(7);
    changeMotionScope(scene, shot, id, 'film');
    const before = structuredClone(scene);
    expect(() => changeMotionScope(scene, scene.shots[2].id, id, 'shot')).toThrow('begins before'); expect(scene).toEqual(before);
  });
  it('retains source motion when trimmed and carries it with reordered and copied shots', () => {
    const scene = source(), shot = scene.shots[0].id;
    addMotion(scene, shot, '$product', 'move'); const motion = structuredClone(get(scene));
    setShotFrames(scene, shot, 20); expect(get(scene).durationFrames).toBe(49);
    moveShot(scene, shot, 1); expect(get(scene, shot)).toEqual(motion);
    const copied = duplicateShot(scene, shot); expect(get(scene, copied)).toEqual({...motion, id: get(scene, copied).id});
    expect(get(scene, copied).id).not.toBe(motion.id);
    updateMotion(scene, copied, get(scene, copied).id, {amount: .2}); expect(get(scene, shot).amount).toBe(.05);
  });
  it('explicit stretching scales motion clock and keys together', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, '$product', 'move');
    updateMotion(scene, shot, id, {durationFrames: 25, startFrame: 13});
    setMotionKeys(scene, shot, id, [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 13, value: .25, interpolation: 'ease'}, {frame: 25, value: 1, interpolation: 'linear'}]);
    stretchShotFrames(scene, shot, 239);
    expect(get(scene)).toMatchObject({startFrame: 25, durationFrames: 49});
    expect(get(scene).keys?.map(key => key.frame)).toEqual([1, 25, 49]);
  });
  it('FPS changes preserve local and shared sample times, and keys do not collide silently', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, '$product', 'move');
    updateMotion(scene, shot, id, {startFrame: 25, durationFrames: 25});
    const camera = addMotion(scene, shot, '$camera', 'orbit'); changeMotionScope(scene, shot, camera, 'film');
    setFrameRate(scene, 30); expect(get(scene)).toMatchObject({startFrame: 31, durationFrames: 31});
    expect(scene.motions[0].durationFrames).toBe(61);
    setMotionKeys(scene, shot, id, [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 2, value: 1, interpolation: 'linear'}]);
    const before = structuredClone(scene);
    expect(() => setFrameRate(scene, 10)).toThrow('keys would overlap'); expect(scene).toEqual(before);
  });
  it('can edit a curve and return to the procedural action without losing its parameters', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, 'cap', 'mechanical');
    setMotionKeys(scene, shot, id, [{frame: 1, value: 0, interpolation: 'hold'}, {frame: 48, value: 1, interpolation: 'linear'}]);
    updateMotion(scene, shot, id, {durationFrames: 24});
    expect(get(scene).keys?.map(key => key.frame)).toEqual([1, 24]);
    setMotionKeys(scene, shot, id, undefined); expect(get(scene).keys).toBeUndefined(); expect(get(scene).amount).toBe(1);
    removeMotion(scene, shot, id); expect(listMotions(scene, shot)).toEqual([]);
  });
  it('retiming a motion duration rejects key collisions atomically', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, '$product', 'move');
    setMotionKeys(scene, shot, id, [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 2, value: .5, interpolation: 'linear'}, {frame: 49, value: 1, interpolation: 'linear'}]);
    const before = structuredClone(scene);
    expect(() => updateMotion(scene, shot, id, {durationFrames: 2})).toThrow('keys would overlap'); expect(scene).toEqual(before);
  });
  it('scope conversion preserves both actions when IDs collide', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, '$product', 'move');
    scene.motions = [{...structuredClone(get(scene)), target: '$camera', kind: 'orbit'}];
    const converted = changeMotionScope(scene, shot, id, 'film');
    expect(converted).not.toBe(id); expect(scene.motions).toHaveLength(2);
    expect(new Set(scene.motions.map((motion: any) => motion.id)).size).toBe(2);
  });
  it('trimming retains camera source time and stretching explicitly changes its speed', () => {
    const scene = source(), shot = scene.shots[0], id = shot.id;
    const at30 = cameraPoseAtFrame(shot, 30), at60 = cameraPoseAtFrame(shot, 60);
    setShotFrames(scene, id, 60);
    expect(scene.shots[0].camera.durationFrames).toBe(120);
    expect(cameraPoseAtFrame(scene.shots[0], 30)).toEqual(at30);
    expect(cameraPoseAtFrame(scene.shots[0], 60)).toEqual(at60);
    stretchShotFrames(scene, id, 119);
    expect(scene.shots[0].camera.durationFrames).toBe(239);
    expect(cameraPoseAtFrame(scene.shots[0], 59)).toEqual(at30);
    setFrameRate(scene, 48);
    expect(scene.shots[0].camera.durationFrames).toBe(477);
    expect(cameraPoseAtFrame(scene.shots[0], 117)).toEqual(at30);
  });
  it('rejects impossible automatic focus for a fixed-radius orbit', () => {
    const scene = source(), shot = scene.shots[0];
    shot.camera.from = {positionM: [.1, 0, 0], targetM: [0, 0, 0], focalLengthMm: 50};
    shot.camera.to = {positionM: [1, 0, 0], targetM: [0, 0, 0], focalLengthMm: 200};
    shot.camera.depthOfField = {enabled: true, fStop: 2.8};
    const before = structuredClone(scene);
    expect(() => addMotion(scene, shot.id, '$camera', 'orbit')).toThrow('focus plane'); expect(scene).toEqual(before);
  });
  it('rejects duplicate local/shared IDs and invalid camera source durations', () => {
    const scene = source(), shot = scene.shots[0];
    addMotion(scene, shot.id, '$product', 'move');
    scene.motions = [{...structuredClone(get(scene)), target: '$camera', kind: 'orbit'}];
    expect(() => validateFilmMotions(scene)).toThrow('distinct IDs');
    delete scene.motions;
    for (const durationFrames of [0, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      shot.camera.durationFrames = durationFrames;
      expect(() => validateFilmMotions(scene)).toThrow('positive whole number');
    }
  });
  it('new shots begin at the trimmed camera source pose and preserve optics', () => {
    const scene = source(), id = scene.shots[0].id;
    scene.shots[0].camera.depthOfField = {enabled: true, fStop: 2.8, focusDistanceM: 1};
    const expected = cameraPoseAtFrame(scene.shots[0], 60);
    setShotFrames(scene, id, 60);
    const addedId = addShot(scene, id), added = scene.shots.find((shot: any) => shot.id === addedId);
    expect(added.camera.from).toEqual(expected); expect(added.camera.to).toEqual(expected);
    expect(added.camera.depthOfField).toEqual(scene.shots[0].camera.depthOfField);
    expect(added.camera.durationFrames).toBeUndefined();
  });
  it.each(['orbit', 'dolly'] as const)('new shots inherit the actual local %s endpoint', kind => {
    const scene = source(), id = scene.shots[0].id;
    scene.shots[0].camera.from = {positionM: [1, .5, 0], targetM: [0, .5, 0], focalLengthMm: 50};
    const motionId = addMotion(scene, id, '$camera', kind);
    updateMotion(scene, id, motionId, {amount: kind === 'orbit' ? 90 : .5, easing: 'linear'});
    setShotFrames(scene, id, 25);
    const addedId = addShot(scene, id), added = scene.shots.find((shot: any) => shot.id === addedId);
    const camera = filmCameraPoseAtFrame(scene, added, added.startFrame);
    expect(camera.positionM[0]).toBeCloseTo(kind === 'orbit' ? Math.SQRT1_2 : .75, 12);
    expect(camera.positionM[2]).toBeCloseTo(kind === 'orbit' ? -Math.SQRT1_2 : 0, 12);
    expect(camera.targetM).toEqual([0, .5, 0]);
  });
  it.each(['orbit', 'dolly'] as const)('new shots compensate an across-cuts %s without applying it twice', kind => {
    const scene = source(), id = scene.shots[0].id;
    scene.shots[0].camera.from = {positionM: [1, .5, 0], targetM: [0, .5, 0], focalLengthMm: 50};
    const motionId = addMotion(scene, id, '$camera', kind);
    updateMotion(scene, id, motionId, {amount: kind === 'orbit' ? 180 : .2, durationFrames: 239, easing: 'linear'});
    changeMotionScope(scene, id, motionId, 'film');
    const previous = filmCameraPoseAtFrame(scene, scene.shots[0], 120), shared = structuredClone(scene.motions);
    const addedId = addShot(scene, id), added = scene.shots.find((shot: any) => shot.id === addedId);
    const opening = filmCameraPoseAtFrame(scene, added, added.startFrame);
    opening.positionM.forEach((value, index) => expect(value).toBeCloseTo(previous.positionM[index], 12));
    expect(opening.targetM).toEqual(previous.targetM); expect(scene.motions).toEqual(shared);
    expect(filmCameraPoseAtFrame(scene, added, added.startFrame + 10).positionM).not.toEqual(opening.positionM);
  });
  it('the editorial camera projection follows custom progress keys and local precedence', () => {
    const scene = source(), id = scene.shots[0].id;
    scene.shots[0].camera.from = {positionM: [1, .5, 0], targetM: [0, .5, 0], focalLengthMm: 50};
    const motionId = addMotion(scene, id, '$camera', 'orbit');
    updateMotion(scene, id, motionId, {amount: 180});
    setMotionKeys(scene, id, motionId, [{frame: 1, value: 0, interpolation: 'hold'}, {frame: 25, value: .5, interpolation: 'linear'}, {frame: 49, value: 1, interpolation: 'linear'}]);
    scene.motions = [{...structuredClone(get(scene)), id: 'shared', amount: -180}];
    expect(filmCameraPoseAtFrame(scene, scene.shots[0], 24).positionM).toEqual([1, .5, 0]);
    const middle = filmCameraPoseAtFrame(scene, scene.shots[0], 25);
    expect(middle.positionM[0]).toBeCloseTo(0, 12); expect(middle.positionM[2]).toBeCloseTo(-1, 12);
  });
  it('rejects malformed curves and unknown targets', () => {
    const scene = source(), shot = scene.shots[0].id;
    const id = addMotion(scene, shot, '$product', 'move');
    expect(() => updateMotion(scene, shot, id, {target: 'missing'})).toThrow('unavailable');
    expect(() => setMotionKeys(scene, shot, id, [{frame: 1, value: 2, interpolation: 'ease'}])).toThrow('0% and 100%');
    expect(() => updateMotion(scene, shot, id, {amount: Number.NaN})).toThrow('finite');
    expect(() => validateFilmMotions(scene)).not.toThrow();
  });
});
