import {isFilmTextCard} from './filmTextCard';
import {partTargetIds} from './partTargets';
import {useEffect, useState, type ReactNode} from 'react';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import {FilmMotionChoice, FilmMotionPreview} from './FilmMotionPreview';
import {motionDiagramSpec} from './filmMotionDiagram';
import {cameraMotionSelection, isCameraHoldMotion, setCameraMotionPreset, type CameraMotionPreset} from './cameraMotionPresets';
import {exactShotAtFrame,shotAtFrame} from './sequence';
import {addMotion, availableMotionKinds, changeMotionScope, listMotions, motionLights, removeMotion, updateMotion, type FilmMotion, type MotionKind} from './filmMotion';
import {isLightTarget, lightTarget} from './world';
import {actionName, clamp, filmTargetName, labelFor, legacyCount, motionBounds, motionMeasure, useFilmEdits} from './FilmWorkspaceShared';
import './film-workspace.css';
import './film-rails.css';

export {filmTargetName, motionBounds, motionMeasure} from './FilmWorkspaceShared';
export {FilmTimeline} from './FilmTimeline';

export interface FilmWorkspaceProps {
  scene: any;
  mode?: 'still' | 'video';
  frame: number;
  /** The selected scene remains stable while the playback frame crosses cuts. */
  editingFrame?: number;
  onFrame: (frame: number) => void;
  onChange: (edit: (scene: any) => void) => void;
  selectedTarget: string;
  onTargetChange: (id: string) => void;
  selectedMotionId: string | null;
  onMotionSelect: (id: string | null) => void;
  playing?: boolean;
  onPlay?: () => void;
  loopPlayback?: boolean;
  onLoopPlaybackChange?: (loop: boolean) => void;
  disabled?: boolean;
  editCurves?: boolean;
  onEditCurves?: (open: boolean) => void;
  onLegacyAnimation?: () => void;
  onResetView?: () => void;
  onCreateShot?: () => void;
  onOutput?: () => void;
}

function Notice({error}: {error: string}) {return error ? <p className="film-error" role="alert">{error}</p> : null;}

/** Scene context belongs to the object rail; the inspector identifies its target. */
export function FilmShotHeader({scene, frame, editingFrame}: Pick<FilmWorkspaceProps, 'scene' | 'frame' | 'editingFrame'>) {
  const shot = exactShotAtFrame(scene, editingFrame ?? frame);
  if (!shot) return <h2 className="film-shot-header"><span className="film-shot-number">Gap</span><span className="film-shot-title">Black</span></h2>;
  const number = String(scene.shots.findIndex((item: any) => item.id === shot.id) + 1).padStart(2, '0');
  const name = shot.name || 'Untitled shot';
  const kind = shot.kind === 'image' ? isFilmTextCard(shot.image?.textCard) ? 'Text' : 'Image' : 'Scene';
  return <h2 className="film-shot-header" aria-label={`${kind} ${number}: ${name}`} title={`${kind} ${number}: ${name}`}>
    <span className="film-shot-number">{kind} {number}</span><span className="film-shot-title">{name}</span>
  </h2>;
}

