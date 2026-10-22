import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {cameraMotionOwnsPose} from './useFilmCamera';

describe('camera motion pose ownership', () => {
  it('keeps legacy endpoint cameras editable', () => {
    expect(cameraMotionOwnsPose(fixture, fixture.shots[0])).toBe(false);
    expect(cameraMotionOwnsPose(null, null)).toBe(false);
  });
  it('owns the spatial pose for local and across-cut camera actions, including held endpoints', () => {
    const motion = {id: 'orbit-1', target: '$camera', kind: 'orbit', enabled: true, startFrame: 20, durationFrames: 10};
    expect(cameraMotionOwnsPose(fixture, {...fixture.shots[0], motions: [motion]})).toBe(true);
    expect(cameraMotionOwnsPose({...fixture, motions: [motion]}, fixture.shots[0])).toBe(true);
  });
  it('allows base framing for a local Still override without exposing the inherited move', () => {
    const shared = {id: 'shared', target: '$camera', kind: 'orbit', amount: 40, enabled: true};
    const hold = {id: 'hold', target: '$camera', kind: 'orbit', amount: 0, enabled: true};
    const scene = {...fixture, motions: [shared]};
    expect(cameraMotionOwnsPose(scene, {...fixture.shots[0], motions: [hold]})).toBe(false);
    expect(cameraMotionOwnsPose(scene, fixture.shots[1])).toBe(true);
  });
  it('ignores disabled camera actions and movements belonging to other objects or shots', () => {
    const disabled = {id: 'orbit-1', target: '$camera', kind: 'orbit', enabled: false};
    const product = {id: 'move-1', target: '$product', kind: 'move', enabled: true};
    expect(cameraMotionOwnsPose({...fixture, motions: [disabled, product]}, fixture.shots[0])).toBe(false);
    expect(cameraMotionOwnsPose({...fixture, shots: [{...fixture.shots[0], motions: [{...disabled, enabled: true}]}, fixture.shots[1]]}, fixture.shots[1])).toBe(false);
  });
});
