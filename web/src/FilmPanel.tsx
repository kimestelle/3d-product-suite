import {EditorCabinetBody} from './editorMotion';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {addShot, duplicateShot, moveShot, removeShot, sequenceEnd, setFrameRate, setOutputDimensions, setShotFrames, shotAtFrame, shotFrames} from './sequence';
import {NumberControl as StepNumber} from './EditorControls';
import type {CameraEnd} from './camera';
import CameraPanel from './CameraPanel';
import {AUDIO_ACCEPT, AUDIO_LIMITS, attachFilmAudio, importFilmAudio, removeFilmAudio, updateFilmAudio, type FilmAudio} from './filmAudio';

function FilmSectionBlock({name, description, active, shortcut, onSelect, children}: {name: FilmSection; description: ReactNode; active: boolean; shortcut: number; onSelect: () => void; children: ReactNode}) {
  return <section className={`gesso-control-section${active ? ' is-open' : ''}`}>
    <button type="button" className="gesso-section-toggle gesso-section-selector" aria-current={active ? "true" : undefined} aria-controls={`film-section-${name}`} aria-keyshortcuts={`Alt+${shortcut}`} title={`Option / Alt ${shortcut}`} onClick={onSelect}><span className="gesso-section-label">{name}</span><small>{description}</small></button>
    <EditorCabinetBody open={active} id={`film-section-${name}`}>{children}</EditorCabinetBody>
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
  onExport?: (mode: 'still' | 'video') => void;
  exportDisabled?: boolean;
  outputOnly?: boolean;
}

/** Keep all changes made by sequence edits, including frame-rate retiming of authored keys. */
export function commitFilmDraft(scene: any, draft: any) {
  scene.shots = draft.shots;
  scene.render = draft.render;
  if (draft.actions !== undefined) scene.actions = draft.actions;
  if (draft.animation !== undefined) scene.animation = draft.animation;
  if (draft.motions !== undefined) scene.motions = draft.motions;
}

/** Validate a soundtrack edit on a draft first, so a rejected value never enters the shared history. */
export function applyFilmAudioEdit(scene: any, onChange: FilmPanelProps['onChange'], mutate: (draft: any) => void): string {
  try {
    mutate(structuredClone(scene));
    onChange(next => {mutate(next);});
    return '';
  } catch (failure) {return failure instanceof Error ? failure.message : 'The soundtrack could not be updated.';}
}

const outputSizes = [{label: 'Portrait / 1080 × 1920', width: 1080, height: 1920}, {label: 'Landscape / 1920 × 1080', width: 1920, height: 1080}, {label: 'Square / 1080 × 1080', width: 1080, height: 1080}, {label: 'Portrait / 540 × 960', width: 540, height: 960}, {label: 'Landscape / 960 × 540', width: 960, height: 540}];

