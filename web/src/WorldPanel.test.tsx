import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import WorldPanel, {type WorldLayer} from './WorldPanel';
import WorldObjectEditor from './WorldObjectEditor';
import {addLight, addProp, applyDramaticSpot} from './world';
function render(layer: WorldLayer, scene: any = fixture, selectedObjectId: string | null = null) {return renderToStaticMarkup(<WorldPanel selectedObjectId={selectedObjectId} scene={scene} layer={layer} worlds={[]} onChange={() => {}} onWorld={() => {}} onImport={() => {}}><button>Compare worlds</button></WorldPanel>);}
describe('World panel', () => {
  it('keeps the selected stage visual above every section and shows worlds as image choices', () => {
    for (const layer of ['Environment', 'Props', 'Lights'] as const) {
      const html = render(layer);
      expect(html).toContain('aria-label="Current stage preview"');
      expect(html.indexOf('gesso-selected-world-cover')).toBeLessThan(html.indexOf('gesso-stage-controls'));
      expect(html).toContain('Scene preview');
    }
    const html = renderToStaticMarkup(<WorldPanel scene={fixture} layer="Environment" worlds={[{id: 'gallery', name: 'Gallery', environment: {...fixture.environment, kind: 'mesh'}}]} onChange={() => {}} onWorld={() => {}} onImport={() => {}}/>);
    expect(html).toContain('aria-label="World library"');
    expect(html).toContain('aria-label="Use Gallery"');
    expect(html).toContain('aria-label="Use Authored studio" aria-pressed="true"');
    expect(html).not.toContain('<option value="authored"');
  });
  it('offers a proportional product fit for an imported world and waits for its preview', () => {
    const scene = {...fixture, placement: {translationM: [0, 0, 0], scale: .5}, environment: {...fixture.environment, kind: 'mesh', asset: {scaleToMeters: 1, translationM: [0, 0, 0], rotationXyzw: [0, 0, 0, 1]}}};
    const html = renderToStaticMarkup(<WorldPanel scene={scene} layer="Environment" worlds={[]} onChange={() => {}} onWorld={() => {}} onImport={() => {}} onFitProduct={() => {}} fitDisabled/>);
    expect(html).toContain('disabled="">Fit product to scene</button>');
    expect(html).toContain('50%');
    expect(html).toContain('Proportions and source dimensions stay unchanged.');
    expect(render('Environment')).not.toContain('Fit product to scene');
  });
  it('preserves the current world’s catalog image and renders lazy covers without loading world files', () => {
    const sha256 = 'b'.repeat(64);
    const previewAsset = {sha256, path: `assets/${sha256}.png`, format: 'png' as const};
    const environment = {...fixture.environment, kind: 'mesh', revisionId: 'botanical'};
    const scene = {...fixture, environment};
    const worlds = [{id: 'botanical', name: 'Botanical', environment, previewAsset}];
    const html = renderToStaticMarkup(<WorldPanel scene={scene} layer="Environment" worlds={worlds} onChange={() => {}} onWorld={() => {}} onImport={() => {}}/>);
    expect(html.match(new RegExp(`src="/api/assets/${sha256}.png"`, 'g'))).toHaveLength(2);
    expect(html.match(/loading="lazy" decoding="async"/g)).toHaveLength(2);
    expect(html).not.toContain('rel="preload"');
  });
  it('adds and removes lights, selects a type and exposes spot, ambient and preset controls', () => {
    const scene: any = structuredClone(fixture);
    expect(addLight(scene, 'spot')).toBe('spot-1');
    const html = render('Lights', scene);
    for (const value of ['Add light', 'aria-label="Light type"', 'Area disk', 'Spot', 'Ambient color', 'Dramatic spot', 'Reset studio rig', 'Remove light', 'Spot · On', 'Area · On']) expect(html).toContain(value);
    expect(html).toContain('<option value="area" selected="">Area disk</option>');
    expect(html).not.toContain('Cone');
    expect(html).not.toContain('disabled="">Remove light');
    const dramatic: any = structuredClone(fixture); applyDramaticSpot(dramatic);
    const spot = render('Lights', dramatic);
    for (const value of ['Cone', 'Blend', '<option value="spot" selected="">Spot</option>', 'Use world color']) expect(spot).toContain(value);
    expect(spot).toContain('disabled="">Remove light</button>');
    expect(spot).toContain('>Ambient</span>');
  });
  it('renders only the selected controls without leftover section selectors', () => {
    const cases = [
      ['Environment', 'World library', 'Add box', 'Studio lights'],
      ['Props', 'Add box', 'World library', 'Studio lights'],
      ['Lights', 'Studio lights', 'World library', 'Add box'],
    ] as const;
    for (const [layer, shown, ...hidden] of cases) {
      const html = render(layer);
      expect(html).toContain(`id="world-section-${layer}"`);
      expect(html).toContain(shown);
      for (const label of hidden) expect(html).not.toContain(label);
      expect(html).not.toContain('gesso-section-selector');
      expect(html.match(/data-editor-cabinet="true"/g)).toHaveLength(1);
    }
    expect(render('Props')).toContain('<details class="gesso-disclosure"><summary>Prop library</summary>');
    expect(render('Lights')).toContain('<details class="gesso-disclosure"><summary>HDRI library</summary>');
  });
  it('retains advanced world operations and uses a concrete authored environment', () => {const html = render('Environment'); expect(html).toContain('Authored studio'); expect(html).toContain('Compare worlds'); expect(html).toContain('Import world');});
  it('makes the plinth and object creation available before props exist', () => {const html = render('Props'); expect(html).toContain('Plinth'); expect(html).toContain('Add box'); expect(html).toContain('Add cylinder'); expect(html).toContain('Edit Plinth'); expect(html).toContain('mm'); expect(html).not.toContain('Size X'); expect(html).not.toContain('gesso-grid-3'); expect(html).not.toContain('Remove prop');});
  it('shows a checked native plinth control by default and explains the retained contact height when hidden', () => {
    const visible = render('Props', fixture, fixture.environment.plinth.id);
    expect(visible).toMatch(/<input type="checkbox" checked=""\/><span>Show plinth<\/span>/);
    const hidden: any = structuredClone(fixture); hidden.environment.plinth.visible = false;
    const html = render('Props', hidden, hidden.environment.plinth.id);
    expect(html).toMatch(/<input type="checkbox"\/><span>Show plinth<\/span>/);
    expect(html).toContain('Hidden. Product placement still follows this contact surface.');
    expect(render('Environment', hidden)).not.toContain('Curved sweep + contact plinth');
  });
  it('exposes the saved light parameters and its preview limit', () => {const html = render('Lights'); for (const value of ['Key','Fill','Rim','Power','Diameter','Position','Aim at','Reset studio rig','Preview approximates area lights.']) expect(html).toContain(value); expect(html).toContain('Decrease Power'); expect(html).toContain('W</span>');});
  it('defers A/B world changes to the comparison controls', () => {const html = render('Environment', {...fixture, comparison: {}}); expect(html).toContain('Compare worlds'); expect(html).not.toContain('Import world'); expect(html).not.toContain('Saved custom world');});
});


