import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {MATERIAL_PRESETS} from './materials';
import {assignMaterialPreset, attachMaterialParts, campaignMaterialPresets, deleteMaterialPreset, materialOwner, materialTargets, materialTypes, presetPartIds, saveMaterialPreset, type SavedMaterialPreset} from './materialPresets';
import {sceneParts, type HierarchyPart} from './hierarchy';
import {commitHistory, createHistory, redoHistory, undoHistory} from './state';

const scene = (): any => structuredClone(fixture);
const preset = (): SavedMaterialPreset => ({id: 'custom-metal', name: 'Brushed aluminium', type: 'metal', material: structuredClone(MATERIAL_PRESETS[2].material)});
const png = {format: 'png' as const, sha256: 'a'.repeat(64), path: `assets/${'a'.repeat(64)}.png`};

describe('campaign material presets', () => {
  it('lists each unlinked part independently without changing legacy scene values', () => {
    const source = scene();
    source.product.components[1].material = structuredClone(source.product.components[0].material);
    const before = structuredClone(source), entries = campaignMaterialPresets(source);
    expect(entries).toHaveLength(4);
    expect(entries.map(entry => entry.id)).toEqual(source.product.components.map((part: any) => `component:${part.id}`));
    expect(entries[0].material).toEqual(entries[1].material);
    expect(presetPartIds(source, entries[0])).toEqual(['bottle-body']);
    entries[0].material.baseColor[0] = 1;
    expect(source).toEqual(before);
  });
  it('recognizes exact names and defaults without guessing sharing or replacing values', () => {
    const source = scene();
    source.product.components[0].material = {...structuredClone(MATERIAL_PRESETS[0].material), roughness: .7};
    source.product.components[1].material = {...structuredClone(MATERIAL_PRESETS[2].material), name: 'Custom chrome'};
    source.product.components[2].material = {...structuredClone(MATERIAL_PRESETS[2].material), name: 'Unknown surface', metallic: .51};
    const entries = campaignMaterialPresets(source);
    expect(entries.slice(0, 3).map(entry => entry.type)).toEqual(['glass', 'metal', 'custom']);
    expect(entries[0].material.roughness).toBe(.7);
    expect(materialTypes.map(type => type.id)).toEqual(['glass', 'plastic', 'metal', 'ceramic', 'rubber', 'paper', 'custom']);
  });
  it('saves an unassigned preset with independent maps and leaves the composition intact', () => {
    const source = scene(), before = structuredClone(source), material = preset();
    material.material.textures = {normal: structuredClone(png)}; material.material.textureRepeat = [2, 3];
    saveMaterialPreset(source, material);
    expect(presetPartIds(source, material)).toEqual([]);
    expect(source.product.components.map(({materialPresetId: _id, ...part}: any) => part)).toEqual(before.product.components);
    expect(source.product.components.map((part: any) => part.materialPresetId)).toEqual(before.product.components.map((part: any) => `component:${part.id}`));
    expect(source.environment).toEqual(before.environment);
    expect(source.actions).toEqual(before.actions);
    expect(source.cameras).toEqual(before.cameras);
    expect(source.product.materialPresets.find((item: SavedMaterialPreset) => item.id === material.id)).toEqual(material);
    material.material.textures.normal!.path = 'caller mutation';
    expect(source.product.materialPresets.find((item: SavedMaterialPreset) => item.id === material.id).material.textures.normal.path).toBe(png.path);
    expect(campaignMaterialPresets(source).find(item => item.id === material.id)?.material.textureRepeat).toEqual([2, 3]);
  });
  it('materializes all legacy parts with stable separate IDs and edits only the requested one', () => {
    const source = scene();
    source.product.components[1].material = structuredClone(source.product.components[0].material);
    const virtual = campaignMaterialPresets(source)[0];
    const saved: SavedMaterialPreset = {id: virtual.id, name: virtual.name, type: virtual.type, material: virtual.material};
    saveMaterialPreset(source, saved, [virtual.sourceComponentId!]);
    expect(presetPartIds(source, saved)).toEqual(['bottle-body']);
    expect(source.product.components[1].materialPresetId).toBe('component:neck');
    expect(campaignMaterialPresets(source).map(item => item.id)).toEqual(['component:bottle-body', 'component:neck', 'component:cap', 'component:label']);
    expect(source.product.components[0].material).toEqual(source.product.components[1].material);
  });
  it('updates every explicitly linked part, preserving independent snapshots and unrelated parts', () => {
    const source = scene(), original = structuredClone(source.product.components), material = preset();
    material.material.textures = {roughness: structuredClone(png)};
    saveMaterialPreset(source, material, ['bottle-body']);
    assignMaterialPreset(source, material.id, 'cap');
    const edited = structuredClone(material); edited.material.roughness = .66; edited.name = 'Satin aluminium';
    saveMaterialPreset(source, edited);
    expect(source.product.materialPresets.find((item: SavedMaterialPreset) => item.id === edited.id)).toEqual(edited);
    expect(presetPartIds(source, edited)).toEqual(['bottle-body', 'cap']);
    expect(source.product.components[0].material).toEqual(edited.material);
    expect(source.product.components[2].material).toEqual(edited.material);
    expect(source.product.components[1]).toEqual({...original[1], materialPresetId: 'component:neck'});
    expect(source.product.components[3]).toEqual({...original[3], materialPresetId: 'component:label'});
    source.product.components[0].material.textures.roughness.path = 'accidental mutation';
    expect(source.product.components[2].material.textures.roughness.path).toBe(png.path);
    expect(source.product.materialPresets.find((item: SavedMaterialPreset) => item.id === material.id).material.textures.roughness.path).toBe(png.path);
  });
  it('reassigns only the requested part and retains the previous saved preset', () => {
    const source = scene(), first = preset(), second = {...preset(), id: 'second', name: 'Other finish'};
    saveMaterialPreset(source, first, ['bottle-body', 'cap']); saveMaterialPreset(source, second);
    assignMaterialPreset(source, second.id, 'cap');
    expect(presetPartIds(source, first)).toEqual(['bottle-body']);
    expect(presetPartIds(source, second)).toEqual(['cap']);
    expect(source.product.materialPresets.map((entry: SavedMaterialPreset) => entry.id)).toEqual(['component:bottle-body', 'component:neck', 'component:cap', 'component:label', first.id, second.id]);
  });
  it('retains a legacy preset after replacement so it can be applied again', () => {
    const source = scene(), original = structuredClone(source.product.components[2].material), material = preset();
    saveMaterialPreset(source, material, ['cap']);
    const former = campaignMaterialPresets(source).find(item => item.id === 'component:cap')!;
    expect(former.material).toEqual(original);
    expect(former.sourceComponentId).toBeUndefined();
    expect(presetPartIds(source, former)).toEqual([]);
    assignMaterialPreset(source, former.id, 'cap');
    expect(source.product.components[2].material).toEqual(original);
    expect(presetPartIds(source, material)).toEqual([]);
  });
  it('bounds imported part IDs and avoids collisions with existing library IDs', () => {
    const source = scene();
    source.product.components[0].id = 'long-part-'.repeat(30);
    source.product.components[1].id = source.product.components[0].id + 'b';
    source.product.materialPresets = [{...preset(), id: 'component:cap'}];
    const before = campaignMaterialPresets(source);
    expect(new Set(before.map(item => item.id)).size).toBe(before.length);
    expect(before.every(item => item.id.length <= 120)).toBe(true);
    expect(before.find(item => item.sourceComponentId === 'cap')!.id).toBe('component:cap:2');
    saveMaterialPreset(source, {...preset(), id: 'new-preset'});
    expect(campaignMaterialPresets(source).slice(0, before.length).map(item => item.id)).toEqual(before.map(item => item.id));
    expect(source.product.materialPresets.every((item: any) => !Object.hasOwn(item, 'sourceComponentId'))).toBe(true);
  });
  it('does not materialize any legacy part when first-write validation fails', () => {
    const source = scene(), before = structuredClone(source);
    expect(() => saveMaterialPreset(source, preset(), ['missing'])).toThrow();
    expect(source).toEqual(before);
    source.product.components[3].material.roughness = NaN;
    const invalid = structuredClone(source);
    expect(() => saveMaterialPreset(source, preset(), ['cap'])).toThrow(/roughness/);
    expect(source).toEqual(invalid);
  });
  it('restores library records, links and snapshots through serialization, undo and redo', () => {
    const original = scene(), first = preset(), edited = structuredClone(original);
    saveMaterialPreset(edited, first, ['cap']);
    const stored = JSON.parse(JSON.stringify(edited)), history = commitHistory(createHistory(original), stored);
    expect(undoHistory(history).present).toEqual(original);
    expect(redoHistory(undoHistory(history)).present).toEqual(stored);
    expect(campaignMaterialPresets(stored).find(item => item.id === first.id)).toEqual(first);
    expect(presetPartIds(stored, first)).toEqual(['cap']);
  });
  it('requires explicit imported override and never assigns to source subnodes', () => {
    const source = scene(); source.product.components[0].shape = 'mesh';
    source.product.components[0].asset = {sha256: 'original', sourceDimensionsM: [.1, .2, .1]};
    const before = structuredClone(source), material = preset();
    expect(campaignMaterialPresets(source).some(item => item.sourceComponentId === 'bottle-body')).toBe(false);
    expect(() => saveMaterialPreset(source, material, ['cap', 'bottle-body'])).toThrow(/override/);
    expect(source).toEqual(before);
    expect(() => saveMaterialPreset(source, material, ['bottle-body:mesh:2'])).toThrow(/product components/);
    expect(source).toEqual(before);
    source.product.components[0].materialOverride = true;
    saveMaterialPreset(source, material, ['bottle-body']);
    expect(source.product.components[0].asset).toEqual(before.product.components[0].asset);
    expect(source.product.components[0].materialOverride).toBe(true);
  });
  it('accepts the exact persisted ID and name length limits', () => {
    const source = scene(), material = {...preset(), id: 'x'.repeat(120), name: 'N'.repeat(140)};
    saveMaterialPreset(source, material, ['cap']);
    expect(source.product.materialPresets.find((item: SavedMaterialPreset) => item.id === material.id)).toEqual(material);
    expect(presetPartIds(source, material)).toEqual(['cap']);
  });
  it('rejects invalid saves atomically, including linked imported materials with override disabled', () => {
    const source = scene(), material = preset(); saveMaterialPreset(source, material, ['cap']);
    source.product.components[2].shape = 'mesh'; source.product.components[2].materialOverride = false;
    const before = structuredClone(source);
    expect(() => saveMaterialPreset(source, {...material, name: 'Changed'})).toThrow(/override/);
    expect(source).toEqual(before);
    for (const invalid of [
      {...material, id: '  '}, {...material, id: 'x'.repeat(121)},
      {...material, name: ''}, {...material, name: 'x'.repeat(141)}, {...material, name: ' Padded name '}, {...material, type: 'wood'},
      {...material, material: {...material.material, roughness: NaN}},
      {...material, material: {...material.material, textureRepeat: [0, 1]}},
      {...material, material: {...material.material, textures: {normal: {...png, path: '../texture.png'}}}},
      {...material, material: {...material.material, textures: {unsupported: png}}},
    ]) expect(() => saveMaterialPreset(source, invalid as SavedMaterialPreset)).toThrow();
    expect(() => assignMaterialPreset(source, 'missing-preset', 'neck')).toThrow(/saved material preset/);
    expect(() => assignMaterialPreset(source, material.id, 'missing')).toThrow(/product components/);
    expect(source).toEqual(before);
  });
});

