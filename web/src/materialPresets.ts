import {partName} from './hierarchy';
import {MATERIAL_PRESETS, type MaterialSpecification} from './materials';
import {equalJson} from './state';

export type MaterialType = 'glass' | 'plastic' | 'metal' | 'ceramic' | 'rubber' | 'paper' | 'custom';
export type SavedMaterialPreset = {id: string; name: string; type: MaterialType; material: MaterialSpecification};
export type LibraryMaterialPreset = SavedMaterialPreset & {sourceComponentId?: string};

/** Starting points, independent of the saved materials in a campaign. */
export const materialTypes: {id: MaterialType; name: string; material: MaterialSpecification}[] = [
  ...MATERIAL_PRESETS.map(preset => ({...structuredClone(preset), id: preset.id as MaterialType})),
  {id: 'custom', name: 'Custom', material: {...structuredClone(MATERIAL_PRESETS[1].material), name: 'Custom'}},
];
const typeIds = new Set(materialTypes.map(type => type.id));
const mapNames = new Set(['basecolor', 'normal', 'roughness', 'metalness', 'height']);

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function finiteRange(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function validateMaterial(material: any): void {
  requireValue(material && typeof material === 'object' && !Array.isArray(material), 'A material specification is required.');
  requireValue(Array.isArray(material.baseColor) && material.baseColor.length === 4 && material.baseColor.every((value: unknown) => finiteRange(value, 0, 1)), 'Material color must have four values between 0 and 1.');
  for (const key of ['roughness', 'metallic', 'transmission']) {
    if (key === 'transmission' && !Object.hasOwn(material, key)) continue;
    requireValue(finiteRange(material[key], 0, 1), `Material ${key} must be between 0 and 1.`);
  }
  for (const [key, minimum, maximum] of [['ior', 1, 3], ['normalScale', 0, 4], ['heightScaleM', 0, .01]] as const) {
    if (Object.hasOwn(material, key)) requireValue(finiteRange(material[key], minimum, maximum), `Material ${key} is outside its supported range.`);
  }
  if (Object.hasOwn(material, 'textureRepeat')) requireValue(Array.isArray(material.textureRepeat) && material.textureRepeat.length === 2 && material.textureRepeat.every((value: unknown) => finiteRange(value, .01, 100)), 'Material texture repeat must have two values between 0.01 and 100.');
  if (Object.hasOwn(material, 'textures')) {
    requireValue(material.textures && typeof material.textures === 'object' && !Array.isArray(material.textures), 'Material textures must contain named PBR maps.');
    const entries = Object.entries(material.textures);
    requireValue(entries.length > 0 && entries.length <= mapNames.size, 'Material textures must contain named PBR maps.');
    for (const [channel, value] of entries) {
      const asset = value as any;
      requireValue(mapNames.has(channel), `Unsupported material texture channel: ${channel}.`);
      requireValue(asset && /^[a-f0-9]{64}$/.test(asset.sha256) && asset.format === 'png' && asset.path === `assets/${asset.sha256}.png`, 'Material maps must use content-addressed PNG assets.');
    }
  }
}
function validatePreset(preset: any): asserts preset is SavedMaterialPreset {
  requireValue(preset && typeof preset === 'object' && !Array.isArray(preset), 'A material preset is required.');
  requireValue(typeof preset.id === 'string' && !!preset.id.trim() && preset.id.length <= 120, 'A saved material preset needs its own ID of at most 120 characters.');
  requireValue(typeof preset.name === 'string' && !!preset.name && preset.name.length <= 140 && preset.name === preset.name.trim(), 'A material preset needs a name of 1–140 characters without surrounding whitespace.');
  requireValue(typeIds.has(preset.type), 'Choose a supported material type.');
  validateMaterial(preset.material);
}
function componentsOf(scene: any): any[] {
  requireValue(scene?.product && Array.isArray(scene.product.components), 'Product components are required.');
  const ids = new Set<string>();
  for (const component of scene.product.components) {
    requireValue(component && typeof component.id === 'string' && !!component.id && !ids.has(component.id), 'Product component IDs must be unique.');
    ids.add(component.id);
  }
  return scene.product.components;
}
function savedPresetsOf(scene: any): SavedMaterialPreset[] {
  const presets = scene.product.materialPresets ?? [];
  requireValue(Array.isArray(presets), 'Saved material presets must be a list.');
  const ids = new Set<string>();
  for (const preset of presets) {
    validatePreset(preset);
    requireValue(!ids.has(preset.id), 'Saved material preset IDs must be unique.');
    ids.add(preset.id);
  }
  return presets;
}
function editable(component: any): boolean {
  return ['box', 'cylinder'].includes(component.shape) || (component.shape === 'mesh' && component.materialOverride === true);
}
function inferType(material: MaterialSpecification): MaterialType {
  const named = MATERIAL_PRESETS.find(preset => material.name === preset.name);
  if (named) return named.id as MaterialType;
  const {name: _name, ...values} = material;
  return (MATERIAL_PRESETS.find(preset => {
    const {name: _presetName, ...defaults} = preset.material;
    return equalJson(values, defaults);
  })?.id as MaterialType | undefined) ?? 'custom';
}

/** Stable IDs retain the part identity; bounded suffixes resolve even imported-ID collisions. */
function virtualPresets(components: any[], saved: SavedMaterialPreset[]): LibraryMaterialPreset[] {
  const used = new Set(saved.map(preset => preset.id));
  return components.filter(component => !component.materialPresetId && editable(component)).map(component => {
    const direct = `component:${component.id}`;
    let hash = 2166136261;
    for (let index = 0; index < component.id.length; index++) hash = Math.imul(hash ^ component.id.charCodeAt(index), 16777619) >>> 0;
    const base = direct.length <= 120 ? direct : `component:${component.id.slice(0, 99)}:${hash.toString(16).padStart(8, '0')}`;
    let id = base, suffix = 1;
    while (used.has(id)) {
      const ending = `:${++suffix}`;
      id = base.slice(0, 120 - ending.length) + ending;
    }
    used.add(id);
    const materialName = typeof component.material.name === 'string' ? component.material.name.trim() : '';
    return {
      id, sourceComponentId: component.id,
      name: (materialName || `${partName(component.id)} material`).slice(0, 140),
      type: inferType(component.material), material: structuredClone(component.material),
    };
  });
}

/** Existing part materials remain independent until the user explicitly links them. */
export function campaignMaterialPresets(scene: any): LibraryMaterialPreset[] {
  const components = componentsOf(scene), saved = savedPresetsOf(scene);
  return [...structuredClone(saved), ...virtualPresets(components, saved)];
}

export function presetPartIds(scene: any, preset: LibraryMaterialPreset): string[] {
  const components = componentsOf(scene);
  return preset.sourceComponentId
    ? components.filter(component => component.id === preset.sourceComponentId && !component.materialPresetId).map(component => component.id)
    : components.filter(component => component.materialPresetId === preset.id).map(component => component.id);
}

/** First writes retain every existing editable material, including those about to be replaced. */
export function saveMaterialPreset(scene: any, preset: SavedMaterialPreset, assignIds: string[] = []): void {
  const components = componentsOf(scene), saved = savedPresetsOf(scene);
  validatePreset(preset);
  requireValue(Array.isArray(assignIds) && assignIds.every(id => typeof id === 'string' && components.some(component => component.id === id)), 'Material presets can only be assigned to product components.');
  const virtual = virtualPresets(components, saved);
  const materialized = new Map(virtual.map(item => [item.sourceComponentId!, item.id]));
  const ids = new Set(assignIds);
  const targets = components.filter(component => ids.has(component.id) || (component.materialPresetId ?? materialized.get(component.id)) === preset.id);
  requireValue(targets.every(editable), 'Enable the component material override before assigning a preset to an imported mesh.');
  // Prepare all records and snapshots before mutation so one invalid part cannot leave a partial library.
  const next = structuredClone(saved);
  const updates = new Map<any, {id: string; material: MaterialSpecification}>();
  for (const item of virtual) {
    const {sourceComponentId, ...record} = item;
    validatePreset(record);
    next.push(record);
    updates.set(components.find(component => component.id === sourceComponentId), {id: record.id, material: structuredClone(record.material)});
  }
  const snapshot: SavedMaterialPreset = {id: preset.id, name: preset.name, type: preset.type, material: structuredClone(preset.material)};
  const existing = next.findIndex(item => item.id === snapshot.id);
  if (existing < 0) next.push(snapshot);
  else next[existing] = snapshot;
  for (const component of targets) updates.set(component, {id: snapshot.id, material: structuredClone(snapshot.material)});
  scene.product.materialPresets = next;
  for (const [component, update] of updates) {
    component.materialPresetId = update.id;
    component.material = update.material;
  }
}

export function assignMaterialPreset(scene: any, presetId: string, componentId: string): void {
  componentsOf(scene);
  const preset = savedPresetsOf(scene).find(item => item.id === presetId);
  requireValue(preset, 'Choose a saved material preset before assigning it.');
  saveMaterialPreset(scene, preset, [componentId]);
}
