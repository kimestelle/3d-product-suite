import {useEffect, useMemo, useRef, useState} from 'react';
import type {WorldCoverItem} from './worldCover';
import './world-cleanup.css';

export type WorldCleanupSelection = {sourceSha256:string; groups:{nodeIndex:number;meshIndex:number;primitiveIndex:number;faceIndices:number[]}[]};
export type WorldCleanupPreview = {environment:any;label:string};
export type WorldCleanupRole = 'floor'|'wall'|'pool-rim'|'other';
export type WorldCleanupCandidate = {
  id:string; labelHint:string; faceCount:number; areaSourceUnits2:number;
  maxDeviationSourceUnits:number; rmsDeviationSourceUnits:number;
};
export type WorldCleanupAnalysis = {
  id:string; analysisId?:string; sourceSha256:string; candidates:WorldCleanupCandidate[];
  triangleCount:number; method:'geometric-only'; units:string; warnings?:string[];
};
export type WorldCleanupReport = {
  operation:'separate'|'flatten';role:WorldCleanupRole;selectedFaces:number;movedVertices:number;
  maxDisplacementSourceUnits:number;boundaryVerticesPreserved:number;sourceTriangles:number;outputTriangles:number;
  geometryChanged:boolean;appearanceTransfer?:string; warnings?:string[];
  initialRmsDeviationSourceUnits?:number;finalRmsDeviationSourceUnits?:number;
  requiredMaxDisplacementSourceUnits?:number;
};
type Prepared = {environment:any;report:WorldCleanupReport;analysisId:string;regionId:string};
export interface WorldCleanupPanelProps {
  scene:any; worlds:WorldCoverItem[]; scopeKey:string; available?:boolean; busy?:boolean;
  preview?:WorldCleanupPreview|null;
  onPreview?:(preview:WorldCleanupPreview|null)=>void|boolean;
  onApply?:(environment:any)=>void|boolean;
  onSelection?:(selection:WorldCleanupSelection|null)=>void;
  onFrame?:()=>void;
}
type Source={id:string;name:string;environment:any};
const roles:{value:WorldCleanupRole;label:string}[]=[{value:'floor',label:'Floor'},{value:'wall',label:'Wall'},{value:'pool-rim',label:'Pool rim'},{value:'other',label:'Other surface'}];
const amount=(value:number)=>Number.isFinite(value)?Number(value.toPrecision(4)).toString():'—';

/** A Gaussian's mesh sibling is offered explicitly; opening this panel never
 * changes representation or copies an unreviewed splat alignment to a mesh. */
export function worldCleanupSources(scene:any,worlds:WorldCoverItem[]):Source[]{
  const environment=scene.environment,provider=environment?.provenance?.providerWorldId;
  const sources:Source[]=[];
  if(environment?.kind==='mesh'&&environment.asset?.format==='glb')sources.push({id:'current',name:'Current mesh',environment});
  if(typeof provider==='string'&&provider.trim())for(const world of worlds){
    const candidate=world.environment;
    if(candidate?.kind!=='mesh'||candidate.asset?.format!=='glb'||candidate.provenance?.providerWorldId!==provider
      ||candidate.provenance?.representation!=='hq-visual-glb'||candidate.provenance?.referenceOnly
      ||candidate.asset.sha256===environment.asset?.sha256)continue;
    sources.push({id:world.id,name:world.name,environment:{...candidate,plinth:environment.plinth,props:environment.props,
      floorY:environment.floorY,studioSizeM:environment.studioSizeM}});
  }
  return sources;
}

export function cleanupCandidateSelection(value:unknown,analysis:WorldCleanupAnalysis,candidate:WorldCleanupCandidate):WorldCleanupSelection{
  const selection=value as WorldCleanupSelection;
  if(selection?.sourceSha256!==analysis.sourceSha256||!Array.isArray(selection.groups)||!selection.groups.length
    ||selection.groups.some(group=>!group||!['nodeIndex','meshIndex','primitiveIndex'].every(key=>Number.isSafeInteger(group[key as keyof typeof group])&&Number(group[key as keyof typeof group])>=0)
      ||!Array.isArray(group.faceIndices)||!group.faceIndices.length||group.faceIndices.some(face=>!Number.isSafeInteger(face)||face<0))
    ||selection.groups.reduce((total,group)=>total+group.faceIndices.length,0)!==candidate.faceCount)throw new Error('Region faces do not match this source analysis.');
  return selection;
}

