import {useId, type KeyboardEvent, type PointerEvent} from 'react';
import {shotAtFrame} from './sequence';
import {cameraSourceEndFrame} from './cameraFraming';
import {isCameraFilmGuide, type FilmPresentationGuide} from './filmGuides';

export interface FilmViewportControlsProps {
  guide: FilmPresentationGuide | null;
  scene: any;
  frame: number;
  mode: 'still' | 'video';
  end: 'from' | 'to';
  editing: boolean;
  disabled: boolean;
  cameraMotionDriven?: boolean;
  error?: string;
  dragging?: boolean;
  onTargetPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onTargetKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** Shared, transparent marks. Coordinates come from the same gate as the rendered pixels. */
export function FilmFrameMarks() {
  return <>
    {['tl', 'tr', 'bl', 'br'].map(corner => <i key={corner} className={`gesso-film-gate-corner ${corner}`}/>)}
    <div className="gesso-film-midlines"><i/><i/></div>
    <i className="gesso-film-crosshair"/>
  </>;
}

/** Only the target is interactive; all camera settings live in the inspector. */
export default function FilmViewportControls({guide, scene, frame, mode, end, editing, disabled,
  cameraMotionDriven = false, error, dragging = false, onTargetPointerDown, onTargetKeyDown}: FilmViewportControlsProps) {
  const id = useId();
  if (!guide?.gate.width || !guide.gate.height) return null;
  const cameraGuide = isCameraFilmGuide(guide) ? guide : null;
  const shot = shotAtFrame(scene, frame);
  const sourceEnd = shot.camera ? cameraSourceEndFrame(shot) : shot.startFrame;
  const isEndpoint = mode === 'still' || frame === (end === 'from' ? shot.startFrame : sourceEnd) && !(end === 'to' && sourceEnd === shot.startFrame);
  const manualFocus = !!shot.camera?.depthOfField?.enabled && shot.camera.depthOfField.focusDistanceM != null;
  const marker = cameraGuide?.focus ?? cameraGuide?.target;
  const showHandle = editing && !cameraMotionDriven && !cameraGuide?.inspecting && isEndpoint && !manualFocus;
  const canAim = showHandle && !disabled;
  const hint = manualFocus ? 'Focus distance is set in the Camera controls.'
    : cameraMotionDriven ? 'Camera motion controls this target.'
    : cameraGuide?.inspecting ? 'Return to shot to edit the camera target.'
    : !isEndpoint ? 'Select Start or End in Camera to move the target.'
    : dragging ? 'Release to aim. Escape cancels.' : 'Drag to aim. Arrow keys nudge; Shift moves farther.';
  const markerLabel = cameraGuide?.focus ? 'Focus point' : 'Camera target';
  const {gate} = guide;
  return <div className={`gesso-film-viewport-controls${dragging ? ' is-dragging' : ''}`} aria-label="Film viewport guides">
    <div className="gesso-film-gate" aria-hidden="true" style={{left: gate.x, top: gate.y, width: gate.width, height: gate.height}}><FilmFrameMarks/></div>
    {marker?.visible && <div className="gesso-film-target" style={{left: marker.x, top: marker.y}}>
      {showHandle ? <button type="button" className="gesso-film-target-handle" aria-label={markerLabel} aria-describedby={`${id}-target-hint`} title={hint} aria-disabled={!canAim} tabIndex={canAim ? 0 : -1}
        onPointerDown={event => {if (canAim) onTargetPointerDown(event);}} onKeyDown={event => {if (canAim) onTargetKeyDown(event); else if (event.key.startsWith('Arrow')) {event.preventDefault();event.stopPropagation();}}}><span/></button>
        : <span className="gesso-film-focus-marker" role="img" aria-label={markerLabel} title={hint}/>}
    </div>}
    <span className="gesso-film-guide-description" id={`${id}-target-hint`}>{hint}</span>
    {editing && error && <p className="gesso-film-guide-error" role="alert">{error}</p>}
  </div>;
}
