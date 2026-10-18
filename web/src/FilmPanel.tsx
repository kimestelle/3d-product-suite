import {UiIcon} from './UiIcon';
import {useEffect, useState, type ReactNode} from 'react';
import {addShot, duplicateShot, moveShot, removeShot, sequenceEnd, setFrameRate, setOutputDimensions, setShotFrames, shotAtFrame, shotFrames} from './sequence';
import {NumberControl as StepNumber} from './EditorControls';
import type {CameraEnd} from './camera';
import CameraPanel from './CameraPanel';

function FilmSectionBlock({name, description, active, shortcut, onSelect, children}: {name: FilmSection; description: ReactNode; active: boolean; shortcut: number; onSelect: () => void; children: ReactNode}) {
  return <section className={`gesso-control-section${active ? ' is-open' : ''}`}>
    <button type="button" className="gesso-section-toggle" aria-expanded={active} aria-controls={`film-section-${name}`} aria-keyshortcuts={`Alt+${shortcut}`} title={`Option / Alt ${shortcut}`} onClick={onSelect}><span>{name}</span><small>{description}</small><UiIcon name={active ? "down" : "chevron"} size={14}/></button>
    {active && <div id={`film-section-${name}`} className="gesso-section-body">{children}</div>}
  </section>;
}
function StepField({label, children}: {label: string; children: ReactNode}) {return <label className="gesso-field gesso-inline-field"><span>{label}</span>{children}</label>;}

export type FilmSection = 'Framing' | 'Animation' | 'Sequence' | 'Output';
export type FilmLayer = FilmSection | 'Shots' | 'Timing';
export interface FilmPanelProps {
  scene: any;
  layer?: FilmLayer;
  onLayerChange?: (layer: FilmSection) => void;
  mode?: 'still' | 'video';
  frame: number;
  samples?: any[];
  onChange: (edit: (scene: any) => void) => void;
  onFrame: (frame: number) => void;
  onResetView?: () => void;
  cameraEnd?: CameraEnd;
  onCameraEndChange?: (end: CameraEnd) => void;
  viewportControls?: boolean;
  cameraTargetId?: string;
  onCameraTargetChange?: (id: string) => void;
  animationContent?: ReactNode;
  renderJobs?: ReactNode;
  onRender?: (kind: 'still' | 'reel') => void;
  renderDisabled?: boolean;
  renderReelDisabled?: boolean;
  renderBusy?: boolean;
}

/** Keep all changes made by sequence edits, including frame-rate retiming of authored keys. */
export function commitFilmDraft(scene: any, draft: any) {
  scene.shots = draft.shots;
  scene.render = draft.render;
  if (draft.animation !== undefined) scene.animation = draft.animation;
}

const outputSizes = [{label: 'Portrait / 1080 × 1920', width: 1080, height: 1920}, {label: 'Landscape / 1920 × 1080', width: 1920, height: 1080}, {label: 'Square / 1080 × 1080', width: 1080, height: 1080}, {label: 'Portrait / 540 × 960', width: 540, height: 960}, {label: 'Landscape / 960 × 540', width: 960, height: 540}];

