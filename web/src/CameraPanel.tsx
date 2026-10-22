import {partTargetIds} from './partTargets';
import {useEffect, useState, type ReactNode} from 'react';
import {cameraTarget, editCamera, type CameraDefinition, type CameraEnd, type CameraPose} from './camera';
import {cameraPoseAtFrame, cameraSourceEndFrame, offsetCameraFraming} from './cameraFraming';
import {setOutputDimensions, shotAtFrame, shotFrames} from './sequence';
import {displayPartName} from './hierarchy';
import {NumberControl as StepNumber, VectorControl as StepVector} from './EditorControls';
import {UiIcon} from './UiIcon';
const formats = [{label: '9:16', width: 1080, height: 1920}, {label: '16:9', width: 1920, height: 1080}, {label: '1:1', width: 1080, height: 1080}, {label: '4:5', width: 1080, height: 1350}];
function StepField({label, children}: {label: string; children: ReactNode}) {return <label className="gesso-field gesso-inline-field"><span>{label}</span>{children}</label>;}

export type CameraLayer = 'Lens' | 'Focus' | 'Path';
export interface CameraPanelProps {
  scene: any;
  layer?: CameraLayer;
  frame: number;
  samples?: any[];
  mode?: 'still' | 'video';
  embedded?: boolean;
  onChange: (edit: (scene: any) => void) => void;
  onFrame: (frame: number) => void;
  onResetView?: () => void;
  cameraEnd?: CameraEnd;
  onCameraEndChange?: (end: CameraEnd) => void;
  /** Retained for older callers; framing controls now live in this panel. */
  viewportControls?: boolean;
  cameraMotionDriven?: boolean;
  cameraTargetId?: string;
  onCameraTargetChange?: (id: string) => void;
}

