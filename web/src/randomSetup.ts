import {Vector3} from 'three';
import {validateCamera} from './camera';
import {offsetCameraFraming} from './cameraFraming';
import {addMotion, filmCameraPoseAtFrame, retimeMotions, updateMotion, validateFilmMotions, type FilmMotion} from './filmMotion';
import {MATERIAL_PRESETS} from './materials';
import {partTargetIds} from './partTargets';
import {isRandomCameraPoseSafe, productBounds, projectedProductBounds, randomCameraPose as cameraPose} from './randomSetupFraming';
import {randomSetupMovement} from './randomSetupMovement';
import {checkActionCoverage, checkKeyframeCoverage, sequenceEnd, setOutputDimensions, setSequenceFrames, shotFrames, type Shot} from './sequence';
import {applyDramaticSpot, colorFromHex, defaultLighting, isLightTarget, lightIdFromTarget} from './world';

export type RandomSetupPolicy = 'keep' | 'fill' | 'random';
export type RandomSetupCategory = 'stage' | 'lighting' | 'framing' | 'motion' | 'materials' | 'colors';
export type RandomSetupSettings = {
  policies: Record<RandomSetupCategory, RandomSetupPolicy>;
  stageIds: string[];
  paletteIds: string[];
  lightingStyles: ('soft' | 'side' | 'spot')[];
  cameraViews: ('front' | 'three-quarter' | 'detail')[];
  motionKinds: ('still' | 'orbit' | 'push')[];
  materialPartIds: string[];
  materialTypes: ('plastic' | 'metal' | 'glass')[];
  durationSeconds: number;
  shotCount: number;
  aspect: 'keep' | '16:9' | '9:16' | '1:1' | '4:5';
};
export type RandomSetupWorld = {id: string; name: string; environment: any};
export type RandomSetupResult<T = any> = {scene: T; changes: string[]; seed: number};
export const RANDOM_SETUP_STAGES = [
  {id: 'builtin:white', name: 'White studio'},
  {id: 'builtin:chalk', name: 'Chalk studio'},
  {id: 'builtin:dark', name: 'Dark studio'},
] as const;

/** Authored sRGB swatches; generation converts them to the shared linear scene values. */
export const RANDOM_SETUP_PALETTES: readonly {id: string; name: string; colors: readonly string[]}[] = [
  {id: 'neutral', name: 'Neutral', colors: ['#272B2D', '#707570', '#B8B8AA', '#E7E4DC']},
  {id: 'clay', name: 'Clay', colors: ['#4B2722', '#A34F36', '#D99A71', '#E9D7BA']},
  {id: 'coastal', name: 'Coastal', colors: ['#162F42', '#456E7A', '#91AAA5', '#DFE4D9']},
  {id: 'orchid', name: 'Orchid', colors: ['#352842', '#74617F', '#B49FB3', '#E8DDE2']},
];

const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const productShots = (scene: any): Shot[] => (scene.shots ?? []).filter((shot: Shot) => shot.kind !== 'image');
const requireValue = (condition: unknown, message: string): void => {if (!condition) throw new Error(message);};

