import {useEffect, useState, type ReactNode} from 'react';
import {cameraTarget, editCamera, type CameraEnd, type CameraPose} from './camera';
import {cameraPoseAtFrame, cameraSourceEndFrame, offsetCameraFraming} from './cameraFraming';
import {shotAtFrame, shotFrames} from './sequence';
import {displayPartName} from './hierarchy';
import {NumberControl as StepNumber, VectorControl as StepVector} from './EditorControls';
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
  viewportControls?: boolean;
  cameraTargetId?: string;
  onCameraTargetChange?: (id: string) => void;
}

export default function CameraPanel({scene, frame, samples = [], mode = 'video', embedded = false, onChange, onFrame, onResetView, cameraEnd, onCameraEndChange, viewportControls = false, cameraTargetId, onCameraTargetChange}: CameraPanelProps) {
  const [endSelection, setEndSelection] = useState<{shotId: string; end: CameraEnd}>(() => {const selected = shotAtFrame(scene, frame); return {shotId: selected.id, end: frame !== selected.startFrame && frame === cameraSourceEndFrame(selected) ? 'to' : 'from'};});
  const [localTarget, setLocalTarget] = useState('');
  const target = cameraTargetId ?? localTarget;
  const setTarget = onCameraTargetChange ?? setLocalTarget;
  const [error, setError] = useState('');
  const shot = shotAtFrame(scene, frame);
  const end = cameraEnd ?? (endSelection.shotId === shot.id ? endSelection.end : frame !== shot.startFrame && frame === cameraSourceEndFrame(shot) ? 'to' : 'from');
  const camera = shot.camera;
  const still = mode === 'still';
  const sourceEnd = cameraSourceEndFrame(shot), trimmedEnd = sourceEnd > shot.endFrame, heldCamera = sourceEnd === shot.startFrame;
  const unavailableEnd = !still && end === 'to' && (trimmedEnd || heldCamera);
  const sampledPose: CameraPose = samples.find(sample => sample.frame === frame && sample.shotId === shot.id)?.camera ?? cameraPoseAtFrame(shot, frame);
  const pose: CameraPose = still || unavailableEnd ? sampledPose : camera[end];
  const endpointFrame = still || unavailableEnd ? frame : end === 'from' ? shot.startFrame : sourceEnd;
  const scope = still || unavailableEnd ? 'Frame' : end === 'from' ? 'Start' : 'End';
  const seconds = shotFrames(shot) / scene.render.fps;
  useEffect(() => setError(''), [shot.id, scene.sceneId, mode]);
  useEffect(() => {if (target && !scene.product.components.some((part: any) => part.id === target)) setTarget('');}, [target, scene.product.components]);

  const update = (edit: (camera: {from: CameraPose; to: CameraPose}) => void) => {
    try {
      const draft = structuredClone(scene);
      editCamera(draft, shot.id, edit);
      onChange(next => {next.shots.find((item: any) => item.id === shot.id).camera = draft.shots.find((item: any) => item.id === shot.id).camera;});
      setError(''); onFrame(endpointFrame); onResetView?.();
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Camera could not be updated.');}
  };
  const updatePose = (edit: (pose: CameraPose) => void, lensOnly = false) => {
    if (unavailableEnd && !lensOnly) return;
    update(next => {if (still || unavailableEnd) offsetCameraFraming(next, pose, edit); else edit(next[end]);});
  };
  const go = (nextEnd: CameraEnd) => {if (nextEnd === 'to' && (trimmedEnd || heldCamera)) return; if (onCameraEndChange) {onCameraEndChange(nextEnd); return;} setEndSelection({shotId: shot.id, end: nextEnd}); onFrame(nextEnd === 'from' ? shot.startFrame : sourceEnd); onResetView?.();};
  const sampleAt = (at: number) => samples.find(sample => sample.frame === at && sample.shotId === shot.id);
  const aim = (both: boolean) => {
    if (unavailableEnd || both && (trimmedEnd || heldCamera)) return;
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

  return <div className={`gesso-panel gesso-compact-panel gesso-camera-panel${embedded ? ' gesso-camera-embedded' : ''}`}>
    {!viewportControls && (!embedded || !still) && <section className="gesso-section gesso-camera-scope" aria-label="Camera scope">
      {!embedded && <StepField label="Shot"><select aria-label="Camera shot" value={shot.id} onChange={event => {const next = scene.shots.find((item: any) => item.id === event.target.value); onFrame(end === 'from' ? next.startFrame : Math.min(next.endFrame, cameraSourceEndFrame(next))); onResetView?.();}}>
        {scene.shots.map((item: any, index: number) => <option key={item.id} value={item.id}>{String(index + 1).padStart(2, '0')} / {item.name || 'Untitled shot'}</option>)}
      </select></StepField>}
      {!still && <div className="gesso-button-row" aria-label="Camera endpoint">
        <button type="button" aria-pressed={end === 'from'} onClick={() => go('from')}>Start <span className="gesso-meta">{shot.startFrame}</span></button>
        <button type="button" aria-pressed={end === 'to'} disabled={trimmedEnd || heldCamera} onClick={() => go('to')}>{trimmedEnd ? 'Source end · trimmed' : heldCamera ? 'Held camera' : 'End'} <span className="gesso-meta">{sourceEnd}</span></button>
      </div>}
    </section>}

    {!viewportControls && <section className="gesso-section" aria-label="Lens controls">
      <StepNumber label="Focal length" value={pose.focalLengthMm} unit="mm" min={1} max={1000} onChange={value => updatePose(next => {next.focalLengthMm = value;}, true)}/>

    </section>}

    <section className="gesso-section" aria-label="Aim controls"><fieldset className="film-camera-fields" disabled={unavailableEnd}>
      {!viewportControls && <div className="gesso-camera-aimrow"><StepField label="Aim"><select aria-label="Target" disabled={unavailableEnd} value={target} onChange={event => setTarget(event.target.value)}><option value="">Whole product</option>{scene.product.components.map((part: any) => <option key={part.id} value={part.id}>{displayPartName(scene, part.id, part.name)}</option>)}</select></StepField>
        <button type="button" aria-label={still ? 'Aim at frame' : `Aim at ${end === 'from' ? 'start' : 'end'}`} disabled={unavailableEnd || !sampleAt(endpointFrame)} onClick={() => aim(false)}>Aim</button></div>}
      <StepVector factor={1000} unit="mm" label={`${scope} target`} values={pose.targetM} onChange={(index, value) => updatePose(next => {next.targetM[index] = value;})}/>
      <StepVector factor={1000} unit="mm" label={`${scope} position`} values={pose.positionM} onChange={(index, value) => updatePose(next => {next.positionM[index] = value;})}/>
    </fieldset></section>

    {!still && trimmedEnd && <p className="gesso-meta">Camera source end (frame {sourceEnd}) is outside this shot. Extend the shot to edit it.</p>}
    {still && <p className="gesso-meta gesso-camera-edit-scope">Edits shift the whole shot. Video motion is preserved.</p>}
    <details className="gesso-disclosure gesso-compact-details gesso-camera-options"><summary>Camera options <span>{still ? 'presets / composition' : 'presets / path'}</span></summary><div className="gesso-section">
      <div className="gesso-button-row gesso-lens-presets">{[24, 35, 50, 85].map(value => <button type="button" key={value} aria-pressed={Math.abs(pose.focalLengthMm - value) < .0001} onClick={() => updatePose(next => {next.focalLengthMm = value;}, true)}>{value} mm</button>)}</div>
    {!still && <section className="gesso-section" aria-label="Path controls"><div className="gesso-section-heading">Path <span>{Number(seconds.toFixed(3))} s · ease in / out</span></div>
      <div className="gesso-button-row"><button type="button" onClick={() => update(next => {const before = next.from; next.from = next.to; next.to = before;})}>Reverse</button><button type="button" onClick={() => update(next => {next.from = structuredClone(pose); next.to = structuredClone(pose);})}>Hold view</button></div>
    </section>}
      {!still && <button type="button" disabled={trimmedEnd || heldCamera || !sampleAt(shot.startFrame) || !sampleAt(sourceEnd)} onClick={() => aim(true)}>Both ends</button>}
      {!still && <><button type="button" onClick={() => update(next => {next.from.focalLengthMm = pose.focalLengthMm; next.to.focalLengthMm = pose.focalLengthMm;})}>Use focal length for whole shot</button>
        <button type="button" disabled={trimmedEnd || heldCamera} onClick={() => update(next => {next[end === 'from' ? 'to' : 'from'] = structuredClone(pose);})}>Copy {end === 'from' ? 'start to end' : 'end to start'}</button></>}
      <div className="gesso-button-row"><button type="button" disabled={unavailableEnd} onClick={() => updatePose(next => {next.positionM = pose.positionM.map((value, index) => pose.targetM[index] + (value - pose.targetM[index]) * .9);})}>Move closer</button>
        <button type="button" disabled={unavailableEnd} onClick={() => updatePose(next => {next.positionM = pose.positionM.map((value, index) => pose.targetM[index] + (value - pose.targetM[index]) * 1.1);})}>Move back</button></div>
      <p className="gesso-meta">36 mm sensor. Output: {scene.render.width} × {scene.render.height}. Depth of field is controlled on the image.</p>
    </div></details>
    {error && <p className="gesso-error" role="alert">{error}</p>}
  </div>;
}