export default function FilmPanel({scene, layer, onLayerChange, mode = 'video', frame, samples = [], onChange, onFrame, onResetView, cameraEnd, onCameraEndChange, viewportControls, cameraTargetId, onCameraTargetChange, animationContent, onExport, exportDisabled, outputOnly = false}: FilmPanelProps) {
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
  const audio: FilmAudio | undefined = scene.audio;
  const [importingAudio, setImportingAudio] = useState(false);
  const [bpmDraft, setBpmDraft] = useState<string | null>(null);
  const audioFile = useRef<HTMLInputElement>(null);
  useEffect(() => setBpmDraft(null), [audio?.bpm, audio?.asset.sha256]);
  const editAudio = (mutate: (draft: any) => void) => setError(applyFilmAudioEdit(scene, onChange, mutate));
  const commitBpm = () => {
    if (bpmDraft === null) return;
    const text = bpmDraft.trim();
    setBpmDraft(null);
    editAudio(draft => {updateFilmAudio(draft, {bpm: text === '' ? null : Number(text)});});
  };
  const importAudio = async () => {
    const chosen = audioFile.current?.files?.[0];
    if (audioFile.current) audioFile.current.value = '';
    if (!chosen) return;
    setImportingAudio(true);
    try {
      const {asset, durationS} = await importFilmAudio(chosen);
      editAudio(draft => {attachFilmAudio(draft, asset, durationS);});
    } catch (failure) {setError(failure instanceof Error ? failure.message : 'The sound file could not be imported.');}
    finally {setImportingAudio(false);}
  };
  const selectSection = (next: FilmSection) => {setLocalSection(next); onLayerChange?.(next);};

  const outputControls = <>
      <section className="gesso-section" aria-label="Film output">
        <StepField label="Composition"><select value={chosenSize} onChange={event => {const size = outputSizes[Number(event.target.value)]; if (size) edit(draft => setOutputDimensions(draft, size.width, size.height));}}>
          {chosenSize < 0 && <option value={-1}>Custom / {scene.render.width} × {scene.render.height}</option>}{outputSizes.map((size, position) => <option key={size.label} value={position}>{size.label}</option>)}
        </select></StepField>
        {!still && <StepField label="Rate"><select aria-label="Frame rate" value={fps} onChange={event => edit(draft => setFrameRate(draft, Number(event.target.value)))}>
          {![24, 25, 30, 48, 50, 60].includes(fps) && <option value={fps}>{fps} fps</option>}{[24, 25, 30, 48, 50, 60].map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
        </select></StepField>}
        <StepNumber label="Width" value={scene.render.width} unit="px" min={2} max={8192} step={2} onChange={value => edit(draft => setOutputDimensions(draft, value, draft.render.height))}/>
        <StepNumber label="Height" value={scene.render.height} unit="px" min={2} max={8192} step={2} onChange={value => edit(draft => setOutputDimensions(draft, draft.render.width, value))}/>
        <p className="gesso-meta">Export chooses file type, resolution, and render quality.{!still && ' Frame rate changes preserve timing to the nearest frame.'}</p>
      </section>
      {!still && <section className="gesso-section gesso-film-sound" aria-label="Film sound">
        <div className="gesso-section-heading film-section-label"><span>Sound</span><span>{audio ? `${Number(audio.durationS.toFixed(1))} s${audio.bpm ? ` · ${audio.bpm} bpm` : ''}` : 'none'}</span></div>
        <input hidden type="file" ref={audioFile} accept={AUDIO_ACCEPT} aria-label="Film sound file" onChange={() => {void importAudio();}}/>
        {audio ? <>
          <p className="gesso-meta">{audio.asset.format.toUpperCase()} · {Number(audio.durationS.toFixed(2))} s. Plays with the film and is muxed into MP4 and ProRes exports.</p>
          <StepField label="Tempo"><input type="number" aria-label="Sound BPM" placeholder="bpm" inputMode="decimal" min={AUDIO_LIMITS.bpm.min} max={AUDIO_LIMITS.bpm.max} step={1} value={bpmDraft ?? (audio.bpm ?? '')} onChange={event => setBpmDraft(event.target.value)} onBlur={commitBpm} onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); commitBpm();}}}/></StepField>
          <StepNumber label="Offset" value={audio.offsetS} unit="s" min={AUDIO_LIMITS.offsetS.min} max={AUDIO_LIMITS.offsetS.max} step={0.01} onChange={value => editAudio(draft => {updateFilmAudio(draft, {offsetS: value});})}/>
          <StepNumber label="Gain" value={audio.gain} min={AUDIO_LIMITS.gain.min} max={AUDIO_LIMITS.gain.max} step={0.05} onChange={value => editAudio(draft => {updateFilmAudio(draft, {gain: value});})}/>
          <div className="gesso-button-row"><button type="button" disabled={importingAudio} onClick={() => audioFile.current?.click()}>{importingAudio ? 'Importing…' : 'Replace sound'}</button><button type="button" onClick={() => editAudio(draft => {removeFilmAudio(draft);})}>Remove sound</button></div>
          <p className="gesso-meta">Offset is the film time where the sound starts; negative values trim its beginning. Tempo draws bar ticks on the timeline.</p>
        </> : <>
          <button type="button" disabled={importingAudio} onClick={() => audioFile.current?.click()}>{importingAudio ? 'Importing sound…' : 'Add sound…'}</button>
          <p className="gesso-meta">MP3, WAV or M4A up to 64 MB. The soundtrack plays with the film and is muxed into MP4 and ProRes exports.</p>
        </>}
      </section>}
  </>;
  if (outputOnly) return <div className="gesso-panel gesso-compact-panel gesso-film-panel">
    {outputControls}
    {error && <p className="gesso-error" role="alert">{error}</p>}
  </div>;

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
        <section className="gesso-section" aria-label="Film sequence"><div className="gesso-section-heading gesso-section-toolbar"><span className="gesso-section-label">Shots</span><button type="button" aria-label="Add shot" onClick={() => edit(draft => addShot(draft, shot.id))}>Add</button><button type="button" onClick={() => edit(draft => duplicateShot(draft, shot.id))}>Duplicate</button></div>
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
      {outputControls}
    </FilmSectionBlock>
    </div>

    {onExport && <section className="gesso-section gesso-film-render" aria-label="Export controls"><button type="button" className="gesso-film-render-button" aria-haspopup="dialog" disabled={exportDisabled} onClick={() => onExport(mode)}>{still ? 'Export still…' : 'Export video…'}</button>
      {scene.comparison && <p className="gesso-meta">Matching A and B renders.</p>}
    </section>}
    {error && <p className="gesso-error" role="alert">{error}</p>}
  </div>;
}
