import {useEffect, useMemo, useRef} from 'react';
import {filmAudioUrl, type FilmAudio} from './filmAudio';

/** The soundtrack as a playback clock: the film follows the audio element while it is audibly running. */
export interface FilmAudioClock {
  /** Start the soundtrack at a film time in seconds. */
  play(filmTimeS: number): void;
  pause(): void;
  /** Keep a paused soundtrack under the scrubbed film time. */
  seek(filmTimeS: number): void;
  /** Called every animation frame with the film clock; returns the soundtrack's film time while it drives playback, else null. */
  sync(filmTimeS: number): number | null;
}

const HAVE_FUTURE_DATA = 3;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** One HTMLAudioElement per attached asset; offset places the file on the film clock, gain scales it (capped at unity). */
export function useFilmAudio(scene: any, {playing, frame, fps}: {playing: boolean; frame: number; fps: number}): FilmAudioClock {
  const audio: FilmAudio | undefined = scene?.audio;
  const source = audio ? filmAudioUrl(audio.asset) : null;
  const offsetS = audio?.offsetS ?? 0, gain = audio?.gain ?? 1;
  const element = useRef<HTMLAudioElement | null>(null);
  const settings = useRef({offsetS, gain});
  settings.current = {offsetS, gain};
  const running = useRef(false);

  useEffect(() => {
    if (!source || typeof Audio === 'undefined') return;
    const created = new Audio(source);
    created.preload = 'auto';
    created.volume = clamp(settings.current.gain, 0, 1);
    element.current = created;
    return () => {created.pause(); created.removeAttribute('src'); created.load(); element.current = null;};
  }, [source]);
  useEffect(() => {if (element.current) element.current.volume = clamp(gain, 0, 1);}, [gain, source]);

  const clock = useMemo<FilmAudioClock>(() => {
    const within = (target: HTMLAudioElement, at: number) => at >= 0 && (!Number.isFinite(target.duration) || at < target.duration);
    const start = (target: HTMLAudioElement, at: number) => {target.currentTime = at; void target.play().catch(() => {});};
    return {
      play(filmTimeS) {
        running.current = true;
        const target = element.current; if (!target) return;
        const at = filmTimeS - settings.current.offsetS;
        if (within(target, at)) start(target, at); else target.pause();
      },
      pause() {
        running.current = false;
        element.current?.pause();
      },
      seek(filmTimeS) {
        const target = element.current; if (!target || running.current) return;
        const at = filmTimeS - settings.current.offsetS;
        if (within(target, at) && Math.abs(target.currentTime - at) > 1e-3) target.currentTime = at;
      },
      sync(filmTimeS) {
        const target = element.current; if (!target || !running.current) return null;
        const {offsetS: offset} = settings.current, at = filmTimeS - offset;
        if (!within(target, at)) {if (!target.paused) target.pause(); return null;}
        if (target.paused) {start(target, at); return null;}
        if (target.readyState < HAVE_FUTURE_DATA) {if (Math.abs(target.currentTime - at) > .25) target.currentTime = at; return null;}
        return target.currentTime + offset;
      },
    };
  }, []);

  useEffect(() => {if (!playing) clock.seek((frame - 1) / fps);}, [clock, playing, frame, fps, source, offsetS]);
  return clock;
}
