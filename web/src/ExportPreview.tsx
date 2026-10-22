import {memo, useLayoutEffect, useRef, useState} from 'react';
import {filmGateRect} from './filmGuides';
import type {ExportMode} from './exportModel';
import {FilmTransport} from './FilmTransport';
import {FilmFrameMarks} from './FilmViewportControls';

/** Mask the overscan using the very same gate that sets the live camera's projection. */
export const ExportPreviewMask = memo(function ExportPreviewMask({aspect}:{aspect:number}) {
  const mask = useRef<HTMLDivElement>(null);
  const [size,setSize] = useState({width:0,height:0});
  useLayoutEffect(()=>{
    const pane=mask.current?.parentElement;if(!pane)return;
    const measure=()=>{const {width,height}=pane.getBoundingClientRect();setSize(previous=>previous.width===width&&previous.height===height?previous:{width,height})};
    const observer=new ResizeObserver(measure);observer.observe(pane);measure();
    return()=>observer.disconnect();
  },[]);
  const gate=filmGateRect(size.width,size.height,aspect);
  return <div ref={mask} className="gesso-export-preview-mask" aria-hidden="true" style={gate.width?{left:gate.x,top:gate.y,width:gate.width,height:gate.height}:{inset:0,background:'var(--chrome)'}}>{gate.width>0&&<FilmFrameMarks/>}</div>;
});

export function ExportPreviewTransport({mode,frame,total,fps,playing,disabled,onPlay,onFrame,paired=false,sourceLabel='Current scene'}:{
  mode:ExportMode;frame:number;total:number;fps:number;playing:boolean;disabled:boolean;onPlay:()=>void;onFrame:(frame:number)=>void;paired?:boolean;sourceLabel?:string;
}) {
  return <div className="gesso-export-preview-chrome">
    <div className="gesso-export-preview-heading"><span>{sourceLabel}</span><span>{paired?'A / B · ':''}{mode==='still'?'Still':'Video'}</span></div>
    <div className="gesso-export-preview-transport" aria-label="Export preview playback">
      {mode==='video'&&<FilmTransport context="export preview" playing={playing} disabled={disabled} atStart={frame<=1} atEnd={frame>=total} onPlay={onPlay} onStart={()=>onFrame(1)} onEnd={()=>onFrame(total)}/>}
      <span className="gesso-export-preview-time">{((frame-1)/fps).toFixed(2)} / {(total/fps).toFixed(2)} s</span>
      <input type="range" aria-label={mode==='still'?'Choose export frame':'Scrub export preview'} min={1} max={total} step={1} value={frame} disabled={disabled} onChange={event=>onFrame(Number(event.target.value))}/>
      <label className="gesso-export-preview-frame">Frame<input type="number" aria-label="Export preview frame" min={1} max={total} step={1} value={frame} disabled={disabled} onChange={event=>{if(event.target.value!=='')onFrame(Math.max(1,Math.min(total,Math.round(Number(event.target.value)))))}}/></label>
    </div>
  </div>;
}
