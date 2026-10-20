import {useEffect, useRef, useState, type ReactNode, type PointerEvent, type KeyboardEvent} from 'react';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import {FilmShotStrip} from './FilmShotStrip';
import type {FilmWorkspaceProps} from './FilmWorkspace';
import {addShot, duplicateShot, exactShotAtFrame, moveShot, removeShot, reorderShot, sequenceEnd, setSequenceFrames, setShotFrames, shotAtFrame, shotFrames, stretchShotFrames, type Shot} from './sequence';
import {frameAfterSceneReorder} from './sceneReorder';
import {setMotionKeys, updateMotion, type FilmMotion, type MotionEntry} from './filmMotion';
import {clamp, round, filmTargetName, labelFor, legacyMotions, motionBounds, useFilmEdits} from './FilmWorkspaceShared';
import {motionStartAfterDrag, motionStartMaximum, timelineMotionBounds, timelineMotions} from './filmTimelineModel';
import './film-timeline.css';

export interface FilmTimelineProps extends FilmWorkspaceProps {editingFrame?: number; onOutput?: () => void; detailContent?: ReactNode; onImportImage?: () => void; importingImage?: boolean}
type ProgressKey = NonNullable<FilmMotion['keys']>[number];
type BlockDrag = {entry: MotionEntry; pointerId: number; input: HTMLButtonElement; pointerX: number; width: number; original: number; destination: number; max: number; total: number};
const entryKey = (entry: MotionEntry) => `${entry.scope}/${entry.shotId ?? ''}/${entry.motion.id}`;
function Notice({error}: {error: string}) {return error ? <p className="film-error" role="alert">{error}</p> : null;}