/** A separate stream for each category and object keeps unrelated choices stable. */
function random(seed: number, scope: string): () => number {
  let state = seed >>> 0;
  for (let i = 0; i < scope.length; i++) state = Math.imul(state ^ scope.charCodeAt(i), 16777619) >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function choose<T extends string>(pool: T[], allowed: readonly string[], rng: () => number, label: string): T {
  requireValue(Array.isArray(pool) && pool.length > 0, `Choose at least one ${label}.`);
  requireValue(pool.every(value => allowed.includes(value)), `One of the selected ${label} options is no longer available.`);
  // Checkbox ordering must not influence reproducibility.
  const options = [...new Set(pool)].sort();
  return options[Math.floor(rng() * options.length)];
}

/** Everything starts opted in, while generation remains a separate unsaved candidate. */
export function defaultRandomSetupSettings(source: any): RandomSetupSettings {
  const targets = new Set(partTargetIds(source));
  return {
    policies: {stage: 'random', lighting: 'random', framing: 'random', motion: 'random', materials: 'random', colors: 'random'},
    stageIds: RANDOM_SETUP_STAGES.map(stage => stage.id), paletteIds: RANDOM_SETUP_PALETTES.map(palette => palette.id), lightingStyles: ['soft', 'side', 'spot'],
    cameraViews: ['front', 'three-quarter', 'detail'], motionKinds: ['still', 'orbit', 'push'],
    materialPartIds: (source?.product?.components ?? []).filter((part: any) => targets.has(part.id)).map((part: any) => part.id),
    materialTypes: ['plastic', 'metal', 'glass'],
    durationSeconds: source?.shots?.length || source?.render?.durationFrames ? sequenceEnd(source) / (source.render?.fps || 24) : 6,
    shotCount: Math.max(2, productShots(source).length || 3), aspect: 'keep',
  };
}

/** Coverage is a constraint on generated framing; retained shots are never silently rewritten. */
export function randomFramingRuleError(settings: RandomSetupSettings): string {
  if (!Number.isSafeInteger(settings.shotCount) || settings.shotCount < 2 || settings.shotCount > 24)
    return 'Use 2–24 product shots so the reel can include a full product and a close-up.';
  if (!settings.cameraViews.includes('detail')) return 'Include Close-up in Refine choices → Camera views.';
  if (!settings.cameraViews.some(view => view === 'front' || view === 'three-quarter'))
    return 'Include a full-product view in Refine choices → Camera views.';
  return '';
}

function fallbackStage(scene: any): any {
  const size = Math.max(...scene.product.dimensionsM) * (scene.placement?.scale ?? 1);
  const ids = new Set(scene.product.components.map((part: any) => part.id));
  let id = 'plinth'; while (ids.has(id)) id += '-support';
  return {revisionId: 'random-studio-white-v1', kind: 'authored', displayName: 'White studio', worldColor: [.9, .9, .9],
    plinth: {id, sizeM: [size * 2.5, size * .1, size * 2.5], translationM: [0, -size * .05, 0]},
    provenance: {source: 'Gesso authored studio preset', owner: '3d-product-suite', reuseBasis: 'Original project geometry', allowedExternalDestinations: []}};
}

function setStage(scene: any, id: string, worlds: RandomSetupWorld[]): void {
  const prior = scene.environment, base = fallbackStage(scene);
  const builtin = RANDOM_SETUP_STAGES.find(stage => stage.id === id);
  let next: any;
  if (builtin) {
    const colors = {'builtin:white': [.9, .9, .9], 'builtin:chalk': [.61, .58, .51], 'builtin:dark': [.025, .028, .032]};
    next = {...base, revisionId: `random-studio-${id.slice(8)}-v1`, displayName: builtin.name, worldColor: colors[builtin.id]};
  } else {
    const world = worlds.find(item => item.id === id);
    requireValue(world, 'This stage is no longer available. Choose another stage.');
    next = clone(world!.environment);
  }
  // Match the real editor's world switch: the support, props and native metre scale stay put.
  next.plinth = clone(prior?.plinth ?? base.plinth);
  if (prior?.props !== undefined) next.props = clone(prior.props);
  if (prior?.studioSizeM !== undefined) next.studioSizeM = prior.studioSizeM;
  if (!next.worldColor) next.worldColor = base.worldColor;
  scene.environment = next;
  scene.placement ??= {translationM: [0, 0, 0], restsOn: next.plinth.id};
  scene.placement.restsOn = next.plinth.id;
  // A new primary stage has no reviewed alignment to the previous alternative.
  delete scene.comparison;
}

function applyLighting(scene: any, style: RandomSetupSettings['lightingStyles'][number]): void {
  const prior = scene.lighting ?? defaultLighting(scene);
  if (style === 'spot') applyDramaticSpot(scene);
  else {
    scene.lighting = defaultLighting(scene);
    if (style === 'side') {
      scene.lighting.ambientStrength = .22;
      scene.lighting.lights[1].powerW *= .3;
      scene.lighting.lights[0].positionM[0] *= 1.5;
      scene.lighting.lights[0].diameterM *= .65;
    }
    if (prior.hdri) scene.lighting.hdri = clone(prior.hdri);
  }
  const center = productBounds(scene).getCenter(new Vector3()).toArray();
  scene.lighting.lights.forEach((light: any) => {light.targetM = [...center];});
  const animatedIds = new Set<string>([...(scene.motions ?? []), ...scene.shots.flatMap((shot: Shot) => shot.motions ?? [])]
    .filter((motion: FilmMotion) => isLightTarget(motion.target)).map((motion: FilmMotion) => lightIdFromTarget(motion.target)));
  // Preserve animated light identities and their base poses, including disabled tracks.
  for (const id of animatedIds) {
    const original = prior.lights.find((light: any) => light.id === id);
    requireValue(original, 'An animated light is missing. Restore it in Stage before generating a setup.');
    scene.lighting.lights = scene.lighting.lights.filter((light: any) => light.id !== id);
    scene.lighting.lights.push(clone(original));
  }
  requireValue(scene.lighting.lights.length <= 8, 'Keep the current lighting: this scene already uses too many animated lights to add a preset.');
}

function newShot(scene: any, usedIds: Set<string>): Shot {
  let index = 1; while (usedIds.has(`random-shot-${index}`)) index++;
  const id = `random-shot-${index}`; usedIds.add(id);
  const pose = cameraPose(scene, 'three-quarter');
  return {id, name: `Product ${index}`, startFrame: 1, endFrame: 2, camera: {from: clone(pose), to: clone(pose)}};
}

function composeShots(scene: any, count: number, created: Set<string>): void {
  const existing = productShots(scene);
  if (count === existing.length) return;
  const dropped = existing.slice(count);
  requireValue(!dropped.some(shot => shot.motions?.some((motion: FilmMotion) => motion.target !== '$camera')),
    'A removed shot contains object or light movement. Keep its shot count, or move that animation in Film first.');
  const retainedIds = new Set(existing.slice(0, count).map(shot => shot.id));
  const shots: Shot[] = scene.shots.filter((shot: Shot) => shot.kind === 'image' || retainedIds.has(shot.id));
  const usedIds = new Set<string>(scene.shots.map((shot: Shot) => shot.id));
  while (shots.filter(shot => shot.kind !== 'image').length < count) {
    const shot = newShot(scene, usedIds); created.add(shot.id); shots.push(shot);
  }
  const total = sequenceEnd(scene), imageFrames = shots.filter(shot => shot.kind === 'image').reduce((sum, shot) => sum + shotFrames(shot), 0);
  requireValue(total - imageFrames >= count * 2, 'There is not enough time for these product shots. Increase the duration or use fewer shots.');
  const available = total - imageFrames;
  let cursor = 1, productIndex = 0;
  for (const shot of shots) {
    const before = shotFrames(shot);
    const length = shot.kind === 'image' ? before : Math.round(available * (++productIndex) / count) - Math.round(available * (productIndex - 1) / count);
    if (shot.motions && !created.has(shot.id)) shot.motions = retimeMotions(shot.motions, before > 1 ? (length - 1) / (before - 1) : 1);
    if (shot.camera.durationFrames !== undefined) shot.camera.durationFrames = Math.max(1, Math.round((shot.camera.durationFrames - 1) * (length - 1) / Math.max(1, before - 1)) + 1);
    shot.startFrame = cursor; shot.endFrame = cursor + length - 1; cursor += length;
  }
  scene.shots = shots; scene.render.durationFrames = total;
}

/** Measure the real sampled camera against the product, in output-frame units. */
function cameraMoveIssue(scene: any, shot: Shot): 'clipping' | 'subtle' | null {
  const bounds = productBounds(scene), aspect = scene.render.width / scene.render.height;
  const start = projectedProductBounds(bounds, filmCameraPoseAtFrame(scene, shot, shot.startFrame), aspect);
  let travel = 0;
  for (let i = 0; i <= 16; i++) {
    const pose = filmCameraPoseAtFrame(scene, shot, shot.startFrame + (shotFrames(shot) - 1) * i / 16);
    const projected = projectedProductBounds(bounds, pose, aspect);
    if (!isRandomCameraPoseSafe(bounds, pose, aspect, shot.camera)) return 'clipping';
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) travel = Math.max(travel, Math.abs(projected[edge] - start[edge]) / 2);
  }
  // At least 4% of an output dimension: the threshold scales with the actual framing.
  return travel >= .04 ? null : 'subtle';
}