describe('World object inspector', () => {
  it('keeps the library separate and opens settings only for the selected object', () => {
    const scene = structuredClone(fixture);
    const id = addProp(scene, 'box');
    const library = render('Props', scene);
    expect(library).toContain('Edit Box 1');
    expect(library).not.toContain('Size X');
    const open = render('Props', scene, id);
    for (const label of ['Object settings', 'Object name', 'Size X', 'Position Y', 'Rotation Z', 'Edge radius', 'Roughness', 'Metalness', 'Remove object']) expect(open).toContain(label);
    expect(open).not.toContain('Show plinth');
    expect(render('Environment', scene, id)).not.toContain('Object settings');
    expect(render('Props', scene, 'removed-object')).not.toContain('Object settings');
  });
  it('retains imported geometry, original-material controls, source dimensions and credit', () => {
    const scene: any = structuredClone(fixture);
    scene.environment.props = [{id: 'chair', displayName: 'Chair', shape: 'mesh', sizeM: [.4,.8,.4], translationM: [0,0,0], rotationXyzw: [0,0,0,1],
      asset: {sourceDimensionsM: [.4,.8,.4]}, materialOverride: false, source: {url: 'https://polyhaven.com/a/chair'}}];
    const before = JSON.stringify(scene);
    const editor = renderToStaticMarkup(<WorldObjectEditor scene={scene} objectId="chair" onChange={() => {}} onClose={() => {}} onFrameProp={() => {}}/>);
    for (const value of ['original UVs and materials', 'Override source materials', '400 × 800 × 400 mm', 'Poly Haven', 'CC0', 'Frame object']) expect(editor).toContain(value);
    expect(editor).not.toContain('Roughness');
    expect(editor).not.toContain('Edge radius');
    expect(JSON.stringify(scene)).toBe(before);
  });
});
