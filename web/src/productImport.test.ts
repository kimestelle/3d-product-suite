import {describe, expect, it} from 'vitest';
import {productImportKind, productImportNotice, productImportSettings, productMaterialFallbacks, productMaterialFallbackCount} from './productImport';

describe('product import settings', () => {
  it.each(['bottle.STEP', 'assembly.stp', 'surface.iges', 'part.IGS'])('uses the file units and chosen axis for %s', filename => {
    expect(productImportKind(filename)).toBe('cad');
    expect(productImportSettings(filename, 'z', '')).toEqual({sourceUp: 'z'});
    expect(productImportSettings(filename, 'y', 'mm')).toEqual({sourceUp: 'y'});
  });
  it.each(['part.STL', 'part.obj'])('requires an explicit unit choice for %s', filename => {
    expect(() => productImportSettings(filename, 'z', '')).toThrow('Choose the units');
    for (const sourceUnits of ['mm', 'cm', 'm', 'in', 'ft'] as const) {
      expect(productImportSettings(filename, 'y', sourceUnits)).toEqual({sourceUp: 'y', sourceUnits});
    }
  });
  it.each(['part.glb'])('does not override units or axes authored in %s', filename => {
    expect(productImportSettings(filename, 'z', 'mm')).toEqual({});
  });
  it('uses Blender file units by default and only overrides them when explicitly selected', () => {
    expect(productImportSettings('part.BLEND', 'z', '')).toEqual({});
    expect(productImportSettings('part.blend', 'y', 'mm')).toEqual({sourceUnits: 'mm'});
    expect(productImportSettings('part.blend', 'z', 'in')).toEqual({sourceUnits: 'in'});
  });
  it('rejects unsupported native CAD formats instead of presenting a successful empty upload', () => {
    expect(productImportKind('part.sldprt')).toBeNull();
    expect(() => productImportSettings('part.sldprt', 'z', 'mm')).toThrow('Choose a GLB');
  });
  it('surfaces format-specific import warnings without claiming OBJ materials were preserved', () => {
    expect(productImportNotice('part.obj', {meshImport: {warnings: ['OBJ materials were not imported.']}}))
      .toBe('OBJ geometry imported using the selected units. OBJ materials were not imported.');
    expect(productImportNotice('part.step', {cadImport: {warnings: ['One unsupported entity was skipped.']}}))
      .toContain('One unsupported entity was skipped.');
    expect(productImportNotice('part.blend', {blendImport: {warnings: ['Missing texture.']}})).toContain('Missing texture.');
    expect(productImportNotice('part.glb', {})).not.toContain('original');
  });
  it('retains readable material fallback records and tolerates older import reports', () => {
    const metadata = {blendImport: {materialFallbacks: [
      {name: 'Metal', reason: 'Unsupported shader group: Group.003.', fix: 'Bake to image textures connected to Principled BSDF, pack resources, then reimport.', objects: ['Cap', null]},
      null, {name: 'Invalid', reason: null},
    ]}};
    expect(productMaterialFallbacks(metadata)).toEqual([{name: 'Metal', reason: 'Unsupported shader group: Group.003.', fix: 'Bake to image textures connected to Principled BSDF, pack resources, then reimport.', objects: ['Cap']}]);
    expect(productMaterialFallbacks({blendImport: {warnings: []}})).toEqual([]);
    expect(productMaterialFallbacks(null)).toEqual([]);
    expect(productMaterialFallbackCount(metadata)).toBe(1);
    expect(productMaterialFallbackCount({blendImport: {...metadata.blendImport, materialFallbackCount: 201}})).toBe(201);
  });
});

// Existing heavy gallery assets remain valid, with an honest performance notice.
it('keeps generic geometry-budget notices for prepared GLBs', () => {
  expect(productImportNotice('ring.glb', {importDiagnostics: {warnings: ['Dense product: 2,190,747 vertices.', null]}}))
    .toBe('Product geometry and supported materials imported. Dense product: 2,190,747 vertices.');
});
