import {assetUrl, isStaticDemo} from './runtime';
/** The scene soundtrack record and the edits the Sound section commits through the shared scene history. */
export type FilmAudioFormat = 'mp3' | 'wav' | 'm4a';
export interface FilmAudioAsset {path: string; sha256: string; format: FilmAudioFormat}
export interface FilmAudio {asset: FilmAudioAsset; offsetS: number; gain: number; bpm?: number; durationS: number}
export type FilmAudioPatch = {offsetS?: number; gain?: number; bpm?: number | null};

export const AUDIO_ACCEPT = 'audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,.mp3,.wav,.m4a';
export const AUDIO_LIMITS = {offsetS: {min: -600, max: 600}, gain: {min: 0, max: 4}, bpm: {min: 30, max: 300}} as const;

/** The immutable asset route the server streams with an audio content type. */
export const filmAudioUrl = (asset: FilmAudioAsset) => assetUrl(asset.path);

function bounded(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return value;
}

/** Attach an imported file, keeping any offset, gain and tempo already chosen for the previous one. */
export function attachFilmAudio(scene: any, asset: FilmAudioAsset, durationS: number): FilmAudio {
  const previous: FilmAudio | undefined = scene.audio;
  const next: FilmAudio = {asset, offsetS: previous?.offsetS ?? 0, gain: previous?.gain ?? 1, durationS: bounded(durationS, 'Duration', Number.MIN_VALUE, 86400)};
  if (previous?.bpm !== undefined) next.bpm = previous.bpm;
  scene.audio = next;
  return next;
}

/** Validate before writing: the same ranges the server enforces, so a rejected value never reaches the history. */
export function updateFilmAudio(scene: any, patch: FilmAudioPatch): FilmAudio {
  const audio: FilmAudio | undefined = scene.audio;
  if (!audio) throw new Error('Add a soundtrack first.');
  if (patch.offsetS !== undefined) audio.offsetS = bounded(patch.offsetS, 'Offset', AUDIO_LIMITS.offsetS.min, AUDIO_LIMITS.offsetS.max);
  if (patch.gain !== undefined) audio.gain = bounded(patch.gain, 'Gain', AUDIO_LIMITS.gain.min, AUDIO_LIMITS.gain.max);
  if (patch.bpm === null) delete audio.bpm;
  else if (patch.bpm !== undefined) audio.bpm = bounded(patch.bpm, 'BPM', AUDIO_LIMITS.bpm.min, AUDIO_LIMITS.bpm.max);
  return audio;
}

export function removeFilmAudio(scene: any) {
  delete scene.audio;
}

/** Upload the file unchanged; the server hashes it and measures its duration with ffprobe. */
export async function importFilmAudio(file: File): Promise<{asset: FilmAudioAsset; durationS: number}> {
  if(isStaticDemo)throw new Error('Importing sound requires the local server.');
  const result = await fetch('/api/audio/import', {method: 'POST', body: file,
    headers: {'X-Product-Suite': '1', 'Content-Type': 'application/octet-stream', 'X-Asset-Filename': file.name}});
  const value = await result.json();
  if (!result.ok) throw new Error(value.error || 'The sound file could not be imported.');
  return value;
}
