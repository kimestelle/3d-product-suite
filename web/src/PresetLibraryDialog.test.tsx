import React,{type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import PresetLibraryDialog,{loadablePresetScopes,togglePresetScope,type PresetLibraryDialogProps,type PresetSummary} from './PresetLibraryDialog';

const hooks=vi.hoisted(()=>({cursor:0,values:[] as any[],dependencies:[] as unknown[][],effects:[] as {index:number;run:()=>void|(()=>void)}[],cleanups:new Map<number,()=>void>(),dirty:false}));
vi.mock('react',async original=>{
  const actual=await original<typeof import('react')>();
  return {...actual,useState(initial:unknown){const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=typeof initial==='function'?initial():initial;
    return [hooks.values[i],(update:any)=>{const next=typeof update==='function'?update(hooks.values[i]):update;if(!Object.is(next,hooks.values[i])){hooks.values[i]=next;hooks.dirty=true;}}];},
    useRef(initial:unknown){const i=hooks.cursor++;return hooks.values[i]??={current:initial};},useId(){return `preset-test-${hooks.cursor++}`;},
    useEffect(run:()=>void|(()=>void),dependencies:unknown[]){const i=hooks.cursor++,previous=hooks.dependencies[i];if(!previous||dependencies.some((value,n)=>!Object.is(value,previous[n]))){hooks.dependencies[i]=dependencies;hooks.effects.push({index:i,run});}},
  };
});
class FocusElement {isConnected=true;focus=vi.fn();}
let returnTo:FocusElement,modal:any;
function nodes(tree:ReactNode):ReactElement<any>[]{return React.Children.toArray(tree).flatMap(node=>React.isValidElement<any>(node)?[node,...nodes((node as ReactElement<any>).props.children)]:[]);}
function render(props:PresetLibraryDialogProps){let tree:ReactElement<any>;do{
  hooks.cursor=0;hooks.dirty=false;hooks.effects=[];tree=PresetLibraryDialog(props);
  for(const node of nodes(tree)){const ref=node.props.ref;if(ref&&typeof ref==='object'&&ref.current===null)ref.current=node.type==='dialog'?modal:new FocusElement();}
  for(const effect of hooks.effects){hooks.cleanups.get(effect.index)?.();const cleanup=effect.run();if(cleanup)hooks.cleanups.set(effect.index,cleanup);else hooks.cleanups.delete(effect.index);}
}while(hooks.dirty);return tree;}
function find(tree:ReactNode,predicate:(node:ReactElement<any>)=>boolean){const result=nodes(tree).find(predicate);if(!result)throw new Error('Expected preset control missing');return result;}
const button=(tree:ReactNode,label:string)=>find(tree,node=>node.type==='button'&&renderToStaticMarkup(node).includes(label));
const field=(tree:ReactNode,label:string)=>find(tree,node=>node.type==='input'&&node.props['aria-label']===label);
const checked=(tree:ReactNode)=>nodes(tree).filter(node=>node.type==='input'&&node.props.type==='checkbox'&&node.props.checked).map(node=>node.props['aria-label']);
const submit=(tree:ReactNode)=>find(tree,node=>node.type==='form').props.onSubmit({preventDefault:vi.fn()});
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const summary:PresetSummary={id:'preset-1',name:'Warm studio',createdAt:'2026-11-04T08:00:00Z',scopes:['stage','lighting','film','finish'],productName:'Watch',sameProduct:true};
const base=():PresetLibraryDialogProps=>({mode:'save',onClose:vi.fn(),onList:vi.fn(async()=>[summary]),onSave:vi.fn(async()=>{}),onApply:vi.fn(async()=>{})});
const unmount=()=>{for(const cleanup of hooks.cleanups.values())cleanup();hooks.cleanups.clear();};
beforeEach(()=>{
  hooks.cursor=0;hooks.values=[];hooks.dependencies=[];hooks.effects=[];hooks.cleanups=new Map();hooks.dirty=false;
  returnTo=new FocusElement();modal={open:false,showModal:vi.fn(()=>{modal.open=true;}),close:vi.fn(()=>{modal.open=false;})};
  vi.stubGlobal('HTMLElement',FocusElement);vi.stubGlobal('document',{activeElement:returnTo});
});
afterEach(()=>{unmount();vi.unstubAllGlobals();});

describe('preset section dependencies',()=>{
  it('includes materials with a product and removes product when materials are unchecked',()=>{
    expect(togglePresetScope(['stage'],'product',true)).toEqual(['product','materials','stage']);
    expect(togglePresetScope(['product','materials','stage'],'materials',false)).toEqual(['stage']);
    expect(togglePresetScope(['product','materials'],'product',false)).toEqual(['materials']);
  });
  it('allows only stored compatible material scope and never invents missing sections',()=>{
    const foreign={...summary,sameProduct:false,scopes:['materials','film'] as PresetSummary['scopes']};
    expect(loadablePresetScopes(foreign,['product','materials','lighting','film'])).toEqual(['film']);
    expect(loadablePresetScopes({...foreign,scopes:['product','materials','film']},['product','film'])).toEqual(['product','materials','film']);
  });
});

describe('save preset controls',()=>{
  it('defaults to Look and submits exactly the named selected sections',async()=>{
    const props=base();let tree=render(props);expect(checked(tree)).toEqual(['Stage + objects','Lighting','Post-processing']);
    button(tree,'Entire setup').props.onClick();tree=render(props);expect(checked(tree)).toHaveLength(6);
    field(tree,'Materials + artwork').props.onChange({target:{checked:false}});tree=render(props);
    expect(checked(tree)).not.toContain('Product + placement');
    button(tree,'Camera + film').props.onClick();tree=render(props);field(tree,'Preset name').props.onChange({target:{value:'  Camera pass  '}});tree=render(props);submit(tree);
    expect(props.onSave).toHaveBeenCalledWith('Camera pass',['film'],expect.any(AbortSignal));await flush();
    expect(props.onList).not.toHaveBeenCalled();expect(props.onApply).not.toHaveBeenCalled();
  });
  it('keeps invalid names and empty selections out of persistence',()=>{
    const props=base();let tree=render(props);submit(tree);tree=render(props);expect(renderToStaticMarkup(tree)).toContain('Name the preset');
    field(tree,'Preset name').props.onChange({target:{value:'Valid name'}});tree=render(props);
    for(const label of ['Stage + objects','Lighting','Post-processing'])field(tree,label).props.onChange({target:{checked:false}}),tree=render(props);
    submit(tree);expect(props.onSave).not.toHaveBeenCalled();expect(renderToStaticMarkup(render(props))).toContain('Choose at least one section');
  });
  it('uses a native modal, cancels pending save and restores the trigger focus without late errors',async()=>{
    const pending=deferred<void>(),props={...base(),onSave:vi.fn<PresetLibraryDialogProps['onSave']>(()=>pending.promise)};let tree=render(props);
    field(tree,'Preset name').props.onChange({target:{value:'In progress'}});tree=render(props);submit(tree);tree=render(props);
    expect(modal.showModal).toHaveBeenCalledOnce();expect(renderToStaticMarkup(tree)).toContain('Saving…');
    const signal=props.onSave.mock.calls[0][2];const preventDefault=vi.fn();tree.props.onCancel({preventDefault});
    expect(preventDefault).toHaveBeenCalledOnce();expect(signal.aborted).toBe(true);expect(props.onClose).toHaveBeenCalledOnce();unmount();
    expect(modal.close).toHaveBeenCalledOnce();expect(returnTo.focus).toHaveBeenCalledWith({preventScroll:true});
    pending.reject(new Error('Late save failure'));await flush();expect(renderToStaticMarkup(render(props))).not.toContain('Late save failure');
  });
});

describe('preset library controls',()=>{
  it('loads a selected subset and explains incompatible materials and camera review',async()=>{
    const foreign={...summary,id:'foreign',name:'Other product',sameProduct:false,scopes:['materials','film'] as PresetSummary['scopes']};
    const props={...base(),mode:'library' as const,onList:vi.fn(async()=>[foreign])};render(props);await flush();let tree=render(props);
    expect(field(tree,'Materials + artwork').props.disabled).toBe(true);expect(field(tree,'Materials + artwork').props.checked).toBe(false);
    expect(renderToStaticMarkup(tree)).toContain('Review camera framing');submit(tree);
    expect(props.onApply).toHaveBeenCalledWith('foreign',['film'],expect.any(AbortSignal));await flush();
  });
  it('makes saved product selection enable its materials and unchecking product removes unsafe materials',async()=>{
    const foreign={...summary,sameProduct:false,scopes:['product','materials','film'] as PresetSummary['scopes']};
    const props={...base(),mode:'library' as const,onList:vi.fn(async()=>[foreign])};render(props);await flush();let tree=render(props);
    expect(field(tree,'Materials + artwork').props.disabled).toBe(false);
    field(tree,'Product + placement').props.onChange({target:{checked:false}});tree=render(props);
    expect(field(tree,'Materials + artwork').props.checked).toBe(false);expect(field(tree,'Materials + artwork').props.disabled).toBe(true);
    field(tree,'Product + placement').props.onChange({target:{checked:true}});tree=render(props);submit(tree);
    expect(props.onApply).toHaveBeenCalledWith('preset-1',['product','materials','film'],expect.any(AbortSignal));await flush();
  });
  it('ignores a library response after cancellation and can retry a failed list',async()=>{
    const slow=deferred<PresetSummary[]>(),props={...base(),mode:'library' as const,onList:vi.fn<PresetLibraryDialogProps['onList']>(()=>slow.promise)};
    let tree=render(props);const signal=props.onList.mock.calls[0][0];button(tree,'Cancel').props.onClick();expect(signal.aborted).toBe(true);
    slow.resolve([summary]);await flush();expect(renderToStaticMarkup(render(props))).not.toContain('Warm studio');unmount();
  });
  it('recovers library and apply errors without clearing the selected scope choices',async()=>{
    const props={...base(),mode:'library' as const,onList:vi.fn<PresetLibraryDialogProps['onList']>().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([summary]),onApply:vi.fn<PresetLibraryDialogProps['onApply']>().mockRejectedValueOnce(new Error('Review stage alignment')).mockResolvedValue(undefined)};
    render(props);await flush();let tree=render(props);expect(renderToStaticMarkup(tree)).toContain('Offline');
    button(tree,'Refresh library').props.onClick();render(props);await flush();tree=render(props);submit(tree);await flush();tree=render(props);
    expect(renderToStaticMarkup(tree)).toContain('Review stage alignment');expect(checked(tree)).toContain('Camera + film');
    field(tree,'Camera + film').props.onChange({target:{checked:false}});tree=render(props);submit(tree);await flush();
    expect(props.onApply).toHaveBeenLastCalledWith('preset-1',['stage','lighting','finish'],expect.any(AbortSignal));
  });
});
