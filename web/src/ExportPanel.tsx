import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import FilmModeTabs from './FilmModeTabs';
import {exportBlockReason, exportBytes, exportDimensions, exportDownloadUrl, exportFilename, exportFormats, exportProgress, formatsForMode, makeExportPayload, primaryExportArtifact, totalExportFrames, type ExportCapabilities, type ExportFormat, type ExportJob, type ExportMode, type ExportPayload, type ExportScale, type ExportScene} from './exportModel';
import './export.css';

export interface ExportPanelProps {
  scene: ExportScene; projectName: string; frame: number; initialMode: ExportMode;
  capabilities: ExportCapabilities; blockedReason?: string; jobs: ExportJob[]; currentDigest: string;
  onSubmit: (payload: ExportPayload) => Promise<ExportJob>;
  onControl: (id: string, action: 'cancel' | 'resume', paired?: boolean) => Promise<void>;
  onClose: () => void; onAdjustFrame?: (mode: ExportMode) => void;
  previewSource?: unknown;
  onModeChange?: (mode: ExportMode) => void;
  compositionSettings?: ReactNode;
}
function jobTitle(job: ExportJob) {return `${job.filename || 'gesso'}${job.paired ? ' · A/B' : ''}`;}
function jobFormat(job: ExportJob) {return exportFormats[job.format ?? (job.kind === 'still' ? 'png' : 'mp4')].label;}
function JobStatus({job}: {job: ExportJob}) {
  const progress = exportProgress(job), active = ['queued', 'running'].includes(job.state);
  const state = job.state === 'succeeded' ? 'Ready to download' : job.state === 'running' ? job.stage === 'capturing' ? 'Capturing environment' : progress.completed === progress.total && progress.total > 0 ? 'Preparing files' : 'Rendering' : job.state === 'queued' ? 'Queued' : job.state === 'cancelled' ? 'Cancelled' : job.state === 'interrupted' ? 'Interrupted' : 'Render failed';
  const tone = job.state === 'succeeded' ? 'success' : active || job.state === 'cancelled' ? 'note' : 'error';
  return <div className="gesso-export-status"><div className="gesso-export-status-line"><span className="gesso-feedback" data-tone={tone} role="status" aria-live="polite">{state}</span><span>{progress.completed} / {progress.total} {progress.total === 1 ? 'frame' : 'frames'}</span></div>
    <progress aria-label="Rendered frames" max={Math.max(progress.total, 1)} value={progress.completed}/>
    {active && <p className="gesso-note">You can leave Export. Rendering continues locally.</p>}
    {job.error && <p className="gesso-export-error" role="alert">{job.error}</p>}
  </div>;
}