describe('material library assignments', () => {
  const imported = () => {
    const source = scene();
    const component = source.product.components[0];
    component.shape = 'mesh';component.materialOverride = false;
    const parts:HierarchyPart[] = [...sceneParts(source),
      {id:component.id+'::node:0',componentId:component.id,name:'Housing',sourceName:'housing',source:'glb',parentId:component.id,sourcePath:'nodes[0]',materialSlots:[{id:'slot0',name:'Paint'}]},
      {id:component.id+'::node:1',componentId:component.id,name:'Shade',sourceName:'shade',source:'glb',parentId:component.id+'::node:0',sourcePath:'nodes[1]',materialSlots:[{id:'slot0',name:'Paint'}]},
      {id:component.id+'::node:2',componentId:component.id,name:'Base',sourceName:'base',source:'glb',parentId:component.id,sourcePath:'nodes[2]',materialSlots:[{id:'slot1',name:'Chrome'}]},
    ];
    return {source,component,parts};
  };
  it('attaches a source section without replacing sibling or original component materials', () => {
    const {source,parts} = imported(); const original=structuredClone(source.product.components[0]);
    saveMaterialPreset(source,preset());
    attachMaterialParts(source,preset().id,['bottle-body::node:1'],parts);
    expect(source.product.components[0]).toEqual({...original,materialBindings:[{nodeIndex:1,materialPresetId:preset().id}]});
    expect(presetPartIds(source,preset())).toEqual(['bottle-body::node:1']);
    expect(materialOwner(source,parts,'bottle-body::node:1')).toBe(preset().id);
    expect(materialOwner(source,parts,'bottle-body::node:2')).toBeNull();
  });
  it('moves sections between presets and inherits through source ancestors', () => {
    const {source,parts} = imported();const second={...preset(),id:'second'};
    saveMaterialPreset(source,preset());saveMaterialPreset(source,second);
    attachMaterialParts(source,preset().id,['bottle-body::node:0'],parts);
    expect(materialOwner(source,parts,'bottle-body::node:1')).toBe(preset().id);
    attachMaterialParts(source,second.id,['bottle-body::node:1'],parts);
    expect(presetPartIds(source,second)).toEqual(['bottle-body::node:1']);
    expect(materialOwner(source,parts,'bottle-body::node:0')).toBe(preset().id);
    attachMaterialParts(source,second.id,['bottle-body::node:0'],parts);
    expect(source.product.components[0].materialBindings).toEqual([{nodeIndex:0,materialPresetId:second.id}]);
    expect(presetPartIds(source,preset())).toEqual([]);
  });
  it('attaches the whole imported object explicitly, replacing its section assignments', () => {
    const {source,parts} = imported();saveMaterialPreset(source,preset());
    attachMaterialParts(source,preset().id,['bottle-body::node:1'],parts);
    attachMaterialParts(source,preset().id,['bottle-body'],parts);
    expect(source.product.components[0].materialOverride).toBe(true);
    expect(source.product.components[0].materialBindings).toBeUndefined();
    expect(presetPartIds(source,preset())).toEqual(['bottle-body']);
  });
  it('materializes legacy materials and reassigns several parts atomically', () => {
    const source=scene(),parts=sceneParts(source),oldCap=structuredClone(source.product.components[2].material);
    const virtual=campaignMaterialPresets(source)[0];
    attachMaterialParts(source,virtual.id,['cap','neck'],parts);
    expect(presetPartIds(source,virtual)).toEqual(['bottle-body','neck','cap']);
    expect(campaignMaterialPresets(source).find(item=>item.id==='component:cap')?.material).toEqual(oldCap);
    const before=structuredClone(source);
    expect(()=>attachMaterialParts(source,virtual.id,['label','missing'],parts)).toThrow(/available/);
    expect(source).toEqual(before);
  });
  it('preserves assignment identities and material linkage through save, undo and redo', () => {
    const {source,parts}=imported();const before=structuredClone(source);saveMaterialPreset(source,preset());
    attachMaterialParts(source,preset().id,['bottle-body::node:1'],parts);
    saveMaterialPreset(source,{...preset(),material:{...preset().material,roughness:.75}});
    expect(materialOwner(source,parts,'bottle-body::node:1')).toBe(preset().id);
    const history=commitHistory(createHistory(before),JSON.parse(JSON.stringify(source)));
    expect(undoHistory(history).present).toEqual(before);
    expect(redoHistory(undoHistory(history)).present).toEqual(source);
    expect(materialTargets(source,parts).some(part=>part.id==='bottle-body::node:1')).toBe(true);
  });
});

