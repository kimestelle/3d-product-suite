import {describe, expect, it} from 'vitest';
import {addMotion, changeMotionScope, setMotionKeys, updateMotion} from './filmMotion';
import fixture from '../../examples/bottle.scene.json';
import {commitHistory, createHistory, redoHistory, undoHistory} from './state';
import {addImageShot, addShot, checkActionCoverage, duplicateShot, exactShotAtFrame, moveShot, removeShot, reorderShot, sequenceEnd, setFrameRate, setOutputDimensions, setSequenceFrames, setShotFrames, closeSequenceGaps, shotAtFrame, shotFrames, type ImageShotAsset} from './sequence';

const source = () => structuredClone(fixture) as any;
const ranges = (scene: any) => scene.shots.map((shot: any) => [shot.startFrame, shot.endFrame]);
const imageAsset: ImageShotAsset = {path: 'assets/images/product.png', sha256: 'a'.repeat(64), format: 'png', width: 1600, height: 1200};

describe('continuous movies and still images', () => {
  it('opens an empty legacy movie without shortening its saved time or motion', () => {
    const scene = source(); scene.shots = []; scene.render.durationFrames = 360;
    const before = structuredClone(scene);
    expect(closeSequenceGaps(scene)).toBe(false);
    expect(scene).toEqual(before);
    const id = addShot(scene);
    expect(scene.shots).toHaveLength(1);
    expect(scene.shots[0]).toMatchObject({id, startFrame: 1, endFrame: 360});
    expect(scene.shots[0].camera.from).toEqual(scene.shots[0].camera.to);
    expect(scene.shots[0].camera.from).toEqual({positionM: [0, .2, 1], targetM: [0, .1, 0], focalLengthMm: 50});
    expect(scene.actions).toEqual(before.actions);
  });

  it('inserts an image as the first clip and preserves a legacy movie duration', () => {
    const scene = source(); scene.shots = []; scene.render.durationFrames = 360;
    const id = addImageShot(scene, imageAsset, 'First image');
    expect(scene.shots[0]).toMatchObject({id, kind: 'image', startFrame: 1, endFrame: 360,
      image: {asset: imageAsset, fit: 'contain'}});
    expect(sequenceEnd(scene)).toBe(360);
  });

  it('edits empty movie duration while retaining and retiming existing animation', () => {
    const scene = source(); scene.shots = []; scene.render.durationFrames = 360;
    scene.animation = {tracks: [{componentId: 'cap', property: 'position.x', enabled: false,
      keys: [{frame: 1, value: 0}, {frame: 360, value: 1}]}]};
    const before = structuredClone(scene);
    setSequenceFrames(scene, 720);
    expect(scene.shots).toEqual([]); expect(sequenceEnd(scene)).toBe(720);
    expect(scene.animation.tracks[0].keys[1].frame).toBe(720);
    expect(scene.actions[0].durationSeconds).toBeCloseTo(before.actions[0].durationSeconds * 719 / 359);
    const stretched = structuredClone(scene);
    expect(() => setSequenceFrames(scene, 1)).toThrow('at least two frames');
    expect(scene).toEqual(stretched);
  });

  it('stretches every shot to fill the chosen movie duration without gaps', () => {
    const scene = source(); setSequenceFrames(scene, 720);
    expect(ranges(scene)).toEqual([[1, 240], [241, 480], [481, 720]]);
    expect(sequenceEnd(scene)).toBe(720);
    for (let frame = 1; frame <= 720; frame++) expect(exactShotAtFrame(scene, frame)).toBeDefined();
    setSequenceFrames(scene, 360); expect(ranges(scene)).toEqual([[1, 120], [121, 240], [241, 360]]);
  });

  it('retimes global actions and keys with the movie, preserving their values', () => {
    const scene = source(), before = structuredClone(scene);
    scene.animation = {tracks: [{componentId: 'cap', property: 'position.x', enabled: false,
      keys: [{frame: 1, value: 0}, {frame: 360, value: 1}]}]};
    setSequenceFrames(scene, 720);
    expect(scene.animation.tracks[0].keys).toEqual([{frame: 1, value: 0}, {frame: 720, value: 1}]);
    expect(scene.actions[0].durationSeconds).toBeCloseTo(before.actions[0].durationSeconds * 719 / 359);
    expect(scene.actions[0].componentId).toBe(before.actions[0].componentId);
  });

  it('keeps shared motion and keys on the final sample when half frames round', () => {
    const scene = source(); scene.actions = []; scene.shots = [scene.shots[0]]; scene.shots[0].endFrame = 359;
    const id = addMotion(scene, scene.shots[0].id, '$product', 'move');
    updateMotion(scene, scene.shots[0].id, id, {startFrame: 2, durationFrames: 358});
    setMotionKeys(scene, scene.shots[0].id, id, [{frame: 1, value: 0, interpolation: 'ease'}, {frame: 358, value: 1, interpolation: 'ease'}]);
    changeMotionScope(scene, scene.shots[0].id, id, 'film');
    setSequenceFrames(scene, 180);
    expect(scene.motions[0]).toMatchObject({startFrame: 2, durationFrames: 179});
    expect(scene.motions[0].keys.map((key: any) => key.frame)).toEqual([1, 179]);
    expect(scene.motions[0].startFrame + scene.motions[0].durationFrames - 1).toBe(180);
  });

  it('keeps exact final mechanical samples inside the new movie despite floating point rounding', () => {
    for (const frames of [24, 99, 480, 1000]) {
      const scene = source(); scene.actions[0].startSeconds = 0; scene.actions[0].durationSeconds = 359 / 24;
      setSequenceFrames(scene, frames);
      const action = scene.actions[0];
      expect(action.startSeconds + action.durationSeconds).toBeLessThanOrEqual((frames - 1) / 24);
      expect(action.durationSeconds).toBeCloseTo((frames - 1) / 24, 10);
    }
  });

  it('stretches local motion keys and camera source timing with the owning scene', () => {
    const scene = source(), shot = scene.shots[0];
    shot.camera.durationFrames = 120;
    const id = addMotion(scene, shot.id, '$product', 'rotate');
    updateMotion(scene, shot.id, id, {durationFrames: 120});
    setMotionKeys(scene, shot.id, id, [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 120, value: 1, interpolation: 'ease'}]);
    setSequenceFrames(scene, 720);
    expect(scene.shots[0].camera.durationFrames).toBe(240);
    expect(scene.shots[0].motions[0].keys.map((key: any) => key.frame)).toEqual([1, 240]);
    expect(scene.shots[0].motions[0].durationFrames).toBe(240);
  });

  it('resolves a requested compact duration after a legacy gap edit has been undone', () => {
    const scene = source(); scene.actions = []; scene.render.durationFrames = 480;
    setSequenceFrames(scene, 360);
    expect(sequenceEnd(scene)).toBe(360); expect(scene.render.durationFrames).toBe(360);
  });

  it('rejects invalid lengths and key collisions atomically', () => {
    const scene = source(), before = structuredClone(scene);
    for (const frames of [0, -10, 10.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => setSequenceFrames(scene, frames)).toThrow('whole number');
    expect(() => setSequenceFrames(scene, 2)).toThrow('one frame for every scene');
    expect(scene).toEqual(before);
    scene.animation = {tracks: [{keys: [{frame: 1}, {frame: 2}]}]};
    const animated = structuredClone(scene);
    expect(() => setSequenceFrames(scene, 180)).toThrow('keys would overlap'); expect(scene).toEqual(animated);
  });

  it('closes old head, interior and tail gaps as an undoable edit', () => {
    const scene = source(); scene.actions = [];
    scene.shots[0].startFrame = 25; scene.shots[0].endFrame = 96;
    scene.render.durationFrames = 480;
    const original = structuredClone(scene); let history = createHistory(scene);
    const draft = structuredClone(scene); expect(closeSequenceGaps(draft)).toBe(true);
    expect(ranges(draft)).toEqual([[1, 72], [73, 192], [193, 312]]); expect(sequenceEnd(draft)).toBe(312);
    history = commitHistory(history, draft); expect(undoHistory(history).present).toEqual(original);
    expect(closeSequenceGaps(draft)).toBe(false);
  });

  it('orders imported clips before packing them', () => {
    const scene = source(); scene.shots.reverse();
    expect(closeSequenceGaps(scene)).toBe(true);
    expect(ranges(scene)).toEqual([[1, 120], [121, 240], [241, 360]]);
  });

  it('ripples following shots when a clip is trimmed, expanded or reordered', () => {
    const scene = source(); setShotFrames(scene, scene.shots[0].id, 48);
    expect(ranges(scene)).toEqual([[1, 48], [49, 168], [169, 288]]);
    const before = structuredClone(scene), id = scene.shots[0].id;
    moveShot(scene, id, 1); expect(ranges(scene)).toEqual([[1, 120], [121, 168], [169, 288]]);
    moveShot(scene, id, -1); expect(scene).toEqual(before);
    setShotFrames(scene, id, 144); expect(ranges(scene)).toEqual([[1, 144], [145, 264], [265, 384]]);
  });

  it('inserts still images at cuts and shifts subsequent clips', () => {
    const scene = source();
    const id = addImageShot(scene, imageAsset, '  Product detail  ', scene.shots[0].id, 48), shot = scene.shots.find((item: any) => item.id === id);
    expect(ranges(scene)).toEqual([[1, 120], [121, 168], [169, 288], [289, 408]]);
    expect(shot).toMatchObject({kind: 'image', name: 'Product detail', image: {asset: imageAsset, fit: 'contain'}});
    shot.image.asset.path = 'changed.png'; expect(imageAsset.path).toBe('assets/images/product.png');
  });

  it('appends images by default and duplicates independent fitting controls', () => {
    const scene = source(), id = addImageShot(scene, imageAsset, 'Image');
    expect(scene.shots.at(-1)).toMatchObject({startFrame: 361, endFrame: 432});
    const copyId = duplicateShot(scene, id), original = scene.shots.find((item: any) => item.id === id), copy = scene.shots.find((item: any) => item.id === copyId);
    expect(copy).toMatchObject({kind: 'image', startFrame: 433, endFrame: 504, image: original.image});
    copy.image.fit = 'cover'; expect(original.image.fit).toBe('contain');
  });

  it('rejects invalid image inserts without changing the timeline', () => {
    const scene = source(), before = structuredClone(scene);
    expect(() => addImageShot(scene, imageAsset, 'Image', 'missing')).toThrow('no longer');
    expect(() => addImageShot(scene, {...imageAsset, sha256: ''}, 'Image')).toThrow('fingerprint');
    expect(() => addImageShot(scene, {...imageAsset, width: 0}, 'Image')).toThrow('Image width');
    expect(() => addImageShot(scene, {...imageAsset, format: 'gif' as any}, 'Image')).toThrow('PNG, JPEG or WebP');
    expect(scene).toEqual(before);
  });

  it('retains images and continuous boundaries through frame-rate conversion', () => {
    const scene = source(); scene.actions = [];
    addImageShot(scene, imageAsset, 'Image', scene.shots[0].id, 48);
    const before = structuredClone(scene); setFrameRate(scene, 30);
    expect(ranges(scene)).toEqual([[1, 150], [151, 210], [211, 360], [361, 510]]);
    setFrameRate(scene, 24); expect(scene).toEqual(before);
  });

  it('rejects a frame-rate change that erases a clip', () => {
    const scene = source(); scene.actions = []; setShotFrames(scene, scene.shots[0].id, 1);
    const before = structuredClone(scene);
    expect(() => setFrameRate(scene, 1)).toThrow('would collapse'); expect(scene).toEqual(before);
  });
});

