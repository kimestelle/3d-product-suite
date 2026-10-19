import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {commitHistory, createHistory, redoHistory, undoHistory} from './state';
import {canSuggestFixtureGrouping, changeParent, displayPartName, keepGrouping, orderedParts, parentCandidates, renamePart, resolveHierarchy, restoreSourceHierarchy, sceneParts, suggestFixtureGrouping, type HierarchyPart} from './hierarchy';

const source = () => structuredClone(fixture) as any;

describe('part display names', () => {
  it('persists aliases through save/reopen and undo/redo without changing render or animation data', () => {
    const scene = source(), parts = sceneParts(scene), originalParts = structuredClone(parts);
    let history = createHistory(scene);
    const edited = structuredClone(history.present);
    renamePart(edited, parts, 'cap', '  Lid  ');
    history = commitHistory(history, edited);
    const reopened = JSON.parse(JSON.stringify(history.present));
    expect(sceneParts(reopened).find(part => part.id === 'cap')?.name).toBe('Lid');
    expect(reopened.product).toEqual(scene.product);
    expect(reopened.actions).toEqual(scene.actions);
    expect(parts).toEqual(originalParts);
    history = undoHistory(history);
    expect(displayPartName(history.present, 'cap')).toBe('Cap');
    history = redoHistory(history);
    expect(displayPartName(history.present, 'cap')).toBe('Lid');
  });

  it('renames imported children independently and preserves names when restoring source grouping', () => {
    const scene = source();
    const parts: HierarchyPart[] = [
      ...sceneParts(scene),
      {id: 'cap::node:1', componentId: 'cap', name: 'source_solid_01', sourceName: 'source_solid_01', sourcePath: '/0/1', parentId: 'cap', source: 'glb'},
      {id: 'cap::node:2', componentId: 'cap', name: 'source_solid_02', sourceName: 'source_solid_02', sourcePath: '/0/2', parentId: 'cap', source: 'glb'},
    ];
    const originalParts = structuredClone(parts);
    renamePart(scene, parts, 'cap::node:1', 'Shell');
    renamePart(scene, parts, 'cap::node:2', 'Shell');
    changeParent(scene, parts, 'cap::node:2', 'cap::node:1');
    restoreSourceHierarchy(scene);
    expect(displayPartName(scene, 'cap::node:1', parts[4].name)).toBe('Shell');
    expect(displayPartName(scene, 'cap::node:2', parts[5].name)).toBe('Shell');
    expect(resolveHierarchy(scene, parts).parents['cap::node:2']).toBe('cap');
    expect(parts).toEqual(originalParts);
  });

  it('rejects empty, oversized and stale names without editing the scene', () => {
    const scene = source(), parts = sceneParts(scene), baseline = structuredClone(scene);
    for (const value of ['', '  ', 'x'.repeat(121)]) expect(() => renamePart(scene, parts, 'cap', value)).toThrow();
    expect(() => renamePart(scene, parts, 'missing', 'Lid')).toThrow('no longer available');
    renamePart(scene, parts, 'cap', 'Cap');
    expect(scene).toEqual(baseline);
    scene.product.components = scene.product.components.filter((part: any) => part.id !== 'cap');
    expect(() => renamePart(scene, parts, 'cap', 'Lid')).toThrow('no longer available');
  });

  it('uses source labels when stored display names are invalid', () => {
    for (const editorPartNames of [null, [], {cap: ''}, {cap: 7}, {cap: 'x'.repeat(121)}]) {
      expect(displayPartName({...source(), editorPartNames}, 'cap')).toBe('Cap');
    }
    expect(displayPartName(source(), 'cap::node:1', 'source_solid_01')).toBe('source_solid_01');
  });
});

