import {useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent} from 'react';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import {partName} from './hierarchy';
import {shotAtFrame} from './sequence';
import type {FilmGuideProjection} from './filmGuides';

export interface FilmViewportControlsProps {
  guide: FilmGuideProjection | null;
  scene: any;
  frame: number;
  mode: 'still' | 'video';
  end: 'from' | 'to';
  editing: boolean;
  disabled: boolean;
  error?: string;
  dragging?: boolean;
  targetId?: string;
  onTargetChange?: (componentId: string) => void;
  onEndChange: (end: 'from' | 'to') => void;
  onAspectChange: (width: number, height: number) => void;
  onFocalLengthChange: (value: number) => void;
  onDepthOfFieldChange: (patch: {enabled?: boolean; fStop?: number; focusDistanceM?: number | null}) => void;
  onAim: (componentId: string) => void;
  onTargetPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onTargetKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export function filmAspectLabel(width: number, height: number): string {
  if (![width, height].every(value => Number.isFinite(value) && value > 0)) return '—';
  let divisor = Math.round(width), remainder = Math.round(height);
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

const formats = [
  {label: '9:16', width: 1080, height: 1920},
  {label: '16:9', width: 1920, height: 1080},
  {label: '1:1', width: 1080, height: 1080},
  {label: '4:5', width: 1080, height: 1350},
];

/** UI stays attached to the render gate; the scene receives every other pointer event. */
export default function FilmViewportControls({guide, scene, frame, mode, end, editing, disabled, error, dragging = false, targetId, onTargetChange,
  onEndChange, onAspectChange, onFocalLengthChange, onDepthOfFieldChange, onAim, onTargetPointerDown, onTargetKeyDown}: FilmViewportControlsProps) {
  const [thirds, setThirds] = useState(false);
  const [localTarget, setLocalTarget] = useState('');
  const target = targetId ?? localTarget;
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const focusRef = useRef<HTMLDetailsElement>(null);
  const id = useId();
  const shot = shotAtFrame(scene, frame);
  const depthOfField = shot.camera.depthOfField;
  const focusEnabled = Boolean(depthOfField?.enabled);
  useEffect(() => {if (focusRef.current && focusEnabled) focusRef.current.open = true;}, [focusEnabled]);
  const parts = scene.product.components as {id: string; name?: string}[];
  useEffect(() => {if (target && !parts.some(part => part.id === target)) {setLocalTarget(''); onTargetChange?.('');}}, [parts, target, onTargetChange]);
  const chooseTarget = (componentId: string) => {setLocalTarget(componentId); onTargetChange?.(componentId);};
  useEffect(() => {if (!editing && detailsRef.current) detailsRef.current.open = false;}, [editing]);
  if (!guide || !guide.gate.width || !guide.gate.height) return null;
  const {gate, inspecting} = guide;
  const width = scene.render.width, height = scene.render.height;
  const ratio = filmAspectLabel(width, height);
  const isEndpoint = mode === 'still' || frame === (end === 'from' ? shot.startFrame : shot.endFrame);
  const cameraDisabled = disabled || !isEndpoint || inspecting;
  const fStop = depthOfField?.fStop ?? 2.8;
  const followTarget = depthOfField?.focusDistanceM == null;
  const focusDistanceM = followTarget ? guide.distanceM : depthOfField.focusDistanceM;
  const focusMillimetres = Number((focusDistanceM * 1000).toFixed(1));
  const distance = guide.distanceM >= 1 ? `${Number(guide.distanceM.toFixed(2))} m` : `${Number((guide.distanceM * 1000).toFixed(1))} mm`;
  const closeFormat = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== 'Escape' || !event.currentTarget.open) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
    event.currentTarget.querySelector('summary')?.focus();
  };
  const hint = inspecting ? 'Return to shot to edit' : !isEndpoint ? 'Choose Start or End to edit' : dragging ? 'Release to aim · Esc cancel' : 'Drag target · arrows to nudge';
  return <div className={`gesso-film-viewport-controls${editing ? ' is-editing' : ''}${inspecting ? ' is-inspecting' : ''}${dragging ? ' is-dragging' : ''}`} data-compact={guide.viewportWidth < 720} aria-label="Film viewport guides" onPointerDown={event => event.stopPropagation()}>
    {!inspecting && <div className="gesso-film-gate" aria-hidden="true" style={{left: gate.x, top: gate.y, width: gate.width, height: gate.height}}>
      {['tl', 'tr', 'bl', 'br'].map(corner => <i key={corner} className={`gesso-film-gate-corner ${corner}`}/>)}
      {thirds && <div className="gesso-film-thirds">{[1, 2].map(index => <span key={index} style={{'--third': index} as CSSProperties}/>)}</div>}
    </div>}
    {!inspecting && <details ref={detailsRef} className="gesso-film-format" onKeyDown={closeFormat} style={{left: gate.x, top: gate.y}}>
      <summary aria-label={`Render frame ${ratio}, ${width} by ${height} pixels`}><span>render frame</span><span>{ratio}</span><span className="gesso-film-frame-size">{width} × {height}</span><UiIcon name="down" size={14}/></summary>
      <div className="gesso-film-format-panel gesso-panel" aria-label="Render frame dimensions">
        <div className="gesso-film-formats" aria-label="Aspect ratio">{formats.map(format => <button type="button" key={format.label} aria-pressed={Math.abs(width / height - format.width / format.height) < .00001} disabled={disabled} onClick={() => onAspectChange(format.width, format.height)}>{format.label}</button>)}</div>
        <NumberControl label="Width" ariaLabel="Viewport frame width" value={width} min={2} max={8192} step={2} unit="px" disabled={disabled} onChange={value => onAspectChange(value, height)}/>
        <NumberControl label="Height" ariaLabel="Viewport frame height" value={height} min={2} max={8192} step={2} unit="px" disabled={disabled} onChange={value => onAspectChange(width, value)}/>
        <label className="gesso-check"><input type="checkbox" checked={thirds} onChange={event => setThirds(event.target.checked)}/><span>Thirds guide</span></label>
      </div>
    </details>}
    {editing && guide.target.visible && <div className="gesso-film-target" style={{left: guide.target.x, top: guide.target.y}}>
      <button type="button" className="gesso-film-target-handle" aria-label="Camera target" aria-describedby={`${id}-target-hint`} title="Drag camera target; arrow keys nudge, Shift + arrow moves farther" disabled={cameraDisabled} onPointerDown={onTargetPointerDown} onKeyDown={onTargetKeyDown}><span/><i/></button>
      <span className="gesso-film-target-label">Target <span>{distance}</span></span>
    </div>}
    {editing && <div className="gesso-film-control-rail">
      <div className="gesso-film-aim-control">
        <label htmlFor={`${id}-target`}>Target</label>
        <select id={`${id}-target`} aria-label="Viewport camera target" disabled={cameraDisabled} value={target} onChange={event => chooseTarget(event.target.value)}><option value="">Whole product</option>{parts.map(part => <option key={part.id} value={part.id}>{part.name || partName(part.id)}</option>)}</select>
        <button type="button" disabled={cameraDisabled} onClick={() => onAim(target)}>Aim</button>
      </div>
      <div className="gesso-film-lens-control gesso-panel"><NumberControl label="Lens" ariaLabel="Viewport focal length" value={guide.focalLengthMm} min={1} max={1000} unit="mm" disabled={cameraDisabled} onChange={onFocalLengthChange}/></div>
      <details className="gesso-film-focus" ref={focusRef} open={focusEnabled || undefined} onKeyDown={closeFormat}>
        <summary><span>Focus</span><span>{focusEnabled ? `${focusMillimetres} mm · f/${fStop}` : 'Off'}</span><UiIcon name="down" size={14}/></summary>
        <div className="gesso-film-focus-panel gesso-panel" aria-label="Viewport depth of field">
          <label className="gesso-check"><input type="checkbox" aria-label="Viewport depth of field" checked={focusEnabled} disabled={disabled || inspecting} onChange={event => onDepthOfFieldChange({enabled: event.target.checked})}/><span>Depth of field</span></label>
          <NumberControl label="f-stop" ariaLabel="Viewport aperture" value={fStop} min={.7} max={32} step={.1} disabled={disabled || inspecting || !focusEnabled} onChange={value => onDepthOfFieldChange({fStop: value})}/>
          <NumberControl label="Distance" ariaLabel="Viewport focus distance" value={focusMillimetres} min={1} max={1000000} step={1} unit="mm" disabled={disabled || inspecting || !focusEnabled} onChange={value => onDepthOfFieldChange({focusDistanceM: value / 1000})}/>
          <label className="gesso-check"><input type="checkbox" aria-label="Follow camera target" checked={followTarget} disabled={disabled || inspecting || !focusEnabled} onChange={event => onDepthOfFieldChange({focusDistanceM: event.target.checked ? null : guide.distanceM})}/><span>Follow target</span></label>
        </div>
      </details>
      {mode === 'video' && <div className="gesso-film-end-controls" aria-label="Viewport camera endpoint">
        <button type="button" aria-pressed={isEndpoint && end === 'from'} disabled={disabled} onClick={() => onEndChange('from')}>Start <span>{shot.startFrame}</span></button>
        <button type="button" aria-pressed={isEndpoint && end === 'to'} disabled={disabled} onClick={() => onEndChange('to')}>End <span>{shot.endFrame}</span></button>
      </div>}
      <p className="gesso-film-target-hint" id={`${id}-target-hint`}>{error ? <span role="alert">{error}</span> : hint}{!guide.target.visible && !error && <span> · target outside view</span>}</p>
    </div>}
  </div>;
}
