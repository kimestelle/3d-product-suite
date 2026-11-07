import {renderToStaticMarkup} from 'react-dom/server';
import {Children, type ReactElement} from 'react';
import {describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import WorldPanel, {stageWorldLibrary,WorldRepresentationSelect,type WorldLayer} from './WorldPanel';
import WorldObjectEditor from './WorldObjectEditor';
import {addLight, addProp, applyDramaticSpot} from './world';
function render(layer: WorldLayer, scene: any = fixture, selectedObjectId: string | null = null) {return renderToStaticMarkup(<WorldPanel selectedObjectId={selectedObjectId} scene={scene} layer={layer} worlds={[]} onChange={() => {}} onWorld={() => {}} onImport={() => {}}><button>Compare worlds</button></WorldPanel>);}
function representationWorld(id: string, representation: string, providerWorldId = 'water', overrides: any = {}) {
  return {id, name: `Room ${id}`, environment: {...fixture.environment, kind: representation === 'gaussian-spz' ? 'splat' : 'mesh',
    revisionId: id, provenance: {representation, providerWorldId, ...(representation === 'hq-visual-glb' ? {meshVariant: 'textured'} : {})}, ...overrides}};
}
describe('World panel', () => {
  it('shows a stage cover for Environment and Props and leads Lighting with the rig', () => {
    for (const layer of ['Environment', 'Props'] as const) {
      const html = render(layer);
      expect(html).toContain('aria-label="Current stage preview"');
      expect(html.indexOf('gesso-selected-world-cover')).toBeLessThan(html.indexOf('gesso-stage-controls'));
      expect(html).toContain('Scene preview');
    }
    const lights = render('Lights');
    expect(lights).not.toContain('aria-label="Current stage preview"');
    expect(lights).toContain('aria-label="Select Key · Area"');
    expect(lights.indexOf('aria-label="Lighting rig · top view"')).toBeLessThan(lights.indexOf('aria-label="Studio lights"'));
    expect(lights).toContain('<summary>Shape and placement</summary>');
    expect(lights).toContain('Amber desk lamp');
    const html = renderToStaticMarkup(<WorldPanel scene={fixture} layer="Environment" worlds={[{id: 'gallery', name: 'Gallery', environment: {...fixture.environment, kind: 'mesh'}}]} onChange={() => {}} onWorld={() => {}} onImport={() => {}}/>);
    expect(html).toContain('aria-label="World library"');
    expect(html).toContain('aria-label="Use Gallery"');
    expect(html).toContain('aria-label="Use Authored studio" aria-pressed="true"');
    expect(html).not.toContain('<option value="authored"');
  });
  it('shows one provider mesh per generated world while retaining fixture and manual imports',()=>{
    const make=(id:string,kind:string,representation?:string,providerWorldId?:string,fixture=false)=>({id,name:id,environment:{...fixtureEnvironment,kind,revisionId:id,fixture,
      provenance:{representation,providerWorldId}}});
    const fixtureEnvironment=fixture.environment;
    const worlds=[make('water-hq','mesh','hq-visual-glb','water'),make('water-splat','splat','gaussian-spz','water'),make('water-reconstruction','mesh','gaussian-reconstructed-mesh','water'),
      make('room-hq','mesh','hq-visual-glb','room'),make('room-splat','splat','gaussian-spz','room'),make('fixture-splat','splat','gaussian-spz','water',true),make('manual-splat','splat'),make('orphan-reconstruction','mesh','gaussian-reconstructed-mesh','other')];
    const before=structuredClone(worlds);
    expect(stageWorldLibrary(worlds).map(world=>world.id)).toEqual(['water-hq','room-hq','fixture-splat','manual-splat','orphan-reconstruction']);
    const html=renderToStaticMarkup(<WorldPanel scene={fixture} layer="Environment" worlds={worlds} onChange={()=>{}} onWorld={()=>{}} onImport={()=>{}}/>);
    for(const id of ['water-hq','room-hq','fixture-splat','manual-splat','orphan-reconstruction'])expect(html).toContain(`data-world-id="${id}"`);
    for(const id of ['water-splat','water-reconstruction','room-splat'])expect(html).not.toContain(`data-world-id="${id}"`);
    expect(worlds).toEqual(before);
  });
  it('keeps a currently selected generated diagnostic visible and preserves the complete comparison list',()=>{
    const worlds=['hq-visual-glb','gaussian-spz','gaussian-reconstructed-mesh'].map((representation,index)=>({id:`world-${index}`,name:`World ${index}`,environment:{...fixture.environment,
      kind:index===1?'splat':'mesh',revisionId:`world-${index}`,provenance:{representation,providerWorldId:'same-world'}}}));
    const scene={...fixture,environment:worlds[1].environment};
    const html=renderToStaticMarkup(<WorldPanel scene={scene} layer="Environment" worlds={worlds} onChange={()=>{}} onWorld={()=>{}} onImport={()=>{}}><span>{worlds.length} comparison representations</span></WorldPanel>);
    expect(html).toContain('data-world-id="world-0"');expect(html).toContain('data-world-id="world-1" aria-label="Use World 1" aria-pressed="true"');
    expect(html).not.toContain('data-world-id="world-2"');expect(html).toContain('3 comparison representations');expect(worlds).toHaveLength(3);
  });
  it('prefers paired native Gaussians while retaining the selected older representation and other worlds',()=>{
    const mesh=representationWorld('mesh','hq-visual-glb'),source=representationWorld('source','gaussian-spz');
    const paired=representationWorld('paired','gaussian-spz','water',{
      previewAsset:{sha256:'a'.repeat(64),path:`assets/${'a'.repeat(64)}.spz`,format:'spz'},
      provenance:{representation:'gaussian-spz',providerWorldId:'water',splatResolution:'full_res'},
    });
    const other=representationWorld('other-mesh','hq-visual-glb','other');
    const worlds=[mesh,source,paired,other],before=structuredClone(worlds);
    expect(stageWorldLibrary(worlds).map(world=>world.id)).toEqual(['paired','other-mesh']);
    expect(stageWorldLibrary(worlds,mesh.id).map(world=>world.id)).toEqual(['mesh','paired','other-mesh']);
    const html=renderToStaticMarkup(<WorldPanel scene={{...fixture,environment:paired.environment}} layer="Environment" worlds={worlds} onChange={()=>{}} onWorld={()=>{}} onImport={()=>{}}/>);
    expect(html).toContain('aria-label="Gaussian quality"');
    expect(html).toContain('Preview snapshots and exports use the full source with the same camera and alignment.');
    expect(html).toContain('<option value="mesh">Textured mesh</option>');
    expect(worlds).toEqual(before);
  });
  it('offers actual mesh and Gaussian siblings for the selected provider world without switching on render', () => {
    const mesh = representationWorld('water-mesh', 'hq-visual-glb'), source = representationWorld('water-source', 'gaussian-spz');
    const worlds = [mesh, source, representationWorld('other-source', 'gaussian-spz', 'other'), representationWorld('water-reconstruction', 'gaussian-reconstructed-mesh')];
    const onWorld = vi.fn(), before = structuredClone(worlds);
    const html = renderToStaticMarkup(<WorldPanel scene={{...fixture, environment: mesh.environment}} layer="Environment" worlds={worlds} onChange={() => {}} onWorld={onWorld} onImport={() => {}}/>);
    expect(html).toContain('aria-label="World representation"');
    expect(html).toContain('<option value="water-mesh" selected="">Textured mesh</option>');
    expect(html).toContain('<option value="water-source">Gaussian source</option>');
    expect(html).not.toContain('<option value="other-source"');
    expect(html).not.toContain('<option value="water-reconstruction"');
    expect(html).toContain('Near-field depth, product reflections and transmission are not equivalent to the mesh.');
    expect(onWorld).not.toHaveBeenCalled(); expect(worlds).toEqual(before);
  });
  it('keeps the selected Gaussian source and routes explicit representation changes through the existing world callback', () => {
    const mesh = representationWorld('water-mesh', 'hq-visual-glb'), source = representationWorld('water-source', 'gaussian-spz');
    const onWorld = vi.fn();
    const tree = WorldRepresentationSelect({worlds: [mesh, source], current: source, onWorld})!;
    const field = (Children.toArray(tree.props.children) as ReactElement<any>[]).find(child => child.props.label === 'World representation')!;
    const select = field.props.children as ReactElement<any>;
    expect(select.props.value).toBe(source.id);
    expect(renderToStaticMarkup(tree)).toContain('<option value="water-source" selected="">Gaussian source</option>');
    select.props.onChange({target: {value: source.id}});
    select.props.onChange({target: {value: 'unrelated-source'}});
    expect(onWorld).not.toHaveBeenCalled();
    select.props.onChange({target: {value: mesh.id}});
    expect(onWorld).toHaveBeenCalledExactlyOnceWith(mesh.id);
  });
  it('retains and identifies every matching representation revision', () => {
    const worlds = [representationWorld('mesh-r1', 'hq-visual-glb'), representationWorld('mesh-r2', 'hq-visual-glb'),
      representationWorld('source-r1', 'gaussian-spz'), representationWorld('source-r2', 'gaussian-spz')];
    const html = renderToStaticMarkup(<WorldRepresentationSelect worlds={worlds} current={worlds[1]} onWorld={() => {}}/>);
    for (const world of worlds) expect(html).toContain(`value="${world.id}"`);
    expect(html).toContain('<option value="mesh-r2" selected="">Textured mesh · Room mesh-r2 · mesh-r2</option>');
    expect(html).toContain('Gaussian source · Room source-r2 · source-r2');
    expect(stageWorldLibrary(worlds).map(world => world.id)).toEqual(['mesh-r1', 'mesh-r2']);
  });
  it('omits representation switching for manual, fixture, unmatched or incomplete provider worlds', () => {
    const mesh = representationWorld('mesh', 'hq-visual-glb'), source = representationWorld('source', 'gaussian-spz');
    const manual = representationWorld('manual', 'manual', 'water');
    const cases = [
      {current: mesh, worlds: [mesh]},
      {current: mesh, worlds: [mesh, representationWorld('foreign', 'gaussian-spz', 'other')]},
      {current: mesh, worlds: [mesh, {...source, environment: {...source.environment, fixture: true}}]},
      {current: manual, worlds: [mesh, source, manual]},
      {current: {...mesh, environment: {...mesh.environment, fixture: true}}, worlds: [mesh, source]},
      {current: {...mesh, id: 'missing-revision'}, worlds: [mesh, source]},
    ];
    for (const props of cases) expect(renderToStaticMarkup(<WorldRepresentationSelect {...props} onWorld={() => {}}/>)).toBe('');
    expect(render('Environment')).not.toContain('World representation');
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
    expect(open).toContain('<summary>Exact size and placement</summary>');
    expect(open).toContain('<summary>Object relationship</summary>');
    expect(open).toContain('<summary>Surface finish</summary>');
    expect(open).not.toContain('aria-label="Product placement"');
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
