import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {FrameDriver,frameContrastColor,type FrameRoute,type FrameVisual} from './DynamicFrame';
import {frameGuidePath} from './frameGuides';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import {createStudioExpansion,studioLoadingNodes} from './studioLoading';
import {aboutFrameNodes,frameBounds,framePath,landingFrameNodes,philosophyFrameNodes,roundedFrameNodes} from './frameGeometry';

class EventSurface {
  listeners=new Map<string,Set<()=>void>>();
  addEventListener(name:string,handler:()=>void) {if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name)!.add(handler);}
  removeEventListener(name:string,handler:()=>void) {this.listeners.get(name)?.delete(handler);}
  emit(name:string) {for(const handler of this.listeners.get(name)??[])handler();}
  count(name:string) {return this.listeners.get(name)?.size??0;}
}
class Element {
  attrs=new Map<string,string>();dataset:Record<string,string>={};inert=false;
  style={backgroundColor:'',visibility:'',pointerEvents:'',values:new Map<string,string>(),setProperty(name:string,value:string){this.values.set(name,value);}};
  setAttribute(name:string,value:string) {this.attrs.set(name,value);}
}
let now=0,nextFrame=1;
let callbacks:Map<number,FrameRequestCallback>;
let windowSurface:EventSurface,documentSurface:EventSurface&{hidden:boolean},preference:EventSurface&{matches:boolean};
let width=1280,height=832;
const routes:FrameRoute[]=['landing','about','philosophy','studio'];
const base={ground:'#980101',fill:'#ef1111',halo:{color:'#ff4c7c',blur:75,spread:30,opacity:.8}};
function source(page:FrameRoute):FrameVisual {
  const origin={x:width/2,y:height/2,width:width*.75,viewportWidth:width,viewportHeight:height,aperture:.68};
  const nodes=page==='landing'?landingFrameNodes(origin):page==='about'?aboutFrameNodes(width,height):
    page==='philosophy'?philosophyFrameNodes(width,height,.2):roundedFrameNodes({left:280,top:110,right:width-40,bottom:height-30},32);
  return {...base,nodes,ground:page==='philosophy'?'#000':page==='studio'?'#1e1e1e':base.ground};
}
function advance(ms=16) {
  now+=ms;const batch=Array.from(callbacks.values());callbacks.clear();
  for(const callback of batch)callback(now);
}
function setup(initial:FrameRoute='landing',studioReady=false,composited=false) {
  const driver=new FrameDriver(initial,'test-contour');
  const animations=Array.from({length:2},()=>({currentTime:0,playState:'running',cancel:vi.fn(),pause(){this.playState='paused';},play(){this.playState='running';}}));
  const surfaces=animations.map(animation=>({animate:vi.fn(()=>animation)}));
  const loader=Object.assign(new Element(),{hidden:true,querySelectorAll:()=>surfaces});
  const elements={root:new Element(),path:new Element(),outside:new Element(),guides:new Element(),halo:new Element(),fill:new Element(),light:new Element(),blur:new Element(),...(composited?{loader}:{})};
  const hosts=Object.fromEntries(routes.map(page=>[page,new Element()])) as Record<FrameRoute,Element>;
  for(const route of routes){driver.register(route,()=>source(route));driver.registerHost(route,hosts[route] as unknown as HTMLElement);}
  if(studioReady)driver.markReady('studio');
  const dispose=driver.attach(elements as unknown as Parameters<FrameDriver['attach']>[0]);
  const settled=vi.fn(),waiting=vi.fn();driver.onSettled=settled;driver.onWaiting=waiting;
  advance();
  return {driver,elements,hosts,dispose,settled,waiting,animations,loader};
}

beforeEach(()=>{
  now=0;nextFrame=1;width=1280;height=832;callbacks=new Map();
  windowSurface=new EventSurface();documentSurface=Object.assign(new EventSurface(),{hidden:false});preference=Object.assign(new EventSurface(),{matches:false});
  vi.stubGlobal('window',windowSurface);vi.stubGlobal('document',documentSurface);
  vi.stubGlobal('innerWidth',width);vi.stubGlobal('innerHeight',height);
  vi.stubGlobal('matchMedia',vi.fn(()=>preference));vi.stubGlobal('performance',{now:()=>now});
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{const id=nextFrame++;callbacks.set(id,callback);return id;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>callbacks.delete(id));
});

