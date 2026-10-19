import {useEffect, useRef, useState, type ReactNode, type PointerEvent, type KeyboardEvent} from 'react';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import {FilmShotStrip} from './FilmShotStrip';
import {displayPartName} from './hierarchy';
import {addShot, duplicateShot, moveShot, removeShot, sequenceEnd, setShotFrames, shotAtFrame, shotFrames, stretchShotFrames} from './sequence';
import {addMotion, availableMotionKinds, changeMotionScope, listMotions, motionLabel, removeMotion, setMotionKeys, updateMotion, type FilmMotion, type MotionKind} from './filmMotion';
import './film-workspace.css';

export interface FilmWorkspaceProps {
  scene: any;
  mode?: 'still' | 'video';
  frame: number;
  onFrame: (frame: number) => void;
  onChange: (edit: (scene: any) => void) => void;
  selectedTarget: string;
  onTargetChange: (id: string) => void;
  selectedMotionId: string | null;
  onMotionSelect: (id: string | null) => void;
  playing?: boolean;
  onPlay?: () => void;
  disabled?: boolean;
  editCurves?: boolean;
  onEditCurves?: (open: boolean) => void;
  onLegacyAnimation?: () => void;
  onResetView?: () => void;
  onCreateShot?: () => void;
}

type MotionEntry = ReturnType<typeof listMotions>[number];
type ProgressKey = NonNullable<FilmMotion['keys']>[number];
const round = (value: number) => Number(value.toFixed(3));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function filmTargetName(scene: any, id: string): string {
  return id === '$camera' ? 'Camera' : id === '$product' ? 'Whole product' : displayPartName(scene, id);
}

function actionName(scene: any, target: string, kind: MotionKind): string {
  if (kind === 'mechanical') return scene.actions?.find((action: any) => action.componentId === target)?.type === 'screw' ? 'Unscrew' : 'Lift';
  return {move: 'Move', rotate: 'Rotate', scale: 'Scale', orbit: 'Orbit', dolly: 'Push in'}[kind];
}

function labelFor(scene: any, motion: FilmMotion) {
  return motion.kind === 'mechanical' || motion.kind === 'dolly' ? actionName(scene, motion.target, motion.kind) : motionLabel(motion);
}

export function motionMeasure(motion: FilmMotion) {
  if (motion.kind === 'move' || motion.kind === 'dolly') return {label: 'Distance', factor: 1000, unit: 'mm', step: 1};
  if (motion.kind === 'rotate' || motion.kind === 'orbit') return {label: 'Angle', factor: 1, unit: '°', step: 1};
  if (motion.kind === 'scale') return {label: 'Final size', factor: 100, unit: '%', step: 1};
  return {label: 'Travel', factor: 100, unit: '%', step: 1};
}

export function motionBounds(entry: MotionEntry, shot: any) {
  const start = entry.motion.startFrame + (entry.scope === 'shot' ? shot.startFrame - 1 : 0);
  return {start, end: start + entry.motion.durationFrames - 1};
}

function legacyCount(scene: any, target: string): number {
  return (scene.actions ?? []).filter((action: any) => action.componentId === target).length +
    (scene.animation?.tracks ?? []).filter((track: any) => track.componentId === target).length;
}

function legacyMotions(scene: any) {
  const tracks = scene.animation?.tracks ?? [];
  const actions = (scene.actions ?? []).map((action: any, index: number) => {
    const driver = tracks.find((track: any) => track.componentId === action.componentId && track.property === 'motion' && track.enabled);
    return {id: `legacy-action-${index}`, target: action.componentId, name: action.type === 'screw' ? 'Unscrew' : 'Lift',
      start: driver?.keys[0]?.frame ?? Math.round(action.startSeconds * scene.render.fps) + 1,
      end: driver?.keys.at(-1)?.frame ?? Math.round((action.startSeconds + action.durationSeconds) * scene.render.fps) + 1};
  });
  const targets = [...new Set<string>(tracks.filter((track: any) => track.property !== 'motion' || !actions.some((action: any) => action.target === track.componentId)).map((track: any) => track.componentId))];
  return [...actions, ...targets.map(target => {
    const keys = tracks.filter((track: any) => track.componentId === target).flatMap((track: any) => track.keys);
    return {id: `legacy-keys-${target}`, target, name: 'Custom keys', start: Math.min(...keys.map((key: any) => key.frame)), end: Math.max(...keys.map((key: any) => key.frame))};
  })];
}

