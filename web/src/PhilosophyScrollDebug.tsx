import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {DEFAULT_SCROLL_TUNING, normalizeScrollTuning, type ScrollTuning} from './philosophyScrollPhysics';
import {PHILOSOPHY_SETTLE_QUERY} from './philosophyScroll';
import {DEFAULT_FRAME_SHRINK} from './frameMorph';
import './philosophy-scroll-debug.css';

export type ScrollDebugSnapshot = {
  position:number;
  velocity:number;
  force:number;
  target:number|null;
  stops:readonly number[];
  phase:'native'|'rolling'|'settling'|'resting';
  enabled:boolean;
  reason:string;
};

type Props = {
  tuning:ScrollTuning;
  onChange:(tuning:ScrollTuning)=>void;
  shrink:number;
  onShrink:(shrink:number)=>void;
  onSeek:(index:number)=>void;
  read:()=>ScrollDebugSnapshot;
  active:boolean;
};

const EMPTY:ScrollDebugSnapshot = {position:0,velocity:0,force:0,target:null,stops:[],phase:'native',enabled:false,reason:''};
const STOP_NAMES = ['cover','principles','01','02','03','04'];
const PLOT_WIDTH = 1000;
const VALLEY_Y = 44;
const HILL_HEIGHT = 32;

function sameSnapshot(a:ScrollDebugSnapshot,b:ScrollDebugSnapshot) {
  return a.position===b.position&&a.velocity===b.velocity&&a.force===b.force&&a.target===b.target
    &&a.phase===b.phase&&a.enabled===b.enabled&&a.reason===b.reason
    &&a.stops.length===b.stops.length&&a.stops.every((stop,index)=>stop===b.stops[index]);
}

function finite(value:number) { return Number.isFinite(value)?value:0; }
function metric(value:number) { return Math.round(finite(value)).toLocaleString('en-US'); }
function potential(t:number) { return 16*t*t*(1-t)*(1-t); }

/** Same normalized quartic potential as the scroll controller. Its horizontal
 * axis is the measured document, so a missing or misplaced stop stays visible. */
function landscape(stops:readonly number[]) {
  const first=stops[0]??0,last=stops.at(-1)??1,span=Math.max(1,last-first);
  const x=(value:number)=>Math.max(0,Math.min(1,(value-first)/span));
  const y=(value:number)=>{
    for(let index=1;index<stops.length;index++){
      if(value<=stops[index]&&value>=stops[index-1]){
        const width=stops[index]-stops[index-1];
        return VALLEY_Y-HILL_HEIGHT*potential(width>0?(value-stops[index-1])/width:0);
      }
    }
    return VALLEY_Y;
  };
  const points:string[]=[];
  for(let index=1;index<stops.length;index++){
    for(let sample=index===1?0:1;sample<=32;sample++){
      const t=sample/32,position=stops[index-1]+(stops[index]-stops[index-1])*t;
      points.push(`${points.length?'L':'M'}${(x(position)*PLOT_WIDTH).toFixed(2)},${(VALLEY_Y-HILL_HEIGHT*potential(t)).toFixed(2)}`);
    }
  }
  return {x,y,path:points.join(' ')};
}

function TuningField({name,label,value,min,max,step,unit,hint,onChange}:{
  name:string;label:string;value:number;min:number;max:number;step:number;unit:string;hint:string;onChange:(value:number)=>void;
}) {
  const id=useId();
  return <label className="scroll-study-field" htmlFor={id}>
    <span className="scroll-study-field-label">{label}<output htmlFor={id}>{value.toFixed(step<1?2:0)}<span>{unit}</span></output></span>
    <input id={id} name={name} type="range" min={min} max={max} step={step} value={value}
      aria-describedby={`${id}-hint`} onChange={event=>onChange(Number(event.target.value))}/>
    <span className="scroll-study-hint" id={`${id}-hint`}>{hint}</span>
  </label>;
}

