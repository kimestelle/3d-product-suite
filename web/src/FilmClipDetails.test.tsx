import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {FilmClipDetails} from './FilmClipDetails';
import {FilmShotHeader} from './FilmWorkspace';

const noop = () => {};
const base = {selectedTarget: '$camera', selectedMotionId: null, onTargetChange: noop, onMotionSelect: noop, onChange: noop, onFrame: noop, onImportImage: noop, importingImage: false};
describe('image and empty film selections', () => {
  it('renders no inspector for an invalid selection while a legacy sequence is being normalized', () => {
    const scene = structuredClone(fixture); scene.shots[0].startFrame = 25;
    for (const side of ['objects', 'inspector'] as const) {
      expect(renderToStaticMarkup(<FilmClipDetails {...base} scene={scene} frame={1} side={side}/>)).toBe('');
    }
  });
  it('shows image dimensions and only image timing and fit controls', () => {
    const scene: any = structuredClone(fixture);
    scene.shots[0].kind = 'image'; scene.shots[0].image = {asset: {path: `assets/${'a'.repeat(64)}.png`, width: 1600, height: 900}, fit: 'contain'};
    const left = renderToStaticMarkup(<FilmClipDetails {...base} scene={scene} frame={1} side="objects"/>);
    const right = renderToStaticMarkup(<FilmClipDetails {...base} scene={scene} frame={1} side="inspector"/>);
    expect(left).toContain('1600'); expect(left).toContain(`/api/assets/${'a'.repeat(64)}.png`);
    expect(right).toContain('Image fit'); expect(right).toContain('Image duration in seconds'); expect(right).not.toContain('Add motion');
    expect(right).not.toContain('Image start in seconds');
    expect(renderToStaticMarkup(<FilmShotHeader scene={scene} frame={1}/>)).toContain('Image');
  });
});
