import {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import PublicSiteHeader from './PublicSiteHeader';
import {useFrameInvalidation, useFrameSource} from './DynamicFrame';
import {roundedFrameNodes} from './frameGeometry';
import {isStaticDemo} from './runtime';
import './marketplace.css';

type Listing = {
  id:string; name:string; creator:string; description:string; kind:string;
  previewUrl:string; assetBytes:number; splatCount?:number; createdAt:string; tags:string[];
  previewUrls?:string[]; format?:string;
  audit?:{summary?:string; reviewedAt?:string};
};
type Membership = {active:boolean;configured:boolean};
type Catalog = {listings:Listing[];membership:Membership;reviewTurnaround:string};
const emptyCatalog:Catalog={listings:[],membership:{active:false,configured:false},reviewTurnaround:'2–3 business days'};
const typeLabel=(kind:string)=>kind==='splat'?'Gaussian world':kind==='mesh'?'Mesh world':'Environment';
const sizeLabel=(bytes:number)=>Number.isFinite(bytes)&&bytes>0?`${(bytes/1_000_000).toFixed(1)} MB`:'Size unavailable';
const dateLabel=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});};

async function requestJson(url:string,signal:AbortSignal) {
  const response=await fetch(url,{credentials:'same-origin',signal,headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error('The community catalog could not load. Try again.');
  return response.json();
}

function ListingDetail({listing,membership,onClose}:{listing:Listing;membership:Membership;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null);
  const [detail,setDetail]=useState(listing),[error,setError]=useState(''),[angle,setAngle]=useState(0);
  const titleId=useId(),helpId=useId();
  useEffect(()=>{
    const returnTo=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const element=dialog.current;
    if(element&&!element.open)element.showModal();
    heading.current?.focus();
    return()=>{element?.close();if(returnTo?.isConnected)returnTo.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{
    if(isStaticDemo)return;
    const abort=new AbortController();
    requestJson(`/api/marketplace/${encodeURIComponent(listing.id)}`,abort.signal).then(result=>{
      if(!abort.signal.aborted)setDetail(result.listing??result);
    }).catch(()=>{if(!abort.signal.aborted)setError('Listing details are unavailable. Close and reopen to retry.');});
    return()=>abort.abort();
  },[listing.id]);
  const previews=detail.previewUrls?.length?detail.previewUrls:[detail.previewUrl];
  const canDownload=membership.active&&membership.configured&&!isStaticDemo;
  const selectedPreview=Math.min(angle,previews.length-1);
  return <dialog ref={dialog} className="gesso-market-detail" aria-labelledby={titleId} aria-describedby={helpId}
    onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>event.stopPropagation()}>
    <header><span>Community environment</span><button type="button" aria-label="Close environment details" onClick={onClose}>×</button></header>
    <div className="gesso-market-detail-body">
      <div className="gesso-market-detail-gallery">
        <img className="gesso-market-detail-image" src={previews[selectedPreview]} alt={`${detail.name} preview ${selectedPreview+1}`} decoding="async"/>
        {previews.length>1&&<div className="gesso-market-detail-angles" role="group" aria-label="Environment previews">{previews.map((preview,index)=><button key={preview} type="button" aria-label={`Show preview ${index+1}`} aria-pressed={selectedPreview===index} onClick={()=>setAngle(index)}><img src={preview} alt="" loading="lazy" decoding="async"/></button>)}</div>}
      </div>
      <section className="gesso-market-detail-info">
        <p className="gesso-market-kind">{typeLabel(detail.kind)}</p>
        <h2 id={titleId} ref={heading} tabIndex={-1}>{detail.name}</h2>
        <p className="gesso-market-creator">By {detail.creator}</p>
        <p id={helpId}>{detail.description}</p>
        <dl><div><dt>Representation</dt><dd>{detail.format?.toUpperCase()??(detail.kind==='splat'?'SPZ Gaussian splat':typeLabel(detail.kind))}</dd></div>
          <div><dt>Download size</dt><dd>{sizeLabel(detail.assetBytes)}</dd></div>
          {Number.isSafeInteger(detail.splatCount)&&<div><dt>Splats</dt><dd>{detail.splatCount!.toLocaleString()}</dd></div>}
          {!!dateLabel(detail.createdAt)&&<div><dt>Published</dt><dd>{dateLabel(detail.createdAt)}</dd></div>}
        </dl>
        {!!detail.tags?.length&&<ul className="gesso-market-tags" aria-label="Environment tags">{detail.tags.map(tag=><li key={tag}>{tag}</li>)}</ul>}
        {detail.audit?.summary&&<details><summary>Review notes</summary><p>{detail.audit.summary}</p>{detail.audit.reviewedAt&&<p>{dateLabel(detail.audit.reviewedAt)}</p>}</details>}
        {error&&<p role="alert" className="gesso-market-error">{error}</p>}
        <div className="gesso-market-entitlement">
          <p>Included with membership</p>
          {canDownload?<a className="gesso-market-download" href={`/api/marketplace/${encodeURIComponent(detail.id)}/download`}>Download environment</a>:<button type="button" disabled>Download environment</button>}
          {!membership.configured?<small>Membership billing hasn’t been connected yet. Downloads will open after setup.</small>:!membership.active?<small>An active subscription is required to download community assets.</small>:null}
        </div>
      </section>
    </div>
  </dialog>;
}

export default function MarketplacePage({active=true}:{active?:boolean}) {
  const root=useRef<HTMLElement>(null);
  const [catalog,setCatalog]=useState<Catalog>(emptyCatalog),[loading,setLoading]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
  const [query,setQuery]=useState(''),[kind,setKind]=useState('all'),[tag,setTag]=useState('all'),[sort,setSort]=useState('newest');
  const [selected,setSelected]=useState<Listing|null>(null);
  const invalidate=useFrameInvalidation();
  useFrameSource('marketplace',()=>{
    const element=root.current;if(!element)return null;
    const bounds=element.getBoundingClientRect();
    return {nodes:roundedFrameNodes({left:bounds.left+12,top:bounds.top+12,right:bounds.right-12,bottom:bounds.bottom-12},12),ground:'#080808',fill:'#111111',halo:{color:'#080808',blur:0,spread:0,opacity:0}};
  });
  useLayoutEffect(()=>{
    const element=root.current;if(!element)return;
    const observer=new ResizeObserver(()=>invalidate('marketplace'));observer.observe(element);invalidate('marketplace');
    return()=>observer.disconnect();
  },[invalidate]);
  useEffect(()=>{
    if(!active){setSelected(null);return;}
    const abort=new AbortController();
    setLoading(true);setError('');
    requestJson(isStaticDemo?`${import.meta.env.BASE_URL}marketplace/catalog.json`:'/api/marketplace',abort.signal).then(result=>{
      if(!Array.isArray(result.listings)||!result.membership)throw new Error('The community catalog is unavailable. Try again.');
      if(!abort.signal.aborted)setCatalog(result);
    }).catch(reason=>{
      if(!abort.signal.aborted){setError(reason instanceof Error?reason.message:'The community catalog could not load.');setCatalog(previous=>({...previous,membership:emptyCatalog.membership}));}
    }).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[active,reload]);
  const kinds=Array.from(new Set(catalog.listings.map(item=>item.kind)));
  const tags=Array.from(new Set(catalog.listings.flatMap(item=>item.tags??[]))).sort();
  const listed=useMemo(()=>{
    const words=query.trim().toLocaleLowerCase();
    return catalog.listings.filter(item=>(kind==='all'||item.kind===kind)&&(tag==='all'||item.tags?.includes(tag))&&
      (!words||`${item.name} ${item.creator} ${item.description} ${(item.tags??[]).join(' ')}`.toLocaleLowerCase().includes(words)))
      .sort((a,b)=>sort==='name'?a.name.localeCompare(b.name):(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
  },[catalog.listings,kind,tag,query,sort]);
  const filtersActive=!!query||kind!=='all'||tag!=='all';
  return <main ref={root} className="gesso-marketplace" data-frame-scroll aria-labelledby="marketplace-title">
    <PublicSiteHeader current="marketplace"/>
    <div className="gesso-market-intro"><div><p>Gesso community</p><h1 id="marketplace-title" tabIndex={-1}>Environments</h1></div><p>Community worlds for product scenes. Included with membership.</p></div>
    <section className="gesso-market-search" aria-label="Search community environments">
      <label><span>Search environments</span><input type="search" aria-label="Search environments" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Materials, lighting, rooms, creators"/></label>
      <label><span>Sort by</span><select aria-label="Sort environments" value={sort} onChange={event=>setSort(event.target.value)}><option value="newest">Recently published</option><option value="name">Name</option></select></label>
    </section>
    <div className="gesso-market-layout">
      <aside className="gesso-market-filters" aria-label="Filter environments">
        <h2>Browse</h2><label><span>Representation</span><select aria-label="Representation" value={kind} onChange={event=>setKind(event.target.value)}><option value="all">All environments</option>{kinds.map(value=><option key={value} value={value}>{typeLabel(value)}</option>)}</select></label>
        {!!tags.length&&<label><span>Tags</span><select aria-label="Environment tag" value={tag} onChange={event=>setTag(event.target.value)}><option value="all">All tags</option>{tags.map(value=><option key={value} value={value}>{value}</option>)}</select></label>}
        {filtersActive&&<button type="button" onClick={()=>{setQuery('');setKind('all');setTag('all');}}>Clear filters</button>}
        <div className="gesso-market-submit"><h3>Share a world</h3><p>Choose community sharing when generating an environment. Submissions go through private checks and review.</p><p>Usually {catalog.reviewTurnaround}.</p><a href="/?step=world&amp;layer=environment">Create in studio →</a></div>
      </aside>
      <section className="gesso-market-results" aria-label="Community environments" aria-busy={loading}>
        <div className="gesso-market-results-heading"><h2>{filtersActive?'Matching environments':'Published environments'}</h2><span role="status">{loading?'Loading…':`${listed.length} ${listed.length===1?'world':'worlds'}`}</span></div>
        {error&&<div className="gesso-market-feedback" role="alert"><p>{error}</p><button type="button" onClick={()=>setReload(value=>value+1)}>Retry catalog</button></div>}
        {!loading&&!error&&!listed.length&&<div className="gesso-market-feedback"><h3>{filtersActive?'No matching worlds':'The first worlds are being prepared'}</h3><p>{filtersActive?'Try a material, room type, or creator name.':'Approved environments will appear here after review.'}</p></div>}
        <div className="gesso-market-grid">{listed.map(item=><button key={item.id} type="button" className="gesso-market-card" aria-label={`View ${item.name}`} onClick={()=>setSelected(item)}>
          <div className="gesso-market-card-image"><img src={item.previewUrl} alt={`${item.name} environment`} loading="lazy" decoding="async" width="1280" height="720"/><span>{typeLabel(item.kind)}</span></div>
          <div className="gesso-market-card-caption"><div><h3>{item.name}</h3><p>{item.creator}</p></div><span>Included</span></div>
        </button>)}</div>
      </section>
    </div>
    <footer className="gesso-market-page-footer"><span>Gesso community</span><a href="/about">About Gesso</a></footer>
    {selected&&createPortal(<ListingDetail listing={selected} membership={catalog.membership} onClose={()=>setSelected(null)}/>,document.body)}
  </main>;
}
