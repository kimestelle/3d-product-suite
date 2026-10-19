import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {commitHistory, createHistory, redoHistory, undoHistory} from './state';
import {addShot, checkActionCoverage, duplicateShot, moveShot, removeShot, setFrameRate, setOutputDimensions, setShotFrames, shotFrames} from './sequence';

const source = () => structuredClone(fixture) as any;
const ranges = (scene: any) => scene.shots.map((shot: any) => [shot.startFrame, shot.endFrame]);

describe('film sequence editing', () => {
  it('retimes a shot and moves every later boundary without changing cameras or actions', () => {
    const scene = source(); const actions = structuredClone(scene.actions); const cameras = scene.shots.map((shot: any) => structuredClone(shot.camera));
    setShotFrames(scene, scene.shots[0].id, 72);
    expect(ranges(scene)).toEqual([[1, 72], [73, 192], [193, 312]]);
    expect(scene.shots.map((shot: any) => shot.camera)).toEqual(cameras.map((camera: any, index: number) => index === 0 ? {...camera, durationFrames: 120} : camera));
    expect(scene.actions).toEqual(actions); expect(scene.render.fps).toBe(24);
  });

  it('rejects a shortening that cuts confirmed movement, atomically', () => {
    const scene = source(); setShotFrames(scene, scene.shots[1].id, 1);
    const before = structuredClone(scene);
    expect(() => setShotFrames(scene, scene.shots[0].id, 1)).toThrow('movement ends at 8.4 s');
    expect(scene).toEqual(before);
  });

  it('allows the exact final action sample and rejects one fewer frame', () => {
    const scene = source(); scene.actions[0].startSeconds = 1; scene.actions[0].durationSeconds = 1;
    expect(() => checkActionCoverage(scene, 49)).not.toThrow();
    expect(() => checkActionCoverage(scene, 48)).toThrow('at least 49 frames');
  });

  it('duplicates shot content under a unique ID and shifts the next shot', () => {
    const scene = source(); const original = structuredClone(scene.shots[0]);
    const id = duplicateShot(scene, original.id); const copy = scene.shots[1];
    expect(id).not.toBe(original.id); expect(copy.camera).toEqual(original.camera); expect(copy.name).toBe(`${original.name} copy`);
    expect(ranges(scene)).toEqual([[1, 120], [121, 240], [241, 360], [361, 480]]);
    const nextId = duplicateShot(scene, id); expect(nextId).not.toBe(id);
  });

  it('adds a stationary shot from the preceding endpoint without aliasing poses', () => {
    const scene = source(); const end = structuredClone(scene.shots[0].camera.to);
    const id = addShot(scene, scene.shots[0].id); const added = scene.shots.find((shot: any) => shot.id === id);
    expect(added.camera).toEqual({from: end, to: end}); expect(shotFrames(added)).toBe(72);
    added.camera.to.positionM[0] += 1;
    expect(added.camera.from.positionM).toEqual(end.positionM); expect(scene.shots[0].camera.to).toEqual(end);
  });

  it('moves a shot with its camera and duration, leaving global movement timing alone', () => {
    const scene = source(); const id = scene.shots[1].id; const camera = structuredClone(scene.shots[1].camera); const actions = structuredClone(scene.actions);
    setShotFrames(scene, id, 90); moveShot(scene, id, -1);
    expect(scene.shots[0].id).toBe(id); expect(scene.shots[0].camera).toEqual({...camera, durationFrames: 120});
    expect(ranges(scene)).toEqual([[1, 90], [91, 210], [211, 330]]); expect(scene.actions).toEqual(actions);
    const before = structuredClone(scene); moveShot(scene, id, -1); expect(scene).toEqual(before);
  });

  it('removes a shot when movement still fits and returns a surviving selection', () => {
    const scene = source(); const id = scene.shots[1].id; const next = scene.shots[2].id;
    expect(removeShot(scene, id)).toBe(next); expect(ranges(scene)).toEqual([[1, 120], [121, 240]]);
    const before = structuredClone(scene);
    expect(() => removeShot(scene, next)).toThrow('movement ends'); expect(scene).toEqual(before);
  });

  it('preserves at least one shot even with no actions', () => {
    const scene = source(); scene.actions = []; scene.shots = [scene.shots[0]];
    expect(() => removeShot(scene, scene.shots[0].id)).toThrow('at least one');
  });

  it('changes frame rate while preserving time, cameras, and confirmed action seconds', () => {
    const scene = source(); const before = structuredClone(scene);
    setFrameRate(scene, 30);
    expect(scene.render.fps).toBe(30); expect(ranges(scene)).toEqual([[1, 150], [151, 300], [301, 450]]);
    expect(scene.actions).toEqual(before.actions); expect(scene.shots.map((shot: any) => shot.camera)).toEqual(before.shots.map((shot: any) => shot.camera));
    setFrameRate(scene, 24); expect(scene).toEqual(before);
  });

  it('rounds cumulative boundaries instead of accumulating duration rounding errors', () => {
    const scene = source(); scene.actions = []; scene.shots.forEach((shot: any, index: number) => {shot.startFrame = index * 25 + 1; shot.endFrame = (index + 1) * 25;});
    setFrameRate(scene, 30);
    expect(ranges(scene)).toEqual([[1, 31], [32, 63], [64, 94]]);
  });

  it('rejects nonintegral frame counts and odd export sizes before committing', () => {
    const scene = source(); const before = structuredClone(scene);
    expect(() => setShotFrames(scene, scene.shots[0].id, 2.2)).toThrow('whole number');
    expect(() => setOutputDimensions(scene, 1081, 1920)).toThrow('even');
    expect(() => setOutputDimensions(scene, 9000, 1920)).toThrow('8192');
    expect(scene).toEqual(before);
    setOutputDimensions(scene, 1920, 1080); expect(scene.render.width).toBe(1920); expect(scene.render.height).toBe(1080);
  });

  it('persists edits through JSON revisions, undo, and redo without changing source geometry', () => {
    const scene = source(); let history = createHistory(scene); const next = structuredClone(scene);
    const id = duplicateShot(next, next.shots[0].id); moveShot(next, id, 1); setFrameRate(next, 30); setOutputDimensions(next, 1920, 1080);
    history = commitHistory(history, next);
    expect(JSON.parse(JSON.stringify(history.present))).toEqual(next);
    history = undoHistory(history); expect(history.present).toEqual(scene);
    history = redoHistory(history); expect(history.present).toEqual(next); expect(history.present.product).toEqual(scene.product);
  });
});

