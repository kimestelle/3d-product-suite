import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {FilmTimeline, type FilmTimelineProps} from './FilmTimeline';
import {FilmShotStrip} from './FilmShotStrip';
import {addMotion, changeMotionScope, updateMotion} from './filmMotion';
import {sequenceEnd, setSequenceFrames, setShotFrames, stretchShotFrames} from './sequence';
import {motionStartAfterDrag, motionStartMaximum, sceneFramesAfterTrim, timelineMotionBounds, timelineMotions} from './filmTimelineModel';

const noop = () => {};
function context(): FilmTimelineProps {
  const scene = structuredClone(fixture) as any;
  scene.actions = []; scene.animation = {tracks: []};
  scene.shots = scene.shots.slice(0, 2);
  scene.shots[0].startFrame = 1; scene.shots[0].endFrame = 24;
  scene.shots[1].startFrame = 25; scene.shots[1].endFrame = 96;
  return {scene, frame: 1, editingFrame: 1, selectedTarget: '$product', selectedMotionId: null,
    onFrame: noop, onChange: noop, onTargetChange: noop, onMotionSelect: noop, onPlay: noop, onEditCurves: noop, onLegacyAnimation: noop};
}

describe('Whole-film timeline coordinates', () => {
  it('puts local motions at their owner offsets and shared motion on the same absolute clock', () => {
    const {scene} = context(), owner = scene.shots[1];
    const localId = addMotion(scene, owner.id, '$product', 'move');
    updateMotion(scene, owner.id, localId, {startFrame: 13, durationFrames: 24});
    const sharedId = addMotion(scene, scene.shots[0].id, '$product', 'rotate');
    updateMotion(scene, scene.shots[0].id, sharedId, {startFrame: 13, durationFrames: 48});
    changeMotionScope(scene, scene.shots[0].id, sharedId, 'film');
    const entries = timelineMotions(scene, '$product');
    const local = timelineMotionBounds(scene, entries.find(entry => entry.motion.id === localId)!);
    expect(local).toMatchObject({start: 37, end: 60, left: 37.5, width: 25, clipped: false});
    const shared = timelineMotionBounds(scene, entries.find(entry => entry.motion.id === sharedId)!);
    expect(shared).toMatchObject({start: 13, end: 60, left: 12.5, width: 50, clipped: false});
  });

  it('uses film duration for drag pixels while preserving the local scene bounds', () => {
    const {scene} = context(), owner = scene.shots[1];
    const id = addMotion(scene, owner.id, '$product', 'move');
    updateMotion(scene, owner.id, id, {startFrame: 1, durationFrames: 12});
    const entry = timelineMotions(scene, '$product')[0], max = motionStartMaximum(scene, entry);
    expect(max).toBe(61);
    expect(motionStartAfterDrag(1, 120, 960, sequenceEnd(scene), max)).toBe(13);
    expect(motionStartAfterDrag(1, 960, 960, sequenceEnd(scene), max)).toBe(61);
    expect(motionStartAfterDrag(13, -960, 960, sequenceEnd(scene), max)).toBe(1);
    changeMotionScope(scene, owner.id, id, 'film');
    expect(motionStartMaximum(scene, timelineMotions(scene, '$product')[0])).toBe(85);
  });

  it('clips local actions at their own cut without compressing across-cuts motion', () => {
    const {scene} = context();
    const id = addMotion(scene, scene.shots[0].id, '$product', 'move');
    updateMotion(scene, scene.shots[0].id, id, {startFrame: 13, durationFrames: 48});
    expect(timelineMotionBounds(scene, timelineMotions(scene, '$product')[0])).toMatchObject({start: 13, end: 24, left: 12.5, width: 12.5, clipped: true});
    changeMotionScope(scene, scene.shots[0].id, id, 'film');
    expect(timelineMotionBounds(scene, timelineMotions(scene, '$product')[0])).toMatchObject({start: 13, end: 60, width: 50, clipped: false});
  });

  it('only renders selected target motions and legacy animation, including actions in other scenes', () => {
    const props = context(), first = props.scene.shots[0], second = props.scene.shots[1];
    const firstId = addMotion(props.scene, first.id, '$product', 'move');
    const secondId = addMotion(props.scene, second.id, '$product', 'rotate');
    const cameraId = addMotion(props.scene, second.id, '$camera', 'orbit');
    props.scene.animation.tracks = [{componentId: 'cap', property: 'rotation', keys: [{frame: 1}, {frame: 96}]}];
    const html = renderToStaticMarkup(<FilmTimeline {...props}/>);
    expect(html).toContain(`data-motion-id="${firstId}"`);
    expect(html).toContain(`data-motion-id="${secondId}"`);
    expect(html).not.toContain(`data-motion-id="${cameraId}"`);
    expect(html).not.toContain('existing animation across cuts');
    const cap = renderToStaticMarkup(<FilmTimeline {...props} selectedTarget="cap"/>);
    expect(cap).toContain('existing animation across cuts');
    expect(cap).not.toContain('data-motion-id=');
  });
});

