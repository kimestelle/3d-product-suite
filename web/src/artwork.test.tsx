import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {artworkAssetUrl, artworkComponentId, canonicalizeDecalArtwork, partArtwork, restorePartArtwork, setPartArtwork, uploadArtwork, type ArtworkAsset} from './artwork';
import {DecalControls, UvDecalOverlay} from './DecalEditor';
import type {ProductDecal, UvLayout} from './decals';

const asset:ArtworkAsset={path:`assets/${'a'.repeat(64)}.png`,sha256:'a'.repeat(64),format:'png',width:8,height:4};
const decal:ProductDecal={id:'ink',partId:'product::node:2',componentId:'product',text:'Test',subtitle:'Rev 2',centerUv:[.5,.5],sizeUv:[.4,.4],heightM:0,bevelM:0,rotationDeg:0};
const fixture=()=>({product:{components:[{id:'product',shape:'mesh',sourceNodes:[{nodeIndex:1,hasMesh:false},{nodeIndex:2,hasMesh:true},{nodeIndex:3,hasMesh:true}]}],decals:[decal]}});
const layout:UvLayout={partId:decal.partId,triangles:[[0,0,1,0,1,1]],triangleCount:1,missingUv:false,overlap:false,truncated:false};
const noop=()=>{};
afterEach(()=>vi.unstubAllGlobals());

describe('artwork selection and immutable revisions',()=>{
  it('targets one mesh, not the assembly or a guessed child',()=>{
    const scene=fixture();
    expect(artworkComponentId(scene,'product::node:2')).toBe('product');
    for(const id of ['product','product::node:1','product::node:99','product::node:02'])expect(artworkComponentId(scene,id)).toBeNull();
    expect(()=>setPartArtwork(scene,{componentId:'product',partId:'product::node:1',finish:'paper',asset})).toThrow(/one product mesh/);
  });
  it('replaces the exact binding, preserves other parts and restores original by removing only the override',()=>{
    const scene=fixture(),original=structuredClone(scene.product.components);
    setPartArtwork(scene,{componentId:'product',partId:'product::node:2',finish:'paper',asset});
    setPartArtwork(scene,{componentId:'product',partId:'product::node:3',finish:'original',asset});
    const next={...asset,sha256:'b'.repeat(64),path:`assets/${'b'.repeat(64)}.png`};
    setPartArtwork(scene,{componentId:'product',partId:'product::node:2',finish:'paper',asset:next});
    expect(partArtwork(scene,'product::node:2')?.asset).toEqual(next);
    expect(partArtwork(scene,'product::node:3')?.asset).toEqual(asset);
    restorePartArtwork(scene,'product::node:2');
    expect(partArtwork(scene,'product::node:2')).toBeUndefined();
    expect(partArtwork(scene,'product::node:3')).toBeDefined();
    expect(scene.product.components).toEqual(original);
  });
  it('shows separate label replacement and placed decal controls with honest original-finish scope',()=>{
    const scene=fixture();setPartArtwork(scene,{componentId:'product',partId:decal.partId,finish:'original',asset});
    const html=renderToStaticMarkup(<DecalControls scene={scene} partId={decal.partId} decal={decal} layout={layout} onSelect={noop} onAdd={noop} onChange={noop}/>);
    expect(html).toContain('Replace label image');expect(html).toContain('Restore original artwork');
    expect(html).toContain('Plain label');expect(html).toContain('They may still contain the old printing.');
    expect(html).toContain('Apply text');expect(html).toContain('Decal image');
    expect(html).toContain('/api/assets/'+asset.sha256+'.png');
  });
  it('disables partial UV and assembly replacements while retaining the original assets',()=>{
    for(const [partId,uv] of [[decal.partId,{...layout,partialUv:true}],['product::node:1',layout]] as const){
      const html=renderToStaticMarkup(<DecalControls scene={fixture()} partId={partId} layout={uv} onSelect={noop} onAdd={noop} onChange={noop}/>);
      expect(html.match(/<input[^>]*aria-label="Replace label image"[^>]*>/)?.[0]).toContain('disabled=""');
    }
  });
  it('the UV overlay shows the applied image, not a substituted font',()=>{
    const html=renderToStaticMarkup(<UvDecalOverlay layout={layout} decal={{...decal,artwork:asset}} partName="Label" onPlace={noop} onAdd={noop}/>);
    expect(html).toContain('<image href="'+artworkAssetUrl(asset));
    expect(html).not.toContain('gesso-uv-artwork-text');
  });
});

describe('artwork uploads',()=>{
  it('uses bounded local upload and returns the immutable asset',async()=>{
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>asset});vi.stubGlobal('fetch',fetch);
    const signal=new AbortController().signal,blob=new Blob(['png']);
    expect(await uploadArtwork(blob,'new label.png',signal)).toEqual(asset);
    expect(fetch).toHaveBeenCalledWith('/api/artwork/import',expect.objectContaining({method:'POST',body:blob,signal,headers:expect.objectContaining({'X-Product-Suite':'1'})}));
    await expect(uploadArtwork(new Blob([]),'x.png')).rejects.toThrow(/32 MB/);
    await expect(uploadArtwork(blob,'x.svg')).rejects.toThrow(/PNG/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('surfaces failed decode and rejects malformed asset references',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce({ok:false,json:async()=>({error:'Image cannot decode'})})
      .mockResolvedValueOnce({ok:true,json:async()=>({...asset,path:'../../secret.png'})});vi.stubGlobal('fetch',fetch);
    await expect(uploadArtwork(new Blob(['x']),'x.png')).rejects.toThrow(/cannot decode/);
    await expect(uploadArtwork(new Blob(['x']),'x.png')).rejects.toThrow(/asset is invalid/);
  });
  it('rasterizes text only after the real font is ready and releases the canvas',async()=>{
    const context={fillStyle:'',textAlign:'',textBaseline:'',font:'',fillRect:vi.fn(),measureText:vi.fn(()=>({width:100})),fillText:vi.fn()};
    const canvas={width:0,height:0,getContext:()=>context,toBlob:(cb:(blob:Blob)=>void)=>cb(new Blob(['shared png']))};
    vi.stubGlobal('document',{fonts:{load:vi.fn().mockResolvedValue([{status:'loaded'}])},createElement:vi.fn(()=>canvas)});
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>asset});vi.stubGlobal('fetch',fetch);
    expect(await canonicalizeDecalArtwork(decal)).toEqual({...decal,artwork:asset});
    expect(context.fillText).toHaveBeenCalledWith('Test',512,1024*.37);
    expect(context.font).toContain('Studio Sans');
    expect(canvas.width).toBe(1);expect(canvas.height).toBe(1);
    expect(decal).not.toHaveProperty('artwork');
  });
  it('does not generate substitute text when the font is missing or the request is cancelled',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    vi.stubGlobal('document',{fonts:{load:vi.fn().mockResolvedValue([])}});
    await expect(canonicalizeDecalArtwork(decal)).rejects.toThrow(/font is still loading/);
    const controller=new AbortController();controller.abort();
    await expect(canonicalizeDecalArtwork(decal,controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