export default function ExportPanel({scene, projectName, frame, initialMode, capabilities, blockedReason, jobs, currentDigest, onSubmit, onControl, onClose, onAdjustFrame, onModeChange, compositionSettings, previewSource}: ExportPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null), mounted = useRef(true), currentMode = useRef(initialMode);
  const sourceRef = useRef(previewSource); sourceRef.current = previewSource;
  const titleId = useId(), formId = useId();
  const [mode, setMode] = useState<ExportMode>(initialMode);
  const [format, setFormat] = useState<ExportFormat>(initialMode === 'still' ? 'png' : 'mp4');
  const [scale, setScale] = useState<ExportScale>(1);
  const [samples, setSamples] = useState([32, 128, 256].includes(scene.render.samples) ? scene.render.samples : 32);
  const [filename, setFilename] = useState(exportFilename(projectName));
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const [selectedJob, setSelectedJob] = useState<ExportJob | null>(null);
  const job = selectedJob ? jobs.find(item => item.id === selectedJob.id && !!item.paired === !!selectedJob.paired) ?? selectedJob : null;
  const paired = !!scene.comparison, formats = formatsForMode(mode, paired), safeFormat = formats.includes(format) ? format : formats[0];
  const choice = exportFormats[safeFormat], reason = exportBlockReason(capabilities, safeFormat, blockedReason);
  const formatLabel = (value: ExportFormat) => value === 'mp4' ? 'MP4' : value === 'prores' ? 'ProRes 422' : value === 'png-sequence' ? 'PNG frames' : exportFormats[value].label;
  let dimensions = {width: scene.render.width, height: scene.render.height}, sizeError = '';
  try {dimensions = exportDimensions(scene, scale);} catch (failure) {sizeError = (failure as Error).message;}
  const total = totalExportFrames(scene), download = job ? primaryExportArtifact(job) : undefined;
  const failed = job && ['failed', 'cancelled', 'interrupted'].includes(job.state);
  const active = job && (job.canCancel ?? ['queued', 'running'].includes(job.state));
  const savedName = exportFilename(filename), otherJobs = jobs.filter(item => !job || item.id !== job.id || !!item.paired !== !!job.paired);
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => {mounted.current = false;};
  }, []);
  useEffect(() => {setSelectedJob(null);setError('');}, [previewSource]);
  const changeMode = (value: ExportMode, notify = true) => {
    if (value === currentMode.current) return;
    currentMode.current = value;
    setMode(value);
    setFormat(previous => formatsForMode(value, paired).includes(previous) ? previous : value === 'still' ? 'png' : 'mp4');
    setSelectedJob(null); setError('');
    if (notify) onModeChange?.(value);
  };
  useEffect(() => {changeMode(initialMode, false);}, [initialMode]);
  const submit = async () => {
    if (pending || reason || sizeError) return;
    const submittedSource = sourceRef.current;
    setError(''); setPending(true);
    try {const result = await onSubmit(makeExportPayload(scene, {mode, format: safeFormat, filename, frame, scale, samples})); if (mounted.current && currentMode.current === mode && submittedSource === sourceRef.current) setSelectedJob(result);}
    catch (failure) {if (mounted.current && currentMode.current === mode && submittedSource === sourceRef.current) setError(failure instanceof Error ? failure.message : 'The export could not start. Try again.');}
    finally {if (mounted.current) setPending(false);}
  };
  const control = async (action: 'cancel' | 'resume') => {
    if (!job || pending) return;
    setPending(true); setError('');
    try {await onControl(job.id, action, job.paired);}
    catch (failure) {if (mounted.current) setError(failure instanceof Error ? failure.message : 'The render could not be updated.');}
    finally {if (mounted.current) setPending(false);}
  };
  return <section className="gesso-export-panel" aria-labelledby={titleId} onKeyDown={event => {if (event.key === 'Escape') {event.stopPropagation(); if (!(event.target as Element)?.closest?.('select:open')) onClose();}}}>
    <FilmModeTabs mode={mode} onMode={changeMode}/>
    <header className="gesso-export-heading"><div><h2 ref={heading} tabIndex={-1} id={titleId}>Export</h2><p>{projectName}</p></div><button type="button" onClick={onClose} aria-label="Close export">×</button></header>
    <div className="gesso-export-body">
      {!job ? <form id={formId} onSubmit={event => {event.preventDefault(); void submit();}} className="gesso-export-form">
        <fieldset className="gesso-export-formats"><legend className="gesso-section-heading"><span className="gesso-section-label">Format</span></legend>{formats.map(value => <label key={value} className={safeFormat === value ? 'is-selected' : ''}><input type="radio" name={`${formId}-format`} value={value} checked={safeFormat === value} onChange={() => {setFormat(value); setError('');}}/><span><strong>{formatLabel(value)}</strong><small className="gesso-export-sr">{exportFormats[value].detail}</small></span></label>)}<p className="gesso-export-format-detail">{choice.detail}{safeFormat === 'mp4' ? ' · H.264' : safeFormat === 'prores' ? ' · MOV' : ''}</p></fieldset>
        {paired && <p className="gesso-export-note">Both environments · matching {mode === 'still' ? 'PNG stills' : 'MP4 videos'}.</p>}
        <div className="gesso-export-composition"><div><span>Current composition</span><strong>{scene.render.width} × {scene.render.height}</strong></div>{onAdjustFrame && <button type="button" onClick={() => onAdjustFrame(mode)}>Adjust framing ↗</button>}</div>
        {compositionSettings && <details className="gesso-disclosure gesso-export-composition-settings"><summary>{mode === 'still' ? 'Composition' : 'Composition + sound'}</summary>{compositionSettings}</details>}
        <div className="gesso-export-two"><label className="gesso-export-field"><span>Resolution</span><select value={scale} onChange={event => setScale(Number(event.target.value) as ExportScale)}>{([.5, 1, 2] as const).map(value => {let invalid = false; try {exportDimensions(scene, value);} catch {invalid = true;} return <option key={value} value={value} disabled={invalid}>{value}×{value === 1 ? ' · original' : ''}</option>;})}</select></label><label className="gesso-export-field"><span>Samples</span><select value={samples} onChange={event => setSamples(Number(event.target.value))}>{[32, 128, 256].map(value => <option key={value} value={value}>{value}{value === 32 ? ' · draft' : ''}</option>)}</select></label></div>
        <div className="gesso-export-spec"><span>{dimensions.width} × {dimensions.height} px</span><span>{mode === 'still' ? `Frame ${frame} of ${total}` : `${Number((total / scene.render.fps).toFixed(2))} s · ${scene.render.fps} fps · ${total} frames`}</span></div>
        <p className="gesso-export-note">Framing stays the same. More samples take longer.</p>
        <label className="gesso-export-filename"><span>Filename</span><div><input value={filename} maxLength={120} onChange={event => setFilename(event.target.value)} onBlur={() => setFilename(savedName)} spellCheck={false}/><span>{choice.extension}</span></div></label>
        {(reason || sizeError) && <p className="gesso-export-error" role="status">{reason || sizeError}</p>}
      </form> : <section className="gesso-export-result" aria-label="Selected export">
        <div className="gesso-export-result-title"><h3>{jobTitle(job)}</h3><span>{jobFormat(job)}</span></div>
        <p className="gesso-export-note">{job.width && job.height ? `${job.width} × ${job.height} px · ` : ''}{job.kind === 'still' ? `Frame ${job.frame ?? frame}` : `${job.fps ?? scene.render.fps} fps`}{job.samples ? ` · ${job.samples} samples` : ''}</p>
        {job.sourceDigest && job.sourceDigest !== currentDigest && <p className="gesso-export-note">Earlier scene revision</p>}
        <JobStatus job={job}/>
        {active && <button type="button" className="gesso-export-text-button" disabled={pending} onClick={() => void control('cancel')}>{pending ? 'Updating…' : job.paired ? 'Cancel both renders' : 'Cancel render'}</button>}
        {failed && <p className="gesso-export-note">Resume keeps completed frames and retries the rest.</p>}
        {job.state === 'succeeded' && <div className="gesso-export-secondary-links">{job.artifacts.filter(artifact => artifact !== download && (artifact.name.endsWith('.blend') || artifact.name === 'contact-sheet.png' || job.paired)).map(artifact => <a key={artifact.name} href={exportDownloadUrl(artifact.url)} download={artifact.downloadName}>{artifact.name.endsWith('.blend') ? `${artifact.name.startsWith('a/') ? 'A · ' : artifact.name.startsWith('b/') ? 'B · ' : ''}Scene file · .blend` : artifact.name === 'contact-sheet.png' ? 'Contact sheet' : artifact.name}<span>↓</span></a>)}</div>}
      </section>}
      {error && <p className="gesso-export-error" role="alert">{error}</p>}
      {otherJobs.length > 0 && <details className="gesso-export-history"><summary>Previous exports <span>{otherJobs.length}</span></summary><div>{otherJobs.map(item => {const file = primaryExportArtifact(item); return <article key={`${item.paired ? 'pair-' : ''}${item.id}`}><button type="button" onClick={() => {setSelectedJob(item); setError('');}}><span>{jobTitle(item)}</span><small>{jobFormat(item)} · {item.state}</small></button>{file && <a href={exportDownloadUrl(file.url)} download={file.downloadName} aria-label={`Download ${file.downloadName || file.name}`}>↓</a>}</article>;})}</div></details>}
    </div>
    <footer className="gesso-export-footer">
      {!job ? <><div className="gesso-export-summary"><small>{paired ? 'A/B · ' : ''}{mode === 'still' ? 'Current frame' : 'Full film'} · local Cycles render</small></div><button className="gesso-export-primary" type="submit" form={formId} disabled={pending || !!reason || !!sizeError}>{pending ? 'Starting…' : mode === 'still' ? 'Render still' : 'Render video'}<span aria-hidden>↗</span></button></> : <>
        {download ? <a className="gesso-export-primary" href={exportDownloadUrl(download.url)} download={download.downloadName}>Download {job.paired ? 'A/B files' : jobFormat(job)}<span>{exportBytes(download.bytes)} ↓</span></a> : failed ? <button className="gesso-export-primary" type="button" disabled={pending} onClick={() => void control('resume')}>{pending ? 'Resuming…' : 'Resume render'}<span aria-hidden>↗</span></button> : <button className="gesso-export-primary" type="button" disabled>{job.state === 'succeeded' ? 'Download unavailable' : job.state === 'queued' ? 'Waiting to render…' : 'Rendering…'}</button>}
        <button type="button" className="gesso-export-text-button" disabled={pending} onClick={() => {setSelectedJob(null); setError('');}}>New export</button>
      </>}
    </footer>
  </section>;
}
