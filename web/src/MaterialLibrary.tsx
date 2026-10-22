import {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {equalJson} from './state';
import MaterialSwatches from './MaterialSwatches';
import MaterialAssignments from './MaterialAssignments';
import type {HierarchyPart} from './hierarchy';
import MaterialProperties, {type MaterialPropertySection} from './MaterialProperties';
import {UiIcon} from './UiIcon';
import PolyHavenLibrary from './PolyHavenLibrary';
import {campaignMaterialPresets, deleteMaterialPreset, materialStarters, materialTypes, presetPartIds, saveMaterialPreset, type LibraryMaterialPreset, type MaterialType, type SavedMaterialPreset} from './materialPresets';
import type {MaterialHover, MaterialPreview, MaterialSpecification} from './materials';
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

export default function MaterialLibrary({scene, componentId, parts, onSelect, onChange, onPreview, onHover, editorHost}:{
  scene:any;componentId:string;editorHost?:HTMLElement|null;onChange:(edit:(scene:any)=>void)=>void;onPreview?:(preview:MaterialPreview|null)=>void;
  parts:HierarchyPart[];onSelect:(id:string)=>void;onHover?:(hover:MaterialHover|null)=>void;
}) {
  const [entries,setEntries] = useState<MaterialEntry[]>([]);
  const [configured,setConfigured] = useState<boolean|null>(null);
  const [prompt,setPrompt] = useState('');
  const [job,setJob] = useState<MaterialJob|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [retry,setRetry] = useState(0);
  const [choosingType,setChoosingType] = useState(true);
  const [draft,setDraft] = useState<Draft|null>(null);
  const [selectedId,setSelectedId] = useState<string|null>(null);
  const [feedback,setFeedbackState] = useState<{message:string;tone:'note'|'success'|'error'}|null>(null);
  const setFeedback = (message:string,tone:'note'|'success'|'error'='note') => setFeedbackState(message ? {message,tone} : null);
  const [sampleShape,setSampleShape] = useState<'sphere'|'cube'>('sphere');
  const sampleControl = useRef<HTMLButtonElement>(null);
  const [activeSection,setActiveSection] = useState<MaterialPropertySection|'textures'|null>('response');
  const textureContentId = useId();
  useEffect(()=>setActiveSection('response'),[draft?.id]);
  const mounted = useRef(true);
  const presetName = useRef<HTMLInputElement>(null);
  const editorBody = useRef<HTMLDivElement>(null);
  const draftSource = useRef<LibraryMaterialPreset|null>(null);
  const focusEditor = useRef(false);
  const selectName = useRef(false);
  const libraryRoot = useRef<HTMLDivElement>(null);
  const draftScope = useRef(scene.sceneId);
  useEffect(() => {if(editorBody.current)editorBody.current.scrollTop=0;},[editorHost,draft?.id,choosingType]);
  useEffect(() => {if(focusEditor.current && presetName.current){presetName.current.focus({preventScroll:true});if(selectName.current)presetName.current.select();focusEditor.current=false;selectName.current=false;}});
  useEffect(() => { mounted.current = true; return () => {mounted.current = false;}; }, []);
  useEffect(() => {
    const source=draftSource.current;
    if(!draft || !source || source.id!==draft.id)return;
    const currentPresets=campaignMaterialPresets(scene);
    const updated=currentPresets.find(preset=>preset.id===source.id);
    if(updated && samePreset(updated,source)) {
      if(source.sourceComponentId && !updated.sourceComponentId) {
        draftSource.current=updated;
        setDraft(current=>current?{...current,isNew:false,sourceComponentId:undefined}:current);
      }
      return;
    }
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
  const nameFor = (base:string) => {
    const names = new Set(presets.map(preset=>preset.name));
    if (!names.has(base)) return base;
    let n=2;while(names.has(base + ' ' + n)) n++;
    return base + ' ' + n;
  };
  const edit = (preset:LibraryMaterialPreset) => {
    if(draft?.id===preset.id){presetName.current?.focus({preventScroll:true});return;}
    focusEditor.current=true;draftSource.current=preset;
    setFeedback('');setChoosingType(false);setSelectedId(preset.id);
    setDraft(editablePreset(preset));
  };
  const newFromType = (id:string) => {
    const type=materialTypes.find(item=>item.id===id);if(!type)return;
    focusEditor.current=true;draftSource.current=null;
    setDraft({id:crypto.randomUUID(),name:nameFor(type.name),type:type.id,material:structuredClone(type.material),isNew:true});setChoosingType(false);
  };
  const newFromStarter = (id:string) => {
    const starter=materialStarters.find(item=>item.id===id);if(!starter)return;
    focusEditor.current=true;draftSource.current=null;
    setFeedback('');setSelectedId(null);setChoosingType(false);
    setDraft({...structuredClone(starter),id:crypto.randomUUID(),name:nameFor(starter.name),isNew:true});
  };
  const closeEditor = () => {draftSource.current=null;setDraft(null);setSelectedId(null);setChoosingType(false);setFeedback('');};
  const rename = (preset:LibraryMaterialPreset) => {
    if(editorBody.current)editorBody.current.scrollTop=0;
    if(draft?.id===preset.id){presetName.current?.focus({preventScroll:true});presetName.current?.select();return;}
    selectName.current=true;edit(preset);
  };
  const duplicate = (preset:LibraryMaterialPreset) => {
    const name=nameFor(preset.name.slice(0,128)+' copy');
    const copy:SavedMaterialPreset={id:crypto.randomUUID(),name,type:preset.type,material:{...structuredClone(preset.material),name}};
    try {
      saveMaterialPreset(structuredClone(scene),copy);
      onChange(next=>saveMaterialPreset(next,copy));
      edit(copy);setFeedback('Duplicated. Attach objects to use this copy.','success');
    } catch(reason){setFeedback((reason as Error).message,'error');}
  };
  const remove = (preset:LibraryMaterialPreset) => {
    try {
      deleteMaterialPreset(structuredClone(scene),preset.id);
      onChange(next=>deleteMaterialPreset(next,preset.id));
      if(draft?.id===preset.id)closeEditor();
      setFeedback(`Deleted ${preset.name}. Undo restores it.`,'success');
      libraryRoot.current?.querySelector<HTMLButtonElement>('.gesso-preset-library-actions>button')?.focus({preventScroll:true});
    } catch(reason){setFeedback((reason as Error).message,'error');}
  };
  const saveDraft = () => {
    if(!draft || !draft.name.trim())return;
    const preset:SavedMaterialPreset={id:draft.id,name:draft.name.trim(),type:draft.type,material:{...structuredClone(draft.material),name:draft.name.trim()}};
    try {
      saveMaterialPreset(structuredClone(scene),preset);
      draftSource.current=preset;
      onChange(next=>saveMaterialPreset(next,preset));setSelectedId(preset.id);setDraft({...preset,isNew:false});
      setFeedback('Saved','success');
    } catch(reason) {setFeedback((reason as Error).message,'error');}
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
  const previewParts=draftParts;
  const changedSurface=!!draft && (!draftSource.current || !sameSurface(draft.material,draftSource.current.material));
  const preview=draft && draftScope.current===scene.sceneId && changedSurface && previewParts.length
    ? {componentIds:previewParts,material:draft.material,presetId:draft.id} : null;
  const previewKey=JSON.stringify(preview);
  useEffect(()=>{onPreview?.(JSON.parse(previewKey));},[previewKey,onPreview]);
  useEffect(()=>()=>onPreview?.(null),[onPreview]);
  const editor = <div className="gesso-panel gesso-preset-editor-content">
    {choosingType && <header className="gesso-preset-heading gesso-preset-editor-heading"><h2>New preset</h2><button type="button" className="gesso-text-button" onClick={closeEditor}>Cancel</button></header>}
    {draft&&<div className="gesso-preset-fixed-preview">
      <div className="gesso-preset-heading"><h2>{draft.name.trim() || 'New preset'}</h2></div>
      <div className="gesso-material-sample" aria-label="Selected material sample">
        <div className="gesso-material-sample-shapes" role="group" aria-label="Sample shape">
          <button type="button" aria-label="Sphere sample" title="Sphere" aria-pressed={sampleShape==='sphere'} onClick={()=>setSampleShape('sphere')}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="10" cy="10" r="7"/></svg></button>
          <button type="button" aria-label="Cube sample" title="Cube" aria-pressed={sampleShape==='cube'} onClick={()=>setSampleShape('cube')}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="m10 2 7 4v8l-7 4-7-4V6Zm0 8 7-4M10 10 3 6m7 4v8"/></svg></button>
        </div>
        <button type="button" ref={sampleControl} className="gesso-material-sample-rotate" aria-label="Rotate material sample" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home" title="Drag to rotate · Arrow keys turn · Double-click or Home resets · Escape cancels"/>
        <div className="gesso-material-sample-render" aria-hidden="true"><MaterialSwatches items={[{id:'selected-sample',name:draft.name,material:draft.material}]} shape={sampleShape} rotationControl={sampleControl} disabled onSelect={()=>{}}/></div>
      </div>
      <div className="gesso-preset-scope"><span className="gesso-feedback" data-tone={previewParts.length ? undefined : 'note'}>{previewParts.length ? `${previewParts.length} attached ${previewParts.length===1?'object / section':'objects / sections'}` : 'Unassigned preset'}</span></div>
    </div>}
    <div className="gesso-preset-editor-body" ref={editorBody}>
    {!draft && !choosingType && <p className="gesso-meta gesso-note">Select a preset from the library to edit it.</p>}
    {choosingType && <section className="gesso-section" aria-label="Choose material type">
      <div className="gesso-material-starters gesso-selection-surface"><MaterialSwatches items={materialStarters} onSelect={newFromStarter}/></div>
      <p className="gesso-meta gesso-note">Choose a finish, then adjust its properties.</p>
      <button type="button" className="gesso-text-button" onClick={()=>newFromType('custom')}>Create custom</button>
    </section>}
    {draft && <>
      <section className="gesso-preset-fields" aria-label="Edit material preset">
        <label className="gesso-field gesso-material-field"><span>Name</span><input ref={presetName} aria-label="Preset name" value={draft.name} maxLength={140} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
        <label className="gesso-field gesso-material-field"><span>Type</span><select aria-label="Material type" value={draft.type} onChange={event=>{
          const type=materialTypes.find(item=>item.id===event.target.value)!;
          const maps=draft.material.textures ? Object.fromEntries(['textures','textureRepeat','normalScale','heightScaleM'].filter(key=>draft.material[key as keyof MaterialSpecification] !== undefined).map(key=>[key,draft.material[key as keyof MaterialSpecification]])) : {};
          setDraft({...draft,type:type.id as MaterialType,material:{...structuredClone(type.material),...maps,name:draft.name}});
        }}>{materialTypes.map(type=><option key={type.id} value={type.id}>{type.name}</option>)}</select></label>
      </section>
      <MaterialProperties material={draft.material} activeSection={activeSection==='textures' ? null : activeSection} onSectionChange={setActiveSection} onChange={material=>setDraft({...draft,material})}/>
    </>}
    <div className="gesso-preset-textures" hidden={!draft} inert={!draft} aria-hidden={!draft}>
      <button className="gesso-section-toggle" type="button" aria-expanded={activeSection==='textures'} aria-controls={textureContentId} onClick={()=>setActiveSection(activeSection==='textures' ? null : 'textures')}><span>Texture library</span><small>Browse</small><UiIcon name={activeSection==='textures' ? 'down' : 'chevron'} size={14}/></button><div className="gesso-preset-texture-content" id={textureContentId} hidden={activeSection!=='textures'} inert={activeSection!=='textures'} aria-hidden={activeSection!=='textures'}>
        {!!draft && activeSection==='textures' && !!entries.length && <MaterialSwatches items={entries} onSelect={id=>{const entry=entries.find(item=>item.id===id);if(entry)useTexture(entry);}}/>}
        {entries.filter(entry=>!!entry.sourceUrl).map(entry=><p className="gesso-meta" key={entry.id}><a href={entry.sourceUrl} target="_blank" rel="noreferrer">{entry.name} · Poly Haven ↗</a> · CC0</p>)}
        <PolyHavenLibrary kind="textures" scopeKey={scene.sceneId + ':' + (draft?.id ?? 'library')} disabled={!draft} onImport={({entry})=>useTexture(entry)}/>
        <section className="gesso-section gesso-material-generator" aria-label="Generate material">
          <div className="gesso-section-heading"><span className="gesso-section-label">Generate texture</span><span>fal · Patina</span></div>
          <label className="gesso-field"><span className="gesso-sr-only">Texture description</span><textarea aria-label="Texture description" value={prompt} maxLength={1200} rows={2} placeholder="Brushed aluminium, fine horizontal grain…" onChange={event=>setPrompt(event.target.value)}/></label>
          <div className="gesso-material-generate-row"><button type="button" disabled={!draft||!configured||!prompt.trim()||busy||pending(job)} onClick={generate}>{busy&&!job ? 'Submitting…' : 'Generate'}</button><span className="gesso-meta">1K · 5 maps · ≈ $0.08</span></div>
          {configured===false&&<p className="gesso-meta gesso-note">Set FAL_KEY on the local server to enable generation. <button className="gesso-text-button" type="button" onClick={()=>setRetry(value=>value+1)}>Check connection</button></p>}
          {configured===null&&!error&&<p className="gesso-meta gesso-note">Checking connection…</p>}
          {job&&<div className="gesso-material-job" aria-live="polite"><span className="gesso-meta gesso-feedback" data-tone={job.state==='failed'?'error':job.state==='succeeded'?'success':'note'}>{job.state==='succeeded'?'Ready. Select the texture to add its maps.':job.state==='failed'?job.error||'Generation failed.':job.state==='cancelled'?(job.notice||'Cancelled.'):job.state==='queued'?'Queued…':job.state==='cancelling'?'Cancelling…':'Generating texture maps…'}</span>{pending(job)&&<button type="button" className="gesso-text-button" disabled={busy} onClick={cancel}>Cancel generation</button>}</div>}
          {error&&<div role="alert"><p className="gesso-error">{error}</p><button type="button" className="gesso-text-button" onClick={()=>{setError('');setRetry(value=>value+1);}}>Retry connection</button></div>}
        </section>
      </div>
    </div>
    {draft && <p className="gesso-meta gesso-note gesso-preset-save-scope">{draftParts.length ? 'Saving updates every attached object and section.' : 'Save to the library, then attach objects or sections.'}</p>}
    {feedback && <p className="gesso-meta gesso-feedback" data-tone={feedback.tone} role="status">{feedback.message}</p>}
    </div>
    {draft && <div className="gesso-preset-footer" aria-label="Material actions">
      <button type="button" className="gesso-preset-save" disabled={!draft.name.trim()} onClick={()=>saveDraft()}>{!draft.name.trim() && <UiIcon name="unavailable" size={12}/>}Save</button>
      <button type="button" onClick={closeEditor}>Cancel</button>
    </div>}
  </div>;
  return <div className="gesso-preset-library gesso-selection-surface" ref={libraryRoot}>
    <section className="gesso-section gesso-material-starters" aria-label="Starting materials">
      <MaterialSwatches items={materialStarters} onSelect={newFromStarter}/>
    </section>
    <section className="gesso-section" aria-label="Material library">
      <div className="gesso-preset-library-actions"><span className="gesso-meta gesso-feedback" data-tone="success">Saved with this campaign</span><button type="button" className="gesso-text-button" onClick={()=>{setChoosingType(true);setDraft(null);setSelectedId(null);setFeedback('');}}>Add new</button></div>
      <MaterialAssignments scene={scene} parts={parts} presets={presets} selectedId={choosingType?undefined:draft?.id??selectedId??undefined}
        onEdit={edit} onRename={rename} onDuplicate={duplicate} onDelete={remove} onSelect={onSelect} onChange={onChange} onHover={onHover}/>
    </section>
    {editorHost ? createPortal(editor,editorHost) : editor}
  </div>;
}