describe('editor hierarchy', () => {
  it('starts the known fixture with a reviewable label grouping without rewriting source or motion', () => {
    const scene = source();
    const baseline = structuredClone(scene);
    const result = resolveHierarchy(scene, sceneParts(scene));
    expect(result.parents.label).toBe('bottle-body');
    expect(result.status.label).toBe('suggested');
    expect(result.sourceParents.label).toBeNull();
    expect(scene).toEqual(baseline);
    const ordered = orderedParts(sceneParts(scene), result.parents);
    expect(ordered.map(item => [item.part.id, item.depth])).toEqual([['bottle-body', 0], ['label', 1], ['neck', 0], ['cap', 0]]);
  });

  it('does not invent the fixture relation for an imported or unrelated product with similarly named parts', () => {
    const scene = source();
    scene.product.provenance.source = 'Manufacturer asset';
    expect(canSuggestFixtureGrouping(scene, sceneParts(scene))).toBe(false);
    suggestFixtureGrouping(scene, sceneParts(scene));
    expect(scene.editorHierarchy).toBeUndefined();
    expect(resolveHierarchy(scene, sceneParts(scene)).parents.label).toBeNull();
  });

  it('keeps, saves, reopens, undoes and redoes grouping independently from component fields', () => {
    const scene = source();
    const parts = sceneParts(scene);
    let history = createHistory(scene);
    const edited = structuredClone(history.present);
    keepGrouping(edited, parts, 'label');
    history = commitHistory(history, edited);
    const reopened = JSON.parse(JSON.stringify(history.present));
    expect(resolveHierarchy(reopened, parts).status.label).toBe('confirmed');
    expect(reopened.product).toEqual(scene.product);
    expect(reopened.actions).toEqual(scene.actions);
    history = undoHistory(history);
    expect(resolveHierarchy(history.present, parts).status.label).toBe('suggested');
    history = redoHistory(history);
    expect(resolveHierarchy(history.present, parts).status.label).toBe('confirmed');
  });

  it('restores only the hierarchy and keeps subsequent material, placement and movement changes', () => {
    const scene = source();
    const parts = sceneParts(scene);
    changeParent(scene, parts, 'neck', 'bottle-body');
    scene.product.components[0].material.roughness = .61;
    scene.product.components[1].assembly.translationM[1] = .12;
    scene.actions[0].distanceM = .07;
    const beforeRestore = structuredClone(scene);
    restoreSourceHierarchy(scene);
    expect(resolveHierarchy(scene, parts).parents).toEqual(Object.fromEntries(parts.map(part => [part.id, null])));
    expect(resolveHierarchy(scene, parts).status.label).toBe('source');
    expect(scene.product).toEqual(beforeRestore.product);
    expect(scene.actions).toEqual(beforeRestore.actions);
    expect(scene.placement).toEqual(beforeRestore.placement);
  });

  it('prevents self-parent and ancestor cycles without changing the scene', () => {
    const scene = source();
    const parts = sceneParts(scene);
    const baseline = structuredClone(scene);
    expect(() => changeParent(scene, parts, 'bottle-body', 'label')).toThrow('cannot contain');
    expect(() => changeParent(scene, parts, 'cap', 'cap')).toThrow('cannot contain');
    expect(() => changeParent(scene, parts, 'cap', 'missing')).toThrow('no longer');
    expect(scene).toEqual(baseline);
    expect(parentCandidates(scene, parts, 'bottle-body').map(part => part.id)).not.toContain('label');
    expect(parentCandidates(scene, parts, 'label').map(part => part.id)).toContain('bottle-body');
  });

  it('recovers stale IDs and malformed or cyclic stored overrides while retaining valid edits', () => {
    const scene = source();
    scene.editorHierarchy = {version: 1, overrides: {
      label: {parentId: 'bottle-body', status: 'confirmed'},
      'bottle-body': {parentId: 'label', status: 'edited'},
      cap: {parentId: 'removed-part', status: 'edited'},
      obsolete: {parentId: 'neck', status: 'edited'},
      neck: {parentId: 'bottle-body', status: 'edited'},
    }};
    const resolved = resolveHierarchy(scene, sceneParts(scene));
    expect(resolved.parents).toEqual({'bottle-body': null, label: 'bottle-body', cap: null, neck: 'bottle-body'});
    expect(resolved.status.neck).toBe('edited');
    expect(resolved.recovered).toBe(3);
  });

  it('retains original GLB node parents even after editorial reparenting', () => {
    const scene = source();
    scene.product.provenance.source = 'GLB source';
    const parts: HierarchyPart[] = [
      {id: 'product', componentId: 'product', name: 'Product', sourceName: 'product', parentId: null, source: 'scene'},
      {id: 'product/0', componentId: 'product', name: 'Shell', sourceName: 'mesh_0', sourcePath: '/0', parentId: 'product', source: 'glb'},
      {id: 'product/1', componentId: 'product', name: 'Insert', sourceName: 'mesh_1', sourcePath: '/1', parentId: 'product', source: 'glb'},
    ];
    changeParent(scene, parts, 'product/1', 'product/0');
    const resolved = resolveHierarchy(scene, parts);
    expect(resolved.parents['product/1']).toBe('product/0');
    expect(resolved.sourceParents['product/1']).toBe('product');
    expect(parts[2].parentId).toBe('product');
    restoreSourceHierarchy(scene);
    expect(resolveHierarchy(scene, parts).parents['product/1']).toBe('product');
  });

  it('does not overwrite accepted or edited relations when suggestions are requested again', () => {
    const scene = source();
    const parts = sceneParts(scene);
    changeParent(scene, parts, 'label', 'cap');
    const before = structuredClone(scene);
    suggestFixtureGrouping(scene, parts);
    expect(scene).toEqual(before);
  });
});
