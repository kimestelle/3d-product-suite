import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {FilmMotionChoice, FilmMotionPreview} from './FilmMotionPreview';
import {motionDiagramDescription, motionDiagramPose, motionDiagramSpec} from './filmMotionDiagram';
import {mountFilmMotionPreview} from './filmMotionPreviewPlayback';

class Surface extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(name: string, callback: EventListenerOrEventListenerObject | null) {super.addEventListener(name, callback); if(callback) {if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name)!.add(callback);}}
  removeEventListener(name: string, callback: EventListenerOrEventListenerObject | null) {super.removeEventListener(name,callback);if(callback)this.listeners.get(name)?.delete(callback);}
  count() {return [...this.listeners.values()].reduce((sum, callbacks) => sum+callbacks.size,0);}
}
function playback() {
  const doc = Object.assign(new Surface(), {hidden: false}), media = Object.assign(new Surface(), {matches: false}), connection = Object.assign(new Surface(), {saveData: false});
  const animations: {play: ReturnType<typeof vi.fn>;pause:ReturnType<typeof vi.fn>;cancel:ReturnType<typeof vi.fn>}[] = [];
  const paths = Object.fromEntries(['subject','actor','beam'].map(key => [key,{animate: vi.fn(() => {const result={play:vi.fn(),pause:vi.fn(),cancel:vi.fn()};animations.push(result);return result;})}]));
  const root = Object.assign(new Surface(), {ownerDocument: doc, dataset: {} as Record<string,string>, focused: false,
    matches: () => root.focused, contains: (element: unknown) => element === root,
    querySelector: (selector: string) => selector === ':focus-visible' ? null : paths[selector.match(/"(.+)"/)![1]]});
  let intersects: (entries: {isIntersecting: boolean}[]) => void;
  const disconnect=vi.fn();
  vi.stubGlobal('window', {matchMedia: () => media}); vi.stubGlobal('navigator', {connection});
  vi.stubGlobal('IntersectionObserver', class {constructor(callback: typeof intersects){intersects=callback;}observe(){}disconnect=disconnect;});
  const event = (name: string, extras: object = {}) => root.dispatchEvent(Object.assign(new Event(name), extras));
  const mount = () => mountFilmMotionPreview(root as unknown as HTMLElement, motionDiagramSpec(fixture,'$camera','orbit'));
  return {root,doc,media,connection,animations,paths,mount,event,disconnect,visible:(value:boolean)=>intersects([{isIntersecting:value}])};
}
afterEach(()=>vi.unstubAllGlobals());

describe('Film action diagrams',()=>{
  it('preserves a fixed target for orbit/dolly and a fixed light for aim',()=>{
    for(const target of ['$camera','$light:key']) {
      const spec=motionDiagramSpec(fixture,target,'orbit'),a=motionDiagramPose(spec,0),b=motionDiagramPose(spec,1);
      expect(a.subject).toBe(b.subject);expect(a.actor).not.toBe(b.actor);expect(a.beam).not.toBe(b.beam);
    }
    const spec=motionDiagramSpec(fixture,'$light:key','aim'),a=motionDiagramPose(spec,0),b=motionDiagramPose(spec,1);
    expect(a.actor).toBe(b.actor);expect(a.subject).toBe(b.subject);expect(a.beam).not.toBe(b.beam);
    const dolly=motionDiagramSpec(fixture,'$camera','dolly');
    expect(motionDiagramPose(dolly,0).subject).toBe(motionDiagramPose(dolly,1).subject);
    expect(motionDiagramDescription(dolly)).toContain('without changing focal length');
  });
  it('maps the selected axis and native screw mechanism without mutating the scene',()=>{
    const scene=structuredClone(fixture);scene.actions.find(action=>action.componentId==='cap')!.type='screw';const before=structuredClone(scene);
    const motion={id:'m',target:'cap',kind:'rotate' as const,axis:'z' as const,amount:-30,startFrame:1,durationFrames:60,easing:'ease' as const,enabled:true};
    const spec=motionDiagramSpec(scene,'cap','rotate',motion);
    expect(spec).toMatchObject({axis:'z',direction:-1});expect(motionDiagramDescription(spec)).toContain('Z axis');
    expect(motionDiagramSpec(scene,'cap','scale',{...motion,kind:'scale',amount:.8}).direction).toBe(-1);
    expect(motionDiagramPose({...spec,axis:'x'},.5).subject).not.toBe(motionDiagramPose(spec,.5).subject);
    const mechanical=motionDiagramSpec(scene,'cap','mechanical');
    expect(mechanical.mechanism).toBe('screw');
    expect(motionDiagramPose(mechanical,0).subject).toBe(motionDiagramPose(mechanical,1).subject);
    expect(motionDiagramPose(mechanical,0).actor).not.toBe(motionDiagramPose(mechanical,1).actor);
    expect(scene).toEqual(before);
  });
  it('keeps finite paths and constant topology throughout every action',()=>{
    for(const kind of ['pose','move','rotate','scale','mechanical','orbit','dolly','aim'] as const)for(const actor of ['$product','$camera','$light:key']){
      const spec=motionDiagramSpec(fixture,actor,kind),start=motionDiagramPose(spec,0);
      for(const t of [0,.25,.5,.75,1])for(const key of ['subject','actor','beam'] as const){
        const value=motionDiagramPose(spec,t)[key];
        expect(value).not.toMatch(/NaN|Infinity/);
        expect(value.replace(/[-.\d ]/g,'')).toBe(start[key].replace(/[-.\d ]/g,''));
      }
    }
  });
  it('renders honest static diagrams and native choice buttons with disabled/selected states',()=>{
    const spec=motionDiagramSpec(fixture,'$camera','orbit');
    const top=renderToStaticMarkup(<FilmMotionPreview spec={spec} label="Orbit"/>);
    expect(top).toContain('Diagram, not a scene render');expect(top).toContain('tabindex="0"');expect(top).not.toContain('<canvas');
    const choice=renderToStaticMarkup(<FilmMotionChoice spec={spec} label="Orbit" disabled selected onClick={()=>{}}/>);
    expect(choice).toContain('type="button"');expect(choice).toContain('disabled=""');expect(choice).toContain('aria-pressed="true"');
    expect(choice).toContain('data-motion-actor="camera"');expect(choice).toContain('>Orbit</span>');
  });
});

