import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import ProductPanel, {type ProductPanelProps} from './ProductPanel';
import {sceneParts} from './hierarchy';
import type {ProductDecal, UvLayout} from './decals';

function parentSelect(html: string) {
  const control = html.match(/<select[^>]*aria-label="Parent"[^>]*>[\s\S]*?<\/select>/)?.[0];
  expect(control).toBeDefined();
  return control!;
}

function render(patch: Partial<ProductPanelProps> = {}) {
  const scene = structuredClone(fixture);
  const noop = () => {};
  return renderToStaticMarkup(<ProductPanel scene={scene} parts={sceneParts(scene)} partId="label" layer="Model"
    onSelect={noop} onChange={noop} onLayer={noop} focused={true} onToggleFocus={noop} onFrame={noop}
    hiddenParts={[]} onToggleVisibility={noop} onImport={noop} {...patch}/>);
}

describe('Product panel capability boundaries', () => {
  it('offers part menus and keeps removed objects out of the tree and material assignments', () => {
    const scene = structuredClone(fixture) as any;
    expect(render()).toContain('aria-label="Part options: Cap"');
    scene.product.removedPartIds = ['cap'];
    const html = render({scene,partId:'cap'});
    expect(html).not.toContain('aria-label="Part options: Cap"');
    expect(html).not.toContain('aria-label="Hide Cap"');
    expect(html).not.toContain('value="Cap"');
    const materials=render({scene,workspace:'material',layer:'Materials'});
    expect(materials).toContain('aria-label="Cap material"'); // Reusable finish is retained.
    expect(materials).not.toContain('title="Cap"'); // Removed object is not assignable.
    scene.product.removedPartIds = scene.product.components.map((part:any)=>part.id);
    const empty = render({scene});
    expect(empty).toContain('All parts removed. Undo to restore them.');
    expect(empty).toContain('Import product…');
    expect(empty).not.toContain('Loading product parts');
  });

  it('keeps material fallback notes available in Product and Material without blocking the controls', () => {
    const scene = structuredClone(fixture) as any;
    scene.product.metadata = {blendImport: {materialFallbacks: [{name: 'Metal', reason: 'Unsupported shader group: Group.003.', fix: 'Bake to image textures connected to Principled BSDF, pack resources, then reimport.', objects: ['Cap']}]}};
    for (const workspace of ['product', 'material'] as const) {
      const html = render({scene, workspace});
      expect(html).toContain('Import notes');
      expect(html).toContain('1 material replaced');
      expect(html).toContain('<strong>Metal</strong>');
      expect(html).toContain('Group.003');
      expect(html).toContain('Assign replacements in Material.');
      expect(html).toContain('To keep the original finish: Bake to image textures connected to Principled BSDF, pack resources, then reimport.');
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('product-import-notes" open');
    }
    expect(render()).not.toContain('Import notes');
  });
  it('offers an editable name and uses saved aliases in the tree, parent and material assignments', () => {
    const scene = structuredClone(fixture) as any;
    scene.editorPartNames = {'bottle-body': 'Glass body', label: 'Front print', cap: 'Lid'};
    const html = render({scene});
    expect(html).toContain('aria-label="Object name"');
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('value="Front print"');
    expect(html).toContain('class="gesso-part-name">Front print</span>');
    expect(html).toContain('aria-label="Hide Front print"');
    expect(parentSelect(html)).toContain('<option value="bottle-body" selected="">Glass body</option>');
    expect(html).toContain('Double-click or press F2 to rename');
    expect(html).toContain('<span class="gesso-section-label">Part details</span>');
    expect(html).toContain('<span class="gesso-section-label">Objects</span>');
    const materials = render({scene, workspace: 'material', layer: 'Materials', partId: 'cap'});
    expect(materials).toContain('aria-label="Lid material"');
  });

  it('shows a reviewable fixture grouping and keyboard-operable part buttons immediately', () => {
    const html = render();
    expect(html).toContain('Keep grouping');
    expect(parentSelect(html)).toContain('<option value="bottle-body" selected="">Body</option>');
    expect(html).not.toContain('Organize…');
    expect(html).not.toContain('File details…');
    expect(html).toContain('Label lies on the body’s front surface.');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Hide Label"');
    expect(html).toContain('MORA bottle');
    expect(html.match(/class="gesso-part-row /g)).toHaveLength(4);
    // Model keeps structure separate from Product's surfaces and Film animation.
    expect(html).toContain('aria-controls="product-section-Model"');
    for (const section of ['Materials', 'Decals', 'Animation']) expect(html).not.toContain(`aria-controls="product-section-${section}"`);
    expect(html).toContain('>Import</button>');
    expect(html.match(/class="gesso-section-toggle gesso-section-selector" aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('id="product-section-Model"');
    expect(html).not.toContain('id="product-section-Materials"');
  });

  it('shows only the active material section without duplicating layer navigation', () => {
    for (const layer of ['Materials', 'Decals'] as const) {
      const html = render({workspace: 'material', layer});
      const other = layer === 'Materials' ? 'Decals' : 'Materials';
      expect(html).toContain(`aria-labelledby="product-section-${layer}-heading"`);
      expect(html).toContain(`id="product-section-${layer}-heading">${layer === 'Materials' ? 'Library' : 'Decals'}</span>`);
      expect(html).toContain(`id="product-section-${layer}"`);
      expect(html).not.toContain(`id="product-section-${other}"`);
      expect(html).not.toContain('gesso-section-selector');
      expect(html).not.toContain(`aria-controls="product-section-${layer}"`);
      expect(html).not.toContain('Option / Alt');
    }
  });

  it('retains genuine tree and mechanism disclosures in Model', () => {
    const product = render({partId: 'cap'});
    const detailsSelector = product.match(/<button[^>]*class="gesso-section-toggle gesso-section-selector"[\s\S]*?<\/button>/)![0];
    expect(detailsSelector).toContain('aria-current="true"');
    expect(detailsSelector).not.toContain('aria-expanded');
    expect(detailsSelector).not.toContain('gesso-ui-icon');
    expect(product).toContain('class="gesso-tree-toggle"');
    expect(product).toMatch(/class="gesso-tree-toggle"[^>]*aria-expanded="true"[^>]*>[\s\S]*?gesso-ui-icon/);
    expect(product).toContain('<details class="gesso-disclosure gesso-product-mechanics"><summary>Mechanics');
  });

  it('uses readable fixture part names while retaining exact source IDs', () => {
    const parts = sceneParts(fixture).map(part => ({...part, name: part.id}));
    const html = render({parts});
    expect(html).toContain('class="gesso-part-name">Body</span>');
    expect(html).toContain('class="gesso-part-name">Label</span>');
    expect(html).not.toContain('File details…');
    expect(html).toContain('class="gesso-status suggested">suggested</span>');
    expect(html).not.toContain('<dt>Structure</dt>');
    expect(parts.find(part => part.id === 'bottle-body')?.name).toBe('bottle-body');
  });

  it('keeps identity and the parent dropdown together without alternate inspector views', () => {
    const html = render();
    const identity = html.match(/<section class="gesso-section gesso-model-selection"[^>]*>[\s\S]*?<\/section>/)![0];
    expect(identity).toContain('aria-label="Object name"');
    expect(identity).toContain('aria-label="Parent"');
    expect(identity).toContain(' mm</p>');
    for (const removed of ['Organize…', 'File details…', 'product-organize', 'product-source-details', 'Apply parent']) {
      expect(html).not.toContain(removed);
    }
    expect(html).not.toContain('>Show assembly</button>');
    expect(html).not.toContain('>Frame</button>');
  });

  it('offers only valid parents and selects the current hierarchy parent', () => {
    const scene = structuredClone(fixture) as any;
    scene.editorHierarchy = {version: 1, overrides: {
      neck: {parentId: 'bottle-body', status: 'edited'},
      cap: {parentId: 'neck', status: 'edited'},
      label: {parentId: 'bottle-body', status: 'edited'},
    }};
    const neck = parentSelect(render({scene, partId: 'neck'}));
    expect(neck).toContain('<option value="">Top level</option>');
    expect(neck).toContain('<option value="bottle-body" selected="">Body</option>');
    expect(neck).toContain('<option value="label">Label</option>');
    expect(neck).not.toContain('<option value="neck"');
    expect(neck).not.toContain('<option value="cap"');
    const body = parentSelect(render({scene, partId: 'bottle-body'}));
    expect(body).toContain('<option value="" selected="">Top level</option>');
    expect(body.match(/<option /g)).toHaveLength(1);
    scene.product.removedPartIds = ['label'];
    expect(parentSelect(render({scene, partId: 'neck'}))).not.toContain('<option value="label"');
  });

  it('keeps source metadata intact without adding a file-details view', () => {
    const scene = structuredClone(fixture) as any;
    scene.product.components = [{...scene.product.components[0], id:'bottle', shape:'mesh'}];
    delete scene.product.label;
    const parts = [{id:'bottle', componentId:'bottle', name:'Bottle', sourceName:'bottle', source:'scene' as const, parentId:null},
      {id:'bottle::node:4', componentId:'bottle', name:'Sticker', sourceName:'Sticker.001', source:'glb' as const,
        parentId:'bottle', sourcePath:'nodes[4]', dimensionsM:[.04,.06,.001] as [number,number,number], materialSlots:[{id:'print',name:'Paper label'}]}];
    scene.editorPartNames = {'bottle::node:4':'Front label'};
    const before = JSON.stringify(scene);
    const html = render({scene, parts, partId:'bottle::node:4'});
    expect(html).toContain('value="Front label"');
    expect(html).toContain('40 × 60 × 1 mm');
    expect(parentSelect(html)).toContain('<option value="bottle" selected="">Bottle</option>');
    expect(html).not.toContain('File details…');
    expect(html).not.toContain('product-source-details');
    expect(html).not.toContain('<dt>Source object</dt>');
    expect(parts[1].sourcePath).toBe('nodes[4]');
    expect(parts[1].materialSlots).toEqual([{id:'print', name:'Paper label'}]);
    expect(JSON.stringify(scene)).toBe(before);
    expect(parts[1].sourceName).toBe('Sticker.001');
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

  it('keeps the material library free of part-focus controls and the inactive decal editor', () => {
    const html = render({workspace: 'material', layer: 'Materials', partId: 'cap'});
    expect(html).toContain('id="product-section-Materials"');
    for (const section of ['Model', 'Decals', 'Animation']) expect(html).not.toContain(`id="product-section-${section}"`);
    expect(html).not.toContain('aria-label="Decal text"');
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
    expect(parentSelect(html)).toContain('<option value="" selected="">Top level</option>');
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
    expect(html).toContain('1 applied');
    expect(html).not.toContain('gesso-material-swatches is-list');
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
