import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {createNativeProofSession,type NativeProofInput,type NativeProofView} from './nativeProof';
import './native-proof.css';

export interface NativeProofProps {
  scopeKey:string;viewKey:string;ownerKey:string;active:boolean;ready:boolean;disabledReason:string;
  prepare:()=>NativeProofInput|Promise<NativeProofInput>;onPresent?:(showing:boolean)=>void;
}
const initial:NativeProofView={phase:'idle',image:null,requestedKey:null,proof:null,error:''};

/** Same scene, native image. Automatic proofs coalesce settled edits; they never
 * commit a preview, save a campaign or turn an older image into a current one. */
export default function NativeProof(props:NativeProofProps){
  const [state,setState]=useState(initial),[showing,setShowing]=useState(false),[automatic,setAutomatic]=useState(false);
  const [visible,setVisible]=useState(()=>document.visibilityState!=='hidden');
  const session=useRef<ReturnType<typeof createNativeProofSession>|null>(null);
  const callbacks=useRef(props);callbacks.current=props;
  const trigger=useRef<HTMLButtonElement|null>(null);
  const autoRequested=useRef('');
  const preparing=useRef(0);
  useEffect(()=>{
    const controller=createNativeProofSession(crypto.randomUUID(),setState);session.current=controller;
    return()=>{preparing.current++;controller.dispose();session.current=null;callbacks.current.onPresent?.(false);};
  },[]);
  useEffect(()=>{const change=()=>setVisible(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',change);return()=>document.removeEventListener('visibilitychange',change);},[]);
  const eligible=props.active&&props.ready&&visible;
  const previousScope=useRef(props.scopeKey);
  useEffect(()=>{
    if(previousScope.current===props.scopeKey)return;
    previousScope.current=props.scopeKey;
    preparing.current++;session.current?.cancel();setShowing(false);
  },[props.scopeKey]);
  useEffect(()=>{preparing.current++;session.current?.clear();autoRequested.current='';setShowing(false);},[props.ownerKey]);
  useEffect(()=>{
    if(!props.active||!visible){preparing.current++;session.current?.cancel();setShowing(false);}
  },[props.active,visible]);
  useEffect(()=>{setShowing(false);},[props.viewKey]);
  const render=async()=>{
    const current=callbacks.current;
    if(!current.active||!current.ready)return;
    const token=++preparing.current,scope=current.scopeKey;
    try{
      const input=await current.prepare();
      if(token===preparing.current&&callbacks.current.scopeKey===scope&&callbacks.current.active&&callbacks.current.ready)session.current?.start(input);
    }catch(error){if(token===preparing.current&&callbacks.current.scopeKey===scope)setState(previous=>({...previous,phase:'failed',error:error instanceof Error?error.message:'The current view could not be prepared.'}));}
  };
  useEffect(()=>{
    if(!automatic||!eligible||autoRequested.current===props.scopeKey)return;
    const key=props.scopeKey;
    const timer=setTimeout(()=>{
      if(callbacks.current.scopeKey!==key||!callbacks.current.active||!callbacks.current.ready)return;
      autoRequested.current=key;void render();
    },650);
    return()=>clearTimeout(timer);
  },[automatic,eligible,props.scopeKey]);
  const staged=session.current?.pendingImage();
  useEffect(()=>{
    if(state.phase==='ready'&&state.image?.sourceKey===callbacks.current.scopeKey&&callbacks.current.active)setShowing(true);
  },[state.phase,state.image]);
  const presented=!!(showing&&state.image&&props.active);
  useEffect(()=>{callbacks.current.onPresent?.(presented);return()=>callbacks.current.onPresent?.(false);},[presented]);
  const back=()=>{setShowing(false);trigger.current?.focus({preventScroll:true});};
  const pending=['requesting','queued','waiting','rendering','loading'].includes(state.phase);
  const current=state.image?.sourceKey===props.scopeKey;
  const status=state.phase==='waiting'?'Waiting for renderer…':state.phase==='queued'?'Proof queued…':state.phase==='loading'?'Loading proof…':'Rendering proof…';
  const onKeyDown=(event:KeyboardEvent)=>{if(event.key==='Escape'&&presented){event.preventDefault();event.stopPropagation();back();}};
  return <><span className="gesso-native-proof-toolbar" hidden={!props.active} onKeyDown={onKeyDown}>
    <button ref={trigger} type="button" disabled={!eligible&&!pending}
      title={pending?'Cancel the current native proof.':props.disabledReason||'Render this view with Cycles, using the scene’s materials, lighting and optics.'}
      onClick={()=>{if(pending){preparing.current++;session.current?.cancel();}else void render();}}>{pending?'Cancel proof':'Render proof'}</button>
    <button type="button" className="gesso-proof-auto" aria-pressed={automatic} disabled={!props.active||(!props.ready&&!automatic)}
      title="Render a new proof after editing settles. Hidden tabs pause requests."
      onClick={()=>setAutomatic(value=>{if(value){preparing.current++;session.current?.cancel();}else autoRequested.current='';return !value;})}>Auto proof{automatic?' on':''}</button>
    {pending&&<span className="gesso-proof-progress" role="status">{status}</span>}
    {!presented&&state.image&&<button type="button" onClick={()=>setShowing(true)} title={current?'Show the current Cycles proof.':'Inspect the retained proof of an earlier edit.'}>{current?'View proof':'Earlier proof'}</button>}
    {presented&&<button type="button" onClick={back}>Back to preview</button>}
    {staged&&<img className="gesso-proof-decode" src={staged.url} alt="" aria-hidden onLoad={async event=>{
      const element=event.currentTarget,url=staged.url,controller=session.current;
      try{if(element.decode)await element.decode();controller?.imageReady(url,element.naturalWidth,element.naturalHeight);}
      catch{controller?.imageFailed(url);}
    }} onError={()=>session.current?.imageFailed(staged.url)}/>}
    {state.error&&<span className="gesso-proof-error" role="alert">{state.error}</span>}
  </span>
    {presented&&state.image&&<div className="gesso-native-proof-image" aria-label="Native render proof" onKeyDown={onKeyDown}>
      <img src={state.image.url} alt={`${state.image.viewLabel} rendered with Cycles, frame ${state.image.proof.frame}`} draggable={false}/>
      <div className="gesso-native-proof-caption" role="status">
        <span>{current?'Cycles proof':'Earlier Cycles proof'} · {state.image.viewLabel} · frame {state.image.proof.frame} · {state.image.proof.width} × {state.image.proof.height} · {state.image.proof.samples} samples</span>
        <button type="button" onClick={back}>Back to preview</button>
      </div>
    </div>}
  </>;
}
