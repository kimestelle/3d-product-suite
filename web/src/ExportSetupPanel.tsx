import {useState, type ReactNode} from 'react';
import {displayPartName} from './hierarchy';
import {partTargetIds} from './partTargets';
import {sequenceEnd} from './sequence';
import {RANDOM_SETUP_PALETTES, RANDOM_SETUP_STAGES, randomFramingRuleError, type RandomSetupCategory, type RandomSetupSettings} from './randomSetup';
import {UiIcon} from './UiIcon';
import './export-setup.css';

export type ExportSetupTab = 'current' | 'random';
export interface ExportSetupPanelProps {
  sourceScene: any;
  tab: ExportSetupTab;
  onTab: (tab: ExportSetupTab) => void;
  settings: RandomSetupSettings;
  onSettings: (settings: RandomSetupSettings) => void;
  worlds: Array<{id: string; name: string; environment: any}>;
  changes: string[];
  hasDraft: boolean;
  dirty?: boolean;
  busy?: boolean;
  error?: string;
  onGenerate: () => void;
}
const scopes: Array<{id: RandomSetupCategory; label: string}> = [
  {id: 'stage', label: 'Stage'}, {id: 'lighting', label: 'Lighting'}, {id: 'colors', label: 'Colors'},
  {id: 'framing', label: 'Framing + shots'}, {id: 'motion', label: 'Camera movement'},
  {id: 'materials', label: 'Materials'},
];
const lighting = [{id: 'soft', name: 'Soft'}, {id: 'side', name: 'Side'}, {id: 'spot', name: 'Spot'}] as const;
const framing = [{id: 'front', name: 'Full product · front'}, {id: 'three-quarter', name: 'Full product · three-quarter'}, {id: 'detail', name: 'Close-up'}] as const;
const motion = [{id: 'still', name: 'Still'}, {id: 'orbit', name: 'Orbit'}, {id: 'push', name: 'Push in'}] as const;
const materials = [{id: 'plastic', name: 'Plastic'}, {id: 'metal', name: 'Metal'}, {id: 'glass', name: 'Glass'}] as const;
type Selection = 'everything' | 'custom' | RandomSetupCategory;

export function ExportSetupSelect({tab, onTab, disabled = false}: {tab: ExportSetupTab; onTab: (tab: ExportSetupTab) => void; disabled?: boolean}) {
  return <label className="gesso-setup-select"><span>Setup</span><select aria-label="Setup" value={tab} disabled={disabled} onChange={event => onTab(event.target.value as ExportSetupTab)}>
    <option value="current">Current</option><option value="random">Random</option>
  </select></label>;
}
export function randomScopeSelection(settings: RandomSetupSettings): Selection {
  const selected = scopes.filter(scope => settings.policies[scope.id] === 'random');
  if (selected.length === scopes.length) return 'everything';
  return selected.length === 1 && scopes.every(scope => ['keep','random'].includes(settings.policies[scope.id])) ? selected[0].id : 'custom';
}
export function selectRandomScope(settings: RandomSetupSettings, selection: Exclude<Selection,'custom'>): RandomSetupSettings {
  return {...settings, policies: Object.fromEntries(scopes.map(scope => [scope.id, selection === 'everything' || selection === scope.id ? 'random' : 'keep'])) as RandomSetupSettings['policies']};
}
function Pool<T extends string>({label, choices, selected, onChange}: {label: string; choices: readonly {id: T; name: string; colors?: readonly string[]}[]; selected: T[]; onChange: (values: T[]) => void}) {
  return <fieldset className="gesso-setup-pool"><legend>{label}</legend><div>
    {choices.map(choice => <label key={choice.id}><input type="checkbox" checked={selected.includes(choice.id)}
      onChange={event => onChange(event.target.checked ? [...selected, choice.id] : selected.filter(value => value !== choice.id))}/>
      <span>{choice.name}{choice.colors && <span className="gesso-setup-palette" aria-hidden="true">{choice.colors.map(color => <i key={color} style={{backgroundColor:color}}/>)}</span>}</span>
    </label>)}
  </div></fieldset>;
}
function ScopeOptions({scope, children, count}: {scope: typeof scopes[number]; children: ReactNode; count: number}) {
  return <details className="gesso-setup-options"><summary>{scope.label}<span>{count} {scope.id === 'colors' ? count === 1 ? 'palette' : 'palettes' : count === 1 ? 'option' : 'options'}</span></summary><div>{children}</div></details>;
}
function Summary({scene, worlds}: {scene: any; worlds: ExportSetupPanelProps['worlds']}) {
  const shots: any[] = scene?.shots ?? [], fps = Number(scene?.render?.fps) || 24;
  const duration = (sequenceEnd(scene) / fps).toFixed(1).replace(/\.0$/, '');
  const world = scene?.environment?.revisionId ? worlds.find(item => item.environment?.revisionId === scene.environment.revisionId) : undefined;
  return <dl className="gesso-setup-summary">
    <div><dt>Product</dt><dd>{partTargetIds(scene).length} parts</dd></div>
    <div><dt>Stage</dt><dd>{world?.name || scene?.environment?.displayName || (scene?.environment?.kind === 'generated' ? 'Imported world' : 'Studio')}</dd></div>
    <div><dt>Film</dt><dd>{shots.length} {shots.length === 1 ? 'scene' : 'scenes'} · {duration} s</dd></div>
    <div><dt>Screen</dt><dd>{scene?.render?.width ?? '—'} × {scene?.render?.height ?? '—'}</dd></div>
  </dl>;
}

