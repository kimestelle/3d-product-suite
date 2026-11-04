import {equalJson} from './state';

export const DRAFT_PREFIX='gesso.recovery.v1.';
export const DRAFT_DELAY_MS=500;
export const MAX_DRAFT_BYTES=2*1024*1024;
export const MAX_RECOVERY_BYTES=4*1024*1024;
export const MAX_RECOVERY_RECORDS=12;
export interface DraftProject {id:string;name:string;revisionId:string;scene:any}
export interface RecoveryDraft {
  schemaVersion:1;id:string;projectId:string;projectName:string;baseRevisionId:string;
  updatedAt:string;token:string;scene:any;
}
export type RecoveryStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
class RecoveryLimitError extends Error {}
export class RecoveryDraftChangedError extends Error {constructor(){super('This draft changed in another tab. Review the latest draft before restoring.');}}
const storageMessage=(error:unknown)=>error instanceof RecoveryLimitError?error.message:'Local recovery could not be stored. Save a revision before closing.';
export const newRecoveryId=()=>globalThis.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const keyFor=(id:string)=>DRAFT_PREFIX+id;
const size=(value:string)=>value.length*2;
function parsed(value:string|null):RecoveryDraft|null {
  if(!value||size(value)>MAX_DRAFT_BYTES)return null;
  try {
    const draft=JSON.parse(value);
    return draft?.schemaVersion===1&&typeof draft.id==='string'&&draft.id.length<=200
      &&typeof draft.projectId==='string'&&draft.projectId.length<=100
      &&typeof draft.projectName==='string'&&draft.projectName.length<=160
      &&typeof draft.baseRevisionId==='string'&&draft.baseRevisionId.length<=128
      &&typeof draft.token==='string'&&draft.token.length<=100
      &&typeof draft.updatedAt==='string'&&Number.isFinite(Date.parse(draft.updatedAt))
      &&draft.scene&&typeof draft.scene==='object'&&!Array.isArray(draft.scene)
      ?draft:null;
  } catch{return null;}
}
function keys(storage:RecoveryStorage):string[] {
  const values:string[]=[];
  for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key?.startsWith(DRAFT_PREFIX))values.push(key);}
  return values;
}
export function readRecoveryDrafts(storage:RecoveryStorage,project:DraftProject):RecoveryDraft[] {
  return keys(storage).map(key=>{const draft=parsed(storage.getItem(key));return draft&&key===keyFor(draft.id)?draft:null;})
    .filter((draft):draft is RecoveryDraft=>!!draft&&draft.projectId===project.id&&!equalJson(draft.scene,project.scene))
    .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
/** Each mounted editor owns its own record, so another tab's draft is not replaced. */
export function writeRecoveryDraft(storage:RecoveryStorage,id:string,project:DraftProject,scene:any):RecoveryDraft|null {
  const recordId=`${project.id}.${id}`;
  if(equalJson(scene,project.scene)){storage.removeItem(keyFor(recordId));return null;}
  const record:RecoveryDraft={schemaVersion:1,id:recordId,projectId:project.id,projectName:project.name,
    baseRevisionId:project.revisionId,updatedAt:new Date().toISOString(),token:newRecoveryId(),scene};
  const value=JSON.stringify(record),bytes=size(value);
  if(bytes>MAX_DRAFT_BYTES)throw new RecoveryLimitError('This scene exceeds the 2 MiB local recovery limit. Save a revision before closing.');
  const entries=keys(storage),others=entries.filter(key=>key!==keyFor(recordId));
  const total=others.reduce((sum,key)=>sum+size(storage.getItem(key)??''),0)+bytes;
  if(others.length>=MAX_RECOVERY_RECORDS||total>MAX_RECOVERY_BYTES)
    throw new RecoveryLimitError('Local recovery storage is full. Save your work and review other recovered drafts before closing.');
  // Do not evict another unsaved draft to make room. A quota failure is surfaced.
  storage.setItem(keyFor(recordId),value);return record;
}
/** A dialog may be open while another tab updates its draft. Never discard that newer version. */
export function removeRecoveryDraft(storage:RecoveryStorage,draft:RecoveryDraft):boolean {
  const current=parsed(storage.getItem(keyFor(draft.id)));
  if(current&&current.token!==draft.token)return false;
  storage.removeItem(keyFor(draft.id));return true;
}
export function recoveryDraftIsCurrent(storage:RecoveryStorage,draft:RecoveryDraft):boolean {
  const current=parsed(storage.getItem(keyFor(draft.id)));
  return !!current&&current.projectId===draft.projectId&&current.token===draft.token;
}
/** Persist the new owner before consuming the recovered record. A quota/storage
 * failure leaves the source intact, including the crash window before UI commit. */
export function handoffRecoveryDraft(storage:RecoveryStorage,writerId:string,project:DraftProject,draft:RecoveryDraft):RecoveryDraft|null {
  if(!recoveryDraftIsCurrent(storage,draft))throw new RecoveryDraftChangedError();
  const owned=writeRecoveryDraft(storage,writerId,project,draft.scene);
  if(owned?.id!==draft.id)removeRecoveryDraft(storage,draft);
  return owned;
}
export function removeOwnedRecovery(storage:RecoveryStorage,id:string,projectId:string):void {storage.removeItem(keyFor(`${projectId}.${id}`));}
export function removeSavedRecoveryDrafts(storage:RecoveryStorage,project:DraftProject):void {
  for(const key of keys(storage)){
    const draft=parsed(storage.getItem(key));
    if(draft?.projectId===project.id&&equalJson(draft.scene,project.scene))removeRecoveryDraft(storage,draft);
  }
}

export function createDraftRecoveryWriter(storage:()=>RecoveryStorage,id:string,onError:(message:string)=>void) {
  let pending:{project:DraftProject;scene:any}|null=null,timer:ReturnType<typeof setTimeout>|null=null,failed=false;
  const flush=()=>{
    if(timer!==null){clearTimeout(timer);timer=null;}
    if(!pending)return !failed;
    const value=pending;
    try {writeRecoveryDraft(storage(),id,value.project,value.scene);pending=null;failed=false;onError('');return true;}
    catch(error){failed=true;onError(storageMessage(error));return false;}
  };
  return {
    queue(project:DraftProject,scene:any){if(pending&&pending.project.id!==project.id)flush();pending={project,scene};if(timer!==null)clearTimeout(timer);timer=setTimeout(flush,DRAFT_DELAY_MS);},
    flush,
    clear(projectId:string){if(timer!==null)clearTimeout(timer);timer=null;pending=null;try{removeOwnedRecovery(storage(),id,projectId);failed=false;onError('');}catch{onError('The recovery draft could not be cleared. Your saved revision is unchanged.');}},
    dispose(){flush();if(timer!==null)clearTimeout(timer);timer=null;},
  };
}
