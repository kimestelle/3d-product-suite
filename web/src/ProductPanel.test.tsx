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
    expect(html).toContain('<dt>Structure</dt><dd>Suggested</dd>');
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
    expect(html).toContain('>Frame</button>');
  });

  it('retains mechanical limits and source evidence while removing duplicate timing controls', () => {
    const html = render({workspace: 'product', layer: 'Model', partId: 'cap'});
    expect(html).toContain('value="55"');
    expect(html).toContain('aria-label="Full travel"');
    expect(html).toContain('aria-label="Pivot X"');
    expect(html).toContain('aria-label="Movement axis"');
    expect(html).toContain('Synthetic lift-off fixture');
    expect(html).not.toContain('aria-label="Start time"');
    expect(html).not.toContain('aria-label="Duration"');
  });

  it('keeps Film animation selection without duplicating mechanics or the property editor', () => {
    const html = render({workspace: 'animation', layer: 'Animation', partId: 'cap', positionSpace: 'world'});
    expect(html).toContain('aria-label="Product parts"');
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
    expect(html).toContain('aria-label="Product parts"');
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

  it('does not expose per-node edits that the component-based scene contract cannot save', () => {
    const scene = structuredClone(fixture) as any;
    scene.product.components = [{...scene.product.components[0], id: 'imported', shape: 'mesh'}];
    delete scene.product.label;
    const parts = [{id: 'imported', componentId: 'imported', name: 'Imported', sourceName: 'imported', source: 'scene' as const, parentId: null},
      {id: 'imported/0', componentId: 'imported', name: 'Shell', sourceName: 'mesh_0', source: 'glb' as const, parentId: 'imported', materialSlots: [{id: 'slot-0', name: 'Shell lacquer'}]}];
    const materials = render({scene, parts, workspace: 'material', partId: 'imported/0', layer: 'Materials'});
    expect(materials).toContain('Shell lacquer');
    expect(materials).toContain('Per-node material editing is not available yet.');
    expect(materials).not.toContain('type="color"');
    const placement = render({scene, parts, workspace: 'animation', partId: 'imported/0', layer: 'Animation'});
    expect(placement).not.toContain('aria-label="Rotation X"');
    expect(placement).toContain('>Select imported</button>');
    expect(placement).not.toContain('aria-label="Full travel"');
  });
});