export default function ExportSetupPanel({sourceScene, tab, onTab, settings, onSettings, worlds, changes, hasDraft, dirty = false, busy = false, error, onGenerate}: ExportSetupPanelProps) {
  const [custom, setCustom] = useState(false);
  const selectedScope = custom ? 'custom' : randomScopeSelection(settings);
  const targets = new Set(partTargetIds(sourceScene));
  const parts: Array<{id: string; name: string}> = (sourceScene?.product?.components ?? []).filter((part: any) => targets.has(part.id)).map((part: any) => ({id: part.id, name: displayPartName(sourceScene, part.id)}));
  const stages = [...RANDOM_SETUP_STAGES, ...worlds.filter(world => !RANDOM_SETUP_STAGES.some(stage => stage.id === world.id))];
  const poolCounts = {stage: settings.stageIds.length, lighting: settings.lightingStyles.length, colors: settings.paletteIds.length, framing: settings.cameraViews.length, motion: settings.motionKinds.length, materials: settings.materialTypes.length};
  const selectedScopes = scopes.filter(scope => settings.policies[scope.id] !== 'keep');
  const missingPool = selectedScopes.find(scope => !poolCounts[scope.id]);
  const materialTargetsMissing = settings.policies.materials === 'random' && !settings.materialPartIds.some(part => targets.has(part));
  const blocked = !selectedScopes.length ? 'Choose something to randomize.' : missingPool ? missingPool.id === 'colors' ? 'Choose at least one preset palette.' : `Choose at least one ${missingPool.label.toLowerCase()} option in Refine choices.` : materialTargetsMissing ? 'Choose the objects whose materials can change in Refine choices.' : settings.policies.framing === 'random' ? randomFramingRuleError(settings) : '';
  const update = <K extends keyof RandomSetupSettings>(key: K, value: RandomSetupSettings[K]) => onSettings({...settings, [key]: value});
  const options: Record<RandomSetupCategory, ReactNode> = {
    stage: <Pool label="Available stages" choices={stages} selected={settings.stageIds} onChange={value => update('stageIds', value)}/>,
    lighting: <Pool label="Light direction" choices={lighting} selected={settings.lightingStyles} onChange={value => update('lightingStyles', value)}/>,
    colors: <><Pool label="Preset palettes" choices={RANDOM_SETUP_PALETTES} selected={settings.paletteIds} onChange={value => update('paletteIds', value)}/><p className="gesso-setup-note">Colors the background and newly randomized materials. Kept materials and artwork stay unchanged.</p></>,
    framing: <Pool label="Camera views" choices={framing} selected={settings.cameraViews} onChange={value => update('cameraViews', value)}/>,
    motion: <><Pool label="Camera motions" choices={motion} selected={settings.motionKinds} onChange={value => update('motionKinds', value)}/><p className="gesso-setup-note">Camera holds while the product or lighting moves. Otherwise, use a clear move or a still shot.</p></>,
    materials: <><Pool label="Objects that can change" choices={parts} selected={settings.materialPartIds} onChange={value => update('materialPartIds', value)}/>
      <Pool label="Material types" choices={materials} selected={settings.materialTypes} onChange={value => update('materialTypes', value)}/><p className="gesso-setup-note">Replaces finishes and their textures. Placed artwork and decals stay.</p></>,
  };
  return <section className="gesso-export-setup" aria-label="Export scene setup">
    <fieldset className="gesso-export-setup-selectors" disabled={busy}>
      <ExportSetupSelect tab={tab} onTab={onTab} disabled={busy}/>
      {tab === 'random' && <label className="gesso-setup-select"><span>Randomize</span><select aria-label="Randomize" value={selectedScope} onChange={event => {
        const selection=event.target.value as Selection;
        setCustom(selection==='custom');
        if(selection!=='custom') onSettings(selectRandomScope(settings,selection));
      }}><option value="everything">Everything</option>{scopes.map(scope=><option key={scope.id} value={scope.id}>{scope.label}</option>)}<option value="custom">Custom</option></select></label>}
    </fieldset>
    <div className="gesso-export-setup-body" role="region" aria-label={tab === 'current' ? 'Current setup' : 'Random options'} tabIndex={0}>
      {tab === 'current' ? <><Summary scene={sourceScene} worlds={worlds}/><p className="gesso-setup-note">Export this scene, or choose Random to try a variation.</p></> : <>
        <fieldset className="gesso-setup-controls" disabled={busy}>
          {selectedScope==='custom' && <Pool label="What can change" choices={scopes.map(scope=>({id:scope.id,name:scope.label}))} selected={selectedScopes.map(scope=>scope.id)} onChange={values=>onSettings({...settings,policies:Object.fromEntries(scopes.map(scope=>[scope.id,values.includes(scope.id)?'random':'keep'])) as RandomSetupSettings['policies']})}/>}
          {settings.policies.framing === 'random' && <>
            <label className="gesso-setup-field"><span>Screen size</span><select aria-label="Random setup screen size" value={settings.aspect} onChange={event => update('aspect', event.target.value as RandomSetupSettings['aspect'])}>
              <option value="keep">Current</option>{(['16:9', '9:16', '1:1', '4:5'] as const).map(aspect => <option key={aspect} value={aspect}>{aspect}</option>)}
            </select></label>
            <label className="gesso-setup-field"><span>Duration · s</span><input aria-label="Duration in seconds" type="number" min={1} max={600} step={1} value={settings.durationSeconds} onChange={event=>{const value=event.target.valueAsNumber;if(Number.isFinite(value))update('durationSeconds',Math.max(1,Math.min(600,value)))}}/></label>
            <label className="gesso-setup-field"><span>Product shots</span><input aria-label="Product shots" type="number" min={2} max={24} step={1} value={settings.shotCount} onChange={event=>{const value=event.target.valueAsNumber;if(Number.isFinite(value))update('shotCount',Math.max(2,Math.min(24,Math.round(value))))}}/></label>
          </>}
          {settings.policies.framing === 'random' && <p className="gesso-setup-note">Every reel includes a full-product shot and a close-up.</p>}
          {selectedScope === 'colors' ? options.colors : <details className="gesso-setup-refine"><summary>Refine choices</summary><div className="gesso-setup-scopes">{selectedScopes.map(scope => <ScopeOptions key={scope.id} scope={scope} count={poolCounts[scope.id]}>{options[scope.id]}</ScopeOptions>)}</div></details>}
        </fieldset>
        <p className="gesso-setup-note">Geometry, placed artwork and product movement stay intact.</p>
        {hasDraft && <section className="gesso-setup-changes" aria-label="Preview changes"><h3>In this preview</h3>{changes.length ? <ul>{changes.map((change, index) => <li key={`${index}-${change}`}>{change}</li>)}</ul> : <p className="gesso-setup-note">No changes in this preview. Try another setup.</p>}</section>}
      </>}
    </div>
    <footer className="gesso-export-setup-footer">
      <p className="gesso-setup-preserved">Original scene kept</p>
      {tab === 'random' && <>
        {error && <p className="gesso-setup-error" role="alert">{error}</p>}
        {!error && blocked && <p className="gesso-setup-note" role="status">{blocked}</p>}
        {!error && !blocked && dirty && hasDraft && <p className="gesso-setup-note" role="status">Settings changed · generate to preview</p>}
        <button type="button" className="gesso-setup-generate" disabled={busy || !!blocked} onClick={onGenerate}><span>{busy ? 'Generating…' : hasDraft && !dirty ? 'Reroll setup' : 'Generate setup'}</span><UiIcon name="dice"/></button>
      </>}
    </footer>
  </section>;
}
