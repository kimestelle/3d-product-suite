import {useEffect,useId,useRef,useState} from 'react';
import './preset-library.css';

export type PresetScope='product'|'materials'|'stage'|'lighting'|'film'|'finish';
export type PresetSummary={id:string;name:string;createdAt:string;scopes:PresetScope[];productName:string;sameProduct:boolean};
export interface PresetLibraryDialogProps {
  mode:'save'|'library';onClose:()=>void;
  onList:(signal:AbortSignal)=>Promise<PresetSummary[]>;
  onSave:(name:string,scopes:PresetScope[],signal:AbortSignal)=>Promise<void>;
  onApply:(id:string,scopes:PresetScope[],signal:AbortSignal)=>Promise<void>;
}
export const presetScopeOptions:readonly {id:PresetScope;label:string}[]=[
  {id:'product',label:'Product + placement'},{id:'materials',label:'Materials + artwork'},
  {id:'stage',label:'Stage + objects'},{id:'lighting',label:'Lighting'},
  {id:'film',label:'Camera + film'},{id:'finish',label:'Post-processing'},
];
export const lookPresetScopes:PresetScope[]=['stage','lighting','finish'];
const ordered=(set:Set<PresetScope>)=>presetScopeOptions.filter(item=>set.has(item.id)).map(item=>item.id);
/** A product carries its own materials. A material-only choice remains useful
 * for the same product without replacing its geometry or placement. */
export function togglePresetScope(current:readonly PresetScope[],scope:PresetScope,enabled:boolean):PresetScope[]{
  const next=new Set(current);if(enabled)next.add(scope);else next.delete(scope);
  if(scope==='product'&&enabled)next.add('materials');
  if(scope==='materials'&&!enabled)next.delete('product');
  return ordered(next);
}
export function loadablePresetScopes(preset:PresetSummary,requested:readonly PresetScope[]):PresetScope[]{
  const saved=new Set(preset.scopes),next=new Set(requested.filter(scope=>saved.has(scope)));
  if(next.has('product')){if(saved.has('materials'))next.add('materials');else next.delete('product');}
  if(!preset.sameProduct&&!next.has('product'))next.delete('materials');
  return ordered(next);
}
const textError=(reason:unknown)=>reason instanceof Error?reason.message:'The preset request failed. Try again.';
type RequestOwner={controller:AbortController;kind:'list'|'save'|'apply'};