/** Validate on a draft before notifying the app, so a rejected edit never changes selection. */
function useFilmEdits({scene, onChange, disabled}: FilmWorkspaceProps) {
  const [error, setError] = useState('');
  useEffect(() => setError(''), [scene.sceneId]);
  const edit = <T,>(mutate: (draft: any) => T): {value: T; draft: any} | undefined => {
    if (disabled) return;
    try {
      const draft = structuredClone(scene), value = mutate(draft);
      onChange(next => {
        next.shots = draft.shots;
        next.render = draft.render;
        if (draft.motions !== undefined) next.motions = draft.motions;
        if (draft.animation !== undefined) next.animation = draft.animation;
      });
      setError('');
      return {value, draft};
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'This edit could not be applied.');}
  };
  return {edit, error, setError};
}

function Notice({error}: {error: string}) {return error ? <p className="film-error" role="alert">{error}</p> : null;}

function ShotName({name, disabled, onCommit}: {name: string; disabled?: boolean; onCommit: (name: string) => void}) {
  const [draft, setDraft] = useState(name), skipBlur = useRef(false);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    if (skipBlur.current) {skipBlur.current = false; return;}
    const next = draft.trim();
    setDraft(name);
    if (next && next !== name && !disabled) onCommit(next);
  };
  return <input type="text" className="film-shot-name" aria-label="Shot name" title="Rename shot" value={draft} maxLength={80} disabled={disabled}
    onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => {
      if (event.key === 'Enter') {event.preventDefault(); event.stopPropagation(); event.currentTarget.blur();}
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); skipBlur.current = true; setDraft(name); event.currentTarget.blur();}
    }}/>;
}

/** Both rails read their context from the same shot as the film playhead. */
export function FilmShotHeader({scene, frame}: Pick<FilmWorkspaceProps, 'scene' | 'frame'>) {
  const shot = shotAtFrame(scene, frame);
  const number = String(scene.shots.findIndex((item: any) => item.id === shot.id) + 1).padStart(2, '0');
  const name = shot.name || 'Untitled shot';
  return <h2 className="film-shot-header" aria-label={`Shot ${number}: ${name}`} title={`${number} ${name}`}>
    <span className="film-shot-number">{number}</span><span className="film-shot-title">{name}</span>
  </h2>;
}

