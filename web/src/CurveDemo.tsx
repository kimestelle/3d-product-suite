import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import {CURVE_PRESETS} from './curvePresets';
import {frameBounds, framePath, type FrameNodes} from './frameGeometry';
import {frameGuidePaths} from './frameGuides';
import {advancePatternProgress, compileCurvePattern, MAX_CURVE_PATTERN_LENGTH, readCurvePattern, reorderPattern, type CurvePatternState} from './curvePattern';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import './curve-demo.css';

const clamp = (n:number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const presets = CURVE_PRESETS.map((preset, index) => {
  const bounds = frameBounds(preset.nodes), inset = Math.max(bounds.width, bounds.height) * .12;
  return {...preset, index, path:framePath(preset.nodes), viewBox:`${bounds.left-inset} ${bounds.top-inset} ${bounds.width+inset*2} ${bounds.height+inset*2}`};
});
const byId = new Map(presets.map(preset=>[preset.id,preset]));
const number = (index:number) => String(index+1).padStart(2,'0');
const stepAtStart = ({ids,progress,loop}:CurvePatternState) => Math.floor(progress*(loop?ids.length:ids.length-1)) % ids.length;
type Step = {key:number;id:string};
function Icon({name}:{name:'play'|'pause'|'reverse'|'download'|'left'|'right'}) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name==='play'?<path d="m8 5 11 7-11 7z"/>:name==='pause'?<path d="M8 5v14M16 5v14"/>:name==='reverse'?<><path d="M3 10h11a6 6 0 0 1 0 12M8 5l-5 5 5 5"/></>:name==='left'?<path d="M20 12H4m6-6-6 6 6 6"/>:name==='right'?<path d="M4 12h16m-6-6 6 6-6 6"/>:<><path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/></>}
  </svg>;
}

const Catalog = memo(function Catalog({ids,selected,replacing,full,onChoose}:{ids:readonly string[];selected:string;replacing:boolean;full:boolean;onChoose:(id:string)=>void}) {
  const buttons = useRef<(HTMLButtonElement|null)[]>([]);
  return <div className="curve-catalog" aria-label="Shape catalog">
    {presets.map((preset,index)=>{
      const count=ids.filter(id=>id===preset.id).length;
      return <button key={preset.id} ref={node=>{buttons.current[index]=node;}}
        type="button" disabled={full&&!replacing}
        aria-label={`${replacing?'Replace selected step with':'Add'} ${preset.name}`}
        aria-pressed={selected===preset.id} title={`${preset.name} · ${preset.family}`}
        onClick={()=>onChoose(preset.id)} onKeyDown={event=>{
          const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-4,ArrowDown:4}[event.key];
          if(delta===undefined)return;
          event.preventDefault();buttons.current[Math.max(0,Math.min(presets.length-1,index+delta))]?.focus();
        }}>
        <span className="curve-tile-number">{number(index)}</span>
        {count>0&&<span className="curve-tile-slot">{count}×</span>}
        <svg viewBox={preset.viewBox} aria-hidden="true"><path d={preset.path}/></svg>
        <span className="curve-tile-name">{preset.name}</span>
      </button>;
    })}
  </div>;
});

/** Reuse the production transition, including its 30% size envelope. Animation
 * updates SVG/readouts directly; the catalog and pattern do not rerender per frame. */