describe('sequence edits preserve authored keyframes', () => {
  const animated = (frames: number[], enabled = true) => {
    const scene = source();
    scene.animation = {tracks: [{id: 'cap-x', componentId: 'cap', property: 'position.x', enabled,
      keys: frames.map((frame, index) => ({frame, value: index * .01, interpolation: index % 2 ? 'hold' : 'ease'}))}]};
    return scene;
  };

  it('rejects a shot shortening that cuts a later key, including disabled tracks', () => {
    for (const enabled of [true, false]) {
      const scene = animated([1, 350], enabled);
      const before = structuredClone(scene);
      expect(() => setShotFrames(scene, scene.shots[0].id, 100)).toThrow('last key at frame 350');
      expect(scene).toEqual(before);
      setShotFrames(scene, scene.shots[0].id, 110);
      expect(scene.shots.at(-1).endFrame).toBe(350);
      expect(scene.animation).toEqual(before.animation);
    }
  });

  it('rejects removing a shot when keys would fall outside the reel without dropping any keys', () => {
    const scene = animated([1, 300], false);
    const before = structuredClone(scene);
    expect(() => removeShot(scene, scene.shots[1].id)).toThrow('Keep at least 300 frames');
    expect(scene).toEqual(before);
  });

  it('keeps continuous reel key times when cameras are reordered or shots are added', () => {
    const scene = animated([1, 120, 121, 360]);
    const animation = structuredClone(scene.animation);
    moveShot(scene, scene.shots[1].id, -1);
    expect(scene.animation).toEqual(animation);
    addShot(scene, scene.shots[0].id);
    duplicateShot(scene, scene.shots[0].id);
    expect(scene.animation).toEqual(animation);
  });

  it('retimes enabled and disabled keys from sample time while preserving their values and interpolation', () => {
    for (const enabled of [true, false]) {
      const scene = animated([1, 25, 49, 121], enabled);
      const before = structuredClone(scene);
      setFrameRate(scene, 30);
      expect(scene.animation.tracks[0].keys.map((key: any) => key.frame)).toEqual([1, 31, 61, 151]);
      expect(scene.animation.tracks[0].keys.map(({frame, ...key}: any) => key)).toEqual(before.animation.tracks[0].keys.map(({frame, ...key}: any) => key));
      expect(scene.animation.tracks[0].enabled).toBe(enabled);
      expect(scene.actions).toEqual(before.actions);
      setFrameRate(scene, 24);
      expect(scene).toEqual(before);
    }
  });

  it('keeps a rounded final endpoint within the shortened frame-rate grid', () => {
    const scene = animated([1, 360]);
    setFrameRate(scene, 12);
    expect(scene.shots.at(-1).endFrame).toBe(180);
    expect(scene.animation.tracks[0].keys.map((key: any) => key.frame)).toEqual([1, 180]);
  });

  it('rejects frame-rate collisions atomically, including final-endpoint clamping and disabled keys', () => {
    for (const frames of [[1, 2], [359, 360]]) {
      const scene = animated(frames, false);
      const before = structuredClone(scene);
      expect(() => setFrameRate(scene, 10)).toThrow('keys would overlap');
      expect(scene).toEqual(before);
    }
  });

  it('rejects a nonfinal key that no longer fits instead of silently clamping it', () => {
    const scene = animated([1, 351]);
    const before = structuredClone(scene);
    expect(() => setFrameRate(scene, 1)).toThrow('last key at frame 16');
    expect(scene).toEqual(before);
  });

  it('allows two different properties to share a retimed frame', () => {
    const scene = animated([1, 25]);
    scene.animation.tracks.push({...structuredClone(scene.animation.tracks[0]), id: 'cap-z', property: 'position.z'});
    setFrameRate(scene, 30);
    expect(scene.animation.tracks.map((track: any) => track.keys.map((key: any) => key.frame))).toEqual([[1, 31], [1, 31]]);
  });
});
