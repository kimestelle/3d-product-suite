import {UiIcon} from './UiIcon';
import {useEffect, useState, type ReactNode} from 'react';
import {DecalControls} from './DecalEditor';
import MaterialLibrary from './MaterialLibrary';
import {campaignMaterialPresets} from './materialPresets';
import type {MaterialPreview} from './materials';
import type {TransformMode} from './transforms';
import type {ProductDecal, UvLayout} from './decals';
import {NumberControl as NumberField, VectorControl as VectorField} from './EditorControls';
import {
  canSuggestFixtureGrouping, changeParent, keepGrouping, orderedParts, parentCandidates,
  partName, resolveHierarchy, restoreSourceHierarchy, sceneParts, suggestFixtureGrouping,
  type HierarchyPart,
} from './hierarchy';

export type ProductLayer = 'Model' | 'Materials' | 'Decals' | 'Animation';
export interface ProductPanelProps {
  scene: any;
  partId: string | null;
  parts: HierarchyPart[];
  layer: ProductLayer;
  workspace?: 'product' | 'material' | 'animation';
  editorHost?: HTMLElement | null;
  positionSpace?: 'world'|'local';
  onPositionSpace?:(space:'world'|'local')=>void;
  transformMode?:TransformMode|null;
  onPreview?: (preview: MaterialPreview | null) => void;
  onSelect: (id: string) => void;
  onChange: (edit: (scene: any) => void) => void;
  onLayer: (layer: ProductLayer) => void;
  focused: boolean;
  onToggleFocus: () => void;
  onFrame: () => void;
  hiddenParts: string[];
  onToggleVisibility: (id: string) => void;
  onImport: () => void;
  decal?: ProductDecal;
  uvLayout?: UvLayout | null;
  onSelectDecal?: (id: string) => void;
  onAddDecal?: () => void;
  frame?: number;
  onPreviewFrame?: (frame: number) => void;
}

function Field({label, children}: {label: string; children: ReactNode}) {
  return <label className="gesso-field"><span>{label}</span>{children}</label>;
}

const statusLabels = {source: 'Source', suggested: 'Suggested', confirmed: 'Confirmed', edited: 'Edited'};

