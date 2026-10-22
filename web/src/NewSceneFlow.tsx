import {useEffect, useRef, useState, type KeyboardEvent} from 'react';
import {NumberControl} from './EditorControls';
import {UiIcon} from './UiIcon';
import {defaultFilmTextCard, drawFilmTextCard, filmTextLimit, prepareFilmTextFont, type FilmTextCard} from './filmTextCard';
import './new-scene-flow.css';

export type StaticSceneDraft = {kind: 'image'; file: File; name: string; durationSeconds: number} |
  {kind: 'text'; card: FilmTextCard; name: string; durationSeconds: number};
export type StaticSceneInitial = {name?: string; durationSeconds?: number; card?: FilmTextCard};

function containKeys(event: KeyboardEvent, onCancel: () => void) {
  event.stopPropagation();
  if (event.key === 'Escape' && !event.defaultPrevented && !(event.target as Element).closest('select:open,input[type=color]')) {event.preventDefault(); onCancel();}
}

export function NewSceneChooser({onProduct, onStatic, onCancel, disabled = false}: {onProduct: () => void; onStatic: () => void; onCancel: () => void; disabled?: boolean}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {heading.current?.focus({preventScroll: true});}, []);
  return <section className="gesso-panel film-rail-panel new-scene-flow" aria-label="Choose scene type" onKeyDown={event => containKeys(event, onCancel)}>
    <h2 tabIndex={-1} ref={heading}>New scene</h2>
    <div className="film-rail-scroll new-scene-choices gesso-selection-surface">
      <button type="button" disabled={disabled} onClick={onProduct}>
        <svg viewBox="0 0 40 32" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><path d="m20 3 13 7.5v14L20 32 7 24.5v-14L20 3Zm0 14 13-6.5M20 17 7 10.5M20 17v15"/></svg>
        <span><strong>Product shot</strong><small>Choose objects, movement and camera.</small></span><UiIcon name="chevron"/>
      </button>
      <button type="button" disabled={disabled} onClick={onStatic}>
        <svg viewBox="0 0 40 32" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><rect x="2" y="3" width="36" height="26" rx="1"/><path d="M5 25 13 17l7 6M22 10h11M27.5 10v13M25 23h5"/><circle cx="11" cy="11" r="2"/></svg>
        <span><strong>Static image / text</strong><small>Upload an image or write a title card.</small></span><UiIcon name="chevron"/>
      </button>
    </div>
    <footer className="new-scene-footer"><button type="button" onClick={onCancel}>Cancel</button></footer>
  </section>;
}

