import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import FilmPanel, {applyFilmAudioEdit} from './FilmPanel';
import {attachFilmAudio, filmAudioUrl, removeFilmAudio, updateFilmAudio} from './filmAudio';

const digest = 'a'.repeat(64);
const asset = {path: `assets/${digest}.wav`, sha256: digest, format: 'wav' as const};
function scene(): any {const value: any = structuredClone(fixture); value.actions = []; return value;}
function render(value: any, mode: 'still' | 'video' = 'video') {
  return renderToStaticMarkup(<FilmPanel scene={value} layer="Output" mode={mode} frame={1} onChange={vi.fn()} onFrame={vi.fn()}/>);
}

describe('Sound section', () => {
  it('offers a soundtrack import inside Output and describes an attached file', () => {
    const html = render(scene());
    expect(html).toContain('aria-label="Film sound"');
    expect(html).toContain('<span>Sound</span><span>none</span>');
    expect(html).toContain('Add sound…');
    expect(html).toContain('aria-label="Film sound file"');
    expect(html).toMatch(/accept="[^"]*audio\/mpeg[^"]*audio\/wav[^"]*audio\/mp4[^"]*"[^>]*aria-label="Film sound file"/);
    const withAudio = scene();
    attachFilmAudio(withAudio, asset, 10);
    updateFilmAudio(withAudio, {bpm: 120, offsetS: .5, gain: .8});
    const attached = render(withAudio);
    expect(attached).toContain('<span>Sound</span><span>10 s · 120 bpm</span>');
    expect(attached).toMatch(/aria-label="Sound BPM"[^>]*value="120"/);
    expect(attached).toContain('value="0.5"');
    expect(attached).toContain('value="0.8"');
    expect(attached).toContain('Remove sound');
    expect(attached).not.toContain('Add sound…');
    expect(render(withAudio, 'still')).not.toContain('aria-label="Film sound"');
  });

  it('commits scene.audio through the shared scene edit and refuses values the server would reject', () => {
    const current = scene(), edits: ((next: any) => void)[] = [];
    const onChange = (edit: (next: any) => void) => {edits.push(edit);};
    expect(applyFilmAudioEdit(current, onChange, draft => {attachFilmAudio(draft, asset, 10);})).toBe('');
    const committed = scene();
    edits[0](committed);
    expect(committed.audio).toEqual({asset, offsetS: 0, gain: 1, durationS: 10});
    expect(current.audio).toBeUndefined();
    expect(applyFilmAudioEdit(committed, onChange, draft => {updateFilmAudio(draft, {bpm: 120, offsetS: -1.5, gain: 2});})).toBe('');
    edits[1](committed);
    expect(committed.audio).toEqual({asset, offsetS: -1.5, gain: 2, bpm: 120, durationS: 10});
    expect(applyFilmAudioEdit(committed, onChange, draft => {updateFilmAudio(draft, {gain: 5});})).toBe('Gain must be between 0 and 4.');
    expect(applyFilmAudioEdit(committed, onChange, draft => {updateFilmAudio(draft, {bpm: 20});})).toMatch(/BPM/);
    expect(applyFilmAudioEdit(committed, onChange, draft => {updateFilmAudio(draft, {offsetS: 601});})).toMatch(/Offset/);
    expect(edits).toHaveLength(2);
    expect(committed.audio).toEqual({asset, offsetS: -1.5, gain: 2, bpm: 120, durationS: 10});
    expect(applyFilmAudioEdit(committed, onChange, draft => {updateFilmAudio(draft, {bpm: null});})).toBe('');
    edits[2](committed);
    expect(committed.audio).not.toHaveProperty('bpm');
    const replacement = {...asset, sha256: 'b'.repeat(64), path: `assets/${'b'.repeat(64)}.mp3`, format: 'mp3' as const};
    expect(applyFilmAudioEdit(committed, onChange, draft => {attachFilmAudio(draft, replacement, 42);})).toBe('');
    edits[3](committed);
    expect(committed.audio).toEqual({asset: replacement, offsetS: -1.5, gain: 2, durationS: 42});
    const before = scene();
    expect(applyFilmAudioEdit(committed, onChange, draft => {removeFilmAudio(draft);})).toBe('');
    edits[4](committed);
    expect(committed).toEqual(before);
    expect(filmAudioUrl(asset)).toBe(`/api/assets/${digest}.wav`);
  });
});
