import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import ProductPanel, {type ProductPanelProps} from './ProductPanel';
import {sceneParts} from './hierarchy';
import type {ProductDecal, UvLayout} from './decals';

function render(patch: Partial<ProductPanelProps> = {}) {
  const scene = structuredClone(fixture);
  const noop = () => {};
  return renderToStaticMarkup(<ProductPanel scene={scene} parts={sceneParts(scene)} partId="label" layer="Model"
    onSelect={noop} onChange={noop} onLayer={noop} focused={true} onToggleFocus={noop} onFrame={noop}
    hiddenParts={[]} onToggleVisibility={noop} onImport={noop} {...patch}/>);
}

describe('Product panel capability boundaries', () => {
  it('offers an editable name and uses saved aliases in the tree, parent and material assignments', () => {
    const scene = structuredClone(fixture) as any;
    scene.editorPartNames = {'bottle-body': 'Glass body', label: 'Front print', cap: 'Lid'};
    const html = render({scene});
    expect(html).toContain('aria-label="Object name"');
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('value="Front print"');
    expect(html).toContain('class="gesso-part-name">Front print</span>');
    expect(html).toContain('aria-label="Hide Front print"');
    expect(html).toContain('<dt>Parent</dt><dd>Glass body</dd>');
    expect(html).toContain('Double-click or press F2 to rename');
    expect(html).toContain('<span>Part details</span>');
    expect(html).toContain('<span>Objects</span>');
    const materials = render({scene, workspace: 'material', layer: 'Materials', partId: 'cap'});
    expect(materials).toContain('aria-label="Lid material"');
  });

  it('shows a reviewable fixture grouping and keyboard-operable part buttons immediately', () => {
    const html = render();
    expect(html).toContain('Keep grouping');
    expect(html).toContain('Change parent');
    expect(html).toContain('Restore source hierarchy');
    expect(html).toContain('Label lies on the body’s front surface.');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Hide Label"');
    expect(html).toContain('MORA bottle');
    expect(html.match(/class="gesso-part-row /g)).toHaveLength(4);
    // Product owns structure; surfaces and animation have their own workspaces.
    expect(html).toContain('aria-controls="product-section-Model"');
    for (const section of ['Materials', 'Decals', 'Animation']) expect(html).not.toContain(`aria-controls="product-section-${section}"`);
    expect(html).toContain('>Import</button>');
    expect(html.match(/class="gesso-section-toggle" aria-expanded="true"/g)).toHaveLength(1);
    expect(html).toContain('id="product-section-Model"');
    expect(html).not.toContain('id="product-section-Materials"');
  });

  it('uses readable fixture part names while retaining exact source IDs', () => {
    const parts = sceneParts(fixture).map(part => ({...part, name: part.id}));
    const html = render({parts});
    expect(html).toContain('class="gesso-part-name">Body</span>');
    expect(html).toContain('class="gesso-part-name">Label</span>');
    expect(html).toContain('>Source objects</button>');
    expect(html).toContain('class="gesso-status suggested">suggested</span>');
    expect(html).not.toContain('<dt>Structure</dt>');
    expect(parts.find(part => part.id === 'bottle-body')?.name).toBe('bottle-body');
  });

  it('opens the saved preset library with visible part assignments', () => {
    const html = render({workspace: 'material', layer: 'Materials', partId: 'cap'});
    expect(html).toContain('>Add new</button>');
    expect(html).not.toContain('>Edit preset</button>');
    expect(html).toContain('aria-label="Cap material"');
    expect(html).toContain('Saved with this campaign');
    expect(html).not.toContain('>Properties</button>');
    expect(html).not.toContain('>Mapping</button>');
    expect(html).not.toContain('Adjust surface');
  });

  it('keeps only the surface sections in Material with the full product visible', () => {
    const html = render({workspace: 'material', layer: 'Materials', partId: 'cap'});
    for (const section of ['Materials', 'Decals']) expect(html).toContain(`aria-controls="product-section-${section}"`);
    for (const section of ['Model', 'Animation']) expect(html).not.toContain(`aria-controls="product-section-${section}"`);
    expect(html).not.toContain('>Import</button>');
    expect(html).not.toContain('>Focus part</button>');
    expect(html).not.toContain('>Show assembly</button>');
    expect(html).not.toContain('>Frame</button>');
    expect(html).not.toContain('aria-label="Objects"');
    expect(html).toContain('gesso-material-swatches is-list');
  });

  it('retains mechanical limits and source evidence while removing duplicate timing controls', () => {
    const html = render({workspace: 'product', layer: 'Model', partId: 'cap'});
    expect(html).toContain('value="55"');
    expect(html).toContain('aria-label="Full travel"');
    expect(html).toContain('aria-label="Pivot X"');
    expect(html).toContain('aria-label="Movement axis"');
    expect(html).toContain('Synthetic lift-off fixture');
    expect(html).toContain('<dt>Parent</dt><dd>Top level</dd>');
    expect(html).not.toContain('<dt>Structure</dt>');
    expect(html).not.toContain('aria-label="Start time"');
    expect(html).not.toContain('aria-label="Duration"');
  });

  it('keeps Film animation selection without duplicating mechanics or the property editor', () => {
    const html = render({workspace: 'animation', layer: 'Animation', partId: 'cap', positionSpace: 'world'});
    expect(html).toContain('aria-label="Objects"');
    for (const field of ['Position', 'Rotation']) for (const axis of ['X', 'Y', 'Z']) expect(html).not.toContain(`aria-label="${field} ${axis}"`);
    expect(html).not.toContain('aria-label="Part scale"');
    expect(html).toContain('Position, rotation, scale + keyframes below.');
    expect(html).not.toContain('Mechanics');
    expect(html).not.toContain('aria-label="Full travel"');
    expect(html).not.toContain('>Import</button>');
    expect(html).not.toContain('id="product-section-Animation"');
    expect(html).not.toContain('id="product-section-Model"');
  });

  it('keeps the part tree available while editing a decal in source UV coordinates', () => {
    const scene = structuredClone(fixture) as any;
    const decal: ProductDecal = {id: 'label-print', componentId: 'label', partId: 'label', text: 'MORA', subtitle: 'BOTANICAL',
      centerUv: [.4, .6], sizeUv: [.8, .5], rotationDeg: 12, heightM: .0003, bevelM: .0001};
    scene.product.decals = [decal];
    const uvLayout: UvLayout = {partId: 'label', triangles: [[0, 0, 1, 0, 1, 1]], triangleCount: 1,
      missingUv: false, overlap: false, truncated: false};
    const html = render({scene, workspace: 'material', layer: 'Decals', decal, uvLayout});
    expect(html).toContain('aria-label="Objects"');
    for (const name of ['Body', 'Label', 'Neck', 'Cap']) {
      expect(html).toContain(`class="gesso-part-name">${name}</span>`);
      expect(html).toContain(`aria-label="Hide ${name}"`);
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*><span class="gesso-part-name">Label<\/span>/);
    for (const label of ['Decal text', 'Decal U', 'Decal V', 'Decal width', 'Decal UV height', 'Decal relief height', 'Decal bevel']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain('>Show assembly</button>');
    expect(html).toContain('>Frame</button>');
    expect(html).not.toContain('Artwork position Y');
  });

  it('offers imported sections in the material library without duplicating the product tree', () => {
    const scene = structuredClone(fixture) as any;
    scene.product.components = [{...scene.product.components[0], id: 'imported', shape: 'mesh'}];
    delete scene.product.label;
    const parts = [{id: 'imported', componentId: 'imported', name: 'Imported', sourceName: 'imported', source: 'scene' as const, parentId: null},
      {id: 'imported::node:0', sourcePath: 'nodes[0]', componentId: 'imported', name: 'Shell', sourceName: 'mesh_0', source: 'glb' as const, parentId: 'imported', materialSlots: [{id: 'slot-0', name: 'Shell lacquer'}]}];
    const materials = render({scene, parts, workspace: 'material', partId: 'imported::node:0', layer: 'Materials'});
    expect(materials).toContain('Original materials');
    expect(materials).toContain('>Shell</button>');
    expect(materials).toContain('draggable="true"');
    expect(materials).not.toContain('aria-label="Objects"');
    expect(materials).not.toContain('type="color"');
    const placement = render({scene, parts, workspace: 'animation', partId: 'imported::node:0', layer: 'Animation'});
    expect(placement).not.toContain('aria-label="Rotation X"');
    expect(placement).not.toContain('>Select imported</button>');
    expect(placement).not.toContain('aria-label="Full travel"');
    scene.editorPartNames = {'imported::node:0': 'Upper shell'};
    const structure = render({scene, parts, workspace: 'product', partId: 'imported::node:0', layer: 'Model'});
    expect(structure).toContain('aria-label="Object name"');
    expect(structure).toContain('value="Upper shell"');
    expect(parts[1].sourceName).toBe('mesh_0');
  });
});