describe('Compositor-owned loading perspective',()=>{
  it('opens from the visible animation time after a delayed main-thread frame',()=>{
    const {driver,elements,animations,loader,dispose}=setup('landing',false,true);
    driver.navigate('studio');advance();advance(480);
    expect(loader.hidden).toBe(false);expect(elements.fill.attrs.get('visibility')).toBe('hidden');
    for(const animation of animations)animation.currentTime=2170;
    driver.markReady('studio');advance(400);
    expect(driver.current!.nodes).toEqual(studioLoadingNodes(2170,{x:width/2,y:height/2}));
    expect(loader.hidden).toBe(true);expect(elements.fill.attrs.get('visibility')).toBe('visible');
    for(const animation of animations)expect(animation.cancel).toHaveBeenCalledOnce();
    advance(680);expect(driver.current).toEqual(source('studio'));dispose();
  });
  it('pauses the native animation on failure and hidden tabs, and cancels it on teardown',()=>{
    const {driver,animations,dispose}=setup('landing',false,true);driver.navigate('studio');advance();advance(480);
    for(const animation of animations)animation.currentTime=900;
    driver.failStudio();advance();expect(animations.every(animation=>animation.playState==='paused')).toBe(true);
    driver.retryStudio();advance();expect(animations.every(animation=>animation.playState==='running')).toBe(true);
    documentSurface.hidden=true;documentSurface.emit('visibilitychange');
    expect(animations.every(animation=>animation.playState==='paused')).toBe(true);
    documentSurface.hidden=false;documentSurface.emit('visibilitychange');advance();
    expect(animations.every(animation=>animation.playState==='running')).toBe(true);
    dispose();for(const animation of animations)expect(animation.cancel).toHaveBeenCalledOnce();
  });
  it('holds the current native pose for reduced motion without an animation clock',()=>{
    const {driver,animations,dispose}=setup('landing',false,true);driver.navigate('studio');advance();advance(480);
    for(const animation of animations)animation.currentTime=1300;
    preference.matches=true;preference.emit('change');advance();
    expect(driver.current!.nodes).toEqual(studioLoadingNodes(1300,{x:width/2,y:height/2}));
    expect(animations.every(animation=>animation.playState==='paused')).toBe(true);expect(callbacks.size).toBe(0);
    preference.matches=false;preference.emit('change');advance();
    expect(animations.every(animation=>animation.playState==='running')).toBe(true);dispose();
  });
});

describe('Local geometry publication and shared inverse clip',()=>{
  it('publishes active local geometry and window offsets synchronously without a second animation frame',()=>{
    const {driver,elements,dispose}=setup('philosophy');
    const next={...source('philosophy'),nodes:philosophyFrameNodes(width,height,.77)};
    const read=vi.fn(()=>next),measure=vi.fn();
    driver.sources.set('philosophy',read);driver.windows.add(measure);
    expect(callbacks.size).toBe(0);
    driver.invalidate('philosophy');
    expect(driver.current).toEqual(next);expect(elements.path.attrs.get('d')).toBe(framePath(next.nodes));
    expect(read).toHaveBeenCalledTimes(1);expect(measure).toHaveBeenCalledTimes(1);expect(callbacks.size).toBe(0);dispose();
  });
  it('keeps pending navigation and active travel under the shared clock instead of snapping to local geometry',()=>{
    const {driver,dispose}=setup('landing',true),initial=structuredClone(driver.current);
    driver.navigate('philosophy');driver.invalidate('philosophy');
    expect(driver.current).toEqual(initial);expect(callbacks.size).toBe(1);
    advance();advance(180);const traveling=structuredClone(driver.current);
    driver.invalidate('philosophy');expect(driver.current).toEqual(traveling);expect(callbacks.size).toBe(1);
    advance(500);expect(driver.current).toEqual(source('philosophy'));dispose();
  });
  it('does not publish hidden or inactive local geometry',()=>{
    const {driver,dispose}=setup('about'),initial=structuredClone(driver.current);
    const inactive=vi.fn(()=>source('landing'));driver.sources.set('landing',inactive);
    driver.invalidate('landing');advance();expect(inactive).not.toHaveBeenCalled();expect(driver.current).toEqual(initial);
    documentSurface.hidden=true;documentSurface.emit('visibilitychange');
    const active=vi.fn(()=>source('about'));driver.sources.set('about',active);
    driver.invalidate('about');expect(active).not.toHaveBeenCalled();expect(callbacks.size).toBe(0);dispose();
  });
  it('uses exactly the displayed contour inside the viewport-sized inverse clip during motion and after resize',()=>{
    const {driver,elements,dispose}=setup('landing',true);
    const verify=()=>expect(elements.outside.attrs.get('d')).toBe(`M 0 0 H ${innerWidth} V ${innerHeight} H 0 Z ${elements.path.attrs.get('d')}`);
    verify();driver.navigate('about');advance();advance(230);verify();
    width=1600;height=1000;vi.stubGlobal('innerWidth',width);vi.stubGlobal('innerHeight',height);
    windowSurface.emit('resize');advance();verify();advance(680);verify();dispose();
  });
});

