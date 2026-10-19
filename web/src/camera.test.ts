import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {cameraTarget, editCamera, validateCamera} from './camera';

const source = () => structuredClone(fixture) as any;

describe('camera controls', () => {
  it('edits only the selected shot and survives JSON persistence', () => {
    const scene = source(); const baseline = structuredClone(scene);
    editCamera(scene, scene.shots[1].id, camera => {camera.from.focalLengthMm = 85; camera.to.focalLengthMm = 50;});
    expect(scene.shots[0]).toEqual(baseline.shots[0]); expect(scene.shots[2]).toEqual(baseline.shots[2]);
    expect(JSON.parse(JSON.stringify(scene)).shots[1].camera.from.focalLengthMm).toBe(85);
  });

  it('rejects endpoints crossing a vertical target even when each endpoint is valid', () => {
    const camera = {from: {positionM: [1, 1, 0], targetM: [0, 0, 0], focalLengthMm: 50}, to: {positionM: [-1, 1, 0], targetM: [0, 0, 0], focalLengthMm: 50}};
    expect(() => validateCamera(camera)).toThrow('through its target');
    camera.to.positionM[2] = 1; expect(() => validateCamera(camera)).not.toThrow();
  });

  it('preserves the old camera when an edit is invalid', () => {
    const scene = source(); const baseline = structuredClone(scene);
    expect(() => editCamera(scene, scene.shots[0].id, camera => {camera.from.positionM = [...camera.from.targetM];})).toThrow('viewing direction');
    expect(scene).toEqual(baseline);
    expect(() => editCamera(scene, scene.shots[0].id, camera => {camera.from.focalLengthMm = NaN;})).toThrow('finite');
    expect(scene).toEqual(baseline);
  });

  it('uses the shared evaluated pose for a moving part target rather than its source assembly', () => {
    const scene = source(); const sample = {components: {cap: {translationM: [.2, .4, .1], rotationXyzw: [0, 0, 0, 1]}}};
    expect(cameraTarget(scene, sample, 'cap')).toEqual([.2, .4, .1]);
    expect(() => cameraTarget(scene, undefined, 'cap')).toThrow('Wait');
    expect(() => cameraTarget(scene, sample, 'missing')).toThrow('no longer');
  });

  it('finds the whole-product bounds from evaluated translated and rotated component sizes', () => {
    const scene = source(); scene.product.components = [{id: 'a', sizeM: [2, 4, 2]}, {id: 'b', sizeM: [2, 2, 2]}];
    const sample = {components: {a: {translationM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1]}, b: {translationM: [4, 0, 0], rotationXyzw: [0, 0, 0, 1]}}};
    expect(cameraTarget(scene, sample)).toEqual([2, 0, 0]);
  });
});


describe('optical camera settings', () => {
  it('persists per-shot optics without changing the other shot or endpoints', () => {
    const scene = source(), before = structuredClone(scene);
    editCamera(scene, scene.shots[0].id, camera => { camera.depthOfField = {enabled: true, fStop: 1.4, focusDistanceM: .5}; });
    expect(scene.shots[0].camera.from).toEqual(before.shots[0].camera.from);
    expect(scene.shots[1]).toEqual(before.shots[1]);
    expect(JSON.parse(JSON.stringify(scene)).shots[0].camera.depthOfField).toEqual({enabled: true, fStop: 1.4, focusDistanceM: .5});
    editCamera(scene, scene.shots[0].id, camera => { camera.from.focalLengthMm = 85; });
    expect(scene.shots[0].camera.depthOfField).toEqual({enabled: true, fStop: 1.4, focusDistanceM: .5});
  });

  it('rejects malformed optics without storing a broken camera', () => {
    const scene = source(), before = structuredClone(scene);
    for (const optics of [null, {}, {enabled: 1, fStop: 2.8}, {enabled: true, fStop: NaN},
      {enabled: false, fStop: .69}, {enabled: false, fStop: 33}, {enabled: false, fStop: 2.8, focusDistanceM: 0},
      {enabled: false, fStop: 2.8, focusDistanceM: Infinity}, {enabled: false, fStop: 2.8, focusDistanceM: 1001}]) {
      expect(() => editCamera(scene, scene.shots[0].id, camera => { camera.depthOfField = optics as any; })).toThrow();
      expect(scene).toEqual(before);
    }
  });

  it('requires a manual focus plane beyond the focal length at both endpoints', () => {
    const scene = source();
    expect(() => editCamera(scene, scene.shots[0].id, camera => {
      camera.from.focalLengthMm = 50; camera.to.focalLengthMm = 85;
      camera.depthOfField = {enabled: true, fStop: 2.8, focusDistanceM: .075};
    })).toThrow('beyond the focal length');
  });

  it('rejects an auto-focus path whose interior crosses the optical near limit', () => {
    const scene = source();
    expect(() => editCamera(scene, scene.shots[0].id, camera => {
      camera.from = {positionM: [.1, 0, .02], targetM: [0, 0, 0], focalLengthMm: 50};
      camera.to = {positionM: [-.1, 0, .02], targetM: [0, 0, 0], focalLengthMm: 50};
      camera.depthOfField = {enabled: true, fStop: 2.8};
    })).toThrow('Focus target must stay beyond');
  });
});


