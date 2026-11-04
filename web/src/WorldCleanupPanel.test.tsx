import React,{type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import WorldCleanupPanel,{worldCleanupSources,type WorldCleanupAnalysis,type WorldCleanupPanelProps} from './WorldCleanupPanel';

const hooks=vi.hoisted(()=>({cursor:0,values:[] as any[],dependencies:[] as unknown[][],effects:[] as {index:number;run:()=>void|(()=>void)}[],cleanups:new Map<number,()=>void>(),dirty:false}));
vi.mock('react',async original=>{
  const actual=await original<typeof import('react')>();
  return {...actual,useState(initial:unknown){const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=typeof initial==='function'?initial():initial;
    return [hooks.values[i],(update:any)=>{const next=typeof update==='function'?update(hooks.values[i]):update;if(!Object.is(next,hooks.values[i])){hooks.values[i]=next;hooks.dirty=true;}}];},
    useRef(initial:unknown){const i=hooks.cursor++;return hooks.values[i]??={current:initial};},
    useMemo(factory:()=>unknown,dependencies:unknown[]){const i=hooks.cursor++,previous=hooks.dependencies[i];if(!previous||dependencies.some((value,n)=>!Object.is(value,previous[n]))){hooks.dependencies[i]=dependencies;hooks.values[i]=factory();}return hooks.values[i];},
    useEffect(run:()=>void|(()=>void),dependencies:unknown[]){const i=hooks.cursor++,previous=hooks.dependencies[i];if(!previous||dependencies.some((value,n)=>!Object.is(value,previous[n]))){hooks.dependencies[i]=dependencies;hooks.effects.push({index:i,run});}},
  };
});
const sourceHash='a'.repeat(64),copyHash='b'.repeat(64);
const environment={kind:'mesh',revisionId:'source',asset:{sha256:sourceHash,path:`assets/${sourceHash}.glb`,format:'glb',translationM:[0,0,0],rotationXyzw:[0,0,0,1],scaleToMeters:1,sourceUp:'Y'},plinth:{id:'contact'},props:[],floorY:0,studioSizeM:2};
const scene={sceneId:'campaign',environment,product:{id:'watch'}};
const candidate={id:'region-1',labelHint:'Horizontal surface',faceCount:12,areaSourceUnits2:1.4,maxDeviationSourceUnits:.008,rmsDeviationSourceUnits:.002};
const selection={sourceSha256:sourceHash,groups:[{nodeIndex:0,meshIndex:0,primitiveIndex:0,faceIndices:Array.from({length:12},(_,i)=>i)}]};
const analysis:WorldCleanupAnalysis={id:'analysis-1',sourceSha256:sourceHash,candidates:[candidate],triangleCount:20,units:'source units',method:'geometric-only'};
const prepared=(operation:'separate'|'flatten'='separate')=>({analysisId:analysis.id,regionId:candidate.id,environment:{...environment,asset:{...environment.asset,sha256:copyHash,path:`assets/${copyHash}.glb`}},
  report:{operation,role:'floor',selectedFaces:12,movedVertices:operation==='flatten'?3:0,maxDisplacementSourceUnits:operation==='flatten'?.004:0,boundaryVerticesPreserved:4,sourceTriangles:20,outputTriangles:20,geometryChanged:operation==='flatten',appearanceTransfer:'Original UVs retained.'}});
class FocusElement{focus=vi.fn();}
let focus:FocusElement;
function nodes(tree:ReactNode):ReactElement<any>[]{return React.Children.toArray(tree).flatMap(node=>React.isValidElement<any>(node)?[node,...nodes((node as ReactElement<any>).props.children)]:[]);}
function render(props:WorldCleanupPanelProps){let tree:ReactElement<any>;do{
  hooks.cursor=0;hooks.dirty=false;hooks.effects=[];tree=WorldCleanupPanel(props);
  for(const node of nodes(tree)){const ref=node.props.ref;if(ref&&typeof ref==='object'&&ref.current===null)ref.current=focus;}
  for(const effect of hooks.effects){hooks.cleanups.get(effect.index)?.();const cleanup=effect.run();if(cleanup)hooks.cleanups.set(effect.index,cleanup);else hooks.cleanups.delete(effect.index);}
}while(hooks.dirty);return tree;}
function find(tree:ReactNode,predicate:(node:ReactElement<any>)=>boolean){const found=nodes(tree).find(predicate);if(!found)throw new Error('Cleanup control missing');return found;}
const button=(tree:ReactNode,label:string)=>find(tree,node=>node.type==='button'&&renderToStaticMarkup(node).includes(label));
const input=(tree:ReactNode,label:string)=>find(tree,node=>node.type==='input'&&node.props['aria-label']===label);
const select=(tree:ReactNode,label:string)=>find(tree,node=>node.type==='select'&&node.props['aria-label']===label);
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};}
function props(){const result:WorldCleanupPanelProps={scene:structuredClone(scene),worlds:[],scopeKey:'revision-1',available:true,preview:null,onSelection:vi.fn(),onApply:vi.fn(()=>true)};
  result.onPreview=vi.fn(value=>{result.preview=value;return true;});return result;}
