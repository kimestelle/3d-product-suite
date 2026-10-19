import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {CURVE_PRESETS, CURVE_PRESET_ALIASES} from './curvePresets';
import {frameBounds, framePath, type FrameNodes} from './frameGeometry';
import {frameGuidePath} from './frameGuides';
import {createFrameMorph} from './frameMorph';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import './curve-demo.css';

type Endpoint = 'a' | 'b';
const clamp = (n:number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const presets = CURVE_PRESETS.map((preset, index) => {
  const bounds = frameBounds(preset.nodes), inset = Math.max(bounds.width, bounds.height) * .12;
  return {...preset, index, path:framePath(preset.nodes), viewBox:`${bounds.left-inset} ${bounds.top-inset} ${bounds.width+inset*2} ${bounds.height+inset*2}`};
});
const lookup = (id:string, fallback:number) => {const index=presets.findIndex(p=>p.id===id);return index<0?fallback:index;};
const initial = () => {
  const params = new URLSearchParams(location.search);
  const resolve = (id:string|null) => id ? CURVE_PRESET_ALIASES[id]??id : null;
  const a = resolve(params.get('a')), b = resolve(params.get('b'));
  return {a:a && presets.some(p=>p.id===a) ? presets.findIndex(p=>p.id===a) : lookup('studio-cross',0),
    b:b && presets.some(p=>p.id===b) ? presets.findIndex(p=>p.id===b) : lookup('studio-landing',2),
    progress:clamp(Number(params.get('t')??0))};
};
function Icon({name}:{name:'play'|'pause'|'swap'|'reverse'|'download'}) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name==='play'?<path d="m8 5 11 7-11 7z"/>:name==='pause'?<><path d="M8 5v14M16 5v14"/></>:name==='swap'?<><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/></>:name==='reverse'?<><path d="M3 10h11a6 6 0 0 1 0 12M8 5l-5 5 5 5"/></>:<><path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/></>}
  </svg>;
}

const Catalog = memo(function Catalog({a,b,slot,onChoose}:{a:number;b:number;slot:Endpoint;onChoose:(index:number)=>void}) {
  const buttons = useRef<(HTMLButtonElement|null)[]>([]);
  return <div className="curve-catalog" aria-label={`Choose shape ${slot.toUpperCase()}`}>
    {presets.map((preset,index)=><button key={preset.id} ref={node=>{buttons.current[index]=node;}}
      type="button"
      aria-label={`${String(index+1).padStart(2,'0')} ${preset.name}${index===a?', A':''}${index===b?', B':''}`}
      aria-pressed={index===a||index===b} title={`${preset.name} · ${preset.family}`}
      onClick={()=>onChoose(index)} onKeyDown={event=>{
        const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-4,ArrowDown:4}[event.key];
        if(delta===undefined)return;
        event.preventDefault();buttons.current[Math.max(0,Math.min(presets.length-1,index+delta))]?.focus();
      }}>
      <span className="curve-tile-number">{String(index+1).padStart(2,'0')}</span>
      {(index===a||index===b)&&<span className="curve-tile-slot">{index===a?'A':''}{index===b?'B':''}</span>}
      <svg viewBox={preset.viewBox} aria-hidden="true"><path d={preset.path}/></svg>
      <span className="curve-tile-name">{preset.name}</span>
    </button>)}
  </div>;
});

/** The same compiled morph and path serializer as the live site. Only the SVG
 * geometry and transport readout update on animation frames; the catalog stays still. */