export default function PhilosophyScrollDebug({tuning,onChange,shrink,onShrink,onSeek,read,active}:Props) {
  const [expanded,setExpanded]=useState(true);
  const [hidden,setHidden]=useState(false);
  const [snapshot,setSnapshot]=useState<ScrollDebugSnapshot>(EMPTY);
  const [staticMotion,setStaticMotion]=useState(()=>!window.matchMedia(PHILOSOPHY_SETTLE_QUERY).matches);
  const marbleRef=useRef<HTMLSpanElement>(null);
  const targetRef=useRef<HTMLSpanElement>(null);
  const plotId=useId();
  const controlsId=useId();

  useEffect(()=>{
    const query=window.matchMedia(PHILOSOPHY_SETTLE_QUERY);
    const update=()=>setStaticMotion(!query.matches);
    query.addEventListener('change',update);
    return ()=>query.removeEventListener('change',update);
  },[]);

  useEffect(()=>{
    if(!active||!expanded||hidden)return;
    let frame=0,lastRead=-Infinity,liveStops:readonly number[]=[];
    let livePlot=landscape(liveStops);
    const sample=(now:number)=>{
      frame=0;
      if(document.hidden)return;
      const next=read();
      if(liveStops.length!==next.stops.length||liveStops.some((stop,index)=>stop!==next.stops[index])){
        liveStops=[...next.stops];
        livePlot=landscape(liveStops);
      }
      // Geometry stays on the renderer's cadence; numeric labels only update
      // ten times a second so reading them does not add React work per frame.
      if(marbleRef.current){
        marbleRef.current.style.left=`${livePlot.x(next.position)*100}%`;
        marbleRef.current.style.top=`${livePlot.y(next.position)}px`;
      }
      if(targetRef.current){
        targetRef.current.style.visibility=next.target===null?'hidden':'visible';
        if(next.target!==null)targetRef.current.style.left=`${livePlot.x(next.target)*100}%`;
      }
      if(now-lastRead>=100){
        lastRead=now;
        setSnapshot(previous=>sameSnapshot(previous,next)?previous:{...next,stops:[...next.stops]});
      }
      frame=requestAnimationFrame(sample);
    };
    const visibility=()=>{
      cancelAnimationFrame(frame);frame=0;
      if(!document.hidden)frame=requestAnimationFrame(sample);
    };
    visibility();
    document.addEventListener('visibilitychange',visibility);
    return ()=>{cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visibility);};
  },[active,expanded,hidden,read]);

  useEffect(()=>{
    if(!active)return;
    const toggle=(event:KeyboardEvent)=>{
      if(!event.altKey||!event.shiftKey||event.code!=='KeyD'||event.metaKey||event.ctrlKey)return;
      const target=event.target;
      if(target instanceof HTMLElement&&target.closest('input,textarea,select,[contenteditable="true"]'))return;
      event.preventDefault();
      setHidden(value=>!value);
      setExpanded(true);
    };
    window.addEventListener('keydown',toggle);
    return ()=>window.removeEventListener('keydown',toggle);
  },[active]);

  const plot=useMemo(()=>landscape(snapshot.stops),[snapshot.stops]);
  const change=(key:'pull'|'damping'|'response',value:number)=>onChange(normalizeScrollTuning({...tuning,[key]:value}));
  const smooth=snapshot.enabled&&!staticMotion;
  const policy=staticMotion?'Native · compact, touch or reduced motion':snapshot.reason||(!tuning.enabled?'Native scrolling':'');

  if(!active||hidden)return null;
  return <section className={`scroll-study${expanded?'':' is-collapsed'}`} data-scroll-debug="" aria-label="Scroll study">
    <header className="scroll-study-header">
      <button type="button" className="scroll-study-title" aria-expanded={expanded} aria-controls={controlsId}
        onClick={()=>setExpanded(value=>!value)}>
        <span aria-hidden="true">{expanded?'−':'+'}</span>scroll study
      </button>
      {expanded&&<dl className="scroll-study-readouts">
        <div><dt>position</dt><dd>{metric(snapshot.position)}<span>px</span></dd></div>
        <div><dt>velocity</dt><dd>{metric(snapshot.velocity)}<span>px/s</span></dd></div>
        <div><dt>force</dt><dd>{metric(snapshot.force)}<span>px/s²</span></dd></div>
      </dl>}
      {expanded&&<span className="scroll-study-phase">{staticMotion||!snapshot.enabled?'native':snapshot.phase}</span>}
      <div className="scroll-study-header-actions">
        {expanded&&<button type="button" onClick={()=>{onChange({...DEFAULT_SCROLL_TUNING});onShrink(DEFAULT_FRAME_SHRINK);}}>reset</button>}
        <button type="button" className="scroll-study-hide" title="Hide scroll study. Alt + Shift + D reopens it."
          aria-label="Hide scroll study; Alt + Shift + D to reopen" onClick={()=>setHidden(true)}>hide <kbd>⌥⇧D</kbd></button>
      </div>
    </header>
    {expanded&&<div className="scroll-study-body" id={controlsId}>
      <div className="scroll-study-landscape">
        <div className="scroll-study-landscape-label"><span>snap landscape</span><span>{policy||'one minimum per finished frame'}</span></div>
        <div className="scroll-study-plot">
          <svg viewBox={`0 0 ${PLOT_WIDTH} 56`} preserveAspectRatio="none" role="img" aria-labelledby={plotId}>
            <title id={plotId}>{snapshot.stops.length} snap positions along the document. Current scroll position {metric(snapshot.position)} pixels.</title>
            <path d={plot.path} vectorEffect="non-scaling-stroke"/>
            {snapshot.stops.map((stop,index)=><line key={index} x1={plot.x(stop)*PLOT_WIDTH} x2={plot.x(stop)*PLOT_WIDTH} y1="44" y2="52" vectorEffect="non-scaling-stroke"/>)}
          </svg>
          <span ref={targetRef} className="scroll-study-target" aria-hidden="true"/>
          <span ref={marbleRef} className="scroll-study-marble" aria-hidden="true"/>
        </div>
        <div className="scroll-study-stops" role="group" aria-label="Jump to finished frame">
          {snapshot.stops.map((stop,index)=><button key={index} type="button" title={`${STOP_NAMES[index]??index+1} · ${metric(stop)} px`}
            aria-current={Math.abs(snapshot.position-stop)<2?'step':undefined}
            style={{left:`${plot.x(stop)*100}%`}}
            onClick={()=>onSeek(index)}>{STOP_NAMES[index]??String(index+1).padStart(2,'0')}</button>)}
        </div>
      </div>
      <div className="scroll-study-settings">
        <div className="scroll-study-mode" role="group" aria-label="Scroll behavior">
          <button type="button" aria-pressed={smooth} disabled={staticMotion} onClick={()=>onChange(normalizeScrollTuning({...tuning,enabled:true}))}>smooth</button>
          <button type="button" aria-pressed={!smooth} onClick={()=>onChange(normalizeScrollTuning({...tuning,enabled:false}))}>native</button>
        </div>
        <div className="scroll-study-fields">
          <TuningField name="shrink" label="shrink" value={Math.round(shrink*100)} min={0} max={50} step={1} unit="%" hint="at the midpoint" onChange={value=>onShrink(value/100)}/>
          <TuningField name="pull" label="pull" value={tuning.pull} min={4} max={18} step={1} unit="s⁻¹" hint="toward each stop" onChange={value=>change('pull',value)}/>
          <TuningField name="damping" label="damping" value={tuning.damping} min={.7} max={1.5} step={.05} unit="ratio" hint="removes momentum" onChange={value=>change('damping',value)}/>
          <TuningField name="response" label="response" value={tuning.response} min={8} max={28} step={1} unit="s⁻¹" hint="follows your input" onChange={value=>change('response',value)}/>
        </div>
      </div>
    </div>}
  </section>;
}