describe('camera edits with bounded motion', () => {
  function dollyScene(scope: 'shot' | 'film' = 'shot') {
    const scene = source(), shot = scene.shots[0];
    shot.camera = {from: {positionM: [1, 0, 0], targetM: [0, 0, 0], focalLengthMm: 50},
      to: {positionM: [1, 0, 0], targetM: [0, 0, 0], focalLengthMm: 50}};
    const motion = {id: 'dolly', target: '$camera', kind: 'dolly', axis: 'y', amount: .9,
      startFrame: 1, durationFrames: 25, easing: 'ease', enabled: true};
    if (scope === 'shot') shot.motions = [motion];
    else {
      // Across-cut motion is evaluated against every shot's framing.
      for (const item of scene.shots) item.camera = structuredClone(shot.camera);
      scene.motions = [motion];
    }
    return scene;
  }

  it('rejects enabling auto focus when a dolly would cross the focal plane, atomically', () => {
    const scene = dollyScene(), shot = scene.shots[0];
    shot.camera.from.focalLengthMm = shot.camera.to.focalLengthMm = 150;
    const before = structuredClone(scene);
    expect(() => editCamera(scene, shot.id, camera => {camera.depthOfField = {enabled: true, fStop: 2.8};})).toThrow('stop before');
    expect(scene).toEqual(before);
  });

  it('rejects increasing focal length beyond the nearest dolly sample, atomically', () => {
    const scene = dollyScene(), shot = scene.shots[0];
    shot.camera.depthOfField = {enabled: true, fStop: 2.8};
    const before = structuredClone(scene);
    expect(() => editCamera(scene, shot.id, camera => {camera.to.focalLengthMm = 150;})).toThrow('stop before');
    expect(scene).toEqual(before);
    editCamera(scene, shot.id, camera => {camera.to.focalLengthMm = 85;});
    expect(scene.shots[0].camera.to.focalLengthMm).toBe(85);
  });

  it('checks across-cut dolly ownership and permits safe manual focus', () => {
    const scene = dollyScene('film'), shot = scene.shots[0];
    const before = structuredClone(scene);
    expect(() => editCamera(scene, shot.id, camera => {camera.from.positionM = [.5, 0, 0];})).toThrow('stop before');
    expect(scene).toEqual(before);
    editCamera(scene, shot.id, camera => {
      camera.from.focalLengthMm = 150;
      camera.depthOfField = {enabled: true, fStop: 2.8, focusDistanceM: .2};
    });
    expect(scene.shots[0].camera.depthOfField.focusDistanceM).toBe(.2);
  });
});


describe('camera target bounds with evaluated scale', () => {
  it('uses component scale for whole-product bounds and retains each individual center', () => {
    const scene = source();
    scene.product.components = [{id: 'a', sizeM: [2, 2, 2]}, {id: 'b', sizeM: [2, 2, 2]}];
    const sample = {components: {
      a: {translationM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: 10},
      b: {translationM: [4, 0, 0], rotationXyzw: [0, 0, 0, 1], scale: 1},
    }};
    expect(cameraTarget(scene, sample)).toEqual([0, 0, 0]);
    expect(cameraTarget(scene, sample, 'a')).toEqual([0, 0, 0]);
    expect(cameraTarget(scene, sample, 'b')).toEqual([4, 0, 0]);
  });
});
