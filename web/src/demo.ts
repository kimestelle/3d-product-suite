import { demoDataUrl } from './runtime';
import { campaignMaterialPresets } from './materialPresets';
import { removedPartIds } from './partTargets';

/** The public fixture is an interactive preview. No backend calls are emulated. */
export type DemoBundle = { bootstrap: any; samples: any };
const copy = <T>(value: T): T => structuredClone(value);
const requireDemo = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Browser demo: ${message}`);
};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vector = (value: any, length = 3): boolean => Array.isArray(value) && value.length === length && value.every(finite);
const canonical = (value: any): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  requireDemo(value !== undefined && (typeof value !== 'number' || finite(value)), 'The scene contains an invalid value.');
  return JSON.stringify(value);
};
const equal = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const add = (a: number[], b: number[]): number[] => a.map((n, i) => n + b[i]);
const mul = ([x, y, z, w]: number[], [X, Y, Z, W]: number[]): number[] =>
  [w * X + x * W + y * Z - z * Y, w * Y - x * Z + y * W + z * X,
    w * Z + x * Y - y * X + z * W, w * W - x * X - y * Y - z * Z];
const rotate = (q: number[], v: number[]): number[] => mul(mul(q, [...v, 0]), [-q[0], -q[1], -q[2], q[3]]).slice(0, 3);
const smooth = (value: number): number => { const u = Math.max(0, Math.min(1, value)); return u * u * (3 - 2 * u); };

function material(value: any, label = false): void {
  requireDemo(value && vector(value.baseColor, 4) && value.baseColor.every((n: number) => n >= 0 && n <= 1)
    && finite(value.roughness) && value.roughness >= 0 && value.roughness <= 1
    && finite(value.metallic) && value.metallic >= 0 && value.metallic <= 1,
  'Material colors, roughness and metallic response must be in range.');
  if (value.transmission !== undefined) requireDemo(finite(value.transmission) && value.transmission >= 0 && value.transmission <= 1
    && (!label || value.transmission === 0), 'This material transmission is unsupported.');
  if (value.ior !== undefined) requireDemo(finite(value.ior) && value.ior >= 1 && value.ior <= 3, 'Index of refraction must be between 1 and 3.');
}

const omitBoth = (current: any, baseline: any, keys: string[]): void => {
  for (const key of keys) { delete current[key]; delete baseline[key]; }
};

/** Published worlds may change the backdrop, never the sampled support geometry.
 * Match the whole bundled definition so a known hash cannot smuggle in a new
 * alignment, collider, revision or unbundled asset. */
function validateSampledWorld(environment: any, baseline: any, bundle: DemoBundle): void {
  requireDemo(vector(environment?.worldColor) && environment.worldColor.every((value: number) => value >= 0 && value <= 1),
    'World color must be in range.');
  const shared = ['plinth', 'props', 'floorY', 'studioSizeM'];
  for (const key of shared) requireDemo(Object.hasOwn(environment, key) === Object.hasOwn(baseline, key)
    && (!Object.hasOwn(environment, key) || equal(environment[key], baseline[key])),
    'Editing objects, floor contact or studio size needs the connected backend.');
  const backdrop = (value: any): any => {
    const result = copy(value);
    for (const key of [...shared, 'worldColor']) delete result[key];
    return result;
  };
  const packaged = [baseline, ...(bundle.bootstrap.worlds ?? []).map((world: any) => world.environment)];
  // The neutral studio is the same supported backdrop-only action as App's
  // Authored studio choice. Derive it from each packaged world so retained
  // metadata cannot authorize a different transform or an external asset.
  const authored = packaged.map((world: any) => {
    const result = copy(world);
    delete result.asset; delete result.fixture; delete result.collider;
    result.kind = 'authored'; result.revisionId = 'neutral-studio-v1'; result.displayName = 'Authored studio';
    result.provenance = {source:'Original authored studio', owner:'3d-product-suite', reuseBasis:'Original project geometry', allowedExternalDestinations:[]};
    return result;
  });
  const candidates = [...packaged, ...authored];
  requireDemo(candidates.some((candidate: any) => equal(backdrop(environment), backdrop(candidate))),
    'Choose one of the included environments. New world assets or alignment changes need the connected backend.');
}

/** A published campaign replays Python's actual poses, including Film motions,
 * imported part transforms and light motion. Only edits independent of those
 * poses can reuse them; an unsupported edit must never silently play old motion. */
function validateSampledScene(scene: any, bundle: DemoBundle): void {
  requireDemo(scene && typeof scene === 'object', 'Choose the supplied demonstration scene.');
  const current = copy(scene), baseline = copy(bundle.bootstrap.project.scene);
  requireDemo(Array.isArray(current.product?.components) && current.product.components.length === baseline.product.components.length,
    'Changing product geometry needs the connected backend.');
  const allowedAssets = new Set<string>();
  const visitAssets = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && typeof value.sha256 === 'string') allowedAssets.add(canonical(value));
    for (const child of Object.values(value)) visitAssets(child);
  };
  visitAssets(bundle.bootstrap.project.scene);
  const validateSurface = (value: any): void => {
    material(value);
    for (const asset of Object.values(value.textures ?? {})) requireDemo(allowedAssets.has(canonical(asset)),
      'New texture files need the connected backend. The included material colors and response remain editable.');
  };
  // This existing validator checks material ranges, map shapes and preset IDs.
  try { campaignMaterialPresets(scene); } catch (error) {
    requireDemo(false, error instanceof Error ? error.message : 'Choose a valid material preset.');
  }
  const presets = scene.product.materialPresets ?? [];
  for (const preset of presets) validateSurface(preset.material);
  const presetIds = new Set(presets.map((preset: any) => preset.id));
  const partIds = new Set<string>(bundle.bootstrap.demo.allowedPartIds ?? []);
  for (const component of baseline.product.components) {
    partIds.add(component.id);
    for (const node of component.sourceNodes ?? []) partIds.add(`${component.id}::node:${node.nodeIndex}`);
  }
  for (let index = 0; index < current.product.components.length; index++) {
    const component = current.product.components[index], original = baseline.product.components[index];
    validateSurface(component.material);
    if (component.materialOverride !== undefined) requireDemo(typeof component.materialOverride === 'boolean', 'Material override must be on or off.');
    if (component.materialPresetId !== undefined) requireDemo(presetIds.has(component.materialPresetId), 'Choose a saved material.');
    requireDemo(component.materialBindings === undefined || Array.isArray(component.materialBindings), 'Material assignments must be a list.');
    const bound = new Set<number>();
    for (const binding of component.materialBindings ?? []) {
      requireDemo(binding && Number.isSafeInteger(binding.nodeIndex) && partIds.has(`${component.id}::node:${binding.nodeIndex}`)
        && presetIds.has(binding.materialPresetId) && !bound.has(binding.nodeIndex), 'Choose an existing product part and material.');
      bound.add(binding.nodeIndex);
    }
    omitBoth(component, original, ['material', 'materialOverride', 'materialPresetId', 'materialBindings']);
  }
  requireDemo(current.product.removedPartIds === undefined || Array.isArray(current.product.removedPartIds)
    && current.product.removedPartIds.every((id: unknown) => typeof id === 'string' && partIds.has(id)), 'Choose an existing product part.');
  omitBoth(current.product, baseline.product, ['materialPresets', 'removedPartIds']);
  if (current.editorPartNames !== undefined) {
    requireDemo(current.editorPartNames && typeof current.editorPartNames === 'object' && !Array.isArray(current.editorPartNames), 'Part names must identify existing parts.');
    for (const [id, name] of Object.entries(current.editorPartNames)) requireDemo(partIds.has(id)
      && typeof name === 'string' && !!name.trim() && name.length <= 120, 'Use a part name of 1–120 characters.');
  }
  if (current.editorHierarchy !== undefined) {
    const hierarchy = current.editorHierarchy;
    requireDemo(hierarchy?.version === 1 && hierarchy.overrides && typeof hierarchy.overrides === 'object' && !Array.isArray(hierarchy.overrides), 'Use a valid product grouping.');
    for (const [id, entry] of Object.entries(hierarchy.overrides)) {
      const item = entry as any;
      requireDemo(partIds.has(id) && item && ['suggested', 'confirmed', 'edited'].includes(item.status)
        && (item.parentId === null || partIds.has(item.parentId)) && item.parentId !== id, 'Choose an existing parent part.');
    }
  }
  omitBoth(current, baseline, ['editorPartNames', 'editorHierarchy']);
  validateSampledWorld(current.environment, baseline.environment, bundle);
  current.environment = baseline.environment;
  requireDemo(Array.isArray(current.shots) && current.shots.length === baseline.shots.length, 'Changing the scene sequence needs the connected backend.');
  for (let index = 0; index < current.shots.length; index++) {
    const shot = current.shots[index], original = baseline.shots[index];
    requireDemo(typeof shot.name === 'string' && shot.name.length <= 140 && shot.camera, 'Choose a valid named scene.');
    shot.name = original.name;
    const optics = shot.camera.depthOfField;
    if (optics !== undefined) requireDemo(optics && typeof optics === 'object'
      && Object.keys(optics).every(key => ['enabled', 'fStop', 'focusDistanceM'].includes(key))
      && (optics.enabled === undefined || typeof optics.enabled === 'boolean')
      && (optics.fStop === undefined || finite(optics.fStop) && optics.fStop >= .7 && optics.fStop <= 64)
      && (optics.focusDistanceM === undefined || finite(optics.focusDistanceM) && optics.focusDistanceM > 0), 'Choose valid optical focus settings.');
    omitBoth(shot.camera, original.camera, ['depthOfField']);
  }
  for (const key of ['width', 'height', 'samples']) {
    requireDemo(Number.isSafeInteger(current.render?.[key]) && current.render[key] > 0 && current.render[key] <= 8192, 'Choose a valid preview size and sample count.');
    current.render[key] = baseline.render[key];
  }
  requireDemo(equal(current, baseline),
    'Changing placement, camera movement, animation, scene timing or geometry needs the connected backend. Undo this edit to return to the supplied film.');
}

async function sampledScene(scene: any, bundle: DemoBundle): Promise<any> {
  validateSampledScene(scene, bundle);
  const frames = copy(bundle.samples.frames);
  const removedChanged = !equal(scene.product.removedPartIds ?? [], bundle.bootstrap.project.scene.product.removedPartIds ?? []);
  const removed = removedChanged ? [...removedPartIds(scene)] : [];
  for (const sample of frames) {
    if (removedChanged) {
      if (removed.length) sample.removedPartIds = removed;
      else delete sample.removedPartIds;
    }
    const shot = scene.shots.find((entry: any) => entry.id === sample.shotId);
    const original = bundle.bootstrap.project.scene.shots.find((entry: any) => entry.id === sample.shotId);
    if (shot && !equal(shot.camera.depthOfField ?? {}, original.camera.depthOfField ?? {})) {
      const optics = shot.camera.depthOfField ?? {};
      sample.camera.depthOfField = {
        enabled: optics.enabled ?? false,
        fStop: optics.fStop ?? 2.8,
        focusDistanceM: optics.focusDistanceM ?? Math.hypot(...sample.camera.positionM.map((value: number, index: number) => value - sample.camera.targetM[index])),
      };
    }
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(scene)));
  const digest = 'demo-' + Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  return { scene: copy(scene), frames, objects: copy(bundle.samples.objects), digest };
}

/** Validate the explicitly supported edits before reusing the fixed geometry. */
function validatedScene(scene: any, bundle: DemoBundle): any {
  requireDemo(scene && typeof scene === 'object', 'Choose the supplied demonstration scene.');
  const current = copy(scene), baseline = copy(bundle.bootstrap.project.scene);
  requireDemo(!current.comparison, 'Mesh comparison and placement calibration need the connected backend.');
  requireDemo(Array.isArray(current.product?.components) && current.product.components.length === baseline.product.components.length,
    'Importing or changing product geometry needs the connected backend.');
  for (let i = 0; i < current.product.components.length; i++) {
    const component = current.product.components[i], original = baseline.product.components[i];
    material(component.material);
    component.material = original.material;
    if (component.labelTexture) {
      const texture = component.labelTexture;
      requireDemo(equal(texture.asset, bundle.bootstrap.demo.labelAsset), 'Uploading new texture files needs the connected backend. Try the included label artwork.');
      const mapping = texture.mapping;
      requireDemo(mapping && ['planar', 'cylindrical'].includes(mapping.mode)
        && ['front', 'back', 'left', 'right', 'top', 'bottom'].includes(mapping.face)
        && vector(mapping.scale, 2) && mapping.scale.every((n: number) => n >= .01 && n <= 10)
        && vector(mapping.offset, 2) && mapping.offset.every((n: number) => n >= -5 && n <= 5)
        && finite(mapping.rotationDegrees) && Math.abs(mapping.rotationDegrees) <= 360,
      'Use a supported face or cylinder label mapping within its limits.');
      material(texture.material, true);
    }
    delete component.labelTexture;
    delete original.labelTexture;
  }
  requireDemo(typeof current.product.revisionId === 'string', 'Product revision is invalid.');
  current.product.revisionId = baseline.product.revisionId;
  if (current.product.label) {
    requireDemo(typeof current.product.label.text === 'string' && current.product.label.text.length <= 40
      && typeof current.product.label.subtitle === 'string' && current.product.label.subtitle.length <= 80,
    'Label text exceeds the supported length.');
    current.product.label.text = baseline.product.label.text;
    current.product.label.subtitle = baseline.product.label.subtitle;
  }

  const environment = current.environment;
  requireDemo(environment && equal(environment.plinth, baseline.environment.plinth)
    && equal(environment.props || [], baseline.environment.props || []) && environment.floorY === baseline.environment.floorY,
  'Editing objects, floor contact or scene geometry needs the connected backend.');
  requireDemo(vector(environment.worldColor) && environment.worldColor.every((n: number) => n >= 0 && n <= 1), 'World color is invalid.');
  if (environment.kind === 'authored') requireDemo(!environment.asset, 'Custom environment assets need the connected backend.');
  else {
    const world = bundle.bootstrap.worlds.find((entry: any) => equal(entry.environment.asset, environment.asset));
    requireDemo(environment.kind === 'mesh' && world, 'Choose one of the included offline environments.');
  }
  current.environment = baseline.environment;
  requireDemo(Array.isArray(current.actions) && current.actions.length === baseline.actions.length,
    'New mechanisms need the connected backend and documented component evidence.');
  const lastFrame = baseline.shots.at(-1).endFrame, fps = baseline.render.fps;
  for (let i = 0; i < current.actions.length; i++) {
    const action = current.actions[i];
    requireDemo(finite(action.startSeconds) && action.startSeconds >= 0 && finite(action.durationSeconds)
      && action.durationSeconds > 0 && action.startSeconds + action.durationSeconds <= (lastFrame - 1) / fps,
    'Cap movement must finish within the reel.');
    action.startSeconds = baseline.actions[i].startSeconds;
    action.durationSeconds = baseline.actions[i].durationSeconds;
  }
  requireDemo(Array.isArray(current.shots) && current.shots.length === baseline.shots.length,
    'Changing the shot sequence needs the connected backend.');
  for (let i = 0; i < current.shots.length; i++) {
    const camera = current.shots[i].camera;
    for (const end of ['from', 'to']) {
      const pose = camera?.[end];
      requireDemo(pose && vector(pose.positionM) && vector(pose.targetM) && finite(pose.focalLengthMm) && pose.focalLengthMm >= 1,
        'Choose finite camera coordinates and a positive focal length.');
    }
    const d0 = [0, 2].map(axis => camera.from.positionM[axis] - camera.from.targetM[axis]);
    const d1 = [0, 2].map(axis => camera.to.positionM[axis] - camera.to.targetM[axis]);
    const delta = d1.map((n, axis) => n - d0[axis]), denominator = delta.reduce((sum, n) => sum + n * n, 0);
    const u = denominator ? Math.max(0, Math.min(1, -d0.reduce((sum, n, axis) => sum + n * delta[axis], 0) / denominator)) : 0;
    requireDemo(d0.reduce((sum, n, axis) => sum + (n + u * delta[axis]) ** 2, 0) > 1e-10,
      'The camera move cannot cross a vertical or zero viewing direction.');
    current.shots[i].camera = baseline.shots[i].camera;
  }
  requireDemo(equal(current, baseline), 'Editing geometry, object placement or scene structure needs the connected backend.');
  return scene;
}

/** Evaluate supported cameras/cap timing from absolute time, matching film.scene. */
export async function evaluateDemoScene(scene: any, bundle: DemoBundle): Promise<any> {
  if (bundle.bootstrap.demo?.playbackMode === 'sampled') return sampledScene(scene, bundle);
  validatedScene(scene, bundle);
  const root = bundle.samples.objects.product;
  const frames = bundle.samples.frames.map((sample: any) => {
    const t = sample.timeSeconds, components: Record<string, any> = {};
    // The fixture's geometry and placement are fixed, so the product scale stays
    // the saved one; samples carry it like film.scene does.
    const scale = scene.placement.scale ?? 1;
    for (const component of scene.product.components) components[component.id] = {
      translationM: add(rotate(root.rotationXyzw, component.assembly.translationM), root.translationM),
      rotationXyzw: mul(root.rotationXyzw, component.assembly.rotationXyzw),
      scale: scale * (component.assembly.scale ?? 1),
    };
    for (const action of scene.actions) {
      const pose = components[action.componentId], u = smooth((t - action.startSeconds) / action.durationSeconds);
      const theta = action.type === 'lift' ? 0 : 2 * Math.PI * action.turns * action.directionSign * u;
      const distance = action.type === 'lift' ? action.distanceM * u : action.axialTravelPerRevolutionM * action.turns * u;
      const q = [...action.axis.map((n: number) => n * Math.sin(theta / 2)), Math.cos(theta / 2)];
      const rotated = rotate(q, action.pivotM);
      const offset = action.pivotM.map((n: number, axis: number) => n - rotated[axis] + action.axis[axis] * distance);
      pose.translationM = add(pose.translationM, rotate(pose.rotationXyzw, offset));
      pose.rotationXyzw = mul(pose.rotationXyzw, q);
    }
    const shot = scene.shots.find((entry: any) => sample.frame >= entry.startFrame && sample.frame <= entry.endFrame);
    const u = smooth((sample.frame - shot.startFrame) / Math.max(1, shot.endFrame - shot.startFrame));
    const before = shot.camera.from, after = shot.camera.to;
    const camera = Object.fromEntries(['positionM', 'targetM'].map(key => [key, before[key].map((n: number, i: number) => n + (after[key][i] - n) * u)]));
    camera.focalLengthMm = before.focalLengthMm + (after.focalLengthMm - before.focalLengthMm) * u;
    // Optical focus follows the edited camera, as in film.scene.evaluate.
    // An unchanged camera keeps Python's exact focus distance (math.dist rounding).
    const optics = shot.camera.depthOfField ?? {};
    const unchanged = equal([camera.positionM, camera.targetM], [sample.camera?.positionM, sample.camera?.targetM]);
    const distance = unchanged && sample.camera?.depthOfField ? sample.camera.depthOfField.focusDistanceM
      : Math.hypot(...camera.positionM.map((n: number, i: number) => n - camera.targetM[i]));
    camera.depthOfField = { enabled: optics.enabled ?? false, fStop: optics.fStop ?? 2.8, focusDistanceM: optics.focusDistanceM ?? distance };
    return { ...sample, components, camera };
  });
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(scene)));
  const digest = 'demo-' + Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  return { scene: copy(scene), frames, objects: copy(bundle.samples.objects), digest };
}

let loading: Promise<DemoBundle> | undefined;
async function demoBundle(): Promise<DemoBundle> {
  if (!loading) loading = Promise.all(['bootstrap.json', 'samples.json'].map(async filename => {
    const response = await fetch(demoDataUrl(filename), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('The browser demo files could not be loaded. Reload this page.');
    return response.json();
  })).then(([bootstrap, samples]) => ({ bootstrap, samples })).catch(error => { loading = undefined; throw error; });
  return loading;
}

export async function demoApi(path: string, method = 'GET', data?: any): Promise<any> {
  // Reject unsupported mutations before loading anything: a demo never POSTs.
  if (method !== 'GET' && !(method === 'POST' && path === '/api/evaluate'))
    throw new Error('Browser demo: this action needs the connected backend. Your current preview has not been saved or submitted.');
  if (method === 'GET' && ['/api/jobs', '/api/comparison-renders'].includes(path)) return [];
  if (method === 'GET' && path === '/api/worldlabs/status') return { configured: false };
  const bundle = await demoBundle();
  if (method === 'POST' && path === '/api/evaluate') {
    const result = await evaluateDemoScene(data?.scene, bundle);
    // Interactive transforms in the gesso editor request one visible frame.
    if (Number.isInteger(data?.frame)) return { scene: result.scene, sample: result.frames[Math.min(result.frames.length, Math.max(1, data.frame)) - 1], digest: result.digest };
    return result;
  }
  if (method === 'GET' && path === '/api/bootstrap') return copy(bundle.bootstrap);
  if (method === 'GET' && path === '/api/projects') return copy(bundle.bootstrap.projects);
  if (method === 'GET' && path === `/api/projects/${encodeURIComponent(bundle.bootstrap.project.id)}`) return copy(bundle.bootstrap.project);
  if (method === 'GET' && path === '/api/worlds') return copy(bundle.bootstrap.worlds);
  throw new Error('Browser demo: this action needs the connected backend. No server request was made.');
}
