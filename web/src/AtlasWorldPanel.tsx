import {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import './atlas-world-panel.css';

type AtlasWorld = {id:string; providerWorldId:string};
type ReferenceImage = {url:string;name?:string};
type Run = {
  id:string; guideId:string; prompt:string;
  parentId?:string; instruction?:string; revision?:number; imageProvider?:string;
  communityOptIn?:boolean; communitySubmission?:{state:string};
  stage:'concepts'|'references'|'views'|'pose'|'draft'|'refine';
  state:'pending'|'succeeded'|'failed'|'uncertain';
  concepts?:ReferenceImage[]; selectedConcept?:number; views?:ReferenceImage[];
  draftWorld?:AtlasWorld; refinedWorld?:AtlasWorld; error?:string; canRetry?:boolean;
};
type Request = (path:string, method?:string, data?:unknown, signal?:AbortSignal)=>Promise<any>;
const endpoint='/api/atlas/worlds';
const guide='water-light-pavilion';
const stageLabels:Record<Run['stage'],string>={concepts:'Visual directions',references:'Reference images',views:'Reference images',pose:'Preparing 3D views',draft:'Draft world',refine:'Refined world'};
const communityMessages:Record<string,string>={changes_needed:'A rendered room preview is needed before review.',queued:'Queued for private community review. Usually 2–3 business days.'};
const surfaceWords=/\b(stone|limestone|marble|travertine|wood|oak|walnut|glass|slate|metal|steel|concrete|plaster|ceramic|leather|fabric)\b/i;
const lightWords=/\b(light|lighting|lit|daylight|sun|sunlit|sunlight|window|lamp|lamps|glow|softbox|backlit|shadow|shadows|dusk|dawn|noon|evening|night)\b/i;
type Props = {request:Request;onUse:(id:string)=>Promise<void>;applyDisabled:boolean};

export default function AtlasWorldDisclosure(props:Props) {
  const [opened,setOpened]=useState(false);
  return <>
    <button type="button" className="wide" aria-haspopup="dialog" onClick={()=>setOpened(true)}>Design environment</button>
    {opened&&createPortal(<AtlasReferenceDialog {...props} onClose={()=>setOpened(false)}/>,document.body)}
  </>;
}

function AtlasReferenceDialog({request,onUse,applyDisabled,onClose}:Props&{onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),heading=useRef<HTMLHeadingElement>(null);
  const callbacks=useRef({onClose});callbacks.current={onClose};
  const [runs,setRuns]=useState<Run[]>([]),[selected,setSelected]=useState('');
  const [newDirection,setNewDirection]=useState(false),[notes,setNotes]=useState('');
  const [surface,setSurface]=useState('decide'),[light,setLight]=useState('decide');
  const [communityOptIn,setCommunityOptIn]=useState(true),[instruction,setInstruction]=useState('');
  const [angle,setAngle]=useState(0),[conceptIndex,setConceptIndex]=useState(-1);
  const [loading,setLoading]=useState(true),[working,setWorking]=useState(false),[error,setError]=useState('');
  const [activity,setActivity]=useState('');
  const busy=useRef(false),mounted=useRef(false);
  const sharingField=useRef<HTMLInputElement>(null),restoreSharingFocus=useRef(false);
  const titleId=useId(),helpId=useId(),choiceId=useId();
  const run=runs.find(item=>item.id===selected)??runs[0];

  useEffect(()=>{
    mounted.current=true;
    const returnTo=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const element=dialog.current;
    if(element&&!element.open)element.showModal();
    heading.current?.focus();
    return()=>{mounted.current=false;element?.close();if(returnTo?.isConnected)returnTo.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{
    const abort=new AbortController();setLoading(true);
    request(endpoint,'GET',undefined,abort.signal).then(result=>{
      if(!abort.signal.aborted)setRuns(result.runs);
    }).catch(failure=>{if(!abort.signal.aborted)setError(failure.message);})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[request]);
  useEffect(()=>{setAngle(0);setConceptIndex(run?.selectedConcept??-1);setInstruction('');setError('');},[run?.id]);
  useEffect(()=>{
    if(working||!restoreSharingFocus.current)return;
    restoreSharingFocus.current=false;
    const focused=document.activeElement;
    if(focused===document.body||focused===dialog.current||focused===sharingField.current)sharingField.current?.focus({preventScroll:true});
  },[working]);

  function choose(id:string) {setSelected(id);setNewDirection(false);}
  function keep(next:Run) {
    if(!mounted.current)return;
    setRuns(items=>[next,...items.filter(item=>item.id!==next.id)]);choose(next.id);
  }
  async function perform(action:()=>Promise<void>,status='Submitting… You can reopen this editor to check the saved operation.') {
    if(busy.current)return;
    busy.current=true;setWorking(true);setActivity(status);setError('');
    try{await action();}
    catch(failure){if(mounted.current)setError(failure instanceof Error?failure.message:String(failure));}
    finally{busy.current=false;if(mounted.current)setWorking(false);}
  }
  const submit=()=>perform(async()=>{
    const prompt=notes.trim();if(!prompt)return;
    const details=[prompt];
    if(!surfaceWords.test(prompt)&&surface!=='decide')details.push(`Supporting surface: ${surface}.`);
    if(!lightWords.test(prompt)&&light!=='decide')details.push(`Lighting: ${light}.`);
    keep(await request(endpoint,'POST',{guideId:guide,imageProvider:'fal',communityOptIn,prompt:details.join('\n'),...(run?{variationKey:crypto.randomUUID()}:{})}));
  });
  const tryMore=()=>perform(async()=>{
    if(run)keep(await request(endpoint,'POST',{guideId:run.guideId,imageProvider:'fal',communityOptIn:run.communityOptIn??true,prompt:run.prompt,variationKey:crypto.randomUUID()}));
  });
  const revise=()=>perform(async()=>{
    if(run&&instruction.trim())keep(await request(`${endpoint}/${run.id}/revise`,'POST',{instruction:instruction.trim()}));
  });
  const updateSharing=(enabled:boolean)=>{
    restoreSharingFocus.current=document.activeElement===sharingField.current;
    return perform(async()=>{
      if(run)keep(await request(`${endpoint}/${run.id}/sharing`,'POST',{communityOptIn:enabled}));
    },'Saving community preference…');
  };
  const makeReferences=()=>perform(async()=>{
    if(run&&conceptIndex>=0)keep(await request(`${endpoint}/${run.id}/references`,'POST',{conceptIndex}));
  });
  const advance=(step:'refresh'|'draft'|'refine')=>perform(async()=>{
    if(run)keep(await request(`${endpoint}/${run.id}/${step}`,'POST'));
  });
  const apply=(world:AtlasWorld)=>perform(async()=>{await onUse(world.id);if(mounted.current)callbacks.current.onClose();});
  const ready=run?.state==='succeeded',starting=!run||newDirection,choosing=!starting&&run.stage==='concepts';
  const canDraft=ready&&(run.stage==='references'||run.stage==='views')&&!run.draftWorld;
  const canRefine=ready&&!!run.draftWorld&&!run.refinedWorld;
  const retry=run?.state==='failed'&&run.canRetry;
  const parent=runs.find(item=>item.id===run?.parentId);
  const viewSet=run?.views?.length?run:parent,conceptSet=run?.concepts?.length?run:parent;
  const views=starting?[]:viewSet?.views??[],concepts=starting?[]:conceptSet?.concepts??[];
  const selectedAngle=Math.min(angle,Math.max(0,views.length-1));
  const selectedConcept=Math.min(conceptIndex,concepts.length-1);
  const concept=concepts[selectedConcept],view=views[selectedAngle];
  const image=choosing?concept:view??concept;
  const imageLabel=choosing?`Direction ${selectedConcept+1}`:view?.name??(view?`Room reference angle ${selectedAngle+1}`:`Chosen direction ${selectedConcept+1}`);
  const showingConcept=!choosing&&!view&&!!concept;
  const showingEarlier=!!image&&(choosing?conceptSet===parent:viewSet===parent);
  const canRevise=!!(run?.views?.length||run?.concepts?.length)&&run?.state!=='pending'&&run?.state!=='uncertain';
  const imageRequest=run?.imageProvider==='fal'&&(run.stage==='references'||run.stage==='concepts');
  const needsSurface=!!notes.trim()&&!surfaceWords.test(notes),needsLight=!!notes.trim()&&!lightWords.test(notes);

  return <dialog ref={dialog} className="gesso-reference-dialog" aria-labelledby={titleId} aria-describedby={helpId}
    onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{
      event.stopPropagation();
      if(event.key!=='Tab')return;
      const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(element=>element.getClientRects().length>0);
      const first=controls[0],last=controls.at(-1),focused=document.activeElement;
      if(event.shiftKey&&(focused===first||focused===heading.current)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&focused===last){event.preventDefault();first?.focus();}
    }}>
    <header className="gesso-reference-header">
      <div><h2 id={titleId} ref={heading} tabIndex={-1}>Design environment</h2><p id={helpId}>Choose a visual direction, review its angles, then build it in 3D.</p></div>
      <button type="button" className="gesso-reference-close" aria-label="Close environment editor" onClick={onClose}>×</button>
    </header>
    <div className="gesso-reference-body" aria-busy={loading||working}>
      <section className="gesso-reference-board" aria-label="Environment reference board">
        {(loading||starting||image||!concepts.length)&&<figure className="gesso-atlas-view">
          {loading?<div className="gesso-reference-placeholder" role="status">Loading reference sets…</div>:image?<>
            <a href={image.url} target="_blank" rel="noreferrer" aria-label={`Open ${imageLabel.toLowerCase()} at full size`}><img src={image.url} alt={imageLabel} width="1280" height="720" decoding="async"/></a>
            <figcaption>{showingEarlier?'Earlier revision · ':''}{imageLabel}<span>Open image for full size</span></figcaption>
          </>:<div className="gesso-reference-placeholder"><h3>Describe the room you have in mind.</h3><p>Generate three directions, choose one, and review it from four angles.</p></div>}
        </figure>}
        {choosing&&concepts.length>0&&<div className="gesso-reference-concepts" role="group" aria-label="Visual directions">
          {concepts.map((item,index)=><button type="button" key={item.url} aria-label={`Preview direction ${index+1}`} aria-pressed={conceptIndex===index} onClick={()=>setConceptIndex(index)}><img src={item.url} alt="" width="1280" height="720" decoding="async"/><span>Direction {index+1}</span></button>)}
        </div>}
        {!choosing&&views.length>0&&<div className="gesso-atlas-angles" role="group" aria-label="Reference angles">
          {views.map((item,index)=><button type="button" key={item.url} aria-label={`Review angle ${index+1}`} aria-pressed={selectedAngle===index} onClick={()=>setAngle(index)}><img src={item.url} alt="" width="1280" height="720" loading="lazy" decoding="async"/><span>{index+1}</span></button>)}
        </div>}
        {image&&<p className="gesso-reference-caption">{showingConcept?'The chosen direction stays visible while its reference angles are being generated.':showingEarlier?'Showing the previous set while this revision has no completed images.':choosing?'Choose a direction to generate its reference angles.':'Check surfaces across angles, straight edges, and clear areas for the product.'}</p>}
      </section>
      <aside className="gesso-reference-controls" aria-label="Reference editing">
        {runs.length>0&&<label>Saved reference set<select aria-label="Saved reference set" value={run.id} disabled={working||loading} onChange={event=>choose(event.target.value)}>{runs.map(item=><option key={item.id} value={item.id}>Revision {item.revision??1} · {item.instruction?.slice(0,42)||item.prompt?.slice(0,42)||'Saved direction'} · {item.id.slice(0,6)}</option>)}</select></label>}
        {starting?<>
          <label>Scene direction<textarea aria-label="Scene direction" value={notes} required maxLength={1000} disabled={working||loading} onChange={event=>setNotes(event.target.value)} placeholder="A quiet designer’s desk, slightly cluttered, with orange evening light"/></label>
          {(needsSurface||needsLight)&&<div className="gesso-reference-questions"><p>Optional details</p>
            {needsSurface&&<fieldset><legend>What should the product rest on?</legend>{[['honed stone','Stone'],['solid wood','Wood'],['decide','Decide for me']].map(([value,label])=><label key={value}><input type="radio" name={`${choiceId}-surface`} checked={surface===value} disabled={working||loading} onChange={()=>setSurface(value)}/><span>{label}</span></label>)}</fieldset>}
            {needsLight&&<fieldset><legend>How should it be lit?</legend>{[['soft daylight','Daylight'],['warm lamp light','Warm lamps'],['decide','Decide for me']].map(([value,label])=><label key={value}><input type="radio" name={`${choiceId}-light`} checked={light===value} disabled={working||loading} onChange={()=>setLight(value)}/><span>{label}</span></label>)}</fieldset>}
          </div>}
          <label className="gesso-reference-community"><input type="checkbox" checked={communityOptIn} disabled={working||loading} onChange={event=>setCommunityOptIn(event.target.checked)}/><span>Submit the finished world for community review</span></label>
          {communityOptIn&&<p>Submissions go through private checks and review before publication. Usually 2–3 business days.</p>}
          <button type="button" className="gesso-reference-primary" disabled={loading||working||!notes.trim()||run?.state==='pending'||run?.state==='uncertain'} onClick={submit}>Generate three directions · uses credits</button>
          {run&&<button type="button" disabled={working} onClick={()=>setNewDirection(false)}>Return to selected set</button>}
        </>:<>
          <p role="status">{stageLabels[run.stage]} · {run.state}</p>
          <details className="gesso-reference-brief"><summary>Scene direction</summary><p>{run.prompt}</p></details>
          {run.instruction&&<p className="gesso-reference-instruction">{run.instruction}</p>}
          <label className="gesso-reference-community"><input ref={sharingField} type="checkbox" checked={run.communityOptIn===true} disabled={working} onChange={event=>updateSharing(event.target.checked)}/><span>Community sharing</span></label>
          <p>{run.communityOptIn?communityMessages[run.communitySubmission?.state??'']??'Finished worlds go through private checks and review. Usually 2–3 business days.':'Private direction. Community sharing is off.'}</p>
          {parent&&<button type="button" disabled={working} onClick={()=>choose(parent.id)}>Return to revision {parent.revision??1}</button>}
          {run.error&&<p role="alert" className="gesso-reference-error">{run.error}</p>}
          {run.state==='uncertain'&&<a href={imageRequest?'https://fal.ai/dashboard/requests':'https://atlas-beta.worldlabs.ai/'} target="_blank" rel="noreferrer">Check {imageRequest?'image requests':'Atlas Operations'}</a>}
          {run.state==='pending'&&<button type="button" disabled={working} onClick={()=>advance('refresh')}>Check build status</button>}
          {canRevise&&<>
            <label>What should change?<textarea aria-label="Reference changes" value={instruction} maxLength={1000} disabled={working} onChange={event=>setInstruction(event.target.value)} placeholder="Make the stone warmer and the ledge thicker. Keep the window and room layout."/></label>
            <p>{choosing?'Saves three revised directions.':'Edits apply across the reference angles and save a new revision.'}</p>
            <button type="button" disabled={working||!instruction.trim()} onClick={revise}>{choosing?'Revise directions':'Revise all angles'} · uses credits</button>
          </>}
          {choosing&&run.state!=='pending'&&run.state!=='uncertain'&&<button type="button" disabled={working} onClick={tryMore}>Try three more · uses credits</button>}
          <button type="button" disabled={working} onClick={()=>{setNotes(run.prompt);setCommunityOptIn(run.communityOptIn??true);setNewDirection(true);}}>Edit brief / start again</button>
        </>}
        {error&&<p className="gesso-reference-error" role="alert">{error}</p>}
        {working&&<p role="status">{activity}</p>}
      </aside>
    </div>
    <footer className="gesso-reference-footer"><p>{starting?'Three image directions come before the 3D build.':choosing?'Choose one direction for its reference angles.':'The 3D build uses this selected reference set.'}</p><div><button type="button" onClick={onClose}>Back to studio</button>
      {!starting&&<>
        {choosing&&ready&&<button type="button" className="gesso-reference-primary" disabled={working||conceptIndex<0} aria-label={conceptIndex<0?'Generate four reference angles · uses credits':`Generate four reference angles from direction ${conceptIndex+1} · uses credits`} onClick={makeReferences}>Generate four angles · uses credits</button>}
        {(canDraft||retry&&(run.stage==='draft'||run.stage==='pose'))&&<button type="button" className="gesso-reference-primary" disabled={working} onClick={()=>advance('draft')}>Build 3D from these views · uses credits</button>}
        {run.draftWorld&&<button type="button" disabled={working||applyDisabled} onClick={()=>apply(run.draftWorld!)}>Use draft in current scene</button>}
        {(canRefine||retry&&run.stage==='refine')&&<button type="button" disabled={working} onClick={()=>advance('refine')}>Refine chosen world · uses credits</button>}
        {run.refinedWorld&&<button type="button" className="gesso-reference-primary" disabled={working||applyDisabled} onClick={()=>apply(run.refinedWorld!)}>Use refined world in current scene</button>}
      </>}
    </div></footer>
  </dialog>;
}
