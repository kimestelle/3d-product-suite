import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ProductImportForm, {
  PRODUCT_MESH_MAX_BYTES, productImportError, productImportQuery, productMeshFormat,
  type ProductImportDraft,
} from './ProductImportForm';

function draft(patch: Partial<ProductImportDraft> = {}): ProductImportDraft {
  return { name: 'Desk lamp', owner: 'Design studio', source: 'Manufacturer CAD export', reuseBasis: 'Company-owned asset',
    file: { name: 'lamp.obj', size: 1024 }, units: 'mm', sourceUp: 'Z', ...patch };
}

describe('product mesh import preparation', () => {
  it('accepts each supported mesh extension regardless of case', () => {
    for (const format of ['glb', 'obj', 'stl', 'ply']) {
      expect(productMeshFormat(`product.${format.toUpperCase()}`)).toBe(format);
      expect(productImportError(draft({ file: { name: `product.${format}`, size: 1024 } }), true)).toBe('');
    }
    expect(productMeshFormat('glb')).toBeUndefined();
    expect(productMeshFormat('product.glb.zip')).toBeUndefined();
  });

  it('requires a file and rejects empty, oversized, and native CAD files before upload', () => {
    expect(productImportError(draft({ file: null }), true)).toContain('Choose a GLB');
    expect(productImportError(draft({ file: { name: 'lamp.stl', size: 0 } }), true)).toContain('empty');
    expect(productImportError(draft({ file: { name: 'lamp.stl', size: PRODUCT_MESH_MAX_BYTES + 1 } }), true)).toContain('128 MiB');
    expect(productImportError(draft({ file: { name: 'lamp.stl', size: PRODUCT_MESH_MAX_BYTES } }), true)).toBe('');
    expect(productImportError(draft({ file: { name: 'lamp.step', size: 1024 } }), true)).toContain('Export native STEP / IGES');
  });

  it('requires deliberate source units and up axis for unitless meshes', () => {
    for (const format of ['obj', 'stl', 'ply']) {
      const mesh = { name: `lamp.${format}`, size: 1024 };
      expect(productImportError(draft({ file: mesh, units: '', sourceUp: '' }), true)).toContain('source units and up axis');
      expect(productImportError(draft({ file: mesh, sourceUp: '' }), true)).toContain('source units and up axis');
      expect(productImportError(draft({ file: mesh, units: '' }), true)).toContain('source units and up axis');
    }
  });

  it('keeps prepared GLB imports available without Blender or normalization selections', () => {
    const prepared = draft({ file: { name: 'lamp.GLB', size: 1024 }, units: '', sourceUp: '' });
    expect(productImportError(prepared, false)).toBe('');
    expect(Object.fromEntries(productImportQuery(prepared, false))).toEqual({
      name: 'Desk lamp', owner: 'Design studio', source: 'Manufacturer CAD export', reuseBasis: 'Company-owned asset',
    });
    // Values selected for a previous mesh must not transform an already-prepared GLB.
    expect(productImportQuery({ ...prepared, units: 'ft', sourceUp: 'Z' }, true).has('units')).toBe(false);
    expect(productImportQuery({ ...prepared, units: 'ft', sourceUp: 'Z' }, true).has('sourceUp')).toBe(false);
  });

  it('blocks non-GLB uploads without Blender and offers a usable alternative', () => {
    const error = productImportError(draft(), false);
    expect(error).toContain('Blender 4.3.2');
    expect(error).toContain('restart the app');
    expect(error).toContain('self-contained GLB');
    expect(() => productImportQuery(draft(), false)).toThrow(error);
  });

  it('preserves provenance and sends explicit source normalization settings', () => {
    for (const units of ['m', 'cm', 'mm', 'in', 'ft'] as const) {
      for (const sourceUp of ['Y', 'Z'] as const) {
        const query = productImportQuery(draft({ name: ' Desk lamp ', units, sourceUp }), true);
        expect(query.get('name')).toBe('Desk lamp');
        expect(query.get('owner')).toBe('Design studio');
        expect(query.get('source')).toBe('Manufacturer CAD export');
        expect(query.get('reuseBasis')).toBe('Company-owned asset');
        expect(query.get('units')).toBe(units);
        expect(query.get('sourceUp')).toBe(sourceUp);
      }
    }
  });

  it('rejects missing provenance rather than submitting whitespace', () => {
    for (const field of ['name', 'owner', 'source', 'reuseBasis'] as const) {
      expect(productImportError(draft({ [field]: '   ' }), true)).toContain('product name, owner, source');
      expect(() => productImportQuery(draft({ [field]: '   ' }), true)).toThrow();
    }
  });

  it('starts with a disabled submit, a mesh picker, and clear CAD / GLB requirements', () => {
    const html = renderToStaticMarkup(<ProductImportForm meshImportAvailable importing={false} onImport={async () => {}}/>);
    expect(html).toContain('aria-label="Product mesh file"');
    expect(html).toContain('accept=".glb,.obj,.stl,.ply"');
    expect(html).toContain('native STEP / IGES files are not supported yet');
    expect(html).toContain('in meters, Y-up, and centered');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import product<\/button>/);
    expect(html).not.toContain('Choose source units');
    expect(html).not.toContain('Choose up axis');
  });
});
