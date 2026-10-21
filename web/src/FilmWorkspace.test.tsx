import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {FilmInspector, FilmObjects, FilmShotHeader, FilmTimeline, filmTargetName, motionBounds, motionMeasure, type FilmWorkspaceProps} from './FilmWorkspace';
import {addMotion, changeMotionScope, listMotions} from './filmMotion';

const noop = () => {};
function context(): FilmWorkspaceProps {
  return {scene: structuredClone(fixture), frame: 1, selectedTarget: '$camera', selectedMotionId: null,
    onFrame: noop, onChange: noop, onTargetChange: noop, onMotionSelect: noop, onPlay: noop, onEditCurves: noop, onLegacyAnimation: noop};
}

describe('Film workspace ownership and editing context', () => {
  it('lists enabled rig lights after the parts and offers light motions for a light target', () => {
    const props = context(), html = renderToStaticMarkup(<FilmObjects {...props}/>);
    expect(html).toContain('film-lights-disclosure'); expect(html).toContain('>Lights</span>');
    for (const name of ['>Key<', '>Fill<', '>Rim<']) expect(html.replace(/<span class="film-light-mark" aria-hidden="true"><\/span>/g, '>')).toContain(name);
    expect(html.indexOf('>Lights</span>')).toBeGreaterThan(html.indexOf('>Parts</span>'));
    expect(filmTargetName(props.scene, '$light:key')).toBe('Key');
    expect(filmTargetName(props.scene, '$light:missing')).toBe('missing');
    props.selectedTarget = '$light:key';
    const inspector = renderToStaticMarkup(<FilmInspector {...props}/>);
    for (const label of ['Orbit', 'Move', 'Aim']) expect(inspector).toContain(label);
    expect(inspector).not.toContain('Custom keyframes'); expect(inspector).not.toContain('Rotate');
    props.mode = 'still';
    expect(renderToStaticMarkup(<FilmObjects {...props}/>)).not.toContain('film-lights-disclosure');
  });
  it('keeps camera, whole product and all parts selectable before any action is added', () => {
    const props = context(), html = renderToStaticMarkup(<FilmObjects {...props}/>);
    expect(html).toContain('Shot objects');
    expect(html).toContain('Whole product');
    expect(html).toContain('Camera');
    expect(html).toContain('film-parts-disclosure');
    expect(html).toContain('>Parts</span>');
    expect(html).not.toContain('Orbit');
    expect(html).not.toContain('Push in');
    expect(html).not.toContain('Add motion');
    expect(html).not.toContain('film-object-motions');
    const inspector = renderToStaticMarkup(<FilmInspector {...props}/>);
    expect(inspector).toContain('Orbit');
    expect(inspector).toContain('Push in');
    // Camera, whole product, every part, and the three lights of the implicit legacy rig.
    expect(html.match(/class="film-object-name"/g)).toHaveLength(props.scene.product.components.length + 2 + 3);
    expect(html).not.toContain('Custom keyframes');
  });

  it('uses saved part names across objects, motion details and the timeline without changing target IDs', () => {
    const props = context(); props.selectedTarget = 'cap';
    props.scene.editorPartNames = {cap: 'Orange cap'};
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, 'cap', 'move');
    const before = structuredClone(props.scene);
    expect(filmTargetName(props.scene, 'cap')).toBe('Orange cap');
    for (const html of [renderToStaticMarkup(<FilmObjects {...props}/>), renderToStaticMarkup(<FilmInspector {...props}/>), renderToStaticMarkup(<FilmTimeline {...props}/>)]) {
      expect(html).toContain('Orange cap');
    }
    expect(listMotions(props.scene, props.scene.shots[0].id).find(entry => entry.motion.id === props.selectedMotionId)?.motion.target).toBe('cap');
    expect(props.scene).toEqual(before);
  });

  it('retains existing film-wide animation and makes its scope explicit', () => {
    const props = context(); props.selectedTarget = props.scene.actions[0].componentId;
    const before = structuredClone(props.scene), html = renderToStaticMarkup(<FilmInspector {...props}/>);
    expect(html).toContain('Existing animation');
    expect(html).toContain('Across cuts');
    expect(html).toContain('Edit existing keys');
    expect(props.scene).toEqual(before);
  });

  it('keeps custom channels reachable for an object without existing animation', () => {
    const props = context(); props.selectedTarget = '$product';
    const html = renderToStaticMarkup(<FilmInspector {...props}/>);
    expect(html).toContain('Custom keyframes');
    expect(html).toContain('Direct transform keys use the film clock.');
  });

  it('shows action scope and units in the inspector, with exact start and duration controls', () => {
    const props = context(); props.selectedTarget = '$product';
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, '$product', 'move');
    const html = renderToStaticMarkup(<FilmInspector {...props}/>);
    for (const label of ['Motion amount', 'Motion axis', 'Motion start', 'Motion duration', 'Motion easing', 'Motion scope']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('>mm<');
    expect(html).toContain('This scene');
    expect(html).toContain('Across cuts');
    expect(html).toContain('Edit curve');
    expect(html).toContain('Remove motion');
    const details = html.split('film-motion-details')[1];
    expect(details).toContain('Motion start');
    expect(details).toContain('Motion duration');
    expect(details).toContain('Motion scope');
    expect(details).toContain('Edit curve');
    expect(details).not.toContain('Motion amount');
    expect(html.indexOf('Motion amount')).toBeLessThan(html.indexOf('film-pose-disclosure'));
    expect(html).not.toContain('film-pose-disclosure\" open');
  });

  it('shows existing static framing in Still without exposing animation controls or losing authored motions', () => {
    const props = context(); props.mode = 'still';
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, '$camera', 'orbit');
    const before = structuredClone(props.scene);
    const objects = renderToStaticMarkup(<FilmObjects {...props}/>);
    const inspector = renderToStaticMarkup(<FilmInspector {...props}><div>Camera coordinates</div></FilmInspector>);
    expect(objects).not.toContain('Add motion');
    expect(objects).not.toContain('Across cuts');
    expect(inspector).toContain('Camera coordinates');
    expect(inspector).not.toContain('Motion duration');
    expect(props.scene).toEqual(before);
  });

  it('explains when a direct action takes ownership from an existing mechanism', () => {
    const props = context(); props.selectedTarget = props.scene.actions[0].componentId;
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, props.selectedTarget, 'move');
    const html = renderToStaticMarkup(<FilmInspector {...props}/>);
    expect(html).toContain('its existing mechanism is held at rest');
    expect(html).toContain('in this shot');
  });

  it('keeps the editing scene in both rails when playback crosses a cut', () => {
    const props = context(), editing = props.scene.shots[0], playing = props.scene.shots[1];
    props.selectedMotionId = addMotion(props.scene, editing.id, '$camera', 'orbit');
    props.frame = playing.startFrame;
    props.editingFrame = editing.startFrame;
    const header = renderToStaticMarkup(<FilmShotHeader {...props}/>);
    const objects = renderToStaticMarkup(<FilmObjects {...props}/>);
    const inspector = renderToStaticMarkup(<FilmInspector {...props}/>);
    expect(header).toContain(`Scene 01: ${editing.name}`);
    expect(objects).toContain('1 motion');
    expect(inspector).toContain('aria-label="Motion amount"');
    expect(inspector).toContain('aria-label="Camera motions"');
    expect(renderToStaticMarkup(<FilmInspector {...props} editingFrame={playing.startFrame}/>)).not.toContain('aria-label="Motion amount"');
  });

  it('keeps pose controls mounted under a native disclosure while motion settings are selected', () => {
    const props = context();
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, '$camera', 'orbit');
    const html = renderToStaticMarkup(<FilmInspector {...props}><div>Camera coordinates</div></FilmInspector>);
    expect(html).toContain('Camera coordinates');
    expect(html).toContain('film-pose-disclosure');
    expect(html).not.toContain('film-pose-disclosure" open');
    expect(html.indexOf('Motion amount')).toBeLessThan(html.indexOf('Camera coordinates'));
    expect(renderToStaticMarkup(<FilmInspector {...props} selectedMotionId={null}/>)).toContain('film-pose-disclosure" open');
  });

  it('distinguishes film absolute time from shot-relative time when displaying blocks', () => {
    const props = context(), shot = props.scene.shots[1];
    const id = addMotion(props.scene, shot.id, '$camera', 'orbit');
    const local = listMotions(props.scene, shot.id).find(entry => entry.motion.id === id)!;
    expect(motionBounds(local, shot).start).toBe(shot.startFrame);
    changeMotionScope(props.scene, shot.id, id, 'film');
    const shared = listMotions(props.scene, shot.id).find(entry => entry.motion.id === id)!;
    expect(motionBounds(shared, shot).start).toBe(shot.startFrame);
    expect(motionMeasure({...shared.motion, kind: 'dolly'}).factor).toBe(1000);
    expect(motionMeasure({...shared.motion, kind: 'scale'}).factor).toBe(100);
  });
});
