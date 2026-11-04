import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {RecoveryDraft} from './draftRecovery';
import './recovery-dialogs.css';

function RecoveryDialog({label,onCancel,children}:{label:string;onCancel:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null),returnTo=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    returnTo.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    dialog.current?.showModal();
    return()=>{dialog.current?.close();if(returnTo.current?.isConnected)returnTo.current.focus({preventScroll:true});};
  },[]);
  return <dialog ref={dialog} className="gesso-recovery-dialog" aria-label={label}
    onCancel={event=>{event.preventDefault();onCancel();}} onKeyDown={event=>event.stopPropagation()}>{children}</dialog>;
}
export function RecoverDraftDialog({drafts,revisionId,separate=false,busy,error,onRestore,onDiscard,onKeepSaved}:{drafts:RecoveryDraft[];revisionId:string;separate?:boolean;busy:boolean;error:string;onRestore:(draft:RecoveryDraft)=>void;onDiscard:(draft:RecoveryDraft)=>void;onKeepSaved:()=>void}) {
  const [selected,setSelected]=useState(drafts[0]?.id??'');
  useEffect(()=>{if(!drafts.some(draft=>draft.id===selected))setSelected(drafts[0]?.id??'');},[drafts,selected]);
  const draft=drafts.find(item=>item.id===selected)??drafts[0];
  if(!draft)return null;
  const stale=separate||draft.baseRevisionId!==revisionId;
  const download=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(draft,null,2)+'\n'],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download=`${draft.projectName.replace(/[^a-z0-9-]+/gi,'-').slice(0,80)||'campaign'}-recovery.json`;link.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <RecoveryDialog label="Recover unsaved work" onCancel={()=>{if(!busy)onKeepSaved();}}>
    <h2>Recover unsaved work</h2>
    <p>{draft.projectName} has a local draft. The saved revision stays unchanged until you save.</p>
    {drafts.length>1?<label>Recovery draft<select aria-label="Recovery draft" disabled={busy} value={draft.id} onChange={event=>setSelected(event.target.value)}>
      {drafts.map((item,index)=><option value={item.id} key={item.id}>Draft {index+1} · {new Date(item.updatedAt).toLocaleString()}</option>)}
    </select></label>:<p className="gesso-recovery-date">{new Date(draft.updatedAt).toLocaleString()}</p>}
    {stale&&<p>{separate?'The current scene has unsaved changes.':'The saved campaign has a newer revision.'} Restoring opens a separate recovered campaign, preserving both versions.</p>}
    {error&&<p role="alert">{error}</p>}
    <div className="gesso-recovery-actions"><button type="button" disabled={busy} onClick={()=>onRestore(draft)}>{busy?'Restoring…':stale?'Restore as new campaign':'Restore draft'}</button>
      <button type="button" disabled={busy} onClick={()=>onDiscard(draft)}>Discard draft</button>
      <button type="button" disabled={busy} onClick={download}>Download draft</button>
      <button type="button" disabled={busy} onClick={onKeepSaved}>Use saved revision</button></div>
  </RecoveryDialog>;
}
export function ImportDecisionDialog({projectName,busy,error,onSave,onDiscard,onCancel}:{projectName:string;busy:boolean;error:string;onSave:()=>void;onDiscard:()=>void;onCancel:()=>void}) {
  return <RecoveryDialog label="Save changes before importing?" onCancel={()=>{if(!busy)onCancel();}}>
    <h2>Save changes before importing?</h2><p>{projectName} has unsaved changes. Importing opens a new campaign. Your current scene stays open if the import fails.</p>
    {error&&<p role="alert">{error}</p>}
    <div className="gesso-recovery-actions"><button type="button" disabled={busy} onClick={onSave}>{busy?'Working…':'Save + import'}</button>
      <button type="button" disabled={busy} onClick={onDiscard}>Discard + import</button>
      <button type="button" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </RecoveryDialog>;
}