export default function CameraPanel({scene, frame, samples = [], mode = 'video', embedded = false, onChange, onFrame, onResetView, cameraEnd, onCameraEndChange, cameraMotionDriven = false, cameraTargetId, onCameraTargetChange}: CameraPanelProps) {
  const [endSelection, setEndSelection] = useState<{shotId: string; end: CameraEnd}>(() => {const selected = shotAtFrame(scene, frame); return {shotId: selected.id, end: frame !== selected.startFrame && frame === cameraSourceEndFrame(selected) ? 'to' : 'from'};});
  const [localTarget, setLocalTarget] = useState('');
  const target = cameraTargetId ?? localTarget;
  const setTarget = onCameraTargetChange ?? setLocalTarget;
  const [error, setError] = useState('');
  const [customSize, setCustomSize] = useState(false);
  const shot = shotAtFrame(scene, frame);
  const end = cameraEnd ?? (endSelection.shotId === shot.id ? endSelection.end : frame !== shot.startFrame && frame === cameraSourceEndFrame(shot) ? 'to' : 'from');
  const camera = shot.camera;
  const still = mode === 'still';
  const sourceEnd = cameraSourceEndFrame(shot), trimmedEnd = sourceEnd > shot.endFrame, heldCamera = sourceEnd === shot.startFrame;
  const unavailableEnd = !still && end === 'to' && (trimmedEnd || heldCamera);
  const spatialDisabled = unavailableEnd || cameraMotionDriven;
  const sampledPose: CameraPose = samples.find(sample => sample.frame === frame && sample.shotId === shot.id)?.camera ?? cameraPoseAtFrame(shot, frame);
  const pose: CameraPose = still || unavailableEnd ? sampledPose : camera[end];
  const endpointFrame = still || unavailableEnd ? frame : end === 'from' ? shot.startFrame : sourceEnd;
  const scope = still || unavailableEnd ? 'Frame' : end === 'from' ? 'Start' : 'End';
  const seconds = shotFrames(shot) / scene.render.fps;
  useEffect(() => setError(''), [shot.id, scene.sceneId, mode]);
  useEffect(() => {if (target && !partTargetIds(scene).includes(target)) setTarget('');}, [target, scene.product.components, scene.product.removedPartIds]);

  const update = (edit: (camera: CameraDefinition) => void, seek = true) => {
    try {
      const draft = structuredClone(scene);
      editCamera(draft, shot.id, edit);
      onChange(next => {next.shots.find((item: any) => item.id === shot.id).camera = draft.shots.find((item: any) => item.id === shot.id).camera;});
      setError(''); if (seek) {onFrame(endpointFrame); onResetView?.();}
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Camera could not be updated.');}
  };
  const updatePose = (edit: (pose: CameraPose) => void, lensOnly = false) => {
    if (spatialDisabled && !lensOnly) return;
    update(next => {if (still || unavailableEnd) offsetCameraFraming(next, pose, edit); else edit(next[end]);});
  };
  const go = (nextEnd: CameraEnd) => {if (nextEnd === 'to' && (trimmedEnd || heldCamera)) return; if (onCameraEndChange) {onCameraEndChange(nextEnd); return;} setEndSelection({shotId: shot.id, end: nextEnd}); onFrame(nextEnd === 'from' ? shot.startFrame : sourceEnd); onResetView?.();};
  const sampleAt = (at: number) => samples.find(sample => sample.frame === at && sample.shotId === shot.id);
  const aim = (both: boolean) => {
    if (spatialDisabled || both && (trimmedEnd || heldCamera)) return;
    try {
      if (still) {
        const point = cameraTarget(scene, sampleAt(frame), target || undefined);
        updatePose(next => {next.targetM = point;});
      } else {
        const targets = (both ? ['from', 'to'] : [end]) as CameraEnd[];
        const points = targets.map(point => ({end: point, target: cameraTarget(scene, sampleAt(point === 'from' ? shot.startFrame : sourceEnd), target || undefined)}));
        update(next => {for (const point of points) next[point.end].targetM = point.target;});
      }
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Target is unavailable.');}
  };

  const aspect = formats.find(format => Math.abs(scene.render.width / scene.render.height - format.width / format.height) < .00001);
  const resize = (width: number, height: number) => {
    try {
      const draft = structuredClone(scene); setOutputDimensions(draft, width, height);
      onChange(next => {next.render.width = draft.render.width; next.render.height = draft.render.height;});
      setError('');
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Frame size could not be updated.');}
  };
  const optics = camera.depthOfField, focusEnabled = Boolean(optics?.enabled), followTarget = optics?.focusDistanceM == null;
  const targetDistance = Math.hypot(...sampledPose.positionM.map((value, index) => value - sampledPose.targetM[index]));
  const focusDistance = optics?.focusDistanceM ?? targetDistance;
  const focus = (patch: {enabled?: boolean; fStop?: number; focusDistanceM?: number | null}) => update(next => {
    const {focusDistanceM, ...rest} = patch;
    const settings = {enabled: false, fStop: 2.8, ...next.depthOfField, ...rest};
    if (focusDistanceM === null) delete settings.focusDistanceM;
    else if (focusDistanceM !== undefined) settings.focusDistanceM = focusDistanceM;
    next.depthOfField = settings;
  }, false);

  return <div className={`gesso-panel gesso-compact-panel gesso-camera-panel${embedded ? ' gesso-camera-embedded' : ''}`}>
    {(!embedded || !still) && <section className="gesso-section gesso-camera-scope" aria-label="Camera scope">
      {!embedded && <StepField label="Scene"><select aria-label="Camera shot" value={shot.id} onChange={event => {const next = scene.shots.find((item: any) => item.id === event.target.value); onFrame(end === 'from' ? next.startFrame : Math.min(next.endFrame, cameraSourceEndFrame(next))); onResetView?.();}}>
        {scene.shots.map((item: any, index: number) => <option key={item.id} value={item.id}>{String(index + 1).padStart(2, '0')} / {item.name || 'Untitled shot'}</option>)}
      </select></StepField>}
      {!still && <div className="gesso-button-row" aria-label="Camera endpoint">
        <button type="button" aria-pressed={end === 'from'} onClick={() => go('from')}>Start</button>
        <button type="button" aria-pressed={end === 'to'} disabled={trimmedEnd || heldCamera} onClick={() => go('to')}>{trimmedEnd ? 'Source end · trimmed' : heldCamera ? 'Held camera' : 'End'}</button>
      </div>}
    </section>}
    <section className="gesso-section gesso-camera-essentials" aria-label="Camera framing">
      <StepField label="Frame"><select aria-label="Camera aspect ratio" value={aspect?.label ?? 'custom'} onChange={event => {const next = formats.find(format => format.label === event.target.value); setCustomSize(!next); if (next) resize(next.width, next.height);}}>{formats.map(format => <option key={format.label} value={format.label}>{format.label}</option>)}<option value="custom">Custom</option></select></StepField>
      <details className="film-rail-disclosure gesso-camera-size" open={customSize} onToggle={event => setCustomSize(event.currentTarget.open)}>
        <summary><UiIcon name="chevron"/><span>Output size</span><small>{scene.render.width} × {scene.render.height}</small></summary>
        <div className="film-rail-detail-body"><StepNumber label="Width" ariaLabel="Camera frame width" value={scene.render.width} min={2} max={8192} step={2} unit="px" onChange={value => resize(value, scene.render.height)}/><StepNumber label="Height" ariaLabel="Camera frame height" value={scene.render.height} min={2} max={8192} step={2} unit="px" onChange={value => resize(scene.render.width, value)}/></div>
      </details>
      <StepNumber label="Lens" ariaLabel="Focal length" value={pose.focalLengthMm} unit="mm" min={1} max={1000} onChange={value => updatePose(next => {next.focalLengthMm = value;}, true)}/>
      <div className="gesso-camera-aimrow"><StepField label="Target"><select aria-label="Target" disabled={spatialDisabled} value={target} onChange={event => setTarget(event.target.value)}><option value="">Whole product</option>{partTargetIds(scene).map(id => <option key={id} value={id}>{displayPartName(scene, id)}</option>)}</select></StepField>
        <button type="button" aria-label={still ? 'Aim at frame' : `Aim at ${end === 'from' ? 'start' : 'end'}`} disabled={spatialDisabled || !sampleAt(endpointFrame)} onClick={() => aim(false)}>Aim</button></div>
      <label className="gesso-check gesso-camera-focus-toggle"><input type="checkbox" aria-label="Depth of field" checked={focusEnabled} onChange={event => focus({enabled: event.target.checked})}/><span>Depth of field</span></label>
      {focusEnabled && <div className="gesso-camera-focus-settings">
        <StepNumber label="f-stop" ariaLabel="Camera aperture" value={optics?.fStop ?? 2.8} min={.7} max={32} step={.1} onChange={value => focus({fStop: value})}/>
        <StepField label="Focus"><select aria-label="Focus mode" value={followTarget ? 'target' : 'distance'} onChange={event => focus({focusDistanceM: event.target.value === 'target' ? null : targetDistance})}><option value="target">Follow target</option><option value="distance">Set distance</option></select></StepField>
        {!followTarget && <StepNumber label="Distance" ariaLabel="Camera focus distance" value={focusDistance * 1000} min={1} max={1000000} step={1} unit="mm" onChange={value => focus({focusDistanceM: value / 1000})}/>}
      </div>}
    </section>
    <details className="film-rail-disclosure gesso-camera-position"><summary><UiIcon name="chevron"/><span>Position and target</span></summary><div className="film-rail-detail-body"><fieldset className="film-camera-fields" disabled={spatialDisabled}>
      <StepVector factor={1000} unit="mm" label={`${scope} target`} values={pose.targetM} onChange={(index, value) => updatePose(next => {next.targetM[index] = value;})}/>
      <StepVector factor={1000} unit="mm" label={`${scope} position`} values={pose.positionM} onChange={(index, value) => updatePose(next => {next.positionM[index] = value;})}/>
    </fieldset></div></details>
    {!still && trimmedEnd && <p className="gesso-meta gesso-note">Camera source end (frame {sourceEnd}) is outside this shot. Extend the shot to edit it.</p>}
    <details className="film-rail-disclosure gesso-camera-advanced"><summary><UiIcon name="chevron"/><span>Advanced</span></summary><div className="film-rail-detail-body">
      <div className="gesso-button-row gesso-lens-presets">{[24, 35, 50, 85].map(value => <button type="button" key={value} aria-pressed={Math.abs(pose.focalLengthMm - value) < .0001} onClick={() => updatePose(next => {next.focalLengthMm = value;}, true)}>{value} mm</button>)}</div>
      {!still && <section className="gesso-section" aria-label="Path controls"><div className="gesso-section-heading"><span className="gesso-section-label">Path</span><span>{Number(seconds.toFixed(3))} s</span></div>
        <div className="gesso-button-row"><button type="button" disabled={cameraMotionDriven} onClick={() => update(next => {const before = next.from; next.from = next.to; next.to = before;})}>Reverse</button><button type="button" disabled={cameraMotionDriven} onClick={() => update(next => {next.from = structuredClone(pose); next.to = structuredClone(pose);})}>Hold view</button></div>
      </section>}
      {!still && <button type="button" disabled={spatialDisabled || trimmedEnd || heldCamera || !sampleAt(shot.startFrame) || !sampleAt(sourceEnd)} onClick={() => aim(true)}>Both ends</button>}
      {!still && <><button type="button" onClick={() => update(next => {next.from.focalLengthMm = pose.focalLengthMm; next.to.focalLengthMm = pose.focalLengthMm;})}>Use lens for whole scene</button>
        <button type="button" disabled={spatialDisabled || trimmedEnd || heldCamera} onClick={() => update(next => {next[end === 'from' ? 'to' : 'from'] = structuredClone(pose);})}>Copy {end === 'from' ? 'start to end' : 'end to start'}</button></>}
      <div className="gesso-button-row"><button type="button" disabled={spatialDisabled} onClick={() => updatePose(next => {next.positionM = pose.positionM.map((value, index) => pose.targetM[index] + (value - pose.targetM[index]) * .9);})}>Move closer</button>
        <button type="button" disabled={spatialDisabled} onClick={() => updatePose(next => {next.positionM = pose.positionM.map((value, index) => pose.targetM[index] + (value - pose.targetM[index]) * 1.1);})}>Move back</button></div>
      {still && <p className="gesso-meta gesso-note gesso-camera-edit-scope">Edits shift the whole scene. Video motion is preserved.</p>}
      <p className="gesso-meta">36 mm sensor</p>
    </div></details>
    {error && <p className="gesso-error gesso-feedback" data-tone="error" role="alert">{error}</p>}
  </div>;
}
