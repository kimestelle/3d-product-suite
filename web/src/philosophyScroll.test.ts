import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createPhilosophyScroll} from './philosophyScroll';

class ScrollRoot extends EventTarget {
  scrollTop=0;
  scrollHeight=4200;
  clientHeight=800;
  editable=false;
  closest(){return this.editable?this:null;}
  scrollTo=vi.fn(({top}:{top:number;behavior:string})=>{
    this.scrollTop=top;
    // Programmatic writes generate the same native events as user scrolling.
    this.dispatchEvent(new Event('scroll'));
    this.dispatchEvent(new Event('scrollend'));
  });
}

function event(target:EventTarget,type:string,fields:Record<string,unknown>={}){
  const value=Object.assign(new Event(type,{cancelable:true}),fields);
  const accepted=target.dispatchEvent(value);
  return {value,accepted};
}

function fixture({nativeEnd=true,enabled=true,position=0}={}){
  const root=new ScrollRoot();root.scrollTop=position;
  if(nativeEnd)Object.assign(root,{onscrollend:null});
  const policy=Object.assign(new EventTarget(),{matches:enabled});
  const doc=Object.assign(new EventTarget(),{hidden:false});
  let selectionCollapsed=true;
  const win=Object.assign(new EventTarget(),{
    setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,
    getSelection:()=>({isCollapsed:selectionCollapsed}),
  });
  vi.stubGlobal('window',win);vi.stubGlobal('document',doc);
  vi.stubGlobal('matchMedia',vi.fn(()=>policy));
  const schedule=vi.fn();
  const control=createPhilosophyScroll(root as unknown as HTMLElement,{
    stops:()=>[0,660,1363.993,2067.986,2771.979,3475.972],schedule,
  });
  const wheel=(dy=120)=>event(root,'wheel',{deltaY:dy,deltaX:0,ctrlKey:false});
  const move=(to:number)=>{root.scrollTop=to;event(root,'scroll');};
  const end=()=>event(root,'scrollend');
  const gesture=(to=120)=>{wheel(to-root.scrollTop);vi.advanceTimersByTime(40);move(to);vi.advanceTimersByTime(100);end();};
  return {root,policy,doc,win,schedule,control,wheel,move,end,gesture,
    select:()=>{selectionCollapsed=false;}};
}

