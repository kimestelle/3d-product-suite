import {describe,expect,it,vi} from 'vitest';
import {ensureFrameHistory,frameHistoryIndex,pushFrameHistory,restoreFrameHistory} from './frameHistory';

type Entry={url:string;state:Record<string,unknown>|null};
/** Native push truncates the forward branch; replace and go never add entries. */
class NativeHistory {
  entries:Entry[];position=0;
  constructor(state:Entry['state']=null,url='/landing'){this.entries=[{url,state:structuredClone(state)}];}
  get state(){return this.entries[this.position].state;}
  get url(){return this.entries[this.position].url;}
  get length(){return this.entries.length;}
  replaceState=vi.fn((state:Entry['state'],_unused:string,url?:string|URL|null)=>{
    this.entries[this.position]={state:structuredClone(state),url:url==null?this.url:String(url)};
  });
  pushState=vi.fn((state:Entry['state'],_unused:string,url?:string|URL|null)=>{
    const next={state:structuredClone(state),url:url==null?this.url:String(url)};
    this.entries.splice(this.position+1);this.entries.push(next);this.position++;
  });
  go=vi.fn((delta=0)=>{const next=this.position+delta;if(next>=0&&next<this.entries.length)this.position=next;});
  asHistory(){return this as unknown as History;}
}

describe('Shared frame native history',()=>{
  it('initializes the current entry once while preserving unrelated native state and its URL',()=>{
    const original={scroll:{x:0,y:480},editor:{part:'shade'},routerKey:'existing-entry'};
    const history=new NativeHistory(original,'/?step=material&layer=materials');
    expect(ensureFrameHistory(history.asHistory())).toBe(0);
    expect(ensureFrameHistory(history.asHistory())).toBe(0);
    expect(history.state).toMatchObject(original);expect(original).not.toHaveProperty('__gessoFrameIndex');
    expect(history.url).toBe('/?step=material&layer=materials');expect(history.length).toBe(1);
    expect(history.replaceState).toHaveBeenCalledTimes(1);expect(history.pushState).not.toHaveBeenCalled();
  });
  it('preserves each entry’s unrelated state while giving editorial and editor routes one sequence',()=>{
    const history=new NativeHistory({session:'gesso',restore:{part:'hinge'}});
    const urls=['/about','/?step=product&layer=model','/?step=film&layer=framing&mode=still','/aperture#shape-light-principles'];
    urls.forEach((url,i)=>{pushFrameHistory(url,history.asHistory());expect(history.url).toBe(url);expect(frameHistoryIndex(history.asHistory())).toBe(i+1);});
    expect(history.length).toBe(5);expect(history.pushState).toHaveBeenCalledTimes(4);
    for(const entry of history.entries)expect(entry.state).toMatchObject({session:'gesso',restore:{part:'hinge'}});
  });
  it.each([null,{}, {__gessoFrameIndex:'4'},{__gessoFrameIndex:1.5},{__gessoFrameIndex:Infinity},{__gessoFrameIndex:NaN},{__gessoFrameIndex:Number.MAX_SAFE_INTEGER+1}])('rejects an unowned or invalid history index: %j',state=>{
    const history=new NativeHistory(state);expect(frameHistoryIndex(history.asHistory())).toBeNull();
  });
  it('accepts an existing safe integer index without resetting it',()=>{
    const history=new NativeHistory({__gessoFrameIndex:8,editor:'retained'});
    expect(ensureFrameHistory(history.asHistory())).toBe(8);expect(history.replaceState).not.toHaveBeenCalled();
    pushFrameHistory('/about',history.asHistory());expect(frameHistoryIndex(history.asHistory())).toBe(9);
  });
  it('cancels a new forward navigation by traversing backward instead of pushing a duplicate return entry',()=>{
    const history=new NativeHistory({scroll:300});ensureFrameHistory(history.asHistory());
    const previous={url:history.url,index:frameHistoryIndex(history.asHistory())};
    pushFrameHistory('/about',history.asHistory());pushFrameHistory('/aperture',history.asHistory());
    const count=history.length,pushes=history.pushState.mock.calls.length,replaces=history.replaceState.mock.calls.length;
    expect(restoreFrameHistory(previous,history.asHistory())).toBe(true);
    expect(history.go).toHaveBeenLastCalledWith(-2);expect(history.url).toBe('/landing');
    expect(history.length).toBe(count);expect(history.pushState).toHaveBeenCalledTimes(pushes);expect(history.replaceState).toHaveBeenCalledTimes(replaces);
    history.go(1);expect(history.url).toBe('/about');history.go(1);expect(history.url).toBe('/aperture');
  });
  it('cancels a Back traversal with the matching positive delta, preserving Forward',()=>{
    const history=new NativeHistory();ensureFrameHistory(history.asHistory());
    pushFrameHistory('/about',history.asHistory());pushFrameHistory('/?step=film&layer=framing',history.asHistory());
    const previous={url:history.url,index:frameHistoryIndex(history.asHistory())};
    history.go(-2);const count=history.length,pushes=history.pushState.mock.calls.length;
    expect(restoreFrameHistory(previous,history.asHistory())).toBe(true);
    expect(history.go).toHaveBeenLastCalledWith(2);expect(history.url).toBe(previous.url);
    expect(history.length).toBe(count);expect(history.pushState).toHaveBeenCalledTimes(pushes);
  });
  it('branches from the actual current index after Back and discards the old Forward branch',()=>{
    const history=new NativeHistory();ensureFrameHistory(history.asHistory());
    pushFrameHistory('/about',history.asHistory());pushFrameHistory('/aperture',history.asHistory());
    history.go(-1);pushFrameHistory('/?step=material&layer=materials',history.asHistory());
    expect(history.entries.map(entry=>entry.url)).toEqual(['/landing','/about','/?step=material&layer=materials']);
    expect(frameHistoryIndex(history.asHistory())).toBe(2);history.go(1);expect(history.url).toBe('/?step=material&layer=materials');
    history.go(-1);expect(frameHistoryIndex(history.asHistory())).toBe(1);expect(history.url).toBe('/about');
  });
  it.each([
    {state:{other:'kept'},position:{url:'/landing',index:null},expected:0},
    {state:{other:'kept',__gessoFrameIndex:4},position:{url:'/landing',index:null},expected:4},
    {state:{other:'kept'},position:{url:'/about',index:3},expected:3},
    {state:{other:'kept',__gessoFrameIndex:2},position:{url:'/landing',index:2},expected:2},
  ])('falls back to replace without adding a cancellation entry: %j',({state,position,expected})=>{
    const history=new NativeHistory(state,'/aperture');
    expect(restoreFrameHistory(position,history.asHistory())).toBe(false);
    expect(history.url).toBe(position.url);expect(frameHistoryIndex(history.asHistory())).toBe(expected);expect(history.state).toMatchObject({other:'kept'});
    expect(history.length).toBe(1);expect(history.go).not.toHaveBeenCalled();expect(history.pushState).not.toHaveBeenCalled();expect(history.replaceState).toHaveBeenCalledTimes(1);
  });
});
