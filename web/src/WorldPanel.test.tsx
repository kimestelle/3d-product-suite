import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import WorldPanel, {type WorldLayer} from './WorldPanel';
import WorldObjectEditor from './WorldObjectEditor';
import {addProp} from './world';
function render(layer: WorldLayer, scene: any = fixture, selectedObjectId: string | null = null) {return renderToStaticMarkup(<WorldPanel selectedObjectId={selectedObjectId} scene={scene} layer={layer} worlds={[]} onChange={() => {}} onWorld={() => {}} onImport={() => {}}><button>Compare worlds</button></WorldPanel>);}
describe('World panel', () => {
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
