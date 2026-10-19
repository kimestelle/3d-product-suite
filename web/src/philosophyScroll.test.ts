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
  const gesture=(to=600)=>{wheel(to-root.scrollTop);vi.advanceTimersByTime(40);move(to);vi.advanceTimersByTime(100);end();};
  return {root,policy,doc,win,schedule,control,wheel,move,end,gesture,
    select:()=>{selectionCollapsed=false;}};
}

beforeEach(()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('Philosophy proximity settling',()=>{
  it('leaves native wheel input unprevented and only finishes a nearby pose after release',()=>{
    const f=fixture();const wheel=f.wheel(600);
    expect(wheel.accepted).toBe(true);expect(wheel.value.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(40);f.move(600);
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTo).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    expect(f.control.advance(performance.now()+40)).toBe(true);
    expect(f.root.scrollTop).toBeGreaterThan(600);expect(f.root.scrollTop).toBeLessThan(660);
    f.control.dispose();
  });

  it('allows a single notch and arbitrary reading positions without jumping to a section',()=>{
    const f=fixture();
    for(const position of [120,240,400,800,1000]){
      f.gesture(position);
      expect(f.control.advance(performance.now()+1000)).toBe(false);
      expect(f.root.scrollTop).toBe(position);
    }
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTo).not.toHaveBeenCalled();
    f.control.dispose();
  });

  it('reaches the exact fractional stop without re-arming from immediate or deferred own events',()=>{
    const f=fixture({position:1100});f.gesture(1300);
    const started=performance.now();
    expect(f.control.advance(started+40)).toBe(true);
    expect(f.control.advance(started+1000)).toBe(false);
    expect(f.root.scrollTop).toBe(1363.993);
    expect(f.root.scrollTo.mock.calls.every(([options])=>options.behavior==='instant')).toBe(true);
    vi.advanceTimersByTime(1000);event(f.root,'scroll');f.end();f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.control.dispose();
  });

  it('cancels immediately on a reversed wheel gesture and leaves its reading position alone',()=>{
    const f=fixture();f.gesture();f.control.advance(performance.now()+40);
    const interrupted=f.root.scrollTop;f.wheel(-80);
    expect(f.control.advance(performance.now()+2000)).toBe(false);
    expect(f.root.scrollTop).toBe(interrupted);
    vi.advanceTimersByTime(40);f.move(interrupted-80);vi.advanceTimersByTime(100);f.end();
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    expect(f.root.scrollTop).toBe(interrupted-80);
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.dispose();
  });

  it('uses the final movement direction even when the gesture originated on the other side',()=>{
    const f=fixture({position:500});f.wheel(150);vi.advanceTimersByTime(40);f.move(650);
    f.wheel(-30);vi.advanceTimersByTime(40);f.move(620);vi.advanceTimersByTime(100);f.end();
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTop).toBe(620);
    f.control.dispose();
  });

  it('retains reverse intent when compositor scrolling precedes the passive wheel callback',()=>{
    const f=fixture({position:780});vi.advanceTimersByTime(40);
    f.root.scrollTop=700;f.wheel(-80);event(f.root,'scroll');vi.advanceTimersByTime(100);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.advance(performance.now()+1000);expect(f.root.scrollTop).toBe(660);
    f.control.dispose();
  });

  it('allows a single notch away from a completed stop before its deferred scroll event',()=>{
    const f=fixture();f.gesture();
    f.root.scrollTo.mockImplementation(({top})=>{f.root.scrollTop=top;});
    f.control.advance(performance.now()+1000);expect(f.root.scrollTop).toBe(660);
    f.root.scrollTop=740;f.wheel(80);event(f.root,'scroll');vi.advanceTimersByTime(100);f.end();
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    expect(f.root.scrollTop).toBe(740);expect(f.schedule).toHaveBeenCalledTimes(1);
    f.gesture(700);f.control.advance(performance.now()+1000);
    expect(f.root.scrollTop).toBe(660);expect(f.schedule).toHaveBeenCalledTimes(2);
    f.control.dispose();
  });

  it('yields to resumed native momentum without requiring another wheel event',()=>{
    const f=fixture();f.gesture();f.control.advance(performance.now()+40);
    const nativePosition=f.root.scrollTop+12;f.move(nativePosition);
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    expect(f.root.scrollTop).toBe(nativePosition);
    f.end();vi.advanceTimersByTime(1000);
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.dispose();
  });

  it('yields to a compositor position change before its deferred scroll callback',()=>{
    const f=fixture();f.gesture();f.control.advance(performance.now()+40);
    const nativePosition=f.root.scrollTop+12;f.root.scrollTop=nativePosition;
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    expect(f.root.scrollTop).toBe(nativePosition);
    event(f.root,'scroll');f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);f.control.dispose();
  });

  it('uses an idle fallback only when native scrollend is unavailable',()=>{
    const fallback=fixture({nativeEnd:false});fallback.wheel(600);vi.advanceTimersByTime(40);fallback.move(600);
    vi.advanceTimersByTime(79);expect(fallback.schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);expect(fallback.schedule).toHaveBeenCalledTimes(1);fallback.control.dispose();
    const native=fixture();native.wheel(600);vi.advanceTimersByTime(40);native.move(600);
    vi.advanceTimersByTime(1000);expect(native.schedule).not.toHaveBeenCalled();
    native.end();expect(native.schedule).toHaveBeenCalledTimes(1);native.control.dispose();
  });

  it('continues immediately at native scrollend with the available release velocity',()=>{
    const f=fixture({position:570});f.wheel(30);vi.advanceTimersByTime(40);f.move(600);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
    const release=performance.now();expect(f.control.advance(release+.01)).toBe(true);
    expect((f.root.scrollTop-600)/.01).toBeCloseTo(.75,5);
    f.control.dispose();
  });

  it('keeps a held PageDown native and waits for key release at a nearby stop',()=>{
    const f=fixture();const down=event(f.root,'keydown',{key:'PageDown'});
    expect(down.accepted).toBe(true);expect(down.value.defaultPrevented).toBe(false);
    vi.advanceTimersByTime(40);f.move(600);vi.advanceTimersByTime(200);f.end();
    expect(f.schedule).not.toHaveBeenCalled();event(f.win,'keyup',{key:'PageDown'});
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.control.advance(performance.now()+1000);expect(f.root.scrollTop).toBe(660);f.control.dispose();
  });

  it('does not compete with native paging momentum after a quick key release',()=>{
    const f=fixture();event(f.root,'keydown',{key:'PageDown'});
    vi.advanceTimersByTime(40);f.move(120);event(f.win,'keyup',{key:'PageDown'});
    vi.advanceTimersByTime(60);f.move(320);vi.advanceTimersByTime(40);expect(f.schedule).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);f.move(600);vi.advanceTimersByTime(80);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);f.control.dispose();
  });

  it('does not arm fine keyboard reading, editable input, Find, focus, or programmatic scrolling',()=>{
    const f=fixture();
    for(const key of ['ArrowDown','ArrowUp','Home','End',' ','f']){
      event(f.root,'keydown',{key});f.move(600);f.end();
    }
    f.root.editable=true;event(f.root,'keydown',{key:'PageDown'});
    f.move(620);event(f.win,'keyup',{key:'PageDown'});f.end();
    event(f.root,'focusin');f.move(640);f.end();vi.advanceTimersByTime(1000);
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTo).not.toHaveBeenCalled();f.control.dispose();
  });

  it('cancels on pointer contact and never settles while the pointer is held',()=>{
    const f=fixture();f.gesture();event(f.root,'pointerdown');
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.wheel(20);vi.advanceTimersByTime(40);f.move(620);vi.advanceTimersByTime(200);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    event(f.win,'pointerup');expect(f.schedule).toHaveBeenCalledTimes(2);f.control.dispose();
  });

  it('releases held input state when the window loses focus',()=>{
    const f=fixture();event(f.root,'keydown',{key:'PageDown'});vi.advanceTimersByTime(40);f.move(600);
    event(f.win,'blur');vi.advanceTimersByTime(200);f.end();expect(f.schedule).not.toHaveBeenCalled();
    f.gesture(620);expect(f.schedule).toHaveBeenCalledTimes(1);f.control.dispose();
  });

  it('does not interfere with zoom, horizontal gestures, or selected text',()=>{
    const f=fixture();f.gesture();
    const zoom=event(f.root,'wheel',{deltaY:100,deltaX:0,ctrlKey:true});
    expect(zoom.value.defaultPrevented).toBe(false);expect(f.control.advance(performance.now()+1000)).toBe(false);
    event(f.root,'wheel',{deltaY:20,deltaX:100,ctrlKey:false});f.move(620);f.end();
    expect(f.schedule).toHaveBeenCalledTimes(1);
    f.select();f.gesture(640);expect(f.schedule).toHaveBeenCalledTimes(1);f.control.dispose();
  });

  it('honors desktop and motion policy and cancels if it changes while settling',()=>{
    const f=fixture({enabled:false});f.gesture();expect(f.schedule).not.toHaveBeenCalled();
    f.policy.matches=true;event(f.policy,'change');f.gesture(620);expect(f.schedule).toHaveBeenCalledTimes(1);
    f.policy.matches=false;event(f.policy,'change');expect(f.control.advance(performance.now()+1000)).toBe(false);f.control.dispose();
  });

  it('cancels on visibility loss and explicit navigation or resize cancellation',()=>{
    const f=fixture();f.gesture();f.doc.hidden=true;event(f.doc,'visibilitychange');
    expect(f.control.advance(performance.now()+1000)).toBe(false);
    f.doc.hidden=false;f.gesture(620);f.control.cancel();expect(f.control.advance(performance.now()+1000)).toBe(false);f.control.dispose();
  });

  it('cleans pending timers and removes listeners on disposal',()=>{
    const f=fixture({nativeEnd:false});f.wheel(600);vi.advanceTimersByTime(40);f.move(600);
    f.control.dispose();vi.advanceTimersByTime(1000);
    f.wheel();f.move(620);f.end();event(f.root,'keydown',{key:'PageDown'});event(f.win,'keyup',{key:'PageDown'});vi.advanceTimersByTime(1000);
    expect(f.schedule).not.toHaveBeenCalled();expect(f.root.scrollTo).not.toHaveBeenCalled();expect(f.control.advance(performance.now())).toBe(false);
  });
});