describe('Measured source recovery and studio failure fallback',()=>{
  it('keeps the last valid contour if its mounted source temporarily cannot measure',()=>{
    const {driver,elements,dispose}=setup('philosophy');
    const measured=structuredClone(driver.current),unavailable=vi.fn(()=>null);
    driver.sources.set('philosophy',unavailable);driver.invalidate('philosophy');
    expect(driver.current).toEqual(measured);expect(elements.path.attrs.get('d')).toBe(framePath(measured!.nodes));
    expect(unavailable).toHaveBeenCalledTimes(1);expect(callbacks.size).toBe(0);dispose();
  });
  it('can return to an already measured route after its source is removed',()=>{
    const {driver,dispose}=setup('about',true),measured=structuredClone(driver.current);
    driver.navigate('landing');advance();advance(680);driver.sources.delete('about');
    driver.navigate('about');advance();advance(680);
    expect(driver.current).toEqual(measured);expect(driver.pending).toBe(false);expect(callbacks.size).toBe(0);dispose();
  });
  it('replaces cached geometry when a live source becomes available again',()=>{
    const {driver,dispose}=setup('philosophy');driver.sources.delete('philosophy');
    driver.invalidate('philosophy');
    const restored={...source('philosophy'),nodes:philosophyFrameNodes(width,height,.9)};
    driver.register('philosophy',()=>restored);advance();expect(driver.current).toEqual(restored);dispose();
  });
  it.each([false,true])('reaches an honest loading/error hold when studio has never provided geometry (missing=%s)',missing=>{
    const {driver,elements,waiting,settled,dispose}=setup();
    const unavailable=vi.fn(()=>null);
    if(missing)driver.sources.delete('studio');else driver.sources.set('studio',unavailable);
    driver.navigate('studio');advance();expect(driver.pending).toBe(false);expect(driver.travel?.loading).toBe(true);
    driver.failStudio();advance(480);advance();
    expect(driver.waiting).toBe(true);expect(waiting).toHaveBeenLastCalledWith(true);
    expect(elements.root.dataset.framePhase).toBe('waiting');expect(frameBounds(driver.current!.nodes).width).toBeCloseTo(92,7);
    expect(settled).not.toHaveBeenCalled();expect(callbacks.size).toBe(0);
    const calls=unavailable.mock.calls.length;advance(10000);
    expect(unavailable).toHaveBeenCalledTimes(calls);expect(callbacks.size).toBe(0);
    driver.navigate('about');advance();advance(680);expect(driver.current).toEqual(source('about'));dispose();
  });
  it('has finite fallback geometry on a direct initial studio failure and can retry into the real source',()=>{
    const {driver,elements,dispose}=setup('landing');
    driver.sources.delete('studio');driver.current=null;driver.navigate('studio');advance();
    expect(elements.path.attrs.get('d')).not.toMatch(/NaN|Infinity/);advance(480);advance();expect(driver.waiting).toBe(true);
    const actual=source('studio');driver.retryStudio();driver.register('studio',()=>actual);driver.markReady('studio');advance();
    expect(driver.travel?.loading).toBe(false);advance(680);expect(driver.current).toEqual(actual);dispose();
  });
  it('retains measured studio geometry if an error boundary unregisters the source during expansion',()=>{
    const {driver,dispose}=setup('landing',true);
    driver.navigate('studio');advance();advance(200);const measured=source('studio');driver.sources.delete('studio');advance(480);
    expect(driver.current).toEqual(measured);expect(callbacks.size).toBe(0);dispose();
  });
});
afterEach(()=>vi.unstubAllGlobals());

describe('Shared frame route transitions',()=>{
  it('restores local shrink tuning and applies edits to subsequent route travel',()=>{
    const storage=new Map([['gesso.frame-shrink.v1','0.3']]);
    vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
    const {driver,dispose}=setup('about',true),start=frameBounds(driver.current!.nodes),end=frameBounds(source('studio').nodes);
    expect(driver.transitionShrink).toBe(.3);
    driver.navigate('studio');advance();advance(340);
    expect(frameBounds(driver.current!.nodes).width).toBeCloseTo((start.width+end.width)/2*.7,5);
    advance(340);expect(driver.current).toEqual(source('studio'));
    driver.setTransitionShrink(0);expect(storage.get('gesso.frame-shrink.v1')).toBe('0');
    driver.navigate('about');advance();advance(340);
    expect(frameBounds(driver.current!.nodes).width).toBeCloseTo((start.width+end.width)/2,5);
    driver.setTransitionShrink(.08);expect(new FrameDriver('about','test').transitionShrink).toBe(.08);
    dispose();
  });
  it.each([['landing','studio'],['studio','about']] as const)('keeps every host inert from immediate %s → %s navigation through the final animation frame',(from,to)=>{
    const {driver,elements,hosts,dispose}=setup(from,true);
    expect(hosts[from].inert).toBe(false);
    const assertInert=()=>{for(const host of Object.values(hosts)){expect(host.inert).toBe(true);expect(host.style.pointerEvents).toBe('none');expect(host.attrs.get('aria-hidden')).toBe('true');}};
    driver.navigate(to);assertInert();expect(elements.root.dataset.framePhase).toBe('moving');
    advance();assertInert();advance(440);assertInert();
    expect(driver.currentWeights[to]).toBeGreaterThan(.5);
    advance(200);assertInert();expect(driver.currentWeights[to]).toBe(1);
    advance(40);expect(driver.travel).toBeNull();expect(hosts[to].inert).toBe(false);expect(hosts[to].style.pointerEvents).toBe('auto');
    for(const route of routes.filter(route=>route!==to))expect(hosts[route].inert).toBe(true);dispose();
  });
  it.each(routes.flatMap(from=>routes.filter(to=>to!==from).map(to=>[from,to])))('settles %s → %s on the registered contour',(from,to)=>{
    const {driver,elements,hosts,settled,dispose}=setup(from as FrameRoute,true);
    driver.navigate(to as FrameRoute);advance();
    expect(driver.travel?.destination).toBe(to);advance(680);
    expect(driver.current).toEqual(source(to as FrameRoute));
    expect(elements.path.attrs.get('d')).toBe(framePath(source(to as FrameRoute).nodes));
    expect(elements.root.dataset.framePhase).toBe('settled');
    expect(settled).toHaveBeenLastCalledWith(to);
    for(const page of routes){expect(driver.currentWeights[page]).toBe(page===to?1:0);expect(hosts[page].inert).toBe(page!==to);}
    expect(callbacks.size).toBe(0);dispose();
  });
  it('retargets from the displayed shape, appearance, and content weights without jumping',()=>{
    const {driver,dispose}=setup('landing',true);
    driver.navigate('about');advance();advance(240);
    const displayed=structuredClone(driver.current),weights={...driver.currentWeights};
    driver.navigate('philosophy');advance();
    expect(driver.current).toEqual(displayed);expect(driver.currentWeights).toEqual(weights);
    expect(driver.travel?.from).toEqual(displayed);expect(driver.travel?.destination).toBe('philosophy');
    advance(680);expect(driver.current).toEqual(source('philosophy'));dispose();
  });
  it('reverses to the starting page from a live intermediate contour',()=>{
    const {driver,dispose}=setup('about',true);
    driver.navigate('landing');advance();advance(400);const intermediate=structuredClone(driver.current);
    driver.navigate('about');advance();expect(driver.current).toEqual(intermediate);
    advance(680);expect(driver.current).toEqual(source('about'));dispose();
  });
});

