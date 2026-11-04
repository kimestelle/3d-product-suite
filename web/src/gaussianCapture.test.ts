import * as THREE from 'three';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {StudioViewport} from './viewport';
import {loadGaussianSourceBytes} from './gaussianSources';

const decoding=vi.hoisted(()=>({instances:[] as any[],next:undefined as Promise<void>|undefined,onCreate:undefined as (()=>void)|undefined}));
vi.mock('./gaussianSources',async original=>({...await original<typeof import('./gaussianSources')>(),loadGaussianSourceBytes:vi.fn(async()=>new ArrayBuffer(32))}));
vi.mock('@sparkjsdev/spark',async()=>{
  const {Group}=await import('three');
  return {SplatMesh:class extends Group {
    initialized:Promise<void>;dispose=vi.fn();
    constructor(readonly options:any){super();this.initialized=decoding.next??Promise.resolve();decoding.instances.push(this);decoding.onCreate?.();}
  }};
});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
function viewport(){
  const view=Object.create(StudioViewport.prototype) as any;
  const asset={path:`assets/${'a'.repeat(64)}.spz`,format:'spz',sha256:'a'.repeat(64),scaleToMeters:2,translationM:[1,2,3]};
  const previewAsset={path:`assets/${'b'.repeat(64)}.spz`,format:'spz',sha256:'b'.repeat(64)};
  const preview=Object.assign(new THREE.Group(),{dispose:vi.fn()}),root=new THREE.Group();root.add(preview);root.position.set(1,2,3);root.scale.setScalar(2);
  const lifetime=new AbortController(),world={environment:{kind:'splat',asset,previewAsset},signal:lifetime.signal,ready:true};
  Object.assign(view,{deferredWorld:world,splat:preview,spark:{},productPreview:false,restoreCaptureSplat:null,dirty:false});
  return {view,asset,preview,root,lifetime};
}
afterEach(()=>{vi.clearAllMocks();decoding.instances=[];decoding.next=undefined;decoding.onCreate=undefined;});

describe('canonical Gaussian snapshot lifetime',()=>{
  it('borrows only canonical bytes in the existing aligned root and restores preview idempotently',async()=>{
    const {view,asset,preview,root}=viewport(),spark=view.spark;
    const restore=await view.useFullResolutionSplat(undefined,()=>{}),canonical=decoding.instances[0];
    expect(loadGaussianSourceBytes).toHaveBeenCalledWith(asset,`/api/assets/${asset.sha256}.spz`,expect.any(AbortSignal));
    expect(canonical.options.fileBytes).toBeInstanceOf(ArrayBuffer);expect(canonical.options.url).toBeUndefined();
    expect(view.splat).toBe(canonical);expect(root.children).toEqual([canonical]);expect(view.spark).toBe(spark);
    expect(root.position.toArray()).toEqual([1,2,3]);expect(root.scale.toArray()).toEqual([2,2,2]);
    restore();restore();
    expect(view.splat).toBe(preview);expect(root.children).toEqual([preview]);expect(preview.dispose).not.toHaveBeenCalled();
    expect(canonical.dispose).toHaveBeenCalledOnce();expect(view.restoreCaptureSplat).toBeNull();expect(view.dirty).toBe(true);
  });
  it('never installs a cancelled decoder and releases its buffers once decoding settles',async()=>{
    const {view,preview,root}=viewport(),abort=new AbortController(),ready=deferred(),created=deferred();decoding.next=ready.promise;decoding.onCreate=created.resolve;
    const task=view.useFullResolutionSplat(abort.signal,()=>{}),cancelled=expect(task).rejects.toMatchObject({name:'AbortError'});
    await created.promise;expect(decoding.instances).toHaveLength(1);abort.abort();await cancelled;
    expect(view.splat).toBe(preview);expect(root.children).toEqual([preview]);
    ready.resolve();await flush();expect(decoding.instances[0].dispose).toHaveBeenCalledOnce();
  });
  it('restores before scene teardown so both source meshes have exactly one owner',async()=>{
    const {view,preview,root}=viewport();const restore=await view.useFullResolutionSplat(undefined,()=>{}),canonical=decoding.instances[0];
    // clearContent invokes this before disposing the ordinary scene resources.
    view.restoreCaptureSplat();view.splat.dispose();view.splat=null;view.deferredWorld=null;root.clear();restore();
    expect(canonical.dispose).toHaveBeenCalledOnce();expect(preview.dispose).toHaveBeenCalledOnce();
    expect(view.splat).toBeNull();expect(root.children).toEqual([]);
  });
  it('rejects a superseded view after source decode without touching preview or camera',async()=>{
    const {view,preview,root}=viewport();let stale=false;const ready=deferred(),created=deferred();decoding.next=ready.promise;decoding.onCreate=created.resolve;
    const task=view.useFullResolutionSplat(undefined,()=>{if(stale)throw new Error('The view changed.');});
    const failure=expect(task).rejects.toThrow('view changed');await created.promise;stale=true;ready.resolve();await failure;await flush();
    expect(view.splat).toBe(preview);expect(root.children).toEqual([preview]);expect(decoding.instances[0].dispose).toHaveBeenCalledOnce();
  });
  it('leaves product inspection and unpaired comparison sources unchanged',async()=>{
    const {view,preview}=viewport();view.productPreview=true;
    expect(await view.useFullResolutionSplat(undefined,()=>{})).toBeNull();
    view.productPreview=false;delete view.deferredWorld.environment.previewAsset;
    expect(await view.useFullResolutionSplat(undefined,()=>{})).toBeNull();
    expect(view.splat).toBe(preview);expect(loadGaussianSourceBytes).not.toHaveBeenCalled();
  });
});