export default function CurveDemo() {
  const [start] = useState(()=>readCurvePattern(location.search));
  const serial = useRef(start.ids.length);
  const [steps,setSteps] = useState<Step[]>(()=>start.ids.map((id,key)=>({id,key})));
  const [selected,setSelected] = useState(()=>stepAtStart(start));
  const [replacing,setReplacing] = useState(false);
  const [anchors,setAnchors] = useState(false);
  const [endpoints,setEndpoints] = useState(false);
  const [playing,setPlaying] = useState(false);
  const [duration,setDuration] = useState(start.duration);
  const [loop,setLoop] = useState(start.loop);
  const [staticMotion,setStaticMotion] = useState(()=>matchMedia(STATIC_MOTION_QUERY).matches);
  const [direction,setDirection] = useState<1|-1>(1);
  const [notice,setNotice] = useState('');
  const [dropTarget,setDropTarget] = useState<number|null>(null);
  const path=useRef<SVGPathElement>(null), dots=useRef<SVGGElement>(null), guides=useRef<SVGPathElement>(null), guideCrosses=useRef<SVGPathElement>(null);
  const endpointA=useRef<SVGPathElement>(null), endpointB=useRef<SVGPathElement>(null), specimen=useRef<SVGSVGElement>(null);
  const scrubber=useRef<HTMLInputElement>(null), readout=useRef<HTMLOutputElement>(null), pairLabel=useRef<HTMLSpanElement>(null);
  const marker=useRef<HTMLSpanElement>(null), row=useRef<HTMLOListElement>(null), stepButtons=useRef(new Map<number,HTMLButtonElement>());
  const progress=useRef(start.progress), directionRef=useRef<1|-1>(1), dragKey=useRef<number|null>(null);
  const persistTimer=useRef<number|undefined>(undefined);
  const nodes=useRef<FrameNodes>(byId.get(start.ids[0])!.nodes);
  const ids=useMemo(()=>steps.map(step=>step.id),[steps]);
  const animator=useMemo(()=>compileCurvePattern(ids,loop),[ids,loop]);
  const selectedIndex=Math.max(0,steps.findIndex(step=>step.key===selected));
  const selectedStep=steps[selectedIndex];
  const displayCount=steps.length+(loop&&steps.length>1?1:0);

  const persist=useCallback(()=>{
    clearTimeout(persistTimer.current);
    const url=new URL(location.href);
    url.searchParams.delete('a');url.searchParams.delete('b');
    url.searchParams.set('pattern',ids.join(','));url.searchParams.set('t',String(progress.current));
    url.searchParams.set('duration',String(duration));url.searchParams.set('loop',loop?'1':'0');
    if(url.href!==location.href)history.replaceState(history.state,'',url.pathname+url.search+url.hash);
  },[ids,duration,loop]);
  const deferPersist=useCallback(()=>{
    clearTimeout(persistTimer.current);persistTimer.current=window.setTimeout(persist,180);
  },[persist]);
  useEffect(()=>()=>clearTimeout(persistTimer.current),[]);
  const paint=useCallback((value:number)=>{
    const t=clamp(value),sample=animator.sample(t);progress.current=t;nodes.current=sample.nodes;
    path.current?.setAttribute('d',framePath(sample.nodes));
    const guidePaths=frameGuidePaths(sample.nodes,1000,600);
    guides.current?.setAttribute('d',guidePaths.lines);guideCrosses.current?.setAttribute('d',guidePaths.crosses);
    if(anchors&&dots.current)Array.from(dots.current.children).forEach((dot,i)=>{
      dot.setAttribute('cx',String(sample.nodes[i].point.x));dot.setAttribute('cy',String(sample.nodes[i].point.y));
    });
    const a=byId.get(ids[sample.from])!,b=byId.get(ids[sample.to])!;
    endpointA.current?.setAttribute('d',a.path);endpointB.current?.setAttribute('d',b.path);
    const pair=sample.from===sample.to?`${number(sample.from)} ${a.name}`:`${number(sample.from)} ${a.name} → ${number(sample.to)} ${b.name}`;
    if(pairLabel.current)pairLabel.current.textContent=pair;
    specimen.current?.setAttribute('aria-label',`Pattern preview: ${pair}`);
    if(scrubber.current){scrubber.current.value=String(t*1000);scrubber.current.setAttribute('aria-valuetext',`${pair}, ${Math.round(sample.localProgress*100)} percent`);}
    if(readout.current)readout.current.textContent=`${(t*animator.legs*duration/1000).toFixed(1)} / ${(animator.legs*duration/1000).toFixed(1)} s`;
    if(marker.current)marker.current.style.left=`calc((100% + 16px) * ${(t*animator.legs+.5)/displayCount} - 8px)`;
    const current=t===1?(loop?displayCount-1:ids.length-1):sample.from;
    if(row.current)Array.from(row.current.children).forEach((child,i)=>{
      const active=i===current;if(child.hasAttribute('data-current')!==active)child.toggleAttribute('data-current',active);
    });
  },[animator,anchors,ids,duration,loop,displayCount]);
  useLayoutEffect(()=>{paint(progress.current);persist();},[paint,persist,endpoints]);
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
    const restore=()=>{
      const state=readCurvePattern(location.search),next=state.ids.map(id=>({id,key:serial.current++}));
      setPlaying(false);setReplacing(false);progress.current=state.progress;setSteps(next);setSelected(next[stepAtStart(state)].key);
      setDuration(state.duration);setLoop(state.loop);
    };
    window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);
  },[]);
  useEffect(()=>{
    if(!playing||staticMotion)return;
    let request=0,last:number|undefined;
    const tick=(now:number)=>{
      const elapsed=last===undefined?0:Math.min(now-last,100);last=now;
      const next=advancePatternProgress(progress.current,elapsed,duration,animator.legs,directionRef.current,loop);
      paint(next.progress);
      if(next.done){setPlaying(false);persist();return;}
      request=requestAnimationFrame(tick);
    };
    request=requestAnimationFrame(tick);return()=>cancelAnimationFrame(request);
  },[playing,staticMotion,duration,loop,animator,paint,persist]);
  const scrub=useCallback((t:number)=>{setPlaying(false);paint(t);deferPersist();},[paint,deferPersist]);
  const toggle=useCallback(()=>{
    if(staticMotion||animator.legs===0)return;
    if(!playing&&((directionRef.current===1&&progress.current===1)||(directionRef.current===-1&&progress.current===0)))paint(directionRef.current===1?0:1);
    if(playing)persist();setPlaying(value=>!value);
  },[staticMotion,animator,playing,paint,persist]);
  const reverse=useCallback(()=>{directionRef.current=directionRef.current===1?-1:1;setDirection(directionRef.current);},[]);
  const focusStep=(key:number)=>requestAnimationFrame(()=>stepButtons.current.get(key)?.focus());
  const revealStep=(key:number)=>requestAnimationFrame(()=>stepButtons.current.get(key)?.scrollIntoView({block:'nearest',inline:'nearest'}));
  const updateSteps=useCallback((next:Step[],key:number,message:string)=>{
    const index=Math.max(0,next.findIndex(step=>step.key===key)),legs=next.length>1?(loop?next.length:next.length-1):0;
    setPlaying(false);setReplacing(false);setDropTarget(null);progress.current=legs?index/legs:0;
    setSteps(next);setSelected(key);setNotice(message);
  },[loop]);
  const choose=useCallback((id:string)=>{
    if(replacing){
      updateSteps(steps.map(step=>step.key===selectedStep.key?{...step,id}:step),selectedStep.key,`Step ${number(selectedIndex)} changed to ${byId.get(id)!.name}`);
      focusStep(selectedStep.key);
    }else if(steps.length<MAX_CURVE_PATTERN_LENGTH){
      const next={key:serial.current++,id};updateSteps([...steps,next],next.key,`${byId.get(id)!.name} added`);revealStep(next.key);
    }
  },[steps,replacing,selectedStep,selectedIndex,updateSteps]);
  const seekStep=(index:number)=>{
    setSelected(steps[index].key);setReplacing(false);scrub(animator.legs?index/animator.legs:0);
  };
  const move=(from:number,to:number)=>{
    if(to<0||to>=steps.length||from===to)return;
    const next=reorderPattern(steps,from,to),item=steps[from];
    updateSteps(next,item.key,`${byId.get(item.id)!.name} moved to step ${number(to)}`);focusStep(item.key);
  };
  const duplicate=()=>{
    if(steps.length>=MAX_CURVE_PATTERN_LENGTH)return;
    const item={...selectedStep,key:serial.current++},next=[...steps];next.splice(selectedIndex+1,0,item);
    updateSteps(next,item.key,`Step ${number(selectedIndex)} duplicated`);focusStep(item.key);
  };
  const remove=()=>{
    if(steps.length===1)return;
    const next=steps.filter(step=>step.key!==selectedStep.key),key=next[Math.min(selectedIndex,next.length-1)].key;
    updateSteps(next,key,`Step ${number(selectedIndex)} removed`);focusStep(key);
  };
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){setReplacing(false);return;}
      if(event.metaKey||event.ctrlKey||event.altKey||event.target instanceof HTMLElement&&event.target.closest('button,a,input,select,textarea'))return;
      if(event.code==='Space'){event.preventDefault();if(!event.repeat)toggle();}
      else if(event.key.toLowerCase()==='r'){event.preventDefault();if(!event.repeat)reverse();}
      else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();scrub(progress.current+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?.1:.01));}
      else if(event.key==='Home'){event.preventDefault();scrub(0);}
      else if(event.key==='End'){event.preventDefault();scrub(1);}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[toggle,reverse,scrub]);
  const changeLoop=(next:boolean)=>{
    setPlaying(false);
    const absolute=loop&&progress.current===1?0:progress.current*animator.legs,newLegs=steps.length>1?(next?steps.length:steps.length-1):0;
    progress.current=newLegs?clamp(absolute/newLegs):0;setLoop(next);
  };
  const save=()=>{
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600"><path d="${framePath(nodes.current)}" fill="#131313"/></svg>`;
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})),link=document.createElement('a');
    link.href=url;link.download=`gesso-pattern-${Math.round(progress.current*100)}.svg`;
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
        <p className="curve-instruction">{replacing?`Choose a shape to replace step ${number(selectedIndex)}.`:'Click a shape to add it to the pattern below.'}</p>
        {replacing&&<button className="curve-cancel-replace" onClick={()=>setReplacing(false)}>Cancel replacement</button>}
        <Catalog ids={ids} selected={selectedStep.id} replacing={replacing} full={steps.length>=MAX_CURVE_PATTERN_LENGTH} onChoose={choose}/>
        <div className="curve-library-footer"><span>64 anchors per shape</span><span>30% smaller between shapes</span></div>
      </aside>
      <main className="curve-main">
        <section className="curve-viewport" aria-label="Shape interpolation preview" tabIndex={0}>
          <div className="curve-viewport-toolbar"><span ref={pairLabel}/><div>
            <button aria-pressed={endpoints} onClick={()=>setEndpoints(!endpoints)}>Endpoints</button>
            <button aria-pressed={anchors} onClick={()=>setAnchors(!anchors)}>64 anchors</button>
          </div></div>
          <svg ref={specimen} className="curve-specimen" viewBox="0 0 1000 600" role="img" aria-label="Pattern preview">
            <path ref={path} className="curve-live" d={framePath(animator.sample(progress.current).nodes)}/>
            <path ref={guides} className="frame-boundary-guides" aria-hidden="true"/>
            <path ref={guideCrosses} className="frame-boundary-crosses" aria-hidden="true"/>
            {endpoints&&<g className="curve-endpoint-guides" aria-hidden="true"><path ref={endpointA}/><path ref={endpointB} strokeDasharray="4 5"/></g>}
            {anchors&&<g ref={dots} className="curve-anchor-guides" aria-hidden="true">{Array.from({length:64},(_,i)=><circle key={i} r="2.2"/>)}</g>}
          </svg>
          <div className="curve-viewport-footer"><span>One closed Bézier curve</span><span>1000 × 600</span></div>
        </section>
        <section className="curve-pattern" aria-labelledby="curve-pattern-heading">
          <div className="curve-pattern-heading"><h2 id="curve-pattern-heading">Pattern <span>{steps.length} shapes</span></h2><span className="curve-pattern-rule"/><span>30% shrink</span></div>
          <div className="curve-pattern-tools"><span>Step {number(selectedIndex)} · {byId.get(selectedStep.id)!.name}</span><div>
            <button aria-label="Move selected step earlier" title="Move earlier (Alt + ← on a step)" disabled={selectedIndex===0} onClick={()=>move(selectedIndex,selectedIndex-1)}><Icon name="left"/></button>
            <button aria-label="Move selected step later" title="Move later (Alt + → on a step)" disabled={selectedIndex===steps.length-1} onClick={()=>move(selectedIndex,selectedIndex+1)}><Icon name="right"/></button>
            <button aria-pressed={replacing} onClick={()=>setReplacing(!replacing)}>Replace</button>
            <button disabled={steps.length>=MAX_CURVE_PATTERN_LENGTH} onClick={duplicate}>Duplicate</button>
            <button disabled={steps.length===1} onClick={remove}>Remove</button>
          </div></div>
          <div className="curve-pattern-scroll">
            <div className="curve-pattern-track" style={{'--pattern-count':displayCount} as CSSProperties}>
              <ol ref={row} className="curve-pattern-steps" aria-label="Pattern sequence">
                {steps.map((step,index)=>{const preset=byId.get(step.id)!;return <li key={step.key} draggable
                  className={dropTarget===index?'is-drop-target':''}
                  onDragStart={event=>{dragKey.current=step.key;setPlaying(false);persist();event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-gesso-curve-step',String(step.key));}}
                  onDragOver={event=>{if(dragKey.current!==null){event.preventDefault();event.dataTransfer.dropEffect='move';setDropTarget(index);}}}
                  onDrop={event=>{event.preventDefault();const from=steps.findIndex(item=>item.key===dragKey.current);dragKey.current=null;setDropTarget(null);if(from>=0)move(from,index);}}
                  onDragEnd={()=>{dragKey.current=null;setDropTarget(null);}}>
                  <button type="button" ref={node=>{if(node)stepButtons.current.set(step.key,node);else stepButtons.current.delete(step.key);}}
                    aria-label={`Step ${number(index)}: ${preset.name}`} aria-pressed={selected===step.key} onClick={()=>seekStep(index)}
                    onKeyDown={event=>{
                      if(event.altKey&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){event.preventDefault();move(index,index+(event.key==='ArrowLeft'?-1:1));}
                      else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();focusStep(steps[Math.max(0,Math.min(steps.length-1,index+(event.key==='ArrowLeft'?-1:1)))].key);}
                      else if(event.key==='Escape')setReplacing(false);
                    }}>
                    <span className="curve-step-number">{number(index)}</span><svg viewBox={preset.viewBox} aria-hidden="true"><path d={preset.path}/></svg><span>{preset.name}</span>
                  </button>
                </li>;})}
                {loop&&steps.length>1&&<li className="curve-loop-step"><button aria-label="Return to first shape" onClick={()=>{setSelected(steps[0].key);scrub(1);}}><span className="curve-step-number">↩ 01</span><svg viewBox={byId.get(ids[0])!.viewBox} aria-hidden="true"><path d={byId.get(ids[0])!.path}/></svg><span>return</span></button></li>}
              </ol>
              <span ref={marker} className="curve-pattern-marker" aria-hidden="true"/>
            </div>
          </div>
        </section>
        <section className="curve-transport" aria-label="Pattern playback">
          <div className="curve-playback"><button className="curve-play" onClick={toggle} disabled={staticMotion||animator.legs===0} aria-label={playing?'Pause pattern':'Play pattern'} title="Play / pause (Space)"><Icon name={playing?'pause':'play'}/>{playing?'Pause':'Play'}</button>
            <button className="curve-reverse" onClick={reverse} aria-label="Reverse playback direction" title="Reverse direction (R)"><Icon name="reverse"/><span>{direction===1?'Forward':'Reverse'}</span></button></div>
          <div className="curve-scrub"><button onClick={()=>scrub(0)} title="Start (Home)" aria-label="Go to pattern start">01</button><input ref={scrubber} aria-label="Pattern progress" type="range" min="0" max="1000" step="1" disabled={animator.legs===0} defaultValue={start.progress*1000} onPointerUp={persist} onKeyUp={persist} onBlur={persist} onChange={event=>scrub(event.target.valueAsNumber/1000)}/><button onClick={()=>scrub(1)} title="End (End)" aria-label="Go to pattern end">{loop?'↩':number(steps.length-1)}</button><output ref={readout} aria-live="off"/></div>
          <div className="curve-timing"><label>Per transition<select aria-label="Transition duration" value={duration} onChange={event=>{setPlaying(false);setDuration(Number(event.target.value));}}><option value="1200">1.2 s</option><option value="2400">2.4 s</option><option value="4800">4.8 s</option></select></label><label className="curve-loop"><input type="checkbox" checked={loop} onChange={event=>changeLoop(event.target.checked)}/>Loop</label></div>
        </section>
        <div className="curve-help"><span>{staticMotion?'Motion paused for this device or preference. Scrub to explore.':'Drag steps to reorder · Space play / pause · R reverse'}</span><span role="status">{notice||'Pattern saved in the URL'}</span></div>
      </main>
    </div>
  </div>;
}