export default function ProductPanel(props: ProductPanelProps) {
  const {scene, partId, layer, workspace = 'product', onSelect, onChange, focused, onToggleFocus, onFrame, hiddenParts, onToggleVisibility} = props;
  const sourceParts = props.parts.length ? props.parts : sceneParts(scene);
  const fixtureGrouping = canSuggestFixtureGrouping(scene, sourceParts);
  const parts = fixtureGrouping ? sourceParts.map(part => ({...part, name: partName(part.id)})) : sourceParts;
  const part = parts.find(item => item.id === partId) ?? parts[0];
  const component = scene?.product?.components?.find((item: any) => item.id === part?.componentId);
  const sourceChild = !!part && part.id !== part.componentId;
  const hierarchy = resolveHierarchy(scene, parts);
  const [view, setView] = useState<'parts' | 'source' | 'parent'>('parts');
  const [parentDraft, setParentDraft] = useState('');
  const [feedback, setFeedback] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [mechanicsOpen, setMechanicsOpen] = useState(false);
  useEffect(() => {setView('parts'); setFeedback('');}, [scene?.sceneId, layer, workspace]);
  useEffect(() => {setView(current => current === 'parent' ? 'parts' : current); setFeedback(''); setMechanicsOpen(false);}, [partId, workspace]);
  if (!scene || !part || !component) return <div className="gesso-panel gesso-product-panel"><p className="gesso-note">Loading product parts…</p></div>;

  const parent = hierarchy.parents[part.id];
  const parentName = parent ? parts.find(item => item.id === parent)?.name ?? parent : 'Product';
  const editComponent = (edit: (component: any) => void) => onChange(next => {
    const target = next.product.components.find((item: any) => item.id === component.id);
    if (target) edit(target);
  });
  const showComponent = <button type="button" onClick={() => onSelect(component.id)}>Select {partName(component.id)}</button>;
  const focusControls = <div className="gesso-button-row">
    {(workspace !== 'material' || layer !== 'Materials') && <button type="button" onClick={onToggleFocus}>{focused ? 'Show assembly' : 'Focus part'}</button>}
    <button type="button" onClick={onFrame} title="Frame part (F)">Frame</button>
  </div>;

  const treeParents = view === 'source' ? hierarchy.sourceParents : hierarchy.parents;
  const hiddenByAncestor = (id: string) => {
    let current = treeParents[id];
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (collapsed.includes(current)) return true;
      seen.add(current); current = treeParents[current];
    }
    return false;
  };
  const tree = <ul className="gesso-part-tree" aria-label={view === 'source' ? 'Source objects' : 'Product parts'}>
    {orderedParts(parts, treeParents).filter(({part: item}) => !hiddenByAncestor(item.id)).map(({part: item, depth}) => {
      const hasChildren = parts.some(child => treeParents[child.id] === item.id);
      return <li key={item.id} className={`gesso-part-row ${part.id === item.id ? 'selected' : ''}`} style={{marginLeft: depth * 20}}>
        {hasChildren ? <button type="button" className="gesso-tree-toggle" aria-label={`${collapsed.includes(item.id) ? 'Expand' : 'Collapse'} ${item.name}`}
          aria-expanded={!collapsed.includes(item.id)} onClick={() => setCollapsed(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}><UiIcon name={collapsed.includes(item.id) ? "chevron" : "down"} size={14}/></button>
          : <span className="gesso-tree-spacer" aria-hidden="true">{depth ? '↳' : '·'}</span>}
        <button type="button" className="gesso-part-select" aria-pressed={part.id === item.id} onClick={() => onSelect(item.id)}>
          <span className="gesso-part-name">{view === 'source' ? item.sourceName : item.name}</span>
          {view !== 'source' && hierarchy.status[item.id] !== 'source' && <span className={`gesso-status ${hierarchy.status[item.id]}`}>{hierarchy.status[item.id]}</span>}
        </button>
        <button type="button" className="gesso-visibility" aria-label={`${hiddenParts.includes(item.id) ? 'Show' : 'Hide'} ${item.name}`}
          aria-pressed={!hiddenParts.includes(item.id)} onClick={() => onToggleVisibility(item.id)} title={hiddenParts.includes(item.id) ? 'Show part' : 'Hide part'}>
          <UiIcon name={hiddenParts.includes(item.id) ? "eyeoff" : "eye"} size={14}/>
        </button>
      </li>;
    })}
  </ul>;

  const canEditMaterial = !sourceChild && (component.shape !== 'mesh' || component.materialOverride === true);
  const action = scene.actions?.find((item: any) => item.componentId === component.id);
  const editAction = (edit: (action: any) => void) => onChange(next => {
    const target = next.actions.find((item: any) => item.actionId === action.actionId);
    if (target) edit(target);
  });


  const modelContent = <>
      {view === 'parent' && <section className="gesso-section">
        <Field label="Parent"><select value={parentDraft} onChange={event=>setParentDraft(event.target.value)}><option value="">Product</option>{parentCandidates(scene,parts,part.id).map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></Field>
        <div className="gesso-button-row"><button type="button" onClick={()=>{if(parentDraft&&!parentCandidates(scene,parts,part.id).some(item=>item.id===parentDraft)){setFeedback('That parent is no longer available.');return;}onChange(next=>changeParent(next,parts,part.id,parentDraft||null));setView('parts');}}>Apply parent</button><button type="button" onClick={()=>setView('parts')}>Cancel</button></div>
      </section>}
      {view === 'source' ? <section className="gesso-section">
        <div className="gesso-section-heading">Selection</div>
        <div className="gesso-selected-name">{part.name}</div>
        <dl className="gesso-facts"><div><dt>Source object</dt><dd>{part.sourceName}</dd></div>
          <div><dt>Source parent</dt><dd>{hierarchy.sourceParents[part.id] ? parts.find(item => item.id === hierarchy.sourceParents[part.id])?.sourceName : 'Product'}</dd></div>
          <div><dt>Geometry</dt><dd>{part.source === 'glb' ? 'GLB node' : component.shape}</dd></div>
          {part.sourcePath && <div><dt>Node path</dt><dd>{part.sourcePath}</dd></div>}</dl>
        {!!part.materialSlots?.length && <><div className="gesso-section-heading">Material slots</div>{part.materialSlots.map(slot => <div className="gesso-source-slot" key={slot.id}>{slot.name || slot.id}</div>)}</>}
        <p className="gesso-meta">Original source structure. Names and parents are read-only.</p>
        <button type="button" onClick={() => setView('parts')}>Editing hierarchy</button>
      </section> : view === 'parts' && <>
        <section className="gesso-section gesso-model-selection">
          <div className="gesso-section-heading">Selection</div>
          <div className="gesso-selected-name">{part.name}</div>
          <p className="gesso-meta">{(part.dimensionsM ?? component.sizeM).map((value: number) => Number((value * 1000).toFixed(1))).join(' × ')} mm</p>
          <dl className="gesso-facts"><div><dt>Parent</dt><dd>{parentName}</dd></div>
            <div><dt>Structure</dt><dd>{statusLabels[hierarchy.status[part.id]]}</dd></div></dl>
          {hierarchy.status[part.id] === 'suggested' && <>
            <p className="gesso-meta">{fixtureGrouping && part.id === 'label' ? 'Label lies on the body’s front surface.' : 'Review this proposed grouping.'}</p>
            <button type="button" onClick={() => {onChange(next => keepGrouping(next, parts, part.id)); setFeedback('Grouping kept');}}>Keep grouping</button>
          </>}
          <button type="button" onClick={() => {setParentDraft(parent ?? ''); setView('parent');}}>Change parent</button>
          <button type="button" onClick={() => {setCollapsed([]); setView('source');}}>Source objects</button>
        </section>
        <button type="button" onClick={() => {onChange(restoreSourceHierarchy); setCollapsed([]); setFeedback('Source hierarchy restored');}}>Restore source hierarchy</button>
        {canSuggestFixtureGrouping(scene, parts) && hierarchy.status.label === 'source' && <button type="button" className="gesso-text-button" onClick={() => {
          onChange(next => suggestFixtureGrouping(next, parts)); onSelect('label'); setCollapsed([]); setFeedback('Grouping suggested');
        }}>Suggest grouping</button>}
      </>}
      {hierarchy.recovered > 0 && <p className="gesso-meta">{hierarchy.recovered} unavailable or invalid grouping {hierarchy.recovered === 1 ? 'entry was' : 'entries were'} omitted.</p>}
    </>;
  const materialContent = <>
    <>
      {sourceChild ? <section className="gesso-section"><div className="gesso-section-heading">Source materials</div>
        {(part.materialSlots ?? []).map(slot => <div key={slot.id} className="gesso-source-slot">{slot.name || slot.id}</div>)}
        <p className="gesso-note">Per-node material editing is not available yet. A component override applies to every mesh in that component.</p>{showComponent}
      </section> : <>
        {component.shape === 'mesh' && <section className="gesso-section">
          <label className="gesso-check"><input type="checkbox" checked={component.materialOverride === true} onChange={event => {const checked = event.target.checked; editComponent(target => {target.materialOverride = checked; if (!checked) delete target.materialPresetId;});}}/><span>Override component material</span></label>
          <p className="gesso-meta">{component.materialOverride ? 'One material replaces every imported slot. Turn off to restore the source materials and textures.' : 'Original materials, textures and UVs are preserved. Enable the override to apply a preset.'}</p>
        </section>}
        <MaterialLibrary onPreview={props.onPreview} editorHost={props.editorHost} scene={scene} componentId={component.id} partNames={Object.fromEntries(parts.filter(item=>item.id===item.componentId).map(item=>[item.id,item.name]))} disabled={!canEditMaterial} onChange={onChange}/>
      </>}
    </>
</>;
  const decalContent = <>
      <DecalControls scene={scene} partId={part.id} decal={props.decal} layout={props.uvLayout ?? null}
        onSelect={props.onSelectDecal ?? (() => {})} onAdd={props.onAddDecal ?? (() => {})} onChange={onChange}/>
    </>
;
  const sourceMovement = sourceChild && <><p className="gesso-note">This source node moves with {partName(component.id)}.</p>{showComponent}</>;
  const mechanicsContent = action && !sourceChild && <details className="gesso-disclosure gesso-product-mechanics" open={mechanicsOpen} onToggle={event=>setMechanicsOpen(event.currentTarget.open)}><summary>Mechanics <span>{action.type==='lift'?'Lift':'Screw'} · {partName(action.relativeTo)}</span></summary>
      <div className="gesso-mechanics-body">
      <VectorField label="Pivot" unit="mm" values={action.pivotM} factor={1000} step={.1} onChange={(index,value)=>editAction(target=>{target.pivotM[index]=value;})}/>
      <div className="gesso-button-row gesso-choice" aria-label="Movement axis">{['X','Y','Z'].map((axis,index)=><button key={axis} type="button" aria-pressed={action.axis.every((value:number,i:number)=>value===(i===index?1:0))} onClick={()=>editAction(target=>{target.axis=[0,0,0];target.axis[index]=1;})}>{axis}</button>)}</div>
      {action.type==='lift'?<NumberField label="Full travel" unit="mm" value={action.distanceM*1000} min={0} step={1} onChange={value=>editAction(target=>{target.distanceM=value/1000;})}/>:<>
        <NumberField label="Full turns" value={action.turns} min={0} step={.1} onChange={value=>editAction(target=>{target.turns=value;})}/>
        <NumberField label="Lead / turn" unit="mm" ariaLabel="Axial travel per turn" value={action.axialTravelPerRevolutionM*1000} min={.000001} step={.1} onChange={value=>editAction(target=>{target.axialTravelPerRevolutionM=value/1000;})}/>
        <Field label="Direction"><select value={action.directionSign} onChange={event=>{const value=Number(event.target.value);editAction(target=>{target.directionSign=value;});}}><option value={1}>Positive</option><option value={-1}>Negative</option></select></Field>
      </>}
      <details><summary>Movement source</summary>{(action.evidenceIds??[]).map((id:string)=><p className="gesso-meta" key={id}>{scene.evidence?.find((item:any)=>item.id===id)?.description??id}</p>)}</details>
      </div>
    </details>;
  const presetCount = campaignMaterialPresets(scene).length;
  const sections: {id:ProductLayer;name:string;summary:string;content:ReactNode}[] = [
    {id:'Materials',name:'Library',summary:`${presetCount} ${presetCount === 1 ? 'preset' : 'presets'}`,content:materialContent},
    {id:'Decals',name:'Decals',summary:`${(scene.product.decals??[]).filter((item:any)=>item.partId===part.id).length} applied`,content:decalContent},
  ];
  const activeMaterialLayer = layer === 'Decals' ? 'Decals' : 'Materials';
  const showMechanics = mechanicsOpen && !!action && !sourceChild;
  const materialLibrary = workspace === 'material' && activeMaterialLayer === 'Materials';
  return <div className={`gesso-panel gesso-product-panel gesso-condensed-product gesso-workspace-${workspace}`}>
    <section className="gesso-fixed-parts"><div className="gesso-section-heading"><span>{scene.product.displayName||(fixtureGrouping?'MORA bottle':'Product')}</span>{workspace==='product'&&<button type="button" className="gesso-text-button" onClick={props.onImport}>Import</button>}{materialLibrary&&<button type="button" className="gesso-text-button" onClick={onFrame} title="Frame part (F)">Frame</button>}</div>{tree}{!materialLibrary&&focusControls}</section>
    {workspace==='product'&&<div className="gesso-control-sections">
      <section className={`gesso-control-section gesso-product-structure${showMechanics?'':' is-open'}`}>
        <button type="button" className="gesso-section-toggle" aria-expanded={!showMechanics} aria-controls="product-section-Model" onClick={()=>setMechanicsOpen(false)}><span>Structure</span><small>{parentName}</small><UiIcon name={showMechanics ? "chevron" : "down"} size={14}/></button>
        {!showMechanics&&<div id="product-section-Model" className="gesso-section-body">{modelContent}{sourceMovement}</div>}
      </section>
      {mechanicsContent}
    </div>}
    {workspace==='material'&&<div className="gesso-control-sections">
      {sections.map((section,index)=><section className={`gesso-control-section${activeMaterialLayer===section.id?' is-open':''}`} key={section.id}>
        <button type="button" className="gesso-section-toggle" aria-expanded={activeMaterialLayer===section.id} aria-controls={`product-section-${section.id}`} onClick={()=>props.onLayer(section.id)} title={`Option / Alt ${index+5}`}><span>{section.name}</span><small>{section.summary}</small><UiIcon name={activeMaterialLayer===section.id ? "down" : "chevron"} size={14}/></button>
        {activeMaterialLayer===section.id&&<div id={`product-section-${section.id}`} className="gesso-section-body">{section.content}</div>}
      </section>)}
    </div>}
    {workspace==='animation'&&<div className="gesso-animation-selection"><p className="gesso-meta">Position, rotation, scale + keyframes below.</p>{sourceMovement}</div>}
    {feedback&&<p className="gesso-meta" role="status">{feedback}</p>}
  </div>;
}
