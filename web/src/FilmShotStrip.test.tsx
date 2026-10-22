import React, {type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {FilmShotStrip, filmFrameAtPosition, filmFrameForKey, filmPlayheadPosition, type FilmShotStripProps} from './FilmShotStrip';
import {FilmTimeline} from './FilmTimeline';
import {shotAtFrame} from './sequence';

// SSR checks use React normally. The handler checks retain the real component's
// refs between renders, without requiring a second browser/DOM test environment.
const hooks = vi.hoisted(() => ({enabled: false, cursor: 0, values: [] as any[]}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {...actual,
    useRef(initial: unknown) {
      if (!hooks.enabled) return actual.useRef(initial);
      return hooks.values[hooks.cursor++] ??= {current: initial};
    },
    useState(initial: unknown) {
      if (!hooks.enabled) return actual.useState(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.values[index], (value: any) => {hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;}];
    },
    useEffect(effect: () => void, dependencies: unknown[]) {if (!hooks.enabled) actual.useEffect(effect, dependencies);},
  };
});
afterEach(() => {hooks.enabled = false; hooks.cursor = 0; hooks.values = [];});

function nodes(tree: ReactNode): ReactElement<any>[] {
  return React.Children.toArray(tree).flatMap(node => React.isValidElement<any>(node) ? [node, ...nodes((node as ReactElement<any>).props.children)] : []);
}
function scrubber(frame = 24, overrides: Partial<FilmShotStripProps> = {}) {
  hooks.enabled = true; hooks.cursor = 0; hooks.values = [];
  const onFrame = vi.fn(), onPlay = vi.fn();
  const props = {scene: {...structuredClone(fixture), shots}, frame, onFrame, onPlay, onReorder: vi.fn(), ...overrides};
  const tree = FilmShotStrip(props), elements = nodes(tree);
  const surface = elements.find(node => node.props.className === 'film-shot-surface')!;
  // The invisible range extends beyond the ruler for edge grabs. Mapping still
  // uses the actual scene width, including the center of every frame interval.
  surface.props.ref.current = {getBoundingClientRect: () => ({left: 40, width: 970})};
  const input = elements.find(node => node.props.className === 'film-shot-seek')!;
  const captured = new Set<number>();
  const target = {
    focus: vi.fn(), getBoundingClientRect: () => ({left: 28, width: 994}),
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  };
  const pointer = (x: number, extra = {}) => ({currentTarget: target, clientX: x, pointerId: 1, button: 0, isPrimary: true,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra});
  const key = (value: string, extra = {}) => ({key: value, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra});
  return {input: input.props, target, pointer, key, onFrame, onPlay, tree};
}

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
      expect(html.match(/class="film-shot-playhead-handle"/g)).toHaveLength(1);
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

  it('grabs the handle off-center without jumping and drags across an exact scene cut', () => {
    const {input, target, pointer, onFrame} = scrubber();
    // Frame 24 is centered at x=275; the 24px target includes x=284.
    input.onPointerDown(pointer(284));
    expect(target.focus).toHaveBeenCalledWith({preventScroll: true});
    expect(target.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onFrame).not.toHaveBeenCalled();
    input.onPointerMove(pointer(284));
    expect(onFrame).not.toHaveBeenCalled();
    input.onPointerMove(pointer(294));
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(25);
    input.onPointerUp(pointer(294));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
    input.onPointerMove(pointer(500));
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('reaches both edge frames when the handle is grabbed on either side', () => {
    for (const offset of [-12, 12]) {
      const {input, pointer, onFrame} = scrubber();
      input.onPointerDown(pointer(275 + offset));
      expect(onFrame).not.toHaveBeenCalled();
      input.onPointerMove(pointer(40 + offset));
      expect(onFrame).toHaveBeenLastCalledWith(1);
      input.onPointerMove(pointer(1010 + offset));
      expect(onFrame).toHaveBeenLastCalledWith(97);
      input.onPointerUp(pointer(1010 + offset));
      expect(onFrame).toHaveBeenCalledTimes(2);
    }
  });

  it('seeks from the ruler against scene bounds and preserves native range changes', () => {
    const {input, pointer, onFrame} = scrubber(1);
    input.onPointerDown(pointer(280));
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(25);
    input.onPointerUp(pointer(280));
    input.onChange({target: {value: '97'}});
    expect(onFrame).toHaveBeenLastCalledWith(97);
  });

  it('restores a cancelled drag and retains keyboard time control on the single range', () => {
    const {input, target, pointer, key, onFrame, onPlay} = scrubber();
    input.onPointerDown(pointer(275));
    input.onPointerMove(pointer(475));
    expect(onFrame).toHaveBeenLastCalledWith(44);
    input.onKeyDown(key('Escape'));
    expect(onFrame).toHaveBeenLastCalledWith(24);
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
    input.onKeyDown(key('ArrowRight'));
    expect(onFrame).toHaveBeenLastCalledWith(25);
    input.onKeyDown(key('Home'));
    expect(onFrame).toHaveBeenLastCalledWith(1);
    input.onKeyDown(key('End'));
    expect(onFrame).toHaveBeenLastCalledWith(97);
    input.onKeyDown(key(' ')); input.onKeyDown(key(' ', {repeat: true}));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('ignores disabled or secondary pointers and releases interrupted grabs', () => {
    const inactive = scrubber(24, {disabled: true});
    inactive.input.onPointerDown(inactive.pointer(400));
    inactive.input.onKeyDown(inactive.key('End'));
    expect(inactive.onFrame).not.toHaveBeenCalled();
    expect(inactive.target.setPointerCapture).not.toHaveBeenCalled();
    const {input, pointer, target, onFrame} = scrubber();
    input.onPointerDown(pointer(400, {isPrimary: false}));
    expect(target.setPointerCapture).not.toHaveBeenCalled();
    input.onPointerDown(pointer(275)); input.onPointerMove(pointer(295));
    expect(onFrame).toHaveBeenLastCalledWith(26);
    input.onPointerCancel();
    expect(onFrame).toHaveBeenLastCalledWith(24);
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
    input.onPointerMove(pointer(900));
    expect(onFrame).toHaveBeenCalledTimes(2);
  });
});