export function FilmTimeline(props: FilmTimelineProps) {
  const {scene, frame, editingFrame = frame, selectedTarget, onFrame, selectedMotionId, onMotionSelect, onTargetChange, disabled, playing, onPlay, editCurves, onEditCurves, onResetView} = props;
  const editingShot = exactShotAtFrame(scene, editingFrame), shot = editingShot ?? shotAtFrame(scene, editingFrame), fps = scene.render.fps, total = sequenceEnd(scene);
  const entries = timelineMotions(scene, selectedTarget), legacy = legacyMotions(scene).filter(entry => entry.target === selectedTarget);
  const selected = editingShot?.kind !== 'image' && editingShot ? entries.find(entry => entry.motion.id === selectedMotionId && (entry.scope === 'film' || entry.shotId === editingShot.id)) : undefined;
  const [preview, setPreview] = useState<{key: string; startFrame: number} | null>(null);
  const drag = useRef<BlockDrag | null>(null), {edit, error} = useFilmEdits(props);
  const cancelDrag = () => {
    const active = drag.current; drag.current = null; setPreview(null);
    if (active?.input.hasPointerCapture(active.pointerId)) active.input.releasePointerCapture(active.pointerId);
  };
  useEffect(() => {cancelDrag();}, [disabled, selectedTarget, scene]);
  useEffect(() => {window.addEventListener('blur', cancelDrag); return () => {window.removeEventListener('blur', cancelDrag); cancelDrag();};}, []);
  const seekFilm = (next: number) => {
    if (disabled) return;
    cancelDrag();
    if (exactShotAtFrame(scene, next)?.id !== shot?.id) {
      if (!props.detailContent) {onMotionSelect(null); onEditCurves?.(false);}
      onResetView?.();
    }
    onFrame(next);
  };
  const sequenceEdit = (id: string | undefined, mutate: (draft: any) => string | void) => {
    const result = edit(mutate); if (!result) return;
    const next = result.draft.shots.find((candidate: Shot) => candidate.id === (result.value || id)) ?? result.draft.shots[0];
    onFrame(next.startFrame); onMotionSelect(null); onEditCurves?.(false); onResetView?.();
  };
  const chooseMotion = (entry: MotionEntry) => {
    onTargetChange(entry.motion.target); onMotionSelect(entry.motion.id);
    if (entry.scope === 'shot' && entry.shotId !== shot.id) {
      const owner = scene.shots.find((candidate: Shot) => candidate.id === entry.shotId);
      onFrame(owner.startFrame); onResetView?.();
    }
  };
  const ownerId = (entry: MotionEntry) => entry.shotId ?? shot.id;
  const beginDrag = (event: PointerEvent<HTMLButtonElement>, entry: MotionEntry) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); chooseMotion(entry);
    drag.current = {entry, pointerId: event.pointerId, input: event.currentTarget, pointerX: event.clientX,
      width: event.currentTarget.parentElement!.getBoundingClientRect().width, original: entry.motion.startFrame,
      destination: entry.motion.startFrame, max: motionStartMaximum(scene, entry), total};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const dragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    active.destination = motionStartAfterDrag(active.original, event.clientX - active.pointerX, active.width, active.total, active.max);
    setPreview({key: entryKey(active.entry), startFrame: active.destination});
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current; if (!active || active.pointerId !== event.pointerId) return;
    cancelDrag();
    if (active.original !== active.destination) edit(draft => updateMotion(draft, ownerId(active.entry), active.entry.motion.id, {startFrame: active.destination}));
  };
  const moveByKey = (event: KeyboardEvent<HTMLButtonElement>, entry: MotionEntry) => {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const next = clamp(entry.motion.startFrame + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1), 1, motionStartMaximum(scene, entry));
    if (next !== entry.motion.startFrame) edit(draft => updateMotion(draft, ownerId(entry), entry.motion.id, {startFrame: next}));
  };
  const hasTracks = !!shot && (entries.length > 0 || legacy.length > 0);
  return <section className={`film-timeline${editCurves && selected ? ' is-editing-curve' : ''}${props.detailContent ? ' is-editing-keys' : ''}`} aria-label="Film timeline" onKeyDown={event => {
    if (event.key === 'Escape' && drag.current) {event.preventDefault(); cancelDrag();}
    const target = event.target as HTMLElement;
    const editingText = target.isContentEditable || !!target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
    if (event.key === ' ' && !editingText && target.tagName !== 'BUTTON' && !event.ctrlKey && !event.metaKey && !event.altKey) {event.preventDefault(); if (!event.repeat && !disabled) onPlay?.();}
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
  }}>
    <header className="film-timeline-toolbar">
      <div className="film-transport"><button type="button" className="film-play" aria-label={playing ? 'Pause film' : 'Play film'} onClick={onPlay} disabled={disabled || !onPlay}>{playing ? 'Pause' : 'Play'}</button>
      <time>{round((frame - 1) / fps)} s</time></div>
      <div className="film-timeline-actions"><div className="film-total-duration" title="Stretches all scenes and their motion to fit the movie"><NumberControl compact label="Duration" ariaLabel="Movie duration in seconds" value={total / fps} min={1 / fps} step={1 / fps} unit="s" disabled={disabled} onChange={value => {
        const result = edit(draft => setSequenceFrames(draft, Math.round(value * fps)));
        if (result) {
          const nextShot = result.draft.shots.find((item: Shot) => item.id === shot?.id);
          const progress = shot ? clamp((editingFrame - shot.startFrame) / Math.max(1, shotFrames(shot) - 1), 0, 1) : 0;
          onFrame(nextShot ? nextShot.startFrame + Math.round(progress * (shotFrames(nextShot) - 1)) : 1);
        }
      }}/></div><button type="button" onClick={() => props.onCreateShot ? props.onCreateShot() : sequenceEdit(shot?.id, draft => addShot(draft, shot?.id))} disabled={disabled}><UiIcon name="plus"/>New scene</button>
      {props.onImportImage && <button type="button" onClick={props.onImportImage} disabled={disabled || props.importingImage}>{props.importingImage ? 'Importing image…' : 'Add image'}</button>}
      {props.onOutput && <button type="button" className="film-output-action" onClick={props.onOutput}>Output <UiIcon name="chevron"/></button>}</div>
    </header>
    <div className="film-time-scroll"><div className="film-time-surface">
      <div className="film-time-ruler" aria-hidden="true"><span className="film-row-label">Scenes</span><div>{[0, .25, .5, .75, 1].map(fraction => <span key={fraction} style={{left: `${fraction * 100}%`}}>{round(fraction * total / fps)} s</span>)}</div></div>
      <div className="film-scenes-lane"><span className="film-row-label">{scene.shots.length} {scene.shots.length === 1 ? 'scene' : 'scenes'}</span>
      <FilmShotStrip scene={scene} frame={frame} editingFrame={editingFrame} onFrame={seekFilm} disabled={disabled} onPlay={onPlay}
        reorderDisabled={playing}
        onReorder={(id,index)=>{
          if(scene.shots.findIndex((candidate:Shot)=>candidate.id===id)===index)return;
          const result=edit(draft=>reorderShot(draft,id,index));
          if(result)onFrame(frameAfterSceneReorder(scene,result.draft,editingFrame));
        }}
        onRename={(id, name) => edit(draft => {draft.shots.find((candidate: Shot) => candidate.id === id).name = name;})}
        onImageFitChange={(id, fit) => edit(draft => {const image = draft.shots.find((candidate: Shot) => candidate.id === id)?.image; if (image) image.fit = fit;})}
        onDurationChange={(id, frames, operation) => sequenceEdit(id, draft => (operation === 'trim' ? setShotFrames : stretchShotFrames)(draft, id, frames))}
        onDuplicate={id => sequenceEdit(id, draft => duplicateShot(draft, id))} onRemove={id => sequenceEdit(id, draft => removeShot(draft, id))}
        onMove={(id, direction) => sequenceEdit(id, draft => moveShot(draft, id, direction))}/></div>
      {hasTracks && <div className="film-motion-tracks" aria-label={`${filmTargetName(scene, selectedTarget)} motions`}>
        {entries.map(entry => {
          const displayed = preview?.key === entryKey(entry) ? {...entry, motion: {...entry.motion, startFrame: preview.startFrame}} : entry;
          const bounds = timelineMotionBounds(scene, displayed), isSelected = selected === entry;
          const owner = entry.scope === 'shot' ? scene.shots.find((candidate: Shot) => candidate.id === entry.shotId) : undefined;
          const scope = owner ? owner.name || 'Untitled scene' : 'Across cuts';
          return <div key={entryKey(entry)} className={`film-motion-row${isSelected ? ' is-selected' : ''}`} data-motion-id={entry.motion.id} data-shot-id={entry.shotId}>
            <button type="button" className="film-track-name" onClick={() => chooseMotion(entry)} aria-pressed={isSelected}><span>{labelFor(scene, entry.motion)}</span><small>{scope}</small></button>
            <div className="film-track-lane">
              {bounds.visible ? <button type="button" className={`film-motion-block${!entry.motion.enabled ? ' is-disabled' : ''}`} style={{left: `${bounds.left}%`, width: `${bounds.width}%`}}
                aria-label={`${labelFor(scene, entry.motion)} on ${filmTargetName(scene, entry.motion.target)}, ${owner ? `scene ${scope}` : 'across cuts'}. Arrow keys move one frame; Shift moves ten.`} aria-pressed={isSelected}
                title={`${labelFor(scene, entry.motion)} · ${round((entry.motion.durationFrames - 1) / fps)} s${bounds.clipped ? ' · clipped at scene boundary' : ''}`} disabled={disabled}
                onPointerDown={event => beginDrag(event, entry)} onPointerMove={dragMove} onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onKeyDown={event => moveByKey(event, entry)} onClick={() => chooseMotion(entry)}>
                <span>{labelFor(scene, entry.motion)}{!entry.motion.enabled && ' · off'}</span>{bounds.clipped && <small>clipped</small>}
              </button> : <button type="button" className="film-outside-motion" onClick={() => chooseMotion(entry)}>{labelFor(scene, entry.motion)} <small>Outside scene</small></button>}
            </div>
          </div>;
        })}
        {legacy.map(motion => {
          const start = Math.max(1, motion.start), end = Math.min(total, motion.end), visible = end >= start;
          const open = () => {onMotionSelect(null); props.onLegacyAnimation?.();};
          return <div className="film-motion-row film-legacy-row" key={motion.id}>
            <button type="button" className="film-track-name" onClick={open} disabled={!props.onLegacyAnimation}><span>{motion.name}</span><small>Across cuts</small></button>
            <div className="film-track-lane">{visible ? <button type="button" className="film-motion-block film-legacy-block" style={{left: `${(start - 1) / total * 100}%`, width: `${(end - start + 1) / total * 100}%`}} onClick={open} disabled={!props.onLegacyAnimation} aria-label={`${filmTargetName(scene, motion.target)} ${motion.name}, existing animation across cuts`}><span>{motion.name}</span><small>existing</small></button> : <span className="film-outside-motion">Outside film</span>}</div>
          </div>;
        })}
      </div>}
    </div></div>
    {!props.detailContent && selected && editCurves && <FilmMotionCurve {...props} entry={selected}/>}
    {props.detailContent}
    <Notice error={error}/>
  </section>;
}

