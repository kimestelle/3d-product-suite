import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import LabelMaterialPanel, {
  LABEL_MAX_BYTES, LABEL_FINISHES, SURFACE_FINISHES, defaultLabelMapping, dragLabelOffset,
  fitLabelMapping, hexToLinear, labelMaterial, labelPreviewStyle, labelTarget, labelUploadError,
  linearToHex, mappingDimensions, resizeLabel, type LabelMapping, type TextureAsset,
} from './LabelMaterialPanel';

const asset: TextureAsset = { format: 'png', path: 'assets/' + 'a'.repeat(64) + '.png', sha256: 'a'.repeat(64), widthPx: 1200, heightPx: 600 };
const file = { name: 'label.png', type: 'image/png', size: 1024 };
function scene(): any { return structuredClone(fixture); }
function markup(current: any, selected: string | null = 'product-root', uploadAvailable?: boolean) {
  return renderToStaticMarkup(<LabelMaterialPanel scene={current} selected={selected} onSelect={() => {}}
    onChange={() => {}} onUpload={async () => asset} onTemplate={() => {}} uploadAvailable={uploadAvailable}/>);
}
function artworkScene() {
  const current = scene();
  current.product.components[0].labelTexture = { asset, mapping: fitLabelMapping(current.product.components[0], asset), material: labelMaterial() };
  return current;
}

describe('label artwork preparation', () => {
  it('checks actual image choices and size before upload', () => {
    for (const name of ['art.PNG', 'art.jpg', 'art.JPEG']) expect(labelUploadError({ ...file, name, type: '' })).toBe('');
    expect(labelUploadError({ ...file, size: LABEL_MAX_BYTES })).toBe('');
    expect(labelUploadError({ ...file, size: LABEL_MAX_BYTES + 1 })).toContain('8 MiB');
    expect(labelUploadError({ ...file, size: 0 })).toContain('empty');
    expect(labelUploadError({ ...file, name: 'label.svg', type: 'image/svg+xml' })).toContain('PNG or JPEG');
    expect(labelUploadError({ ...file, type: 'image/svg+xml' })).toContain('PNG or JPEG');
  });

  it('selects the highlighted product component, then the existing label, then the first part', () => {
    const current = scene();
    expect(labelTarget(current, 'cap').id).toBe('cap');
    expect(labelTarget(current, 'world').id).toBe('label');
    delete current.product.label;
    expect(labelTarget(current, null).id).toBe('bottle-body');
    current.product.components = [];
    expect(labelTarget(current, null)).toBeUndefined();
    expect(markup(current)).toBe('');
  });

  it('fits artwork with its physical image aspect preserved instead of stretching it to a square', () => {
    const component = { shape: 'box', sizeM: [.06, .1, .04] };
    const mapping = fitLabelMapping(component, asset);
    expect(mapping.scale[0]).toBe(.7);
    const [w, h] = mappingDimensions(component, mapping);
    expect(mapping.scale[0] * w / (mapping.scale[1] * h)).toBeCloseTo(2);
    expect(mapping.offset).toEqual([0, 0]);
    const tall = fitLabelMapping(component, { ...asset, widthPx: 100, heightPx: 1000 });
    expect(tall.scale[1]).toBe(.9);
    expect(tall.scale[0] * w / (tall.scale[1] * h)).toBeCloseTo(.1);
  });

  it('uses correct projected dimensions for each face, wrap and original UV coordinates', () => {
    const component = { shape: 'box', sizeM: [2, 3, 4] };
    for (const face of ['front', 'back'] as const) expect(mappingDimensions(component, { mode: 'planar', face })).toEqual([2, 3]);
    for (const face of ['left', 'right'] as const) expect(mappingDimensions(component, { mode: 'planar', face })).toEqual([4, 3]);
    for (const face of ['top', 'bottom'] as const) expect(mappingDimensions(component, { mode: 'planar', face })).toEqual([2, 4]);
    expect(mappingDimensions(component, { mode: 'uv', face: 'front' })).toEqual([1, 1]);
    const cylinder = { shape: 'cylinder', sizeM: [2, 3, 2] };
    expect(defaultLabelMapping(cylinder).mode).toBe('cylindrical');
    expect(mappingDimensions(cylinder, defaultLabelMapping(cylinder))).toEqual([2 * Math.PI, 3]);
  });

  it('keeps image proportions while resizing and respects both size limits', () => {
    const mapping: LabelMapping = { ...defaultLabelMapping({}), scale: [.4, .2] };
    expect(resizeLabel(mapping, 0, .8, true).scale).toEqual([.8, .4]);
    expect(resizeLabel(mapping, 1, .1, true).scale).toEqual([.2, .1]);
    expect(resizeLabel(mapping, 0, .8, false).scale).toEqual([.8, .2]);
    expect(resizeLabel(mapping, 0, 100, true).scale).toEqual([10, 5]);
    expect(resizeLabel(mapping, 0, 0, true).scale).toEqual([.02, .01]);
    expect(mapping.scale).toEqual([.4, .2]);
  });

  it('uses upward V offsets and clamps drag placement to the schema range', () => {
    expect(dragLabelOffset([0, 0], 50, -30, 200, 100)).toEqual([.25, .3]);
    expect(dragLabelOffset([4.9, -4.9], 100, 100, 100, 100)).toEqual([5, -5]);
    expect(dragLabelOffset([0, 0], 0, 0, 0, 0)).toEqual([0, 0]);
  });

  it('previews rotation before anisotropic scale just as the renderers sample UVs', () => {
    const mapping: LabelMapping = { ...defaultLabelMapping({}), scale: [.4, .2], offset: [.1, -.2], rotationDegrees: 90 };
    const style = labelPreviewStyle(mapping, 2);
    expect(style.left).toBe('60%');
    expect(style.top).toBe('70%');
    expect(style.width).toBe('100%');
    expect(style.height).toBe('100%');
    expect(style.transform).toBe('translate(-50%, -50%) matrix(0,-0.1,0.8,0,0,0)');
    expect(labelPreviewStyle({ ...mapping, rotationDegrees: 0 }, 2).transform).toBe('translate(-50%, -50%) matrix(0.4,0,0,0.2,0,0)');
  });
});