describe('Studio readiness and interruption',()=>{
  it.each([
    ['#131313','#131313','#f9faf7'],
    ['#131313','rgb(19, 19, 19)','#f9faf7'],
    ['#f9faf7','#f9faf7','#131313'],
    ['#131313','transparent','#f9faf7'],
    ['#131313','#ff5724','#ff5724'],
  ])('keeps the loading glyph visible on %s when the source halo is %s',(ground,halo,expected)=>{
    const {driver,elements,dispose}=setup('studio');
    const visual={...source('studio'),ground,halo:{color:halo,blur:0,spread:0,opacity:0}};
    driver.register('studio',()=>visual);driver.navigate('studio');advance();advance(480);
    expect(driver.current!.fill).toBe(expected);expect(elements.fill.attrs.get('fill')).toBe(expected);
    expect(driver.current!.halo.color).toBe(expected);
    expect(frameContrastColor(ground)).toBe(ground==='#f9faf7'?'#131313':'#f9faf7');
    dispose();
  });
  it('paints a centered, contrasting loader on the first frame of a direct studio visit',()=>{
    const {driver,elements,waiting,hosts,dispose}=setup('studio');
    driver.current=null;driver.sources.delete('studio');driver.navigate('studio');advance();
    expect(driver.waiting).toBe(true);expect(driver.travel).toBeNull();expect(waiting).toHaveBeenLastCalledWith(true);
    expect(elements.root.dataset.framePhase).toBe('waiting');
    const bounds=frameBounds(driver.current!.nodes);
    expect(bounds.width).toBeCloseTo(92,7);expect(bounds.left+46).toBeCloseTo(width/2,7);
    expect(bounds.top+46).toBeCloseTo(height/2,7);expect(elements.fill.attrs.get('fill')).not.toBe(driver.current!.ground);
    expect(Object.values(driver.currentWeights).every(weight=>weight===0)).toBe(true);expect(hosts.studio.inert).toBe(true);
    driver.register('studio',()=>source('studio'));advance(100);
    expect(driver.waiting).toBe(true);expect(driver.current!.fill).not.toBe(driver.current!.ground);
    driver.markReady('studio');advance();advance(680);expect(driver.current).toEqual(source('studio'));dispose();
  });
  it.each(['landing','about','philosophy','studio'] as const)('centers the loader in the viewport from %s',route=>{
    const {driver,dispose}=setup(route);
    driver.navigate('studio');advance();advance(480);
    for(const ms of [0,350,700,1400,2100]) {
      advance(ms);const bounds=frameBounds(driver.current!.nodes);
      expect((bounds.left+bounds.right)/2).toBeCloseTo(width/2,7);
      expect((bounds.top+bounds.bottom)/2).toBeCloseTo(height/2,7);
    }
    dispose();expect(callbacks.size).toBe(0);
  });
  it('keeps the rotating loader centered when the viewport resizes',()=>{
    const {driver,dispose}=setup('about');driver.navigate('studio');advance();advance(480);advance(700);
    width=1600;height=1000;vi.stubGlobal('innerWidth',width);vi.stubGlobal('innerHeight',height);
    windowSurface.emit('resize');advance();
    const bounds=frameBounds(driver.current!.nodes);
    expect((bounds.left+bounds.right)/2).toBeCloseTo(800,7);expect((bounds.top+bounds.bottom)/2).toBeCloseTo(500,7);
    dispose();
  });
  it('retargets a loading contraction to the new viewport center after resize',()=>{
    const {driver,dispose}=setup('about');driver.navigate('studio');advance();advance(180);
    const displayed=structuredClone(driver.current);
    width=1600;height=1000;vi.stubGlobal('innerWidth',width);vi.stubGlobal('innerHeight',height);
    windowSurface.emit('resize');advance();expect(driver.current).toEqual(displayed);
    advance(480);const bounds=frameBounds(driver.current!.nodes);
    expect((bounds.left+bounds.right)/2).toBeCloseTo(800,7);expect((bounds.top+bounds.bottom)/2).toBeCloseTo(500,7);
    dispose();
  });
  it('freezes a failed loader and resumes the same shape on retry',()=>{
    const {driver,dispose}=setup();driver.navigate('studio');advance();advance(480);advance(700);
    const displayed=structuredClone(driver.current);
    driver.failStudio();advance();expect(driver.current).toEqual(displayed);expect(callbacks.size).toBe(0);
    advance(10000);driver.retryStudio();advance();expect(driver.current).toEqual(displayed);expect(callbacks.size).toBe(1);
    advance(200);expect(driver.current).not.toEqual(displayed);
    driver.markReady('studio');advance();advance(680);expect(driver.current).toEqual(source('studio'));dispose();
  });
  it('pauses the loading clock while hidden and resumes without jumping',()=>{
    const {driver,dispose}=setup();driver.navigate('studio');advance();advance(480);advance(700);
    const displayed=structuredClone(driver.current);
    documentSurface.hidden=true;documentSurface.emit('visibilitychange');expect(callbacks.size).toBe(0);
    advance(10000);documentSurface.hidden=false;documentSurface.emit('visibilitychange');advance(0);
    expect(driver.current).toEqual(displayed);advance(100);expect(driver.current).not.toEqual(displayed);dispose();
  });
  it('holds the current loading shape without a clock when reduced motion is enabled',()=>{
    const {driver,dispose}=setup();driver.navigate('studio');advance();advance(480);advance(700);
    const displayed=structuredClone(driver.current);
    preference.matches=true;preference.emit('change');advance();
    expect(driver.current).toEqual(displayed);expect(callbacks.size).toBe(0);
    advance(10000);preference.matches=false;preference.emit('change');advance();
    expect(driver.current).toEqual(displayed);expect(callbacks.size).toBe(1);
    driver.navigate('about');advance();advance(680);expect(driver.current).toEqual(source('about'));expect(callbacks.size).toBe(0);dispose();
  });
  it('contracts to the centered loading disk, tilts while waiting, then opens from its current perspective',()=>{
    const {driver,elements,hosts,waiting,settled,dispose}=setup();
    driver.navigate('studio');advance();expect(driver.travel?.loading).toBe(true);
    advance(480);expect(driver.waiting).toBe(true);
    const circle=frameBounds(driver.current!.nodes);
    expect(circle.width).toBeCloseTo(92,7);expect(circle.height).toBeCloseTo(92,7);
    expect(circle.left+46).toBeCloseTo(width/2,7);expect(circle.top+46).toBeCloseTo(height/2,7);
    expect(elements.root.dataset.framePhase).toBe('waiting');expect(settled).not.toHaveBeenCalled();
    for(const host of Object.values(hosts))expect(host.inert).toBe(true);
    const initial=framePath(driver.current!.nodes);advance(700);
    expect(callbacks.size).toBe(1);expect(framePath(driver.current!.nodes)).not.toBe(initial);
    const held=structuredClone(driver.current);driver.markReady('studio');advance();
    expect(driver.current).toEqual(held);expect(driver.waiting).toBe(false);expect(driver.travel?.loading).toBe(false);
    expect(driver.travel?.opening).toBe(true);
    expect(driver.travel!.morph(.12)).toEqual(createStudioExpansion(held!.nodes,source('studio').nodes)(.12));
    advance(680);expect(driver.current).toEqual(source('studio'));expect(waiting).toHaveBeenLastCalledWith(false);dispose();
  });
  it('finishes the contraction even if rendering is ready before the circle is reached',()=>{
    const {driver,dispose}=setup();
    driver.navigate('studio');advance();advance(120);driver.markReady('studio');advance(120);
    expect(driver.travel?.loading).toBe(true);expect(driver.waiting).toBe(false);
    advance(240);expect(frameBounds(driver.current!.nodes).width).toBeCloseTo(92,7);expect(driver.waiting).toBe(true);
    advance();expect(driver.travel?.loading).toBe(false);advance(680);expect(driver.current).toEqual(source('studio'));dispose();
  });
  it('ignores a late studio readiness notification after the user has chosen another route',()=>{
    const {driver,settled,dispose}=setup();
    driver.navigate('studio');advance();advance(480);
    driver.navigate('about');advance();driver.markReady('studio');advance(680);
    expect(driver.target).toBe('about');expect(driver.current).toEqual(source('about'));expect(driver.waiting).toBe(false);
    expect(settled).toHaveBeenLastCalledWith('about');expect(settled).not.toHaveBeenCalledWith('studio');dispose();
  });
  it('uses an already available studio without a loading gate and can mark it unready for retry',()=>{
    const {driver,dispose}=setup('landing',true);
    driver.navigate('studio');advance();expect(driver.travel?.loading).toBe(false);advance(680);
    driver.navigate('landing');advance();advance(680);driver.retryStudio();
    driver.navigate('studio');advance();expect(driver.travel?.loading).toBe(true);dispose();
  });
});

