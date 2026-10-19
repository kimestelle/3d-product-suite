import {useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent} from 'react';
import lampRender from './assets/gesso/landing-nessino.png';
import {landingMorphNodes, type ApertureNode, type AperturePoint} from './landingMorph';
import {aperturePath, cloneApertureNodes, moveApertureAnchor, moveApertureHandle} from './apertureGeometry';
import {ApertureArtwork, apertureSvgMarkup, type ApertureAppearance} from './ApertureArtwork';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import './aperture-editor.css';

const STORAGE = 'gesso.aperture.v1';
type Study = {progress:number; custom:boolean; nodes:ApertureNode[]; appearance:ApertureAppearance};
type Handle = 'point'|'in'|'out';
type HandleMode = 'free'|'aligned'|'symmetric';
const DEFAULT_APPEARANCE:ApertureAppearance = {width:18,softness:22,strength:.7,separation:5,angle:32,tint:'#f9faf7',background:'#131313',interior:'empty'};
const defaults = ():Study => ({progress:0,custom:false,nodes:landingMorphNodes(0),appearance:{...DEFAULT_APPEARANCE}});
const finite = (value:unknown, fallback:number, min:number, max:number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min,Math.min(max,value)) : fallback;
function loadStudy(): {study:Study;saved:string;notice:string} {
  try {
    const raw=localStorage.getItem(STORAGE);
    if (!raw) return {study:defaults(),saved:'',notice:''};
    const data=JSON.parse(raw);
    if (data.version !== 1 || !data.study || typeof data.study.appearance !== 'object') throw new Error('Invalid preset');
    const value=data.study, a=value.appearance, d=DEFAULT_APPEARANCE;
    const color=(v:unknown,fallback:string)=>typeof v==='string'&&/^#[\da-f]{6}$/i.test(v)?v:fallback;
    const study:Study={progress:finite(value.progress,0,0,1),custom:!!value.custom,nodes:cloneApertureNodes(value.nodes),appearance:{
      width:finite(a.width,d.width,0,80),softness:finite(a.softness,d.softness,0,50),strength:finite(a.strength,d.strength,0,1),separation:finite(a.separation,d.separation,0,16),angle:finite(a.angle,d.angle,0,360),tint:color(a.tint,d.tint),background:color(a.background,d.background),interior:['empty','solid','scene'].includes(a.interior)?a.interior:d.interior,
    }};
    return {study,saved:JSON.stringify(study),notice:'Local preset restored'};
  } catch {return {study:defaults(),saved:'',notice:'The local preset could not be read. Defaults restored.'};}
}

function Slider({label,value,min,max,step=1,unit,onChange,onStart,onEnd}:{label:string;value:number;min:number;max:number;step?:number;unit:string;onChange:(n:number)=>void;onStart:()=>void;onEnd:()=>void}) {
  return <div className="aperture-slider">
    <NumberControl label={label} value={value} min={min} max={max} step={step} unit={unit} onChange={onChange}/>
    <input type="range" aria-label={`${label} slider`} min={min} max={max} step={step} value={value} style={{'--range-progress':`${(value-min)/(max-min)*100}%`} as CSSProperties} onPointerDown={onStart} onPointerUp={onEnd} onPointerCancel={onEnd} onBlur={onEnd} onChange={event=>onChange(Number(event.target.value))}/>
  </div>;
}