describe('material finish controls', () => {
  it('converts display colors to linear materials without changing alpha', () => {
    const rgba = hexToLinear('#808080', .4);
    expect(rgba[0]).toBeCloseTo(.21586, 4);
    expect(rgba[3]).toBe(.4);
    for (const hex of ['#000000', '#ffffff', '#6799ab', '#808080']) expect(linearToHex(hexToLinear(hex))).toBe(hex);
  });

  it('offers opaque label coatings separately from transmissive product materials', () => {
    expect(LABEL_FINISHES.paper.roughness).toBeGreaterThan(LABEL_FINISHES.vinyl.roughness);
    expect(LABEL_FINISHES.foil.metallic).toBe(1);
    for (const finish of Object.values(LABEL_FINISHES)) expect(finish).not.toHaveProperty('transmission');
    expect(SURFACE_FINISHES.glass.transmission).toBe(1);
    expect(SURFACE_FINISHES.metal.metallic).toBe(1);
    expect(labelMaterial().baseColor).toEqual([1, 1, 1, 1]);
  });

  it('preserves original imported material on selection until the user explicitly customizes it', () => {
    const current = scene();
    current.product.components[0].shape = 'mesh';
    const before = JSON.stringify(current);
    const html = markup(current, 'bottle-body');
    expect(html).toContain('<option value="original" selected="">Original mesh materials</option>');
    expect(html).toContain('Original mesh materials are preserved');
    expect(html).not.toContain('aria-label="Surface color"');
    expect(JSON.stringify(current)).toBe(before);
    current.product.components[0].materialOverride = true;
    expect(markup(current, 'bottle-body')).toContain('aria-label="Surface color"');
    expect(markup(current, 'bottle-body')).toContain('Restore original mesh materials');
  });

  it('offers the guide and mapping before upload, and original UV mapping only for imported meshes', () => {
    const current = scene();
    const html = markup(current);
    expect(html).toContain('Download UV guide');
    expect(html).toContain('aria-label="Artwork mapping"');
    expect(html).toContain('Face projection');
    expect(html).toContain('Cylinder wrap');
    expect(html).not.toContain('Existing UVs');
    expect(html).not.toContain('Label placement preview');
    expect(html).toContain('aria-label="Label artwork file"');
    current.product.components[0].shape = 'mesh';
    expect(markup(current, 'bottle-body')).toContain('Existing UVs');
  });

  it('provides keyboard equivalent placement fields and separate label and product finishes', () => {
    const current = artworkScene();
    const before = JSON.stringify(current);
    const html = markup(current, 'bottle-body');
    expect(html).toContain('aria-label="Label placement preview"');
    for (const label of ['Artwork width (%)', 'Artwork height (%)', 'Position X (%)', 'Position Y (%)', 'Artwork rotation (°)', 'Artwork tint', 'Label opacity', 'Label roughness', 'Label metallic', 'Surface roughness', 'Surface metallic', 'Surface transmission', 'Index of refraction']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('Lock artwork proportions');
    expect(html).toContain('Matte paper');
    expect(html).toContain('Glossy vinyl');
    expect(html).toContain('Metallic foil');
    expect(html).toContain('Remove artwork');
    expect(html).toContain('/api/' + asset.path);
    expect(html).not.toContain('Label transmission');
    expect(JSON.stringify(current)).toBe(before);
  });

  it('disables backend uploads in the static demo while preserving sample artwork editing and guide downloads', () => {
    const html = markup(artworkScene(), 'bottle-body', false);
    const uploadInput = html.match(/<input[^>]*aria-label="Label artwork file"[^>]*>/)?.[0];
    expect(uploadInput).toContain('disabled=""');
    expect(uploadInput).toContain('aria-disabled="true"');
    expect(uploadInput).toContain('aria-describedby=');
    expect(html).toContain('Image uploads need a connected backend. Try the sample artwork and placement controls.');
    expect(html).toContain('aria-label="Label placement preview"');
    expect(html).toMatch(/<select aria-label="Artwork mapping">/);
    expect(html).toMatch(/<fieldset class="label-controls" aria-label="Artwork placement and finish">/);
    expect(html).toMatch(/<button type="button" class="wide">Download UV guide<\/button>/);
    expect(html).toContain('aria-label="Surface roughness"');
  });

  it('keeps uploads available by default for connected editors', () => {
    const html = markup(artworkScene(), 'bottle-body');
    const uploadInput = html.match(/<input[^>]*aria-label="Label artwork file"[^>]*>/)?.[0];
    expect(uploadInput).not.toContain('disabled=""');
    expect(uploadInput).toContain('aria-disabled="false"');
    expect(html).not.toContain('Image uploads need a connected backend.');
  });
});