/** One immutable candidate feeds the real preview and exporter; this function never saves a project. */
export function generateRandomSetup<T>(source: T, settings: RandomSetupSettings, seed: number, worlds: RandomSetupWorld[] = []): RandomSetupResult<T> {
  requireValue(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff, 'The setup seed must be a whole number between 0 and 4294967295.');
  const scene: any = clone(source), changes: string[] = [], created = new Set<string>();
  requireValue(scene?.product?.components?.length && scene?.product?.dimensionsM?.every((n: number) => Number.isFinite(n) && n > 0), 'Import a product before generating a setup.');
  requireValue(Number.isInteger(scene.render?.fps) && scene.render.fps > 0, 'Choose a valid film frame rate first.');
  for (const category of ['stage', 'lighting', 'framing', 'motion', 'materials', 'colors'] as const)
    requireValue(['keep', 'fill', 'random'].includes(settings.policies[category]), `Choose keep, fill gaps or randomize for ${category}.`);
  scene.shots ??= [];

  const stageMissing = !scene.environment?.kind || !scene.environment?.plinth;
  if (settings.policies.stage === 'random' || settings.policies.stage === 'fill' && stageMissing) {
    const id = choose(settings.stageIds, [...RANDOM_SETUP_STAGES.map(stage => stage.id), ...worlds.map(world => world.id)], random(seed, 'stage'), 'stage');
    const before = clone(scene.environment); setStage(scene, id, worlds);
    if (!same(before, scene.environment)) changes.push(`Stage: ${scene.environment.displayName ?? worlds.find(world => world.id === id)?.name ?? id}`);
  }
  requireValue(scene.environment?.plinth && scene.placement, 'The product needs a stage and placement. Allow Stage to fill the gap.');

  let palette: typeof RANDOM_SETUP_PALETTES[number] | undefined;
  let backgroundHex: string | undefined;
  if (settings.policies.colors === 'random' || settings.policies.colors === 'fill' && !scene.environment.worldColor) {
    const paletteId = choose(settings.paletteIds, RANDOM_SETUP_PALETTES.map(item => item.id), random(seed, 'colors:palette'), 'color palette');
    palette = RANDOM_SETUP_PALETTES.find(item => item.id === paletteId)!;
    backgroundHex = choose([...palette.colors], palette.colors, random(seed, 'colors:background'), 'background color');
    scene.environment.worldColor = colorFromHex(backgroundHex);
    changes.push(`Colors: ${palette.name} · background ${backgroundHex}`);
  }

  if (settings.policies.framing === 'random' || settings.policies.framing === 'fill' && !scene.shots.length) {
    requireValue(Number.isSafeInteger(settings.shotCount) && settings.shotCount >= 2 && settings.shotCount <= 24, randomFramingRuleError(settings));
    requireValue(Number.isFinite(settings.durationSeconds) && settings.durationSeconds > 0 && settings.durationSeconds <= 600, 'Choose a duration above 0 and no longer than 600 seconds.');
    const frames = Math.round(settings.durationSeconds * scene.render.fps);
    requireValue(frames >= settings.shotCount * 2, 'Keep at least two frames per product shot.');
    const beforeTotal = sequenceEnd(scene), beforeCount = productShots(scene).length;
    if (!scene.shots.length) scene.render.durationFrames = Math.max(frames, beforeTotal);
    // Lengthen before adding shots, shorten afterwards: canonical retiming retains authored actions and keys.
    if (frames > sequenceEnd(scene)) setSequenceFrames(scene, frames);
    composeShots(scene, settings.shotCount, created);
    if (frames !== sequenceEnd(scene)) setSequenceFrames(scene, frames);
    if (beforeTotal !== frames) changes.push(`Duration: ${Number((frames / scene.render.fps).toFixed(3))} s`);
    if (beforeCount !== settings.shotCount) changes.push(`Product shots: ${settings.shotCount}`);
  }
  if (settings.policies.framing === 'random' && settings.aspect !== 'keep') {
    const ratios = {'16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5]};
    requireValue(settings.aspect in ratios, 'Choose a supported screen size.');
    const [w, h] = ratios[settings.aspect], longest = Math.max(scene.render.width, scene.render.height);
    const width = Math.max(2, Math.round(longest * w / Math.max(w, h) / 2) * 2);
    const height = Math.max(2, Math.round(longest * h / Math.max(w, h) / 2) * 2);
    if (width !== scene.render.width || height !== scene.render.height) {setOutputDimensions(scene, width, height); changes.push(`Screen: ${settings.aspect}`);}
  }
  const framingShots = productShots(scene).filter(shot => settings.policies.framing === 'random' ||
    settings.policies.framing === 'fill' && (!shot.camera?.from || !shot.camera?.to || created.has(shot.id)));
  if (framingShots.length) {
    // Validate the entire pool before assigning the two required roles.
    choose(settings.cameraViews, ['front', 'three-quarter', 'detail'], random(seed, 'framing:pool'), 'camera view');
    requireValue(!randomFramingRuleError(settings), randomFramingRuleError(settings));
  }
  for (const [index, shot] of framingShots.entries()) {
    const pool = index === 0 ? settings.cameraViews.filter(view => view !== 'detail') : index === 1 ? ['detail' as const] : settings.cameraViews;
    const view = choose(pool, ['front', 'three-quarter', 'detail'], random(seed, `framing:${shot.id}`), 'camera view');
    const pose = cameraPose(scene, view, shot.camera), before = clone(shot.camera);
    if (!shot.camera?.from || !shot.camera?.to) shot.camera = {from: clone(pose), to: clone(pose)};
    else offsetCameraFraming(shot.camera, clone(shot.camera.from), next => Object.assign(next, clone(pose)));
    const label = view === 'detail' ? 'Close-up' : 'Full product';
    if (created.has(shot.id)) shot.name = `${label} ${index + 1}`;
    if (!same(before, shot.camera)) changes.push(`${shot.name}: ${label.toLowerCase()}${view === 'three-quarter' ? ' · three-quarter' : ''}`);
  }

  const lightingMissing = scene.lighting !== undefined && (!scene.lighting || !Array.isArray(scene.lighting.lights));
  if (settings.policies.lighting === 'random' || settings.policies.lighting === 'fill' && lightingMissing) {
    const style = choose(settings.lightingStyles, ['soft', 'side', 'spot'], random(seed, 'lighting'), 'lighting style');
    const before = clone(scene.lighting);
    if (lightingMissing) delete scene.lighting;
    applyLighting(scene, style);
    if (!same(before, scene.lighting)) changes.push(`Lighting: ${style}`);
  }

  if (settings.policies.motion === 'random') {
    // Only the camera is in this scope. Mechanical actions, part keys and light motion remain authored.
    if (scene.motions?.some((motion: FilmMotion) => motion.target === '$camera')) scene.motions = scene.motions.filter((motion: FilmMotion) => motion.target !== '$camera');
  }
  for (const shot of productShots(scene)) {
    if (!(settings.policies.motion === 'random' || settings.policies.motion === 'fill' && created.has(shot.id))) continue;
    let kind = choose(settings.motionKinds, ['still', 'orbit', 'push'], random(seed, `motion:${shot.id}`), 'camera movement');
    const authored = randomSetupMovement(scene, shot);
    let reason = '';
    if (authored.cameraMustHold) {kind = 'still'; reason = ' · existing movement';}
    const before = clone({camera: shot.camera, motions: shot.motions});
    if (shot.motions?.some((motion: FilmMotion) => motion.target === '$camera')) shot.motions = shot.motions.filter((motion: FilmMotion) => motion.target !== '$camera');
    shot.camera.to = clone(shot.camera.from);
    delete shot.camera.durationFrames;
    const distance = Math.hypot(...shot.camera.from.positionM.map((value: number, index: number) => value - shot.camera.from.targetM[index]));
    const minimum = shot.camera.depthOfField?.enabled && shot.camera.depthOfField.focusDistanceM === undefined ? shot.camera.from.focalLengthMm / 1000 : .00001;
    // A push changes subject scale by at least ~22%; never clamp it down to a barely visible move.
    if (kind === 'push' && distance * .82 <= minimum) {
      kind = settings.motionKinds.includes('orbit') ? 'orbit' : 'still';
      reason = ' · no room for a clear push-in';
    }
    const inheritedCamera = (scene.motions ?? []).some((motion: FilmMotion) => motion.enabled && motion.target === '$camera');
    if (kind !== 'still' || inheritedCamera) {
      requireValue(shotFrames(shot) >= 2, 'Camera movement needs at least two frames in each product shot.');
      // One owner replaces any endpoint path; a zero orbit masks an inherited move for Still.
      const id = addMotion(scene, shot.id, '$camera', 'orbit');
      updateMotion(scene, shot.id, id, {kind: kind === 'push' ? 'dolly' : 'orbit', durationFrames: shotFrames(shot),
        amount: kind === 'still' ? 0 : kind === 'orbit' ? 32 : distance * .18});
      if (kind !== 'still') {
        const issue = cameraMoveIssue(scene, shot);
        if (issue) {
          kind = 'still'; reason = issue === 'subtle' ? ' · movement would be too small' : ' · movement would cross the product';
          if (inheritedCamera) updateMotion(scene, shot.id, id, {kind: 'orbit', amount: 0});
          else shot.motions = shot.motions!.filter((motion: FilmMotion) => motion.id !== id);
        }
      }
    }
    if (!same(before, {camera: shot.camera, motions: shot.motions}) || reason) changes.push(`${shot.name}: ${kind === 'push' ? 'push in' : kind} camera${reason}`);
    if (authored.mixedAuthoredKinds) changes.push(`${shot.name}: existing ${authored.kinds.join(' + ')} kept`);
  }

  if (settings.policies.materials === 'random') requireValue(settings.materialPartIds.length > 0, 'Choose at least one object whose material can change.');
  const materialTargets = new Set(partTargetIds(scene));
  if (settings.policies.materials !== 'keep') for (const id of [...new Set(settings.materialPartIds)].sort()) {
    const part = scene.product.components.find((item: any) => item.id === id);
    requireValue(part && materialTargets.has(id), 'A selected material object is no longer in the product. Choose its current object.');
    // Imported source surfaces count as authored even when no override is present.
    if (settings.policies.materials === 'fill' && (part.material || part.shape === 'mesh' && !part.materialOverride)) continue;
    const type = choose(settings.materialTypes, ['plastic', 'metal', 'glass'], random(seed, `materials:${id}`), 'material type');
    part.material = clone(MATERIAL_PRESETS.find(preset => preset.id === type)!.material);
    // Palette colors belong only to new finishes, never to retained source surfaces or artwork.
    let materialHex: string | undefined;
    if (palette && settings.policies.materials === 'random') {
      const swatches = palette.colors.filter(hex => hex !== backgroundHex);
      materialHex = choose([...swatches], swatches, random(seed, `colors:material:${id}`), 'material color');
      part.material.baseColor = [...colorFromHex(materialHex), part.material.baseColor[3]];
    }
    delete part.materialPresetId;
    if (part.shape === 'mesh') {part.materialOverride = true; delete part.materialBindings;}
    changes.push(`${part.name ?? id}: ${type}${materialHex ? ` · ${materialHex}` : ''}`);
  }
  for (const shot of scene.shots) validateCamera(shot.camera);
  checkActionCoverage(scene, sequenceEnd(scene)); checkKeyframeCoverage(scene, sequenceEnd(scene)); validateFilmMotions(scene);
  return {scene, changes, seed};
}
