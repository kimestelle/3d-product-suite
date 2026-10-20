import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {addMotion, filmCameraPoseAtFrame, changeMotionScope, listMotions, updateMotion, validateFilmMotions} from './filmMotion';
import {createFrameSetup, frameObjectMotionKinds, patchFrameMotions, setFrameCamera, setFrameObjects, type FrameSetup} from './frameSetup';

const source = () => structuredClone(fixture) as any;
const newFrame = (scene: any) => createFrameSetup(scene, scene.shots[0].id);
const shotFor = (scene: any, setup: FrameSetup) => scene.shots.find((shot: any) => shot.id === setup.shotId);
const sampleFor = (scene: any, setup: FrameSetup) => ({frame: shotFor(scene, setup).startFrame,
  components: Object.fromEntries(scene.product.components.map((part: any) => [part.id, {
    translationM: [...part.assembly.translationM], rotationXyzw: [...part.assembly.rotationXyzw], scale: 1,
  }]))});
const motions = (scene: any, setup: FrameSetup) => shotFor(scene, setup).motions ?? [];

describe('new frame setup', () => {
  it('starts the first scene in an empty legacy movie without discarding motion', () => {
    const scene = source(); scene.shots = []; scene.render.durationFrames = 360;
    const actions = structuredClone(scene.actions);
    const setup = createFrameSetup(scene), shot = shotFor(scene, setup);
    expect(shot).toMatchObject({name: 'Untitled', startFrame: 1, endFrame: 360});
    expect(scene.render.durationFrames).toBe(360);
    expect(scene.actions).toEqual(actions);
    expect(setup.stage).toBe('objects');
  });

  it('extends an explicit movie duration when creating another scene', () => {
    const scene = source(); scene.render.durationFrames = 360;
    const setup = createFrameSetup(scene, scene.shots.at(-1).id);
    expect(shotFor(scene, setup)).toMatchObject({startFrame: 361, endFrame: 432});
    expect(scene.render.durationFrames).toBe(432);
  });

  it('creates a named frame with an inherited composition and no added movement', () => {
    const scene = source(), actions = structuredClone(scene.actions);
    const setup = newFrame(scene), shot = shotFor(scene, setup);
    expect(setup).toMatchObject({stage: 'objects', targets: ['$product'], objectKind: null, objectMotionIds: [], cameraTarget: '$product', cameraKind: null, cameraMotionId: null});
    expect(shot.name).toBe('Untitled'); expect(motions(scene, setup)).toEqual([]); expect(scene.actions).toEqual(actions);
    expect(shot.camera.from).toEqual(shot.camera.to);
  });

  it('adds a unique Untitled title without renaming existing scenes', () => {
    const scene = source();
    scene.shots[0].name = 'Untitled'; scene.shots[1].name = 'Untitled 2'; scene.shots[2].name = 'Frame 3';
    const names = scene.shots.map(({id, name}: any) => ({id, name}));
    expect(shotFor(scene, newFrame(scene)).name).toBe('Untitled 3');
    expect(shotFor(scene, newFrame(scene)).name).toBe('Untitled 4');
    for (const {id, name} of names) expect(scene.shots.find((shot: any) => shot.id === id).name).toBe(name);
  });

  it('uses the intersection of supported actions for multiple selected objects', () => {
    const scene = source();
    expect(frameObjectMotionKinds(scene, ['cap', 'neck'])).toEqual(['move', 'rotate', 'scale']);
    expect(frameObjectMotionKinds(scene, ['cap'])).toContain('mechanical');
    expect(frameObjectMotionKinds(scene, ['cap', 'bottle-body'])).toEqual([]);
    expect(frameObjectMotionKinds(scene, [])).toEqual([]);
  });

  it('edits multiple objects together while preserving independent source geometry', () => {
    const scene = source(), product = structuredClone(scene.product);
    let setup = newFrame(scene);
    setup = setFrameObjects(scene, setup, ['cap', 'neck'], 'move');
    expect(motions(scene, setup).map((motion: any) => motion.target)).toEqual(['cap', 'neck']);
    patchFrameMotions(scene, setup, {amount: .08, axis: 'x', durationFrames: 37, easing: 'linear'});
    expect(motions(scene, setup).every((motion: any) => motion.amount === .08 && motion.axis === 'x' && motion.durationFrames === 37)).toBe(true);
    expect(scene.product).toEqual(product);
  });

  it('retains IDs and parameters when revisiting choices and extends those parameters to new selections', () => {
    const scene = source(); let setup = newFrame(scene);
    setup = setFrameObjects(scene, setup, ['cap'], 'move');
    const capId = setup.objectMotionIds[0];
    patchFrameMotions(scene, setup, {amount: .12, axis: 'z', durationFrames: 25});
    setup = setFrameObjects(scene, setup, ['cap', 'neck'], 'move');
    expect(setup.objectMotionIds[0]).toBe(capId);
    expect(motions(scene, setup).every((motion: any) => motion.amount === .12 && motion.axis === 'z' && motion.durationFrames === 25)).toBe(true);
    setup = setFrameObjects(scene, setup, ['neck'], 'move');
    setup = setFrameObjects(scene, setup, ['neck'], 'move');
    expect(motions(scene, setup)).toHaveLength(1);
    expect(motions(scene, setup)[0].amount).toBe(.12);
  });

  it('rejects mixed Whole product selection and incompatible actions without changing scene or setup', () => {
    const scene = source(); let setup = newFrame(scene);
    setup = setFrameObjects(scene, setup, ['cap'], 'mechanical');
    const before = structuredClone(scene), beforeSetup = structuredClone(setup);
    expect(() => setFrameObjects(scene, setup, ['$product', 'cap'], 'move')).toThrow('Whole product');
    expect(() => setFrameObjects(scene, setup, ['cap', 'neck'], 'mechanical')).toThrow('supported by every');
    expect(() => setFrameObjects(scene, setup, ['missing'], null)).toThrow('no longer');
    expect(scene).toEqual(before); expect(setup).toEqual(beforeSetup);
  });

  it('no added motion removes only setup-owned local motions and preserves shared and legacy sources', () => {
    const scene = source(); let setup = newFrame(scene);
    const shared = addMotion(scene, setup.shotId, '$product', 'rotate'); changeMotionScope(scene, setup.shotId, shared, 'film');
    const custom = addMotion(scene, setup.shotId, 'label', 'scale');
    const global = structuredClone(scene.motions), actions = structuredClone(scene.actions);
    setup = setFrameObjects(scene, setup, ['cap', 'neck'], 'move');
    setup = setFrameObjects(scene, setup, ['cap', 'neck'], null);
    expect(setup.objectMotionIds).toEqual([]);
    expect(motions(scene, setup).map((motion: any) => motion.id)).toEqual([custom]);
    expect(scene.motions).toEqual(global); expect(scene.actions).toEqual(actions);
  });

  it('rolls back the whole multi-object parameter edit if one motion would conflict', () => {
    const scene = source(); let setup = newFrame(scene);
    setup = setFrameObjects(scene, setup, ['cap', 'neck'], 'move');
    const extra = addMotion(scene, setup.shotId, 'neck', 'rotate');
    updateMotion(scene, setup.shotId, extra, {kind: 'move', axis: 'x'});
    const before = structuredClone(scene);
    expect(() => patchFrameMotions(scene, setup, {axis: 'x'})).toThrow('already has a motion');
    expect(scene).toEqual(before);
  });

  it('targets the evaluated object at frame start and keeps the aim fixed', () => {
    const scene = source(); let setup = newFrame(scene);
    const sample = sampleFor(scene, setup); sample.components.cap.translationM = [.1, .2, .05];
    setup = setFrameCamera(scene, setup, 'cap', 'orbit', sample);
    const shot = shotFor(scene, setup);
    shot.camera.from.targetM.forEach((value: number, index: number) => expect(value).toBeCloseTo([.1, .2, .05][index], 12));
    expect(shot.camera.to.targetM).toEqual(shot.camera.from.targetM);
    expect(setup).toMatchObject({stage: 'camera', cameraTarget: 'cap', cameraKind: 'orbit'});
    expect(motions(scene, setup).find((motion: any) => motion.id === setup.cameraMotionId).target).toBe('$camera');
    sample.components.cap.translationM[0] = 9;
    expect(shot.camera.from.targetM[0]).toBeCloseTo(.1, 12);
  });

  it('revisiting a camera action preserves its parameters without duplicating it', () => {
    const scene = source(); let setup = newFrame(scene);
    let sample = sampleFor(scene, setup);
    setup = setFrameCamera(scene, setup, 'cap', 'orbit', sample);
    patchFrameMotions(scene, setup, {amount: 70, durationFrames: 31, easing: 'linear'});
    const id = setup.cameraMotionId;
    setup = setFrameCamera(scene, setup, 'neck', 'orbit', sample);
    expect(setup.cameraMotionId).toBe(id);
    expect(motions(scene, setup)).toHaveLength(1);
    expect(motions(scene, setup)[0]).toMatchObject({amount: 70, durationFrames: 31, easing: 'linear'});
    setup = setFrameObjects(scene, setup, ['cap'], 'move');
    expect(setup.stage).toBe('objects'); expect(motions(scene, setup)).toHaveLength(2);
    setup = setFrameCamera(scene, setup, 'neck', 'orbit', sampleFor(scene, setup));
    expect(motions(scene, setup)).toHaveLength(2);
  });

  it('rejects stale target samples and invalid camera aims atomically', () => {
    const scene = source(); const setup = newFrame(scene), sample = sampleFor(scene, setup);
    const before = structuredClone(scene);
    expect(() => setFrameCamera(scene, setup, 'cap', 'orbit', {...sample, frame: sample.frame - 1})).toThrow('frame’s start');
    sample.components.cap.translationM = [...shotFor(scene, setup).camera.from.positionM];
    expect(() => setFrameCamera(scene, setup, 'cap', 'orbit', sample)).toThrow();
    expect(scene).toEqual(before);
  });

  it('uses a safe dolly distance for small framing and validates the final owner before shared constraints', () => {
    const scene = source(); let setup = newFrame(scene);
    const shot = shotFor(scene, setup);
    shot.camera.from = {positionM: [.02, .5, 0], targetM: [0, .5, 0], focalLengthMm: 10};
    shot.camera.to = structuredClone(shot.camera.from);
    const sample = sampleFor(scene, setup); sample.components.cap.translationM = [0, .5, 0];
    setup = setFrameCamera(scene, setup, 'cap', 'dolly', sample);
    expect(motions(scene, setup)[0].amount).toBeLessThan(.02);
    expect(() => validateFilmMotions(scene)).not.toThrow();
    const local = motions(scene, setup)[0];
    scene.motions = [{...structuredClone(local), id: 'shared', amount: .1}];
    // The local owner makes the inherited too-long dolly inactive in this frame.
    setup = setFrameCamera(scene, setup, 'cap', 'orbit', sample);
    expect(setup.cameraKind).toBe('orbit');
    expect(scene.motions).toHaveLength(1);
  });

  it.each(['orbit', 'dolly'] as const)('changing from shared %s to local and back preserves the visible start position', kind => {
    const scene = source(), first = scene.shots[0];
    first.camera.from = {positionM: [1, .5, 0], targetM: [0, .5, 0], focalLengthMm: 50};
    first.camera.to = structuredClone(first.camera.from);
    const id = addMotion(scene, first.id, '$camera', kind);
    updateMotion(scene, first.id, id, {amount: kind === 'orbit' ? 90 : .1});
    changeMotionScope(scene, first.id, id, 'film');
    let setup = newFrame(scene), shot = shotFor(scene, setup), sample = sampleFor(scene, setup);
    const original = filmCameraPoseAtFrame(scene, shot, shot.startFrame);
    setup = setFrameCamera(scene, setup, 'cap', 'orbit', sample);
    shot = shotFor(scene, setup);
    const local = filmCameraPoseAtFrame(scene, shot, shot.startFrame);
    local.positionM.forEach((value, index) => expect(value).toBeCloseTo(original.positionM[index], 12));
    setup = setFrameCamera(scene, setup, 'neck', null, sample);
    shot = shotFor(scene, setup);
    const inherited = filmCameraPoseAtFrame(scene, shot, shot.startFrame);
    inherited.positionM.forEach((value, index) => expect(value).toBeCloseTo(original.positionM[index], 12));
    expect(scene.motions).toHaveLength(1);
  });

  it('retargeting a custom local curve with nonzero starting progress does not move the camera', () => {
    const scene = source(); let setup = newFrame(scene);
    setup = setFrameCamera(scene, setup, 'cap', 'orbit', sampleFor(scene, setup));
    patchFrameMotions(scene, setup, {keys: [{frame: 1, value: .5, interpolation: 'linear'}, {frame: 49, value: 1, interpolation: 'linear'}]});
    let shot = shotFor(scene, setup);
    const before = filmCameraPoseAtFrame(scene, shot, shot.startFrame);
    setup = setFrameCamera(scene, setup, 'neck', 'orbit', sampleFor(scene, setup));
    shot = shotFor(scene, setup);
    const after = filmCameraPoseAtFrame(scene, shot, shot.startFrame);
    after.positionM.forEach((value, index) => expect(value).toBeCloseTo(before.positionM[index], 12));
  });

  it('refuses to patch a managed motion moved outside setup instead of modifying shared work', () => {
    const scene = source(); let setup = newFrame(scene);
    setup = setFrameObjects(scene, setup, ['cap'], 'move');
    changeMotionScope(scene, setup.shotId, setup.objectMotionIds[0], 'film');
    const before = structuredClone(scene);
    expect(() => patchFrameMotions(scene, setup, {amount: .2})).toThrow('outside frame setup'); expect(scene).toEqual(before);
    setup = setFrameObjects(scene, setup, ['cap'], null);
    expect(listMotions(scene, setup.shotId).filter(item => item.scope === 'film')).toHaveLength(1);
  });
});