export function FilmObjects(props: FilmWorkspaceProps) {
  const {scene, frame, selectedTarget, onTargetChange, selectedMotionId, onMotionSelect, onFrame, disabled, onLegacyAnimation, onEditCurves} = props;
  const shot = shotAtFrame(scene, frame), entries = props.mode === 'still' ? [] : listMotions(scene, shot.id);
  const {edit, error} = useFilmEdits(props);
  const targets = ['$camera', '$product', ...scene.product.components.map((part: any) => part.id)];
  const chooseTarget = (target: string) => {onTargetChange(target); onMotionSelect(null); onEditCurves?.(false);};
  const add = (kind: MotionKind) => {
    const result = edit(draft => addMotion(draft, shot.id, selectedTarget, kind));
    if (result) {onMotionSelect(result.value); onEditCurves?.(false); onFrame(shot.startFrame);}
  };
  return <div className="gesso-panel film-objects">
    <div className="film-object-list" aria-label="Shot objects">
      {targets.map(target => {
        const motions = entries.filter(entry => entry.motion.target === target), current = target === selectedTarget;
        return <div className={`film-object${current ? ' is-selected' : ''}`} key={target}>
          <button type="button" className="film-object-name" aria-pressed={current} onClick={() => chooseTarget(target)}>
            <span>{target === '$camera' ? <UiIcon name="circle"/> : target === '$product' ? <UiIcon name="chevron" size={12}/> : <span className="film-part-mark"/>}{filmTargetName(scene, target)}</span>
            <small>{motions.length ? `${motions.length} ${motions.length === 1 ? 'motion' : 'motions'}` : target === '$camera' ? 'frame' : 'pose'}</small>
          </button>
          {current && motions.length > 0 && <div className="film-object-motions" aria-label={`${filmTargetName(scene, target)} motions`}>
            {motions.map(entry => <button type="button" key={entry.motion.id} className="film-motion-link" aria-pressed={selectedMotionId === entry.motion.id} onClick={() => {onMotionSelect(entry.motion.id); onEditCurves?.(false);}}>
              <span>{labelFor(scene, entry.motion)}{!entry.motion.enabled && <small> · off</small>}</span><small>{entry.scope === 'film' ? 'Across cuts' : 'This shot'}</small>
            </button>)}
          </div>}
        </div>;
      })}
    </div>
    {props.mode !== 'still' && <section className="film-add-actions" aria-label={`Add motion to ${filmTargetName(scene, selectedTarget)}`}>
      <div className="film-section-label"><span>Add motion</span><span>{filmTargetName(scene, selectedTarget)}</span></div>
      <div className="film-action-buttons">{availableMotionKinds(scene, selectedTarget).map(kind => <button type="button" key={kind} disabled={disabled} onClick={() => add(kind)}><UiIcon name="plus"/>{actionName(scene, selectedTarget, kind)}</button>)}</div>
      <p className="film-hint">{availableMotionKinds(scene, selectedTarget).length ? 'Select a motion to set its amount and timing.' : 'This part anchors another movement. Animate Whole product to move them together.'}</p>
    </section>}
    {props.mode !== 'still' && selectedTarget !== '$camera' && <section className="film-existing-actions" aria-label="Custom animation">
      <div className="film-section-label"><span>{legacyCount(scene, selectedTarget) ? 'Existing animation' : 'Individual channels'}</span><span>Across cuts</span></div>
      <button type="button" onClick={onLegacyAnimation} disabled={!onLegacyAnimation}><span>{legacyCount(scene, selectedTarget) ? 'Edit existing keys' : 'Custom keyframes'}</span><UiIcon name="chevron"/></button>
      <p className="film-hint">{legacyCount(scene, selectedTarget) ? 'Keeps its original film timing.' : 'Direct transform keys use the film clock.'}</p>
    </section>}
    <Notice error={error}/>
  </div>;
}

