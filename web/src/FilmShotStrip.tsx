import {useEffect, useRef, type KeyboardEvent, type PointerEvent} from 'react';
import {sequenceEnd, shotAtFrame, shotFrames, type Shot} from './sequence';

/** Each frame owns one equal interval on the film; cuts sit between intervals. */
export function filmFrameAtPosition(x: number, left: number, width: number, total: number): number {
  return Math.max(1, Math.min(total, Math.floor((x - left) / Math.max(1, width) * total) + 1));
}

export function filmPlayheadPosition(frame: number, shot: Shot): number {
  return (Math.max(shot.startFrame, Math.min(shot.endFrame, frame)) - shot.startFrame + .5) / shotFrames(shot);
}

export function filmFrameForKey(key: string, frame: number, total: number, fps: number, shift = false): number | undefined {
  const step = shift ? 10 : 1;
  const next = key === 'Home' ? 1 : key === 'End' ? total :
    key === 'ArrowLeft' || key === 'ArrowDown' ? frame - step :
    key === 'ArrowRight' || key === 'ArrowUp' ? frame + step :
    key === 'PageUp' ? frame + fps : key === 'PageDown' ? frame - fps : undefined;
  return next === undefined ? undefined : Math.max(1, Math.min(total, next));
}

/** The range supplies focus and accessibility; its hit area is the shot row itself. */
export function FilmShotStrip({scene, frame, onFrame, disabled, onPlay}: {
  scene: any; frame: number; onFrame: (frame: number) => void; disabled?: boolean; onPlay?: () => void;
}) {
  const total = sequenceEnd(scene), fps = scene.render.fps, shot = shotAtFrame(scene, frame);
  const viewport = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{pointerId: number; input: HTMLInputElement} | null>(null);
  const cancel = () => {
    const active = drag.current; drag.current = null;
    if (active?.input.hasPointerCapture(active.pointerId)) active.input.releasePointerCapture(active.pointerId);
  };
  useEffect(() => {if (disabled) cancel();}, [disabled]);
  useEffect(() => {window.addEventListener('blur', cancel); return () => {window.removeEventListener('blur', cancel); cancel();};}, []);
  useEffect(() => {
    const scroll = viewport.current, row = surface.current;
    if (!scroll || !row || scroll.scrollWidth <= scroll.clientWidth) return;
    const x = (frame - .5) / total * row.clientWidth, inset = 16;
    if (x < scroll.scrollLeft + inset) scroll.scrollLeft = Math.max(0, x - inset);
    else if (x > scroll.scrollLeft + scroll.clientWidth - inset) scroll.scrollLeft = x - scroll.clientWidth + inset;
  }, [frame, total]);
  const seek = (event: PointerEvent<HTMLInputElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    onFrame(filmFrameAtPosition(event.clientX, bounds.left, bounds.width, total));
  };
  const keyboard = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat) onPlay?.(); return;
    }
    const next = filmFrameForKey(event.key, frame, total, fps, event.shiftKey);
    if (next !== undefined) {event.preventDefault(); event.stopPropagation(); onFrame(next);}
  };
  return <div className="film-shots" ref={viewport}>
    <div className="film-shot-surface" ref={surface} style={{minWidth: `${scene.shots.length * 96}px`}}>
      <div className="film-shot-row" role="list" aria-label="Film shots">
        {scene.shots.map((item: Shot, index: number) => <div className="film-shot-box" role="listitem" key={item.id}
          style={{width: `${shotFrames(item) / total * 100}%`}} aria-current={item.id === shot.id ? 'true' : undefined}
          title={`${String(index + 1).padStart(2, '0')} ${item.name || 'Shot'} · ${Number((shotFrames(item) / fps).toFixed(3))} s`}>
          <span className="film-shot-caption"><span>{String(index + 1).padStart(2, '0')}</span><strong>{item.name || 'Shot'}</strong></span>
          <small>{Number((shotFrames(item) / fps).toFixed(3))} s</small>
          {item.id === shot.id && <span className="film-shot-playhead" aria-hidden="true" style={{left: `clamp(1px, ${filmPlayheadPosition(frame, item) * 100}%, calc(100% - 1px))`}}/>}
        </div>)}
      </div>
      <input className="film-shot-seek" type="range" aria-label="Film playhead" min={1} max={total} step={1} value={frame} disabled={disabled}
        aria-valuetext={`${((frame - 1) / fps).toFixed(2)} seconds · ${shot.name || 'Shot'} · frame ${frame} of ${total}`}
        title="Drag through shots · ← → one frame · Shift ten frames · Space play / pause"
        onChange={event => onFrame(Number(event.target.value))} onKeyDown={keyboard}
        onPointerDown={event => {
          if (disabled || event.button !== 0) return;
          event.preventDefault(); event.currentTarget.focus();
          drag.current = {pointerId: event.pointerId, input: event.currentTarget};
          event.currentTarget.setPointerCapture(event.pointerId); seek(event);
        }}
        onPointerMove={event => {if (drag.current?.pointerId === event.pointerId) seek(event);}}
        onPointerUp={event => {if (drag.current?.pointerId === event.pointerId) {seek(event); cancel();}}}
        onPointerCancel={cancel} onLostPointerCapture={cancel}/>
    </div>
  </div>;
}
