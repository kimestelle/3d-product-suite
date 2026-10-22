import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import ExportSetupPanel, {ExportSetupSelect, randomScopeSelection, selectRandomScope, type ExportSetupPanelProps} from './ExportSetupPanel';
import {defaultRandomSetupSettings, RANDOM_SETUP_PALETTES} from './randomSetup';
import bottle from '../../examples/bottle.scene.json';

function context(): ExportSetupPanelProps {
  const sourceScene = structuredClone(bottle);
  return {sourceScene, tab: 'current', onTab: vi.fn(), settings: defaultRandomSetupSettings(sourceScene), onSettings: vi.fn(), worlds: [], changes: [], hasDraft: false, onGenerate: vi.fn()};
}

describe('export setup rail', () => {
  it('starts with one native source dropdown and keeps Random controls out of Current', () => {
    const props=context(), before=JSON.stringify(props.sourceScene);
    const html=renderToStaticMarkup(<ExportSetupPanel {...props}/>);
    expect(html).toContain('aria-label="Setup"');
    expect(html).toContain('<option value="current" selected="">Current</option>');
    expect(html).toContain('<option value="random">Random</option>');
    expect(html).not.toContain('aria-label="Randomize"');
    expect(html).not.toContain('role="tab');
    expect(html).toContain('Original scene kept');
    expect(html).not.toContain('Generate setup');
    expect(props.onGenerate).not.toHaveBeenCalled();expect(props.onSettings).not.toHaveBeenCalled();
    expect(JSON.stringify(props.sourceScene)).toBe(before);
  });

  it('switches source without generating or replacing any settings', () => {
    const onTab=vi.fn(), control=ExportSetupSelect({tab:'current',onTab}).props.children[1];
    control.props.onChange({target:{value:'random'}});
    control.props.onChange({target:{value:'current'}});
    expect(onTab.mock.calls).toEqual([['random'],['current']]);
  });

  it('defaults Random to Everything, including colors and material targets', () => {
    const props=context(), html=renderToStaticMarkup(<ExportSetupPanel {...props} tab="random"/>);
    expect(html).toContain('aria-label="Randomize"');
    expect(html).toContain('<option value="everything" selected="">Everything</option>');
    expect(html).toContain('<option value="colors">Colors</option>');
    expect(html).toContain('Preset palettes');
    expect(html).toContain('Refine choices');
    expect(html).not.toContain(' policy"');
    expect(html).toContain('class="gesso-setup-generate"><span>Generate setup</span>');
    expect(html).toContain('Duration in seconds');
    expect(props.settings.materialPartIds).toHaveLength(bottle.product.components.length);
    expect(props.onGenerate).not.toHaveBeenCalled();
  });

  it('isolates a chosen scope without resetting its option pools or changing the source', () => {
    const props=context(), before=structuredClone(props.settings);
    const settings=selectRandomScope(props.settings,'colors');
    expect(randomScopeSelection(settings)).toBe('colors');
    expect(settings.policies.colors).toBe('random');
    expect(Object.values(settings.policies).filter(value=>value==='random')).toHaveLength(1);
    expect(settings.paletteIds).toEqual(before.paletteIds);
    expect(settings.materialPartIds).toEqual(before.materialPartIds);
    expect(props.settings).toEqual(before);
    expect(randomScopeSelection(selectRandomScope(settings,'everything'))).toBe('everything');
    settings.policies.stage='random';expect(randomScopeSelection(settings)).toBe('custom');
  });

  it('shows palette swatches and hides unrelated timing controls for Colors', () => {
    const props=context();props.settings=selectRandomScope(props.settings,'colors');
    const html=renderToStaticMarkup(<ExportSetupPanel {...props} tab="random"/>);
    for(const palette of RANDOM_SETUP_PALETTES)expect(html).toContain(palette.name);
    expect(html).toContain('gesso-setup-palette');
    expect(html).toContain('Kept materials and artwork stay unchanged.');
    expect(html).not.toContain('Duration in seconds');
    expect(html).not.toContain('Random setup screen size');
  });

  it('blocks empty scope, palette or material targets while leaving the choices editable', () => {
    const props=context();
    props.settings=selectRandomScope(props.settings,'colors');props.settings.paletteIds=[];
    let html=renderToStaticMarkup(<ExportSetupPanel {...props} tab="random"/>);
    expect(html).toContain('Choose at least one preset palette.');
    expect(html).toContain('class="gesso-setup-generate" disabled=""');
    props.settings=selectRandomScope(props.settings,'materials');props.settings.materialPartIds=[];
    html=renderToStaticMarkup(<ExportSetupPanel {...props} tab="random"/>);
    expect(html).toContain('Choose the objects whose materials can change');
    props.settings.policies.materials='keep';
    expect(renderToStaticMarkup(<ExportSetupPanel {...props} tab="random"/>)).toContain('Choose something to randomize.');
  });

  it('shows actual preview changes and marks settings that need generating again', () => {
    const props={...context(),tab:'random' as const,hasDraft:true,changes:['Colors: Clay · background #6E382A']};
    const html=renderToStaticMarkup(<ExportSetupPanel {...props}/>);
    expect(html).toContain('In this preview');expect(html).toContain('Colors: Clay');expect(html).toContain('Reroll setup');
    const changed=renderToStaticMarkup(<ExportSetupPanel {...props} dirty/>);
    expect(changed).toContain('Settings changed · generate to preview');expect(changed).not.toContain('Reroll setup');
  });

  it('explains coverage and blocks settings that cannot produce both required views', () => {
    const props={...context(),tab:'random' as const};
    let html=renderToStaticMarkup(<ExportSetupPanel {...props}/>);
    expect(html).toContain('Every reel includes a full-product shot and a close-up.');
    expect(html).toContain('aria-label="Product shots" type="number" min="2"');
    expect(html).toContain('Camera holds while the product or lighting moves.');
    props.settings.cameraViews=['front'];
    html=renderToStaticMarkup(<ExportSetupPanel {...props}/>);
    expect(html).toContain('Include Close-up');
    expect(html).toContain('class="gesso-setup-generate" disabled=""');
    props.settings.cameraViews=['detail'];
    html=renderToStaticMarkup(<ExportSetupPanel {...props}/>);
    expect(html).toContain('Include a full-product view');
    expect(html).toContain('class="gesso-setup-generate" disabled=""');
    // Keeping framing does not force camera changes when only colors are random.
    props.settings=selectRandomScope(props.settings,'colors');
    html=renderToStaticMarkup(<ExportSetupPanel {...props}/>);
    expect(html).not.toContain('Every reel includes');
    expect(html).toContain('class="gesso-setup-generate"><span>Generate setup</span>');
  });

  it('disables source and option changes while busy and leaves errors recoverable', () => {
    const props={...context(),tab:'random' as const};
    const busy=renderToStaticMarkup(<ExportSetupPanel {...props} busy/>);
    expect(busy).toContain('class="gesso-export-setup-selectors" disabled=""');
    expect(busy).toContain('class="gesso-setup-controls" disabled=""');
    expect(busy).toContain('class="gesso-setup-generate" disabled=""><span>Generating…</span>');
    const failed=renderToStaticMarkup(<ExportSetupPanel {...props} error="Stage no longer available"/>);
    expect(failed).toContain('role="alert">Stage no longer available');
    expect(failed).toContain('class="gesso-setup-generate"><span>Generate setup</span>');
  });
});