beforeEach(()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('Philosophy post-gesture settling',()=>{
  it('leaves native wheel events unprevented and waits for release before scheduling',()=>{
    const f=fixture();
    const wheel=f.wheel();
    expect(wheel.accepted).toBe(true);expect(wheel.value.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(40);f.move(120);
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    expect(f.control.advance(performance.now()+80)).toBe(true);
    expect(f.root.scrollTop).toBeGreaterThan(120);expect(f.root.scrollTop).toBeLessThan(660);
    f.control.dispose();
  });

  it('writes the real scroll offset, reaches the exact pose, and never re-arms from its own events',()=>{
    const f=fixture();f.gesture();
    const started=performance.now();
    expect(f.control.advance(started+100)).toBe(true);
    expect(f.control.advance(started+1000)).toBe(false);
    expect(f.root.scrollTop).toBe(660);
    expect(f.root.scrollTo.mock.calls.every(([options])=>options.behavior==='instant')).toBe(true);
    vi.advanceTimersByTime(1000);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.control.dispose();
  });

  it('cancels immediately on a new wheel gesture and reverses from the displayed position',()=>{
    const f=fixture();f.gesture();
    f.control.advance(performance.now()+100);
    const interrupted=f.root.scrollTop;
    f.wheel(-120);
    expect(f.control.advance(performance.now()+2000)).toBe(false);
    expect(f.root.scrollTop).toBe(interrupted);
    vi.advanceTimersByTime(40);f.move(Math.max(0,interrupted-120));
    vi.advanceTimersByTime(100);f.end();
    f.control.advance(performance.now()+1000);
    expect(f.root.scrollTop).toBe(0);
    f.control.dispose();
  });

  it('retains reverse intent when compositor scrolling precedes the passive wheel callback',()=>{
    const f=fixture({position:1363.993});
    vi.advanceTimersByTime(40);
    // A passive wheel listener may observe the compositor's new position already.
    f.root.scrollTop=1097.993;f.wheel(-266);event(f.root,'scroll');
    vi.advanceTimersByTime(100);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.advance(performance.now()+1000);
    expect(f.root.scrollTop).toBe(660);
    f.control.dispose();
  });

  it('updates its baseline on animation writes before their deferred scroll callback',()=>{
    const f=fixture();f.gesture();
    f.root.scrollTo.mockImplementation(({top})=>{f.root.scrollTop=top;});
    f.control.advance(performance.now()+100);
    const displayed=f.root.scrollTop;
    expect(displayed).toBeGreaterThan(200);
    // Reverse before the browser delivers the scroll event from the animation.
    f.root.scrollTop=displayed-80;f.wheel(-80);event(f.root,'scroll');
    vi.advanceTimersByTime(100);f.end();f.control.advance(performance.now()+1000);
    expect(f.root.scrollTop).toBe(0);
    f.control.dispose();
  });

  it('can leave a finished animated stop even before its scroll event is delivered',()=>{
    const f=fixture();f.gesture();
    f.root.scrollTo.mockImplementation(({top})=>{f.root.scrollTop=top;});
    f.control.advance(performance.now()+1000);expect(f.root.scrollTop).toBe(660);
    f.root.scrollTop=580;f.wheel(-80);event(f.root,'scroll');
    vi.advanceTimersByTime(100);f.end();f.control.advance(performance.now()+1000);
    expect(f.root.scrollTop).toBe(0);
    f.control.dispose();
  });

  it('uses an idle fallback only when native scrollend is unavailable',()=>{
    const fallback=fixture({nativeEnd:false});fallback.wheel();
    vi.advanceTimersByTime(40);fallback.move(120);
    vi.advanceTimersByTime(79);expect(fallback.schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);expect(fallback.schedule).toHaveBeenCalledTimes(1);
    fallback.control.dispose();
    const native=fixture();native.wheel();vi.advanceTimersByTime(40);native.move(120);
    vi.advanceTimersByTime(1000);expect(native.schedule).not.toHaveBeenCalled();
    native.end();expect(native.schedule).toHaveBeenCalledTimes(1);
    native.control.dispose();
  });

  it('continues immediately from native scrollend without inserting an idle timer',()=>{
    const f=fixture();f.wheel();vi.advanceTimersByTime(40);f.move(120);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const release=performance.now();
    expect(f.control.advance(release+.01)).toBe(true);
    // Native offset changed 120px in 40ms: retain the 3px/ms release speed.
    expect((f.root.scrollTop-120)/.01).toBeCloseTo(3,5);
    f.control.dispose();
  });

  it('keeps a held PageDown native, then settles after release',()=>{
    const f=fixture();
    const down=event(f.root,'keydown',{key:'PageDown'});
    expect(down.accepted).toBe(true);expect(down.value.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(40);f.move(560);
    vi.advanceTimersByTime(200);f.end();
    expect(f.schedule).not.toHaveBeenCalled();
    event(f.win,'keyup',{key:'PageDown'});
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.advance(performance.now()+1000);expect(f.root.scrollTop).toBe(660);
    f.control.dispose();
  });

  it('does not compete with native paging momentum after a quick key release',()=>{
    const f=fixture();event(f.root,'keydown',{key:'PageDown'});
    vi.advanceTimersByTime(40);f.move(120);event(f.win,'keyup',{key:'PageDown'});
    vi.advanceTimersByTime(60);f.move(320);
    vi.advanceTimersByTime(40);expect(f.schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);f.move(500);
    vi.advanceTimersByTime(80);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.dispose();
  });

  it('does not arm fine keyboard reading, form input, Find, focus, or programmatic scrolling',()=>{
    const f=fixture();
    for(const key of ['ArrowDown','ArrowUp','Home','End',' ','f']){
      event(f.root,'keydown',{key});f.move(140);f.end();
    }
    f.root.editable=true;event(f.root,'keydown',{key:'PageDown'});
    f.move(260);event(f.win,'keyup',{key:'PageDown'});f.end();
    event(f.root,'focusin');f.move(400);f.end();vi.advanceTimersByTime(1000);
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTo).not.toHaveBeenCalled();
    f.control.dispose();
  });

  it('cancels on pointer contact and never settles while the pointer is held',()=>{
    const f=fixture();f.gesture();event(f.root,'pointerdown');
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.wheel();vi.advanceTimersByTime(40);f.move(240);
    vi.advanceTimersByTime(200);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    // Native scrolling already ended while held; no second scrollend is promised.
    event(f.win,'pointerup');
    expect(f.schedule).toHaveBeenCalledTimes(2);
    f.control.dispose();
  });

  it('releases held input state when the window loses focus',()=>{
    const f=fixture();event(f.root,'keydown',{key:'PageDown'});
    vi.advanceTimersByTime(40);f.move(120);
    event(f.win,'blur');vi.advanceTimersByTime(200);f.end();
    expect(f.schedule).not.toHaveBeenCalled();
    f.gesture(240);expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.dispose();
  });

  it('does not interfere with zoom, horizontal gestures, or selected text',()=>{
    const f=fixture();f.gesture();
    const zoom=event(f.root,'wheel',{deltaY:100,deltaX:0,ctrlKey:true});
    expect(zoom.value.defaultPrevented).toBe(false);
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    event(f.root,'wheel',{deltaY:20,deltaX:100,ctrlKey:false});f.move(180);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.select();f.gesture(300);expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.dispose();
  });

  it('honors desktop/motion policy at rest and cancels if it changes during settling',()=>{
    const f=fixture({enabled:false});f.gesture();
    expect(f.schedule).not.toHaveBeenCalled();
    f.policy.matches=true;event(f.policy,'change');f.gesture(360);
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.policy.matches=false;event(f.policy,'change');
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.control.dispose();
  });

  it('cancels on visibility loss and explicit navigation/resize cancellation',()=>{
    const f=fixture();f.gesture();f.doc.hidden=true;event(f.doc,'visibilitychange');
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.doc.hidden=false;f.gesture(240);f.control.cancel();
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.control.dispose();
  });

  it('cleans pending timers and removes listeners on disposal',()=>{
    const f=fixture({nativeEnd:false});f.wheel();vi.advanceTimersByTime(40);f.move(120);
    f.control.dispose();vi.advanceTimersByTime(1000);
    f.wheel();f.move(240);f.end();event(f.root,'keydown',{key:'PageDown'});
    event(f.win,'keyup',{key:'PageDown'});vi.advanceTimersByTime(1000);
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTo).not.toHaveBeenCalled();
    expect(f.control.advance(performance.now())).toBe(false);
  });
});