describe('Motion preferences, viewport changes, and lifecycle',()=>{
  it('settles navigation immediately under reduced motion while retaining the readiness gate',()=>{
    preference.matches=true;const {driver,dispose}=setup();
    driver.navigate('about');advance();expect(driver.current).toEqual(source('about'));expect(driver.travel).toBeNull();
    driver.navigate('studio');advance();expect(driver.waiting).toBe(true);expect(frameBounds(driver.current!.nodes).width).toBeCloseTo(92,7);
    driver.markReady('studio');advance();expect(driver.current).toEqual(source('studio'));expect(driver.waiting).toBe(false);dispose();
  });
  it('honors reduced motion when the preference changes during travel',()=>{
    const {driver,dispose}=setup();driver.navigate('about');advance();advance(180);
    preference.matches=true;preference.emit('change');advance();
    expect(driver.current).toEqual(source('about'));expect(driver.travel).toBeNull();dispose();
  });
  it('retargets resize from the current shape and reaches the newly measured destination',()=>{
    const {driver,dispose}=setup('about',true);driver.navigate('studio');advance();advance(200);
    const displayed=structuredClone(driver.current);width=1600;height=1000;windowSurface.emit('resize');advance();
    expect(driver.current).toEqual(displayed);expect(driver.travel?.from).toEqual(displayed);
    advance(680);expect(driver.current).toEqual(source('studio'));dispose();
  });
  it('refreshes an idle frame after resize and invokes native window measurement first',()=>{
    const {driver,dispose}=setup('about');const order:string[]=[];
    driver.windows.add(()=>order.push('measure'));
    driver.sources.set('about',()=>{order.push('source');return source('about');});
    width=980;height=700;windowSurface.emit('resize');advance();
    expect(order[0]).toBe('measure');expect(driver.current).toEqual(source('about'));expect(callbacks.size).toBe(0);dispose();
  });
  it('pauses while hidden and resumes from the same progress',()=>{
    const {driver,dispose}=setup();driver.navigate('about');advance();advance(200);
    const displayed=structuredClone(driver.current);documentSurface.hidden=true;documentSurface.emit('visibilitychange');
    expect(callbacks.size).toBe(0);advance(2000);
    documentSurface.hidden=false;documentSurface.emit('visibilitychange');advance(0);
    expect(driver.current).toEqual(displayed);advance(480);expect(driver.current).toEqual(source('about'));dispose();
  });
  it('coalesces invalidations and cancels pending work and listeners on teardown',()=>{
    const {driver,elements,dispose}=setup();
    driver.navigate('about');driver.invalidate();driver.invalidate();expect(callbacks.size).toBe(1);
    const path=elements.path.attrs.get('d');dispose();
    expect(callbacks.size).toBe(0);expect(windowSurface.count('resize')).toBe(0);
    expect(documentSurface.count('visibilitychange')).toBe(0);expect(preference.count('change')).toBe(0);
    driver.invalidate();driver.markReady('studio');advance(1000);
    expect(callbacks.size).toBe(0);expect(elements.path.attrs.get('d')).toBe(path);
  });
});