function progressAt(keys: ProgressKey[], frame: number) {
  if (frame <= keys[0].frame) return keys[0].value;
  for (let index = 1; index < keys.length; index++) {
    const left = keys[index - 1], right = keys[index];
    if (frame > right.frame) continue;
    let progress = (frame - left.frame) / Math.max(1, right.frame - left.frame);
    if (left.interpolation === 'hold') progress = frame < right.frame ? 0 : 1;
    else if (left.interpolation === 'ease') progress = progress * progress * (3 - 2 * progress);
    return left.value + (right.value - left.value) * progress;
  }
  return keys.at(-1)!.value;
}

function FilmMotionCurve(props: FilmTimelineProps & {entry: MotionEntry}) {
  const {scene, frame, entry, disabled, onFrame, onEditCurves} = props;
  const shot = entry.shotId ? scene.shots.find((candidate: Shot) => candidate.id === entry.shotId) : shotAtFrame(scene, props.editingFrame ?? frame), motion = entry.motion;
  const keys: ProgressKey[] = motion.keys ?? [{frame: 1, value: 0, interpolation: motion.easing}, {frame: motion.durationFrames, value: 1, interpolation: motion.easing}];
  const [selectedFrame, setSelectedFrame] = useState(1), {edit, error} = useFilmEdits(props);
  const selectedKey = keys.find(key => key.frame === selectedFrame) ?? keys[0];
  useEffect(() => setSelectedFrame(1), [motion.id]);
  const bounds = motionBounds(entry, shot), local = clamp(frame - bounds.start + 1, 1, motion.durationFrames);
  const x = (value: number) => (value - 1) / Math.max(1, motion.durationFrames - 1) * 100;
  const update = (patch: Partial<ProgressKey>) => {
    const next = keys.map(key => key === selectedKey ? {...key, ...patch} : key).sort((a, b) => a.frame - b.frame);
    if (edit(draft => setMotionKeys(draft, shot.id, motion.id, next)) && patch.frame !== undefined) setSelectedFrame(patch.frame);
  };
  let path = `M0,${100 - keys[0].value * 100}L${x(keys[0].frame)},${100 - keys[0].value * 100}`;
  for (let index = 1; index < keys.length; index++) {
    const left = keys[index - 1], right = keys[index], dx = x(right.frame) - x(left.frame), y1 = 100 - left.value * 100, y2 = 100 - right.value * 100;
    path += left.interpolation === 'hold' ? `H${x(right.frame)}V${y2}` : left.interpolation === 'linear' ? `L${x(right.frame)},${y2}` : `C${x(left.frame) + dx / 3},${y1} ${x(right.frame) - dx / 3},${y2} ${x(right.frame)},${y2}`;
  }
  path += `H100`;
  return <section className="film-curve" aria-label="Motion progress curve">
    <div className="film-curve-toolbar"><strong>{labelFor(scene, motion)} / progress</strong><button type="button" disabled={disabled || keys.some(key => key.frame === local)} onClick={() => {const next = [...keys, {frame: local, value: progressAt(keys, local), interpolation: motion.easing}].sort((a, b) => a.frame - b.frame); if (edit(draft => setMotionKeys(draft, shot.id, motion.id, next))) setSelectedFrame(local);}}>Add key at playhead</button><button type="button" disabled={disabled || !motion.keys} onClick={() => edit(draft => setMotionKeys(draft, shot.id, motion.id, undefined))}>Reset curve</button><button type="button" onClick={() => onEditCurves?.(false)}>Close</button></div>
    <div className="film-curve-body"><div className="film-curve-axis"><span>100%</span><span>0%</span></div><div className="film-curve-plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0H100M0 50H100M0 100H100" className="film-curve-grid"/><path d={path} className="film-curve-line"/></svg>

      <div className="film-curve-clock" aria-label="Motion time in seconds">{[0, .5, 1].map(fraction => <span key={fraction}>{round(fraction * (motion.durationFrames - 1) / scene.render.fps)} s</span>)}</div>
      {keys.map(key => <button type="button" key={key.frame} className="film-curve-key" style={{left: `${x(key.frame)}%`, top: `${100 - key.value * 100}%`}} aria-label={`Progress key at frame ${key.frame}, ${round(key.value * 100)} percent`} aria-pressed={key.frame === selectedKey.frame} disabled={disabled} onClick={() => {setSelectedFrame(key.frame); onFrame(clamp(bounds.start + key.frame - 1, entry.scope === 'shot' ? shot.startFrame : 1, entry.scope === 'shot' ? shot.endFrame : sequenceEnd(scene)));}}><span/></button>)}
    </div><div className="film-curve-values"><NumberControl compact label="Frame" ariaLabel="Progress key frame" value={selectedKey.frame} min={1} max={motion.durationFrames} step={1} disabled={disabled} onChange={value => update({frame: Math.round(value)})}/><NumberControl compact label="Progress" ariaLabel="Progress key value" value={selectedKey.value * 100} min={0} max={100} unit="%" step={1} disabled={disabled} onChange={value => update({value: value / 100})}/><select aria-label="Key interpolation" value={selectedKey.interpolation} disabled={disabled} onChange={event => update({interpolation: event.target.value as ProgressKey['interpolation']})}><option value="ease">Ease in / out</option><option value="linear">Constant speed</option><option value="hold">Hold</option></select><button type="button" disabled={disabled || keys.length <= 2} onClick={() => {if (edit(draft => setMotionKeys(draft, shot.id, motion.id, keys.filter(key => key !== selectedKey)))) setSelectedFrame(keys[0].frame);}}>Remove key</button></div></div>
    <Notice error={error}/>
  </section>;
}