describe('deleting material presets', () => {
  it('removes an unused saved preset without changing any product surface or other scene data', () => {
    const source = scene(); saveMaterialPreset(source, preset());
    const before = structuredClone(source);
    deleteMaterialPreset(source, preset().id);
    expect(source.product.components).toEqual(before.product.components);
    expect(source).toEqual({...before, product: {...before.product, materialPresets: before.product.materialPresets.filter((item: SavedMaterialPreset) => item.id !== preset().id)}});
    expect(campaignMaterialPresets(source).some(item => item.id === preset().id)).toBe(false);
  });

  it('moves linked primitives to one visible Neutral preset with independent snapshots', () => {
    const source = scene(); saveMaterialPreset(source, preset(), ['bottle-body', 'cap']);
    const before = structuredClone(source.product.components[1]);
    deleteMaterialPreset(source, preset().id);
    const fallback = campaignMaterialPresets(source).find(item => item.name === 'Neutral')!;
    expect(fallback).toMatchObject({id: 'default-neutral', type: 'custom', material: {baseColor: [.8, .8, .8, 1], roughness: .45, metallic: 0}});
    expect(presetPartIds(source, fallback)).toEqual(['bottle-body', 'cap']);
    expect(source.product.components[1]).toEqual(before);
    expect(campaignMaterialPresets(source).some(item => item.id === preset().id)).toBe(false);
    source.product.components[0].material.baseColor[0] = 0;
    expect(source.product.components[2].material.baseColor[0]).toBe(.8);
    expect(source.product.materialPresets.find((item: SavedMaterialPreset) => item.id === fallback.id).material.baseColor[0]).toBe(.8);
  });

  it('deletes virtual primitive entries permanently and reuses the Neutral fallback on another deletion', () => {
    const source = scene(), original = campaignMaterialPresets(source);
    deleteMaterialPreset(source, original[0].id);
    expect(campaignMaterialPresets(source).some(item => item.id === original[0].id)).toBe(false);
    expect(campaignMaterialPresets(source).filter(item => item.id !== 'default-neutral').map(item => item.id)).toEqual(original.slice(1).map(item => item.id));
    deleteMaterialPreset(source, original[2].id);
    const entries = campaignMaterialPresets(JSON.parse(JSON.stringify(source)));
    expect(entries.filter(item => item.name === 'Neutral')).toHaveLength(1);
    expect(presetPartIds(source, entries.find(item => item.id === 'default-neutral')!)).toEqual(['bottle-body', 'cap']);
    expect(entries.some(item => item.id === original[0].id || item.id === original[2].id)).toBe(false);
  });

  it('keeps deleting an attached Neutral preset valid without reviving its deleted ID', () => {
    const source = scene(); deleteMaterialPreset(source, 'component:bottle-body');
    deleteMaterialPreset(source, 'default-neutral');
    const entries = campaignMaterialPresets(source), fallback = entries.find(item => item.name === 'Neutral')!;
    expect(fallback.id).toBe('default-neutral:2');
    expect(entries.some(item => item.id === 'default-neutral')).toBe(false);
    expect(presetPartIds(source, fallback)).toEqual(['bottle-body']);
  });

  it('restores imported material for a virtual mesh override without creating a replacement library entry', () => {
    const source = scene(), root = source.product.components[0];
    root.shape = 'mesh'; root.materialOverride = true;
    root.asset = {sha256: 'unchanged geometry'};
    const before = structuredClone(root);
    deleteMaterialPreset(source, 'component:bottle-body');
    const updated = source.product.components[0];
    expect(updated.materialOverride).toBe(false);
    expect(updated.materialPresetId).toBeUndefined();
    expect(updated.asset).toEqual(before.asset);
    expect(updated.assembly).toEqual(before.assembly);
    expect(campaignMaterialPresets(source).some(item => item.id === 'component:bottle-body' || item.sourceComponentId === root.id)).toBe(false);
    expect(campaignMaterialPresets(source).some(item => item.name === 'Neutral')).toBe(false);
  });

  it('removes root and section assignments while preserving more-specific assignments to other materials', () => {
    const source = scene(), root = source.product.components[0];
    root.shape = 'mesh'; root.materialOverride = true;
    const other = {...preset(), id: 'other', name: 'Other finish'};
    saveMaterialPreset(source, preset(), [root.id]); saveMaterialPreset(source, other);
    root.materialBindings = [{nodeIndex: 0, materialPresetId: preset().id}, {nodeIndex: 1, materialPresetId: other.id}, {nodeIndex: 2, materialPresetId: preset().id}];
    deleteMaterialPreset(source, preset().id);
    expect(source.product.components[0].materialOverride).toBe(false);
    expect(source.product.components[0].materialPresetId).toBeUndefined();
    expect(source.product.components[0].materialBindings).toEqual([{nodeIndex: 1, materialPresetId: other.id}]);
    expect(presetPartIds(source, other)).toEqual(['bottle-body::node:1']);
    deleteMaterialPreset(source, other.id);
    expect(source.product.components[0].materialBindings).toBeUndefined();
  });

  it('lets a deleted section inherit its containing material', () => {
    const source = scene(), root = source.product.components[0];
    root.shape = 'mesh'; root.materialOverride = true;
    const other = {...preset(), id: 'other', name: 'Other finish'};
    saveMaterialPreset(source, preset(), [root.id]); saveMaterialPreset(source, other);
    root.materialBindings = [{nodeIndex: 0, materialPresetId: other.id}];
    const parts: HierarchyPart[] = [...sceneParts(source), {id: `${root.id}::node:0`, componentId: root.id, name: 'Housing', sourceName: 'housing', source: 'glb', parentId: root.id, sourcePath: 'nodes[0]', materialSlots: [{id: 'slot0', name: 'Paint'}]}];
    deleteMaterialPreset(source, other.id);
    expect(materialOwner(source, parts, `${root.id}::node:0`)).toBe(preset().id);
    expect(source.product.components[0].material).toEqual(preset().material);
  });

  it('rejects unknown IDs and invalid material graphs atomically', () => {
    const source = scene(); saveMaterialPreset(source, preset(), ['cap']);
    const before = structuredClone(source);
    expect(() => deleteMaterialPreset(source, 'missing')).toThrow(/no longer available/);
    expect(source).toEqual(before);
    const invalidScenes = [
      (item: any) => { item.product.components[0].material.roughness = NaN; },
      (item: any) => { item.product.components[2].materialPresetId = 'missing'; },
      (item: any) => { item.product.components[2].material.roughness = .91; },
      (item: any) => { item.product.components[2].shape = 'mesh'; item.product.components[2].materialOverride = false; },
      (item: any) => { item.product.components[0].materialBindings = []; },
      (item: any) => { item.product.components[0].shape = 'mesh'; item.product.components[0].materialOverride = true; item.product.components[0].materialBindings = [{nodeIndex: 0, materialPresetId: preset().id}, {nodeIndex: 0, materialPresetId: preset().id}]; },
      (item: any) => { item.product.components[0].shape = 'mesh'; item.product.components[0].materialOverride = true; item.product.components[0].materialBindings = [{nodeIndex: 0, materialPresetId: 'missing'}]; },
      (item: any) => { item.product.components[0].shape = 'mesh'; item.product.components[0].materialOverride = true; item.product.components[0].materialBindings = [{nodeIndex: -1, materialPresetId: preset().id}]; },
    ];
    for (const invalidate of invalidScenes) {
      const invalid = structuredClone(source); invalidate(invalid);
      const snapshot = structuredClone(invalid);
      expect(() => deleteMaterialPreset(invalid, preset().id)).toThrow();
      expect(invalid).toEqual(snapshot);
    }
  });

  it('restores records and all assignments through undo/redo and serialization', () => {
    const source = scene(); saveMaterialPreset(source, preset(), ['bottle-body', 'cap']);
    const before = structuredClone(source);
    deleteMaterialPreset(source, preset().id);
    const stored = JSON.parse(JSON.stringify(source)), history = commitHistory(createHistory(before), stored);
    expect(undoHistory(history).present).toEqual(before);
    expect(redoHistory(undoHistory(history)).present).toEqual(stored);
    expect(campaignMaterialPresets(stored).some(item => item.id === preset().id)).toBe(false);
  });
});
