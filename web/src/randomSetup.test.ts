import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import glassFixture from '../../examples/glass.scene.json';
import {addMotion, filmCameraPoseAtFrame, updateMotion, validateFilmMotions} from './filmMotion';
import {addImageShot, sequenceEnd} from './sequence';
import {colorFromHex, colorHex, defaultLighting} from './world';
import {RANDOM_SETUP_PALETTES, defaultRandomSetupSettings, generateRandomSetup, type RandomSetupSettings} from './randomSetup';
import {productBounds, projectedProductBounds} from './randomSetupFraming';
import {randomSetupMovement} from './randomSetupMovement';

const source = (): any => structuredClone(fixture);
const settingsFor = (scene: any, categories: (keyof RandomSetupSettings['policies'])[] = []): RandomSetupSettings => {
  const settings = defaultRandomSetupSettings(scene);
  for (const category of Object.keys(settings.policies) as (keyof RandomSetupSettings['policies'])[]) settings.policies[category] = categories.includes(category) ? 'random' : 'keep';
  return settings;
};
const fillSettingsFor = (scene: any): RandomSetupSettings => {
  const settings = defaultRandomSetupSettings(scene);
  for (const category of Object.keys(settings.policies) as (keyof RandomSetupSettings['policies'])[]) settings.policies[category] = 'fill';
  return settings;
};
const validateWithExporter = (scene: any) => {
  execFileSync('python3', ['-c', 'import json,sys; from film.scene import validate_scene; validate_scene(json.load(sys.stdin))'], {
    input: JSON.stringify(scene), cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8',
  });
};
const imageAsset = {path: `assets/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64), format: 'png' as const, width: 1280, height: 720};

describe('non-destructive random export setups', () => {
  it('treats a complete composition and its implicit default rig as decided', () => {
    const original = source(), before = structuredClone(original);
    const result = generateRandomSetup(original, fillSettingsFor(original), 21);
    expect(result.scene).toEqual(before); expect(result.scene).not.toBe(original);
    expect(result.changes).toEqual([]); expect(original).toEqual(before);
    expect(result.scene.lighting).toBeUndefined();
  });

  it('defaults to everything with all eligible objects and palettes while preserving the source', () => {
    const original = source(); original.product.removedPartIds = ['neck'];
    const before = structuredClone(original), settings = defaultRandomSetupSettings(original);
    expect(Object.values(settings.policies)).toEqual(Array(6).fill('random'));
    expect(settings.materialPartIds).toEqual(original.product.components.filter((part: any) => part.id !== 'neck').map((part: any) => part.id));
    expect(settings.paletteIds).toEqual(RANDOM_SETUP_PALETTES.map(palette => palette.id));
    expect(settings.durationSeconds).toBe(sequenceEnd(original) / original.render.fps);
    expect(settings.shotCount).toBe(original.shots.length); expect(settings.aspect).toBe('keep');
    const result = generateRandomSetup(original, settings, 21);
    expect(result.scene).not.toEqual(before); expect(original).toEqual(before);
    expect(result.scene.product.components.find((part: any) => part.id === 'neck')).toEqual(original.product.components[1]);
    expect(result.scene.product.label).toEqual(original.product.label);
    validateWithExporter(result.scene);
  });

  it('uses a selected palette in linear RGB without altering retained materials or room assets', () => {
    const original = source(), before = structuredClone(original), settings = settingsFor(original, ['colors']);
    settings.paletteIds = ['clay'];
    const result = generateRandomSetup(original, settings, 42);
    const palette = RANDOM_SETUP_PALETTES.find(item => item.id === 'clay')!;
    const chosen = colorHex(result.scene.environment.worldColor).toUpperCase();
    expect(palette.colors).toContain(chosen);
    expect(result.scene.environment.worldColor).toEqual(colorFromHex(chosen));
    expect(result.changes).toEqual([`Colors: Clay · background ${chosen}`]);
    expect(result.scene.product).toEqual(before.product);
    expect(result.scene.shots).toEqual(before.shots);
    expect(result.scene.environment.plinth).toEqual(before.environment.plinth);
    expect(result.scene.environment.props).toEqual(before.environment.props);
    expect(original).toEqual(before);
    validateWithExporter(result.scene);
  });

  it('colors only freshly randomized finishes and keeps palette selection independent of other scopes', () => {
    const original = source(), settings = settingsFor(original, ['materials','colors']);
    settings.materialPartIds = ['cap']; settings.materialTypes = ['metal']; settings.paletteIds = ['coastal'];
    const result = generateRandomSetup(original, settings, 512);
    const palette = RANDOM_SETUP_PALETTES.find(item => item.id === 'coastal')!;
    const material = result.scene.product.components.find((part: any) => part.id === 'cap').material;
    const materialHex = colorHex(material.baseColor).toUpperCase();
    expect(palette.colors).toContain(materialHex); expect(material.metallic).toBe(1);
    expect(materialHex).not.toBe(colorHex(result.scene.environment.worldColor).toUpperCase());
    for (const part of original.product.components.filter((part: any) => part.id !== 'cap')) expect(result.scene.product.components.find((item: any) => item.id === part.id)).toEqual(part);
    const all = {...settings, policies: {...settings.policies, lighting: 'random' as const, stage: 'random' as const, framing: 'random' as const}};
    const other = generateRandomSetup(original, all, 512);
    expect(other.scene.environment.worldColor).toEqual(result.scene.environment.worldColor);
    expect(other.scene.product.components).toEqual(result.scene.product.components);
    validateWithExporter(result.scene);
  });

  it('replays palettes independent of checkbox ordering and rejects invalid pools without changing the source', () => {
    const original = source(), before = structuredClone(original), settings = defaultRandomSetupSettings(original);
    const result = generateRandomSetup(original, settings, 123), reversed = structuredClone(settings);
    reversed.paletteIds.reverse(); reversed.materialPartIds.reverse();
    expect(generateRandomSetup(original, reversed, 123)).toEqual(result);
    settings.paletteIds = [];
    expect(() => generateRandomSetup(original, settings, 123)).toThrow('at least one color palette');
    settings.paletteIds = ['missing'];
    expect(() => generateRandomSetup(original, settings, 123)).toThrow('no longer available');
    settings.paletteIds = ['neutral']; settings.materialPartIds = ['neck']; original.product.removedPartIds = ['neck'];
    expect(() => generateRandomSetup(original, settings, 123)).toThrow('no longer in the product');
    delete original.product.removedPartIds;
    expect(original).toEqual(before);
  });

  it('replays a seed exactly and keeps category choices independent', () => {
    const original = source(), all = settingsFor(original, ['stage', 'lighting', 'framing', 'motion']);
    const result = generateRandomSetup(original, all, 123);
    expect(generateRandomSetup(original, all, 123)).toEqual(result);
    const withoutLighting = structuredClone(all); withoutLighting.policies.lighting = 'keep';
    const second = generateRandomSetup(original, withoutLighting, 123);
    expect(second.scene.environment).toEqual(result.scene.environment);
    expect(second.scene.shots).toEqual(result.scene.shots);
    const reversed = structuredClone(all); reversed.stageIds.reverse(); reversed.cameraViews.reverse();
    expect(generateRandomSetup(original, reversed, 123)).toEqual(result);
    expect(generateRandomSetup(original, all, 124).scene).not.toEqual(result.scene);
  });

  it('preserves product geometry, source units, labels and approved mechanisms across random stage/camera changes', () => {
    const original = source(), before = structuredClone(original);
    original.placement.scale = .25;
    original.product.decals = [{id: 'artwork-preserved'}];
    const settings = settingsFor(original, ['stage', 'framing', 'motion']);
    const result = generateRandomSetup(original, settings, 6);
    expect(result.scene.product).toEqual(original.product);
    expect(result.scene.coordinates).toEqual(original.coordinates);
    expect(result.scene.actions).toEqual(original.actions);
    expect(result.scene.placement).toEqual(original.placement);
    expect(result.scene.environment.plinth).toEqual(before.environment.plinth);
    expect(original.product.components).toEqual(before.product.components);
  });

  it('uses only chosen stage assets and clears obsolete comparison approval in the candidate', () => {
    const original = source();
    original.environment.props = [{id: 'existing-prop'}]; original.environment.studioSizeM = .4;
    original.comparison = {schemaVersion: 1, alternative: {revisionId: 'paired'}, reviewedAlignmentDigest: 'previous'};
    const world = {id: 'library-one', name: 'Saved room', environment: {...structuredClone(original.environment), revisionId: 'room-one', displayName: 'Saved room'}};
    const settings = settingsFor(original, ['stage']); settings.stageIds = ['library-one'];
    const result = generateRandomSetup(original, settings, 100, [world]);
    expect(result.scene.environment.revisionId).toBe('room-one');
    expect(result.scene.environment.plinth).toEqual(original.environment.plinth);
    expect(result.scene.environment.props).toEqual(original.environment.props);
    expect(result.scene.environment.studioSizeM).toBe(.4);
    expect(result.scene.comparison).toBeUndefined(); expect(original.comparison.reviewedAlignmentDigest).toBe('previous');
    expect(world.environment.revisionId).toBe('room-one');
    settings.stageIds = ['gone']; expect(() => generateRandomSetup(original, settings, 100, [world])).toThrow('no longer available');
  });

  it('fills an absent stage and empty film without inventing product geometry', () => {
    const original = source(); delete original.environment; original.shots = []; original.actions = []; original.render.durationFrames = 144;
    const settings = fillSettingsFor(original);
    const result = generateRandomSetup(original, settings, 7);
    expect(result.scene.shots).toHaveLength(3); expect(sequenceEnd(result.scene)).toBe(144);
    expect(result.scene.product).toEqual(original.product);
    expect(result.scene.environment.kind).toBe('authored');
    validateWithExporter(result.scene);
    settings.policies.stage = 'keep'; expect(() => generateRandomSetup(original, settings, 7)).toThrow('Allow Stage');
  });

  it('does not invent movement for a deliberately still camera when filling gaps', () => {
    const original = source(); original.shots.forEach((shot: any) => {shot.camera.to = structuredClone(shot.camera.from);});
    expect(generateRandomSetup(original, fillSettingsFor(original), 1).scene).toEqual(original);
  });

  it('retains authored camera path deltas and optics if only framing is randomized', () => {
    const original = source(); original.shots[0].camera.depthOfField = {enabled: true, fStop: 4, focusDistanceM: .5};
    const result = generateRandomSetup(original, settingsFor(original, ['framing']), 33);
    for (let i = 0; i < original.shots.length; i++) {
      const before = original.shots[i].camera, after = result.scene.shots[i].camera;
      expect(after.depthOfField).toEqual(before.depthOfField);
      for (let axis = 0; axis < 3; axis++) {
        expect(after.to.positionM[axis] - after.from.positionM[axis]).toBeCloseTo(before.to.positionM[axis] - before.from.positionM[axis]);
        expect(after.to.targetM[axis] - after.from.targetM[axis]).toBeCloseTo(before.to.targetM[axis] - before.from.targetM[axis]);
      }
    }
    validateWithExporter(result.scene);
  });

  it('holds the camera around authored object movement, retaining actions and keys', () => {
    const original = source(), shot = original.shots[0];
    const id = addMotion(original, shot.id, '$product', 'rotate');
    updateMotion(original, shot.id, id, {amount: 24});
    original.animation = {tracks: [{id: 'product-x', componentId: '$product', property: 'position.x', enabled: false, keys: [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 360, value: .1, interpolation: 'ease'}]}]};
    const settings = settingsFor(original, ['motion']); settings.motionKinds = ['push'];
    const result = generateRandomSetup(original, settings, 14);
    expect(result.scene.actions).toEqual(original.actions); expect(result.scene.animation).toEqual(original.animation);
    expect(result.scene.shots[0].motions.find((motion: any) => motion.id === id)).toEqual(shot.motions[0]);
    expect(result.scene.shots[0].motions.find((motion: any) => motion.target === '$camera')).toBeUndefined();
    expect(result.scene.shots[0].camera.to).toEqual(result.scene.shots[0].camera.from);
    expect(result.changes).toContain(`${shot.name}: still camera · existing movement`);
    validateWithExporter(result.scene);
  });

  it('retimes native actions and keys using the canonical film clock, while retaining image content', () => {
    const original = source(); addImageShot(original, imageAsset, 'End card', original.shots[0].id, 48);
    original.animation = {tracks: [{id: 'product-x', componentId: '$product', property: 'position.x', enabled: false, keys: [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 408, value: .1, interpolation: 'ease'}]}]};
    const settings = settingsFor(original, ['framing']); settings.durationSeconds = 24; settings.shotCount = 4; settings.aspect = '16:9';
    const result = generateRandomSetup(original, settings, 32);
    expect(sequenceEnd(result.scene)).toBe(576);
    expect(result.scene.shots.filter((shot: any) => shot.kind !== 'image')).toHaveLength(4);
    expect(result.scene.shots.find((shot: any) => shot.kind === 'image').image).toEqual(original.shots.find((shot: any) => shot.kind === 'image').image);
    expect(result.scene.animation.tracks[0].keys.at(-1).frame).toBe(576);
    expect(result.scene.actions[0].distanceM).toBe(original.actions[0].distanceM);
    expect(result.scene.actions[0].startSeconds).toBeCloseTo(original.actions[0].startSeconds * 575 / 407);
    expect(result.scene.render.width / result.scene.render.height).toBeCloseTo(16 / 9, 2);
    validateWithExporter(result.scene);
  });

  it('rejects removing an object-animated shot rather than silently dropping its performance', () => {
    const original = source(); addMotion(original, original.shots[2].id, '$product', 'rotate');
    const before = structuredClone(original), settings = settingsFor(original, ['framing']); settings.shotCount = 2;
    expect(() => generateRandomSetup(original, settings, 1)).toThrow('object or light movement');
    expect(original).toEqual(before);
  });

  it('preserves animated light identity and base pose when choosing a new rig', () => {
    const original = source(); original.lighting = defaultLighting(original);
    const id = addMotion(original, original.shots[0].id, '$light:key', 'orbit');
    const settings = settingsFor(original, ['lighting']); settings.lightingStyles = ['spot'];
    const result = generateRandomSetup(original, settings, 10);
    expect(result.scene.lighting.lights.find((light: any) => light.id === 'key')).toEqual(original.lighting.lights[0]);
    expect(result.scene.shots[0].motions.find((motion: any) => motion.id === id)).toEqual(original.shots[0].motions[0]);
    validateWithExporter(result.scene);
  });

  it('changes only explicitly selected object materials and keeps the source material reusable', () => {
    const original = source();
    original.product.components[0].material.textures = {basecolor: {path: `assets/${'b'.repeat(64)}.png`, sha256: 'b'.repeat(64), format: 'png'}};
    const before = structuredClone(original), settings = settingsFor(original, ['materials']);
    settings.materialPartIds = ['cap']; settings.materialTypes = ['metal'];
    const result = generateRandomSetup(original, settings, 2);
    expect(result.scene.product.components[2].material.metallic).toBe(1);
    expect(result.scene.product.components[0]).toEqual(before.product.components[0]);
    expect(result.scene.product.components[3]).toEqual(before.product.components[3]);
    expect(result.scene.product.label).toEqual(original.product.label); expect(original).toEqual(before);
    validateWithExporter(result.scene);
    settings.materialPartIds = []; expect(() => generateRandomSetup(original, settings, 2)).toThrow('Choose at least one object');
  });

  it('fills an actually missing primitive material while preserving authored glass', () => {
    const original: any = structuredClone(glassFixture);
    const intact = structuredClone(original.product.components[0]);
    delete original.product.components[2].material;
    const settings = fillSettingsFor(original);
    expect(settings.materialPartIds).toContain(original.product.components[2].id);
    const result = generateRandomSetup(original, settings, 22);
    expect(result.scene.product.components[0]).toEqual(intact);
    expect(result.scene.product.components[2].material).toBeDefined();
    validateWithExporter(result.scene);
  });

  it('does not apply screen size, duration or count unless framing is opted in', () => {
    const original = source(), settings = settingsFor(original);
    settings.aspect = '1:1'; settings.durationSeconds = 30; settings.shotCount = 10;
    expect(generateRandomSetup(original, settings, 5).scene).toEqual(original);
  });

  it('rejects empty random pools, invalid seeds and durations without touching the source', () => {
    const original = source(), before = structuredClone(original), settings = settingsFor(original, ['framing']);
    settings.cameraViews = []; expect(() => generateRandomSetup(original, settings, 3)).toThrow('at least one camera view');
    settings.cameraViews = ['front']; settings.durationSeconds = .001;
    expect(() => generateRandomSetup(original, settings, 3)).toThrow('two frames');
    expect(() => generateRandomSetup(original, settings, NaN)).toThrow('setup seed'); expect(original).toEqual(before);
  });


  it('requires both shot scales and defaults a single-shot source to at least two shots', () => {
    const original = source(), before = structuredClone(original), settings = settingsFor(original, ['framing']);
    expect(defaultRandomSetupSettings({...original, shots: [original.shots[0]]}).shotCount).toBe(2);
    settings.shotCount = 1;
    expect(() => generateRandomSetup(original, settings, 7)).toThrow('2–24 product shots');
    settings.shotCount = 2; settings.cameraViews = ['front'];
    expect(() => generateRandomSetup(original, settings, 7)).toThrow('Include Close-up');
    settings.cameraViews = ['detail'];
    expect(() => generateRandomSetup(original, settings, 7)).toThrow('Include a full-product view');
    expect(original).toEqual(before);
  });

  it('guarantees full-product and close-up coverage across seeds and output ratios', () => {
    const original = source(); original.actions = [];
    const settings = settingsFor(original, ['framing', 'motion']); settings.shotCount = 2;
    for (const aspect of ['16:9', '9:16', '1:1', '4:5'] as const) for (const seed of [0, 1, 13, 42, 123, 0xffffffff]) {
      settings.aspect = aspect;
      const {scene} = generateRandomSetup(original, settings, seed), bounds = productBounds(scene), ratio = scene.render.width / scene.render.height;
      const [full, close] = scene.shots;
      for (let i = 0; i <= 8; i++) {
        const frame = full.startFrame + (full.endFrame - full.startFrame) * i / 8;
        const projected = projectedProductBounds(bounds, filmCameraPoseAtFrame(scene, full, frame), ratio);
        expect(projected.left).toBeGreaterThanOrEqual(-1); expect(projected.right).toBeLessThanOrEqual(1);
        expect(projected.bottom).toBeGreaterThanOrEqual(-1); expect(projected.top).toBeLessThanOrEqual(1);
      }
      const detail = projectedProductBounds(bounds, filmCameraPoseAtFrame(scene, close, close.startFrame), ratio);
      expect(detail.occupancy).toBeCloseTo(1.4, 5);
    }
  });

  it('uses one sampled camera owner with visible travel, or deliberately holds', () => {
    const original = source(); original.actions = [];
    const settings = settingsFor(original, ['framing', 'motion']);
    for (const kind of ['orbit', 'push'] as const) {
      settings.motionKinds = [kind];
      const {scene} = generateRandomSetup(original, settings, 27), bounds = productBounds(scene), aspect = scene.render.width / scene.render.height;
      for (const shot of scene.shots) {
        const owners = (shot.motions ?? []).filter((motion: any) => motion.target === '$camera' && motion.enabled);
        expect(owners.length).toBeLessThanOrEqual(1);
        expect(shot.camera.to).toEqual(shot.camera.from);
        if (!owners.length) continue;
        const first = projectedProductBounds(bounds, filmCameraPoseAtFrame(scene, shot, shot.startFrame), aspect);
        let travel = 0;
        for (let i = 1; i <= 16; i++) {
          const p = projectedProductBounds(bounds, filmCameraPoseAtFrame(scene, shot, shot.startFrame + (shot.endFrame - shot.startFrame) * i / 16), aspect);
          expect(p.minDepth).toBeGreaterThan(.001);
          for (const edge of ['left', 'right', 'top', 'bottom'] as const) travel = Math.max(travel, Math.abs(p[edge] - first[edge]) / 2);
        }
        expect(travel).toBeGreaterThanOrEqual(.04);
      }
      validateWithExporter(scene);
    }
  });

  it('does not stack random camera movement on the bottle mechanism or enabled part keys', () => {
    const original = source();
    original.animation = {tracks: [{id: 'cap-out-back', componentId: 'cap', property: 'position.x', enabled: true,
      keys: [{frame: 1, value: 0, interpolation: 'linear'}, {frame: 60, value: .02, interpolation: 'linear'}, {frame: 120, value: 0, interpolation: 'linear'}]}]};
    const settings = settingsFor(original, ['motion']); settings.motionKinds = ['orbit'];
    const result = generateRandomSetup(original, settings, 5);
    for (const shot of result.scene.shots) if (randomSetupMovement(original, shot).cameraMustHold) {
      expect(filmCameraPoseAtFrame(result.scene, shot, shot.endFrame)).toEqual(filmCameraPoseAtFrame(result.scene, shot, shot.startFrame));
    }
    expect(result.scene.animation).toEqual(original.animation); expect(result.scene.actions).toEqual(original.actions);
    validateWithExporter(result.scene);
  });

  it('holds rather than reducing an unsafe push to a tiny optical move', () => {
    const original = source(); original.actions = [];
    for (const shot of original.shots) {
      shot.camera.from = {positionM: [0, .08, .055], targetM: [0, .08, 0], focalLengthMm: 50};
      shot.camera.to = structuredClone(shot.camera.from); shot.camera.depthOfField = {enabled: true, fStop: 4};
    }
    const settings = settingsFor(original, ['motion']); settings.motionKinds = ['push'];
    const {scene, changes} = generateRandomSetup(original, settings, 3);
    expect(scene.shots.every((shot: any) => !(shot.motions ?? []).some((motion: any) => motion.target === '$camera'))).toBe(true);
    expect(changes.some(change => change.includes('no room for a clear push-in'))).toBe(true);
    validateWithExporter(scene);
  });

  it('generates valid shared preview/export scenes for several seeds and motion types', () => {
    const original = source(), settings = settingsFor(original, ['stage', 'lighting', 'framing', 'motion']);
    for (const seed of [0, 1, 8, 42, 512, 0xffffffff]) {
      const {scene} = generateRandomSetup(original, settings, seed);
      validateFilmMotions(scene); validateWithExporter(scene);
    }
  });
});
