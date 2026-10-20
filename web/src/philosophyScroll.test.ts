import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createPhilosophyScroll} from './philosophyScroll';
import {DEFAULT_SCROLL_TUNING} from './philosophyScrollPhysics';

const stops=[0,660,1363.993,2067.986,2771.979,3475.972];
class ScrollRoot extends EventTarget {
  scrollTop=0;scrollHeight=4276;clientHeight=800;parentElement=null;
  editable=false;debug=false;
  closest(selector:string){return (selector.includes('data-scroll-debug')&&this.debug)||(selector.includes('input')&&this.editable)?this:null;}
  scrollTo=vi.fn(({top}:{top:number;behavior:string})=>{this.scrollTop=top;this.dispatchEvent(new Event('scroll'));this.dispatchEvent(new Event('scrollend'));});
}
function event(target:EventTarget,type:string,fields:Record<string,unknown>={}){
  const value=Object.assign(new Event(type,{cancelable:true}),fields);target.dispatchEvent(value);return value;
}
function fixture({enabled=true,position=0}={}){
  const root=new ScrollRoot();root.scrollTop=position;
  const policy=Object.assign(new EventTarget(),{matches:enabled});
  const doc=Object.assign(new EventTarget(),{hidden:false});
  let selected=false;
  const win=Object.assign(new EventTarget(),{getSelection:()=>({isCollapsed:!selected})});
  const tuning={...DEFAULT_SCROLL_TUNING,enabled:true};
  vi.stubGlobal('window',win);vi.stubGlobal('document',doc);vi.stubGlobal('HTMLElement',ScrollRoot);
  vi.stubGlobal('matchMedia',()=>policy);
  const schedule=vi.fn();
  const control=createPhilosophyScroll(root as unknown as HTMLElement,{stops:()=>stops,schedule,tuning:()=>tuning});
  const wheel=(dy=120,fields={})=>event(root,'wheel',{deltaY:dy,deltaX:0,deltaMode:0,ctrlKey:false,metaKey:false,shiftKey:false,...fields});
  const advance=(ms=16)=>{vi.advanceTimersByTime(ms);return control.advance(performance.now());};
  const settle=()=>{for(let i=0;i<700;i++)if(!advance())return;throw new Error('motion did not settle');};
  return {root,policy,doc,win,tuning,schedule,control,wheel,advance,settle,select:()=>{selected=true;}};
}
beforeEach(()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']}));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('Philosophy continuous desktop scrolling',()=>{
  it('starts on the first frame and uses one real offset without a scrollend timer',()=>{
    const f=fixture();expect(f.wheel(120).defaultPrevented).toBe(true);
    expect(f.schedule).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    expect(f.advance()).toBe(true);expect(f.root.scrollTop).toBeGreaterThan(0);expect(f.root.scrollTop).toBeLessThan(120);
    f.settle();expect(f.root.scrollTop).toBeCloseTo(120,0);
    expect(f.root.scrollTo.mock.calls.every(([options])=>options.behavior==='instant')).toBe(true);
    f.control.dispose();
  });
  it('settles into03 after approaching or slightly passing it',()=>{
    for(const [position,delta] of [[2700,30],[2840,-30]]){
      const f=fixture({position});f.wheel(delta);f.settle();
      expect(f.root.scrollTop).toBeCloseTo(stops[4],4);expect(f.control.snapshot().phase).toBe('resting');f.control.dispose();
    }
  });
  it('retains velocity between trackpad events and accepts immediate reversal',()=>{
    const f=fixture();f.wheel(120);f.advance();
    const before=f.control.snapshot().velocity;f.wheel(60);
    expect(f.control.snapshot().velocity).toBeGreaterThan(before);
    f.wheel(-180);expect(f.control.snapshot().velocity).toBeLessThan(0);f.advance();f.control.dispose();
  });
  it('allows small departures without pulling repeatedly back to the same stop',()=>{
    const f=fixture({position:660});f.wheel(50);f.settle();const first=f.root.scrollTop;
    expect(first).toBeGreaterThan(700);expect(first).toBeLessThan(720);
    f.wheel(50);f.settle();expect(f.root.scrollTop).toBeGreaterThan(first+40);f.control.dispose();
  });
  it('keeps native keyboard navigation, and yields to native scroll before deferred events',()=>{
    const f=fixture();f.wheel();f.advance();
    const key=event(f.root,'keydown',{key:'PageDown'});expect(key.defaultPrevented).toBe(false);expect(f.advance()).toBe(false);
    f.wheel();f.advance();f.root.scrollTop+=30;const native=f.root.scrollTop;
    expect(f.advance()).toBe(false);expect(f.root.scrollTop).toBe(native);f.control.dispose();
  });
  it('ignores its own synchronous and deferred scroll events after settling',()=>{
    const f=fixture({position:2700});f.wheel(30);f.settle();
    const count=f.schedule.mock.calls.length;event(f.root,'scroll');event(f.root,'scrollend');
    expect(f.advance()).toBe(false);expect(f.schedule).toHaveBeenCalledTimes(count);f.control.dispose();
  });
  it('normalizes line and page deltas rather than treating them as pixels',()=>{
    const f=fixture();f.wheel(3,{deltaMode:1});f.settle();expect(f.root.scrollTop).toBeCloseTo(48,0);f.control.dispose();
    const page=fixture();page.wheel(1,{deltaMode:2});expect(page.control.snapshot().velocity).toBeGreaterThan(1000);page.control.dispose();
  });
  it('never takes over zoom, horizontal input, text selection or editable controls',()=>{
    const f=fixture();
    for(const flags of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{deltaX:240}])expect(f.wheel(120,flags).defaultPrevented).toBe(false);
    f.root.editable=true;expect(f.wheel().defaultPrevented).toBe(false);f.root.editable=false;
    f.select();expect(f.wheel().defaultPrevented).toBe(false);expect(f.root.scrollTo).not.toHaveBeenCalled();f.control.dispose();
  });
  it('debug controls keep native wheel and do not cancel a running seek on focus',()=>{
    const f=fixture();f.control.seek(4);f.root.debug=true;
    event(f.root,'focusin');event(f.root,'keydown',{key:'Tab'});
    expect(f.wheel().defaultPrevented).toBe(false);expect(f.advance()).toBe(true);
    f.settle();expect(f.root.scrollTop).toBe(stops[4]);f.control.dispose();
  });
  it('uses native motion on compact/reduced-motion devices or when disabled',()=>{
    const f=fixture({enabled:false});expect(f.wheel().defaultPrevented).toBe(false);
    f.control.seek(4);expect(f.root.scrollTop).toBe(stops[4]);expect(f.control.snapshot().phase).toBe('native');f.control.dispose();
    const live=fixture();live.wheel();live.advance();live.tuning.enabled=false;expect(live.advance()).toBe(false);expect(live.wheel().defaultPrevented).toBe(false);live.control.dispose();
  });
  it('cancels on motion policy, visibility, pointer contact, focus or explicit resize/navigation',()=>{
    const f=fixture();
    for(const cancel of [()=>event(f.policy,'change'),()=>{f.doc.hidden=true;event(f.doc,'visibilitychange');},()=>event(f.root,'pointerdown'),()=>event(f.root,'focusin'),()=>f.control.cancel()]){
      f.doc.hidden=false;event(f.win,'pointerup');f.wheel(30);f.advance();cancel();expect(f.advance()).toBe(false);
    }
    f.control.dispose();
  });
  it('interrupts explicit stop navigation with a new wheel gesture',()=>{
    const f=fixture();f.control.seek(4);f.advance(80);const before=f.root.scrollTop;
    f.wheel(-120);f.advance();expect(f.control.snapshot().velocity).toBeLessThan(0);
    f.settle();expect(f.root.scrollTop).toBeLessThan(before);f.control.dispose();
  });
  it('leaves outward wheel at boundaries native and removes every listener on teardown',()=>{
    const f=fixture();expect(f.wheel(-120).defaultPrevented).toBe(false);
    f.wheel(120);f.control.dispose();const count=f.schedule.mock.calls.length;
    expect(f.wheel(120).defaultPrevented).toBe(false);event(f.root,'scroll');event(f.policy,'change');
    expect(f.advance()).toBe(false);expect(f.schedule).toHaveBeenCalledTimes(count);
  });
});
