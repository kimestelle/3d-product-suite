import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import FilmViewportControls, {filmAspectLabel, type FilmViewportControlsProps} from './FilmViewportControls';
import type {FilmGuideProjection} from './filmGuides';

const guide: FilmGuideProjection = {gate: {x: 340, y: 64, width: 288, height: 512}, viewportWidth: 968, viewportHeight: 640,
  target: {x: 484, y: 320, visible: true}, targetM: [0, .1, 0], distanceM: .7, focalLengthMm: 50, inspecting: false};
const defaults: FilmViewportControlsProps = {guide, scene: fixture, frame: fixture.shots[0].startFrame, mode: 'video', end: 'from', editing: true, disabled: false,
  onEndChange: vi.fn(), onAspectChange: vi.fn(), onFocalLengthChange: vi.fn(), onDepthOfFieldChange: vi.fn(), onAim: vi.fn(), onTargetPointerDown: vi.fn(), onTargetKeyDown: vi.fn()};
const render = (props: Partial<FilmViewportControlsProps> = {}) => renderToStaticMarkup(<FilmViewportControls {...defaults} {...props}/>);

describe('Film viewport controls', () => {
  it('uses measured gate and projected target coordinates instead of fixed screen percentages', () => {
    const html = render();
    expect(html).toContain('left:340px;top:64px;width:288px;height:512px');
    expect(html).toContain('left:484px;top:320px');
    expect(html).toContain('aria-label="Camera target"');
    expect(html).toContain('700 mm');
  });
  it('exposes exact output size, aspect choices and native disclosures', () => {
    const html = render();
    expect(html).toContain('<details');
    expect(html).toContain('aria-label="Render frame dimensions"');
    for (const label of ['9:16', '16:9', '1:1', '4:5']) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('aria-label="Viewport frame width"');
    expect(html).toContain(`value="${fixture.render.width}"`);
    expect(html).toContain('aria-label="Viewport frame height"');
    expect(html).toContain('Thirds guide');
    expect(html).not.toContain('focus radius');
  });
  it('does not draw a target at a made-up screen position while it is offscreen', () => {
    const html = render({guide: {...guide, target: {x: -4, y: 100, visible: false}}});
    expect(html).not.toContain('aria-label="Camera target"');
    expect(html).toContain('target outside view');
    expect(html).toContain('aria-label="Viewport camera target"');
  });
  it('points to the existing inspection action without duplicating its controls', () => {
    const html = render({guide: {...guide, inspecting: true}});
    expect(html).toContain('Return to shot to edit');
    expect(html).not.toContain('>Return to shot</button>');
    expect(html).not.toContain('gesso-film-inspection');
    expect(html).not.toContain('class="gesso-film-gate"');
    expect(html).not.toContain('render frame');
    expect(html).toMatch(/aria-label="Viewport focal length"[^>]*disabled=""/);
  });
  it('prevents edits at interpolated frames while endpoints stay available', () => {
    const html = render({frame: fixture.shots[0].startFrame + 1});
    expect(html).toContain('Choose Start or End to edit');
    expect(html).toMatch(/aria-label="Camera target"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Viewport focal length"[^>]*disabled=""/);
    expect(html).toContain('<button type="button" aria-pressed="false">Start');
    expect(html).toContain('<button type="button" aria-pressed="false">End');
  });
  it('hides endpoints in still mode and keeps framing editable at the current frame', () => {
    const html = render({mode: 'still', frame: fixture.shots[0].startFrame + 1});
    expect(html).not.toContain('Viewport camera endpoint');
    expect(html).not.toContain('Choose Start or End');
    expect(html).not.toMatch(/aria-label="Viewport focal length"[^>]*disabled=""/);
  });
  it('preserves the gate outside Framing without exposing a target edit handle', () => {
    const html = render({editing: false});
    expect(html).toContain('class="gesso-film-gate"');
    expect(html).not.toContain('aria-label="Camera target"');
    expect(html).not.toContain('class="gesso-film-control-rail"');
  });
  it('disables scene changes during a render and describes cancellation during a drag', () => {
    const html = render({disabled: true});
    expect(html).toContain('<button type="button" aria-pressed="true" disabled="">Start');
    expect(html).toMatch(/aria-label="Viewport frame width"[^>]*disabled=""/);
    expect(render({dragging: true})).toContain('Release to aim · Esc cancel');
    expect(render({error: 'Target is unavailable.'})).toContain('<span role="alert">Target is unavailable.</span>');
  });
  it('shows optical aperture and focus distance, with no screen-space blur radius', () => {
    const scene: any = structuredClone(fixture);
    scene.shots[0].camera.depthOfField = {enabled: true, fStop: 2.8, focusDistanceM: null};
    const auto = render({scene});
    expect(auto).toContain('700 mm · f/2.8');
    expect(auto).toContain('class="gesso-film-focus" open=""');
    expect(auto).toContain('aria-label="Viewport aperture"');
    expect(auto).toContain('aria-label="Viewport focus distance"');
    expect(auto).toMatch(/aria-label="Follow camera target" checked=""/);
    expect(auto).not.toContain('Guide radius');
    expect(auto).toContain('>f-stop</label>');
    expect(auto).not.toContain('>f/</span>');
    scene.shots[0].camera.depthOfField.focusDistanceM = .386;
    const manual = render({scene});
    expect(manual).toContain('386 mm · f/2.8');
    expect(manual).not.toMatch(/aria-label="Follow camera target" checked=""/);
  });
  it('keeps depth of field off by default and preserves its values when disabled', () => {
    const html = render();
    expect(html).toContain('>Off</span>');
    expect(html).toMatch(/aria-label="Viewport aperture"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Viewport focus distance"[^>]*disabled=""/);
    expect(html).not.toMatch(/aria-label="Viewport depth of field"[^>]*disabled=""/);
  });
  it('shows the controlled target shared with the sidebar', () => {
    const html = render({targetId: 'cap', onTargetChange: vi.fn()});
    expect(html).toContain('<option value="cap" selected="">Cap</option>');
  });
  it('waits for a measured frame instead of guessing guide positions', () => {
    expect(render({guide: null})).toBe('');
    expect(render({guide: {...guide, gate: {...guide.gate, height: 0}}})).toBe('');
  });
});

describe('Film aspect readout', () => {
  it('reduces real output dimensions and retains uncommon ratios', () => {
    expect(filmAspectLabel(1080, 1920)).toBe('9:16');
    expect(filmAspectLabel(1920, 1080)).toBe('16:9');
    expect(filmAspectLabel(1080, 1350)).toBe('4:5');
    expect(filmAspectLabel(2000, 800)).toBe('5:2');
    expect(filmAspectLabel(0, 1080)).toBe('—');
  });
});