export default function CurveDemo() {
  const [start] = useState(initial);
  const [pair,setPair] = useState({a:start.a,b:start.b});
  const [slot,setSlot] = useState<Endpoint>('a');
  const [anchors,setAnchors] = useState(false);
  const [endpoints,setEndpoints] = useState(false);
  const [playing,setPlaying] = useState(false);
  const [duration,setDuration] = useState(2400);
  const [loop,setLoop] = useState(false);
  const [staticMotion,setStaticMotion] = useState(()=>matchMedia(STATIC_MOTION_QUERY).matches);
  const [direction,setDirection] = useState<1|-1>(1);
  const [notice,setNotice] = useState('');
  const path = useRef<SVGPathElement>(null), dots = useRef<SVGGElement>(null), guides = useRef<SVGPathElement>(null);
  const scrubber = useRef<HTMLInputElement>(null), readout = useRef<HTMLOutputElement>(null);
  const progress = useRef(start.progress), directionRef = useRef<1|-1>(1);
  const persistTimer = useRef<number|undefined>(undefined);
  const nodes = useRef<FrameNodes>(presets[start.a].nodes);
  const animator = useMemo(()=>createFrameMorph(presets[pair.a].nodes,presets[pair.b].nodes),[pair]);

  const persist = useCallback(()=>{
    clearTimeout(persistTimer.current);
    const url = new URL(location.href);
    url.searchParams.set('a',presets[pair.a].id);url.searchParams.set('b',presets[pair.b].id);
    url.searchParams.set('t',progress.current.toFixed(3));
    if(url.href!==location.href)history.replaceState(history.state,'',url.pathname+url.search+url.hash);
  },[pair]);
  const deferPersist = useCallback(()=>{
    clearTimeout(persistTimer.current);persistTimer.current=window.setTimeout(persist,180);
  },[persist]);
  useEffect(()=>()=>clearTimeout(persistTimer.current),[persist]);
  const paint = useCallback((value:number)=>{
    const t=clamp(value);progress.current=t;nodes.current=animator(t);
    path.current?.setAttribute('d',framePath(nodes.current));
    guides.current?.setAttribute('d',frameGuidePath(nodes.current,1000,600));
    if(anchors&&dots.current)Array.from(dots.current.children).forEach((dot,i)=>{
      dot.setAttribute('cx',String(nodes.current[i].point.x));dot.setAttribute('cy',String(nodes.current[i].point.y));
    });
    if(scrubber.current){scrubber.current.value=String(t*1000);scrubber.current.setAttribute('aria-valuetext',`${(t*100).toFixed(1)} percent from ${presets[pair.a].name} to ${presets[pair.b].name}`);}
    if(readout.current)readout.current.textContent=`${(t*100).toFixed(1)}%`;
  },[animator,anchors,pair]);
  useLayoutEffect(()=>{paint(progress.current);persist();},[paint,persist]);
  useEffect(()=>{document.title='Curve study — gesso';},[]);
  useEffect(()=>{
    const query=matchMedia(STATIC_MOTION_QUERY);
    const update=()=>{setStaticMotion(query.matches);if(query.matches)setPlaying(false);};
    query.addEventListener('change',update);return()=>query.removeEventListener('change',update);
  },[]);
  useEffect(()=>{
    const pause=()=>{if(document.hidden){setPlaying(false);persist();}};
    document.addEventListener('visibilitychange',pause);return()=>document.removeEventListener('visibilitychange',pause);
  },[persist]);
  useEffect(()=>{
    if(!playing||staticMotion)return;
    let request=0,last=0;
    const tick=(now:number)=>{
      const elapsed=last?Math.min(now-last,100):0;last=now;
      const next=progress.current+elapsed/duration*directionRef.current;
      paint(next);
      if(elapsed>0&&(next>=1||next<=0)){
        if(loop){directionRef.current=directionRef.current===1?-1:1;setDirection(directionRef.current);}
        else {setPlaying(false);persist();return;}
      }
      request=requestAnimationFrame(tick);
    };
    request=requestAnimationFrame(tick);return()=>cancelAnimationFrame(request);
  },[playing,staticMotion,duration,loop,paint,persist]);
  const scrub=useCallback((t:number)=>{setPlaying(false);paint(t);deferPersist();},[paint,deferPersist]);
  const toggle=useCallback(()=>{
    if(staticMotion||pair.a===pair.b)return;
    if(!playing&&((directionRef.current===1&&progress.current===1)||(directionRef.current===-1&&progress.current===0)))paint(directionRef.current===1?0:1);
    if(playing)persist();setPlaying(value=>!value);
  },[staticMotion,pair,playing,paint,persist]);
  const reverse=useCallback(()=>{directionRef.current=directionRef.current===1?-1:1;setDirection(directionRef.current);},[]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.metaKey||event.ctrlKey||event.altKey||event.target instanceof HTMLElement&&event.target.closest('button,a,input,select,textarea'))return;
      if(event.code==='Space'){event.preventDefault();if(!event.repeat)toggle();}
      else if(event.key.toLowerCase()==='r'){event.preventDefault();if(!event.repeat)reverse();}
      else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();scrub(progress.current+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?.1:.01));}
      else if(event.key==='Home'){event.preventDefault();scrub(0);}
      else if(event.key==='End'){event.preventDefault();scrub(1);}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[toggle,reverse,scrub]);
  const choose=useCallback((index:number)=>{
    setPlaying(false);setNotice('');progress.current=0;
    setPair(prior=>({...prior,[slot]:index}));if(slot==='a')setSlot('b');
  },[slot]);
  const swap=()=>{setPlaying(false);progress.current=1-progress.current;setPair({a:pair.b,b:pair.a});};
  const save=()=>{
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600"><path d="${framePath(nodes.current)}" fill="#131313"/></svg>`;
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})),link=document.createElement('a');
    link.href=url;link.download=`gesso-${presets[pair.a].id}-${presets[pair.b].id}-${Math.round(progress.current*100)}.svg`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('SVG exported');
  };

  return <div className="curve-demo">
    <header className="curve-header">
      <a className="gesso-wordmark" href="/landing" aria-label="gesso home">gesso<span>studio</span></a>
      <h1>Curve study <span>design system</span></h1>
      <nav aria-label="Study navigation"><a href="/aperture">Form + light</a><a href="/?step=product&layer=model">Enter studio <span className="gesso-ui-icon gesso-export-arrow" aria-hidden="true"/></a><button onClick={save}><Icon name="download"/>Export SVG</button></nav>
    </header>
    <div className="curve-workspace">
      <aside className="curve-library" aria-label="Shape library">
        <div className="curve-library-heading"><h2>Shapes</h2><span>16</span></div>
        <p className="curve-instruction">Choose A, then B. Scrub between them.</p>
        <div className="curve-endpoint-picker" aria-label="Assign endpoints">
          {(['a','b'] as const).map(endpoint=><button key={endpoint} aria-pressed={slot===endpoint} onClick={()=>setSlot(endpoint)} title={`Choose a shape for ${endpoint.toUpperCase()}`}>
            <span className="curve-slot-label">{endpoint.toUpperCase()}</span><span>{presets[pair[endpoint]].name}</span>
            <svg viewBox={presets[pair[endpoint]].viewBox} aria-hidden="true"><path d={presets[pair[endpoint]].path}/></svg>
          </button>)}
          <button className="curve-swap" onClick={swap} aria-label="Swap A and B" title="Swap A and B"><Icon name="swap"/></button>
        </div>
        <div className="curve-selection-hint" aria-live="polite">Selecting <b>{slot.toUpperCase()}</b></div>
        <Catalog a={pair.a} b={pair.b} slot={slot} onChoose={choose}/>
        <div className="curve-library-footer"><span>64 anchors per shape</span><span>120 pairs · both directions</span></div>
      </aside>
      <main className="curve-main">
        <section className="curve-viewport" aria-label="Shape interpolation preview" tabIndex={0}>
          <div className="curve-viewport-toolbar"><span>{presets[pair.a].name} <span aria-hidden="true">→</span> {presets[pair.b].name}</span><div>
            <button aria-pressed={endpoints} onClick={()=>setEndpoints(!endpoints)}>Endpoints</button>
            <button aria-pressed={anchors} onClick={()=>setAnchors(!anchors)}>64 anchors</button>
          </div></div>
          <svg className="curve-specimen" viewBox="0 0 1000 600" role="img" aria-label={`64-anchor curve between ${presets[pair.a].name} and ${presets[pair.b].name}`}>
            <path ref={path} className="curve-live" d={framePath(animator(progress.current))}/>
            <path ref={guides} className="frame-boundary-guides" d={frameGuidePath(animator(progress.current),1000,600)} aria-hidden="true"/>
            {endpoints&&<g className="curve-endpoint-guides" aria-hidden="true"><path d={presets[pair.a].path}/><path d={presets[pair.b].path} strokeDasharray="4 5"/></g>}
            {anchors&&<g ref={dots} className="curve-anchor-guides" aria-hidden="true">{Array.from({length:64},(_,i)=><circle key={i} r="2.2"/>)}</g>}
          </svg>
          <div className="curve-viewport-footer"><span>One closed Bézier curve</span><span>1000 × 600</span></div>
        </section>
        <section className="curve-transport" aria-label="Interpolation controls">
          <div className="curve-playback"><button className="curve-play" onClick={toggle} disabled={staticMotion||pair.a===pair.b} aria-label={playing?'Pause transition':'Play transition'} title="Play / pause (Space)"><Icon name={playing?'pause':'play'}/>{playing?'Pause':'Play'}</button>
            <button className="curve-reverse" onClick={reverse} aria-label="Reverse playback direction" title="Reverse direction (R)"><Icon name="reverse"/><span>{direction===1?'A → B':'B → A'}</span></button></div>
          <div className="curve-scrub"><button onClick={()=>scrub(0)} title="Start (Home)" aria-label="Go to shape A">A</button><input ref={scrubber} aria-label="Interpolation" type="range" min="0" max="1000" step="1" defaultValue={start.progress*1000} onPointerUp={persist} onKeyUp={persist} onBlur={persist} onChange={event=>scrub(event.target.valueAsNumber/1000)}/><button onClick={()=>scrub(1)} title="End (End)" aria-label="Go to shape B">B</button><output ref={readout} aria-live="off">{(start.progress*100).toFixed(1)}%</output></div>
          <div className="curve-timing"><label>Duration<select aria-label="Transition duration" value={duration} onChange={event=>setDuration(Number(event.target.value))}><option value="1200">1.2 s</option><option value="2400">2.4 s</option><option value="4800">4.8 s</option></select></label><label className="curve-loop"><input type="checkbox" checked={loop} onChange={event=>setLoop(event.target.checked)}/>Loop</label></div>
        </section>
        <div className="curve-help"><span>{staticMotion?'Motion paused for this device or preference. Drag the slider to explore.':<>Space play / pause <span>← → scrub</span> R reverse</>}</span><span role="status">{notice||'Same geometry as the live frame'}</span></div>
      </main>
    </div>
  </div>;
}