export function FilmObjects(props: FilmWorkspaceProps) {
  const {scene, frame, editingFrame, selectedTarget, onTargetChange, onMotionSelect, onEditCurves} = props;
  const shot = shotAtFrame(scene, editingFrame ?? frame), entries = props.mode === 'still' ? [] : listMotions(scene, shot.id);
  const isPart = !selectedTarget.startsWith('$');
  const isLight = isLightTarget(selectedTarget);
  const [partsOpen, setPartsOpen] = useState(isPart);
  const [lightsOpen, setLightsOpen] = useState(isLight);
  useEffect(() => {if (isPart) setPartsOpen(true);}, [selectedTarget, isPart]);
  useEffect(() => {if (isLight) setLightsOpen(true);}, [selectedTarget, isLight]);
  const chooseTarget = (target: string) => {onTargetChange(target); onMotionSelect(null); onEditCurves?.(false);};
  const lights = props.mode === 'still' ? [] : motionLights(scene).filter(light => light.enabled);
  const targetRow = (target: string) => {
    const count = entries.filter(entry => entry.motion.target === target).length;
    const cameraState = target === '$camera' && props.mode !== 'still' ? cameraMotionSelection(scene, shot.id) : null;
    return <div className={`film-object${target === selectedTarget ? ' is-selected' : ''}`} key={target}>
      <button type="button" className="film-object-name" aria-pressed={target === selectedTarget} onClick={() => chooseTarget(target)}>
        <span>{target === '$camera' ? <UiIcon name="circle"/> : target === '$product' ? <span className="film-product-mark" aria-hidden="true"/> : isLightTarget(target) ? <span className="film-light-mark" aria-hidden="true"/> : <span className="film-part-mark"/>}{filmTargetName(scene, target)}</span>
        <small>{target === '$camera' ? cameraState === 'dolly' ? 'push in' : cameraState === 'custom' ? 'path' : cameraState ?? 'frame' : count ? `${count} ${count === 1 ? 'motion' : 'motions'}` : isLightTarget(target) ? 'still' : 'pose'}</small>
      </button>
    </div>;
  };
  return <div className="gesso-panel film-objects">
    <div className="film-object-list gesso-selection-surface" aria-label="Shot objects">
      {targetRow('$camera')}
      {targetRow('$product')}
      <details className="film-rail-disclosure film-parts-disclosure" open={partsOpen} onToggle={event => setPartsOpen(event.currentTarget.open)}>
        <summary><UiIcon name="chevron"/><span>Parts</span><small>{partTargetIds(scene).length}</small></summary>
        <div className="film-parts-list">{partTargetIds(scene).map(targetRow)}</div>
      </details>
      {lights.length > 0 && <details className="film-rail-disclosure film-parts-disclosure film-lights-disclosure" open={lightsOpen} onToggle={event => setLightsOpen(event.currentTarget.open)}>
        <summary><UiIcon name="chevron"/><span>Lights</span><small>{lights.length}</small></summary>
        <div className="film-parts-list">{lights.map(light => targetRow(lightTarget(light.id)))}</div>
      </details>}
    </div>
  </div>;
}