describe('Shared frame invalidation and write budgets',()=>{
  it('reads a destination once per trip and reuses it until explicit invalidation or resize',()=>{
    const {driver,dispose}=setup('landing',true);
    const read=vi.fn(()=>source('about'));driver.sources.set('about',read);
    driver.navigate('about');advance();
    for(let i=0;i<10;i++)advance(40);
    expect(read).toHaveBeenCalledTimes(1);
    driver.invalidate('about');advance();expect(read).toHaveBeenCalledTimes(2);
    advance(40);advance(40);expect(read).toHaveBeenCalledTimes(2);
    width=1500;height=960;windowSurface.emit('resize');advance();expect(read).toHaveBeenCalledTimes(3);
    advance(680);expect(read).toHaveBeenCalledTimes(3);expect(driver.current).toEqual(source('about'));
    driver.invalidate();advance();expect(read).toHaveBeenCalledTimes(3);
    driver.navigate('landing');advance();advance(680);driver.navigate('about');advance();expect(read).toHaveBeenCalledTimes(4);
    dispose();
  });
  it('measures dirty visible windows once, with no layout reads during pure morph ticks',()=>{
    const {driver,dispose}=setup('landing',true);
    const measure=Object.fromEntries(routes.map(page=>[page,vi.fn()])) as Record<FrameRoute,ReturnType<typeof vi.fn>>;
    const unwatch=routes.map(page=>driver.watchWindow(page,measure[page]));
    expect(measure.landing).toHaveBeenCalledTimes(1);
    for(const page of routes.filter(page=>page!=='landing'))expect(measure[page]).not.toHaveBeenCalled();
    for(const callback of Object.values(measure))callback.mockClear();
    driver.navigate('about');advance();
    expect(measure.landing).toHaveBeenCalledTimes(1);expect(measure.about).toHaveBeenCalledTimes(1);
    for(let i=0;i<12;i++)advance(40);
    expect(measure.landing).toHaveBeenCalledTimes(1);expect(measure.about).toHaveBeenCalledTimes(1);
    expect(measure.philosophy).not.toHaveBeenCalled();expect(measure.studio).not.toHaveBeenCalled();
    advance(200);expect(callbacks.size).toBe(0);
    driver.invalidate('about');expect(measure.about).toHaveBeenCalledTimes(2);expect(measure.landing).toHaveBeenCalledTimes(1);
    driver.invalidate('landing');expect(callbacks.size).toBe(0);expect(measure.landing).toHaveBeenCalledTimes(1);
    windowSurface.emit('resize');advance();expect(measure.about).toHaveBeenCalledTimes(3);expect(measure.landing).toHaveBeenCalledTimes(1);
    for(const remove of unwatch)remove();driver.invalidate('about');expect(measure.about).toHaveBeenCalledTimes(3);dispose();
  });
  it('keeps inactive source/window changes asleep but consumes the latest values when visited',()=>{
    const {driver,dispose}=setup('about',true);
    const visual={...source('philosophy'),nodes:philosophyFrameNodes(width,height,.85)};
    const read=vi.fn(()=>visual),measure=vi.fn();
    driver.register('philosophy',read);const unwatch=driver.watchWindow('philosophy',measure);
    for(let i=0;i<5;i++)driver.invalidate('philosophy');
    driver.markReady('studio');
    expect(callbacks.size).toBe(0);expect(read).not.toHaveBeenCalled();expect(measure).not.toHaveBeenCalled();
    driver.navigate('philosophy');advance();advance(680);
    expect(driver.current).toEqual(visual);expect(read).toHaveBeenCalledTimes(1);expect(measure).toHaveBeenCalledTimes(1);
    unwatch();dispose();
  });
  it('does not rewrite SVG or host attributes for unchanged geometry or repeated idle paints',()=>{
    const {driver,elements,hosts,dispose}=setup('about',true);
    const writes=[...Object.values(elements),...Object.values(hosts)].map(element=>vi.spyOn(element,'setAttribute'));
    driver.invalidate();advance();driver.invalidate('about');driver.invalidate();advance();
    for(const write of writes)expect(write).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);dispose();
  });
  it('updates the contour without rewriting constant fill, halo, filter, or hidden-host attributes',()=>{
    const {driver,elements,hosts,dispose}=setup('landing',true);
    const writes=[elements.fill,elements.halo,elements.blur,hosts.philosophy,hosts.studio].map(element=>vi.spyOn(element,'setAttribute'));
    const path=vi.spyOn(elements.path,'setAttribute');
    driver.navigate('about');advance();advance(160);advance(160);advance(160);
    expect(path).toHaveBeenCalled();
    for(const write of writes)expect(write).not.toHaveBeenCalled();
    dispose();
  });
});

