import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {DecalControls, UvDecalOverlay, decalForPart, newDecal, uvPointFromClient, decalDragOffset} from './DecalEditor';
import type {ProductDecal, UvLayout} from './decals';

const noop = () => {};
const layout: UvLayout = {partId: 'cap', triangles: [[0, 0, 1, 0, 1, 1]], triangleCount: 1,
  missingUv: false, overlap: false, truncated: false, suggestedCenterUv: [.3, .7], suggestedSizeUv: [.25, .15]};
const decal: ProductDecal = {id: 'cap-mark', componentId: 'cap', partId: 'cap', text: 'MORA', subtitle: 'BOTANICAL',
  centerUv: [.25, .75], sizeUv: [.4, .3], rotationDeg: -15, heightM: .0004, bevelM: .00015};

function input(html: string, name: string) {
  const tag = html.match(new RegExp(`<input[^>]*aria-label="${name}"[^>]*>`))?.[0];
  expect(tag, `${name} is an accessible input`).toBeDefined();
  return tag!;
}
function expectMeasuredInput(html: string, name: string, value: string, unit: string) {
  const tag = input(html, name);
  expect(tag).toContain(`value="${value}"`);
  const description = tag.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(description, `${name} exposes its unit to assistive technology`).toBeDefined();
  expect(html).toContain(`id="${description}">${unit}</span>`);
}

describe('Decal selection and creation', () => {
  it('keeps a selected decal within its part and recovers when that decal is removed', () => {
    const other = {...decal, id: 'body-mark', componentId: 'bottle-body', partId: 'bottle-body'};
    const second = {...decal, id: 'cap-second'};
    const scene = {product: {decals: [other, decal, second]}};
    expect(decalForPart(scene, 'cap', 'cap-second')).toBe(second);
    expect(decalForPart(scene, 'cap', 'body-mark')).toBe(decal);
    expect(decalForPart(scene, 'cap', 'removed-mark')).toBe(decal);
    expect(decalForPart(scene, 'label', 'cap-mark')).toBeUndefined();
    expect(decalForPart(scene, null, 'cap-mark')).toBeUndefined();
    expect(decalForPart({product: {}}, 'cap', null)).toBeUndefined();
  });

  it('uses the selected source node and its usable UV region without replacing existing artwork', () => {
    const scene = structuredClone(fixture);
    const before = structuredClone(scene);
    const importedLayout = {...layout, partId: 'product::node:7'};
    const created = newDecal(scene, importedLayout.partId, 'product', importedLayout);
    expect(created.partId).toBe('product::node:7');
    expect(created.componentId).toBe('product');
    expect(created.text).toBe(scene.product.label.text);
    expect(created.centerUv).toEqual([.3, .7]);
    expect(created.sizeUv).toEqual([.25, .15]);
    expect(created.heightM).toBeGreaterThan(0);
    expect(created.bevelM).toBeLessThanOrEqual(created.heightM / 2);
    expect(newDecal(scene, importedLayout.partId, 'product', importedLayout).id).not.toBe(created.id);
    expect(scene).toEqual(before);
  });

  it('has a usable centered default for a product without fixture artwork or a suggested region', () => {
    const bareLayout: UvLayout = {...layout, suggestedCenterUv: undefined, suggestedSizeUv: undefined};
    const created = newDecal({product: {}}, 'cap', 'cap', bareLayout);
    expect(created.text).toBe('gesso');
    expect(created.subtitle).toBe('');
    expect(created.centerUv).toEqual([.5, .5]);
    expect(created.sizeUv.every(value => value > 0 && value <= 1)).toBe(true);
  });
});

describe('Decal controls', () => {
  it('distinguishes UV percentages from physical relief and exposes their units', () => {
    const html = renderToStaticMarkup(<DecalControls scene={{product: {decals: [decal]}}} partId="cap"
      decal={decal} layout={layout} onSelect={noop} onAdd={noop} onChange={noop}/>);
    expectMeasuredInput(html, 'Decal U', '25', '%');
    expectMeasuredInput(html, 'Decal V', '75', '%');
    expectMeasuredInput(html, 'Decal width', '40', '%');
    expectMeasuredInput(html, 'Decal UV height', '30', '%');
    expectMeasuredInput(html, 'Decal rotation', '-15', '°');
    expectMeasuredInput(html, 'Decal relief height', '0.4', 'mm');
    expectMeasuredInput(html, 'Decal bevel', '0.15', 'mm');
    expect(input(html, 'Decal bevel')).toContain('max="0.2"');
    expect(input(html, 'Decal text')).toContain('value="MORA"');
    expect(input(html, 'Decal descriptor')).toContain('value="BOTANICAL"');
  });

  it.each([
    ['missing UV attributes', {...layout, missingUv: true}],
    ['no usable triangles', {...layout, triangleCount: 0, triangles: []}],
  ])('prevents adding artwork to %s', (_, unavailable) => {
    const html = renderToStaticMarkup(<DecalControls scene={{product: {}}} partId="cap"
      layout={unavailable} onSelect={noop} onAdd={noop} onChange={noop}/>);
    expect(html).toContain('This part has no usable UVs. Select a mesh with UVs in the tree.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add decal<\/button>/);
    expect(html).not.toContain('aria-label="Decal U"');
  });

  it('distinguishes loading from an absent UV map', () => {
    const html = renderToStaticMarkup(<DecalControls scene={{product: {}}} partId="cap"
      layout={null} onSelect={noop} onAdd={noop} onChange={noop}/>);
    expect(html).toContain('Loading this part’s UVs…');
    expect(html).not.toContain('no usable UVs');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add decal<\/button>/);
  });
});

