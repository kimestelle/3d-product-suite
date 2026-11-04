import {createHash,webcrypto} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {gaussianRenderAsset,loadGaussianSourceBytes} from './gaussianSources';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

function source(){
  const bytes=new TextEncoder().encode('immutable Gaussian source');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  return {bytes,asset:{path:`assets/${sha256}.spz`,sha256,format:'spz'}};
}

describe('Gaussian source selection',()=>{
  it('keeps canonical bytes for export while the editor uses the paired preview',()=>{
    const asset={path:'canonical',scaleToMeters:2,translationM:[1,2,3]},previewAsset={path:'preview'};
    expect(gaussianRenderAsset({asset,previewAsset},false)).toBe(previewAsset);
    expect(gaussianRenderAsset({asset,previewAsset},true)).toBe(asset);
    expect(gaussianRenderAsset({asset},false)).toBe(asset);
    expect(previewAsset).toEqual({path:'preview'});
  });
});

describe('canonical Gaussian snapshot download',()=>{
  it('passes only the verified source bytes to decoding and supports abortable same-origin requests',async()=>{
    const {asset,bytes}=source(),abort=new AbortController();
    vi.stubGlobal('crypto',webcrypto);
    const fetch=vi.fn(async()=>new Response(bytes));vi.stubGlobal('fetch',fetch);
    expect(new Uint8Array(await loadGaussianSourceBytes(asset,'/assets/source.spz',abort.signal))).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith('/assets/source.spz',{signal:abort.signal,credentials:'same-origin'});
  });
  it('rejects source substitution instead of silently capturing preview density',async()=>{
    const {asset}=source();vi.stubGlobal('crypto',webcrypto);
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('other source')));
    await expect(loadGaussianSourceBytes(asset,'/source',new AbortController().signal)).rejects.toThrow('SHA-256');
  });
  it('rejects unsafe paths before fetching and preserves the 128 MiB cap',async()=>{
    const {asset}=source(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(loadGaussianSourceBytes({...asset,path:`../${asset.path}`},'/source',new AbortController().signal)).rejects.toThrow('content-addressed');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(new Response('',{headers:{'Content-Length':String(128*1024*1024+1)}}));
    await expect(loadGaussianSourceBytes(asset,'/source',new AbortController().signal)).rejects.toThrow('128 MiB');
  });
  it('does not publish bytes after cancellation',async()=>{
    const {asset,bytes}=source(),abort=new AbortController();abort.abort();
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(bytes)));
    await expect(loadGaussianSourceBytes(asset,'/source',abort.signal)).rejects.toMatchObject({name:'AbortError'});
  });
});
