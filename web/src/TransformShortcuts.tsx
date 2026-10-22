import {useEffect,useRef,useState} from 'react';
import {equalJson} from './state';
import {displayPartName} from './hierarchy';
import {animatedTransformScene,copyAnimatedTransform} from './animatedTransforms';
import {getPropertyValue,PRODUCT_TARGET} from './keyframes';
import type {TransformGesture} from './transformPointer';
import {
  nudgeTransformAmount,pointerTransformAmount,rotationSampleDelta,supportsTransform,transformKeyIntent,transformTargetKey,transformScaleLimits,typedTransformAmount,
  type TransformAxis,type TransformMode,type TransformTarget,
} from './transforms';

type Pointer = {x:number;y:number};
type PointerAnchor = {gesture:TransformGesture;base:number;fine:boolean;lastAngle:number;angle:number};
type Transaction = {source:any;frame:number;target:TransformTarget;mode:TransformMode;axis:TransformAxis;amount:number;text:string};
export interface TransformShortcutsProps {
  scene:any;
  frame?:number;
  target:TransformTarget|null;
  enabled:boolean;
  viewport:HTMLElement|null;
  createGesture?:(target:TransformTarget,pointer:Pointer)=>TransformGesture|null;
  onStart?:(mode:TransformMode)=>void;
  onPreview?:(scene:any|null)=>void;
  onCommit:(edit:(scene:any)=>void)=>void;
  onMode?:(mode:TransformMode|null)=>void;
}
const labels = {translate:'Move',rotate:'Rotate',scale:'Scale'};
const keys = {translate:'G',rotate:'R',scale:'S'};
function editableTarget(target:EventTarget|null):boolean {
  return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
}
function displayAmount(transaction:Transaction):string {
  if (transaction.text) return transaction.text;
  const value = transaction.mode === 'translate' ? transaction.amount*1000 : transaction.amount;
  return Number(transaction.mode === 'scale' ? value.toPrecision(8) : value.toFixed(4)).toString();
}

