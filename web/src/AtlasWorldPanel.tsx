import {useEffect, useRef, useState} from 'react';

type AtlasWorld = {id:string; providerWorldId:string};
type Run = {
  id:string;
  guideId:string;
  prompt:string;
  stage:'views'|'draft'|'refine';
  state:'pending'|'succeeded'|'failed'|'uncertain';
  views?:{url:string}[];
  draftWorld?:AtlasWorld;
  refinedWorld?:AtlasWorld;
  error?:string;
  canRetry?:boolean;
};
type Request = (path:string, method?:string, data?:unknown, signal?:AbortSignal)=>Promise<any>;
const endpoint='/api/atlas/worlds';
const guide='water-light-pavilion';

type Props = {request:Request;onUse:(id:string)=>Promise<void>;applyDisabled:boolean};

export default function AtlasWorldDisclosure(props:Props) {
  const [opened,setOpened]=useState(false);
  return <details className="gesso-disclosure" onToggle={event=>{if(event.currentTarget.open)setOpened(true);}}>
    <summary>Build with Atlas</summary>
    {opened&&<AtlasWorldPanel {...props}/>}
  </details>;
}

function AtlasWorldPanel({request,onUse,applyDisabled}:Props) {
  const [runs,setRuns]=useState<Run[]>([]);
  const [selected,setSelected]=useState('');
  const [notes,setNotes]=useState('');
  const [working,setWorking]=useState(false);
  const [error,setError]=useState('');
  const busy=useRef(false);
  const run=runs.find(item=>item.id===selected)??runs[0];

  useEffect(()=>{
    const abort=new AbortController();
    request(endpoint,'GET',undefined,abort.signal).then(result=>{
      if(!abort.signal.aborted)setRuns(result.runs);
    }).catch(failure=>{
      if(!abort.signal.aborted)setError(failure.message);
    });
    return ()=>abort.abort();
  },[request]);

  function keep(next:Run) {
    setRuns(items=>[next,...items.filter(item=>item.id!==next.id)]);
    setSelected(next.id);
  }

  async function perform(action:()=>Promise<void>) {
    if(busy.current)return;
    busy.current=true;
    setWorking(true);
    setError('');
    try {await action();}
    catch(failure){setError(failure instanceof Error?failure.message:String(failure));}
    finally {busy.current=false;setWorking(false);}
  }

  const submit=()=>perform(async()=>{
    const prompt=notes.trim();
    keep(await request(endpoint,'POST',{guideId:guide,...(prompt?{prompt}:{})}));
  });
  const advance=(step:'refresh'|'draft'|'refine')=>perform(async()=>{
    if(run)keep(await request(`${endpoint}/${run.id}/${step}`,'POST'));
  });
  const apply=(world:AtlasWorld)=>perform(()=>onUse(world.id));
  const ready=run?.state==='succeeded';
  const canDraft=ready&&run.stage==='views'&&!run.draftWorld;
  const canRefine=ready&&!!run.draftWorld&&!run.refinedWorld;
  const retry=run?.state==='failed'&&run.canRetry;
  return <section className="control-section" aria-label="Atlas world build">
    <p className="small-copy">Water-light pavilion · a dry glass slab, basalt plinth and steel console beside a ribbed glass wall.</p>
    <img src={`${endpoint}/guides/${guide}/reference`} alt="Water-light pavilion reference" loading="lazy" style={{display:'block',width:'100%',height:'auto'}}/>
    <label className="gesso-field"><span>Art direction (optional)</span>
      <textarea value={notes} maxLength={500} onChange={event=>setNotes(event.target.value)} placeholder="Cooler glass, softer light on the basalt"/>
    </label>
    <button type="button" className="wide" disabled={working||run?.state==='pending'||run?.state==='uncertain'} onClick={submit}>Generate Atlas views · uses credits</button>
    {error&&<p className="small-copy" role="alert">{error}</p>}
    {run&&<>
      {runs.length>1&&<label className="gesso-field"><span>Saved build</span><select value={run.id} disabled={working} onChange={event=>setSelected(event.target.value)}>
        {runs.map(item=><option key={item.id} value={item.id}>{item.prompt?.slice(0,54)||'Water-light pavilion'} · {item.id.slice(0,8)}</option>)}
      </select></label>}
      <p role="status" className="small-copy">{run.stage==='views'?'Source views':run.stage==='draft'?'Draft splat':'Refined splat'} · {run.state}</p>
      {run.error&&<p role="alert" className="small-copy">{run.error}</p>}
      {run.state==='uncertain'&&<a className="text-link" href="https://atlas-beta.worldlabs.ai/" target="_blank" rel="noreferrer">Check Atlas Operations</a>}
      {run.state==='pending'&&<button type="button" disabled={working} onClick={()=>advance('refresh')}>Check build status</button>}
      {!!run.views?.length&&<details className="gesso-disclosure" open={run.stage==='views'?true:undefined}>
        <summary>Review {run.views.length} source views</summary>
        <p className="small-copy">Check the same surfaces across angles. Look for a continuous channel, straight console edges, and clear product contact areas.</p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(2, minmax(0, 1fr))',gap:4}}>
          {run.views.map((view,index)=><a key={view.url} href={view.url} target="_blank" rel="noreferrer" aria-label={`Open source view ${index+1}`}>
            <img src={view.url} alt={`Source view ${index+1}`} width="1280" height="720" loading="lazy" style={{display:'block',width:'100%',height:'auto'}}/>
          </a>)}
        </div>
      </details>}
      {(canDraft||retry&&run.stage==='draft')&&<button type="button" className="wide" disabled={working} onClick={()=>advance('draft')}>Build draft from reviewed views · uses credits</button>}
      {run.draftWorld&&<button type="button" className="wide" disabled={working||applyDisabled} onClick={()=>apply(run.draftWorld!)}>Use draft in current scene</button>}
      {(canRefine||retry&&run.stage==='refine')&&<button type="button" className="wide" disabled={working} onClick={()=>advance('refine')}>Refine from reviewed views · uses credits</button>}
      {run.refinedWorld&&<button type="button" className="wide" disabled={working||applyDisabled} onClick={()=>apply(run.refinedWorld!)}>Use refined world in current scene</button>}
    </>}
  </section>;
}
