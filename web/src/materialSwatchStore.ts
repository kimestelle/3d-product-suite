import * as THREE from 'three';
import {createSurfaceMaterial, disposeSurfaceMaterial, loadMaterialTextures, type ImageAsset, type MaterialSpecification} from './materials';

export type SwatchPreviewState = 'loading' | 'ready' | 'failed' | 'stale';
type SwatchItem = {id: string; material: MaterialSpecification};
type Pending = {material: THREE.MeshPhysicalMaterial; key: string; abort: AbortController};
type Entry = {
  material: THREE.MeshPhysicalMaterial | null;
  specification: MaterialSpecification;
  surfaceKey: string;
  textureKey: string;
  state: SwatchPreviewState;
  pending: Pending | null;
};
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'bumpMap'] as const;
const textureKey = (specification: MaterialSpecification) => JSON.stringify(Object.entries(specification.textures || {}).sort(([a], [b]) => a.localeCompare(b)));

/** Scalar edits keep the same material, shader and decoded maps. Only shader
 * feature switches request recompilation; a slider normally changes uniforms. */
function updateSurface(material: THREE.MeshPhysicalMaterial, specification: MaterialSpecification): void {
  const rgba = specification.baseColor, transmission = specification.transmission ?? 0;
  const shaderChanged = material.transparent !== (rgba[3] < 1) || (material.transmission > 0) !== (transmission > 0);
  material.name = specification.name || '';
  material.color.setRGB(rgba[0], rgba[1], rgba[2], THREE.LinearSRGBColorSpace);
  material.roughness = specification.roughness;
  material.metalness = specification.metallic;
  material.opacity = rgba[3]; material.transparent = rgba[3] < 1;
  material.transmission = transmission; material.ior = specification.ior ?? 1.5;
  material.thickness = transmission ? .006 : 0;
  material.normalScale.setScalar(specification.normalScale ?? 1);
  material.bumpScale = specification.heightScaleM ?? 0;
  const repeat = specification.textureRepeat || [1, 1];
  for (const slot of MAP_SLOTS) material[slot]?.repeat.set(repeat[0], repeat[1]);
  if (shaderChanged) material.needsUpdate = true;
}

/** Material lifetime is independent from the WebGL canvas. New maps replace a
 * complete sample only after decoding; interrupted requests cannot publish. */
export function createMaterialSwatchStore(assetUrl: (asset: ImageAsset) => string, invalidate: () => void) {
  const entries = new Map<string, Entry>();
  let disposed = false;
  const cancelPending = (entry: Entry) => {
    entry.pending?.abort.abort();
    entry.pending = null;
  };
  const remove = (id: string, entry: Entry) => {
    cancelPending(entry);
    if (entry.material) disposeSurfaceMaterial(entry.material);
    entries.delete(id);
  };
  function prepare(entry: Entry, key: string) {
    const pending: Pending = {material: createSurfaceMaterial(entry.specification), key, abort: new AbortController()};
    entry.pending = pending;
    entry.state = entry.material ? 'ready' : 'loading';
    const current = () => !disposed && entry.pending === pending && !pending.abort.signal.aborted;
    let published = false;
    void loadMaterialTextures(pending.material, entry.specification, assetUrl, {signal: pending.abort.signal}).then(() => {
      if (!current()) return;
      // A slider may have moved while the same map was decoding.
      updateSurface(pending.material, entry.specification);
      if (entry.material) disposeSurfaceMaterial(entry.material);
      entry.material = pending.material; entry.textureKey = key;
      entry.pending = null; entry.state = 'ready'; published = true;
      invalidate();
    }).catch(() => {
      if (!current()) return;
      entry.pending = null; entry.state = entry.material ? 'stale' : 'failed';
      invalidate();
    }).finally(() => {
      if (!published) disposeSurfaceMaterial(pending.material);
    });
  }
  return {
    sync(items: SwatchItem[]) {
      if (disposed) return;
      const ids = new Set(items.map(item => item.id));
      let changed = false;
      for (const [id, entry] of entries) if (!ids.has(id)) {remove(id, entry); changed = true;}
      for (const item of items) {
        const key = JSON.stringify(item.material), mapsKey = textureKey(item.material);
        let entry = entries.get(item.id);
        if (entry?.surfaceKey === key) continue;
        changed = true;
        if (!entry) {
          entry = {material: null, specification: structuredClone(item.material), surfaceKey: key,
            textureKey: '', state: 'loading', pending: null};
          entries.set(item.id, entry);
        } else {
          entry.specification = structuredClone(item.material); entry.surfaceKey = key;
        }
        if (entry.material) updateSurface(entry.material, entry.specification);
        if (entry.pending?.key === mapsKey) {
          updateSurface(entry.pending.material, entry.specification);
          continue;
        }
        cancelPending(entry);
        if (entry.material && entry.textureKey === mapsKey) {
          entry.state = 'ready';
        } else if (mapsKey === '[]') {
          if (entry.material) disposeSurfaceMaterial(entry.material);
          entry.material = createSurfaceMaterial(entry.specification);
          entry.textureKey = mapsKey; entry.state = 'ready';
        } else prepare(entry, mapsKey);
      }
      if (changed) invalidate();
    },
    get(id: string) {return entries.get(id)?.material ?? null;},
    states(): Record<string, SwatchPreviewState> {
      return Object.fromEntries([...entries].map(([id, entry]) => [id, entry.state]));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [id, entry] of entries) remove(id, entry);
    },
  };
}