export function StaticSceneComposer({width, height, fps, initial, editing = false, disabled = false, onSubmit, onCancel}: {
  width: number; height: number; fps: number; initial?: StaticSceneInitial; editing?: boolean; disabled?: boolean;
  onSubmit: (draft: StaticSceneDraft) => Promise<void>; onCancel: () => void;
}) {
  const [kind, setKind] = useState<'image' | 'text'>(initial?.card ? 'text' : 'image');
  const [durationSeconds, setDuration] = useState(initial?.durationSeconds ?? 3);
  const [card, setCard] = useState<FilmTextCard>(initial?.card ?? {...defaultFilmTextCard});
  const [file, setFile] = useState<File | null>(null), [imageUrl, setImageUrl] = useState('');
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [previewError, setPreviewError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null), canvas = useRef<HTMLCanvasElement>(null), mounted = useRef(true), submitting = useRef(false);
  const blocked = disabled || pending;
  useEffect(() => {mounted.current = true; heading.current?.focus({preventScroll: true}); return () => {mounted.current = false;};}, []);
  useEffect(() => {
    if (!file) {setImageUrl(''); return;}
    const url = URL.createObjectURL(file); setImageUrl(url); return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    let current = true; setPreviewError('');
    if (kind === 'text' && card.text.trim()) void prepareFilmTextFont().then(() => {
      if (current && canvas.current) drawFilmTextCard(canvas.current, card, width, height, true);
    }).catch(reason => {if (current) setPreviewError(reason instanceof Error ? reason.message : 'The text preview is unavailable.');});
    return () => {current = false;};
  }, [kind, card, width, height]);
  const chooseFile = (chosen?: File) => {
    setError(''); if (!chosen) return;
    if (!/\.(png|jpe?g|webp)$/i.test(chosen.name) || chosen.size > 32 * 1024 * 1024) {setFile(null); setError('Choose a PNG, JPEG or WebP image up to 32 MiB.'); return;}
    setFile(chosen);
  };
  const submit = async () => {
    if (submitting.current || blocked || (kind === 'image' ? !file : !card.text.trim() || !!previewError)) return;
    submitting.current = true; setPending(true); setError('');
    try {
      const shared = {name: initial?.name?.trim() || (kind === 'text' ? card.text.trim().split('\n')[0].slice(0, 80) : file?.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Image'), durationSeconds};
      await onSubmit(kind === 'image' ? {...shared, kind, file: file!} : {...shared, kind, card: {...card}});
    } catch (reason) {if (mounted.current) setError(reason instanceof Error ? reason.message : 'This scene could not be added.');}
    finally {submitting.current = false; if (mounted.current) setPending(false);}
  };
  return <section className="gesso-panel film-rail-panel new-scene-flow static-scene-composer" aria-label={editing ? 'Edit static scene' : 'Create static scene'} onKeyDown={event => containKeys(event, onCancel)}>
    <h2 ref={heading} tabIndex={-1}>{editing ? 'Edit scene' : 'Static image / text'}</h2>
    <div className="static-scene-preview" style={{aspectRatio: `${width} / ${height}`, background: kind === 'text' ? card.background : '#000'}}>
      {kind === 'image' ? imageUrl ? <img src={imageUrl} alt="Selected image preview" onError={() => {setFile(null); setError('This image could not be read. Choose another image.');}}/> : <span>Image preview</span>
        : card.text.trim() ? <canvas ref={canvas} aria-label="Text scene preview"/> : <span>Text preview</span>}
    </div>
    <div className="static-scene-tabs" role="group" aria-label="Static scene content">
      <button type="button" aria-pressed={kind === 'image'} disabled={blocked} onClick={() => {setKind('image'); setError('');}}>Image</button>
      <button type="button" aria-pressed={kind === 'text'} disabled={blocked} onClick={() => {setKind('text'); setError('');}}>Text</button>
    </div>
    <div className="film-rail-scroll static-scene-fields">
      {kind === 'image' ? <label className="static-scene-upload"><span>{file ? 'Replace image' : 'Choose image'}</span><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Static scene image" disabled={blocked} onChange={event => {chooseFile(event.target.files?.[0]); event.target.value = '';}}/><small>PNG / JPEG / WebP</small></label>
        : <>
          <label className="static-scene-text"><span>Text</span><textarea aria-label="Scene text" placeholder="Write a title or a short line." value={card.text} maxLength={filmTextLimit} rows={4} disabled={blocked} onChange={event => setCard({...card, text: event.target.value})}/></label>
          <div className="static-scene-colors">
            <label><span>Type</span><input type="color" aria-label="Text color" value={card.color} disabled={blocked} onChange={event => setCard({...card, color: event.target.value})}/></label>
            <label><span>Background</span><input type="color" aria-label="Text background color" value={card.background} disabled={blocked} onChange={event => setCard({...card, background: event.target.value})}/></label>
          </div>
        </>}
      <NumberControl label="Duration" ariaLabel="Static scene duration" value={durationSeconds} min={1 / fps} step={1 / fps} unit="s" disabled={blocked} onChange={setDuration}/>
      {(error || previewError) && <p className="film-error" role="alert">{error || previewError}</p>}
      {pending && <p className="gesso-feedback" data-tone="pending" role="status">Preparing scene…</p>}
    </div>
    <footer className="new-scene-footer">
      <button type="button" onClick={onCancel}><UiIcon name="undo"/>{editing ? 'Cancel' : 'Back'}</button>
      <button type="button" className="new-scene-submit" disabled={blocked || (kind === 'image' ? !file : !card.text.trim() || !!previewError)} onClick={() => void submit()}>{pending ? 'Preparing…' : editing ? 'Save scene' : 'Add scene'}</button>
    </footer>
  </section>;
}