export default function FilmPanel({scene, layer, onLayerChange, mode = 'video', frame, samples = [], onChange, onFrame, onResetView, cameraEnd, onCameraEndChange, viewportControls, cameraTargetId, onCameraTargetChange, animationContent, renderJobs, onRender, renderDisabled, renderReelDisabled, renderBusy}: FilmPanelProps) {
  const [error, setError] = useState('');
  const [localSection, setLocalSection] = useState<FilmSection>('Framing');
  const selectedSection = layer === 'Shots' ? 'Sequence' : layer === 'Timing' ? 'Output' : layer ?? localSection;
  const shot = shotAtFrame(scene, frame);
  const index = scene.shots.findIndex((item: any) => item.id === shot.id);
  const fps = scene.render.fps;
  const total = sequenceEnd(scene);
  const still = mode === 'still';
  useEffect(() => setError(''), [scene.sceneId, mode]);
  const section = still && (selectedSection === 'Animation' || selectedSection === 'Sequence') ? 'Framing' : selectedSection;

  const edit = (mutate: (draft: any) => string | void) => {
    try {
      const draft = structuredClone(scene);
      const selectedId = mutate(draft) || shot.id;
      const nextShot = draft.shots.find((item: any) => item.id === selectedId) ?? draft.shots[0];
      const offset = selectedId === shot.id ? Math.round((frame - shot.startFrame) * draft.render.fps / fps) : 0;
      onChange(next => commitFilmDraft(next, draft));
      onFrame(nextShot.startFrame + Math.min(Math.max(0, offset), shotFrames(nextShot) - 1));
      setError('');
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'Film could not be updated.');}
  };
  const chosenSize = outputSizes.findIndex(size => size.width === scene.render.width && size.height === scene.render.height);
  const selectSection = (next: FilmSection) => {setLocalSection(next); onLayerChange?.(next);};

  return <div className="gesso-panel gesso-compact-panel gesso-film-panel">
    <section className="gesso-section gesso-film-scope" aria-label="Film scope">
      {still ? <><StepNumber label="Frame" value={frame} min={1} max={total} step={1} onChange={value => {onFrame(Math.round(value)); onResetView?.();}}/>
        <p className="gesso-meta">{shot.name || `Shot ${String(index + 1).padStart(2, '0')}`} · {frame} / {total}</p></> :
      <StepField label="Shot"><select aria-label="Film shot" value={shot.id} onChange={event => {const next = scene.shots.find((item: any) => item.id === event.target.value); onFrame(next.startFrame); onResetView?.();}}>
        {scene.shots.map((item: any, position: number) => <option key={item.id} value={item.id}>{String(position + 1).padStart(2, '0')} / {item.name || 'Untitled shot'}</option>)}
      </select></StepField>}
    </section>

    <div className="gesso-control-sections">
    <FilmSectionBlock name="Framing" shortcut={5} description={viewportControls ? 'position / path' : 'lens / aim / position'} active={section === 'Framing'} onSelect={() => selectSection('Framing')}>
      <CameraPanel embedded mode={mode} cameraEnd={cameraEnd} onCameraEndChange={onCameraEndChange} viewportControls={viewportControls} cameraTargetId={cameraTargetId} onCameraTargetChange={onCameraTargetChange} scene={scene} frame={frame} samples={samples} onChange={onChange} onFrame={onFrame} onResetView={onResetView}/>
    </FilmSectionBlock>

    {!still && <FilmSectionBlock name="Animation" shortcut={6} description="parts / transforms / keys" active={section === 'Animation'} onSelect={() => selectSection('Animation')}>
      {animationContent ?? <p className="gesso-meta">Select a part to edit its movement in the keyframe editor.</p>}
    </FilmSectionBlock>}

    {!still && <FilmSectionBlock name="Sequence" shortcut={7} description={<>{scene.shots.length} {scene.shots.length === 1 ? 'shot' : 'shots'} · {Number((total / fps).toFixed(3))} s</>} active={section === 'Sequence'} onSelect={() => selectSection('Sequence')}>
      <div className="gesso-panel gesso-compact-panel">
        <section className="gesso-section" aria-label="Film sequence"><div className="gesso-section-heading gesso-section-toolbar"><span>Shots</span><button type="button" aria-label="Add shot" onClick={() => edit(draft => addShot(draft, shot.id))}>Add</button><button type="button" onClick={() => edit(draft => duplicateShot(draft, shot.id))}>Duplicate</button></div>
          <div className="gesso-shot-list gesso-bounded-shot-list" aria-label="Shots">{scene.shots.map((item: any, position: number) => <button type="button" key={item.id} aria-pressed={shot.id === item.id} onClick={() => onFrame(item.startFrame)}>
            <span>{String(position + 1).padStart(2, '0')} / {item.name || 'Untitled shot'}</span><small>{Number((shotFrames(item) / fps).toFixed(2))} s</small>
          </button>)}</div>
        </section>
        <section className="gesso-section" aria-label="Selected shot">
          <StepField label="Name"><input aria-label="Shot name" value={shot.name ?? ''} maxLength={80} onChange={event => {const name = event.target.value; onChange(next => {next.shots.find((item: any) => item.id === shot.id).name = name;});}}/></StepField>
          <StepNumber label="Duration" value={shotFrames(shot) / fps} unit="s" min={1 / fps} max={3600} step={1 / fps} onChange={value => edit(draft => setShotFrames(draft, shot.id, Math.max(1, Math.round(value * fps))))}/>
          <div className="gesso-button-row"><button type="button" disabled={index === 0} onClick={() => edit(draft => moveShot(draft, shot.id, -1))}>Move earlier</button><button type="button" disabled={index === scene.shots.length - 1} onClick={() => edit(draft => moveShot(draft, shot.id, 1))}>Move later</button></div>
          <details className="gesso-disclosure gesso-compact-details"><summary>Frames {shot.startFrame}–{shot.endFrame} / remove shot</summary><div className="gesso-section">
            <StepNumber label="Length" value={shotFrames(shot)} unit="fr" min={1} max={fps * 3600} onChange={value => edit(draft => setShotFrames(draft, shot.id, value))}/>
            <button type="button" disabled={scene.shots.length === 1} onClick={() => edit(draft => removeShot(draft, shot.id))}>Remove shot</button>
            <p className="gesso-meta">Reordering keeps each shot’s camera and length. Product animation stays at its film time.</p>
          </div></details>
        </section>
      </div>
    </FilmSectionBlock>}

    <FilmSectionBlock name="Output" shortcut={still ? 6 : 8} description={<>{scene.render.width} × {scene.render.height}{!still && ` · ${fps} fps`}</>} active={section === 'Output'} onSelect={() => selectSection('Output')}>
      <section className="gesso-section" aria-label="Film output">
        <StepField label="Format"><select value={chosenSize} onChange={event => {const size = outputSizes[Number(event.target.value)]; if (size) edit(draft => setOutputDimensions(draft, size.width, size.height));}}>
          {chosenSize < 0 && <option value={-1}>Custom / {scene.render.width} × {scene.render.height}</option>}{outputSizes.map((size, position) => <option key={size.label} value={position}>{size.label}</option>)}
        </select></StepField>
        {!still && <StepField label="Rate"><select aria-label="Frame rate" value={fps} onChange={event => edit(draft => setFrameRate(draft, Number(event.target.value)))}>
          {![24, 25, 30, 48, 50, 60].includes(fps) && <option value={fps}>{fps} fps</option>}{[24, 25, 30, 48, 50, 60].map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
        </select></StepField>}
        <StepNumber label="Width" value={scene.render.width} unit="px" min={2} max={8192} step={2} onChange={value => edit(draft => setOutputDimensions(draft, value, draft.render.height))}/>
        <StepNumber label="Height" value={scene.render.height} unit="px" min={2} max={8192} step={2} onChange={value => edit(draft => setOutputDimensions(draft, draft.render.width, value))}/>
        <StepNumber label="Samples" value={scene.render.samples} min={1} max={65536} onChange={value => edit(draft => {if (!Number.isInteger(value)) throw new Error('Samples must be a whole number.'); draft.render.samples = value;})}/>
        <p className="gesso-meta">Cycles export. More samples reduce noise and take longer.{!still && ' Frame rate changes preserve timing to the nearest frame.'}</p>
      </section>
    </FilmSectionBlock>
    </div>

    {onRender && <section className="gesso-section gesso-film-render" aria-label="Render controls"><button type="button" className="gesso-film-render-button" disabled={renderDisabled || (!still && renderReelDisabled) || renderBusy} onClick={() => onRender(still ? 'still' : 'reel')}>{still ? 'Render still' : 'Render video'}</button>
      {scene.comparison && <p className="gesso-meta">Matching A and B renders.</p>}
    </section>}
    {renderJobs && <details className="gesso-disclosure gesso-compact-details gesso-render-jobs" open={renderBusy ? true : undefined}><summary>Renders / progress</summary><div className="gesso-bounded-jobs">{renderJobs}</div></details>}
    {error && <p className="gesso-error" role="alert">{error}</p>}
  </div>;
}
