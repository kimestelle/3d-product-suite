import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import SceneObjectsPanel from './SceneObjectsPanel';
import { addSceneProp, setPropRelationship } from './sceneObjects';

function markup(scene: any, selected = 'product-root', ready = true) {
  return renderToStaticMarkup(<SceneObjectsPanel scene={scene} selected={selected} ready={ready}
    onSelect={() => {}} onChange={() => {}} onPickSurface={() => {}} pickingSurface={false} onCancelPick={() => {}}/>);
}
function scene(): any { return structuredClone(fixture); }

describe('scene hierarchy and interaction controls', () => {
  it('renders a named selectable hierarchy and exposes the documented component action', () => {
    const html = markup(scene());
    expect(html).toContain('role="tree" aria-label="Scene object tree"');
    expect(html).toContain('role="treeitem" aria-label="Product" aria-level="1" aria-selected="true"');
    expect(html).toContain('data-tree-id="bottle-body"');
    expect(html).toContain('data-tree-id="action:cap-lift-v1"');
    expect(html).toContain('Lift action');
    expect(html).toContain('data-tree-id="camera:reveal"');
    expect(html).toContain('Rest product on');
    expect(html).toContain('Offset from support');
    expect(html).toContain('Product rotation (°)');
  });

  it('does not create default geometry while showing explicit add actions', () => {
    const current = scene();
    current.environment.plinth.visible = false;
    current.placement.restsOn = 'floor';
    const before = JSON.stringify(current);
    const html = markup(current);
    expect(html).toContain('＋ Box');
    expect(html).toContain('＋ Cylinder');
    expect(html).toContain('＋ Add optional plinth');
    expect(html).not.toContain('data-tree-id="plinth:plinth"');
    expect(html).not.toContain('<option value="plinth"');
    expect(JSON.stringify(current)).toBe(before);
  });

  it('offers real spatial interactions with valid targets and no self relation', () => {
    const current = scene();
    const id = addSceneProp(current, 'cylinder');
    const html = markup(current, `prop:${id}`);
    expect(html).toContain('aria-label="Object interaction"');
    expect(html).toContain('Dimensions · X/Z diameter');
    expect(html).toContain('<option value="on">On top of</option>');
    expect(html).toContain('<option value="beside" selected="">Beside</option>');
    expect(html).toContain('<option value="inFrontOf">In front of</option>');
    expect(html).toContain('<option value="behind">Behind</option>');
    expect(html).toContain('Gap (m)');
    expect(html).toContain('Offset from relation');
    expect(html).not.toContain(`<option value="${id}"`);
    expect(html).not.toContain('<option value="floor"'); // Floor has no meaningful beside relationship.
    expect(html).toContain('Remove object');
  });

  it('offers an obvious product support action and disables it for loading or tilted objects', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    expect(markup(current, `prop:${id}`)).toMatch(/<button[^>]*class="wide">Rest product on this object<\/button>/);
    expect(markup(current, `prop:${id}`, false)).toMatch(/<button[^>]*disabled=""[^>]*>Rest product on this object<\/button>/);
    current.environment.props[0].rotationXyzw = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
    const tilted = markup(current, `prop:${id}`);
    expect(tilted).toMatch(/<button[^>]*disabled=""[^>]*>Rest product on this object<\/button>/);
    expect(tilted).toContain('Support needs a visible, horizontal top surface.');
  });

  it('shows absolute position only for free props and retains the on-floor action', () => {
    const current = scene();
    const id = addSceneProp(current, 'box');
    setPropRelationship(current, id, 'free');
    const html = markup(current, `prop:${id}`);
    expect(html).toContain('<option value="free" selected="">Free placement</option>');
    expect(html).toContain('<legend>Position</legend>');
    expect(html).not.toContain('Gap (m)');
    setPropRelationship(current, id, 'on', 'floor');
    expect(markup(current, `prop:${id}`)).toContain('<option value="floor" selected="">Floor</option>');
  });

  it('enables surface picking only for a ready mesh world, with a clear Gaussian alternative', () => {
    const current = scene();
    current.environment.kind = 'mesh';
    const loading = markup(current, 'product-root', false);
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>Pick a surface in the world<\/button>/);
    const ready = markup(current);
    expect(ready).toMatch(/<button[^>]*aria-pressed="false">Pick a surface in the world<\/button>/);
    current.environment.kind = 'splat';
    const splat = markup(current);
    expect(splat).not.toContain('>Pick a surface in the world</button>');
    expect(splat).toContain('Use a mesh world to pick a surface.');
  });

  it('provides editable floor height and an explicitly removable optional plinth', () => {
    const current = scene();
    expect(markup(current, 'floor')).toContain('Floor height (m)');
    const plinth = markup(current, 'plinth:plinth');
    expect(plinth).toContain('aria-label="Plinth placement"');
    expect(plinth).toContain('Plinth dimensions');
    expect(plinth).toContain('Plinth position');
    expect(plinth).toContain('Remove plinth');
  });
});
