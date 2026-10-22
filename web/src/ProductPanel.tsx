import ModelOutlinePreview,{type ModelOutlineCapture} from './ModelOutlinePreview';
import {EditorCabinetBody} from './editorMotion';
import {UiIcon} from './UiIcon';
import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import PartNameField from './PartNameField';
import PartOptionsMenu from './PartOptionsMenu';
import {partRemovalPlan,removeProductPart} from './partRemoval';
import {partTargetIds,removedPartIds} from './partTargets';
import {DecalControls} from './DecalEditor';
import MaterialLibrary from './MaterialLibrary';
import ProductImportNotes from './ProductImportNotes';
import {campaignMaterialPresets} from './materialPresets';
import type {MaterialHover, MaterialPreview} from './materials';
import type {TransformMode} from './transforms';
import type {ProductDecal, UvLayout} from './decals';
import {NumberControl as NumberField, VectorControl as VectorField} from './EditorControls';
import {
  canSuggestFixtureGrouping, changeParent, keepGrouping, orderedParts, parentCandidates,
  displayPartName, partName, renamePart, resolveHierarchy, sceneParts,
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
  onMaterialHover?: (hover: MaterialHover | null) => void;
  onSelect: (id: string) => void;
  onChange: (edit: (scene: any) => void) => void;
  onLayer: (layer: ProductLayer) => void;
  focused: boolean;
  onToggleFocus: () => void;
  onFrame: () => void;
  hiddenParts: string[];
  onToggleVisibility: (id: string) => void;
  onImport: () => void;
  onRemoved?: (name:string) => void;
  captureOutline?: ModelOutlineCapture;
  outlineRevision?: string;
  outlineReady?: boolean;
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

export default function ProductPanel(props: ProductPanelProps) {
  const {scene, partId, layer, workspace = 'product', onSelect, onChange, focused, onToggleFocus, onFrame, hiddenParts, onToggleVisibility} = props;
  const allSourceParts = props.parts.length ? props.parts : sceneParts(scene);
  const removed=removedPartIds(scene);
  const sourceParts=allSourceParts.filter(item=>!removed.has(item.id));
  const availableTargets=new Set(partTargetIds(scene));
  const fixtureGrouping = canSuggestFixtureGrouping(scene, sourceParts);
  const parts = sourceParts.map(part => ({...part, name: displayPartName(scene, part.id, fixtureGrouping ? partName(part.id) : part.name)}));
  const part = parts.find(item => item.id === partId) ?? parts[0];
  const component = scene?.product?.components?.find((item: any) => item.id === part?.componentId);
  const sourceChild = !!part && part.id !== part.componentId;
  const hierarchy = resolveHierarchy(scene, parts);
  const [feedback, setFeedback] = useState<{message:string;tone:'success'|'error'|'note'}|null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [hoveredPart,setHoveredPart]=useState<string|null>(null);
  const [decalVisualHost,setDecalVisualHost]=useState<HTMLDivElement|null>(null);
  const [mechanicsOpen, setMechanicsOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const inspectorScroll = useRef<HTMLDivElement>(null);
  const panelRef=useRef<HTMLDivElement>(null);
  const focusAfterRemoval=useRef<string|null|undefined>(undefined);
  useLayoutEffect(()=>{
    const id=focusAfterRemoval.current;if(id===undefined)return;focusAfterRemoval.current=undefined;
    const button=id?[...panelRef.current?.querySelectorAll<HTMLButtonElement>('.gesso-part-select')??[]].find(element=>element.dataset.partId===id):panelRef.current?.querySelector<HTMLButtonElement>('[data-part-import]');
    button?.focus({preventScroll:true});
  },[scene,partId]);
  const [renameRequest, setRenameRequest] = useState<string | null>(null);
  useEffect(() => {setFeedback(null);}, [scene?.sceneId, layer, workspace]);
  useEffect(() => {inspectorScroll.current?.scrollTo({top:0});}, [part?.id]);
  useEffect(() => {setFeedback(null); setMechanicsOpen(false);}, [partId, workspace]);
  useEffect(() => {
    if (renameRequest !== part?.id || workspace !== 'product' || mechanicsOpen) return;
    nameRef.current?.focus();
    nameRef.current?.select();
    setRenameRequest(null);
  }, [renameRequest, part?.id, workspace, mechanicsOpen]);
  if(scene&&!sourceParts.length&&removed.size)return <div ref={panelRef} className="gesso-panel gesso-product-panel"><p className="gesso-note">All parts removed. Undo to restore them.</p>{workspace==='product'&&<button type="button" data-part-import onClick={props.onImport}>Import product…</button>}</div>;
  if (!scene || !part || !component) return <div className="gesso-panel gesso-product-panel"><p className="gesso-note">Loading product parts…</p></div>;

  const parent = hierarchy.parents[part.id];
  const beginRename = (id: string) => {
    if (workspace !== 'product') return;
    onSelect(id); setMechanicsOpen(false); setRenameRequest(id);
  };
  const focusControls = <div className="gesso-button-row">
    {(workspace !== 'material' || layer !== 'Materials') && <button type="button" onClick={onToggleFocus}>{focused ? 'Show assembly' : 'Focus part'}</button>}
    <button type="button" onClick={onFrame} title="Frame part (F)">Frame</button>
  </div>;

  const treeParents = hierarchy.parents;
  const hiddenByAncestor = (id: string) => {
    let current = treeParents[id];
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (collapsed.includes(current)) return true;
      seen.add(current); current = treeParents[current];
    }
    return false;
  };
  const highlighted=hoveredPart ?? part.id;
  const highlightIds=parts.filter(item=>{let id:string|null=item.id;const seen=new Set<string>();while(id&&!seen.has(id)){if(id===highlighted)return true;seen.add(id);id=hierarchy.parents[id];}return false;}).map(item=>item.id);
  const tree = <ul className="gesso-part-tree" aria-label="Objects">
    {orderedParts(parts, treeParents).filter(({part: item}) => !hiddenByAncestor(item.id)).map(({part: item, depth}) => {
      const hasChildren = parts.some(child => treeParents[child.id] === item.id);
      return <li key={item.id} className={`gesso-part-row ${part.id === item.id ? 'selected' : ''}`} style={{marginLeft: depth * 20}} onPointerEnter={()=>setHoveredPart(item.id)} onPointerLeave={()=>setHoveredPart(null)} onFocus={()=>setHoveredPart(item.id)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setHoveredPart(null);}}>
        {hasChildren ? <button type="button" className="gesso-tree-toggle" aria-label={`${collapsed.includes(item.id) ? 'Expand' : 'Collapse'} ${item.name}`}
          aria-expanded={!collapsed.includes(item.id)} onClick={() => setCollapsed(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}><UiIcon name={collapsed.includes(item.id) ? "chevron" : "down"} size={14}/></button>
          : <span className="gesso-tree-spacer" aria-hidden="true">{depth ? '↳' : '·'}</span>}
        <button type="button" className="gesso-part-select" data-part-id={item.id} aria-pressed={part.id === item.id} onClick={() => onSelect(item.id)}
          title={workspace === 'product' ? 'Double-click or press F2 to rename' : undefined}
          onDoubleClick={() => beginRename(item.id)} onKeyDown={event => {
            if (event.key === 'F2' && workspace === 'product') {event.preventDefault(); event.stopPropagation(); beginRename(item.id);}
          }}>
          <span className="gesso-part-name">{item.name}</span>
          {hierarchy.status[item.id] !== 'source' && <span className={`gesso-status ${hierarchy.status[item.id]}`}>{hierarchy.status[item.id]}</span>}
        </button>
        <button type="button" className="gesso-visibility" aria-label={`${hiddenParts.includes(item.id) ? 'Show' : 'Hide'} ${item.name}`}
          aria-pressed={!hiddenParts.includes(item.id)} onClick={() => onToggleVisibility(item.id)} title={hiddenParts.includes(item.id) ? 'Show part' : 'Hide part'}>
          <UiIcon name={hiddenParts.includes(item.id) ? "eyeoff" : "eye"} size={14}/>
        </button>
        {workspace==='product'&&<PartOptionsMenu name={item.name} disabled={!availableTargets.has(item.id)}
          removalCount={()=>partRemovalPlan(scene,allSourceParts,item.id).ids.length}
          onRename={()=>beginRename(item.id)} onRemove={()=>{
            const plan=partRemovalPlan(scene,allSourceParts,item.id);
            focusAfterRemoval.current=plan.nextId;
            onChange(next=>removeProductPart(next,allSourceParts,item.id));
            if(plan.nextId)onSelect(plan.nextId);
            props.onRemoved?.(item.name);
          }}/>}
      </li>;
    })}
  </ul>;

  const action = scene.actions?.find((item: any) => item.componentId === component.id);
  const editAction = (edit: (action: any) => void) => onChange(next => {
    const target = next.actions.find((item: any) => item.actionId === action.actionId);
    if (target) edit(target);
  });


  const modelContent = <>
    <section className="gesso-section gesso-model-selection" aria-label="Selected object">
      <PartNameField key={part.id} name={part.name} inputRef={nameRef} onCommit={name => onChange(next => renamePart(next, sourceParts, part.id, name))}/>
      <p className="gesso-meta">{(part.dimensionsM ?? component.sizeM).map((value: number) => Number((value * 1000).toFixed(1))).join(' × ')} mm</p>
      <Field label="Parent"><select aria-label="Parent" value={parent ?? ''} title="Groups this object in the list. Motion stays unchanged." onChange={event => {
        const parentId = event.target.value || null;
        if (parentId === parent) return;
        try {
          onChange(next => changeParent(next, parts, part.id, parentId));
          // Keep the selected row visible when its new parent is collapsed.
          const ancestors = new Set<string>();
          let current = parentId;
          while (current && !ancestors.has(current)) {ancestors.add(current); current = hierarchy.parents[current];}
          setCollapsed(ids => ids.filter(id => !ancestors.has(id)));
          setFeedback(null);
        } catch (error) {setFeedback({message:error instanceof Error ? error.message : 'Could not change parent.',tone:'error'});}
      }}><option value="">Top level</option>{parentCandidates(scene, parts, part.id).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></Field>
    </section>
    {(hierarchy.status[part.id] === 'suggested' || hierarchy.recovered > 0) && <div ref={inspectorScroll} className="gesso-part-inspector-scroll">
      {hierarchy.status[part.id] === 'suggested' && <section className="gesso-section">
        <p className="gesso-meta gesso-note">{fixtureGrouping && part.id === 'label' ? 'Label lies on the body’s front surface.' : 'Review this proposed grouping.'}</p>
        <button type="button" className="gesso-text-button" onClick={() => {onChange(next => keepGrouping(next, parts, part.id)); setFeedback({message:'Grouping kept',tone:'success'});}}>Keep grouping</button>
      </section>}
      {hierarchy.recovered > 0 && <p className="gesso-meta gesso-note">{hierarchy.recovered} unavailable or invalid grouping {hierarchy.recovered === 1 ? 'entry was' : 'entries were'} omitted.</p>}
    </div>}
  </>;
  const materialContent = <MaterialLibrary onPreview={props.onPreview} onHover={props.onMaterialHover} editorHost={props.editorHost}
    scene={scene} componentId={part.id} parts={parts} onSelect={onSelect} onChange={onChange}/>;
  const decalContent = <>
      <DecalControls visualHost={decalVisualHost} scene={scene} partId={part.id} decal={props.decal} layout={props.uvLayout ?? null}
        onSelect={props.onSelectDecal ?? (() => {})} onAdd={props.onAddDecal ?? (() => {})} onChange={onChange}/>
    </>
;
  const mechanicsContent = action && !sourceChild && <details className="gesso-disclosure gesso-product-mechanics" open={mechanicsOpen} onToggle={event=>setMechanicsOpen(event.currentTarget.open)}><summary>Mechanics <span>{action.type==='lift'?'Lift':'Screw'} · {displayPartName(scene, action.relativeTo)}</span></summary>
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
  const activeMaterialSection = sections.find(section=>section.id===activeMaterialLayer)!;
  const showMechanics = mechanicsOpen && !!action && !sourceChild;
  const materialLibrary = workspace === 'material' && activeMaterialLayer === 'Materials';
  return <div ref={panelRef} className={`gesso-panel gesso-product-panel gesso-condensed-product gesso-workspace-${workspace}`}>
    {workspace==='product'&&<ModelOutlinePreview capture={props.captureOutline} revision={props.outlineRevision??scene.sceneId} ready={props.outlineReady??false} highlightIds={hoveredPart?highlightIds:[]} name={parts.find(item=>item.id===highlighted)?.name??'Model'}/>}
    {workspace==='material'&&layer==='Decals'&&<div className="gesso-decal-visual-host" ref={setDecalVisualHost}/>}
    {workspace!=='animation'&&<ProductImportNotes metadata={scene.product.metadata}/>}
    {!materialLibrary&&<section className="gesso-fixed-parts"><div className="gesso-section-heading"><span>{scene.product.displayName||(fixtureGrouping?'MORA bottle':'Product')}</span>{workspace==='product'&&<button type="button" className="gesso-text-button" onClick={props.onImport}>Import</button>}</div><div className="gesso-section-heading"><span className="gesso-section-label">Objects</span></div>{tree}{workspace!=='product'&&focusControls}</section>}
    {workspace==='product'&&<div className="gesso-control-sections">
      <section className={`gesso-control-section gesso-product-structure${showMechanics?'':' is-open'}`}>
        <button type="button" className="gesso-section-toggle gesso-section-selector" aria-current={!showMechanics ? "true" : undefined} aria-controls="product-section-Model" onClick={()=>setMechanicsOpen(false)}><span className="gesso-section-label">Part details</span></button>
        <EditorCabinetBody open={!showMechanics} id="product-section-Model">{modelContent}</EditorCabinetBody>
      </section>
      {mechanicsContent}
    </div>}
    {workspace==='material'&&<div className="gesso-control-sections">
      <section className="gesso-control-section is-open" key={activeMaterialLayer} aria-labelledby={`product-section-${activeMaterialLayer}-heading`}>
        <div className="gesso-section-heading"><span className="gesso-section-label" id={`product-section-${activeMaterialLayer}-heading`}>{activeMaterialSection.name}</span><span>{activeMaterialSection.summary}</span></div>
        <EditorCabinetBody open id={`product-section-${activeMaterialLayer}`}>{activeMaterialSection.content}</EditorCabinetBody>
      </section>
    </div>}
    {workspace==='animation'&&<div className="gesso-animation-selection"><p className="gesso-meta gesso-note">Position, rotation, scale + keyframes below.</p></div>}
    {feedback&&<p className="gesso-meta gesso-feedback" data-tone={feedback.tone} role="status">{feedback.message}</p>}
  </div>;
}
