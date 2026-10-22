import {UiIcon} from './UiIcon';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import './polyhaven-library.css';

type Asset = {id:string;name:string;thumbnailUrl?:string;sourceUrl?:string};
type Result = {kind:'textures'|'models'|'hdris';entry:any};
export interface PolyHavenLibraryProps {kind:Result['kind'];onImport:(result:Result)=>void;disabled?:boolean;scopeKey?:string}
async function api(path:string, data?:unknown, signal?:AbortSignal) {
  const response=await fetch(path,{method:data?'POST':'GET',signal,headers:data?{'Content-Type':'application/json','X-Product-Suite':'1'}:{},body:data?JSON.stringify(data):undefined});
  const value=await response.json();
  if(!response.ok) throw new Error(value.error||`Request failed (${response.status})`);
  return value;
}
export default function PolyHavenLibrary({kind,onImport,disabled=false,scopeKey=''}:PolyHavenLibraryProps) {
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState('');
  const [search,setSearch]=useState('');
  const [offset,setOffset]=useState(0);
  const [assets,setAssets]=useState<Asset[]>([]);
  const [more,setMore]=useState(false);
  const [total,setTotal]=useState(0);
  const [loading,setLoading]=useState(false);
  const [downloading,setDownloading]=useState<string|null>(null);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [retry,setRetry]=useState(0);
  const importController=useRef<AbortController|null>(null);
  const session=useRef(0);
  const latest=useRef({onImport,disabled,scopeKey,kind});latest.current={onImport,disabled,scopeKey,kind};
  const [stale,setStale]=useState(false);
  useEffect(()=>{
    session.current++;
    importController.current?.abort();setDownloading(null);setNotice('');
    return()=>{session.current++;importController.current?.abort();};
  },[kind,scopeKey]);
  useEffect(()=>{
    if(!open)return;
    const abort=new AbortController();setLoading(true);setError('');
    api(`/api/polyhaven/assets?kind=${kind}&q=${encodeURIComponent(search)}&offset=${offset}`,undefined,abort.signal).then(data=>{
      if(abort.signal.aborted)return;
      setStale(!!data.stale);setAssets(current=>offset?[...current,...data.assets]:data.assets);setMore(!!data.hasMore);setTotal(data.total??data.assets.length);
    }).catch(reason=>{if(!abort.signal.aborted)setError(reason.message);}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[open,kind,search,offset,retry]);
  const submit=(event:FormEvent)=>{event.preventDefault();setOffset(0);setSearch(query.trim());setRetry(value=>value+1);};
  const download=async(asset:Asset)=>{
    if(disabled||downloading)return;
    const ownSession=session.current,abort=new AbortController();importController.current=abort;
    setDownloading(asset.id);setError('');setNotice('');
    try{
      const result=await api('/api/polyhaven/import',{kind,id:asset.id},abort.signal);
      if(abort.signal.aborted||session.current!==ownSession||latest.current.scopeKey!==scopeKey||latest.current.kind!==kind)return;
      if(latest.current.disabled){setNotice(`${asset.name} downloaded. Enable material editing to apply it.`);return;}
      latest.current.onImport(result);setNotice(`${asset.name} ${kind==='models'?'added':'applied'}`);
    }catch(reason){if(!abort.signal.aborted&&session.current===ownSession)setError((reason as Error).message);}
    finally{if(session.current===ownSession)setDownloading(null);}
  };
  const label=kind==='textures'?'materials':kind==='models'?'props':'HDRIs';
  return <section className="gesso-section gesso-polyhaven" aria-label={`Poly Haven ${label}`}>
    <div className="gesso-polyhaven-heading"><button type="button" className="gesso-text-button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><UiIcon name={open ? "down" : "chevron"} size={14}/> Browse Poly Haven</button><a href="https://polyhaven.com" target="_blank" rel="noreferrer" className="gesso-meta">CC0 ↗</a></div>
    {open&&<>
      <form className="gesso-polyhaven-search" onSubmit={submit}><input type="search" aria-label={`Search Poly Haven ${label}`} value={query} placeholder={kind==='hdris'?'Search studio, softbox…':kind==='models'?'Search vase, plant, rock…':'Search metal, wood, stone…'} onChange={event=>setQuery(event.target.value)}/><button type="submit" disabled={loading}>Search</button></form>
      <div className="gesso-polyhaven-results gesso-selection-surface" aria-busy={loading}>
        {assets.map(asset=><button type="button" key={asset.id} className="gesso-polyhaven-asset" aria-label={`${kind==='models'?'Add':'Apply'} ${asset.name}`} disabled={disabled||!!downloading||loading} onClick={()=>download(asset)}>
          <span className="gesso-polyhaven-image">{asset.thumbnailUrl&&<img src={asset.thumbnailUrl} alt="" loading="lazy"/>}</span><span>{downloading===asset.id?'Downloading…':asset.name}</span>
        </button>)}
      </div>
      <div className="gesso-polyhaven-status" aria-live="polite"><span className="gesso-meta">{loading?'Loading library…':`${total} ${label} · 1K imports${stale?' · cached':''}`}</span>{more&&<button type="button" className="gesso-text-button" disabled={loading||!!downloading} onClick={()=>setOffset(assets.length)}>Load more</button>}</div>
      {!loading&&!assets.length&&!error&&<p className="gesso-meta">No matches. Try a material or object name.</p>}
      {downloading&&<p className="gesso-meta" role="status">Downloading to your local library…</p>}
      {notice&&<p className="gesso-meta" role="status">{notice}</p>}
      {error&&<div role="alert"><p className="gesso-error">{error}</p><button type="button" className="gesso-text-button" onClick={()=>setRetry(value=>value+1)}>Retry library</button></div>}
    </>}
  </section>;
}