describe('Halo rendering budget',()=>{
  it('keeps the shared shape intact and suspends invisible halo work until it is needed again',()=>{
    const {driver,elements,dispose}=setup('philosophy',true);
    let visual={...source('philosophy'),halo:{color:'#ff5724',spread:24,blur:40,opacity:0}};
    driver.register('philosophy',()=>visual);
    expect(elements.halo.attrs.get('display')).toBe('none');
    const haloWrites=vi.spyOn(elements.halo,'setAttribute'),blurWrites=vi.spyOn(elements.blur,'setAttribute');
    visual={...visual,nodes:philosophyFrameNodes(width,height,.8),halo:{...visual.halo,spread:65,blur:95}};
    driver.invalidate('philosophy');
    expect(elements.path.attrs.get('d')).toBe(framePath(visual.nodes));
    expect(haloWrites).not.toHaveBeenCalled();expect(blurWrites).not.toHaveBeenCalled();
    visual={...visual,halo:{...visual.halo,opacity:1}};
    driver.invalidate('philosophy');
    expect(elements.halo.attrs.get('display')).toBe('inline');
    expect(elements.halo.attrs.get('stroke-width')).toBe('130');
    expect(elements.halo.attrs.get('stroke')).toBe('#ff5724');
    expect(elements.halo.attrs.get('opacity')).toBe('1');
    expect(elements.blur.attrs.get('stdDeviation')).toBe('95');
    expect(elements.path.attrs.get('d')).toBe(framePath(visual.nodes));
    expect(callbacks.size).toBe(0);dispose();
  });
});

describe('Mobile frame navigation',()=>{
  it('uses the shared mobile/coarse-pointer policy and reaches every ready destination without tweening',()=>{
    width=640;vi.stubGlobal('innerWidth',width);preference.matches=true;
    const {driver,settled,dispose}=setup('landing',true);
    expect(matchMedia).toHaveBeenCalledWith(STATIC_MOTION_QUERY);
    expect(STATIC_MOTION_QUERY).toContain('(max-width: 760px)');
    expect(STATIC_MOTION_QUERY).toContain('(hover: none) and (pointer: coarse)');
    for(const destination of ['about','philosophy','studio','landing'] as const){
      driver.navigate(destination);advance();
      expect(driver.current).toEqual(source(destination));expect(driver.travel).toBeNull();
      expect(settled).toHaveBeenLastCalledWith(destination);expect(callbacks.size).toBe(0);
    }
    dispose();
  });
  it('settles in-flight travel at the new mobile breakpoint and restores desktop motion when widened',()=>{
    const {driver,dispose}=setup('landing',true);
    driver.navigate('about');advance();advance(160);expect(driver.travel).not.toBeNull();
    width=640;height=800;vi.stubGlobal('innerWidth',width);vi.stubGlobal('innerHeight',height);
    preference.matches=true;windowSurface.emit('resize');preference.emit('change');advance();
    expect(driver.current).toEqual(source('about'));expect(driver.travel).toBeNull();expect(callbacks.size).toBe(0);
    width=1280;height=832;vi.stubGlobal('innerWidth',width);vi.stubGlobal('innerHeight',height);
    preference.matches=false;windowSurface.emit('resize');preference.emit('change');advance();
    driver.navigate('philosophy');advance();expect(driver.travel).not.toBeNull();
    advance(680);expect(driver.current).toEqual(source('philosophy'));dispose();
  });
});


