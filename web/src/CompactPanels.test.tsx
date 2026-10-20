import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import CameraPanel from './CameraPanel';
import FilmPanel, {commitFilmDraft} from './FilmPanel';
import {setFrameRate, setSequenceFrames} from './sequence';
import {VectorControl} from './EditorControls';

const noop = () => {};
describe('Combined editor panels', () => {
  it('retains all camera operations on each legacy deep link and names target coordinates accurately', () => {
    for (const layer of ['Lens', 'Focus', 'Path'] as const) {
      const html = renderToStaticMarkup(<CameraPanel scene={fixture} frame={1} layer={layer} onChange={noop} onFrame={noop}/>);
      for (const name of ['Focal length', 'Target', 'Start target X', 'Start position Z', 'Reverse', 'Hold view', 'Copy start to end']) expect(html).toContain(name);
      expect(html).toContain('Depth of field is controlled on the image.');
      expect(html).toContain('aria-label="Aim at start" disabled="">Aim');
      expect(html).toMatch(/disabled=""[^>]*>Both ends/);
    }
  });
  it('uses the viewport endpoint while retaining precise coordinates in the rail', () => {
    const html = renderToStaticMarkup(<FilmPanel scene={fixture} frame={fixture.shots[0].endFrame} cameraEnd="to" viewportControls onChange={noop} onFrame={noop}/>);
    expect(html).toContain('End target X');
    expect(html).toContain('End position Z');
    expect(html).toContain('Copy end to start');
    expect(html).not.toContain('aria-label="Lens controls"');
    expect(html).not.toContain('aria-label="Target"');
    expect(html).not.toContain('aria-label="Camera endpoint"');
  });
  it('requires both evaluated endpoints before offering an aim operation for the whole shot', () => {
    const sample = {frame: fixture.shots[0].startFrame, shotId: fixture.shots[0].id};
    const html = renderToStaticMarkup(<CameraPanel scene={fixture} frame={1} samples={[sample]} onChange={noop} onFrame={noop}/>);
    expect(html).toContain('<button type="button" aria-label="Aim at start">Aim</button>');
    expect(html).toContain('<button type="button" disabled="">Both ends</button>');
  });
  it('keeps composition and shot controls together while opening export for delivery settings', () => {
    const scene = structuredClone(fixture); scene.shots = [scene.shots[0]];
    const html = renderToStaticMarkup(<FilmPanel scene={scene} frame={1} layer="Shots" onChange={noop} onFrame={noop} onExport={noop}/>);
    expect(html).toContain('Duration');
    const output = renderToStaticMarkup(<FilmPanel scene={scene} frame={1} layer="Output" onChange={noop} onFrame={noop}/>);
    for (const name of ['Frame rate', 'Composition', 'Width', 'Height']) expect(output).toContain(name);
    expect(html).toContain('<button type="button" disabled="">Remove shot</button>');
    expect(html).not.toContain('Render still');
    expect(html).toContain('>Export video…</button>');
  });
  it('keeps one shot selector in Film and one visible section open', () => {
    const html = renderToStaticMarkup(<FilmPanel scene={fixture} frame={1} onChange={noop} onFrame={noop}/>);
    expect(html.match(/aria-label="Film shot"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Camera shot"');
    expect(html.match(/class="gesso-section-body"/g)).toHaveLength(1);
    expect(html).toContain('Camera options');
    expect(html).toContain('aria-current="true" aria-controls="film-section-Framing"');
    expect(html).toContain('aria-controls="film-section-Animation"');
    expect(html).toContain('aria-controls="film-section-Sequence"');
    expect(html).toContain('aria-controls="film-section-Output"');
  });
  it('keeps Film section selectors arrow-free while preserving shortcuts and real disclosures', () => {
    for (const layer of ['Framing', 'Animation', 'Sequence', 'Output'] as const) {
      const html = renderToStaticMarkup(<FilmPanel scene={fixture} layer={layer} frame={1} onChange={noop} onFrame={noop}/>);
      const selectors = html.match(/<button[^>]*class="gesso-section-toggle gesso-section-selector"[\s\S]*?<\/button>/g) ?? [];
      expect(selectors).toHaveLength(4);
      expect(selectors.filter(button => button.includes('aria-current="true"'))).toHaveLength(1);
      expect(selectors.find(button => button.includes('aria-current="true"'))).toContain(`aria-controls="film-section-${layer}"`);
      for (const [index, selector] of selectors.entries()) {
        expect(selector).not.toContain('aria-expanded');
        expect(selector).not.toContain('gesso-ui-icon');
        expect(selector).toContain(`aria-keyshortcuts="Alt+${index + 5}"`);
      }
    }
    const framing = renderToStaticMarkup(<FilmPanel scene={fixture} frame={1} onChange={noop} onFrame={noop}/>);
    expect(framing).toContain('<details class="gesso-disclosure gesso-compact-details gesso-camera-options"><summary>Camera options');
  });
  it('offers an actual frame in Still and hides video-only controls without changing the scene', () => {
    const scene = structuredClone(fixture), before = JSON.stringify(scene);
    scene.shots[0].camera.from.focalLengthMm = 35;
    scene.shots[0].camera.to.focalLengthMm = 85;
    const edited = JSON.stringify(scene);
    const html = renderToStaticMarkup(<FilmPanel scene={scene} mode="still" layer="Sequence" frame={scene.shots[0].startFrame} onChange={noop} onFrame={noop} onExport={noop}/>);
    expect(html).toContain('aria-label="Frame"');
    expect(html).toContain('aria-current="true" aria-controls="film-section-Framing"');
    expect(html).toContain('Frame position X');
    expect(html).toContain('Edits shift the whole shot. Video motion is preserved.');
    expect(html).toContain('>Export still…</button>');
    for (const name of ['Camera endpoint', 'Reverse', 'Hold view', 'Film sequence', 'Frame rate', 'Render video', 'aria-controls="film-section-Animation"']) expect(html).not.toContain(name);
    expect(JSON.stringify(scene)).toBe(edited);
    expect(before).not.toBe(edited);
  });
  it('opens the shared animation workspace in Video and falls back to Framing in Still', () => {
    const content = <div aria-label="Animation workspace">Part movement</div>;
    const video = renderToStaticMarkup(<FilmPanel scene={fixture} mode="video" layer="Animation" frame={1} onChange={noop} onFrame={noop} animationContent={content}/>);
    expect(video).toContain('aria-current="true" aria-controls="film-section-Animation"');
    expect(video).toContain('aria-label="Animation workspace"');
    const still = renderToStaticMarkup(<FilmPanel scene={fixture} mode="still" layer="Animation" frame={1} onChange={noop} onFrame={noop} animationContent={content}/>);
    expect(still).toContain('aria-current="true" aria-controls="film-section-Framing"');
    expect(still).not.toContain('aria-label="Animation workspace"');
  });
  it('commits retimed animation keys along with a frame-rate change', () => {
    const scene: any = structuredClone(fixture);
    scene.actions = [];
    const oldFps = scene.render.fps;
    scene.animation = {tracks: [{id: 'travel', componentId: scene.product.components[0].id, property: 'position', enabled: true, keys: [{frame: 1, value: [0, 0, 0], interpolation: 'linear'}, {frame: oldFps + 1, value: [0, 1, 0], interpolation: 'ease'}]}]};
    const draft = structuredClone(scene);
    setFrameRate(draft, oldFps * 2);
    commitFilmDraft(scene, draft);
    expect(scene.render.fps).toBe(oldFps * 2);
    expect(scene.animation.tracks[0].keys.map((key: any) => key.frame)).toEqual([1, oldFps * 2 + 1]);
    expect(scene.shots.at(-1).endFrame).toBe(fixture.shots.at(-1)!.endFrame * 2);
  });
  it('commits mechanical action timing with a full movie duration edit', () => {
    const scene: any = structuredClone(fixture), draft = structuredClone(scene);
    const originalDuration = scene.actions[0].durationSeconds;
    setSequenceFrames(draft, 720); commitFilmDraft(scene, draft);
    expect(scene.actions[0].durationSeconds).toBeCloseTo(originalDuration * 719 / 359);
    expect(scene.render.durationFrames).toBe(720);
    expect(scene.shots.at(-1).endFrame).toBe(720);
  });
  it('keeps vector units, axis names and exact signed values available to assistive technology', () => {
    const html = renderToStaticMarkup(<VectorControl label="Position" values={[-.0125, 0, .45]} factor={1000} step={.1} unit="mm" onChange={noop}/>);
    for (const axis of ['X', 'Y', 'Z']) expect(html).toContain(`aria-label="Position ${axis}"`);
    expect(html.match(/aria-describedby=/g)).toHaveLength(3);
    expect(html).toContain('value="-12.5"'); expect(html).toContain('value="450"');
    expect(html.match(/type="number"/g)).toHaveLength(3);
    expect(html).toContain('step="0.1"');
  });
});
