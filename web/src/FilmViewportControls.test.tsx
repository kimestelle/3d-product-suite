import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import FilmViewportControls, {type FilmViewportControlsProps} from './FilmViewportControls';
import type {FilmGuideProjection} from './filmGuides';

const guide: FilmGuideProjection = {gate: {x: 340, y: 64, width: 288, height: 512}, viewportWidth: 968, viewportHeight: 640,
  target: {x: 484, y: 320, visible: true}, targetM: [0, .1, 0], distanceM: .7, focalLengthMm: 50, inspecting: false};
const defaults: FilmViewportControlsProps = {guide, scene: fixture, frame: fixture.shots[0].startFrame, mode: 'video', end: 'from', editing: true, disabled: false,
  onTargetPointerDown: vi.fn(), onTargetKeyDown: vi.fn()};
const render = (props: Partial<FilmViewportControlsProps> = {}) => renderToStaticMarkup(<FilmViewportControls {...defaults} {...props}/>);

describe('Film composition guides', () => {
  it('uses the presented gate, four corners and center marks with no settings over the image', () => {
    const html = render();
    expect(html).toContain('left:340px;top:64px;width:288px;height:512px');
    expect(html.match(/class="gesso-film-gate-corner /g)).toHaveLength(4);
    expect(html).toContain('gesso-film-midlines'); expect(html).toContain('gesso-film-crosshair');
    expect(html).toContain('left:484px;top:320px');
    expect(html).toContain('<button type="button" class="gesso-film-target-handle" aria-label="Camera target"');
    expect(html).not.toMatch(/<input|<select|<details|render frame|gesso-film-control-rail|gesso-film-target-label/);
  });
  it.each([{editing:false}, {guide:{...guide,inspecting:true}}, {cameraMotionDriven:true}, {frame:2}])('keeps passive frame and target while interaction is unavailable: %j', props => {
    const html=render(props);
    expect(html).toContain('class="gesso-film-gate"');
    expect(html).toContain('class="gesso-film-focus-marker"');
    expect(html).not.toContain('<button');
  });
  it('keeps the target button mounted through evaluation without accepting edits', () => {
    const html=render({disabled:true});
    expect(html).toContain('<button');expect(html).toContain('aria-disabled="true" tabindex="-1"');
  });
  it('retains the frame but never invents a target for an offscreen point or flat image', () => {
    const offscreen=render({guide:{...guide,target:{x:-4,y:100,visible:false}}});
    const flat=render({guide:{gate:guide.gate,viewportWidth:968,viewportHeight:640}});
    for(const html of [offscreen,flat]){expect(html).toContain('gesso-film-gate');expect(html).not.toContain('class="gesso-film-target"');}
  });
  it('shows the actual optical focus point without exposing a target gesture for manual focus', () => {
    const scene:any=structuredClone(fixture);scene.shots[0].camera.depthOfField={enabled:true,fStop:2.8,focusDistanceM:.4};
    const html=render({scene,guide:{...guide,focus:{x:460,y:300,visible:true}}});
    expect(html).toContain('left:460px;top:300px');expect(html).toContain('aria-label="Focus point"');expect(html).not.toContain('<button');
  });
  it('keeps follow-target focus editable and still mode editable between video endpoints', () => {
    const html=render({mode:'still',frame:2,guide:{...guide,focus:guide.target}});
    expect(html).toContain('<button type="button" class="gesso-film-target-handle" aria-label="Focus point"');
  });
  it('honors trimmed and held camera sources', () => {
    const scene:any=structuredClone(fixture);scene.shots[0].camera.durationFrames=240;
    expect(render({scene,frame:scene.shots[0].endFrame,end:'to'})).not.toContain('<button');
    scene.shots[0].camera.durationFrames=60;
    expect(render({scene,frame:60,end:'to'})).toContain('<button');
    expect(render({scene,frame:scene.shots[0].endFrame,end:'to'})).not.toContain('<button');
    scene.shots[0].camera.durationFrames=1;
    expect(render({scene,frame:1,end:'to'})).not.toContain('<button');
  });
  it('retains keyboard guidance and reports failures only during camera editing', () => {
    expect(render({dragging:true})).toContain('Escape cancels');
    expect(render({error:'Target unavailable.'})).toContain('role="alert">Target unavailable.');
    expect(render({editing:false,error:'Target unavailable.'})).not.toContain('role="alert"');
  });
  it('waits for the renderer to publish a measured gate', () => {
    expect(render({guide:null})).toBe('');expect(render({guide:{...guide,gate:{...guide.gate,height:0}}})).toBe('');
  });
});