describe('Film diagram animation lifetime',()=>{
  it('animates only on visible contact, resumes without restarting, and cleans up',()=>{
    const p=playback(),dispose=p.mount();
    p.event('pointerenter',{pointerType:'mouse'});expect(p.animations).toHaveLength(0);
    p.visible(true);expect(p.animations).toHaveLength(2);expect(p.root.dataset.previewPlaying).toBe('true');
    const existing=[...p.animations];p.event('pointerleave');expect(p.root.dataset.previewPlaying).toBe('false');
    for(const animation of existing)expect(animation.pause).toHaveBeenCalled();
    p.event('pointerenter',{pointerType:'mouse'});expect(p.animations).toEqual(existing);
    p.visible(false);expect(p.root.dataset.previewPlaying).toBe('false');
    p.visible(true);expect(p.root.dataset.previewPlaying).toBe('true');
    dispose();for(const animation of existing)expect(animation.cancel).toHaveBeenCalledOnce();
    expect(p.disconnect).toHaveBeenCalledOnce();expect(p.doc.count()+p.media.count()+p.connection.count()+p.root.count()).toBe(0);
  });
  it('supports keyboard focus without letting a mouse click keep it running after exit',()=>{
    const p=playback(),dispose=p.mount();p.visible(true);
    p.root.focused=true;p.event('focusin');expect(p.root.dataset.previewPlaying).toBe('true');
    p.event('focusout',{relatedTarget:null});expect(p.root.dataset.previewPlaying).toBe('false');
    p.event('pointerenter',{pointerType:'mouse'});p.event('pointerdown');p.root.focused=false;p.event('focusin');
    p.event('pointerleave');expect(p.root.dataset.previewPlaying).toBe('false');dispose();
  });
  it('does not run on touch, under reduced motion/data saving, or in a hidden tab',()=>{
    const p=playback(),dispose=p.mount();p.visible(true);p.event('pointerenter',{pointerType:'touch'});expect(p.animations).toHaveLength(0);
    p.media.matches=true;p.event('pointerenter',{pointerType:'mouse'});expect(p.animations).toHaveLength(0);
    p.media.matches=false;p.media.dispatchEvent(new Event('change'));expect(p.root.dataset.previewPlaying).toBe('true');
    for(const [surface,key] of [[p.doc,'hidden'],[p.media,'matches'],[p.connection,'saveData']] as const){
      (surface as any)[key]=true;surface.dispatchEvent(new Event(surface===p.doc?'visibilitychange':'change'));expect(p.root.dataset.previewPlaying).toBe('false');
      (surface as any)[key]=false;surface.dispatchEvent(new Event(surface===p.doc?'visibilitychange':'change'));expect(p.root.dataset.previewPlaying).toBe('true');
    }
    dispose();
  });
});