export function FilmInspector(props: FilmWorkspaceProps & {children?: ReactNode; onEditMechanism?: () => void}) {
  const {scene, frame, editingFrame, selectedTarget, selectedMotionId, onMotionSelect, onFrame, disabled, editCurves, onEditCurves, onLegacyAnimation, children} = props;
  const shot = shotAtFrame(scene, editingFrame ?? frame);
  const entries = props.mode === 'still' ? [] : listMotions(scene, shot.id).filter(item => item.motion.target === selectedTarget);
  const cameraSelected = selectedTarget === '$camera';
  const cameraChoice = cameraSelected ? cameraMotionSelection(scene, shot.id) : null;
  const cameraOwner = entries.find(item => item.motion.enabled);
  const entry = entries.find(item => item.motion.id === selectedMotionId) ?? (cameraSelected ? cameraOwner : undefined);
  const motion = entry && !isCameraHoldMotion(entry.motion) ? entry.motion : undefined;
  const {edit, error} = useFilmEdits(props), fps = scene.render.fps;
  const [poseOpen, setPoseOpen] = useState(!motion);
  const [addingMotion, setAddingMotion] = useState(false);
  useEffect(() => setAddingMotion(false), [selectedTarget, shot.id]);
  useEffect(() => setPoseOpen(!motion), [selectedTarget, shot.id, motion?.id]);
  const patch = (value: Partial<FilmMotion>) => {if (motion) edit(draft => updateMotion(draft, shot.id, motion.id, value));};
  const measure = motion ? motionMeasure(motion) : null;
  const kinds = availableMotionKinds(scene, selectedTarget);
  const add = (kind: MotionKind) => {
    const result = edit(draft => addMotion(draft, shot.id, selectedTarget, kind));
    if (result) {setAddingMotion(false); onMotionSelect(result.value); onEditCurves?.(false); onFrame(shot.startFrame);}
  };
  const chooseCameraMotion = (preset: CameraMotionPreset) => {
    if (disabled) return;
    if (preset === cameraChoice) {onMotionSelect(cameraOwner && !isCameraHoldMotion(cameraOwner.motion) ? cameraOwner.motion.id : null); onEditCurves?.(false); return;}
    const result = edit(draft => setCameraMotionPreset(draft, shot.id, preset, editingFrame ?? frame));
    if (result) {onMotionSelect(result.value); onEditCurves?.(false); onFrame(preset === 'still' ? shot.startFrame : clamp(editingFrame ?? frame, shot.startFrame, shot.endFrame)); props.onResetView?.();}
  };
  const assignedMotions = entries.length > 0 && <div className="film-assigned-motions" aria-label={`${filmTargetName(scene, selectedTarget)} motions`}>
    {entries.filter(item => !isCameraHoldMotion(item.motion)).map(item => <button type="button" key={item.motion.id} className="film-motion-link" aria-pressed={entry?.motion.id === item.motion.id} onClick={() => {onMotionSelect(item.motion.id); onEditCurves?.(false);}}>
      <span>{labelFor(scene, item.motion)}{!item.motion.enabled && <small> · off</small>}</span><small>{item.scope === 'film' ? 'Across cuts' : 'This scene'}</small>
    </button>)}
  </div>;
  const existing = legacyCount(scene, selectedTarget);
  return <div className="gesso-panel film-inspector film-rail-panel">
    <div className="film-inspector-heading"><h2>{filmTargetName(scene, selectedTarget)}</h2></div>
    {cameraSelected && props.mode !== 'still' && <div className="film-camera-presets">
      <div className="film-action-buttons film-camera-motion-choices" role="group" aria-label="Camera motion">
        {(['still', 'orbit', 'dolly'] as const).map(preset => <FilmMotionChoice key={preset} spec={motionDiagramSpec(scene, '$camera', preset === 'still' ? 'pose' : preset)} label={preset === 'still' ? 'Still' : actionName(scene, '$camera', preset)} selected={cameraChoice === preset} disabled={disabled}
          title={preset === 'still' ? 'Hold the current camera view for this scene. Product motion continues.' : undefined} onClick={() => chooseCameraMotion(preset)}/>)}
      </div>
      {cameraChoice === 'custom' && <p className="film-hint gesso-note">Custom camera path</p>}
    </div>}
    {!cameraSelected && <FilmMotionPreview spec={motionDiagramSpec(scene, selectedTarget, motion?.kind ?? 'pose', motion)} label={motion ? labelFor(scene, motion) : selectedTarget === '$camera' ? 'Framing' : 'Position'} disabled={disabled || motion?.enabled === false}/>}
    <div className="film-rail-scroll">
    {props.mode !== 'still' && <section className="film-rail-motion" aria-label={`Motion for ${filmTargetName(scene, selectedTarget)}`}>
      {!cameraSelected && <details className="film-rail-disclosure film-add-motion" open={addingMotion} onToggle={event => setAddingMotion(event.currentTarget.open)}>
      <summary><UiIcon name="chevron"/><span>Add motion</span></summary>
      <div className="film-action-buttons" aria-label={`Add motion to ${filmTargetName(scene, selectedTarget)}`}>{kinds.map(kind => <FilmMotionChoice key={kind} spec={motionDiagramSpec(scene, selectedTarget, kind)} label={actionName(scene, selectedTarget, kind)} disabled={disabled} onClick={() => add(kind)}/>)}</div>
      {!kinds.length && <p className="film-hint gesso-note">This part anchors another movement. Animate Whole product to move them together.</p>}
      </details>}
      {!cameraSelected && assignedMotions}
      {motion && <section className="film-selected-motion" aria-label={`${labelFor(scene, motion)} settings`}>
        <div className="film-motion-heading"><span>{labelFor(scene, motion)}</span><label className="film-enable"><input type="checkbox" checked={motion.enabled} disabled={disabled} onChange={event => patch({enabled: event.target.checked})}/>Enabled</label></div>
        <div className="film-motion-properties" aria-label="Motion parameters">
          <NumberControl label={measure!.label} ariaLabel="Motion amount" value={motion.amount * measure!.factor} unit={measure!.unit} step={measure!.step} min={motion.kind === 'scale' ? 1 : motion.kind === 'mechanical' ? 0 : undefined} max={motion.kind === 'mechanical' ? 100 : undefined} disabled={disabled} onChange={value => patch({amount: value / measure!.factor})}/>
          {(motion.kind === 'move' || motion.kind === 'rotate') && <label className="gesso-field film-select"><span>Axis</span><select aria-label="Motion axis" value={motion.axis} disabled={disabled} onChange={event => patch({axis: event.target.value as FilmMotion['axis']})}>{['x', 'y', 'z'].map(axis => <option key={axis} value={axis}>{axis.toUpperCase()}</option>)}</select></label>}
          <label className="gesso-field film-select"><span>Timing</span><select aria-label="Motion easing" value={motion.keys ? 'custom' : motion.easing} disabled={disabled || !!motion.keys} onChange={event => patch({easing: event.target.value as FilmMotion['easing']})}>{motion.keys && <option value="custom">Custom curve</option>}<option value="ease">Ease in / out</option><option value="linear">Constant speed</option><option value="hold">Hold, then change</option></select></label>
        </div>
        {motion.kind === 'mechanical' && <p className="film-hint gesso-note">Uses the part’s existing {scene.actions?.find((action: any) => action.componentId === motion.target)?.type === 'screw' ? 'screw axis and pitch' : 'lift axis and travel'}.</p>}
        {motion.enabled && (motion.kind === 'move' || motion.kind === 'rotate') && scene.actions?.some((action: any) => action.componentId === motion.target) && <p className="film-hint gesso-note">Controls this part directly; its existing mechanism is held at rest {entry!.scope === 'shot' ? 'in this shot' : 'across the film'}.</p>}
        {motion.kind === 'mechanical' && props.onEditMechanism && <button type="button" className="film-mechanism-link" onClick={props.onEditMechanism}>Edit mechanism<UiIcon name="chevron"/></button>}
        <details className="film-rail-disclosure film-motion-details" key={motion.id}>
          <summary><UiIcon name="chevron"/><span>Timing and scope</span></summary>
          <div className="film-rail-detail-body">
            <NumberControl label="Start" ariaLabel="Motion start" value={(motion.startFrame - 1) / fps} min={0} unit="s" step={1 / fps} disabled={disabled} onChange={value => patch({startFrame: Math.round(value * fps) + 1})}/>
            <NumberControl label="Duration" ariaLabel="Motion duration" value={(motion.durationFrames - 1) / fps} min={1 / fps} unit="s" step={1 / fps} disabled={disabled} onChange={value => patch({durationFrames: Math.round(value * fps) + 1})}/>
            <label className="gesso-field film-select"><span>Scope</span><select aria-label="Motion scope" value={entry!.scope} disabled={disabled} onChange={event => {const result = edit(draft => changeMotionScope(draft, shot.id, motion.id, event.target.value as 'shot' | 'film')); if (result?.value) onMotionSelect(result.value);}}><option value="shot">This scene</option><option value="film">Across cuts</option></select></label>
            <p className="film-hint gesso-note">{entry!.scope === 'shot' ? 'Time starts at this shot. Reordering carries this motion with it.' : 'Time starts at the film. Camera cuts keep this motion running.'}</p>
            <div className="film-inspector-actions">
              <button type="button" aria-pressed={!!editCurves} onClick={() => onEditCurves?.(!editCurves)} disabled={!onEditCurves}>{editCurves ? 'Close curve' : 'Edit curve'}<UiIcon name="chevron"/></button>
              <button type="button" disabled={disabled} onClick={() => {const bounds = motionBounds(entry!, shot); onFrame(clamp(bounds.start, shot.startFrame, shot.endFrame));}}>Go to start</button>
            </div>
            <button className="film-remove-motion" type="button" disabled={disabled} onClick={() => {if (edit(draft => removeMotion(draft, shot.id, motion.id))) {onMotionSelect(null); onEditCurves?.(false);}}}>Remove motion</button>
          </div>
        </details>
      </section>}
    </section>}
    {cameraSelected && <div className="film-camera-framing">{children ?? <p className="film-hint gesso-note">Select the camera to adjust framing.</p>}</div>}
    {cameraSelected && entries.some(item => !isCameraHoldMotion(item.motion)) && <details className="film-rail-disclosure film-camera-actions"><summary><UiIcon name="chevron"/><span>Saved motions</span></summary>{assignedMotions}</details>}
    {selectedTarget !== '$camera' && <details className="film-rail-disclosure film-pose-disclosure" open={poseOpen} onToggle={event => setPoseOpen(event.currentTarget.open)}>
      <summary><UiIcon name="chevron"/><span>Position</span></summary>
      <div className="film-rail-detail-body">{children ?? <p className="film-hint gesso-note">Select an object to set its base pose.</p>}</div>
    </details>}
    {props.mode !== 'still' && selectedTarget !== '$camera' && !isLightTarget(selectedTarget) && <details className="film-rail-disclosure film-custom-details">
      <summary><UiIcon name="chevron"/><span>Custom keyframes</span>{existing > 0 && <small>Existing</small>}</summary>
      <div className="film-rail-detail-body">
        <div className="film-rail-heading"><span>{existing ? 'Existing animation' : 'Individual channels'}</span><small>Across cuts</small></div>
        <button type="button" className="film-mechanism-link" onClick={onLegacyAnimation} disabled={!onLegacyAnimation}><span>{existing ? 'Edit existing keys' : 'Edit custom keys'}</span><UiIcon name="chevron"/></button>
        <p className="film-hint gesso-note">{existing ? 'Keeps its original film timing.' : 'Direct transform keys use the film clock.'}</p>
      </div>
    </details>}
    <Notice error={error}/>
    </div>
  </div>;
}