export default function PresetLibraryDialog(props:PresetLibraryDialogProps){
  const callbacks=useRef(props);callbacks.current=props;
  const dialog=useRef<HTMLDialogElement>(null),nameField=useRef<HTMLInputElement>(null),heading=useRef<HTMLHeadingElement>(null);
  const request=useRef<RequestOwner|null>(null),mounted=useRef(false),closing=useRef(false);
  const [name,setName]=useState(''),[scopes,setScopes]=useState<PresetScope[]>(lookPresetScopes.slice());
  const [presets,setPresets]=useState<PresetSummary[]>([]),[selectedId,setSelectedId]=useState(''),[query,setQuery]=useState('');
  const [error,setError]=useState(''),[loading,setLoading]=useState(props.mode==='library'),[pending,setPending]=useState(false),[reload,setReload]=useState(0);
  const selectedRef=useRef(selectedId);selectedRef.current=selectedId;
  const titleId=useId(),helpId=useId(),errorId=useId();
  const preset=presets.find(item=>item.id===selectedId);
  const mode=props.mode,busy=loading||pending;
  const materialBlocked=mode==='library'&&!!preset&&!preset.sameProduct&&!scopes.includes('product');
  const filmNeedsReview=mode==='library'&&!!preset&&!preset.sameProduct&&scopes.includes('film')&&!scopes.includes('product');
  const listed=presets.filter(item=>`${item.name}\n${item.productName}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close=()=>{
    if(closing.current)return;closing.current=true;request.current?.controller.abort();request.current=null;
    callbacks.current.onClose();
  };
  const perform=async<T,>(kind:RequestOwner['kind'],task:(signal:AbortSignal)=>Promise<T>,accept:(value:T)=>void)=>{
    if(closing.current||!mounted.current)return;
    request.current?.controller.abort();const owner={kind,controller:new AbortController()};request.current=owner;
    setError('');if(kind==='list')setLoading(true);else setPending(true);
    const current=()=>mounted.current&&!closing.current&&request.current===owner&&!owner.controller.signal.aborted;
    try{const value=await task(owner.controller.signal);if(current())accept(value);}
    catch(reason){if(current())setError(textError(reason));}
    finally{if(current()){request.current=null;setLoading(false);setPending(false);}}
  };
  useEffect(()=>{
    mounted.current=true;closing.current=false;
    const returnTo=typeof document!=='undefined'&&typeof HTMLElement!=='undefined'&&document.activeElement instanceof HTMLElement?document.activeElement:null;
    const element=dialog.current;
    if(element&&!element.open)element.showModal();
    if(mode==='save')nameField.current?.focus();else heading.current?.focus();
    return()=>{mounted.current=false;closing.current=true;request.current?.controller.abort();request.current=null;element?.close();if(returnTo?.isConnected)returnTo.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{
    request.current?.controller.abort();request.current=null;setPending(false);setError('');
    if(mode==='save'){setLoading(false);setScopes(lookPresetScopes.slice());return;}
    void perform('list',signal=>callbacks.current.onList(signal),rows=>{
      setPresets(rows);const next=rows.find(item=>item.id===selectedRef.current)??rows[0];
      setSelectedId(next?.id??'');setScopes(next?loadablePresetScopes(next,next.scopes):[]);
    });
  },[mode,reload]);
  const choose=(next:PresetSummary)=>{setSelectedId(next.id);setScopes(loadablePresetScopes(next,next.scopes));setError('');};
  const toggle=(scope:PresetScope,enabled:boolean)=>{
    const next=togglePresetScope(scopes,scope,enabled);setScopes(mode==='library'&&preset?loadablePresetScopes(preset,next):next);setError('');
  };
  const submit=()=>{
    if(busy||closing.current)return;
    if(!scopes.length){setError('Choose at least one section.');return;}
    if(mode==='save'){
      const value=name.trim();if(!value||value.length>120){setError('Name the preset using 1–120 characters.');nameField.current?.focus();return;}
      void perform('save',signal=>callbacks.current.onSave(value,scopes.slice(),signal),()=>{});
    }else{
      if(!preset){setError('Choose a preset first.');return;}
      const selected=loadablePresetScopes(preset,scopes);
      if(!selected.length){setError('Choose a compatible section to load.');return;}
      void perform('apply',signal=>callbacks.current.onApply(preset.id,selected,signal),()=>{});
    }
  };
  const date=(value:string)=>{const parsed=new Date(value);return Number.isNaN(parsed.getTime())?'':parsed.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});};
  return <dialog ref={dialog} className="gesso-preset-dialog" aria-labelledby={titleId} aria-describedby={helpId}
    onCancel={event=>{event.preventDefault();close();}} onKeyDown={event=>event.stopPropagation()}>
    <form onSubmit={event=>{event.preventDefault();submit();}}>
      <header><h2 id={titleId} ref={heading} tabIndex={-1}>{mode==='save'?'Save preset':'Preset library'}</h2><button type="button" aria-label="Close presets" onClick={close}>×</button></header>
      <p id={helpId} className="gesso-preset-help">{mode==='save'?'Choose the parts of this setup to reuse. Presets and campaign revisions are saved separately.':'Load selected sections as one undoable edit. Save the campaign to keep the changes.'}</p>
      {mode==='save'?<>
        <label className="gesso-preset-name">Preset name<input ref={nameField} aria-label="Preset name" value={name} required maxLength={120} disabled={busy} onChange={event=>{setName(event.target.value);setError('');}} aria-invalid={!!error&&!name.trim()||undefined} aria-describedby={error?errorId:undefined}/></label>
        <div className="gesso-preset-shortcuts" role="group" aria-label="Preset scope shortcuts">
          <button type="button" disabled={busy} onClick={()=>{setScopes(presetScopeOptions.map(item=>item.id));setError('');}}>Entire setup</button>
          <button type="button" disabled={busy} onClick={()=>{setScopes(lookPresetScopes.slice());setError('');}}>Look</button>
          <button type="button" disabled={busy} onClick={()=>{setScopes(['film']);setError('');}}>Camera + film</button>
        </div>
      </>:<>
        <label className="gesso-preset-search">Search presets<input type="search" aria-label="Search presets" value={query} disabled={loading||pending} onChange={event=>setQuery(event.target.value)}/></label>
        {loading?<p role="status">Loading presets…</p>:presets.length===0?<p className="gesso-preset-empty">No saved presets yet. Save part of a setup from the top bar.</p>:<div className="gesso-preset-list" role="group" aria-label="Saved presets">
          {listed.map(item=><button key={item.id} type="button" disabled={pending} aria-pressed={item.id===selectedId} onClick={()=>choose(item)}>
            <strong>{item.name}</strong><span>{item.productName} · {date(item.createdAt)}</span><small>{presetScopeOptions.filter(scope=>item.scopes.includes(scope.id)).map(scope=>scope.label).join(' · ')}</small>
          </button>)}
          {listed.length===0&&<p>No presets match this search.</p>}
        </div>}
      </>}
      {(mode==='save'||!!preset)&&<fieldset disabled={busy} className="gesso-preset-scopes"><legend>{mode==='save'?'Sections to save':`Sections to load · ${preset?.name}`}</legend>
        <div>{presetScopeOptions.filter(scope=>mode==='save'||preset?.scopes.includes(scope.id)).map(scope=><label key={scope.id}>
          <input type="checkbox" aria-label={scope.label} checked={scopes.includes(scope.id)} disabled={scope.id==='materials'&&materialBlocked} onChange={event=>toggle(scope.id,event.target.checked)}/><span>{scope.label}</span>
        </label>)}</div>
        {(mode==='save'||preset?.scopes.includes('product'))&&<p>Product includes its materials and artwork.</p>}
        {materialBlocked&&preset?.scopes.includes('materials')&&<p className="gesso-preset-note">{preset.scopes.includes('product')?'Load the saved product to use its materials and artwork.':'Materials and artwork belong to a different product and cannot be loaded here.'}</p>}
        {filmNeedsReview&&<p className="gesso-preset-note">Review camera framing for the current product after loading.</p>}
      </fieldset>}
      {error&&<p className="gesso-preset-error" role="alert" id={errorId}>{error}</p>}
      {mode==='library'&&error&&!pending&&<button type="button" className="gesso-preset-retry" onClick={()=>setReload(value=>value+1)}>Refresh library</button>}
      <footer><button type="button" onClick={close}>Cancel</button><button type="submit" disabled={busy||!scopes.length||(mode==='library'&&!preset)}>{pending?mode==='save'?'Saving…':'Loading…':mode==='save'?'Save preset':'Load selected sections'}</button></footer>
    </form>
  </dialog>;
}
