import {partTargetIds} from './partTargets';
import {useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {displayPartName} from './hierarchy';
import {listMotions,motionChannels,motionLabel} from './filmMotion';
import {shotAtFrame} from './sequence';
import {
  PRODUCT_TARGET,TRANSFORM_PROPERTIES,animationBlockReason,animationTracks,formatAnimationTime,getMotion,getPropertyValue,getTrack,lastAnimationFrame,
  moveKey,propertyPresentation,removeKey,setKeyInterpolation,toggleTrack,upsertKey,writeProperty,
  type AnimationKey,type AnimationTrack,type KeyframeInterpolation,type KeyframeProperty,
} from './keyframes';
import './keyframe-editor.css';

export interface KeyframeEditorProps {
  scene:any;componentId:string|null;frame:number;onFrame:(frame:number)=>void;
  onChange:(edit:(scene:any)=>void)=>void|boolean;playing:boolean;onPlay:()=>void;disabled?:boolean;
  scope?:'local'|'world';onScopeChange?:(scope:'local'|'world')=>void;
  embedded?:boolean;
}
type Selection={componentId:string;property:KeyframeProperty;frame?:number};
type KeyDrag={trackId:string;fromFrame:number;toFrame:number;pointerId:number;left:number;width:number;button:HTMLButtonElement};
const rounded=(value:number,precision=4)=>Number(value.toFixed(precision));

function ValueField({value,label,step=1,precision=4,min,max,disabled,onCommit}:{value:number;label:string;step?:number;precision?:number;min?:number;max?:number;disabled?:boolean;onCommit:(value:number)=>void|boolean}){
  const [text,setText]=useState(String(rounded(value,precision)));
  const editing=useRef(false),skipBlur=useRef(false),dirty=useRef(false);
  useEffect(()=>{if(!editing.current)setText(String(rounded(value,precision)));},[value,precision]);
  const commit=()=>{
    editing.current=false;
    if(skipBlur.current){skipBlur.current=false;dirty.current=false;return;}
    if(!dirty.current){setText(String(rounded(value,precision)));return;}
    dirty.current=false;
    const parsed=Number(text);
    if(text.trim()&&Number.isFinite(parsed)&&(min===undefined||parsed>=min)&&(max===undefined||parsed<=max)){
      if(Math.abs(parsed-value)>1e-9 && onCommit(parsed)===false){setText(String(rounded(value,precision)));return;}
      setText(String(rounded(parsed,precision)));
    }else setText(String(rounded(value,precision)));
  };
  return <input type="number" aria-label={label} value={text} min={min} max={max} step={step} disabled={disabled}
    onFocus={()=>{editing.current=true;dirty.current=false;}} onChange={event=>{dirty.current=true;setText(event.target.value);}} onBlur={commit}
    onKeyDown={event=>{
      if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}
      else if(event.key==='Escape'){event.preventDefault();skipBlur.current=true;editing.current=false;setText(String(rounded(value,precision)));event.currentTarget.blur();}
    }}/>;
}

function trackProperties(scene:any,id:string):KeyframeProperty[]{
  return [...TRANSFORM_PROPERTIES.filter(property=>id!==PRODUCT_TARGET||!property.startsWith('rotation.')),...(getMotion(scene,id)?['motion' as const]:[])];
}
function targetName(scene:any,id:string):string {
  return id===PRODUCT_TARGET?'Whole product':displayPartName(scene,id);
}
function channelName(scene:any,id:string,property:KeyframeProperty):string {
  const info=propertyPresentation(scene,id,property);return [info.label,info.axis].filter(Boolean).join(' ');
}

