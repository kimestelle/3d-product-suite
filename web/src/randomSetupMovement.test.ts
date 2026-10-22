import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {addMotion, changeMotionScope, updateMotion} from './filmMotion';
import {defaultLighting} from './world';
import {randomSetupMovement} from './randomSetupMovement';
const source = (): any => structuredClone(fixture);
const withoutMechanism = () => {const scene = source(); scene.actions = []; return scene;};
const track = (property: string, values: number[], frames = [1, 60, 120]) => ({id: property, componentId: '$product', property, enabled: true,
  keys: values.map((value, index) => ({frame: frames[index], value, interpolation: 'linear'}))});

describe('authored movement during random setup shots', () => {
  it('detects the bottle mechanism only while it moves without changing performance', () => {
    const scene = source(), before = structuredClone(scene);
    expect(scene.shots.map((shot: any) => randomSetupMovement(scene, shot).cameraMustHold)).toEqual([false, true, false]);
    expect(randomSetupMovement(scene, scene.shots[1]).kinds).toEqual(['mechanical']); expect(scene).toEqual(before);
  });
  it('detects interior excursions even when track and action endpoints match', () => {
    const scene = withoutMechanism(); scene.animation = {tracks: [track('position.x', [0, .2, 0])]};
    expect(randomSetupMovement(scene, scene.shots[0])).toEqual({cameraMustHold: true, kinds: ['move'], mixedAuthoredKinds: false});
    delete scene.animation;
    const id = addMotion(scene, scene.shots[0].id, '$product', 'rotate');
    updateMotion(scene, scene.shots[0].id, id, {durationFrames: 120, keys: [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 60, value: 1, interpolation: 'linear'}, {frame: 120, value: 0, interpolation: 'linear'}]});
    expect(randomSetupMovement(scene, scene.shots[0]).kinds).toEqual(['rotate']);
  });
  it('ignores disabled, constant, completed and future tracks', () => {
    const scene = withoutMechanism();
    scene.animation = {tracks: [track('position.x', [0, .2, 0]), track('position.y', [.2, .2, .2]), track('scale', [1, 2], [130, 150])]};
    scene.animation.tracks[0].enabled = false;
    expect(randomSetupMovement(scene, scene.shots[0]).cameraMustHold).toBe(false);
    expect(randomSetupMovement(scene, scene.shots[2]).cameraMustHold).toBe(false);
  });
  it('uses local clocks and masks conflicting shared owners with static holds', () => {
    const scene = withoutMechanism(), shot = scene.shots[1];
    const shared = addMotion(scene, shot.id, '$product', 'move');
    updateMotion(scene, shot.id, shared, {durationFrames: 120}); changeMotionScope(scene, shot.id, shared, 'film');
    expect(randomSetupMovement(scene, scene.shots[0]).cameraMustHold).toBe(false);
    expect(randomSetupMovement(scene, shot).kinds).toEqual(['move']);
    const local = addMotion(scene, shot.id, '$product', 'move'); updateMotion(scene, shot.id, local, {amount: 0});
    expect(randomSetupMovement(scene, shot).cameraMustHold).toBe(false);
  });
  it('does not count a varying track replaced by a static Film owner', () => {
    const scene = withoutMechanism(); scene.animation = {tracks: [track('position.y', [0, .2, 0])]};
    const id = addMotion(scene, scene.shots[0].id, '$product', 'move'); updateMotion(scene, scene.shots[0].id, id, {amount: 0});
    expect(randomSetupMovement(scene, scene.shots[0]).cameraMustHold).toBe(false);
  });
  it('honors mechanical progress holds and explicit spatial owners', () => {
    const scene = source(), shot = scene.shots[1];
    scene.animation = {tracks: [{...track('motion', [.5, .5], [121, 240]), componentId: 'cap'}]};
    expect(randomSetupMovement(scene, shot).cameraMustHold).toBe(false);
    delete scene.animation;
    const id = addMotion(scene, shot.id, 'cap', 'move'); updateMotion(scene, shot.id, id, {amount: 0});
    expect(randomSetupMovement(scene, shot).cameraMustHold).toBe(false);
  });
  it('ignores disabled and zero-travel actions and camera-only movement', () => {
    const scene = withoutMechanism(), shot = scene.shots[0];
    const rotate = addMotion(scene, shot.id, '$product', 'rotate'); updateMotion(scene, shot.id, rotate, {enabled: false});
    addMotion(scene, shot.id, '$camera', 'orbit');
    const scale = addMotion(scene, shot.id, '$product', 'scale'); updateMotion(scene, shot.id, scale, {amount: 1});
    expect(randomSetupMovement(scene, shot).cameraMustHold).toBe(false);
  });
  it('ignores removed components and imported source descendants', () => {
    const scene = source(); scene.product.removedPartIds = ['cap'];
    expect(randomSetupMovement(scene, scene.shots[1]).cameraMustHold).toBe(false);
    const body = scene.product.components[0];
    body.sourceNodes = [{nodeIndex: 1, parentIndex: null, drawable: true}, {nodeIndex: 2, parentIndex: 1, drawable: true}];
    scene.product.removedPartIds.push(`${body.id}::node:1`);
    scene.animation = {tracks: [{...track('position.x', [0, .2, 0]), componentId: `${body.id}::node:2`}]};
    expect(randomSetupMovement(scene, scene.shots[0]).cameraMustHold).toBe(false);
  });
  it('reports different authored kinds while grouping XYZ channels of one operation', () => {
    const scene = withoutMechanism();
    scene.animation = {tracks: [track('position.x', [0, .1, .2]), track('position.y', [0, .2, .4]), track('scale', [1, 1.1, 1.2])]};
    expect(randomSetupMovement(scene, scene.shots[0])).toEqual({cameraMustHold: true, kinds: ['move', 'scale'], mixedAuthoredKinds: true});
  });
  it('detects a light sweep and ignores an orbit with zero horizontal radius', () => {
    const scene = withoutMechanism(), shot = scene.shots[0]; scene.lighting = defaultLighting(scene);
    addMotion(scene, shot.id, '$light:key', 'orbit');
    expect(randomSetupMovement(scene, shot).kinds).toEqual(['light']);
    scene.lighting.lights[0].positionM = [0, 1, 0]; scene.lighting.lights[0].targetM = [0, 0, 0];
    expect(randomSetupMovement(scene, shot).cameraMustHold).toBe(false);
    scene.lighting.lights[0].enabled = false;
    expect(randomSetupMovement(scene, shot).cameraMustHold).toBe(false);
  });
  it('reports simultaneous light operations even though they share a light label', () => {
    const scene = withoutMechanism(), shot = scene.shots[0]; scene.lighting = defaultLighting(scene);
    addMotion(scene, shot.id, '$light:key', 'move'); addMotion(scene, shot.id, '$light:key', 'aim');
    expect(randomSetupMovement(scene, shot)).toEqual({cameraMustHold: true, kinds: ['light'], mixedAuthoredKinds: true});
  });
  it('includes held-key discontinuities at shot boundaries but ignores held final poses', () => {
    const scene = withoutMechanism(); scene.animation = {tracks: [track('position.x', [0, 1], [1, 120])]};
    scene.animation.tracks[0].keys[0].interpolation = 'hold';
    expect(randomSetupMovement(scene, scene.shots[0]).cameraMustHold).toBe(true);
    expect(randomSetupMovement(scene, scene.shots[1]).cameraMustHold).toBe(false);
  });
});
