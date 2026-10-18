import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import WorldPanel, {type WorldLayer} from './WorldPanel';
function render(layer: WorldLayer, scene: any = fixture) {return renderToStaticMarkup(<WorldPanel scene={scene} layer={layer} worlds={[]} onChange={() => {}} onWorld={() => {}} onImport={() => {}}><button>Compare worlds</button></WorldPanel>);}
describe('World panel', () => {
  it('retains advanced world operations and uses a concrete authored environment', () => {const html = render('Environment'); expect(html).toContain('Authored studio'); expect(html).toContain('Compare worlds'); expect(html).toContain('Import world');});
  it('makes the plinth and object creation available before props exist', () => {const html = render('Props'); expect(html).toContain('Plinth'); expect(html).toContain('Add box'); expect(html).toContain('Add cylinder'); expect(html).toContain('gesso-control-row'); expect(html).toContain('min="1"'); expect(html).not.toContain('gesso-grid-3'); expect(html).not.toContain('Remove prop');});
  it('shows a checked native plinth control by default and explains the retained contact height when hidden', () => {
    const visible = render('Props');
    expect(visible).toMatch(/<input type="checkbox" checked=""\/><span>Show plinth<\/span>/);
    const hidden: any = structuredClone(fixture); hidden.environment.plinth.visible = false;
    const html = render('Props', hidden);
    expect(html).toMatch(/<input type="checkbox"\/><span>Show plinth<\/span>/);
    expect(html).toContain('Hidden. Product placement still follows this contact surface.');
    expect(render('Environment', hidden)).not.toContain('Curved sweep + contact plinth');
  });
  it('exposes the saved light parameters and its preview limit', () => {const html = render('Lights'); for (const value of ['Key','Fill','Rim','Power','Diameter','Position','Aim at','Reset studio rig','Preview approximates area lights.']) expect(html).toContain(value); expect(html).toContain('Decrease Power'); expect(html).toContain('W</span>');});
  it('defers A/B world changes to the comparison controls', () => {const html = render('Environment', {...fixture, comparison: {}}); expect(html).toContain('Compare worlds'); expect(html).not.toContain('Import world'); expect(html).not.toContain('Saved custom world');});
});