describe('Scene editing and persistent curve context', () => {
  it('keeps recovery actions available for an empty legacy movie', () => {
    const props = context(); props.scene.shots = []; props.scene.render.durationFrames = 240;
    const html = renderToStaticMarkup(<FilmTimeline {...props} onImportImage={noop}/>);
    expect(html).toContain('aria-label="Movie duration in seconds"');
    expect(html).toContain('value="10"');
    expect(html).toContain('New scene'); expect(html).toContain('Add image');
    expect(html).not.toContain('aria-label="Motion progress curve"');
  });

  it('exposes movie duration in seconds and a disabled import action while an image loads', () => {
    const props = context(); props.scene.render.durationFrames = 240;
    const html = renderToStaticMarkup(<FilmTimeline {...props} onImportImage={noop}/>);
    expect(html).toContain('aria-label="Movie duration in seconds"');
    expect(html).toContain(`value="${240 / props.scene.render.fps}"`);
    expect(html).toContain('New scene'); expect(html).toContain('Add image');
    const pending = renderToStaticMarkup(<FilmTimeline {...props} onImportImage={noop} importingImage/>);
    expect(pending).toContain('disabled="">Importing image…</button>');
  });

  it('keeps the edited scene and curve while playback enters another scene', () => {
    const props = context(), first = props.scene.shots[0];
    props.selectedMotionId = addMotion(props.scene, first.id, '$product', 'move');
    const html = renderToStaticMarkup(<FilmTimeline {...props} frame={48} editCurves/>);
    for (const name of ['Film scenes', 'Motion progress curve', 'Progress key frame', 'Progress key value']) expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain('Add key at playhead');
    expect(html).toContain('Arrow keys move one frame; Shift moves ten.');
    expect(html.match(/class="film-shot-playhead"/g)).toHaveLength(1);
    expect(html.match(/type="range"/g)).toHaveLength(1);
    expect(html).not.toContain('class="film-playhead"');
    expect(html).not.toContain('film-shot-tools');
    expect(html).toContain('New scene');
  });

  it('renders editing ownership separately from the playback tile and supports inline scene controls', () => {
    const props = context();
    const html = renderToStaticMarkup(<FilmShotStrip scene={props.scene} frame={48} editingFrame={1} onFrame={noop} onRename={noop} onDurationChange={noop} onDuplicate={noop}/>);
    expect(html.match(/is-editing/g)).toHaveLength(1);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('Scene name:'); expect(html).toContain('Scene options:'); expect(html).toContain('Trim scene end:');
    expect(html).toContain('maxLength="80"');
  });

  it('previews trim frame deltas without changing data, and trim keeps authored motion timing', () => {
    const {scene} = context(), owner = scene.shots[1];
    const id = addMotion(scene, owner.id, '$product', 'move');
    updateMotion(scene, owner.id, id, {startFrame: 13, durationFrames: 24});
    const before = structuredClone(scene), frames = sceneFramesAfterTrim(72, -120, 960, 96);
    expect(frames).toBe(60); expect(scene).toEqual(before);
    expect(sceneFramesAfterTrim(72, -5000, 960, 96)).toBe(1);
    setShotFrames(scene, owner.id, frames);
    expect(scene.shots[1].endFrame).toBe(84);
    expect(scene.shots[1].motions[0]).toEqual(before.shots[1].motions[0]);
    const stretch = structuredClone(before); stretchShotFrames(stretch, owner.id, frames);
    expect(stretch.shots[1].motions[0].durationFrames).not.toBe(24);
  });

  it('rejects a trim that cuts a key, while movie duration retimes it', () => {
    const {scene} = context();
    scene.animation.tracks = [{componentId: '$product', property: 'position', keys: [{frame: 96}]}];
    const before = structuredClone(scene);
    expect(() => setShotFrames(scene, scene.shots[1].id, 48)).toThrow('last key at frame 96');
    expect(scene).toEqual(before);
    setSequenceFrames(scene, 72);
    expect(sequenceEnd(scene)).toBe(72); expect(scene.animation.tracks[0].keys[0].frame).toBe(72);
    expect(scene.shots.map((shot: any) => [shot.startFrame, shot.endFrame])).toEqual([[1, 18], [19, 72]]);
  });

  it('does not show a previous scene curve while the edited frame is black or an image', () => {
    const props = context(), first = props.scene.shots[0];
    props.selectedMotionId = addMotion(props.scene, first.id, '$product', 'move');
    props.scene.render.durationFrames = 120;
    const gap = renderToStaticMarkup(<FilmTimeline {...props} editingFrame={110} editCurves/>);
    expect(gap).not.toContain('aria-label="Motion progress curve"');
    first.kind = 'image'; first.image = {asset: {path: 'lamp.png'}, fit: 'contain'};
    const image = renderToStaticMarkup(<FilmTimeline {...props} editCurves/>);
    expect(image).not.toContain('aria-label="Motion progress curve"');
  });
});

describe('Soundtrack tempo on the ruler', () => {
  it('draws bar and beat ticks from the tempo, anchored at the soundtrack offset', () => {
    const props = context();
    props.scene.audio = {asset: {path: `assets/${'a'.repeat(64)}.wav`, sha256: 'a'.repeat(64), format: 'wav'}, offsetS: 0, gain: 1, bpm: 120, durationS: 10};
    const html = renderToStaticMarkup(<FilmTimeline {...props}/>);
    expect(html.match(/class="film-bar-tick"/g)).toHaveLength(3);
    expect(html.match(/class="film-beat-tick"/g)).toHaveLength(9);
    expect(html).toContain('class="film-bar-tick" style="left:50%"');
    props.scene.audio.offsetS = 0.5;
    expect(renderToStaticMarkup(<FilmTimeline {...props}/>).match(/class="film-bar-tick"/g)).toHaveLength(2);
    delete props.scene.audio.bpm;
    expect(renderToStaticMarkup(<FilmTimeline {...props}/>)).not.toContain('film-beat-grid');
    expect(renderToStaticMarkup(<FilmTimeline {...context()}/>)).not.toContain('film-beat-grid');
  });
});
