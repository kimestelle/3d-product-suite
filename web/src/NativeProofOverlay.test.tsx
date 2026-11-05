import React,{type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import NativeProof,{type NativeProofProps} from './NativeProofOverlay';
import type {NativeProofInput} from './nativeProof';

// Run the production component and request controller. Only React's hook host
// is replaced, so lifecycle effects stay directly inspectable.
const hooks=vi.hoisted(()=>({cursor:0,values:[] as any[],dependencies:[] as unknown[][],effects:[] as {index:number;run:()=>void|(()=>void)}[],cleanups:new Map<number,()=>void>(),dirty:false}));
vi.mock('react',async original=>{
  const actual=await original<typeof import('react')>();
  return {...actual,
    useState(initial:unknown){const index=hooks.cursor++;if(!(index in hooks.values))hooks.values[index]=typeof initial==='function'?initial():initial;
      return [hooks.values[index],(update:any)=>{const value=typeof update==='function'?update(hooks.values[index]):update;if(!Object.is(value,hooks.values[index])){hooks.values[index]=value;hooks.dirty=true;}}];},
    useRef(initial:unknown){const index=hooks.cursor++;return hooks.values[index]??={current:initial};},
    useEffect(run:()=>void|(()=>void),dependencies:unknown[]){const index=hooks.cursor++,previous=hooks.dependencies[index];if(!previous||dependencies.some((value,i)=>!Object.is(value,previous[i]))){hooks.dependencies[index]=dependencies;hooks.effects.push({index,run});}},
  };
});

class FocusElement {focus=vi.fn();}
let focus:FocusElement,visibility:EventTarget&{visibilityState:string};
function nodes(tree:ReactNode):ReactElement<any>[]{return React.Children.toArray(tree).flatMap(node=>React.isValidElement<any>(node)?[node,...nodes((node as ReactElement<any>).props.children)]:[]);}
function render(props:NativeProofProps){let tree:ReactElement<any>;do{
  hooks.cursor=0;hooks.dirty=false;hooks.effects=[];tree=NativeProof(props);
  for(const node of nodes(tree)){const ref=node.props.ref;if(ref&&typeof ref==='object'&&ref.current===null)ref.current=focus;}
  for(const effect of hooks.effects){hooks.cleanups.get(effect.index)?.();const cleanup=effect.run();if(cleanup)hooks.cleanups.set(effect.index,cleanup);else hooks.cleanups.delete(effect.index);}
}while(hooks.dirty);return tree;}
function find(tree:ReactNode,predicate:(node:ReactElement<any>)=>boolean){const node=nodes(tree).find(predicate);if(!node)throw new Error('Proof control missing');return node;}
const button=(tree:ReactNode,label:string)=>find(tree,node=>node.type==='button'&&React.Children.toArray(node.props.children).join('')===label);
const html=(tree:ReactElement<any>)=>renderToStaticMarkup(tree);
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
function props(){
  const result:NativeProofProps={scopeKey:'scene-1',viewKey:'inspection-1',ownerKey:'campaign-1',active:true,ready:true,disabledReason:'',onPresent:vi.fn(),prepare:vi.fn()};
  result.prepare=vi.fn(()=>input(result));return result;
}
function input(p:NativeProofProps):NativeProofInput{return {scene:{product:{id:'watch'},digest:`digest:${p.scopeKey}`},frame:18,sourceDigest:`digest:${p.scopeKey}`,sourceKey:p.scopeKey,width:640,height:360,samples:32,
  cameraOverride:{positionM:[.2,.1,.4],targetM:[0,.1,0],focalLengthMm:70},viewLabel:'Inspection view'};}
const response=(value:unknown)=>({ok:true,json:async()=>value});
function server(state='succeeded'){
  const fetch=vi.fn(async(path:string,options:any)=>{
    if(path==='/api/proofs/session/cancel')return response({state:'cancelled'});
    if(path.endsWith('/image.png'))return {ok:true,blob:async()=>new Blob(['pixels'],{type:'image/png'})};
    const body=JSON.parse(options.body),id=`proof-${body.sequence}`;
    return response({id,state,sessionId:body.sessionId,sequence:body.sequence,sourceDigest:body.scene.digest,frame:body.frame,width:body.width,height:body.height,samples:body.samples,imageUrl:`/api/proofs/${id}/image.png`});
  });vi.stubGlobal('fetch',fetch);return fetch;
}
const submissions=(fetch:ReturnType<typeof server>)=>fetch.mock.calls.filter(([path])=>path==='/api/proofs');
async function complete(p:NativeProofProps,decode:Promise<void>=Promise.resolve()){
  let tree=render(p);const image=find(tree,node=>node.type==='img'&&node.props.className==='gesso-proof-decode');
  const loaded=image.props.onLoad({currentTarget:{decode:()=>decode,naturalWidth:640,naturalHeight:360}});await flush();tree=render(p);
  await loaded;await flush();return render(p);
}
const unmount=()=>{for(const cleanup of hooks.cleanups.values())cleanup();hooks.cleanups.clear();};
beforeEach(()=>{
  vi.useFakeTimers();hooks.cursor=0;hooks.values=[];hooks.dependencies=[];hooks.effects=[];hooks.cleanups=new Map();hooks.dirty=false;focus=new FocusElement();
  visibility=Object.assign(new EventTarget(),{visibilityState:'visible'});vi.stubGlobal('document',visibility);
  let number=0;vi.spyOn(URL,'createObjectURL').mockImplementation(()=>`blob:proof-${++number}`);vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
});
afterEach(()=>{unmount();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});

describe('native proof toolbar and image handoff',()=>{
  it('requests explicitly, leaves the scene untouched and presents only after the actual image decodes',async()=>{
    const p=props(),canonical=input(p),before=structuredClone(canonical);p.prepare=vi.fn(()=>canonical);const fetch=server();let tree=render(p);
    expect(fetch).not.toHaveBeenCalled();expect(button(tree,'Auto proof').props['aria-pressed']).toBe(false);
    button(tree,'Render proof').props.onClick();await flush();tree=render(p);expect(submissions(fetch)).toHaveLength(1);expect(html(tree)).toContain('Loading proof');expect(html(tree)).not.toContain('Native render proof');
    const requested=JSON.parse(submissions(fetch)[0][1].body);expect(requested.scene).toEqual(canonical.scene);expect(requested.cameraOverride).toEqual(canonical.cameraOverride);expect(canonical).toEqual(before);
    const decoded=deferred<void>(),image=find(tree,node=>node.type==='img'&&node.props.className==='gesso-proof-decode');
    const loaded=image.props.onLoad({currentTarget:{decode:()=>decoded.promise,naturalWidth:640,naturalHeight:360}});await flush();tree=render(p);expect(html(tree)).not.toContain('Native render proof');
    decoded.resolve();await loaded;await flush();tree=render(p);expect(html(tree)).toContain('Cycles proof · Inspection view · frame 18 · 640 × 360');
    expect(html(tree)).toContain('Inspection view rendered with Cycles, frame 18');expect(p.onPresent).toHaveBeenLastCalledWith(true);expect(canonical).toEqual(before);
    const preventDefault=vi.fn(),stopPropagation=vi.fn();find(tree,node=>node.props.className==='gesso-native-proof-image').props.onKeyDown({key:'Escape',preventDefault,stopPropagation});tree=render(p);
    expect(preventDefault).toHaveBeenCalledOnce();expect(stopPropagation).toHaveBeenCalledOnce();expect(focus.focus).toHaveBeenCalledWith({preventScroll:true});expect(p.onPresent).toHaveBeenLastCalledWith(false);
    expect(button(tree,'View proof')).toBeDefined();
  });
  it('keeps mounted controls and the opt-in setting through edits, coalescing only the latest settled scene',async()=>{
    const p=props(),fetch=server();let tree=render(p),trigger=button(tree,'Render proof').props.ref;
    button(tree,'Auto proof').props.onClick();tree=render(p);expect(button(tree,'Auto proof on').props['aria-pressed']).toBe(true);
    await vi.advanceTimersByTimeAsync(300);p.scopeKey='scene-2';p.viewKey='inspection-2';tree=render(p);
    expect(button(tree,'Render proof').props.ref).toBe(trigger);expect(button(tree,'Auto proof on').props['aria-pressed']).toBe(true);
    await vi.advanceTimersByTimeAsync(500);expect(fetch).not.toHaveBeenCalled();p.scopeKey='scene-3';render(p);
    await vi.advanceTimersByTimeAsync(649);expect(fetch).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);await flush();tree=render(p);
    expect(p.prepare).toHaveBeenCalledOnce();expect(JSON.parse(submissions(fetch)[0][1].body).scene.digest).toBe('digest:scene-3');
    tree=await complete(p);expect(html(tree)).toContain('Cycles proof · Inspection view');expect(button(tree,'Auto proof on').props['aria-pressed']).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);expect(submissions(fetch)).toHaveLength(1);
  });
  it.each(['inactive','hidden','scope','owner'] as const)('cancels remote work on %s and cannot install its old image',async(change)=>{
    const p=props(),fetch=server('queued');let tree=render(p);button(tree,'Render proof').props.onClick();await flush();tree=render(p);
    const request=submissions(fetch)[0][1];expect(request.signal.aborted).toBe(false);
    if(change==='inactive')p.active=false;
    if(change==='scope')p.scopeKey='scene-2';
    if(change==='owner')p.ownerKey='campaign-2';
    if(change==='hidden'){visibility.visibilityState='hidden';visibility.dispatchEvent(new Event('visibilitychange'));}
    tree=render(p);expect(request.signal.aborted).toBe(true);expect(fetch.mock.calls.some(([path])=>path==='/api/proofs/session/cancel')).toBe(true);
    expect(html(tree)).not.toContain('Native render proof');expect(p.onPresent).toHaveBeenLastCalledWith(false);
  });
  it('invalidates a slow preparation when the tab hides before any submission',async()=>{
    const p=props(),prepared=deferred<NativeProofInput>(),fetch=server();p.prepare=vi.fn(()=>prepared.promise);let tree=render(p);button(tree,'Render proof').props.onClick();
    visibility.visibilityState='hidden';visibility.dispatchEvent(new Event('visibilitychange'));render(p);prepared.resolve(input(p));await flush();render(p);
    expect(fetch).not.toHaveBeenCalled();expect(p.onPresent).toHaveBeenLastCalledWith(false);
  });
  it('retains and labels the earlier decoded proof while a replacement fails to decode',async()=>{
    const p=props();server();let tree=render(p);button(tree,'Render proof').props.onClick();await flush();tree=await complete(p);
    p.scopeKey='scene-2';p.viewKey='inspection-2';tree=render(p);expect(button(tree,'Earlier proof')).toBeDefined();expect(p.onPresent).toHaveBeenLastCalledWith(false);
    button(tree,'Earlier proof').props.onClick();tree=render(p);expect(html(tree)).toContain('Earlier Cycles proof · Inspection view');
    button(tree,'Render proof').props.onClick();await flush();tree=render(p);const staged=find(tree,node=>node.type==='img'&&node.props.className==='gesso-proof-decode');staged.props.onError();tree=render(p);
    expect(html(tree)).toContain('could not be decoded');expect(html(tree)).toContain('Earlier Cycles proof');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:proof-2');expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:proof-1');
    p.ownerKey='campaign-2';tree=render(p);expect(html(tree)).not.toContain('Native render proof');expect(nodes(tree).some(node=>node.type==='button'&&node.props.children==='Earlier proof')).toBe(false);expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:proof-1');
  });
  it('turning automatic proof off cancels its pending timer without a render',async()=>{
    const p=props(),fetch=server();let tree=render(p);button(tree,'Auto proof').props.onClick();tree=render(p);
    await vi.advanceTimersByTimeAsync(400);button(tree,'Auto proof on').props.onClick();tree=render(p);await vi.advanceTimersByTimeAsync(1000);
    expect(button(tree,'Auto proof').props['aria-pressed']).toBe(false);expect(fetch).not.toHaveBeenCalled();
  });
});