export function FilmInspector(props: FilmWorkspaceProps & {children?: ReactNode; onEditMechanism?: () => void}) {
  const {scene, frame, selectedTarget, selectedMotionId, onMotionSelect, onFrame, disabled, editCurves, onEditCurves, children} = props;
  const shot = shotAtFrame(scene, frame), entry = props.mode === 'still' ? undefined : listMotions(scene, shot.id).find(item => item.motion.id === selectedMotionId);
  const {edit, error} = useFilmEdits(props);
  const motion = entry?.motion, fps = scene.render.fps;
  const patch = (value: Partial<FilmMotion>) => {if (motion) edit(draft => updateMotion(draft, shot.id, motion.id, value));};
  const measure = motion ? motionMeasure(motion) : null;
  return <div className="gesso-panel film-inspector">
    {motion && <div className="film-breadcrumb" aria-label="Editing object"><span>{filmTargetName(scene, motion.target)}</span></div>}
    {!motion ? <>
      <div className="film-inspector-heading"><h2>{filmTargetName(scene, selectedTarget)}</h2><span>{selectedTarget === '$camera' ? 'Framing' : 'Base pose'}</span></div>
      {children ?? <p className="film-hint">Choose a motion on the left to animate this {selectedTarget === '$camera' ? 'camera' : 'object'}.</p>}
    </> : <>
      <div className="film-inspector-heading"><h2>{labelFor(scene, motion)}</h2><label className="film-enable"><input type="checkbox" checked={motion.enabled} disabled={disabled} onChange={event => patch({enabled: event.target.checked})}/>Enabled</label></div>
      <section className="film-motion-properties" aria-label="Motion parameters">
        <NumberControl label={measure!.label} ariaLabel="Motion amount" value={motion.amount * measure!.factor} unit={measure!.unit} step={measure!.step} min={motion.kind === 'scale' ? 1 : motion.kind === 'mechanical' ? 0 : undefined} max={motion.kind === 'mechanical' ? 100 : undefined} disabled={disabled} onChange={value => patch({amount: value / measure!.factor})}/>
        {(motion.kind === 'move' || motion.kind === 'rotate') && <label className="gesso-field film-select"><span>Axis</span><select aria-label="Motion axis" value={motion.axis} disabled={disabled} onChange={event => patch({axis: event.target.value as FilmMotion['axis']})}>{['x', 'y', 'z'].map(axis => <option key={axis} value={axis}>{axis.toUpperCase()}</option>)}</select></label>}
        <NumberControl label="Start" ariaLabel="Motion start" value={(motion.startFrame - 1) / fps} min={0} unit="s" step={1 / fps} disabled={disabled} onChange={value => patch({startFrame: Math.round(value * fps) + 1})}/>
        <NumberControl label="Duration" ariaLabel="Motion duration" value={(motion.durationFrames - 1) / fps} min={1 / fps} unit="s" step={1 / fps} disabled={disabled} onChange={value => patch({durationFrames: Math.round(value * fps) + 1})}/>
        <label className="gesso-field film-select"><span>Timing</span><select aria-label="Motion easing" value={motion.keys ? 'custom' : motion.easing} disabled={disabled || !!motion.keys} onChange={event => patch({easing: event.target.value as FilmMotion['easing']})}>{motion.keys && <option value="custom">Custom curve</option>}<option value="ease">Ease in / out</option><option value="linear">Constant speed</option><option value="hold">Hold, then change</option></select></label>
        <label className="gesso-field film-select"><span>Scope</span><select aria-label="Motion scope" value={entry!.scope} disabled={disabled} onChange={event => {const result = edit(draft => changeMotionScope(draft, shot.id, motion.id, event.target.value as 'shot' | 'film')); if (result?.value) onMotionSelect(result.value);}}><option value="shot">This shot</option><option value="film">Across cuts</option></select></label>
      </section>
      <p className="film-hint">{entry!.scope === 'shot' ? 'Time starts at this shot. Reordering carries this motion with it.' : 'Time starts at the film. Camera cuts keep this motion running.'}</p>
      {motion.kind === 'mechanical' && <p className="film-hint">Uses the part’s existing {scene.actions?.find((action: any) => action.componentId === motion.target)?.type === 'screw' ? 'screw axis and pitch' : 'lift axis and travel'}.</p>}
      {motion.enabled && (motion.kind === 'move' || motion.kind === 'rotate') && scene.actions?.some((action: any) => action.componentId === motion.target) && <p className="film-hint">Controls this part directly; its existing mechanism is held at rest {entry!.scope === 'shot' ? 'in this shot' : 'across the film'}.</p>}
      {motion.kind === 'mechanical' && props.onEditMechanism && <button type="button" className="film-mechanism-link" onClick={props.onEditMechanism}>Edit mechanism<UiIcon name="chevron"/></button>}
      <div className="film-inspector-actions">
        <button type="button" aria-pressed={!!editCurves} onClick={() => onEditCurves?.(!editCurves)} disabled={!onEditCurves}>{editCurves ? 'Close curve' : 'Edit curve'}<UiIcon name="chevron"/></button>
        <button type="button" disabled={disabled} onClick={() => {const bounds = motionBounds(entry!, shot); onFrame(clamp(bounds.start, shot.startFrame, shot.endFrame));}}>Go to start</button>
      </div>
      <button className="film-remove-motion" type="button" disabled={disabled} onClick={() => {if (edit(draft => removeMotion(draft, shot.id, motion.id))) {onMotionSelect(null); onEditCurves?.(false);}}}>Remove motion</button>
    </>}
    <Notice error={error}/>
  </div>;
}

