import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {FilmInspector, FilmObjects, FilmTimeline, filmTargetName, motionBounds, motionMeasure, type FilmWorkspaceProps} from './FilmWorkspace';
import {addMotion, changeMotionScope, listMotions} from './filmMotion';

const noop = () => {};
function context(): FilmWorkspaceProps {
  return {scene: structuredClone(fixture), frame: 1, selectedTarget: '$camera', selectedMotionId: null,
    onFrame: noop, onChange: noop, onTargetChange: noop, onMotionSelect: noop, onPlay: noop, onEditCurves: noop, onLegacyAnimation: noop};
}

describe('Film workspace ownership and editing context', () => {
  it('keeps camera, whole product and all parts selectable before any action is added', () => {
    const props = context(), html = renderToStaticMarkup(<FilmObjects {...props}/>);
    expect(html).toContain('Shot objects');
    expect(html).toContain('Whole product');
    expect(html).toContain('Camera');
    expect(html).toContain('Orbit');
    expect(html).toContain('Push in');
    expect(html.match(/class="film-object-name"/g)).toHaveLength(props.scene.product.components.length + 2);
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
    const before = structuredClone(props.scene), html = renderToStaticMarkup(<FilmObjects {...props}/>);
    expect(html).toContain('Existing animation');
    expect(html).toContain('Across cuts');
    expect(html).toContain('Edit existing keys');
    expect(props.scene).toEqual(before);
  });

  it('keeps custom channels reachable for an object without existing animation', () => {
    const props = context(); props.selectedTarget = '$product';
    const html = renderToStaticMarkup(<FilmObjects {...props}/>);
    expect(html).toContain('Custom keyframes');
    expect(html).toContain('Direct transform keys use the film clock.');
  });

  it('shows action scope and units in the inspector, with exact start and duration controls', () => {
    const props = context(); props.selectedTarget = '$product';
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, '$product', 'move');
    const html = renderToStaticMarkup(<FilmInspector {...props}/>);
    for (const label of ['Motion amount', 'Motion axis', 'Motion start', 'Motion duration', 'Motion easing', 'Motion scope']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('>mm<');
    expect(html).toContain('This shot');
    expect(html).toContain('Across cuts');
    expect(html).toContain('Edit curve');
    expect(html).toContain('Remove motion');
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

  it('keeps the shot timeline visible while the selected motion opens its progress curve', () => {
    const props = context(); props.editCurves = true;
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, '$camera', 'orbit');
    const html = renderToStaticMarkup(<FilmTimeline {...props}/>);
    for (const label of ['Film shots', 'Motion progress curve', 'Progress key frame', 'Progress key value']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('aria-label="Shot motions"');
    expect(html).toContain('Trim end');
    expect(html).toContain('Stretch shot');
    expect(html).toContain('aria-label="Shot name"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('Add key at playhead');
    const blocks = renderToStaticMarkup(<FilmTimeline {...props} editCurves={false}/>);
    expect(blocks).toContain('Arrow keys move one frame; Shift moves ten.');
    expect(blocks).toContain('Across cuts');
    expect(blocks).toContain('Outside this shot');
    const secondShot = renderToStaticMarkup(<FilmTimeline {...props} frame={props.scene.shots[1].startFrame} editCurves={false}/>);
    expect(secondShot).toContain('existing animation across cuts');
  });

  it('explains when a direct action takes ownership from an existing mechanism', () => {
    const props = context(); props.selectedTarget = props.scene.actions[0].componentId;
    props.selectedMotionId = addMotion(props.scene, props.scene.shots[0].id, props.selectedTarget, 'move');
    const html = renderToStaticMarkup(<FilmInspector {...props}/>);
    expect(html).toContain('its existing mechanism is held at rest');
    expect(html).toContain('in this shot');
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
