import {describe,expect,it} from 'vitest';
import {createImportRequestGuard} from './campaignTransition';

describe('product import campaign ownership',()=>{
  const source=()=>({projectId:'watch',revisionId:'saved-a',scene:{value:1}});
  it('accepts only the unchanged source and preserves an independently saved imported result',()=>{
    const guard=createImportRequestGuard(),owner=source(),request=guard.begin(owner);
    expect(guard.accepts(request,owner)).toBe(true);
    expect(guard.accepts(request,{...owner,scene:{value:1}})).toBe(false);
    expect(guard.accepts(request,{...owner,revisionId:'saved-b'})).toBe(false);
    expect(guard.accepts(request,{...owner,projectId:'another'})).toBe(false);
  });
  it('closing the form invalidates even a fetch implementation that ignores abort',async()=>{
    const guard=createImportRequestGuard(),owner=source(),request=guard.begin(owner);
    const late=Promise.resolve({id:'imported'});guard.cancel();await late;
    expect(request.controller.signal.aborted).toBe(true);expect(guard.accepts(request,owner)).toBe(false);
  });
  it('an old completion cannot finish or clear the replacement request',()=>{
    const guard=createImportRequestGuard(),owner=source(),old=guard.begin(owner),next=guard.begin(owner);
    expect(old.controller.signal.aborted).toBe(true);expect(guard.finish(old)).toBe(false);
    expect(guard.accepts(next,owner)).toBe(true);expect(guard.finish(next)).toBe(true);
    expect(guard.accepts(next,owner)).toBe(false);
  });
});