/** A transient transaction: preview never enters scene history; Apply makes one edit. */
export default function TransformShortcuts(props:TransformShortcutsProps) {
  const current = useRef(props); current.current = props;
  const transaction = useRef<Transaction|null>(null);
  const [active,setActive] = useState<Transaction|null>(null);
  const [feedback,setFeedback] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement|null>(null);
  const latestPointer = useRef<Pointer|null>(null);
  const pointerInside = useRef(false);
  const pointerFine = useRef(false);
  const pointerAnchor = useRef<PointerAnchor|null>(null);
  const suppressContext = useRef(false);

  function anchorPointer(state:Transaction,point=latestPointer.current,fine=pointerFine.current) {
    pointerAnchor.current = null;
    if (!point || !pointerInside.current || !current.current.createGesture) return;
    const gesture = current.current.createGesture(state.target,point);
    if (gesture) pointerAnchor.current = {gesture,base:state.amount,fine,lastAngle:0,angle:0};
    else setFeedback('Choose another axis or view.');
  }
  function chooseAxis(axis:TransformAxis) {
    const state = transaction.current;
    if (!state) return;
    if (state.mode === 'scale') {setFeedback('Scale is uniform across X, Y and Z.');return;}
    const next = {...state,axis};
    update(next); anchorPointer(next);
  }

  function finish(commit:boolean,restoreFocus=true) {
    const state = transaction.current;
    if (!state) return;
    if (commit && state.text && typedTransformAmount(state.mode,state.text) === null) {
      setFeedback(state.mode === 'scale' ? 'Enter a scale factor greater than zero.' : 'Enter a number.'); return;
    }
    let preview:any = null;
    if (commit && current.current.scene === state.source) {
      try {preview = animatedTransformScene(state.source,state.target,state.mode,state.axis,state.amount,state.frame);}
      catch (error) {setFeedback(error instanceof Error ? error.message : 'This transform is unavailable.');return;}
    }
    transaction.current = null; pointerAnchor.current = null; setActive(null); setFeedback('');
    if (preview && !equalJson(preview,state.source)) current.current.onCommit(next=>copyAnimatedTransform(next,preview,state.target,state.mode,state.axis,state.frame));
    current.current.onPreview?.(null);
    current.current.onMode?.(null);
    if (restoreFocus && previousFocus.current?.isConnected) previousFocus.current.focus({preventScroll:true});
    previousFocus.current = null;
  }
  function start(mode:TransformMode,fromButton=false) {
    const {scene,target,enabled} = current.current;
    if (!enabled || !target) {setFeedback('Select a component to transform.'); return;}
    if (!supportsTransform(scene,target,mode)) {
      setFeedback(mode === 'rotate' && target.kind === 'product' ? 'Select a part to rotate. Whole-product rotation is not available.' : 'Select a component to transform.'); return;
    }
    if (!transaction.current) previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const next:Transaction = {source:scene,frame:current.current.frame??1,target,mode,axis:mode === 'rotate' ? 'z' : 'x',amount:mode === 'scale' ? 1 : 0,text:''};
    transaction.current = next; setActive(next); setFeedback('');
    current.current.onStart?.(mode);
    current.current.onMode?.(mode);
    current.current.onPreview?.(scene);
    if (fromButton) pointerAnchor.current = null; else anchorPointer(next);
    panel.current?.focus({preventScroll:true});
  }
  function update(next:Transaction) {
    transaction.current = next; setActive(next); setFeedback('');
    if (next.text && typedTransformAmount(next.mode,next.text) === null) return;
    try {current.current.onPreview?.(animatedTransformScene(next.source,next.target,next.mode,next.axis,next.amount,next.frame));}
    catch (error) {setFeedback(error instanceof Error ? error.message : 'This transform is unavailable.');}
  }

  useEffect(()=>{
    const state = transaction.current;
    if (state && (!props.enabled || (props.frame??1) !== state.frame || props.scene !== state.source || transformTargetKey(props.target) !== transformTargetKey(state.target))) finish(false,false);
  },[props.enabled,props.scene,props.frame,transformTargetKey(props.target)]);

  useEffect(()=>{
    const keydown = (event:KeyboardEvent) => {
      if (!current.current.enabled || !transaction.current && event.target instanceof Element && event.target.closest('.gesso-keyframe-editor,.keyframe-editor')) return;
      if (event.key === 'Shift' && transaction.current && !editableTarget(event.target)) {
        if (!pointerFine.current) {pointerFine.current = true;anchorPointer(transaction.current,latestPointer.current,true);}
        return;
      }
      const intent = transformKeyIntent({...event,key:event.key,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey,
        shiftKey:event.shiftKey,repeat:event.repeat,isComposing:event.isComposing,editable:editableTarget(event.target)},!!transaction.current);
      if (!intent) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (intent.type === 'start') {start(intent.mode); return;}
      if (intent.type === 'cancel' || intent.type === 'confirm') {finish(intent.type === 'confirm'); return;}
      const state = transaction.current;
      if (!state) return;
      if (intent.type === 'axis') {
        chooseAxis(intent.axis);
      } else if (intent.type === 'nudge') {
        const scale=getPropertyValue(state.source,state.target.kind==='product'?PRODUCT_TARGET:state.target.componentId,'scale',state.frame);
        const bounds=transformScaleLimits(state.target);
        const next = {...state,amount:nudgeTransformAmount(state.mode,state.amount,intent.direction,intent.fine,{min:bounds.min/scale,max:bounds.max/scale}),text:''};
        update(next);anchorPointer(next);
      } else if (intent.type === 'type') {
        let text = intent.key === 'backspace' ? state.text.slice(0,-1) : state.text+intent.key;
        if (!/^[+-]?\d*\.?\d*$/.test(text)) return;
        const parsed = typedTransformAmount(state.mode,text);
        const next = {...state,text,amount:parsed ?? (text ? state.amount : state.mode === 'scale' ? 1 : 0)};
        update(next);anchorPointer(next);
      }
    };
    const keyup = (event:KeyboardEvent) => {
      if (event.key === 'Shift') {
        pointerFine.current = false;
        if (transaction.current) anchorPointer(transaction.current,latestPointer.current,false);
      }
    };
    window.addEventListener('keydown',keydown,true);window.addEventListener('keyup',keyup,true);
    return ()=>{window.removeEventListener('keydown',keydown,true);window.removeEventListener('keyup',keyup,true);};
  },[]);
  useEffect(()=>{
    const viewport=props.viewport;
    if (!viewport) return;
    const isControl=(target:EventTarget|null)=>target instanceof Element && !!target.closest('button,input,textarea,select,a,[role="slider"],[contenteditable],.gesso-transform-shortcuts');
    const move=(event:PointerEvent)=>{
      if (isControl(event.target)) {pointerInside.current=false;pointerAnchor.current=null;return;}
      const point={x:event.clientX,y:event.clientY};
      const entering=!pointerInside.current;
      pointerInside.current=true;latestPointer.current=point;
      const state=transaction.current;
      if (!state) {pointerFine.current=event.shiftKey;return;}
      if (state.text || !current.current.createGesture) return;
      if (entering || !pointerAnchor.current || pointerFine.current !== event.shiftKey) {
        pointerFine.current=event.shiftKey;anchorPointer(state,point,event.shiftKey);return;
      }
      const anchor=pointerAnchor.current;
      const sample=anchor.gesture.sample(state.mode,state.axis,point);
      if (sample === null || !Number.isFinite(sample) || state.mode === 'scale' && sample <= 0) {
        setFeedback('Choose another axis or view.');return;
      }
      let delta=sample;
      if (state.mode === 'rotate') {
        anchor.angle+=rotationSampleDelta(anchor.lastAngle,sample);anchor.lastAngle=sample;delta=anchor.angle;
      }
      update({...state,amount:pointerTransformAmount(state.mode,anchor.base,delta,anchor.fine),text:''});
    };
    const leave=()=>{pointerInside.current=false;pointerAnchor.current=null;};
    const down=(event:PointerEvent)=>{
      if (!transaction.current || isControl(event.target) || event.button !== 0 && event.button !== 2) return;
      event.preventDefault();event.stopImmediatePropagation();
      suppressContext.current=event.button === 2;
      finish(event.button === 0);
    };
    const cancel=(event:MouseEvent)=>{
      if (!transaction.current && !suppressContext.current) return;
      event.preventDefault();event.stopPropagation();suppressContext.current=false;finish(false);
    };
    const resized=new ResizeObserver(()=>{if(transaction.current) anchorPointer(transaction.current);});
    resized.observe(viewport);
    viewport.addEventListener('pointermove',move);
    viewport.addEventListener('pointerleave',leave);
    viewport.addEventListener('pointerdown',down,true);
    viewport.addEventListener('contextmenu',cancel);
    return ()=>{
      resized.disconnect();viewport.removeEventListener('pointermove',move);viewport.removeEventListener('pointerleave',leave);
      viewport.removeEventListener('pointerdown',down,true);viewport.removeEventListener('contextmenu',cancel);
      pointerInside.current=false;pointerAnchor.current=null;latestPointer.current=null;
    };
  },[props.viewport]);
  useEffect(()=>{
    const blur=()=>{pointerInside.current=false;pointerFine.current=false;pointerAnchor.current=null;finish(false,false);};
    const hidden=()=>{if(document.hidden) finish(false,false);};
    window.addEventListener('blur',blur); document.addEventListener('visibilitychange',hidden);
    return ()=>{window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',hidden);};
  },[]);
  useEffect(()=>()=>{
    if (transaction.current) {
      transaction.current = null;
      current.current.onPreview?.(null); current.current.onMode?.(null);
    }
  },[]);

  if (!props.enabled) return null;
  const targetName = props.target?.kind === 'product' ? 'Product' : props.target?.kind === 'part' ? displayPartName(props.scene, props.target.componentId) : 'No component selected';
  return <div className={`gesso-transform-shortcuts${active ? ' is-active' : ''}`} ref={panel} tabIndex={-1} aria-label="Transform controls" onPointerDown={event=>event.stopPropagation()}>
    <div className="gesso-transform-tools" role="group" aria-label="Transform mode">
      {(['translate','rotate','scale'] as TransformMode[]).map(mode=><button key={mode} type="button" aria-pressed={active?.mode === mode}
        disabled={!supportsTransform(props.scene,props.target,mode)} title={mode === 'rotate' && props.target?.kind === 'product' ? 'Select a part to rotate' : `${labels[mode]} (${keys[mode]})`}
        onClick={()=>start(mode,true)}>{labels[mode]} <kbd>{keys[mode]}</kbd></button>)}
    </div>
    {active ? <>
      <div className="gesso-transform-status" role="status">{labels[active.mode]} {active.mode === 'scale' ? 'uniform' : active.axis.toUpperCase()} · {targetName} <strong>{displayAmount(active)}{active.mode === 'translate' ? ' mm' : active.mode === 'rotate' ? '°' : '×'}</strong></div>
      {active.mode !== 'scale' && <div className="gesso-transform-axes" role="group" aria-label="Transform axis">{(['x','y','z'] as TransformAxis[]).map(axis=><button key={axis} type="button" aria-pressed={active.axis === axis} onClick={()=>{chooseAxis(axis);panel.current?.focus({preventScroll:true});}}>{axis.toUpperCase()}</button>)}</div>}
      <p className="gesso-transform-hints">{props.createGesture ? 'Move pointer · click apply · ' : ''}{active.mode !== 'scale' ? 'X / Y / Z axis · ' : ''}↑ ↓ adjust · Shift fine · type {active.mode === 'translate' ? 'mm' : active.mode === 'rotate' ? 'degrees' : 'factor'}</p>
      <div className="gesso-transform-actions"><button type="button" onClick={()=>finish(true)}>Apply <kbd>↵</kbd></button><button type="button" onClick={()=>finish(false)}>Cancel <kbd>esc</kbd></button></div>
    </> : <p className="gesso-transform-hints">{props.target ? `${targetName} · G move${props.target.kind === 'part' ? ' · R rotate' : ''} · S scale` : 'Select a component to transform'}</p>}
    {feedback && <p className="gesso-transform-feedback" role="status">{feedback}</p>}
  </div>;
}
