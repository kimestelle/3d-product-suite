import {useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {createPortal} from 'react-dom';
import {NumberControl} from './EditorControls';
import {exactShotAtFrame, sequenceEnd, shotFrames, type Shot} from './sequence';
import {sceneFramesAfterTrim} from './filmTimelineModel';
import {sceneDropTarget, sceneReorderIndexForKey} from './sceneReorder';

/** Each frame owns one equal interval on the film; cuts sit between intervals. */
export function filmFrameAtPosition(x: number, left: number, width: number, total: number): number {
  return Math.max(1, Math.min(total, Math.floor((x - left) / Math.max(1, width) * total) + 1));
}
export function filmPlayheadPosition(frame: number, shot: Pick<Shot, 'startFrame' | 'endFrame'>): number {
  return (Math.max(shot.startFrame, Math.min(shot.endFrame, frame)) - shot.startFrame + .5) / (shot.endFrame - shot.startFrame + 1);
}
export function filmFrameForKey(key: string, frame: number, total: number, fps: number, shift = false): number | undefined {
  const step = shift ? 10 : 1;
  const next = key === 'Home' ? 1 : key === 'End' ? total :
    key === 'ArrowLeft' || key === 'ArrowDown' ? frame - step :
    key === 'ArrowRight' || key === 'ArrowUp' ? frame + step :
    key === 'PageUp' ? frame + fps : key === 'PageDown' ? frame - fps : undefined;
  return next === undefined ? undefined : Math.max(1, Math.min(total, next));
}
export interface FilmShotStripProps {
  scene: any; frame: number; editingFrame?: number; onFrame: (frame: number) => void; disabled?: boolean; onPlay?: () => void;
  onRename?: (id: string, name: string) => void;
  onImageFitChange?: (id: string, fit: 'contain' | 'cover') => void;
  onDurationChange?: (id: string, frames: number, operation: 'trim' | 'stretch') => void;
  onDuplicate?: (id: string) => void; onRemove?: (id: string) => void; onMove?: (id: string, direction: -1 | 1) => void;
  onReorder?: (id: string, index: number) => void; reorderDisabled?: boolean;
}

function SceneName({shot, disabled, onRename}: {shot: Shot; disabled?: boolean; onRename?: FilmShotStripProps['onRename']}) {
  const name = shot.name || 'Untitled scene', [draft, setDraft] = useState(name), skip = useRef(false);
  useEffect(() => setDraft(name), [name]);
  if (!onRename) return <strong>{name}</strong>;
  return <input className="film-scene-name" type="text" aria-label={`Scene name: ${name}`} title="Rename scene" maxLength={80} value={draft} disabled={disabled}
    onChange={event => setDraft(event.target.value)} onBlur={() => {
      const value = draft.trim(); setDraft(name);
      if (skip.current) {skip.current = false; return;}
      if (value && value !== name && !disabled) onRename(shot.id, value);
    }} onKeyDown={event => {
      if (event.key === 'Enter') {event.preventDefault(); event.currentTarget.blur();}
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); skip.current = true; setDraft(name); event.currentTarget.blur();}
    }}/>;
}