export default function ApertureEditor({embedded = false, active = true}: {embedded?:boolean; active?:boolean} = {}) {
  const Workspace = embedded ? 'div' : 'main';
  const Heading = embedded ? 'h3' : 'h1';
  const [initial]=useState(loadStudy);
  const [study,setStudy]=useState(initial.study);
  const current=useRef(study);
  const [saved,setSaved]=useState(initial.saved);
  const [notice,setNotice]=useState(initial.notice);
  const [guides,setGuides]=useState(false);
  const [zoom,setZoom]=useState({scale:1,x:500,y:300});
  const morphFrame=useRef(0);
  const morphTarget=useRef<{progress:number;nodes:ApertureNode[]}|null>(null);
  const motionPolicy=useRef<MediaQueryList|null>(null);
  const stopMorph=()=>{cancelAnimationFrame(morphFrame.current);morphFrame.current=0;morphTarget.current=null;};
  const finishMorph=()=>{
    const target=morphTarget.current;stopMorph();
    if(!target)return;
    const next={...current.current,progress:target.progress,custom:false,nodes:target.nodes};
    current.current=next;setStudy(next);
  };
  const [selected,setSelected]=useState(0);
  const [mode,setMode]=useState<HandleMode>('aligned');
  const [busy,setBusy]=useState(false);
  const [,setHistoryVersion]=useState(0);
  const past=useRef<Study[]>([]), future=useRef<Study[]>([]);
  const gesture=useRef<{before:Study;past:Study[];future:Study[];changed:boolean}|null>(null);
  const drag=useRef<{index:number;handle:Handle;pointer:number;target:SVGCircleElement}|null>(null);
  const svg=useRef<SVGSVGElement>(null);
  const id=useId().replace(/:/g,'');
  const path=aperturePath(study.nodes);
  const dirty=JSON.stringify(study)!==saved;
  const selectedNode=study.nodes[selected];
  const revision=()=>setHistoryVersion(v=>v+1);
  const record=()=>{past.current=[...past.current.slice(-39),current.current];future.current=[];revision();};
  const apply=(next:Study,keepHistory=true)=>{
    if(keepHistory)stopMorph();
    if(JSON.stringify(next)===JSON.stringify(current.current))return;
    if(keepHistory){if(!gesture.current)record();else if(!gesture.current.changed){record();gesture.current.changed=true;}}
    current.current=next;setStudy(next);setNotice('');
  };
  const begin=()=>{stopMorph();if(!gesture.current)gesture.current={before:current.current,past:past.current.slice(),future:future.current.slice(),changed:false};};
  const cancel=()=>{const active=gesture.current;if(active){gesture.current=null;past.current=active.past;future.current=active.future;current.current=active.before;setStudy(active.before);revision();}};
  const end=()=>{if(gesture.current&&JSON.stringify(current.current)===JSON.stringify(gesture.current.before))cancel();else gesture.current=null;};
  const undo=()=>{stopMorph();if(drag.current){finishDrag(true);return;}end();if(!past.current.length)return;future.current.push(current.current);const next=past.current.pop()!;current.current=next;setStudy(next);revision();setNotice('');};
  const redo=()=>{stopMorph();if(drag.current){finishDrag(true);return;}end();if(!future.current.length)return;past.current.push(current.current);const next=future.current.pop()!;current.current=next;setStudy(next);revision();setNotice('');};
  const appearance=<K extends keyof ApertureAppearance>(key:K,value:ApertureAppearance[K])=>apply({...current.current,appearance:{...current.current.appearance,[key]:value}});
  const morph=(progress:number)=>apply({...current.current,progress,custom:false,nodes:landingMorphNodes(progress)});
  const morphTo=(progress:number)=>{
    stopMorph();end();const from=current.current,target=landingMorphNodes(progress);
    if(!from.custom&&from.progress===progress)return;
    record();
    if((motionPolicy.current??matchMedia(STATIC_MOTION_QUERY)).matches||document.hidden||!active){apply({...from,progress,custom:false,nodes:target},false);return;}
    morphTarget.current={progress,nodes:target};
    const start=performance.now();
    const tick=(now:number)=>{
      const t=Math.min(1,(now-start)/260),amount=t*t*(3-2*t);
      const mix=(a:AperturePoint,b:AperturePoint)=>({x:a.x+(b.x-a.x)*amount,y:a.y+(b.y-a.y)*amount});
      const nodes=from.nodes.map((node,index)=>({point:mix(node.point,target[index].point),in:mix(node.in,target[index].in),out:mix(node.out,target[index].out)}));
      apply({...current.current,progress:from.progress+(progress-from.progress)*amount,custom:t<1,nodes},false);
      morphFrame.current=t<1?requestAnimationFrame(tick):0;
      if(t===1)morphTarget.current=null;
    };
    morphFrame.current=requestAnimationFrame(tick);
  };

  const save=()=>{try{localStorage.setItem(STORAGE,JSON.stringify({version:1,study:current.current}));setSaved(JSON.stringify(current.current));setNotice('Saved in this browser');}catch{setNotice('Couldn’t save locally. Export SVG to keep this shape.');}};
  const updatePoint=(index:number,handle:Handle,point:AperturePoint)=>{
    const nodes=handle==='point'?moveApertureAnchor(current.current.nodes,index,point):moveApertureHandle(current.current.nodes,index,handle,point,mode);
    apply({...current.current,nodes,custom:true});
  };
  const pointerPosition=(event:ReactPointerEvent):AperturePoint|null=>{
    const transform=svg.current?.getScreenCTM();if(!transform)return null;
    const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(transform.inverse());
    return {x:point.x,y:point.y};
  };
  const startDrag=(event:ReactPointerEvent<SVGCircleElement>,index:number,handle:Handle)=>{
    if(event.button!==0||drag.current)return;
    event.preventDefault();event.stopPropagation();setSelected(index);event.currentTarget.focus();begin();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current={index,handle,pointer:event.pointerId,target:event.currentTarget};
  };
  const finishDrag=(cancelled=false)=>{
    const active=drag.current;if(!active)return;drag.current=null;
    if(cancelled)cancel();else end();
    if(active.target.hasPointerCapture(active.pointer))active.target.releasePointerCapture(active.pointer);
  };
  useEffect(()=>{
    const previous=document.title;if(!embedded)document.title='Aperture — gesso';
    const preference=matchMedia(STATIC_MOTION_QUERY);motionPolicy.current=preference;
    const preferenceChanged=()=>{if(preference.matches)finishMorph();};
    const hide=()=>{if(document.hidden)finishMorph();};
    preference.addEventListener('change',preferenceChanged);
    document.addEventListener('visibilitychange',hide);
    return()=>{stopMorph();motionPolicy.current=null;preference.removeEventListener('change',preferenceChanged);document.removeEventListener('visibilitychange',hide);if(!embedded)document.title=previous;};
  },[embedded]);
  useEffect(()=>{if(!active)finishMorph();},[active]);
  useEffect(()=>{
    const release=()=>{if(!drag.current)end();};
    const blur=()=>{if(drag.current)finishDrag(true);else end();};
    window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);window.addEventListener('blur',blur);
    return()=>{window.removeEventListener('pointerup',release);window.removeEventListener('pointercancel',release);window.removeEventListener('blur',blur);};
  },[]);
  const exportSvg=async()=>{
    if(busy)return;setBusy(true);setNotice('Preparing SVG…');
    try{
      const snapshot=current.current;
      let image:string|undefined;
      if(snapshot.appearance.interior==='scene'){
        const response=await fetch(lampRender);if(!response.ok)throw new Error('Scene image unavailable');
        const blob=await response.blob();
        image=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Could not embed scene image'));reader.readAsDataURL(blob);});
      }
      const markup=apertureSvgMarkup(aperturePath(snapshot.nodes),snapshot.appearance,image);
      const url=URL.createObjectURL(new Blob([markup],{type:'image/svg+xml'}));
      const link=document.createElement('a');link.href=url;link.download='gesso-aperture.svg';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      setNotice('SVG exported · editable curve and halo');
    }catch(error){setNotice(`Export failed: ${error instanceof Error?error.message:'please try again'}`);}finally{setBusy(false);}
  };
  const axis=(key:'x'|'y',value:number)=>updatePoint(selected,'point',{...selectedNode.point,[key]:value});
  return <div className={`gesso-aperture-editor${embedded?' is-embedded':''}`} onKeyDown={event=>{
    if(event.key==='Escape'&&drag.current){event.preventDefault();finishDrag(true);return;}
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'&&!(event.target as Element).closest('input,select,textarea')){event.preventDefault();if(event.shiftKey)redo();else undo();}
  }}>
    <header className="aperture-header">
      {!embedded&&<a className="aperture-wordmark" href="/landing" aria-label="gesso home"><span/></a>}
      <Heading>{embedded?'live study':'aperture'} <span>/ form + light</span></Heading>
      <nav aria-label="Study navigation">{!embedded&&<a href="/about">about</a>}<button type="button" onClick={exportSvg} disabled={busy}>{busy&&<UiIcon name="loader"/>}{busy?'preparing…':'export SVG'}</button></nav>
    </header>
    <Workspace className="aperture-workspace">
      <section className="aperture-specimen" aria-label="Vector and halo canvas" style={{background:study.appearance.background}}>
        <div className="aperture-canvas-toolbar"><span>{study.custom?'custom contour':study.progress===0?'rounded X':study.progress===.5?'circle':study.progress===1?'window':'morph'}<small>64 points</small></span><div className="aperture-canvas-actions"><select aria-label="Canvas zoom" value={zoom.scale} onChange={event=>setZoom({scale:Number(event.target.value),x:guides?selectedNode.point.x:500,y:guides?selectedNode.point.y:300})}><option value="1">fit</option><option value="2">2×</option><option value="4">4×</option></select><button type="button" aria-pressed={guides} onClick={()=>setGuides(!guides)}>edit points</button></div></div>
        <svg ref={svg} className="aperture-canvas" viewBox={`${zoom.x-640/zoom.scale} ${zoom.y-440/zoom.scale} ${1280/zoom.scale} ${880/zoom.scale}`} role={guides?'group':'img'} aria-label="Editable Bézier aperture" onPointerMove={event=>{const active=drag.current;if(!active||active.pointer!==event.pointerId)return;const point=pointerPosition(event);if(point)updatePoint(active.index,active.handle,point);}} onPointerUp={event=>{if(drag.current?.pointer===event.pointerId)finishDrag();}} onPointerCancel={event=>{if(drag.current?.pointer===event.pointerId)finishDrag(true);}} onLostPointerCapture={event=>{if(drag.current?.pointer===event.pointerId)finishDrag(true);}}>
          <ApertureArtwork id={id} path={path} settings={study.appearance} sceneHref={lampRender}/>
          {guides&&<g className="aperture-guides">
            <path d={path} fill="none" stroke="#ababab" strokeWidth=".7" vectorEffect="non-scaling-stroke"/>
            {(['in','out'] as const).map(handle=><g key={handle}><line x1={selectedNode.point.x} y1={selectedNode.point.y} x2={selectedNode[handle].x} y2={selectedNode[handle].y} stroke="#aaa" strokeWidth="1" vectorEffect="non-scaling-stroke"/><circle role="button" tabIndex={0} aria-label={`${handle==='in'?'Incoming':'Outgoing'} handle for point ${selected+1}`} cx={selectedNode[handle].x} cy={selectedNode[handle].y} r="5" className="aperture-handle" onPointerDown={event=>startDrag(event,selected,handle)} onKeyDown={event=>{const delta=event.shiftKey?10:1;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const p=selectedNode[handle];updatePoint(selected,handle,{x:p.x+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0),y:p.y+(event.key==='ArrowDown'?delta:event.key==='ArrowUp'?-delta:0)});}}}/></g>)}
            {study.nodes.map((node,index)=><circle key={index} role="button" tabIndex={index===selected?0:-1} aria-label={`Point ${index+1}`} aria-pressed={selected===index} cx={node.point.x} cy={node.point.y} r={selected===index?6:3.5} className={`aperture-anchor ${selected===index?'selected':''}`} onPointerDown={event=>startDrag(event,index,'point')} onKeyDown={event=>{const delta=event.shiftKey?10:1;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();updatePoint(index,'point',{x:node.point.x+(event.key==='ArrowRight'?delta:event.key==='ArrowLeft'?-delta:0),y:node.point.y+(event.key==='ArrowDown'?delta:event.key==='ArrowUp'?-delta:0)});}}}/>) }
          </g>}
        </svg>
        {guides?<div className="aperture-point-editor" aria-label="Selected point">
          <label>point<select aria-label="Selected point" value={selected} onChange={event=>setSelected(Number(event.target.value))}>{study.nodes.map((_,i)=><option key={i} value={i}>{String(i+1).padStart(2,'0')}</option>)}</select></label>
          {(['x','y'] as const).map(key=><label key={key}>{key}<input aria-label={`Point ${key.toUpperCase()}`} type="number" min="0" max={key==='x'?1000:600} step="1" value={Number(selectedNode.point[key].toFixed(1))} onChange={event=>{if(event.target.value!==''&&Number.isFinite(event.target.valueAsNumber))axis(key,event.target.valueAsNumber);}}/></label>)}
          <label>handles<select aria-label="Handle behavior" value={mode} onChange={event=>setMode(event.target.value as HandleMode)}><option value="aligned">aligned</option><option value="symmetric">mirrored</option><option value="free">free</option></select></label>
        </div>:<p className="aperture-canvas-note">One curve. Light at its edge.</p>}
        {guides&&<p className="aperture-canvas-note is-editing">Drag points + handles · arrows nudge · Shift ×10 · Esc cancels</p>}
      </section>
      <aside className="aperture-controls" aria-label="Shape and halo controls">
        <div className="aperture-control-body">
          <section className="aperture-control-section"><h2>shape</h2><div className="aperture-presets">{[{name:'X',value:0},{name:'circle',value:.5},{name:'window',value:1}].map(preset=><button key={preset.name} type="button" aria-pressed={!study.custom&&study.progress===preset.value} onClick={()=>morphTo(preset.value)}>{!study.custom&&study.progress===preset.value&&<UiIcon name="check"/>}{preset.name}</button>)}</div>
            <Slider label="morph" value={study.progress*100} min={0} max={100} unit="%" onChange={value=>morph(value/100)} onStart={begin} onEnd={end}/>
          </section>
          <section className="aperture-control-section"><h2>halo</h2>
            <Slider label="width" value={study.appearance.width} min={0} max={80} unit="px" onChange={value=>appearance('width',value)} onStart={begin} onEnd={end}/>
            <Slider label="softness" value={study.appearance.softness} min={0} max={50} unit="px" onChange={value=>appearance('softness',value)} onStart={begin} onEnd={end}/>
            <Slider label="strength" value={Math.round(study.appearance.strength*100)} min={0} max={100} unit="%" onChange={value=>appearance('strength',value/100)} onStart={begin} onEnd={end}/>
          </section>
          <section className="aperture-control-section"><h2>chromatic aberration</h2>
            <Slider label="separation" value={study.appearance.separation} min={0} max={16} step={.25} unit="px" onChange={value=>appearance('separation',value)} onStart={begin} onEnd={end}/>
            <Slider label="direction" value={study.appearance.angle} min={0} max={360} unit="°" onChange={value=>appearance('angle',value)} onStart={begin} onEnd={end}/>
            <label className="aperture-tint"><span>light tint</span><input aria-label="Light tint" type="color" value={study.appearance.tint} onPointerDown={begin} onBlur={end} onChange={event=>appearance('tint',event.target.value)}/><output>{study.appearance.tint}</output></label>
          </section>
          <section className="aperture-control-section aperture-view"><h2>surface</h2><div className="aperture-presets">{[{name:'ink',color:'#131313'},{name:'chalk',color:'#f9faf7'},{name:'red',color:'#980101'}].map(surface=><button key={surface.name} type="button" aria-pressed={study.appearance.background===surface.color} onClick={()=>appearance('background',surface.color)}><i style={{background:surface.color}}/>{surface.name}</button>)}</div><label className="aperture-select"><span>opening</span><select aria-label="Opening content" value={study.appearance.interior} onChange={event=>appearance('interior',event.target.value as ApertureAppearance['interior'])}><option value="empty">empty</option><option value="solid">solid tint</option><option value="scene">lamp render</option></select></label></section>
        </div>
        <footer className="aperture-control-footer"><div className="aperture-history"><button onClick={undo} disabled={!past.current.length}>undo</button><button onClick={redo} disabled={!future.current.length}>redo</button><button onClick={()=>{apply(defaults());setSelected(0);}}>reset</button></div><button className="aperture-save" onClick={save} disabled={!dirty}>{!dirty&&<UiIcon name="unavailable"/>}{dirty?'save preset':'saved locally'}</button><p role="status">{notice||(dirty?'Changes stay in this study until you save.':'Preset saved in this browser.')}</p></footer>
      </aside>
    </Workspace>
  </div>;
}