describe('film sequence editing', () => {
  it('trims a shot and closes the cut while preserving source camera and global timing', () => {
    const scene = source(); const actions = structuredClone(scene.actions); const cameras = scene.shots.map((shot: any) => structuredClone(shot.camera));
    setShotFrames(scene, scene.shots[0].id, 72);
    expect(ranges(scene)).toEqual([[1, 72], [73, 192], [193, 312]]);
    expect(scene.shots.map((shot: any) => shot.camera)).toEqual(cameras.map((camera: any, index: number) => index === 0 ? {...camera, durationFrames: 120} : camera));
    expect(scene.actions).toEqual(actions); expect(scene.render.fps).toBe(24);
  });

  it('rejects a ripple deletion that would cut confirmed across-cuts movement', () => {
    const scene = source(); removeShot(scene, scene.shots[2].id);
    const before = structuredClone(scene);
    expect(() => removeShot(scene, scene.shots[1].id)).toThrow('movement ends at 8.4 s');
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

  it('removes shots and closes the cut instead of leaving black time', () => {
    const scene = source(); scene.actions = [];
    const id = scene.shots[1].id, next = scene.shots[2].id;
    expect(removeShot(scene, id)).toBe(next); expect(ranges(scene)).toEqual([[1, 120], [121, 240]]);
    removeShot(scene, next); expect(ranges(scene)).toEqual([[1, 120]]); expect(sequenceEnd(scene)).toBe(120);
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

describe('scene reordering', () => {
  it('moves a scene directly to either end, preserving its camera, duration and local motion', () => {
    const scene = source(); scene.render.durationFrames = 360;
    const id = scene.shots[0].id;
    setShotFrames(scene, id, 72);
    const motionId = addMotion(scene, id, '$product', 'rotate');
    setMotionKeys(scene, id, motionId, [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 49, value: 1, interpolation: 'ease'}]);
    const before = structuredClone(scene), originalShots = scene.shots;

    expect(reorderShot(scene, id, 2)).toBe(true);
    expect(scene.shots.map((shot: any) => shot.id)).toEqual([before.shots[1].id, before.shots[2].id, id]);
    expect(ranges(scene)).toEqual([[1, 120], [121, 240], [241, 312]]);
    expect(scene.shots[2]).toEqual({...before.shots[0], startFrame: 241, endFrame: 312});
    expect(scene.render.durationFrames).toBe(312);
    expect(originalShots).toEqual(before.shots);

    expect(reorderShot(scene, id, 0)).toBe(true);
    expect(scene).toEqual(before);
  });

  it('moves image holds intact between scenes and keeps global content at its authored times', () => {
    const scene = source(), imageId = addImageShot(scene, imageAsset, 'Product detail', scene.shots[0].id, 48);
    const motionId = addMotion(scene, scene.shots[0].id, '$product', 'move');
    changeMotionScope(scene, scene.shots[0].id, motionId, 'film');
    scene.animation = {tracks: [{id: 'cap-x', componentId: 'cap', property: 'position.x', enabled: true,
      keys: [{frame: 1, value: 0}, {frame: 408, value: .1}]}]};
    const before = structuredClone(scene);

    expect(reorderShot(scene, imageId, 3)).toBe(true);
    expect(scene.shots.at(-1)).toEqual({...before.shots[1], startFrame: 361, endFrame: 408});
    expect(ranges(scene)).toEqual([[1, 120], [121, 240], [241, 360], [361, 408]]);
    expect(sequenceEnd(scene)).toBe(sequenceEnd(before));
    const {shots: oldShots, ...oldGlobal} = before, {shots: newShots, ...newGlobal} = scene;
    expect(newGlobal).toEqual(oldGlobal);
    expect(newShots.map((shot: any) => ({...shot, startFrame: 0, endFrame: shotFrames(shot)})).sort((a: any, b: any) => a.id.localeCompare(b.id)))
      .toEqual(oldShots.map((shot: any) => ({...shot, startFrame: 0, endFrame: shotFrames(shot)})).sort((a: any, b: any) => a.id.localeCompare(b.id)));
  });

  it('does not replace state or add history when dropped back in the same position', () => {
    const scene = source(), before = structuredClone(scene), shots = scene.shots, render = scene.render;
    expect(reorderShot(scene, scene.shots[1].id, 1)).toBe(false);
    expect(scene).toEqual(before); expect(scene.shots).toBe(shots); expect(scene.render).toBe(render);
  });

  it('rejects stale IDs and invalid target positions without mutation', () => {
    const scene = source(), before = structuredClone(scene), shots = scene.shots;
    expect(() => reorderShot(scene, 'missing', 0)).toThrow('no longer');
    for (const index of [-1, 3, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => reorderShot(scene, scene.shots[0].id, index)).toThrow('position within the film');
    }
    expect(scene).toEqual(before); expect(scene.shots).toBe(shots);
  });

  it('validates all moved content before committing and remains undoable as one edit', () => {
    const invalid = source(); invalid.shots[2].kind = 'image';
    const beforeInvalid = structuredClone(invalid), originalShots = invalid.shots;
    expect(() => reorderShot(invalid, invalid.shots[0].id, 2)).toThrow('contain or cover');
    expect(invalid).toEqual(beforeInvalid); expect(invalid.shots).toBe(originalShots);

    const scene = source(), draft = structuredClone(scene); let history = createHistory(scene);
    reorderShot(draft, draft.shots[0].id, 2); history = commitHistory(history, draft);
    history = undoHistory(history); expect(history.present).toEqual(scene);
    history = redoHistory(history); expect(history.present).toEqual(draft);
  });
});

describe('sequence edits preserve authored keyframes', () => {
  const animated = (frames: number[], enabled = true) => {
    const scene = source();
    scene.animation = {tracks: [{id: 'cap-x', componentId: 'cap', property: 'position.x', enabled,
      keys: frames.map((frame, index) => ({frame, value: index * .01, interpolation: index % 2 ? 'hold' : 'ease'}))}]};
    return scene;
  };

  it('protects later keys from trims and deletions, including disabled tracks', () => {
    for (const enabled of [true, false]) {
      const scene = animated([1, 350], enabled), before = structuredClone(scene);
      expect(() => setShotFrames(scene, scene.shots[2].id, 60)).toThrow('last key at frame 350');
      expect(() => removeShot(scene, scene.shots[2].id)).toThrow('last key at frame 350');
      expect(scene).toEqual(before);
      setSequenceFrames(scene, 300);
      expect(sequenceEnd(scene)).toBe(300); expect(scene.animation.tracks[0].keys.at(-1).frame).toBe(292);
    }
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