function SceneMenu({shot, index, props}: {shot: Shot; index: number; props: FilmShotStripProps}) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({left: 0, bottom: 0});
  const [operation, setOperation] = useState<'trim' | 'stretch'>('trim');
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId();
  const name = shot.name || 'Untitled scene', close = (focus = false) => {setOpen(false); if (focus) trigger.current?.focus();};
  useEffect(() => {if (props.disabled) close();}, [props.disabled]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: globalThis.PointerEvent) => {if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();};
    const cancel = () => close();
    document.addEventListener('pointerdown', outside); window.addEventListener('blur', cancel); window.addEventListener('resize', cancel); document.addEventListener('scroll', cancel, true);
    return () => {document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); document.removeEventListener('scroll', cancel, true);};
  }, [open]);
  const action = (callback: (() => void) | undefined) => {callback?.(); close(true);};
  return <><button type="button" ref={trigger} className="film-scene-menu-trigger" aria-label={`Scene options: ${name}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={props.disabled}
    onClick={() => {if (open) {close(true); return;} const bounds = trigger.current!.getBoundingClientRect(); setPosition({left: Math.max(8, Math.min(window.innerWidth - 260, bounds.right - 248)), bottom: window.innerHeight - bounds.top + 6}); setOpen(true);}}>···</button>
    {open && createPortal(<div className="gesso-scene-menu" id={id} role="dialog" aria-label={`Scene options: ${name}`} ref={panel} style={{left: position.left, bottom: position.bottom}}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') {event.preventDefault(); close(true);}
        if (event.key === 'Tab') {
          const controls = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
          else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
        }
      }}>
      <div className="film-scene-menu-heading"><strong>{name}</strong><button type="button" aria-label="Close scene options" onClick={() => close(true)}>×</button></div>
      {shot.kind === 'image' && <label className="film-duration-operation">Image fit<select aria-label="Image fit" value={shot.image?.fit ?? 'contain'} disabled={!props.onImageFitChange} onChange={event => props.onImageFitChange?.(shot.id, event.target.value as 'contain' | 'cover')}><option value="contain">Fit in frame</option><option value="cover">Fill frame</option></select></label>}
      <label className="film-duration-operation">Duration<select aria-label="Scene duration operation" disabled={!props.onDurationChange} value={operation} onChange={event => setOperation(event.target.value as 'trim' | 'stretch')}><option value="trim">Trim end</option><option value="stretch">Stretch scene</option></select></label>
      <NumberControl compact label="Length" ariaLabel="Scene duration in frames" value={shotFrames(shot)} min={1} step={1} unit="frames" disabled={!props.onDurationChange} onChange={value => props.onDurationChange?.(shot.id, Math.round(value), operation)}/>
      <p>{Number((shotFrames(shot) / props.scene.render.fps).toFixed(3))} s · {operation === 'trim' ? 'Keeps motion timing' : 'Retimes scene motions'}</p>
      <div className="film-scene-menu-actions"><button type="button" disabled={!props.onDuplicate} onClick={() => action(() => props.onDuplicate?.(shot.id))}>Duplicate scene</button>
      <button type="button" disabled={!props.onMove || index === 0} onClick={() => action(() => props.onMove?.(shot.id, -1))}>Move earlier</button>
      <button type="button" disabled={!props.onMove || index === props.scene.shots.length - 1} onClick={() => action(() => props.onMove?.(shot.id, 1))}>Move later</button>
      <button type="button" disabled={!props.onRemove || props.scene.shots.length === 1} onClick={() => action(() => props.onRemove?.(shot.id))}>Delete scene</button></div>
    </div>, document.body)}
  </>;
}

type TrimDrag = {pointerId: number; input: HTMLButtonElement; shot: Shot; x: number; width: number; total: number; frames: number};
type SceneDrag = {id:string; pointerId:number; input:HTMLButtonElement; startX:number; startY:number; startLeft:number; x:number; y:number; active:boolean; index:number; valid:boolean};

/** One time ruler scrubs the film; scene bodies reorder while inline controls stay editable. */
export function FilmShotStrip(props: FilmShotStripProps) {
  const {scene, frame, editingFrame = frame, onFrame, disabled, onPlay, onDurationChange} = props;
  const total = sequenceEnd(scene), fps = scene.render.fps, shot = exactShotAtFrame(scene, frame), editingShot = exactShotAtFrame(scene, editingFrame);
  const surface = useRef<HTMLDivElement>(null), drag = useRef<{pointerId: number; input: HTMLInputElement; original: number} | null>(null);
  const trim = useRef<TrimDrag | null>(null), [preview, setPreview] = useState<{id: string; frames: number} | null>(null);
  const reorder=useRef<SceneDrag|null>(null), [drop,setDrop]=useState<{id:string; index:number; boundary:number; valid:boolean; offset:number}|null>(null);
  const reorderButtons=useRef(new Map<string,HTMLButtonElement>()), restoreFocus=useRef<{id:string;index:number}|null>(null);
  const [placementAnnouncement,setPlacementAnnouncement]=useState('');
  const autoScroll=useRef(0), updateDropRef=useRef<()=>void>(()=>{});
  const cancelReorder=()=>{
    const active=reorder.current;reorder.current=null;setDrop(null);
    if(autoScroll.current)cancelAnimationFrame(autoScroll.current);autoScroll.current=0;
    if(active?.input.hasPointerCapture(active.pointerId))active.input.releasePointerCapture(active.pointerId);
  };
  const updateDrop=()=>{
    const active=reorder.current, bounds=surface.current?.getBoundingClientRect();
    if(!active||!bounds)return;
    active.valid=active.y>=bounds.top-32&&active.y<=bounds.bottom+32;
    if(!active.active&&Math.hypot(active.x-active.startX,active.y-active.startY)<6)return;
    active.active=true;
    const target=sceneDropTarget(scene.shots,active.id,active.x,bounds.left,bounds.width,total);
    active.index=target.index;
    setDrop({id:active.id,index:target.index,boundary:target.boundary,valid:active.valid,offset:active.x-active.startX+active.startLeft-bounds.left});
  };
  updateDropRef.current=updateDrop;
  const startAutoScroll=()=>{
    if(autoScroll.current)return;
    let previous=0;
    const tick=(now:number)=>{
      autoScroll.current=0;
      const active=reorder.current, scroller=surface.current?.closest<HTMLElement>('.film-time-scroll');
      if(!active)return;
      if(active.active&&active.valid&&scroller){
        const bounds=scroller.getBoundingClientRect(), edge=32;
        const speed=active.x<bounds.left+edge?-Math.min(1,(bounds.left+edge-active.x)/edge):active.x>bounds.right-edge?Math.min(1,(active.x-bounds.right+edge)/edge):0;
        const before=scroller.scrollLeft;
        scroller.scrollLeft+=speed*320*Math.min(32,previous?now-previous:16)/1000;
        if(before!==scroller.scrollLeft)updateDropRef.current();
      }
      previous=now;autoScroll.current=requestAnimationFrame(tick);
    };
    autoScroll.current=requestAnimationFrame(tick);
  };
  const cancel = (restore = false) => {
    const active = drag.current; drag.current = null;
    if (active?.input.hasPointerCapture(active.pointerId)) active.input.releasePointerCapture(active.pointerId);
    if (restore && active) onFrame(active.original);
  };
  const cancelTrim = () => {const active = trim.current; trim.current = null; setPreview(null); if (active?.input.hasPointerCapture(active.pointerId)) active.input.releasePointerCapture(active.pointerId);};
  useEffect(() => {if (disabled) {cancel(); cancelTrim();cancelReorder();}}, [disabled]);
  useEffect(()=>{if(props.reorderDisabled)cancelReorder();},[props.reorderDisabled]);
  useEffect(() => {
    const blur = () => {cancel(); cancelTrim();cancelReorder();}; window.addEventListener('blur', blur);window.addEventListener('resize',blur);
    return () => {window.removeEventListener('blur', blur);window.removeEventListener('resize',blur); cancel(); cancelTrim();cancelReorder();};
  }, []);
  useEffect(() => {cancelTrim();cancelReorder();}, [scene]);
  useEffect(()=>{
    const pending=restoreFocus.current;
    if(!disabled&&pending){
      reorderButtons.current.get(pending.id)?.focus({preventScroll:true});
      const index=scene.shots.findIndex((item:Shot)=>item.id===pending.id);
      if(index===pending.index)setPlacementAnnouncement(`${scene.shots[index].name||'Untitled scene'} moved to scene ${index+1} of ${scene.shots.length}.`);
      restoreFocus.current=null;
    }
  },[scene,disabled]);
  const seek = (event: PointerEvent<HTMLInputElement>) => {const bounds = event.currentTarget.getBoundingClientRect(); onFrame(filmFrameAtPosition(event.clientX, bounds.left, bounds.width, total));};
  const keyboard = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); cancel(true); return;}
    if (event.key === ' ') {event.preventDefault(); event.stopPropagation(); if (!event.repeat) onPlay?.(); return;}
    const next = filmFrameForKey(event.key, frame, total, fps, event.shiftKey);
    if (next !== undefined) {event.preventDefault(); event.stopPropagation(); onFrame(next);}
  };
  return <div className="film-shots" data-reorder={!!props.onReorder} onKeyDown={event => {if (event.key === 'Escape' && (trim.current||reorder.current)) {event.preventDefault(); event.stopPropagation(); cancelTrim();cancelReorder();}}}>
    <div className="film-shot-surface" ref={surface}>
      <div className="film-shot-row" role="list" aria-label="Film scenes">
        {(scene.shots as Shot[]).map((item, index) => {
          return <div className={`film-shot-box${item.id === editingShot?.id ? ' is-editing' : ''}${item.kind === 'image' ? ' is-image' : ''}${drop?.id===item.id?' is-dragging':''}`} role="listitem" key={item.id}
          style={{left: `${(item.startFrame - 1) / total * 100}%`, width: `${shotFrames(item) / total * 100}%`,...(drop?.id===item.id?{transform:`translateX(${drop.offset}px)`}:{})}} aria-current={item.id === shot?.id ? 'true' : undefined}
          title={`Scene ${index + 1}: ${item.name || 'Untitled scene'} · ${Number((shotFrames(item) / fps).toFixed(3))} s`}>
          {item.kind === 'image' && item.image?.asset?.path && <img className="film-shot-thumbnail" src={`/api/assets/${encodeURIComponent(item.image.asset.path.split('/').pop()!)}`} alt="" draggable={false}/>}
          {props.onReorder&&<button type="button" className="film-scene-reorder" aria-label={`Reorder scene: ${item.name||'Untitled scene'}`} aria-keyshortcuts="ArrowLeft ArrowRight Home End"
            title={props.reorderDisabled?'Click to seek · Pause film to reorder':'Drag to reorder · ← → move · Home / End first / last · Escape cancel'} disabled={disabled}
            ref={element=>{if(element)reorderButtons.current.set(item.id,element);else reorderButtons.current.delete(item.id);}}
            onPointerDown={event=>{
              if(disabled||event.button!==0||!event.isPrimary)return;
              event.preventDefault();event.stopPropagation();cancel();cancelTrim();event.currentTarget.focus({preventScroll:true});
              if(props.reorderDisabled){const bounds=surface.current!.getBoundingClientRect();onFrame(filmFrameAtPosition(event.clientX,bounds.left,bounds.width,total));return;}
              setPlacementAnnouncement('');reorder.current={id:item.id,pointerId:event.pointerId,input:event.currentTarget,startX:event.clientX,startY:event.clientY,startLeft:surface.current!.getBoundingClientRect().left,x:event.clientX,y:event.clientY,active:false,index,valid:true};
              event.currentTarget.setPointerCapture(event.pointerId);startAutoScroll();
            }} onPointerMove={event=>{const active=reorder.current;if(active?.pointerId!==event.pointerId)return;active.x=event.clientX;active.y=event.clientY;updateDrop();}}
            onPointerUp={event=>{
              const active=reorder.current;if(!active||active.pointerId!==event.pointerId)return;
              active.x=event.clientX;active.y=event.clientY;updateDrop();cancelReorder();
              if(active.active){if(active.valid&&active.index!==index){restoreFocus.current={id:item.id,index:active.index};props.onReorder?.(item.id,active.index);}}
              else if(active.valid){const bounds=surface.current!.getBoundingClientRect();onFrame(filmFrameAtPosition(event.clientX,bounds.left,bounds.width,total));}
            }} onPointerCancel={cancelReorder} onLostPointerCapture={cancelReorder}
            onClick={event=>{if(event.detail===0)onFrame(item.startFrame);}}
            onKeyDown={event=>{
              if(event.ctrlKey||event.metaKey||event.altKey||disabled||props.reorderDisabled)return;
              if(event.key==='Escape'&&reorder.current){event.preventDefault();event.stopPropagation();cancelReorder();return;}
              const next=sceneReorderIndexForKey(event.key,index,scene.shots.length);
              if(next!==undefined){event.preventDefault();event.stopPropagation();if(next!==index){setPlacementAnnouncement('');restoreFocus.current={id:item.id,index:next};props.onReorder?.(item.id,next);}}
            }}/>}
          <span className="film-shot-caption"><span>{String(index + 1).padStart(2, '0')}</span><SceneName shot={item} disabled={disabled} onRename={props.onRename}/></span>
          <small>{item.kind === 'image' && 'Image · '}{preview?.id === item.id ? `${preview.frames} frames` : `${Number((shotFrames(item) / fps).toFixed(3))} s`}</small>
          {props.onDuplicate && <SceneMenu shot={item} index={index} props={props}/>}
          {item.id === shot?.id && <span className="film-shot-playhead" aria-hidden="true" style={{left: `clamp(1px, ${filmPlayheadPosition(frame, item) * 100}%, calc(100% - 1px))`}}/>}
          {onDurationChange && <button type="button" className="film-scene-trim" aria-label={`Trim scene end: ${item.name || 'Untitled scene'}`} title="Drag to trim · ← → one frame · Shift ten frames" disabled={disabled}
            onPointerDown={event => {
              if (disabled || event.button !== 0) return;
              event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
              trim.current = {pointerId: event.pointerId, input: event.currentTarget, shot: item, x: event.clientX, width: surface.current!.getBoundingClientRect().width, total, frames: shotFrames(item)};
              event.currentTarget.setPointerCapture(event.pointerId);
            }} onPointerMove={event => {
              const active = trim.current; if (!active || active.pointerId !== event.pointerId) return;
              active.frames = sceneFramesAfterTrim(shotFrames(active.shot), event.clientX - active.x, active.width, active.total);
              setPreview({id: item.id, frames: active.frames});
            }} onPointerUp={event => {
              const active = trim.current; if (!active || active.pointerId !== event.pointerId) return;
              cancelTrim(); if (active.frames !== shotFrames(active.shot)) onDurationChange(active.shot.id, active.frames, 'trim');
            }} onPointerCancel={cancelTrim} onLostPointerCapture={cancelTrim} onKeyDown={event => {
              if (event.ctrlKey || event.metaKey || event.altKey || disabled || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation(); onDurationChange(item.id, Math.max(1, shotFrames(item) + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1)), 'trim');
            }}/>}
        </div>;})}
      </div>
      {drop&&drop.valid&&drop.index!==scene.shots.findIndex((item:Shot)=>item.id===drop.id)&&<span className="film-scene-drop-marker" aria-hidden="true" style={{left:`clamp(1px, ${drop.boundary/total*100}%, calc(100% - 1px))`}}/>}
      <span className="gesso-sr-only" role="status">{drop ? drop.valid?`Move scene to position ${drop.index+1} of ${scene.shots.length}. Release to place; Escape to cancel.`:'Outside timeline. Release to cancel.':placementAnnouncement}</span>
      {preview && <span className="film-trim-preview" aria-hidden="true" style={{left: `${(scene.shots.find((item: Shot) => item.id === preview.id).startFrame - 1 + preview.frames) / total * 100}%`}}/>}
      <input className="film-shot-seek" type="range" aria-label="Film playhead" min={1} max={total} step={1} value={frame} disabled={disabled}
        aria-valuetext={`${((frame - 1) / fps).toFixed(2)} seconds · ${shot ? shot.name || 'Untitled scene' : 'No scene'} · frame ${frame} of ${total}`}
        title="Scrub the time ruler · ← → one frame · Shift ten frames · Space play / pause"
        onChange={event => onFrame(Number(event.target.value))} onKeyDown={keyboard}
        onPointerDown={event => {if (disabled || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = {pointerId: event.pointerId, input: event.currentTarget, original: frame}; event.currentTarget.setPointerCapture(event.pointerId); seek(event);}}
        onPointerMove={event => {if (drag.current?.pointerId === event.pointerId) seek(event);}}
        onPointerUp={event => {if (drag.current?.pointerId === event.pointerId) {seek(event); cancel();}}}
        onPointerCancel={() => cancel(true)} onLostPointerCapture={() => cancel()}/>
    </div>
  </div>;
}
