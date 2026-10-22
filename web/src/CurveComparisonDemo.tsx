import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {CURVE_PRESETS} from './curvePresets';
import {framePath} from './frameGeometry';
import {compileCurveComparison,type ComparisonMethod} from './curveComparison';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import {DEFAULT_PRODUCT_SETTINGS,readProductSettings,serializeProductSettings,updateProductSettings,type ProductViewMode,type ProductViewSettings} from './curveProductSettings';
import type {CurveProductRenderer} from './curveProductRenderer';
import type {CurveProduct} from './curveProductAsset';
import './curve-demo.css';
import './curve-comparison.css';

const PAIRS=[
  {id:'rectangle-star',name:'rectangle → star',from:'studio-landing',to:'symbols-star',action:'Watch the sides draw inward as the points emerge.'},
  {id:'star-plus',name:'star → plus',from:'symbols-star',to:'symbols-plus',action:'Watch the diagonal tips recede as the four arms widen.'},
] as const;
const METHODS:{id:ComparisonMethod;name:string;note:string}[]=[
  {id:'current',name:'Current',note:'The shared production morph.'},
  {id:'sdf',name:'Distance field',note:'Blend the occupied space, then smooth the intermediate outline.'},
  {id:'radial',name:'Radial smoothing',note:'Blend the outline’s radii, then soften small bends in the middle.'},
];
const CHECKPOINTS=[0,.25,.5,.75,1];
type PairId=typeof PAIRS[number]['id'];
type View='all'|ComparisonMethod;
type Compiled=ReturnType<typeof compileCurveComparison>;
const cache=new Map<PairId,Compiled>();
const preset=(id:string)=>CURVE_PRESETS.find(item=>item.id===id)!.nodes;
const clamp=(value:number)=>Number.isFinite(value)?Math.max(0,Math.min(1,value)):0;
const ease=(value:number)=>value*value*(3-2*value);
function readState(){
  const params=new URLSearchParams(location.search),pair=params.get('pair'),view=params.get('view'),duration=Number(params.get('duration'));
  return {pair:PAIRS.some(item=>item.id===pair)?pair as PairId:'rectangle-star' as PairId,
    view:view==='current'||view==='sdf'||view==='all'?view:'radial' as View,
    progress:params.has('t')?clamp(Number(params.get('t'))):.5,
    duration:[1200,2400,4800].includes(duration)?duration:2400,repeat:params.get('repeat')!=='0',objects:readProductSettings(params.get('object'),params.get('fx')),product:params.get('content')!=='shape',angle:Math.max(-180,Math.min(180,Number(params.get('angle'))||0))};
}
function Glyph({name}:{name:'play'|'pause'|'back'|'reverse'}){
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name==='play'?<path d="m8 5 11 7-11 7z"/>:name==='pause'?<path d="M8 5v14M16 5v14"/>:name==='back'?<path d="M20 12H4m6-6-6 6 6 6"/>:<><path d="M3 8h13a5 5 0 0 1 0 10H3m5-15L3 8l5 5"/></>}
  </svg>;
}

/** A separate comparison surface: experimental paths never change page frames.
 * One clock paints all three SVGs, retaining their common coordinates and scale. */