/** Match the evaluator's local-over-shared ownership, including pinned targets. */
export function boundedMotionReason(scene:any,frame:number,target:string,property:KeyframeProperty):string|null {
  const shot=shotAtFrame(scene,frame);if(!shot)return null;
  const entries=listMotions(scene,shot.id).filter(entry=>entry.motion.enabled);
  const local=entries.filter(entry=>entry.scope==='shot');
  const active=entries.filter(entry=>entry.scope==='shot'||!local.some(owner=>owner.motion.target===entry.motion.target&&motionChannels(owner.motion).some(channel=>motionChannels(entry.motion).includes(channel))));
  const owner=active.find(entry=>entry.motion.target===target&&(motionChannels(entry.motion).includes(property)||property==='motion'&&!!getMotion(scene,target)&&(entry.motion.kind==='move'||entry.motion.kind==='rotate')));
  return owner?`Pause ${motionLabel(owner.motion)} to edit these keys.`:null;
}

function Curve({track,total,frame,selectedFrame,onSelect,onScrub,onDrag,onDragMove,onDragEnd,onDragCancel,onKey,dragFrame,disabled,scene,showPlayhead=true}:{
  track:AnimationTrack;total:number;frame:number;selectedFrame?:number;onSelect:(key:AnimationKey)=>void;onScrub:(frame:number)=>void;
  onDrag:(event:PointerEvent<HTMLButtonElement>,track:AnimationTrack,key:AnimationKey)=>void;
  onDragMove:(event:PointerEvent<HTMLButtonElement>)=>void;onDragEnd:(event:PointerEvent<HTMLButtonElement>)=>void;onDragCancel:()=>void;onKey:(event:KeyboardEvent<HTMLButtonElement>,track:AnimationTrack,key:AnimationKey)=>void;dragFrame?:{fromFrame:number;toFrame:number};disabled?:boolean;scene:any;showPlayhead?:boolean;
}){
  const info=propertyPresentation(scene,track.componentId,track.property);
  const values=track.keys.map(key=>key.value*info.factor),low=Math.min(...values),high=Math.max(...values),spread=high-low;
  const padding=spread>1e-10?spread*.15:Math.max(Math.abs(low)*.1,.1);
  const min=low-padding,max=high+padding;
  const x=(keyFrame:number)=>(keyFrame-1)/Math.max(1,total-1)*100;
  const displayY=(value:number)=>100-(value-min)/(max-min)*100;
  const y=(value:number)=>displayY(value*info.factor);
  const pathKeys=dragFrame?track.keys.map(key=>key.frame===dragFrame.fromFrame?{...key,frame:dragFrame.toFrame}:key).sort((a,b)=>a.frame-b.frame):track.keys;
  let path=`M0,${y(pathKeys[0].value)} L${x(pathKeys[0].frame)},${y(pathKeys[0].value)}`;
  for(let index=1;index<pathKeys.length;index++){
    const left=pathKeys[index-1],right=pathKeys[index],dx=x(right.frame)-x(left.frame);
    if(left.interpolation==='hold')path+=` L${x(right.frame)},${y(left.value)} L${x(right.frame)},${y(right.value)}`;
    else if(left.interpolation==='linear')path+=` L${x(right.frame)},${y(right.value)}`;
    else path+=` C${x(left.frame)+dx/3},${y(left.value)} ${x(right.frame)-dx/3},${y(right.value)} ${x(right.frame)},${y(right.value)}`;
  }
  path+=` L100,${y(pathKeys.at(-1)!.value)}`;
  const rulers=spread>1e-10?[low,(low+high)/2,high]:[low];
  return <div className="kf-curve" aria-label={`${channelName(scene,track.componentId,track.property)} curve`}>
    <div className="kf-curve-unit">{rulers.map(value=><span key={value} style={{top:`${displayY(value)}%`}}>{rounded(value,info.precision)} {info.unit}</span>)}</div>
    <div className="kf-curve-plot" onPointerDown={event=>{
      if(event.target!==event.currentTarget||disabled)return;
      const rect=event.currentTarget.getBoundingClientRect();onScrub(Math.max(1,Math.min(total,Math.round(1+(event.clientX-rect.left)/rect.width*(total-1)))));
    }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={rulers.map(value=>`M0 ${displayY(value)}H100`).join(' ')} className="kf-curve-grid"/><path d={path} className="kf-curve-line"/></svg>
      {showPlayhead&&<span className="kf-playhead" style={{left:`${x(frame)}%`}} aria-hidden="true"/>}
      {track.keys.map(key=><button key={key.frame} type="button" data-kf-track={track.id} data-kf-frame={key.frame} className={`kf-key kf-curve-key ${selectedFrame===key.frame?'selected':''}`} style={{left:`${x(dragFrame?.fromFrame===key.frame?dragFrame.toFrame:key.frame)}%`,top:`${y(key.value)}%`}}
        aria-label={`Key at frame ${key.frame}, ${rounded(key.value*info.factor,info.precision)} ${info.unit}`} aria-pressed={selectedFrame===key.frame} disabled={disabled}
        onPointerDown={event=>onDrag(event,track,key)} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragCancel} onLostPointerCapture={onDragCancel}
        onClick={event=>{if(event.detail===0)onSelect(key);}} onKeyDown={event=>onKey(event,track,key)}><span aria-hidden="true"/></button>)}
    </div>
  </div>;
}

