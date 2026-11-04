import {afterEach,describe,expect,it,vi} from 'vitest';
import {createDraftRecoveryWriter,DRAFT_DELAY_MS,DRAFT_PREFIX,MAX_DRAFT_BYTES,readRecoveryDrafts,removeRecoveryDraft,removeSavedRecoveryDrafts,writeRecoveryDraft,handoffRecoveryDraft,type RecoveryStorage} from './draftRecovery';

class MemoryStorage implements RecoveryStorage {
  values=new Map<string,string>();fail=false;
  get length(){return this.values.size;}
  key(index:number){return [...this.values.keys()][index]??null;}
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){if(this.fail)throw new Error('Storage quota unavailable');this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const project={id:'campaign',name:'Auden watch',revisionId:'saved-a',scene:{schemaVersion:1,value:0}};
afterEach(()=>vi.useRealTimers());

describe('local canonical draft recovery',()=>{
  it('keeps per-campaign and concurrent tab branches independently without changing saved source',()=>{
    const storage=new MemoryStorage(),before=structuredClone(project);
    const first=writeRecoveryDraft(storage,'tab-a',project,{schemaVersion:1,value:1})!;
    writeRecoveryDraft(storage,'tab-b',project,{schemaVersion:1,value:2});
    const second={...project,id:'another'};
    writeRecoveryDraft(storage,'tab-a',second,{schemaVersion:1,value:3});
    expect(readRecoveryDrafts(storage,project).map(item=>item.scene.value).sort()).toEqual([1,2]);
    expect(readRecoveryDrafts(storage,second).map(item=>item.scene.value)).toEqual([3]);
    expect(first.baseRevisionId).toBe('saved-a');expect(project).toEqual(before);
    writeRecoveryDraft(storage,'tab-a',project,project.scene);
    expect(readRecoveryDrafts(storage,project).map(item=>item.scene.value)).toEqual([2]);
    expect(readRecoveryDrafts(storage,second)).toHaveLength(1);
  });
  it('does not discard a newer update that arrived while a recovery dialog was open',()=>{
    const storage=new MemoryStorage();
    const displayed=writeRecoveryDraft(storage,'tab-a',project,{schemaVersion:1,value:1})!;
    const newer=writeRecoveryDraft(storage,'tab-a',project,{schemaVersion:1,value:2})!;
    expect(removeRecoveryDraft(storage,displayed)).toBe(false);
    expect(readRecoveryDrafts(storage,project)[0].token).toBe(newer.token);
    expect(removeRecoveryDraft(storage,newer)).toBe(true);expect(readRecoveryDrafts(storage,project)).toEqual([]);
  });
  it('writes the new owner durably before removing the recovery source',()=>{
    const storage=new MemoryStorage(),source=writeRecoveryDraft(storage,'old-tab',project,{schemaVersion:1,value:1})!;
    const operations:string[]=[],set=storage.setItem.bind(storage),remove=storage.removeItem.bind(storage);
    vi.spyOn(storage,'setItem').mockImplementation((key,value)=>{operations.push(`write:${key}`);set(key,value);});
    vi.spyOn(storage,'removeItem').mockImplementation(key=>{operations.push(`remove:${key}`);remove(key);});
    const copied=handoffRecoveryDraft(storage,'new-tab',project,source)!;
    expect(operations).toEqual([`write:${DRAFT_PREFIX}${copied.id}`,`remove:${DRAFT_PREFIX}${source.id}`]);
    expect(readRecoveryDrafts(storage,project).map(item=>item.id)).toEqual([copied.id]);
    // A crash before React installs the scene still has this complete record.
    expect(readRecoveryDrafts(storage,project)[0].scene).toEqual(source.scene);
  });
  it('retains the source when quota prevents a recovery handoff',()=>{
    const storage=new MemoryStorage(),source=writeRecoveryDraft(storage,'old-tab',project,{schemaVersion:1,value:1})!;
    storage.fail=true;
    expect(()=>handoffRecoveryDraft(storage,'new-tab',project,source)).toThrow('quota');
    expect(readRecoveryDrafts(storage,project).map(item=>item.token)).toEqual([source.token]);
  });
  it('rejects a source updated while native validation was awaiting without consuming either branch',async()=>{
    const storage=new MemoryStorage(),source=writeRecoveryDraft(storage,'old-tab',project,{schemaVersion:1,value:1})!;
    await Promise.resolve();
    const newer=writeRecoveryDraft(storage,'old-tab',project,{schemaVersion:1,value:2})!;
    expect(()=>handoffRecoveryDraft(storage,'new-tab',project,source)).toThrow('changed in another tab');
    expect(readRecoveryDrafts(storage,project).map(item=>item.token)).toEqual([newer.token]);
  });
  it('does not remove the record if the recovered writer is already its owner',()=>{
    const storage=new MemoryStorage(),source=writeRecoveryDraft(storage,'same-tab',project,{schemaVersion:1,value:1})!;
    const copied=handoffRecoveryDraft(storage,'same-tab',project,source)!;
    expect(copied.id).toBe(source.id);expect(readRecoveryDrafts(storage,project)[0].token).toBe(copied.token);
  });
  it('keeps stale-base drafts recoverable while clearing only data covered by an explicit save',()=>{
    const storage=new MemoryStorage();
    writeRecoveryDraft(storage,'tab-a',project,{schemaVersion:1,value:1});
    writeRecoveryDraft(storage,'tab-b',project,{schemaVersion:1,value:2});
    const latest={...project,revisionId:'saved-b',scene:{schemaVersion:1,value:1}};
    const drafts=readRecoveryDrafts(storage,latest);
    expect(drafts).toHaveLength(1);expect(drafts[0].baseRevisionId).toBe('saved-a');
    removeSavedRecoveryDrafts(storage,latest);
    expect(storage.length).toBe(1);expect(readRecoveryDrafts(storage,latest)[0].scene.value).toBe(2);
  });
  it('ignores malformed or oversized records without deleting other work',()=>{
    const storage=new MemoryStorage();storage.setItem('unrelated','keep');
    const draft=writeRecoveryDraft(storage,'tab-a',project,{schemaVersion:1,value:1})!;
    storage.setItem(DRAFT_PREFIX+'broken','{');
    storage.setItem(DRAFT_PREFIX+'large',' '.repeat(MAX_DRAFT_BYTES));
    expect(readRecoveryDrafts(storage,project).map(item=>item.id)).toEqual([draft.id]);
    expect(storage.getItem('unrelated')).toBe('keep');expect(storage.getItem(DRAFT_PREFIX+'broken')).toBe('{');
  });
  it('bounds storage and reports quota failures without evicting another unsaved branch',()=>{
    const storage=new MemoryStorage();writeRecoveryDraft(storage,'tab-a',project,{schemaVersion:1,value:1});
    const saved=[...storage.values];
    expect(()=>writeRecoveryDraft(storage,'tab-b',project,{schemaVersion:1,text:'x'.repeat(MAX_DRAFT_BYTES)})).toThrow('2 MiB');
    expect([...storage.values]).toEqual(saved);
    storage.fail=true;
    expect(()=>writeRecoveryDraft(storage,'tab-b',project,{schemaVersion:1,value:2})).toThrow('quota');
    expect([...storage.values]).toEqual(saved);
  });
  it('refuses excess branches rather than removing older recoverable edits',()=>{
    const storage=new MemoryStorage();
    for(let i=0;i<12;i++)writeRecoveryDraft(storage,`tab-${i}`,project,{schemaVersion:1,value:i+1});
    const saved=[...storage.values];
    expect(()=>writeRecoveryDraft(storage,'thirteenth',project,{schemaVersion:1,value:99})).toThrow('storage is full');
    expect([...storage.values]).toEqual(saved);expect(readRecoveryDrafts(storage,project)).toHaveLength(12);
  });
  it('debounces changes and synchronously flushes the latest pending edit for pagehide',async()=>{
    vi.useFakeTimers();const storage=new MemoryStorage(),onError=vi.fn();
    const writer=createDraftRecoveryWriter(()=>storage,'tab-a',onError);
    writer.queue(project,{schemaVersion:1,value:1});await vi.advanceTimersByTimeAsync(DRAFT_DELAY_MS-1);
    expect(storage.length).toBe(0);
    writer.queue(project,{schemaVersion:1,value:2});expect(writer.flush()).toBe(true);
    expect(readRecoveryDrafts(storage,project)[0].scene.value).toBe(2);expect(vi.getTimerCount()).toBe(0);
    writer.dispose();expect(storage.length).toBe(1);
  });
  it('preserves pending edits after a storage failure so retry can recover them',()=>{
    const storage=new MemoryStorage(),onError=vi.fn(),writer=createDraftRecoveryWriter(()=>storage,'tab-a',onError);
    storage.fail=true;writer.queue(project,{schemaVersion:1,value:4});
    expect(writer.flush()).toBe(false);expect(onError).toHaveBeenLastCalledWith('Local recovery could not be stored. Save a revision before closing.');
    storage.fail=false;expect(writer.flush()).toBe(true);
    expect(readRecoveryDrafts(storage,project)[0].scene.value).toBe(4);expect(onError).toHaveBeenLastCalledWith('');
  });
  it('flushes the previous campaign before switching queued ownership',()=>{
    const storage=new MemoryStorage(),writer=createDraftRecoveryWriter(()=>storage,'tab-a',vi.fn());
    writer.queue(project,{schemaVersion:1,value:1});
    const another={...project,id:'another'};writer.queue(another,{schemaVersion:1,value:2});writer.flush();
    expect(readRecoveryDrafts(storage,project)[0].scene.value).toBe(1);
    expect(readRecoveryDrafts(storage,another)[0].scene.value).toBe(2);
    writer.clear(another.id);expect(readRecoveryDrafts(storage,another)).toEqual([]);
    expect(readRecoveryDrafts(storage,project)).toHaveLength(1);
  });
});