export default function CurveComparison(){
  const [initial]=useState(readState);
  const [pairId,setPairId]=useState<PairId>(initial.pair),[view,setView]=useState<View>(initial.view);
  const [duration,setDuration]=useState(initial.duration),[repeat,setRepeat]=useState(initial.repeat);
  const [playing,setPlaying]=useState(false),[direction,setDirection]=useState<1|-1>(1);
  const [objects,setObjects]=useState(initial.objects),[activeObject,setActiveObject]=useState<ComparisonMethod>(initial.view==='all'?'current':initial.view);
  const [showProduct,setShowProduct]=useState(initial.product),[productState,setProductState]=useState<'loading'|'ready'|'error'>('loading'),[productRetry,setProductRetry]=useState(0);
  const [productInfo,setProductInfo]=useState<Omit<CurveProduct,'root'>|null>(null),[productError,setProductError]=useState('');
  const [angle,setAngle]=useState(initial.angle),[drawRevision,setDrawRevision]=useState(0);
  const renderer=useRef<CurveProductRenderer|null>(null),canvases=useRef(new Map<ComparisonMethod,HTMLCanvasElement>());
  const turn=useRef<{id:number;x:number;angle:number}|null>(null);
  const selectedObject=objects[activeObject],activeMethod=METHODS.find(method=>method.id===activeObject)!;
  const editObject=(patch:Partial<ProductViewSettings>)=>{setShowProduct(true);setPlaying(false);setObjects(value=>updateProductSettings(value,activeObject,patch));};
  const selectObject=(method:ComparisonMethod)=>{setActiveObject(method);};
  const chooseView=(next:View)=>{setView(next);if(next!=='all')selectObject(next);};
  const [endpoints,setEndpoints]=useState(false),[anchors,setAnchors]=useState(false);
  const [compiled,setCompiled]=useState<{id:PairId;value:Compiled}|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const [staticMotion,setStaticMotion]=useState(()=>matchMedia(STATIC_MOTION_QUERY).matches);
  const progress=useRef(initial.progress),directionRef=useRef<1|-1>(1),persistTimer=useRef<number|undefined>(undefined);
  const paths=useRef(new Map<ComparisonMethod,SVGPathElement>()),dots=useRef(new Map<ComparisonMethod,SVGGElement>());
  const slider=useRef<HTMLInputElement>(null),percent=useRef<HTMLOutputElement>(null),time=useRef<HTMLOutputElement>(null);
  const checkpointButtons=useRef(new Map<number,HTMLButtonElement>()),stage=useRef<HTMLElement>(null);
  const pair=PAIRS.find(item=>item.id===pairId)!,ready=compiled?.id===pairId;
  const back=new URLSearchParams(location.search);
  if(back.has('pattern_t'))back.set('t',String(clamp(Number(back.get('pattern_t')))));
  for(const key of ['compare','pair','view','repeat','pattern_t','fx','content','object','angle'])back.delete(key);
  const backUrl=`/curves${back.size?'?'+back.toString():''}`;

  const persist=useCallback(()=>{
    clearTimeout(persistTimer.current);
    const url=new URL(location.href);
    for(const [key,value] of Object.entries({compare:'1',pair:pairId,view,t:String(progress.current),duration:String(duration),repeat:repeat?'1':'0',object:serializeProductSettings(objects),content:showProduct?'product':'shape',angle:String(angle)}))url.searchParams.set(key,value);
    url.searchParams.delete('fx');
    if(!url.searchParams.get('object'))url.searchParams.delete('object');
    if(url.href!==location.href)history.replaceState(history.state,'',url.pathname+url.search);
  },[pairId,view,duration,repeat,objects,showProduct,angle]);
  const paint=useCallback((value:number)=>{
    const t=clamp(value);progress.current=t;
    if(ready&&compiled)for(const method of METHODS){
      const nodes=compiled.value.sample(ease(t),method.id);
      paths.current.get(method.id)?.setAttribute('d',framePath(nodes));
      if(anchors){
        const children=dots.current.get(method.id)?.children;
        if(children)Array.from(children).forEach((dot,i)=>{
          dot.setAttribute('cx',String(nodes[i].point.x));dot.setAttribute('cy',String(nodes[i].point.y));
        });
      }
    }
    if(slider.current){slider.current.value=String(t*1000);slider.current.setAttribute('aria-valuetext',`${Math.round(t*100)} percent, ${pair.name}`);}
    if(percent.current)percent.current.textContent=`${Math.round(t*100)}%`;
    if(time.current)time.current.textContent=`${(t*duration/1000).toFixed(2)} / ${(duration/1000).toFixed(1)} s`;
    for(const [value,button] of checkpointButtons.current)button.setAttribute('aria-pressed',String(Math.abs(value-t)<.0005));
  },[compiled,ready,anchors,pair.name,duration]);
  useLayoutEffect(()=>{paint(progress.current);},[paint,view,endpoints,showProduct,productState]);
  useEffect(()=>{clearTimeout(persistTimer.current);persistTimer.current=window.setTimeout(persist,120);},[persist]);
  useEffect(()=>{
    const controller=new AbortController();let owned:CurveProductRenderer|null=null;
    setProductState('loading');setProductError('');
    (async()=>{
      const [{loadCurveProduct},{CurveProductRenderer},{disposeSceneObject}]=await Promise.all([import('./curveProductAsset'),import('./curveProductRenderer'),import('./sceneObjects')]);
      if(controller.signal.aborted)return;
      const product=await loadCurveProduct(controller.signal);
      if(controller.signal.aborted){disposeSceneObject(product.root);return;}
      try{owned=new CurveProductRenderer(product.root,()=>{if(!controller.signal.aborted){setProductError('The 3D preview lost its graphics context. Retry to restore it.');setProductState('error');}});}
      catch(error){disposeSceneObject(product.root);throw error;}
      renderer.current=owned;setProductInfo({name:product.name,partCount:product.partCount,triangleCount:product.triangleCount});setProductState('ready');
    })().catch(error=>{if(!controller.signal.aborted){setProductError(error instanceof Error?error.message:'Could not load the product.');setProductState('error');}});
    return()=>{controller.abort();owned?.dispose();if(renderer.current===owned)renderer.current=null;};
  },[productRetry]);
  // The geometry is rendered only when its settings/angle or visible targets
  // change. Morph playback only moves the SVG clip over these cached pixels.
  useLayoutEffect(()=>{
    if(!showProduct||productState!=='ready'||document.hidden)return;
    const request=requestAnimationFrame(()=>{
      try{for(const [method,canvas] of canvases.current)renderer.current?.draw(canvas,objects[method],{yaw:angle,pitch:0});}
      catch(error){setProductError(error instanceof Error?error.message:'Could not draw the product.');setProductState('error');}
    });
    return()=>cancelAnimationFrame(request);
  },[objects,angle,view,showProduct,productState,drawRevision]);
  useEffect(()=>()=>clearTimeout(persistTimer.current),[]);
  useEffect(()=>{
    document.title='Morph comparison — gesso';
    const query=matchMedia(STATIC_MOTION_QUERY);
    const policy=()=>{setStaticMotion(query.matches);if(query.matches)setPlaying(false);};
    query.addEventListener('change',policy);return()=>query.removeEventListener('change',policy);
  },[]);
  useEffect(()=>{
    setPlaying(false);setError('');
    const cached=cache.get(pairId);
    if(cached){setCompiled({id:pairId,value:cached});return;}
    // Paint the preparation state first. Numerical work is compiled once per pair.
    const request=requestAnimationFrame(()=>{timer=window.setTimeout(()=>{
      try{const value=compileCurveComparison(preset(pair.from),preset(pair.to));cache.set(pairId,value);setCompiled({id:pairId,value});}
      catch(reason){setError(reason instanceof Error?reason.message:'Could not prepare this comparison.');}
    },0);});
    let timer:number|undefined;
    return()=>{cancelAnimationFrame(request);clearTimeout(timer);};
  },[pairId,pair.from,pair.to,retry]);
  useEffect(()=>{
    const hidden=()=>{if(document.hidden){setPlaying(false);persist();}else setDrawRevision(value=>value+1);};
    document.addEventListener('visibilitychange',hidden);return()=>document.removeEventListener('visibilitychange',hidden);
  },[persist]);
  useEffect(()=>{
    const restore=()=>{const state=readState();setPlaying(false);progress.current=state.progress;setPairId(state.pair);setView(state.view);if(state.view!=='all')setActiveObject(state.view);setDuration(state.duration);setRepeat(state.repeat);setObjects(state.objects);setShowProduct(state.product);setAngle(state.angle);paint(state.progress);};
    window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);
  },[paint]);
  useEffect(()=>{
    if(!playing||!ready||staticMotion)return;
    let request=0,last:number|undefined;
    const tick=(now:number)=>{
      const elapsed=last===undefined?0:Math.min(now-last,100);last=now;
      let t=progress.current+directionRef.current*elapsed/duration;
      if(elapsed>0&&(t>=1||t<=0)){
        if(repeat){directionRef.current=t>=1?-1:1;setDirection(directionRef.current);t=t>=1?2-t:-t;}
        else{paint(clamp(t));setPlaying(false);persist();return;}
      }
      paint(t);request=requestAnimationFrame(tick);
    };
    request=requestAnimationFrame(tick);return()=>cancelAnimationFrame(request);
  },[playing,ready,staticMotion,duration,repeat,paint,persist]);
  const scrub=useCallback((value:number)=>{setPlaying(false);paint(value);clearTimeout(persistTimer.current);persistTimer.current=window.setTimeout(persist,120);},[paint,persist]);
  const toggle=useCallback(()=>{
    if(staticMotion||!ready)return;
    if(!playing&&(progress.current===0||progress.current===1)){directionRef.current=progress.current===0?1:-1;setDirection(directionRef.current);}
    if(playing)persist();setPlaying(value=>!value);
  },[staticMotion,ready,playing,persist]);
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

  return <div className="curve-demo curve-comparison">
    <header className="curve-header">
      <a className="gesso-wordmark" href="/landing" aria-label="gesso home">gesso<span>studio</span></a>
      <h1>Curve study <span>comparison</span></h1>
      <nav aria-label="Study navigation"><a href={backUrl}><Glyph name="back"/>Pattern</a><a href="/aperture">Form + light</a></nav>
    </header>
    <div className="curve-workspace">
      <aside className="curve-library" aria-label="Comparison setup">
        <div className="curve-library-heading"><h2>Transitions</h2><span>02</span></div>
        <div className="comparison-pairs">{PAIRS.map((item,i)=><button key={item.id} aria-pressed={item.id===pairId} onClick={()=>{setPlaying(false);setPairId(item.id);}}>
          <span>0{i+1}</span><span>{item.name}</span>
          <span className="comparison-pair-shapes" aria-hidden="true"><svg viewBox="0 0 1000 600"><path d={framePath(preset(item.from))}/></svg><span>→</span><svg viewBox="0 0 1000 600"><path d={framePath(preset(item.to))}/></svg></span>
        </button>)}</div>
        <section className="comparison-surface-inspector" aria-label="Product view controls">
          <div className="comparison-inspector-heading"><h2>Object</h2><button onClick={()=>editObject({...DEFAULT_PRODUCT_SETTINGS})}>Reset</button></div>
          <label className="comparison-surface-field comparison-frame-field">Frame<select value={activeObject} onChange={event=>{const method=event.target.value as ComparisonMethod;selectObject(method);if(view!=='all')setView(method);}} aria-label="Frame to edit">{METHODS.map(method=><option key={method.id} value={method.id}>{method.name}</option>)}</select></label>
          <label className="comparison-surface-field">View<select value={selectedObject.mode} onChange={event=>editObject({mode:event.target.value as ProductViewMode})} aria-label="Object appearance"><option value="solid">Solid</option><option value="translucent">Translucent</option><option value="wireframe">Wireframe</option></select></label>
          <div className="comparison-effect-controls">
            {selectedObject.mode!=='solid'&&<label className="comparison-surface-slider"><span>Object opacity<output>{Math.round(selectedObject.opacity*100)}%</output></span><input aria-label="Object opacity" type="range" min="0" max="100" step="1" value={Math.round(selectedObject.opacity*100)} onChange={event=>editObject({opacity:event.target.valueAsNumber/100})}/></label>}
            {selectedObject.mode==='wireframe'&&<>
              <label className="comparison-surface-slider"><span>Edge opacity<output>{Math.round(selectedObject.edges*100)}%</output></span><input aria-label="Edge opacity" type="range" min="0" max="100" step="1" value={Math.round(selectedObject.edges*100)} onChange={event=>editObject({edges:event.target.valueAsNumber/100})}/></label>
              <label className="comparison-back-edges"><input type="checkbox" checked={selectedObject.backEdges} onChange={event=>editObject({backEdges:event.target.checked})}/>Show back edges</label>
            </>}
            <p className="comparison-surface-description">{selectedObject.mode==='solid'?'Original product geometry and finish.':selectedObject.mode==='wireframe'?'Actual triangle edges. Lower the object opacity to expose the structure.':'Fade the product’s surfaces to see how its parts overlap.'}</p>
          </div>
          <div className="comparison-angle-control"><label className="comparison-surface-slider"><span>Turn<output>{Math.round(angle)}°</output></span><input aria-label="Product turn angle" type="range" min="-180" max="180" step="1" value={angle} onChange={event=>{setShowProduct(true);setPlaying(false);setAngle(event.target.valueAsNumber);}}/></label><span>Drag the product to turn · shared angle</span></div>
          <button className="comparison-match-surfaces" onClick={()=>{setShowProduct(true);setPlaying(false);setObjects(value=>({current:{...value[activeObject]},sdf:{...value[activeObject]},radial:{...value[activeObject]}}));}}>Apply to all frames</button>
          <p className="comparison-editing-note">Editing {activeMethod.name.toLowerCase()} only.</p>
        </section>
        <details className="comparison-method-details"><summary>About the comparison</summary><p>{pair.action}</p>{METHODS.map(method=><p key={method.id}><strong>{method.name}.</strong> {method.note}</p>)}<p>Both tests use the same smoothing. No feature matching yet.</p></details>
        <div className="curve-library-footer"><span>64 anchors · 30% shrink</span><span>{productInfo?`${productInfo.name} · ${productInfo.partCount} meshes`:'Local product geometry'}</span></div>
      </aside>
      <main className="curve-main">
        <div className="comparison-toolbar"><div role="group" aria-label="Comparison view">
          <button aria-pressed={view==='all'} onClick={()=>chooseView('all')}>All three</button>
          {METHODS.map(method=><button key={method.id} aria-pressed={view===method.id} onClick={()=>chooseView(method.id)}>{method.name}</button>)}
        </div><div role="group" aria-label="Contour inspection"><button aria-pressed={showProduct} onClick={()=>setShowProduct(!showProduct)}>Product</button><button aria-pressed={endpoints} onClick={()=>setEndpoints(!endpoints)}>Endpoints</button><button aria-pressed={anchors} onClick={()=>setAnchors(!anchors)}>64 anchors</button></div></div>
        <section ref={stage} className={`comparison-stage ${view==='all'?'show-all':'show-one'}`} aria-label={`${pair.name} comparison`} aria-busy={!ready&&!error} tabIndex={0}>
          {METHODS.filter(method=>view==='all'||method.id===view).map((method,i)=><figure key={method.id} className="comparison-window" data-editing={showProduct&&method.id===activeObject?true:undefined}>
            <figcaption><button aria-label={`Edit ${method.name} object`} aria-pressed={showProduct&&activeObject===method.id} onClick={()=>{setShowProduct(true);selectObject(method.id);}}>{method.name}</button><span>{method.id==='current'?'production':'experimental'}</span></figcaption>
            <svg viewBox="0 0 1000 600" role="img" aria-label={`${method.name}: ${pair.name}${showProduct?`, ${objects[method.id].mode} product`:''}`} onClick={()=>selectObject(method.id)}>
              <defs><path id={`comparison-outline-${method.id}`} ref={node=>{if(node)paths.current.set(method.id,node);else paths.current.delete(method.id);}}/><clipPath id={`comparison-clip-${method.id}`}><use href={`#comparison-outline-${method.id}`}/></clipPath></defs>
              {showProduct&&productState==='ready'?<g clipPath={`url(#comparison-clip-${method.id})`}><foreignObject x="0" y="0" width="1000" height="600">
                <div className="comparison-product-canvas" onPointerDown={event=>{if(event.button!==0||turn.current)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);turn.current={id:event.pointerId,x:event.clientX,angle};setPlaying(false);selectObject(method.id);}}
                  onPointerMove={event=>{const gesture=turn.current;if(!gesture||gesture.id!==event.pointerId)return;const next=gesture.angle+(event.clientX-gesture.x)*.5;setAngle(Math.round(((next+180)%360+360)%360-180));}}
                  onPointerUp={event=>{if(turn.current?.id===event.pointerId){turn.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}}
                  onPointerCancel={()=>{turn.current=null;}} onLostPointerCapture={()=>{turn.current=null;}}>
                  <canvas ref={node=>{if(node)canvases.current.set(method.id,node);else canvases.current.delete(method.id);}} width="750" height="450" aria-hidden="true"/>
                </div>
              </foreignObject></g>:<use className="curve-live" href={`#comparison-outline-${method.id}`}/>}
              {endpoints&&<g className="curve-endpoint-guides" aria-hidden="true"><path d={framePath(preset(pair.from))}/><path d={framePath(preset(pair.to))} strokeDasharray="4 5"/></g>}
              {anchors&&<g className="curve-anchor-guides" ref={node=>{if(node)dots.current.set(method.id,node);else dots.current.delete(method.id);}} aria-hidden="true">{Array.from({length:64},(_,index)=><circle key={index} r="3"/>)}</g>}
            </svg>
            <div className="comparison-window-footer"><span>{view==='all'?`0${i+1}`:'64 cubic segments'}</span><span>{showProduct?objects[method.id].mode:'1000 × 600'}</span></div>
          </figure>)}
          {!ready&&<div className="comparison-loading" role="status">{error?<><span>Could not prepare the comparison.</span><span>{error}</span><button onClick={()=>setRetry(value=>value+1)}>Retry</button></>:<span>Preparing both outlines…</span>}</div>}
        </section>
        {showProduct&&productState!=='ready'&&<div className="comparison-image-status" role="status">{productState==='loading'?'Loading product geometry…':<>{productError} <button onClick={()=>setProductRetry(value=>value+1)}>Retry</button></>}</div>}
        <section className="comparison-dock" aria-label="Shared comparison playback">
          <div className="comparison-checkpoints"><span>{pair.name}</span><div role="group" aria-label="Inspect a checkpoint">{CHECKPOINTS.map(value=><button key={value} ref={node=>{if(node)checkpointButtons.current.set(value,node);else checkpointButtons.current.delete(value);}} aria-label={`Inspect ${value*100} percent`} aria-pressed={false} onClick={()=>scrub(value)}>{value*100}%</button>)}</div></div>
          <div className="curve-transport">
            <div className="curve-playback"><button className="curve-play" disabled={!ready||staticMotion} onClick={toggle} aria-label={playing?'Pause comparison':'Play comparison'}><Glyph name={playing?'pause':'play'}/>{playing?'Pause':'Play'}</button><button className="curve-reverse" onClick={reverse} aria-label="Reverse comparison direction"><Glyph name="reverse"/><span>{direction===1?'Forward':'Reverse'}</span></button></div>
            <div className="curve-scrub"><input ref={slider} type="range" min="0" max="1000" step="1" defaultValue={initial.progress*1000} aria-label="Comparison progress" onChange={event=>scrub(event.target.valueAsNumber/1000)} onPointerUp={persist} onKeyUp={persist} onBlur={persist}/><output ref={percent} aria-live="off"/></div>
            <div className="curve-timing"><label>Duration<select value={duration} aria-label="Comparison duration" onChange={event=>{setPlaying(false);setDuration(Number(event.target.value));}}><option value={1200}>1.2 s</option><option value={2400}>2.4 s</option><option value={4800}>4.8 s</option></select></label><label className="curve-loop"><input type="checkbox" checked={repeat} onChange={event=>setRepeat(event.target.checked)}/>Repeat ↔</label></div>
          </div>
          <div className="curve-help"><span>{staticMotion?'Motion paused for this device or preference. Scrub to compare.':'Space play / pause · R reverse · ← → scrub'}</span><output ref={time} aria-live="off"/></div>
        </section>
      </main>
    </div>
  </div>;
}
