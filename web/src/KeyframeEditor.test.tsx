import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import KeyframeEditor, {boundedMotionReason} from './KeyframeEditor';
import {addMotion, changeMotionScope, updateMotion} from './filmMotion';
import {upsertKey} from './keyframes';

const noop=()=>{};
describe('Legacy keyframe ownership',()=>{
  it('guards the requested target and channel independently of which part is selected or pinned',()=>{
    const scene:any=structuredClone(fixture),shot=scene.shots[0];
    const id=addMotion(scene,shot.id,'cap','move');
    expect(boundedMotionReason(scene,shot.startFrame,'cap','position.y')).toBe('Pause Move to edit these keys.');
    expect(boundedMotionReason(scene,shot.startFrame,'cap','position.x')).toBeNull();
    expect(boundedMotionReason(scene,shot.startFrame,'cap','scale')).toBeNull();
    expect(boundedMotionReason(scene,shot.startFrame,'$product','position.y')).toBeNull();
    expect(boundedMotionReason(scene,scene.shots[1].startFrame,'cap','position.y')).toBeNull();
    updateMotion(scene,shot.id,id,{enabled:false});
    expect(boundedMotionReason(scene,shot.startFrame,'cap','position.y')).toBeNull();
  });

  it('uses the effective shot owner instead of a conflicting shared mechanism',()=>{
    const scene:any=structuredClone(fixture),shot=scene.shots[0];
    const shared=addMotion(scene,shot.id,'cap','mechanical');
    changeMotionScope(scene,shot.id,shared,'film');
    addMotion(scene,shot.id,'cap','move');
    expect(boundedMotionReason(scene,shot.startFrame,'cap','position.y')).toBe('Pause Move to edit these keys.');
    expect(boundedMotionReason(scene,shot.startFrame,'cap','position.x')).toBeNull();
    expect(boundedMotionReason(scene,shot.startFrame,'cap','motion')).toBe('Pause Move to edit these keys.');
    expect(boundedMotionReason(scene,scene.shots[1].startFrame,'cap','position.x')).toBe('Pause Mechanism to edit these keys.');
  });

  it('disables conflicting row mutations while retaining keys, property selection and navigation',()=>{
    const scene:any=structuredClone(fixture),shot=scene.shots[0];
    upsertKey(scene,'cap','position.y',1,0);upsertKey(scene,'cap','position.y',30,.04);
    addMotion(scene,shot.id,'cap','move');
    const before=structuredClone(scene);
    const html=renderToStaticMarkup(<KeyframeEditor scene={scene} componentId="cap" frame={1} onFrame={noop} onChange={noop} playing={false} onPlay={noop}/>);
    expect(html).toMatch(/<input[^>]*aria-label="Cap Position Y"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-label="Disable Cap Position Y animation"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-label="Add or update Cap Position Y key at frame 1"[^>]*disabled=""/);
    expect(html).not.toMatch(/<input[^>]*aria-label="Cap Position X"[^>]*disabled=""/);
    expect(html).toContain('Pause Move to edit these keys.');
    expect(html).not.toMatch(/<button[^>]*aria-label="Cap Position Y, frame 1,[^>]*disabled=""/);
    expect(html).not.toMatch(/<input[^>]*aria-label="Animation playhead"[^>]*disabled=""/);
    expect(scene).toEqual(before);
  });

  it('defers playback display to the film shot strip when embedded while retaining key editing',()=>{
    const scene:any=structuredClone(fixture);
    upsertKey(scene,'cap','position.y',1,0);upsertKey(scene,'cap','position.y',30,.04);
    const before=structuredClone(scene);
    const props={scene,componentId:'cap',frame:1,onFrame:noop,onChange:noop,playing:false,onPlay:noop};
    const embedded=renderToStaticMarkup(<KeyframeEditor {...props} embedded/>);
    for(const duplicate of ['aria-label="Play animation"','class="kf-time"','aria-label="Animation playhead"','class="kf-ruler-needle"','class="kf-playhead"']) expect(embedded).not.toContain(duplicate);
    for(const control of ['aria-label="Animation scope"','aria-label="Cap Position Y"','aria-label="Add or update Cap Position Y key at frame 1"','aria-label="Previous keyframe"','aria-label="Next keyframe"']) expect(embedded).toContain(control);
    expect(embedded).toContain('aria-label="Cap Position Y, frame 30,');
    expect(embedded).toContain('Show the selected property&#x27;s value curve');
    const standalone=renderToStaticMarkup(<KeyframeEditor {...props}/>);
    for(const transport of ['aria-label="Play animation"','class="kf-time"','aria-label="Animation playhead"','class="kf-ruler-needle"','class="kf-playhead"']) expect(standalone).toContain(transport);
    expect(scene).toEqual(before);
  });

});