const response=(value:unknown,ok=true)=>({ok,json:async()=>value});
function server(){const mock=vi.fn<(url:string,options:any)=>Promise<any>>(async(url,options)=>response(url.endsWith('/analyze')?analysis:url.includes('/regions/')?selection:prepared(JSON.parse(options.body).operation)));vi.stubGlobal('fetch',mock);return mock;}
async function analyze(p:WorldCleanupPanelProps){let tree=render(p);button(tree,'Inspect mesh candidates').props.onClick();await flush();return render(p);}
async function choose(p:WorldCleanupPanelProps,tree:ReactElement<any>){input(tree,'Region 1: Horizontal surface').props.onChange();await flush();tree=render(p);select(tree,'Cleanup surface label').props.onChange({target:{value:'floor'}});return render(p);}
const unmount=()=>{for(const cleanup of hooks.cleanups.values())cleanup();hooks.cleanups.clear();};
beforeEach(()=>{hooks.cursor=0;hooks.values=[];hooks.dependencies=[];hooks.effects=[];hooks.cleanups=new Map();hooks.dirty=false;focus=new FocusElement();});
afterEach(()=>{unmount();vi.unstubAllGlobals();});

describe('explicit cleanup mesh source',()=>{
  it('offers a matching HQ sibling while retaining its alignment and current contact objects',()=>{
    const current={...scene,environment:{...environment,kind:'splat',asset:{...environment.asset,sha256:'c'.repeat(64),format:'spz',translationM:[9,8,7]},provenance:{providerWorldId:'water'}}};
    const sibling={id:'hq',name:'Water HQ',environment:{...environment,asset:{...environment.asset,translationM:[1,2,3]},plinth:{id:'library'},floorY:-9,provenance:{providerWorldId:'water',representation:'hq-visual-glb'}}};
    const sources=worldCleanupSources(current,[sibling,{...sibling,id:'foreign',environment:{...sibling.environment,provenance:{providerWorldId:'other',representation:'hq-visual-glb'}}}]);
    expect(sources).toHaveLength(1);expect(sources[0].environment.asset.translationM).toEqual([1,2,3]);
    expect(sources[0].environment.plinth).toEqual(current.environment.plinth);expect(sources[0].environment.floorY).toBe(0);
  });
  it('does not inspect on mount and explains the static backend requirement',()=>{
    const p={...props(),available:false},fetch=server();const html=renderToStaticMarkup(render(p));
    expect(html).toContain('Structure cleanup needs a connected backend');expect(button(render(p),'Inspect mesh candidates').props.disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();expect(p.onApply).not.toHaveBeenCalled();
  });
  it('starts another cleanup from the newly applied mesh while preserving an explicit source choice during previews',()=>{
    const p=props();p.scene={...scene,environment:{...environment,kind:'splat',asset:{...environment.asset,sha256:'c'.repeat(64),format:'spz'},provenance:{providerWorldId:'water'}}};
    p.worlds=[{id:'original-hq',name:'Water HQ',environment:{...environment,provenance:{providerWorldId:'water',representation:'hq-visual-glb'}}}];
    let tree=render(p);expect(select(tree,'Cleanup source mesh').props.value).toBe('original-hq');
    p.scene={...scene,environment:{...environment,asset:{...environment.asset,sha256:copyHash},provenance:{providerWorldId:'water'}}};p.scopeKey='applied-copy';
    tree=render(p);expect(select(tree,'Cleanup source mesh').props.value).toBe('current');
    select(tree,'Cleanup source mesh').props.onChange({target:{value:'original-hq'}});tree=render(p);
    p.preview={environment:p.worlds[0].environment,label:'Source mesh · cleanup review'};tree=render(p);
    expect(select(tree,'Cleanup source mesh').props.value).toBe('original-hq');
  });
});

describe('conservative cleanup review',()=>{
  it('analyzes explicitly, highlights existing source faces and requires a user label before separating',async()=>{
    const p=props(),fetch=server();let tree=await analyze(p);
    expect(fetch.mock.calls[0][0]).toBe('/api/world-cleanup/analyze');
    expect(JSON.parse(fetch.mock.calls[0][1].body).scene.environment.asset.sha256).toBe(sourceHash);
    expect(renderToStaticMarkup(tree)).toContain('Geometry suggests a shape, not an object identity');
    expect(fetch.mock.calls).toHaveLength(1);
    input(tree,'Region 1: Horizontal surface').props.onChange();await flush();tree=render(p);
    expect(fetch.mock.calls[1][0]).toBe('/api/world-cleanup/analysis-1/regions/region-1');expect(fetch.mock.calls[1][1].method).toBe('GET');
    expect(p.onSelection).toHaveBeenLastCalledWith(selection);
    expect(button(tree,'Preview separate mesh').props.disabled).toBe(true);
    expect(p.onApply).not.toHaveBeenCalled();
  });
  it('keeps separation provisional, compares source/copy and applies only the visible prepared result',async()=>{
    const p=props(),fetch=server();let tree=await choose(p,await analyze(p));button(tree,'Preview separate mesh').props.onClick();await flush();tree=render(p);
    const body=JSON.parse(fetch.mock.calls[2][1].body);expect(body).toMatchObject({analysisId:'analysis-1',regionId:'region-1',role:'floor',operation:'separate'});
    expect(p.onApply).not.toHaveBeenCalled();expect(renderToStaticMarkup(tree)).toContain('Moved vertices');
    button(tree,'Source mesh').props.onClick();tree=render(p);expect(button(tree,'Apply separated mesh').props.disabled).toBe(true);expect(fetch.mock.calls.filter(([url])=>url.includes('/regions/'))).toHaveLength(1);
    button(tree,'Separated mesh').props.onClick();tree=render(p);button(tree,'Apply separated mesh').props.onClick();await flush();
    expect(p.onApply).toHaveBeenCalledExactlyOnceWith(prepared().environment);expect(p.onPreview).toHaveBeenLastCalledWith(null);expect(focus.focus).toHaveBeenCalled();
  });
  it('requires prior separation and explicit planarity before a bounded interior flatten preview',async()=>{
    const p=props(),fetch=server();let tree=await choose(p,await analyze(p));expect(renderToStaticMarkup(tree)).not.toContain('Optional planar repair');
    button(tree,'Preview separate mesh').props.onClick();await flush();tree=render(p);expect(button(tree,'Preview flatten interior').props.disabled).toBe(true);
    const flat=nodes(tree).find(node=>node.type==='input'&&node.props.type==='checkbox')!;flat.props.onChange({target:{checked:true}});tree=render(p);
    input(tree,'Maximum cleanup displacement').props.onChange({target:{value:'0.006'}});tree=render(p);button(tree,'Preview flatten interior').props.onClick();await flush();tree=render(p);
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toMatchObject({operation:'flatten',maxDisplacementSourceUnits:.006});
    expect(renderToStaticMarkup(tree)).toContain('Original UVs retained.');expect(p.onApply).not.toHaveBeenCalled();
  });
  it('cancel and source changes abort ownership so a late analysis cannot install a stale mesh',async()=>{
    const p=props(),slow=deferred<any>(),fetch=vi.fn<(url:string,options:any)=>Promise<any>>(()=>slow.promise);vi.stubGlobal('fetch',fetch);let tree=render(p);
    button(tree,'Inspect mesh candidates').props.onClick();tree=render(p);const signal=fetch.mock.calls[0][1].signal;
    button(tree,'Cancel analysis').props.onClick();expect(signal.aborted).toBe(true);
    p.scopeKey='revision-2';render(p);slow.resolve(response(analysis));await flush();tree=render(p);
    expect(renderToStaticMarkup(tree)).not.toContain('geometric candidates ·');expect(p.preview).toBe(null);expect(p.onApply).not.toHaveBeenCalled();
  });
  it('returns to the canonical world and clears overlays when the disclosure closes',async()=>{
    const p=props();server();let tree=await analyze(p);input(tree,'Region 1: Horizontal surface').props.onChange();await flush();tree=render(p);
    tree.props.onToggle({currentTarget:{open:false}});tree=render(p);
    expect(p.onPreview).toHaveBeenLastCalledWith(null);expect(p.onSelection).toHaveBeenLastCalledWith(null);expect(p.onApply).not.toHaveBeenCalled();
  });
  it('does not publish a mismatched server preview',async()=>{
    const p=props();const fetch=server();fetch.mockReset().mockResolvedValueOnce(response(analysis)).mockResolvedValueOnce(response(selection)).mockResolvedValueOnce(response({...prepared(),regionId:'wrong'}));
    let tree=await choose(p,await analyze(p));button(tree,'Preview separate mesh').props.onClick();await flush();tree=render(p);
    expect(renderToStaticMarkup(tree)).toContain('Preview does not match this cleanup selection');expect(p.onApply).not.toHaveBeenCalled();
  });
  it('retains the prepared copy when the parent refuses application after a source change',async()=>{
    const p=props();server();let tree=await choose(p,await analyze(p));button(tree,'Preview separate mesh').props.onClick();await flush();tree=render(p);
    p.onApply=vi.fn(()=>false);tree=render(p);button(tree,'Apply separated mesh').props.onClick();tree=render(p);
    expect(renderToStaticMarkup(tree)).toContain('The scene changed. Review this cleanup again.');expect(p.preview?.environment.asset.sha256).toBe(copyHash);
  });
  it('cancels a lazy face request and ignores its late response after the scene changes',async()=>{
    const p=props(),fetch=server(),slow=deferred<any>();let tree=await analyze(p);fetch.mockImplementationOnce(()=>slow.promise);
    input(tree,'Region 1: Horizontal surface').props.onChange();tree=render(p);expect(renderToStaticMarkup(tree)).toContain('Loading region faces');
    const signal=fetch.mock.calls[1][1].signal;button(tree,'Cancel inspection').props.onClick();expect(signal.aborted).toBe(true);
    p.scopeKey='new-world';render(p);slow.resolve(response(selection));await flush();tree=render(p);
    expect(p.onSelection).toHaveBeenLastCalledWith(null);expect(p.preview).toBe(null);expect(renderToStaticMarkup(tree)).not.toContain('Candidate regions');
  });
  it('rejects face lists belonging to a different source and prevents separation',async()=>{
    const p=props(),fetch=server();let tree=await analyze(p);fetch.mockImplementationOnce(async()=>response({...selection,sourceSha256:copyHash}));
    input(tree,'Region 1: Horizontal surface').props.onChange();await flush();tree=render(p);
    expect(renderToStaticMarkup(tree)).toContain('Region faces do not match this source analysis');expect(p.onSelection).toHaveBeenLastCalledWith(null);
    expect(p.onApply).not.toHaveBeenCalled();expect(button(tree,'Preview separate mesh').props.disabled).toBe(true);
  });
});