describe('UV overlay accessibility and source limits', () => {
  it('provides a named keyboard target and distinguishes shared UVs from a unique unwrap', () => {
    const html = renderToStaticMarkup(<UvDecalOverlay layout={{...layout, overlap: true, truncated: true}}
      decal={decal} partName="Cap" onPlace={noop} onAdd={noop}/>);
    expect(html).toContain('aria-label="Decal position on Cap UV map"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('Drag decal to place · drag elsewhere to orbit · arrows to nudge');
    expect(html).toContain('Shared UVs repeat artwork across faces.');
    expect(html).toContain('Wireframe simplified for this view.');
    expect(html).toContain('aria-label="Collapse UV map"');
  });

  it('shows an unavailable map without offering placement or an add action', () => {
    const html = renderToStaticMarkup(<UvDecalOverlay layout={{...layout, missingUv: true, triangles: [], triangleCount: 0}}
      partName="Shell" onPlace={noop} onAdd={noop}/>);
    expect(html).toContain('No usable UVs on this part');
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toContain('>Add decal</button>');
    expect(html).not.toContain('gesso-uv-artwork');
  });
});


describe('UV pointer correspondence', () => {
  it('uses the same centered square and upward V axis as the SVG map', () => {
    const landscape = {left: 100, top: 50, width: 800, height: 400};
    expect(uvPointFromClient(400, 150, landscape)).toEqual([.25, .75]);
    expect(uvPointFromClient(300, 450, landscape)).toEqual([0, 0]);
    expect(uvPointFromClient(700, 50, landscape)).toEqual([1, 1]);
    const portrait = {left: 100, top: 50, width: 400, height: 800};
    expect(uvPointFromClient(200, 350, portrait)).toEqual([.25, .75]);
  });

  it('does not report a surface at the edge when hovering letterboxed or outside space', () => {
    const bounds = {left: 100, top: 50, width: 800, height: 400};
    expect(uvPointFromClient(250, 250, bounds)).toBeNull();
    expect(uvPointFromClient(750, 250, bounds)).toBeNull();
    expect(uvPointFromClient(500, 49, bounds)).toBeNull();
    expect(uvPointFromClient(500, 451, bounds)).toBeNull();
  });

  it('allows a captured decal drag to stop at the tile boundary without turning hover into a false hit', () => {
    const bounds = {left: 100, top: 50, width: 800, height: 400};
    expect(uvPointFromClient(200, 550, bounds, true)).toEqual([0, 0]);
    expect(uvPointFromClient(800, 0, bounds, true)).toEqual([1, 1]);
    expect(uvPointFromClient(200, 550, bounds)).toBeNull();
  });

  it('ignores hidden viewports and invalid pointer coordinates', () => {
    expect(uvPointFromClient(0, 0, {left: 0, top: 0, width: 0, height: 400})).toBeNull();
    expect(uvPointFromClient(NaN, 0, {left: 0, top: 0, width: 400, height: 400})).toBeNull();
  });
});


describe('Decal gesture ownership', () => {
  it('only claims the artwork, preserving the grab offset instead of jumping to an empty UV point', () => {
    const mark = {...decal, rotationDeg: 0};
    expect(decalDragOffset([.3, .8], mark)?.[0]).toBeCloseTo(.05);
    expect(decalDragOffset([.3, .8], mark)?.[1]).toBeCloseTo(.05);
    expect(decalDragOffset([.5, .75], mark)).toBeNull();
    expect(decalDragOffset([.25, .95], mark)).toBeNull();
  });

  it('hits the rotated decal footprint rather than its unrotated box', () => {
    const mark = {...decal, centerUv: [.5, .5] as [number, number], sizeUv: [.6, .1] as [number, number], rotationDeg: 45};
    expect(decalDragOffset([.65, .65], mark)).not.toBeNull();
    expect(decalDragOffset([.7, .5], mark)).toBeNull();
    expect(decalDragOffset([.7, .3], mark)).toBeNull();
  });
});