type BlockDrag = {id: string; pointerId: number; pointerX: number; width: number; original: number; destination: number; max: number; shotFrames: number};

export function FilmTimeline(props: FilmWorkspaceProps & {detailContent?: ReactNode}) {
  const {scene, frame, onFrame, selectedMotionId, onMotionSelect, onTargetChange, disabled, playing, onPlay, editCurves, onEditCurves, onResetView} = props;
  const shot = shotAtFrame(scene, frame), fps = scene.render.fps, total = sequenceEnd(scene), length = shotFrames(shot);
  const entries = listMotions(scene, shot.id), selected = entries.find(entry => entry.motion.id === selectedMotionId), legacy = legacyMotions(scene);
  const [durationMode, setDurationMode] = useState<'trim' | 'stretch'>('trim');
  const [preview, setPreview] = useState<{id: string; startFrame: number} | null>(null);
  const drag = useRef<BlockDrag | null>(null), {edit, error} = useFilmEdits(props);
  const shotIndex = scene.shots.indexOf(shot);
  const cancelDrag = () => {drag.current = null; setPreview(null);};
  useEffect(() => {cancelDrag();}, [shot.id, disabled]);
  useEffect(() => {
    const cancel = () => {drag.current = null; setPreview(null);};
    window.addEventListener('blur', cancel);
    return () => {window.removeEventListener('blur', cancel); drag.current = null;};
  }, []);
  const seekFilm = (next: number) => {
    if (disabled) return;
    if (shotAtFrame(scene, next).id !== shot.id) {
      if (!props.detailContent) {onMotionSelect(null); onEditCurves?.(false);}
      onResetView?.();
    }
    onFrame(next);
  };
  const sequenceEdit = (mutate: (draft: any) => string | void) => {
    const result = edit(mutate);
    if (!result) return;
    const next = result.draft.shots.find((candidate: any) => candidate.id === (result.value || shot.id)) ?? result.draft.shots[0];
    onFrame(next.startFrame); onMotionSelect(null); onEditCurves?.(false); onResetView?.();
  };
  const chooseMotion = (entry: MotionEntry) => {onTargetChange(entry.motion.target); onMotionSelect(entry.motion.id);};
  const beginDrag = (event: PointerEvent<HTMLButtonElement>, entry: MotionEntry) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); chooseMotion(entry);
    const max = Math.max(1, (entry.scope === 'film' ? total : length) - entry.motion.durationFrames + 1);
    drag.current = {id: entry.motion.id, pointerId: event.pointerId, pointerX: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width, original: entry.motion.startFrame, destination: entry.motion.startFrame, max, shotFrames: length};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const dragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.destination = clamp(active.original + Math.round((event.clientX - active.pointerX) / Math.max(1, active.width) * active.shotFrames), 1, active.max);
    setPreview({id: active.id, startFrame: active.destination});
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    cancelDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.original !== active.destination) edit(draft => updateMotion(draft, shot.id, active.id, {startFrame: active.destination}));
  };
  const moveByKey = (event: KeyboardEvent<HTMLButtonElement>, entry: MotionEntry) => {
    if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); event.stopPropagation();
    const max = Math.max(1, (entry.scope === 'film' ? total : length) - entry.motion.durationFrames + 1);
    const next = clamp(entry.motion.startFrame + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 1), 1, max);
    if (next !== entry.motion.startFrame) edit(draft => updateMotion(draft, shot.id, entry.motion.id, {startFrame: next}));
  };
  return <section className={`film-timeline${editCurves && selected ? ' is-editing-curve' : ''}${props.detailContent ? ' is-editing-keys' : ''}`} aria-label="Film timeline" onKeyDown={event => {
    if (event.key === 'Escape' && drag.current) {event.preventDefault(); cancelDrag();}
    const target = event.target as HTMLElement;
    const editingText = target.isContentEditable || !!target.closest('input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');
    if (event.key === ' ' && !editingText && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat && !disabled) onPlay?.();
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
  }}>
    <header className="film-timeline-toolbar">
      <button type="button" className="film-play" aria-label={playing ? 'Pause film' : 'Play film'} onClick={onPlay} disabled={disabled || !onPlay}>{playing ? 'Pause' : 'Play'}</button>
      <time>{round((frame - 1) / fps)} <span>/ {round(total / fps)} s</span></time>
      <span className="film-timeline-spacer"/>
      <button type="button" onClick={() => props.onCreateShot ? props.onCreateShot() : sequenceEdit(draft => addShot(draft, shot.id))} disabled={disabled}><UiIcon name="plus"/>New frame</button>
      <button type="button" onClick={() => sequenceEdit(draft => duplicateShot(draft, shot.id))} disabled={disabled}>Duplicate</button>
    </header>
    <FilmShotStrip scene={scene} frame={frame} onFrame={seekFilm} disabled={disabled} onPlay={onPlay}/>
    <div className="film-shot-tools">
      <ShotName key={shot.id} name={shot.name || 'Shot'} disabled={disabled} onCommit={name => edit(draft => {draft.shots.find((candidate: any) => candidate.id === shot.id).name = name;})}/>
      <button type="button" onClick={() => sequenceEdit(draft => moveShot(draft, shot.id, -1))} disabled={disabled || shotIndex === 0} aria-label="Move shot earlier"><UiIcon name="chevron" className="film-chevron-left"/></button>
      <button type="button" onClick={() => sequenceEdit(draft => moveShot(draft, shot.id, 1))} disabled={disabled || shotIndex === scene.shots.length - 1} aria-label="Move shot later"><UiIcon name="chevron"/></button>
      <div className="film-shot-duration"><select value={durationMode} aria-label="Shot duration operation" onChange={event => setDurationMode(event.target.value as 'trim' | 'stretch')}><option value="trim">Trim end</option><option value="stretch">Stretch shot</option></select><NumberControl compact label="Length" ariaLabel="Shot duration" value={length / fps} unit="s" min={1 / fps} step={1 / fps} disabled={disabled} onChange={value => sequenceEdit(draft => (durationMode === 'trim' ? setShotFrames : stretchShotFrames)(draft, shot.id, Math.max(1, Math.round(value * fps))))}/></div>
      <button type="button" className="film-shot-remove" onClick={() => sequenceEdit(draft => removeShot(draft, shot.id))} disabled={disabled || scene.shots.length === 1}>Remove</button>
    </div>
    {!props.detailContent && !(selected && editCurves) && <div className="film-motion-tracks" aria-label="Shot motions">
      {entries.length === 0 && legacy.length === 0 && <p className="film-empty-timeline">Select an object, then add a motion. Camera framing stays available in the viewport.</p>}
      {entries.map(entry => {
        const displayed = preview?.id === entry.motion.id ? {...entry, motion: {...entry.motion, startFrame: preview.startFrame}} : entry;
        const bounds = motionBounds(displayed, shot), start = Math.max(bounds.start, shot.startFrame), end = Math.min(bounds.end, shot.endFrame), visible = end >= start;
        const clipped = bounds.start < shot.startFrame || bounds.end > shot.endFrame;
        return <div key={entry.motion.id} className={`film-motion-row${selectedMotionId === entry.motion.id ? ' is-selected' : ''}`}>
          <button type="button" className="film-track-name" onClick={() => chooseMotion(entry)} aria-pressed={selectedMotionId === entry.motion.id}><span>{filmTargetName(scene, entry.motion.target)}</span><small>{entry.scope === 'film' ? 'Across cuts' : 'This shot'}</small></button>
          <div className="film-track-lane">
            {visible ? <button type="button" className={`film-motion-block${!entry.motion.enabled ? ' is-disabled' : ''}`} style={{left: `${(start - shot.startFrame) / length * 100}%`, width: `${(end - start + 1) / length * 100}%`}} aria-label={`${labelFor(scene, entry.motion)} on ${filmTargetName(scene, entry.motion.target)}, ${entry.scope === 'film' ? 'across cuts' : 'this shot'}. Arrow keys move one frame; Shift moves ten.`} aria-pressed={selectedMotionId === entry.motion.id} title={`${labelFor(scene, entry.motion)} · ${round((entry.motion.durationFrames - 1) / fps)} s${clipped ? ' · clipped by this shot' : ''}`} disabled={disabled}
              onPointerDown={event => beginDrag(event, entry)} onPointerMove={dragMove} onPointerUp={finishDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onKeyDown={event => moveByKey(event, entry)} onClick={() => chooseMotion(entry)}>
              <span>{labelFor(scene, entry.motion)}{!entry.motion.enabled && ' · off'}</span>{clipped && <small>clipped</small>}
            </button> : <button type="button" className="film-outside-motion" onClick={() => chooseMotion(entry)}>{labelFor(scene, entry.motion)} <small>Outside this shot</small></button>}
          </div>
        </div>;
      })}
      {legacy.map(motion => {
        const start = Math.max(shot.startFrame, motion.start), end = Math.min(shot.endFrame, motion.end), visible = end >= start;
        const open = () => {onTargetChange(motion.target); onMotionSelect(null); props.onLegacyAnimation?.();};
        return <div className="film-motion-row film-legacy-row" key={motion.id}>
          <button type="button" className="film-track-name" onClick={open} disabled={!props.onLegacyAnimation}><span>{filmTargetName(scene, motion.target)}</span><small>Across cuts</small></button>
          <div className="film-track-lane">
            {visible ? <button type="button" className="film-motion-block film-legacy-block" style={{left: `${(start - shot.startFrame) / length * 100}%`, width: `${Math.max(1, end - start + 1) / length * 100}%`}} onClick={open} disabled={!props.onLegacyAnimation} aria-label={`${filmTargetName(scene, motion.target)} ${motion.name}, existing animation across cuts`}><span>{motion.name}</span><small>existing</small></button> : <button type="button" className="film-outside-motion" onClick={open} disabled={!props.onLegacyAnimation}>{motion.name}<small>Outside this shot</small></button>}
          </div>
        </div>;
      })}
    </div>}
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

function FilmMotionCurve(props: FilmWorkspaceProps & {entry: MotionEntry}) {
  const {scene, frame, entry, disabled, onFrame, onEditCurves} = props;
  const shot = shotAtFrame(scene, frame), motion = entry.motion;
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
      <span className="film-playhead" style={{left: `${x(local)}%`}} aria-hidden="true"/>
      <div className="film-curve-clock" aria-label="Motion time in seconds">{[0, .5, 1].map(fraction => <span key={fraction}>{round(fraction * (motion.durationFrames - 1) / scene.render.fps)} s</span>)}</div>
      {keys.map(key => <button type="button" key={key.frame} className="film-curve-key" style={{left: `${x(key.frame)}%`, top: `${100 - key.value * 100}%`}} aria-label={`Progress key at frame ${key.frame}, ${round(key.value * 100)} percent`} aria-pressed={key.frame === selectedKey.frame} disabled={disabled} onClick={() => {setSelectedFrame(key.frame); onFrame(clamp(bounds.start + key.frame - 1, shot.startFrame, shot.endFrame));}}><span/></button>)}
    </div><div className="film-curve-values"><NumberControl compact label="Frame" ariaLabel="Progress key frame" value={selectedKey.frame} min={1} max={motion.durationFrames} step={1} disabled={disabled} onChange={value => update({frame: Math.round(value)})}/><NumberControl compact label="Progress" ariaLabel="Progress key value" value={selectedKey.value * 100} min={0} max={100} unit="%" step={1} disabled={disabled} onChange={value => update({value: value / 100})}/><select aria-label="Key interpolation" value={selectedKey.interpolation} disabled={disabled} onChange={event => update({interpolation: event.target.value as ProgressKey['interpolation']})}><option value="ease">Ease in / out</option><option value="linear">Constant speed</option><option value="hold">Hold</option></select><button type="button" disabled={disabled || keys.length <= 2} onClick={() => {if (edit(draft => setMotionKeys(draft, shot.id, motion.id, keys.filter(key => key !== selectedKey)))) setSelectedFrame(keys[0].frame);}}>Remove key</button></div></div>
    <Notice error={error}/>
  </section>;
}
