import {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {equalJson} from './state';
import MaterialSwatches from './MaterialSwatches';
import MaterialProperties, {type MaterialPropertySection} from './MaterialProperties';
import {UiIcon} from './UiIcon';
import PolyHavenLibrary from './PolyHavenLibrary';
import {campaignMaterialPresets, materialTypes, presetPartIds, saveMaterialPreset, type LibraryMaterialPreset, type MaterialType, type SavedMaterialPreset} from './materialPresets';
import type {MaterialPreview, MaterialSpecification} from './materials';
import './material-library.css';

type MaterialEntry = {id:string; name:string; material:MaterialSpecification; prompt?:string;provider?:string;sourceUrl?:string};
type MaterialJob = {id:string; state:string; material?:MaterialEntry; error?:string;notice?:string};
type Draft = SavedMaterialPreset & {isNew:boolean;sourceComponentId?:string};
const samePreset = (a:SavedMaterialPreset,b:SavedMaterialPreset) => a.id===b.id && a.name===b.name && a.type===b.type && equalJson(a.material,b.material);
const editablePreset = (preset:LibraryMaterialPreset):Draft => ({...preset,material:structuredClone(preset.material),isNew:!!preset.sourceComponentId});
const sameSurface = (a:MaterialSpecification,b:MaterialSpecification) => {
  const {name:_a,...surfaceA}=a, {name:_b,...surfaceB}=b;
  return equalJson(surfaceA,surfaceB);
};
const pending = (job:MaterialJob|null) => !!job && ['queued','running','submitting','downloading','cancelling'].includes(job.state);
async function request(path:string, method='GET', data?:unknown, signal?:AbortSignal) {
  const response = await fetch(path, {method, signal, headers:method === 'GET' ? {} : {'Content-Type':'application/json','X-Product-Suite':'1'},
    body:method === 'GET' ? undefined : JSON.stringify(data ?? {})});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed (' + response.status + ')');
  return value;
}

export default function MaterialLibrary({scene, componentId, partNames, disabled=false, onChange, onPreview, editorHost}:{
  scene:any;componentId:string;partNames:Record<string,string>;disabled?:boolean;editorHost?:HTMLElement|null;onChange:(edit:(scene:any)=>void)=>void;onPreview?:(preview:MaterialPreview|null)=>void;
}) {
  const [entries,setEntries] = useState<MaterialEntry[]>([]);
  const [configured,setConfigured] = useState<boolean|null>(null);
  const [prompt,setPrompt] = useState('');
  const [job,setJob] = useState<MaterialJob|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [retry,setRetry] = useState(0);
  const [choosingType,setChoosingType] = useState(false);
  const [draft,setDraft] = useState<Draft|null>(null);
  const [selectedId,setSelectedId] = useState<string|null>(null);
  const [feedback,setFeedback] = useState('');
  const [activeSection,setActiveSection] = useState<MaterialPropertySection|'textures'|null>('response');
  const textureContentId = useId();
  useEffect(()=>setActiveSection('response'),[draft?.id]);
  const mounted = useRef(true);
  const presetName = useRef<HTMLInputElement>(null);
  const editorBody = useRef<HTMLDivElement>(null);
  const draftSource = useRef<LibraryMaterialPreset|null>(null);
  const focusEditor = useRef(false);
  const draftScope = useRef('');
  useEffect(() => {if(editorBody.current)editorBody.current.scrollTop=0;},[editorHost,draft?.id,choosingType]);
  useEffect(() => {if(focusEditor.current && presetName.current){presetName.current.focus({preventScroll:true});focusEditor.current=false;}});
  useEffect(() => { mounted.current = true; return () => {mounted.current = false;}; }, []);
  useEffect(() => {
    const preset=campaignMaterialPresets(scene).find(item=>presetPartIds(scene,item).includes(componentId));
    draftSource.current=preset ?? null;draftScope.current=scene.sceneId+':'+componentId;
    setSelectedId(preset?.id ?? null);setChoosingType(false);setFeedback('');
    setDraft(preset ? editablePreset(preset) : null);
  }, [componentId,scene.sceneId]);
  useEffect(() => {
    const source=draftSource.current;
    if(!draft || !source || source.id!==draft.id)return;
    const currentPresets=campaignMaterialPresets(scene);
    const updated=currentPresets.find(preset=>preset.id===source.id);
    if(updated && samePreset(updated,source))return;
    if(!samePreset(draft,source)){setFeedback('The saved preset changed. Your unsaved draft is still here.');return;}
    const restored=updated ?? currentPresets.find(preset=>presetPartIds(scene,preset).includes(componentId));
    draftSource.current=restored ?? null;
    setDraft(restored ? editablePreset(restored) : null);setSelectedId(restored?.id ?? null);setFeedback('');
  }, [scene]);
  const accept = (next:MaterialJob) => {
    setJob(next);
    if (next.state === 'succeeded' && next.material) setEntries(current => [...current.filter(entry => entry.id !== next.material!.id),next.material!]);
  };
  useEffect(() => {
    const abort = new AbortController();
    request('/api/materials','GET',undefined,abort.signal).then(data => {
      setEntries(data.materials ?? []); setConfigured(data.configured === true); setError('');
      const active = (data.jobs ?? []).find((item:MaterialJob) => pending(item));
      if (active) setJob(active);
    }).catch(reason => {if (!abort.signal.aborted) setError(reason.message);});
    return () => abort.abort();
  }, [retry]);
  useEffect(() => {
    if (!pending(job)) return;
    const abort = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await request('/api/materials/jobs/' + job!.id,'GET',undefined,abort.signal);
        if (abort.signal.aborted) return;
        accept(next);
        if (pending(next)) timer = setTimeout(poll,2500);
      } catch (reason) {if (!abort.signal.aborted) setError((reason as Error).message);}
    };
    timer = setTimeout(poll,1200);
    return () => {abort.abort();clearTimeout(timer);};
  }, [job?.id,retry]);
  const presets = campaignMaterialPresets(scene);
  const label = (id:string) => partNames[id] ?? id;
  const assigned = presets.find(preset => presetPartIds(scene,preset).includes(componentId));
  const selected = presets.find(preset => preset.id === selectedId) ?? assigned ?? presets[0];
  const nameFor = (base:string) => {
    const names = new Set(presets.map(preset=>preset.name));
    if (!names.has(base)) return base;
    let n=2;while(names.has(base + ' ' + n)) n++;
    return base + ' ' + n;
  };
  const edit = (preset:LibraryMaterialPreset, duplicate=false) => {
    if(!duplicate && draft?.id===preset.id){presetName.current?.focus({preventScroll:true});return;}
    focusEditor.current=true;draftSource.current=duplicate ? null : preset;
    setFeedback('');setChoosingType(false);setSelectedId(duplicate ? null : preset.id);
    setDraft({id:duplicate ? crypto.randomUUID() : preset.id,
      name:duplicate ? nameFor(preset.name + ' copy') : preset.name, type:preset.type,
      material:structuredClone(preset.material),isNew:duplicate || !!preset.sourceComponentId,
      ...(!duplicate && preset.sourceComponentId ? {sourceComponentId:preset.sourceComponentId} : {})});
  };
  const newFromType = (id:string) => {
    const type=materialTypes.find(item=>item.id===id);if(!type)return;
    focusEditor.current=true;draftSource.current=null;
    setDraft({id:crypto.randomUUID(),name:nameFor(type.name),type:type.id,material:structuredClone(type.material),isNew:true});setChoosingType(false);
  };
  const closeEditor = () => {draftSource.current=null;setDraft(null);setChoosingType(false);setFeedback('');};
  const saveDraft = (applyToPart=false) => {
    if(!draft || !draft.name.trim() || (applyToPart && disabled))return;
    const preset:SavedMaterialPreset={id:draft.id,name:draft.name.trim(),type:draft.type,material:{...structuredClone(draft.material),name:draft.name.trim()}};
    const assignments=Array.from(new Set([...(draft.sourceComponentId ? [draft.sourceComponentId] : []),...(applyToPart ? [componentId] : [])]));
    try {
      saveMaterialPreset(structuredClone(scene),preset,assignments);
      draftSource.current=preset;
      onChange(next=>saveMaterialPreset(next,preset,assignments));setSelectedId(preset.id);setDraft({...preset,isNew:false});
      setFeedback(applyToPart ? 'Applied to ' + label(componentId) : draft.isNew && !assignments.length ? 'Preset added.' : 'Preset updated.');
    } catch(reason) {setFeedback((reason as Error).message);}
  };
  const useTexture = (entry:MaterialEntry) => {
    setEntries(current=>[...current.filter(item=>item.id!==entry.id),entry]);
    setDraft(current=>current ? {...current,type:'custom',material:{...structuredClone(entry.material),name:current.name}} : current);
  };
  const generate = async () => {
    if (busy || pending(job) || !configured || !prompt.trim()) return;
    setBusy(true); setError('');
    try {const next = await request('/api/materials/generate','POST',{prompt:prompt.trim()}); if (mounted.current) accept(next);}
    catch (reason) {if (mounted.current) setError((reason as Error).message);}
    finally {if (mounted.current) setBusy(false);}
  };
  const cancel = async () => {
    if (!job || busy) return;
    setBusy(true); setError('');
    try {const next = await request('/api/materials/jobs/' + job.id + '/cancel','POST'); if (mounted.current) accept(next);}
    catch (reason) {if (mounted.current) setError((reason as Error).message);}
    finally {if (mounted.current) setBusy(false);}
  };
  const draftParts=draft ? presetPartIds(scene,presets.find(preset=>preset.id===draft.id) ?? draft) : [];
  const previewParts=draftParts.length ? draftParts : disabled ? [] : [componentId];
  const changedSurface=!!draft && (!draftSource.current || !sameSurface(draft.material,draftSource.current.material));
  const preview=draft && draftScope.current===scene.sceneId+':'+componentId && (changedSurface || !draftParts.length) && previewParts.some(id=>{
    const component=scene.product.components.find((item:any)=>item.id===id);
    return component?.material && !sameSurface(component.material,draft.material);
  }) ? {componentIds:previewParts,material:draft.material} : null;
  const previewKey=JSON.stringify(preview);
  useEffect(()=>{onPreview?.(JSON.parse(previewKey));},[previewKey,onPreview]);
  useEffect(()=>()=>onPreview?.(null),[onPreview]);
  const editor = <div className="gesso-panel gesso-preset-editor-content">
    <div className="gesso-preset-editor-body" ref={editorBody}>
    {!draft && !choosingType && <p className="gesso-meta">Select a preset from the library to edit it.</p>}
    {choosingType && <section className="gesso-section" aria-label="Choose material type">
      <div className="gesso-preset-heading"><h2>New preset</h2><button type="button" className="gesso-text-button" onClick={closeEditor}>Cancel</button></div>
      <p className="gesso-meta">Start with a material type.</p>
      <MaterialSwatches items={materialTypes} onSelect={newFromType}/>
    </section>}
    {draft && <>
      <div className="gesso-preset-heading"><h2>{draft.name.trim() || 'New preset'}</h2><button type="button" className="gesso-text-button" onClick={()=>edit(draft,true)}>Duplicate</button></div>
      <div className="gesso-preset-scope"><UiIcon name="clock" size={12}/><span>{previewParts.length ? previewParts.map(label).join(', ') + ' · all frames' : 'Unassigned preset'}</span></div>
      <section className="gesso-preset-fields" aria-label="Edit material preset">
        <label className="gesso-field gesso-material-field"><span>Name</span><input ref={presetName} aria-label="Preset name" value={draft.name} maxLength={140} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
        <label className="gesso-field gesso-material-field"><span>Type</span><select aria-label="Material type" value={draft.type} onChange={event=>{
          const type=materialTypes.find(item=>item.id===event.target.value)!;
          const maps=draft.material.textures ? Object.fromEntries(['textures','textureRepeat','normalScale','heightScaleM'].filter(key=>draft.material[key as keyof MaterialSpecification] !== undefined).map(key=>[key,draft.material[key as keyof MaterialSpecification]])) : {};
          setDraft({...draft,type:type.id as MaterialType,material:{...structuredClone(type.material),...maps,name:draft.name}});
        }}>{materialTypes.map(type=><option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
      </section>
      <MaterialProperties material={draft.material} activeSection={activeSection==='textures' ? null : activeSection} onSectionChange={setActiveSection} onChange={material=>setDraft({...draft,material})}/>
      {!!draftParts.length && !draftParts.includes(componentId) && <button type="button" disabled={disabled || !draft.name.trim()} onClick={()=>saveDraft(true)}>Apply to {label(componentId)}</button>}
    </>}
    <div className="gesso-preset-textures" hidden={!draft}>
      <button className="gesso-section-toggle" type="button" aria-expanded={activeSection==='textures'} aria-controls={textureContentId} onClick={()=>setActiveSection(activeSection==='textures' ? null : 'textures')}><span>Texture library</span><small>Browse</small><UiIcon name={activeSection==='textures' ? 'down' : 'chevron'} size={14}/></button><div className="gesso-preset-texture-content" id={textureContentId} hidden={activeSection!=='textures'}>
        {!!entries.length && <MaterialSwatches items={entries} onSelect={id=>{const entry=entries.find(item=>item.id===id);if(entry)useTexture(entry);}}/>}
        {entries.filter(entry=>!!entry.sourceUrl).map(entry=><p className="gesso-meta" key={entry.id}><a href={entry.sourceUrl} target="_blank" rel="noreferrer">{entry.name} · Poly Haven ↗</a> · CC0</p>)}
        <PolyHavenLibrary kind="textures" scopeKey={scene.sceneId + ':' + (draft?.id ?? 'library')} disabled={!draft} onImport={({entry})=>useTexture(entry)}/>
        <section className="gesso-section gesso-material-generator" aria-label="Generate material">
          <div className="gesso-section-heading"><span>Generate texture</span><span>fal · Patina</span></div>
          <label className="gesso-field"><span className="gesso-sr-only">Texture description</span><textarea aria-label="Texture description" value={prompt} maxLength={1200} rows={2} placeholder="Brushed aluminium, fine horizontal grain…" onChange={event=>setPrompt(event.target.value)}/></label>
          <div className="gesso-material-generate-row"><button type="button" disabled={!draft||!configured||!prompt.trim()||busy||pending(job)} onClick={generate}>{busy&&!job ? 'Submitting…' : 'Generate'}</button><span className="gesso-meta">1K · 5 maps · ≈ $0.08</span></div>
          {configured===false&&<p className="gesso-meta">Set FAL_KEY on the local server to enable generation. <button className="gesso-text-button" type="button" onClick={()=>setRetry(value=>value+1)}>Check connection</button></p>}
          {configured===null&&!error&&<p className="gesso-meta">Checking connection…</p>}
          {job&&<div className="gesso-material-job" aria-live="polite"><span className={job.state==='failed'?'gesso-error':'gesso-meta'}>{job.state==='succeeded'?'Ready. Select the texture to add its maps.':job.state==='failed'?job.error||'Generation failed.':job.state==='cancelled'?(job.notice||'Cancelled.'):job.state==='queued'?'Queued…':job.state==='cancelling'?'Cancelling…':'Generating texture maps…'}</span>{pending(job)&&<button type="button" className="gesso-text-button" disabled={busy} onClick={cancel}>Cancel generation</button>}</div>}
          {error&&<div role="alert"><p className="gesso-error">{error}</p><button type="button" className="gesso-text-button" onClick={()=>{setError('');setRetry(value=>value+1);}}>Retry connection</button></div>}
        </section>
      </div>
    </div>
    {draft && <p className="gesso-meta gesso-preset-save-scope">{draftParts.length ? 'Saving updates ' + draftParts.map(label).join(', ') + '. Duplicate first to keep the current preset.' : previewParts.length ? 'Preview on ' + previewParts.map(label).join(', ') + '. Save applies this preset.' : 'Save to the library. Select an editable part to preview.'}</p>}
    {feedback && <p className="gesso-meta" role="status">{feedback}</p>}
    </div>
    {draft && <div className="gesso-preset-footer" aria-label="Material actions">
      <button type="button" className="gesso-preset-save" disabled={!draft.name.trim()} onClick={()=>saveDraft(!draftParts.length && !disabled)}>{!draft.name.trim() && <UiIcon name="unavailable" size={12}/>}Save</button>
      <button type="button" onClick={closeEditor}>Cancel</button>
    </div>}
  </div>;
  return <div className="gesso-preset-library">
    <section className="gesso-section" aria-label="Material library">
      <div className="gesso-preset-library-actions"><span className="gesso-meta">Saved with this campaign</span><button type="button" className="gesso-text-button" onClick={()=>{setChoosingType(true);setDraft(null);setSelectedId(null);setFeedback('');}}>Add new</button></div>
      {presets.length ? <MaterialSwatches items={presets.map(preset=>({...preset,description:presetPartIds(scene,preset).map(label).join(' · ') || 'Unassigned'}))}
        selectedId={choosingType ? undefined : draft?.id ?? selected?.id} onSelect={id=>{const preset=presets.find(item=>item.id===id);if(preset)edit(preset);}}/> : <p className="gesso-meta">No presets in this campaign. Add a material type to start.</p>}
    </section>
    {editorHost ? createPortal(editor,editorHost) : editor}
  </div>;
}