async function request(path:string,payload:unknown,signal:AbortSignal){
  const response=await fetch(path,{method:'POST',credentials:'same-origin',signal,
    headers:{'Content-Type':'application/json','X-Product-Suite':'1'},body:JSON.stringify(payload)});
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||'The mesh could not be reviewed.');
  return value;
}
async function requestSelection(analysis:WorldCleanupAnalysis,candidate:WorldCleanupCandidate,signal:AbortSignal){
  const response=await fetch(`/api/world-cleanup/${encodeURIComponent(analysis.analysisId??analysis.id)}/regions/${encodeURIComponent(candidate.id)}`,
    {method:'GET',credentials:'same-origin',signal,headers:{'X-Product-Suite':'1'}});
  const value=await response.json();
  if(!response.ok)throw new Error(value.error||'The selected mesh region could not be inspected.');
  return cleanupCandidateSelection(value,analysis,candidate);
}

export default function WorldCleanupPanel({scene,worlds,scopeKey,available=false,busy=false,preview,onPreview,onApply,onSelection,onFrame}:WorldCleanupPanelProps){
  const sources=useMemo(()=>worldCleanupSources(scene,worlds),[scene,worlds]);
  const [sourceId,setSourceId]=useState(sources[0]?.id??'');
  useEffect(()=>{setSourceId(sources[0]?.id??'');},[scopeKey]);
  const source=sources.find(item=>item.id===sourceId)??sources[0];
  const [analysis,setAnalysis]=useState<WorldCleanupAnalysis|null>(null),[regionId,setRegionId]=useState('');
  const [role,setRole]=useState<WorldCleanupRole|''>(''),[planar,setPlanar]=useState(false),[budget,setBudget]=useState('0.01');
  const [prepared,setPrepared]=useState<Prepared|null>(null),[separated,setSeparated]=useState(false),[showSource,setShowSource]=useState(false);
  const [pending,setPending]=useState<'analysis'|'selection'|'separate'|'flatten'|null>(null),[error,setError]=useState('');
  const [inspectedRegion,setInspectedRegion]=useState('');
  const abort=useRef<AbortController|null>(null),generation=useRef(0),mounted=useRef(true),context=useRef('');
  const selectionCache=useRef(new Map<string,WorldCleanupSelection>());
  const inspectButton=useRef<HTMLButtonElement|null>(null);
  const callbacks=useRef({onPreview,onApply,onSelection});callbacks.current={onPreview,onApply,onSelection};
  const currentContext=JSON.stringify([scopeKey,source?.id,source?.environment?.asset]);context.current=currentContext;
  const sourceScene=source?{...scene,environment:source.environment}:null;
  const sourceSnapshot=useRef<any>(null);
  const region=analysis?.candidates.find(item=>item.id===regionId);
  const enabled=available&&!!onPreview&&!!onApply,locked=!enabled||busy||!!pending;
  const sourceVisible=!!preview&&preview.environment?.asset?.sha256===source?.environment?.asset?.sha256;
  const budgetValue=Number(budget),budgetValid=budget.trim()!==''&&Number.isFinite(budgetValue)&&budgetValue>=.000001&&budgetValue<=.2;
  const clearView=()=>{callbacks.current.onSelection?.(null);callbacks.current.onPreview?.(null);};
  useEffect(()=>{
    mounted.current=true;
    return()=>{mounted.current=false;generation.current++;abort.current?.abort();clearView();};
  },[]);
  useEffect(()=>{
    generation.current++;abort.current?.abort();abort.current=null;
    setAnalysis(null);setRegionId('');setRole('');setPlanar(false);setPrepared(null);setSeparated(false);setShowSource(false);setPending(null);setError('');setInspectedRegion('');selectionCache.current.clear();
    sourceSnapshot.current=null;clearView();
  },[currentContext]);
  const cancel=()=>{generation.current++;abort.current?.abort();abort.current=null;setPending(null);setError('');};
  const start=()=>{abort.current?.abort();const controller=new AbortController();abort.current=controller;return{controller,token:++generation.current,owner:context.current};};
  const owns=(token:number,owner:string,controller:AbortController)=>mounted.current&&!controller.signal.aborted&&generation.current===token&&context.current===owner;
  const inspect=async(candidate?:WorldCleanupCandidate)=>{
    if(!source||!enabled||busy||!analysis||!sourceSnapshot.current)return;
    const {controller,token,owner}=start();setError('');callbacks.current.onSelection?.(null);
    if(candidate)setPending('selection');
    try{
      const key=candidate?`${analysis.analysisId??analysis.id}/${candidate.id}`:'';
      const selection=candidate?(selectionCache.current.get(key)??await requestSelection(analysis,candidate,controller.signal)):null;
      if(!owns(token,owner,controller))return;
      if(callbacks.current.onPreview?.({environment:sourceSnapshot.current.environment,label:'Source mesh · cleanup review'})===false)throw new Error('Wait for the current scene to settle, then inspect this region again.');
      if(candidate&&selection){selectionCache.current.set(key,selection);setInspectedRegion(candidate.id);}
      callbacks.current.onSelection?.(selection);setShowSource(true);
    }catch(failure){if(owns(token,owner,controller)){setInspectedRegion('');setError(failure instanceof Error?failure.message:'The selected mesh region could not be inspected.');}}
    finally{if(owns(token,owner,controller)){abort.current=null;setPending(null);}}
  };
  const analyze=async()=>{
    if(locked||!sourceScene)return;
    const {controller,token,owner}=start(),snapshot=structuredClone(sourceScene);
    setPending('analysis');setError('');setPrepared(null);setSeparated(false);setInspectedRegion('');selectionCache.current.clear();callbacks.current.onSelection?.(null);
    try{
      const result=await request('/api/world-cleanup/analyze',{scene:snapshot},controller.signal) as WorldCleanupAnalysis;
      if(!owns(token,owner,controller))return;
      if(result.sourceSha256!==snapshot.environment.asset.sha256||!Array.isArray(result.candidates)||result.method!=='geometric-only')throw new Error('Analysis does not match the selected source mesh.');
      sourceSnapshot.current=snapshot;setAnalysis(result);setRegionId('');setRole('');setPlanar(false);
      if(callbacks.current.onPreview?.({environment:snapshot.environment,label:'Source mesh · cleanup review'})===false)throw new Error('Wait for the current scene to settle, then inspect the source mesh.');
      setShowSource(true);
      callbacks.current.onSelection?.(null);
    }catch(failure){if(owns(token,owner,controller))setError(failure instanceof Error?failure.message:'The mesh could not be analyzed.');}
    finally{if(owns(token,owner,controller)){abort.current=null;setPending(null);}}
  };
  const selectRegion=(candidate:WorldCleanupCandidate)=>{
    cancel();setRegionId(candidate.id);setRole('');setPlanar(false);setPrepared(null);setSeparated(false);setInspectedRegion('');setError('');void inspect(candidate);
  };
  const invalidatePrepared=()=>{
    setPrepared(null);setError('');if(region)void inspect(region);
  };
  const prepare=async(operation:'separate'|'flatten')=>{
    if(locked||!analysis||!region||inspectedRegion!==region.id||!role||!sourceSnapshot.current||(operation==='flatten'&&(!separated||!planar||!budgetValid)))return;
    const {controller,token,owner}=start();setPending(operation);setError('');
    try{
      const result=await request('/api/world-cleanup/preview',{scene:sourceSnapshot.current,
        analysisId:analysis.analysisId??analysis.id,regionId:region.id,role,operation,
        ...(operation==='flatten'?{maxDisplacementSourceUnits:budgetValue}:{})},controller.signal) as Prepared;
      if(!owns(token,owner,controller))return;
      if(result.analysisId!==(analysis.analysisId??analysis.id)||result.regionId!==region.id||!result.environment?.asset
        ||result.report?.operation!==operation||result.report.role!==role)throw new Error('Preview does not match this cleanup selection.');
      if(callbacks.current.onPreview?.({environment:result.environment,label:operation==='separate'?'Separated mesh · cleanup preview':'Flattened interior · cleanup preview'})===false)throw new Error('The scene changed while preparing this copy. Review it again.');
      setPrepared(result);setSeparated(true);setShowSource(false);callbacks.current.onSelection?.(null);
    }catch(failure){if(owns(token,owner,controller))setError(failure instanceof Error?failure.message:'The cleanup could not be previewed.');}
    finally{if(owns(token,owner,controller)){abort.current=null;setPending(null);}}
  };
  const apply=()=>{
    if(locked||!prepared||showSource||preview?.environment?.asset?.sha256!==prepared.environment.asset.sha256)return;
    const applied=callbacks.current.onApply?.(prepared.environment);
    if(applied===false){setError('The scene changed. Review this cleanup again.');return;}
    clearView();setPrepared(null);setSeparated(false);
    queueMicrotask(()=>inspectButton.current?.focus({preventScroll:true}));
  };
  const returnToCurrent=()=>{cancel();clearView();setShowSource(false);inspectButton.current?.focus({preventScroll:true});};
  return <details className="gesso-disclosure gesso-world-cleanup" onToggle={event=>{if(!event.currentTarget.open){cancel();clearView();setShowSource(false);}}}>
    <summary>Structure cleanup</summary>
    <section className="gesso-section" aria-label="Structure cleanup">
      <p className="gesso-meta">Find nearly planar regions, confirm a label, then review a separate mesh copy.</p>
      {!available&&<p className="gesso-meta gesso-note" role="status">Structure cleanup needs a connected backend.</p>}
      {!source&&<p className="gesso-meta gesso-note">Choose an imported mesh, or a Gaussian world with an HQ mesh sibling.</p>}
      {source&&<>
        <label className="gesso-field"><span>Source mesh</span><select aria-label="Cleanup source mesh" value={source.id} disabled={locked} onChange={event=>setSourceId(event.target.value)}>
          {sources.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {scene.environment.kind==='splat'&&<p className="gesso-meta gesso-note">Inspecting previews the mesh source. Apply explicitly replaces the Gaussian world with this mesh copy; alignment needs review.</p>}
        <button ref={inspectButton} type="button" disabled={locked} onClick={()=>void analyze()}>{pending==='analysis'?'Analyzing mesh…':analysis?'Analyze again':'Inspect mesh candidates'}</button>
        {pending&&<button type="button" onClick={cancel}>Cancel {pending==='analysis'?'analysis':pending==='selection'?'inspection':'preview'}</button>}
      </>}
      {analysis&&<>
        <p className="gesso-meta">{analysis.candidates.length} geometric candidates · {analysis.triangleCount.toLocaleString()} source triangles</p>
        <p className="gesso-meta gesso-note">Geometry suggests a shape, not an object identity. Labels below are yours to confirm.</p>
        {!!analysis.warnings?.length&&analysis.warnings.map((warning,index)=><p key={index} className="gesso-meta gesso-note">{warning}</p>)}
        {analysis.candidates.length>0?<fieldset className="gesso-cleanup-regions" disabled={locked}><legend>Candidate regions</legend>
          {analysis.candidates.map((candidate,index)=><label key={candidate.id}>
            <input type="radio" name="cleanup-region" aria-label={`Region ${index+1}: ${candidate.labelHint}`} checked={candidate.id===regionId} onChange={()=>selectRegion(candidate)}/>
            <span><strong>{index+1}. {candidate.labelHint}</strong><small>{candidate.faceCount.toLocaleString()} faces · max plane deviation {amount(candidate.maxDeviationSourceUnits)} source units</small></span>
          </label>)}
        </fieldset>:<p className="gesso-meta">No suitable near-planar region found. The source stays unchanged.</p>}
      </>}
      {analysis&&region&&<>
        <div className="gesso-button-row"><button type="button" disabled={locked} onClick={()=>void inspect(region)}>{pending==='selection'?'Loading region faces…':'Inspect selected region'}</button>
          {onFrame&&<button type="button" disabled={locked||!sourceVisible||inspectedRegion!==region.id} onClick={onFrame}>Frame region</button>}
        </div>
        <label className="gesso-field"><span>Confirm surface label</span><select aria-label="Cleanup surface label" value={role} disabled={locked} onChange={event=>{setRole(event.target.value as WorldCleanupRole|'');setSeparated(false);setPlanar(false);invalidatePrepared();}}>
          <option value="">Choose a label…</option>{roles.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
        </select></label>
        <button type="button" disabled={locked||!role||inspectedRegion!==region.id} onClick={()=>void prepare('separate')}>{pending==='separate'?'Preparing separate mesh…':'Preview separate mesh'}</button>
        <p className="gesso-meta gesso-note">Separation retains the original vertex positions, UVs and material atlas. Unassigned surroundings remain.</p>
        {separated&&<fieldset className="gesso-cleanup-repair" disabled={locked}>
          <legend>Optional planar repair</legend>
          <label className="gesso-check"><input type="checkbox" checked={planar} onChange={event=>{setPlanar(event.target.checked);if(prepared?.report.operation==='flatten')invalidatePrepared();}}/><span>This selected patch should be planar</span></label>
          <label className="gesso-field"><span>Maximum movement · source units</span><input aria-label="Maximum cleanup displacement" type="number" min="0.000001" max="0.2" step="0.001" value={budget} onChange={event=>{setBudget(event.target.value);if(prepared?.report.operation==='flatten')invalidatePrepared();}}/></label>
          <button type="button" disabled={!planar||!budgetValid} onClick={()=>void prepare('flatten')}>{pending==='flatten'?'Preparing planar repair…':'Preview flatten interior'}</button>
          <p className="gesso-meta gesso-note">Boundary vertices stay fixed. This pass does not infer hidden surfaces or straighten baked texture lines.</p>
        </fieldset>}
      </>}
      {prepared&&<section className="gesso-cleanup-result" aria-label="Cleanup preview measurements">
        <div className="gesso-button-row" role="group" aria-label="Compare cleanup">
          <button type="button" aria-pressed={showSource} disabled={locked} onClick={()=>void inspect(region)}>Source mesh</button>
          <button type="button" aria-pressed={!showSource} disabled={locked} onClick={()=>{if(callbacks.current.onPreview?.({environment:prepared.environment,label:prepared.report.operation==='separate'?'Separated mesh · cleanup preview':'Flattened interior · cleanup preview'})===false){setError('Wait for the current scene to settle, then compare this copy again.');return;}setShowSource(false);callbacks.current.onSelection?.(null);}}>{prepared.report.operation==='separate'?'Separated mesh':'Flattened interior'}</button>
        </div>
        <dl><div><dt>Selected faces</dt><dd>{prepared.report.selectedFaces.toLocaleString()}</dd></div>
          <div><dt>Moved vertices</dt><dd>{prepared.report.movedVertices.toLocaleString()}</dd></div>
          <div><dt>Maximum movement</dt><dd>{amount(prepared.report.maxDisplacementSourceUnits)} source units</dd></div>
          <div><dt>Boundary vertices kept</dt><dd>{prepared.report.boundaryVerticesPreserved.toLocaleString()}</dd></div>
          {typeof prepared.report.initialRmsDeviationSourceUnits==='number'&&typeof prepared.report.finalRmsDeviationSourceUnits==='number'&&<div><dt>Plane RMS · before / after</dt><dd>{amount(prepared.report.initialRmsDeviationSourceUnits)} / {amount(prepared.report.finalRmsDeviationSourceUnits)}</dd></div>}
          <div><dt>Triangles</dt><dd>{prepared.report.outputTriangles.toLocaleString()}</dd></div></dl>
        {prepared.report.appearanceTransfer&&<p className="gesso-meta gesso-note">{prepared.report.appearanceTransfer}</p>}
        {prepared.report.warnings?.map((warning,index)=><p key={index} className="gesso-meta gesso-note">{warning}</p>)}
        <button type="button" disabled={locked||showSource||preview?.environment?.asset?.sha256!==prepared.environment.asset.sha256} onClick={apply}>Apply {prepared.report.operation==='separate'?'separated mesh':'flattened interior'}</button>
        <p className="gesso-meta">Apply is one undoable edit. Save the campaign to keep it.</p>
      </section>}
      {preview&&<button type="button" onClick={returnToCurrent}>Return to current world</button>}
      {error&&<p className="gesso-meta gesso-cleanup-error" role="alert">{error}</p>}
    </section>
  </details>;
}