export default function KeyframeEditor({scene,componentId,frame,onFrame,onChange,playing,onPlay,disabled=false,scope:controlledScope,onScopeChange,embedded=false}:KeyframeEditorProps){
  const [localScope,setLocalScope]=useState<'local'|'world'>('local');
  const scope=controlledScope??localScope;
  const targetId=scope==='world'?PRODUCT_TARGET:componentId??scene?.product?.components?.[0]?.id??PRODUCT_TARGET;
  const [pin,setPin]=useState<string|null>(null),[curves,setCurves]=useState(false),[selection,setSelection]=useState<Selection|null>(null),[notice,setNotice]=useState('');
  const [dragPreview,setDragPreview]=useState<{trackId:string;fromFrame:number;toFrame:number}|null>(null);
  const drag=useRef<KeyDrag|null>(null);
  const editorRoot=useRef<HTMLElement|null>(null);
  const pendingKeyFocus=useRef<{trackId:string;frame:number}|null>(null);
  const total=lastAnimationFrame(scene),fps=scene.render.fps;
  const targetBlockReason=animationBlockReason(scene,targetId,'position.x');
  const components=partTargetIds(scene).map(id=>({id}));
  const ids=pin&&pin!==targetId&&components.some((part:any)=>part.id===pin)?[targetId,pin]:[targetId];
  const selected:Selection=selection&&ids.includes(selection.componentId)?selection:{componentId:targetId,property:(getMotion(scene,targetId)?'motion':'position.x') as KeyframeProperty};
  const selectedTrack=getTrack(scene,selected.componentId,selected.property);
  const selectedKey=selected.frame===undefined?undefined:selectedTrack?.keys.find(key=>key.frame===selected.frame);
  const info=propertyPresentation(scene,selected.componentId,selected.property);
  const currentValue=getPropertyValue(scene,selected.componentId,selected.property,frame);
  const selectedOwner=boundedMotionReason(scene,frame,selected.componentId,selected.property);
  const chooseScope=(value:'local'|'world')=>{setSelection(null);setNotice('');(onScopeChange??setLocalScope)(value);};
  useEffect(()=>{setSelection(null);setNotice('');pendingKeyFocus.current=null;},[targetId,scene.sceneId]);
  useEffect(()=>{if(pin&&!components.some((part:any)=>part.id===pin))setPin(null);},[components,pin]);
  const cancelDrag=()=>{drag.current=null;setDragPreview(null);};
  useEffect(()=>{
    const cancel=()=>{drag.current=null;setDragPreview(null);};
    window.addEventListener('blur',cancel);document.addEventListener('visibilitychange',cancel);
    return()=>{window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',cancel);drag.current=null;};
  },[]);
  useEffect(()=>{cancelDrag();},[targetId,disabled,total]);
  // Retiming changes a key's React identity. Restore its keyboard target only after
  // canonical evaluation re-enables the controls, and only if the user stayed here.
  useEffect(()=>{
    if(disabled||!pendingKeyFocus.current)return;
    const pending=pendingKeyFocus.current;
    const button=Array.from(editorRoot.current?.querySelectorAll<HTMLButtonElement>('button[data-kf-track]')??[])
      .find(item=>item.dataset.kfTrack===pending.trackId&&Number(item.dataset.kfFrame)===pending.frame&&!item.disabled&&item.getClientRects().length>0);
    if(button){pendingKeyFocus.current=null;button.focus({preventScroll:true});}
  },[disabled,scene,curves]);
  useEffect(()=>{
    const cancelFocus=()=>{pendingKeyFocus.current=null;};
    const cancelOnNavigation=(event:globalThis.KeyboardEvent)=>{if(event.key==='Tab'||event.key==='Escape'||event.metaKey||event.ctrlKey)cancelFocus();};
    const cancelOnFocus=(event:FocusEvent)=>{
      const target=event.target;
      if(pendingKeyFocus.current&&target instanceof HTMLElement&&target!==document.body&&!target.matches('button[data-kf-track]'))cancelFocus();
    };
    document.addEventListener('pointerdown',cancelFocus,true);document.addEventListener('keydown',cancelOnNavigation,true);document.addEventListener('focusin',cancelOnFocus,true);
    window.addEventListener('blur',cancelFocus);
    return()=>{document.removeEventListener('pointerdown',cancelFocus,true);document.removeEventListener('keydown',cancelOnNavigation,true);document.removeEventListener('focusin',cancelOnFocus,true);window.removeEventListener('blur',cancelFocus);};
  },[]);
  const commit=(edit:(next:any)=>void,id=selected.componentId,property=selected.property)=>{
    if(disabled)return false;
    const owner=boundedMotionReason(scene,frame,id,property);if(owner){setNotice(owner);return false;}
    try{if(onChange(edit)===false)return false;setNotice('');return true;}catch(error){setNotice(error instanceof Error?error.message:'Could not change that keyframe.');return false;}
  };
  const percent=(value:number)=>(value-1)/Math.max(1,total-1)*100;
  const selectKey=(track:AnimationTrack,key:AnimationKey)=>{setSelection({componentId:track.componentId,property:track.property,frame:key.frame});onFrame(key.frame);};
  const beginDrag=(event:PointerEvent<HTMLButtonElement>,track:AnimationTrack,key:AnimationKey)=>{
    if(disabled||event.button!==0)return;
    event.preventDefault();event.stopPropagation();event.currentTarget.focus();
    const owner=boundedMotionReason(scene,frame,track.componentId,track.property);
    if(owner){selectKey(track,key);setNotice(owner);return;}
    const rect=event.currentTarget.parentElement!.getBoundingClientRect();
    drag.current={trackId:track.id,fromFrame:key.frame,toFrame:key.frame,pointerId:event.pointerId,left:rect.left,width:rect.width,button:event.currentTarget};
    event.currentTarget.setPointerCapture(event.pointerId);setSelection({componentId:track.componentId,property:track.property,frame:key.frame});
  };
  const dragMove=(event:PointerEvent<HTMLButtonElement>)=>{
    const active=drag.current;if(!active||active.pointerId!==event.pointerId)return;
    active.toFrame=Math.max(1,Math.min(total,Math.round(1+(event.clientX-active.left)/active.width*(total-1))));
    setDragPreview({trackId:active.trackId,fromFrame:active.fromFrame,toFrame:active.toFrame});
  };
  const endDrag=(event:PointerEvent<HTMLButtonElement>)=>{
    const active=drag.current;if(!active||active.pointerId!==event.pointerId)return;
    drag.current=null;setDragPreview(null);
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    const track=animationTracks(scene).find(item=>item.id===active.trackId);if(!track)return;
    if(active.fromFrame!==active.toFrame){
      if(track.keys.some(key=>key.frame===active.toFrame)){setNotice(`Frame ${active.toFrame} already has a key. Choose another frame.`);return;}
      if(!commit(next=>moveKey(next,track.id,active.fromFrame,active.toFrame),track.componentId,track.property))return;
      pendingKeyFocus.current={trackId:track.id,frame:active.toFrame};
      setSelection({componentId:track.componentId,property:track.property,frame:active.toFrame});
    }
    onFrame(active.toFrame);
  };
  const keyKeyboard=(event:KeyboardEvent<HTMLButtonElement>,track:AnimationTrack,key:AnimationKey)=>{
    if(disabled||event.altKey||event.metaKey||event.ctrlKey)return;
    const owner=boundedMotionReason(scene,frame,track.componentId,track.property);
    if(owner&&['Delete','Backspace','ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setNotice(owner);return;}
    if(event.key==='Delete'||event.key==='Backspace'){
      event.preventDefault();if(!commit(next=>removeKey(next,track.id,key.frame),track.componentId,track.property))return;setSelection({componentId:track.componentId,property:track.property});
    }else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
      event.preventDefault();const destination=Math.max(1,Math.min(total,key.frame+(event.key==='ArrowRight'?1:-1)*(event.shiftKey?10:1)));
      if(track.keys.some(item=>item.frame===destination&&item.frame!==key.frame)){setNotice(`Frame ${destination} already has a key.`);return;}
      if(!commit(next=>moveKey(next,track.id,key.frame,destination),track.componentId,track.property))return;
      if(destination!==key.frame)pendingKeyFocus.current={trackId:track.id,frame:destination};
      setSelection({componentId:track.componentId,property:track.property,frame:destination});onFrame(destination);
    }
  };
  const addAtPlayhead=(id:string,property:KeyframeProperty)=>{
    const owner=boundedMotionReason(scene,frame,id,property);if(owner){setNotice(owner);return;}
    const track=getTrack(scene,id,property),value=getPropertyValue(scene,id,property,frame);
    if(!commit(next=>{
      if(!track?.enabled)toggleTrack(next,id,property,frame,true);
      upsertKey(next,id,property,frame,value);
    },id,property))return;
    setSelection({componentId:id,property,frame});
  };
  const ticks=useMemo(()=>Array.from({length:6},(_,index)=>Math.round(1+(total-1)*index/5)),[total]);
  const selectedIndex=selectedKey&&selectedTrack?selectedTrack.keys.indexOf(selectedKey):-1;
  const beforeKey=selectedTrack?.keys.filter(key=>key.frame<frame).at(-1),afterKey=selectedTrack?.keys.find(key=>key.frame>frame);

  return <section ref={editorRoot} className={`gesso-keyframe-editor${embedded?' is-embedded':''}`} aria-label="Keyframe editor" onKeyDown={event=>{
    if(event.key==='Escape'&&drag.current){event.preventDefault();cancelDrag();setNotice('Timing change cancelled');}
    const target=event.target as HTMLElement;
    const editingText=target.isContentEditable||!!target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
    if(event.key===' '&&!editingText&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();if(!event.repeat&&!disabled)onPlay();}
    if(!event.metaKey&&!event.ctrlKey&&!event.altKey)event.stopPropagation();
  }}>
    <header className="kf-header">
      {!embedded&&<button type="button" className="kf-play" onClick={onPlay} disabled={disabled} aria-label={playing?'Pause animation':'Play animation'} title={playing?'Pause':'Play'}>{playing?'Ⅱ':'▶'}</button>}
      <strong>Animation</strong>
      <select className="kf-scope" value={scope} aria-label="Animation scope" onChange={event=>chooseScope(event.target.value as 'local'|'world')} disabled={disabled}><option value="local">Selected part</option><option value="world">Whole product</option></select>
      <span className="kf-target" title={targetName(scene,targetId)}>{targetName(scene,targetId)}</span>
      <select className="kf-pin" aria-label="Pin another part" value={pin??''} onChange={event=>setPin(event.target.value||null)}>
        <option value="">Compare part…</option>{components.filter((part:any)=>part.id!==targetId).map((part:any)=><option value={part.id} key={part.id}>{targetName(scene,part.id)}</option>)}
      </select>
      {!embedded&&<time className="kf-time">{formatAnimationTime(frame,fps)}</time>}
      <button type="button" className="kf-view-toggle" aria-pressed={curves} onClick={()=>setCurves(value=>!value)} title="Show the selected property's value curve">Curves</button>
    </header>
    {targetBlockReason&&<p className="kf-constraint">{targetBlockReason}</p>}
    {selectedOwner&&<p className="kf-constraint" role="status">{selectedOwner} Existing keys remain available to inspect.</p>}
    <div className="kf-ruler-row">
      <div className="kf-ruler-caption"><span>Property / value</span><span>Animate</span></div>
      <div className="kf-ruler">
        <div className="kf-shots" aria-label="Shot boundaries">{(scene.shots??[]).map((shot:any)=><span key={shot.id} title={`${shot.label??shot.name??shot.id} · frames ${shot.startFrame}–${shot.endFrame}`}
          style={{left:`${percent(shot.startFrame)}%`,width:`${(shot.endFrame-shot.startFrame+1)/total*100}%`}}>{shot.label??shot.name??shot.id}</span>)}</div>
        <div className="kf-ticks" aria-hidden="true">{ticks.map((tick,index)=><span key={`${tick}-${index}`} style={{left:`${percent(tick)}%`}}>{((tick-1)/fps).toFixed(1)}s</span>)}</div>
        {!embedded&&<input type="range" aria-label="Animation playhead" min={1} max={total} step={1} value={frame} disabled={disabled} onChange={event=>onFrame(Number(event.target.value))}/>}
        {!embedded&&<span className="kf-ruler-needle" style={{left:`${percent(frame)}%`}} aria-hidden="true"/>}
      </div>
    </div>
    <div className={`kf-body ${curves?'show-curves':''}`}>
      <div className="kf-tracks">
        {ids.map((id,index)=><div key={id} className="kf-target-tracks">
          {ids.length>1&&<div className="kf-target-heading"><span>{targetName(scene,id)}{index>0?' · pinned':''}</span>{index>0&&<button type="button" aria-label={`Unpin ${targetName(scene,id)}`} onClick={()=>setPin(null)}>×</button>}</div>}
          {trackProperties(scene,id).map(property=>{
            const track=getTrack(scene,id,property),presentation=propertyPresentation(scene,id,property),value=getPropertyValue(scene,id,property,frame),isSelected=selected.componentId===id&&selected.property===property;
            const owned=boundedMotionReason(scene,frame,id,property),blocked=owned??animationBlockReason(scene,id,property);
            const currentKey=track?.keys.find(key=>key.frame===frame),name=channelName(scene,id,property),enabled=!!track?.enabled;
            const displayKeys=track?.keys??[];
            return <div className={`kf-row ${isSelected?'selected':''} ${enabled?'animated':''}`} key={property}>
              <div className="kf-property">
                <button type="button" className="kf-property-name" aria-pressed={isSelected} aria-label={`${targetName(scene,id)} ${name} property`} onClick={()=>setSelection({componentId:id,property})} title={`${targetName(scene,id)} → ${name}`}><span>{presentation.axis&&presentation.axis!=='X'?'':presentation.label}</span><small>{presentation.axis}</small></button>
                <ValueField label={`${targetName(scene,id)} ${name}`} value={value*presentation.factor} step={presentation.step} precision={presentation.precision} min={presentation.min} max={presentation.max} disabled={disabled||!!owned||(property==='motion'&&!enabled)} onCommit={nextValue=>{
                  if(!commit(next=>writeProperty(next,id,property,frame,nextValue/presentation.factor),id,property))return false;setSelection({componentId:id,property,...(enabled?{frame}: {})});
                }}/>
                <span className="kf-unit">{presentation.unit}</span>
                <button type="button" className="kf-enable" aria-pressed={enabled} aria-label={`${enabled?'Disable':'Enable'} ${targetName(scene,id)} ${name} animation`} title={owned??(enabled?'Disable animation; keep keys':blocked??(property==='motion'?'Edit the existing movement as keyframes':'Animate this property'))} disabled={disabled||!!owned||(!enabled&&!!blocked)}
                  onClick={()=>{if(!commit(next=>toggleTrack(next,id,property,frame),id,property))return;setSelection({componentId:id,property});}}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="9" r="5"/><path d="M6 1h4M8 1v3M8 6v3l2 1"/></svg></button>
                <button type="button" className={`kf-add ${enabled&&currentKey?'at-key':''}`} aria-label={`Add or update ${targetName(scene,id)} ${name} key at frame ${frame}`} title={blocked??(enabled&&currentKey?'Select key at playhead':'Record value at playhead')} disabled={disabled||!!blocked}
                  onClick={()=>currentKey&&enabled?selectKey(track!,currentKey):addAtPlayhead(id,property)}><span aria-hidden="true">◇</span></button>
              </div>
              <div className={`kf-lane ${enabled?'':'inactive'}`} onPointerDown={event=>{
                if(event.target!==event.currentTarget||disabled)return;
                const rect=event.currentTarget.getBoundingClientRect();onFrame(Math.max(1,Math.min(total,Math.round(1+(event.clientX-rect.left)/rect.width*(total-1)))));setSelection({componentId:id,property});
              }}>
                {(scene.shots??[]).slice(1).map((shot:any)=><span className="kf-shot-boundary" aria-hidden="true" key={shot.id} style={{left:`${percent(shot.startFrame)}%`}}/>)}
                {enabled&&displayKeys.length>1&&<span className="kf-key-span" style={{left:`${percent(displayKeys[0].frame)}%`,width:`${percent(displayKeys.at(-1)!.frame)-percent(displayKeys[0].frame)}%`}} aria-hidden="true"/>}
                {!displayKeys.length&&<span className="kf-static-label">{property==='motion'?'Timed movement · enable to edit keys':'All frames'}</span>}
                {!enabled&&!!displayKeys.length&&<span className="kf-static-label">{property==='motion'?'Timed movement · keys paused':'All frames · keys paused'}</span>}
                {displayKeys.map(key=>{
                  const keyFrame=dragPreview?.trackId===track!.id&&dragPreview.fromFrame===key.frame?dragPreview.toFrame:key.frame;
                  const keySelected=isSelected&&selected.frame===key.frame;
                  return <button type="button" key={key.frame} data-kf-track={track!.id} data-kf-frame={key.frame} className={`kf-key ${keySelected?'selected':''} ${key.interpolation==='hold'?'hold':''}`} style={{left:`${percent(keyFrame)}%`}} aria-pressed={keySelected}
                    aria-label={`${targetName(scene,id)} ${name}, frame ${key.frame}, ${rounded(key.value*presentation.factor,presentation.precision)} ${presentation.unit}`} disabled={disabled||!enabled}
                    title={owned??`Frame ${key.frame} · ${rounded(key.value*presentation.factor,presentation.precision)} ${presentation.unit} · ${key.interpolation}\nDrag to retime; arrow keys move one frame`}
                    onPointerDown={event=>beginDrag(event,track!,key)} onPointerMove={dragMove} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
                    onClick={event=>{if(event.detail===0)selectKey(track!,key);}} onKeyDown={event=>keyKeyboard(event,track!,key)}><span aria-hidden="true"/></button>;
                })}
                {!embedded&&<span className="kf-playhead" aria-hidden="true" style={{left:`${percent(frame)}%`}}/>}
              </div>
            </div>;
          })}
        </div>)}
      </div>
      {curves&&<div className="kf-curve-panel">
        <div className="kf-curve-caption"><span>{targetName(scene,selected.componentId)} → {channelName(scene,selected.componentId,selected.property)}</span><span>{info.unit}</span></div>
        {selectedTrack?.keys.length?<Curve track={selectedTrack} total={total} frame={frame} showPlayhead={!embedded} selectedFrame={selected.frame} dragFrame={dragPreview?.trackId===selectedTrack.id?dragPreview:undefined}
          onSelect={key=>selectKey(selectedTrack!,key)} onScrub={onFrame} onDrag={beginDrag} onDragMove={dragMove} onDragEnd={endDrag} onDragCancel={cancelDrag} onKey={keyKeyboard} disabled={disabled||!selectedTrack?.enabled} scene={scene}/>
          :<div className="kf-curve-empty"><span>{rounded(currentValue*info.factor,info.precision)} {info.unit} · all frames</span><button type="button" title={selectedOwner??animationBlockReason(scene,selected.componentId,selected.property)??undefined} onClick={()=>addAtPlayhead(selected.componentId,selected.property)} disabled={disabled||!!selectedOwner||!!animationBlockReason(scene,selected.componentId,selected.property)}>Record first key</button></div>}
      </div>}
    </div>
    <footer className="kf-footer">
      <span className="kf-edit-scope" title={`${targetName(scene,selected.componentId)} → ${channelName(scene,selected.componentId,selected.property)}`}>{info.label}{info.axis?` ${info.axis}`:''}<small>{selectedTrack?.enabled?`At ${formatAnimationTime(selectedKey?.frame??frame,fps)}`:selected.property==='motion'?'Timed movement':'All frames'}</small></span>
      <button type="button" className="kf-prev" aria-label="Previous keyframe" disabled={disabled||!beforeKey} onClick={()=>beforeKey&&selectKey(selectedTrack!,beforeKey)}>‹</button>
      <button type="button" className="kf-next" aria-label="Next keyframe" disabled={disabled||!afterKey} onClick={()=>afterKey&&selectKey(selectedTrack!,afterKey)}>›</button>
      {selectedKey&&selectedTrack?<>
        <label className="kf-exact"><span>Frame</span><ValueField label="Selected key frame" value={selectedKey.frame} min={1} max={total} step={1} disabled={disabled||!!selectedOwner||!selectedTrack.enabled} onCommit={value=>{
          const to=Math.round(value);if(selectedTrack.keys.some(key=>key.frame===to&&key.frame!==selectedKey.frame)){setNotice(`Frame ${to} already has a key.`);return false;}
          if(!commit(next=>moveKey(next,selectedTrack.id,selectedKey.frame,to)))return false;setSelection({...selected,frame:to});onFrame(to);
        }}/></label>
        <label className="kf-exact"><span>Value</span><ValueField label="Selected key value" value={selectedKey.value*info.factor} min={info.min} max={info.max} step={info.step} precision={info.precision} disabled={disabled||!!selectedOwner||!selectedTrack.enabled} onCommit={value=>commit(next=>upsertKey(next,selected.componentId,selected.property,selectedKey.frame,value/info.factor))}/><small>{info.unit}</small></label>
        <select className="kf-interpolation" aria-label="Following segment interpolation" value={selectedKey.interpolation} disabled={disabled||!!selectedOwner||!selectedTrack.enabled||selectedIndex===selectedTrack.keys.length-1} title={selectedIndex===selectedTrack.keys.length-1?'Add a later key to shape the next segment':'Changes the segment after this key'}
          onChange={event=>{const value=event.target.value as KeyframeInterpolation;commit(next=>setKeyInterpolation(next,selectedTrack.id,selectedKey.frame,value));}}><option value="linear">Linear</option><option value="ease">Ease</option><option value="hold">Hold</option></select>
        <button type="button" className="kf-delete" aria-label="Delete selected keyframe" title="Delete selected keyframe" disabled={disabled||!!selectedOwner} onClick={()=>{if(!commit(next=>removeKey(next,selectedTrack.id,selectedKey.frame)))return;setSelection({componentId:selected.componentId,property:selected.property});}}>Delete</button>
      </>:<span className="kf-hint">{selectedOwner??(selectedTrack?.enabled?'Change a value to record a key here.':'◷ enables animation. ◇ records a key.')}</span>}
      {notice&&<span className="kf-notice" role="status">{notice}</span>}
      <span className="kf-shortcuts" title="G move · R rotate · S scale in the viewport">G / R / S</span>
    </footer>
  </section>;
}