describe('Shape-aware route morphing',()=>{
  const cross=()=>({...source('landing'),nodes:landingFrameNodes({x:width/2,y:height/2,width:width*.75,
    viewportWidth:width,viewportHeight:height,aperture:0})});
  const expectCircle=(nodes:FrameVisual['nodes'])=>{
    const bounds=frameBounds(nodes),cx=(bounds.left+bounds.right)/2,cy=(bounds.top+bounds.bottom)/2;
    expect(bounds.width).toBeCloseTo(bounds.height,5);
    for(const node of nodes)expect(Math.hypot(node.point.x-cx,node.point.y-cy)).toBeCloseTo(bounds.width/2,5);
  };
  it.each(['about','philosophy','studio'] as const)('resolves the home cross into a circle before opening %s',destination=>{
    const {driver,dispose}=setup('landing',true);
    const home=cross();driver.register('landing',()=>home);
    driver.navigate(destination);advance();
    expect(driver.current).toEqual(home);
    advance(340);expectCircle(driver.current!.nodes);
    advance(340);expect(driver.current).toEqual(source(destination));
    expect(callbacks.size).toBe(0);dispose();
  });
  it('uses the same cross handoff when returning home',()=>{
    const {driver,dispose}=setup('about',true),home=cross();driver.register('landing',()=>home);
    driver.navigate('landing');advance();advance(340);expectCircle(driver.current!.nodes);
    advance(340);expect(driver.current).toEqual(home);dispose();
  });
  it('keeps a broad window broad between About and the editor',()=>{
    const {driver,dispose}=setup('about',true),start=frameBounds(driver.current!.nodes),end=frameBounds(source('studio').nodes);
    driver.navigate('studio');advance();advance(340);
    const middle=frameBounds(driver.current!.nodes);
    expect(middle.width).toBeCloseTo((start.width+end.width)/2*.7,5);
    expect(middle.height).toBeCloseTo((start.height+end.height)/2*.7,5);
    expect(middle.width/middle.height).toBeCloseTo((start.width+end.width)/(start.height+end.height),7);
    advance(340);expect(driver.current).toEqual(source('studio'));dispose();
  });
  it('can retarget while the cross is closing without snapping back',()=>{
    const {driver,dispose}=setup('landing',true);driver.register('landing',cross);
    driver.navigate('about');advance();advance(130);
    const displayed=structuredClone(driver.current);
    driver.navigate('philosophy');advance();expect(driver.current).toEqual(displayed);
    advance(680);expect(driver.current).toEqual(source('philosophy'));dispose();
  });
});


describe('Window boundary guides',()=>{
  it('keeps the full pixel halo around an edge-on loader and expands when only blur changes',()=>{
    const {driver,elements,dispose}=setup('philosophy');
    const nodes=studioLoadingNodes(2800,{x:640,y:416}),bounds=frameBounds(nodes);
    let visual={...source('philosophy'),nodes,halo:{...base.halo,blur:20,spread:8}};
    driver.register('philosophy',()=>visual);
    const read=()=>({x:Number(elements.light.attrs.get('x')),y:Number(elements.light.attrs.get('y')),
      width:Number(elements.light.attrs.get('width')),height:Number(elements.light.attrs.get('height'))});
    const small=read();
    expect(small.y).toBeLessThanOrEqual(bounds.top-88);
    expect(small.y+small.height).toBeGreaterThanOrEqual(bounds.bottom+88);
    expect(small.width).toBeLessThan(300);expect(small.height).toBeLessThan(300);
    visual={...visual,halo:{...visual.halo,blur:136,spread:64}};
    driver.invalidate('philosophy');const broad=read();
    expect(broad.x).toBeLessThanOrEqual(bounds.left-608);
    expect(broad.y+broad.height).toBeGreaterThanOrEqual(bounds.bottom+608);
    expect(elements.blur.attrs.get('stdDeviation')).toBe('136');
    expect(elements.halo.attrs.get('stroke-width')).toBe('128');
    expect(callbacks.size).toBe(0);dispose();
  });
  it('tracks the displayed contour through travel, interruption and local editor resizing',()=>{
    const {driver,elements,dispose}=setup('landing',true);
    const verify=()=>expect(elements.guides.attrs.get('d')).toBe(frameGuidePath(driver.current!.nodes,innerWidth,innerHeight));
    verify();driver.navigate('about');advance();advance(230);verify();
    const held=elements.guides.attrs.get('d');
    driver.navigate('studio');advance();expect(elements.guides.attrs.get('d')).toBe(held);
    advance(220);verify();advance(680);verify();
    const editor={...source('studio'),nodes:roundedFrameNodes({left:340,top:116,right:940,bottom:562},20)};
    driver.register('studio',()=>editor);verify();
    expect(elements.guides.attrs.get('d')).toBe('M 340 0 V 832 M 940 0 V 832 M 0 116 H 1280 M 0 562 H 1280');
    expect(callbacks.size).toBe(0);dispose();
  });
  it('updates rule lengths on resize even when the contour stays fixed',()=>{
    const {driver,elements,dispose}=setup('about',true),fixed=driver.current!;
    driver.register('about',()=>fixed);
    vi.stubGlobal('innerWidth',1500);vi.stubGlobal('innerHeight',900);
    windowSurface.emit('resize');advance();
    expect(elements.guides.attrs.get('d')).toBe(frameGuidePath(fixed.nodes,1500,900));dispose();
  });
  it('does not draw a false box for compact philosophy pages with no shared window',()=>{
    const {driver,elements,dispose}=setup('philosophy');
    driver.register('philosophy',()=>({...source('philosophy'),nodes:roundedFrameNodes({left:0,top:0,right:0,bottom:0})}));
    expect(elements.guides.attrs.get('d')).toBe('');expect(callbacks.size).toBe(0);dispose();
  });
});
