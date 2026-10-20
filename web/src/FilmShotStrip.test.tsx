import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {FilmShotStrip, filmFrameAtPosition, filmFrameForKey, filmPlayheadPosition} from './FilmShotStrip';
import {FilmTimeline} from './FilmTimeline';
import {shotAtFrame} from './sequence';

const shots = [
  {id: 'a', name: 'Wide', startFrame: 1, endFrame: 24, camera: {}},
  {id: 'b', name: 'Detail', startFrame: 25, endFrame: 96, camera: {}},
  {id: 'c', name: 'Flash', startFrame: 97, endFrame: 97, camera: {}},
];

describe('One film timeline', () => {
  it('maps equal frame intervals across unequal shots and exact cuts', () => {
    const scene = {shots}, left = 40, width = 970;
    expect(filmFrameAtPosition(-20, left, width, 97)).toBe(1);
    expect(filmFrameAtPosition(5000, left, width, 97)).toBe(97);
    expect(filmFrameAtPosition(left + 240 - .01, left, width, 97)).toBe(24);
    expect(filmFrameAtPosition(left + 240, left, width, 97)).toBe(25);
    for (let frame = 1; frame <= 97; frame++) {
      const hit = filmFrameAtPosition(left + (frame - .5) * 10, left, width, 97);
      expect(hit).toBe(frame);
      const shot = shotAtFrame(scene, hit), position = filmPlayheadPosition(hit, shot);
      expect(position).toBeGreaterThan(0);
      expect(position).toBeLessThan(1);
    }
    expect(filmPlayheadPosition(97, shots[2])).toBe(.5);
  });

  it('steps through cuts and clamps keyboard seeks at the film ends', () => {
    expect(filmFrameForKey('ArrowRight', 24, 97, 24)).toBe(25);
    expect(filmFrameForKey('ArrowLeft', 25, 97, 24)).toBe(24);
    expect(filmFrameForKey('ArrowRight', 90, 97, 24, true)).toBe(97);
    expect(filmFrameForKey('ArrowLeft', 1, 97, 24)).toBe(1);
    expect(filmFrameForKey('Home', 70, 97, 24)).toBe(1);
    expect(filmFrameForKey('End', 70, 97, 24)).toBe(97);
    expect(filmFrameForKey('PageUp', 70, 97, 24)).toBe(94);
    expect(filmFrameForKey('PageDown', 70, 97, 24)).toBe(46);
    expect(filmFrameForKey('Enter', 70, 97, 24)).toBeUndefined();
  });

  it('renders exactly one line in the active shot using the supplied film frame', () => {
    const scene = {...structuredClone(fixture), shots};
    const before = structuredClone(scene);
    for (const frame of [1, 24, 25, 96, 97]) {
      const html = renderToStaticMarkup(<FilmShotStrip scene={scene} frame={frame} onFrame={() => {}}/>);
      expect(html.match(/class="film-shot-playhead"/g)).toHaveLength(1);
      expect(html.match(/aria-current="true"/g)).toHaveLength(1);
      expect(html).not.toContain('film-gap-box');
      expect(html).not.toContain('Black');
      expect(html).toContain(`min="1" max="97" step="1"`);
      expect(html).toContain(`value="${frame}"`);
      expect(html).toContain(`frame ${frame} of 97`);
    }
    expect(scene).toEqual(before);
    const disabled = renderToStaticMarkup(<FilmShotStrip scene={scene} frame={1} onFrame={() => {}} disabled/>);
    expect(disabled).toContain('disabled=""');
  });

  it('retains shot and motion editing without a second time slider or lane playheads', () => {
    const scene = structuredClone(fixture), noop = () => {};
    const props = {scene, frame: scene.shots[1].startFrame, onFrame: noop, onChange: noop,
      selectedTarget: scene.actions[0].componentId, onTargetChange: noop, selectedMotionId: null, onMotionSelect: noop};
    const html = renderToStaticMarkup(<FilmTimeline {...props}/>);
    expect(html.match(/type="range"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Film playhead"');
    expect(html).not.toContain('Shot time');
    expect(html).not.toContain('class="film-playhead"');
    expect(html).toContain('aria-label="Scene name:');
    expect(html).toContain('aria-label="Scene options:');
    expect(html).not.toContain('film-shot-tools');
    expect(html).toContain('existing animation across cuts');
    const custom = renderToStaticMarkup(<FilmTimeline {...props} detailContent={<div>Custom keyframe controls</div>}/>);
    expect(custom).toContain('aria-label="Film playhead"');
    expect(custom).toContain('Custom keyframe controls');
    expect(custom).toContain('existing animation across cuts');
  });

  it('renders an image thumbnail within its timed shot and keeps the single playhead', () => {
    const scene = {...structuredClone(fixture), shots: [{...shots[0], kind: 'image', name: 'Lamp detail', image: {
      asset: {path: '/assets/lamp detail.png', sha256: 'test', format: 'png', width: 1200, height: 800}, fit: 'contain',
    }}]};
    const html = renderToStaticMarkup(<FilmShotStrip scene={scene} frame={12} onFrame={() => {}} onDuplicate={() => {}}/>);
    expect(html).toContain('class="film-shot-thumbnail"');
    expect(html).toContain('src="/api/assets/lamp%20detail.png"');
    expect(html).toContain('Image · ');
    expect(html).toContain('Scene options: Lamp detail');
    expect(html.match(/class="film-shot-playhead"/g)).toHaveLength(1);
  });

  it('keeps reorder, trim, rename and time-scrub controls distinct',()=>{
    const scene={...structuredClone(fixture),shots},noop=()=>{};
    const html=renderToStaticMarkup(<FilmShotStrip scene={scene} frame={1} onFrame={noop} onReorder={noop} onRename={noop} onDurationChange={noop}/>);
    expect(html.match(/class="film-scene-reorder"/g)).toHaveLength(3);
    expect(html).toContain('data-reorder="true"');
    expect(html).toContain('Reorder scene: Detail');
    expect(html).toContain('ArrowLeft ArrowRight Home End');
    expect(html.match(/class="film-scene-trim"/g)).toHaveLength(3);
    expect(html.match(/type="range"/g)).toHaveLength(1);
    expect(html).toContain('Scrub the time ruler');
    const playing=renderToStaticMarkup(<FilmShotStrip scene={scene} frame={1} onFrame={noop} onReorder={noop} reorderDisabled/>);
    expect(playing).toContain('Click to seek · Pause film to reorder');
    expect(playing).not.toContain('disabled=""');
    const disabled=renderToStaticMarkup(<FilmShotStrip scene={scene} frame={1} onFrame={noop} onReorder={noop} disabled/>);
    expect(disabled.match(/title="Drag to reorder[^>]+disabled=""/g)).toHaveLength(3);
  });
});
