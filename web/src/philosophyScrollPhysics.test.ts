import {describe,expect,it} from 'vitest';
import {createScrollParticle,DEFAULT_SCROLL_TUNING,normalizeScrollTuning,normalizeStops,pushScrollParticle,sampleScrollLandscape,stepScrollParticle,type ScrollParticle,type ScrollTuning} from './philosophyScrollPhysics';

const stops=[0,660,1363.993,2067.986,2771.979,3475.972];
const maximum=3600;
const tuning={...DEFAULT_SCROLL_TUNING,enabled:true};
function run(initial:ScrollParticle,{dt=1/60,seconds=6,points=stops,max=maximum,settings=tuning,start=0}: {dt?:number;seconds?:number;points?:number[];max?:number;settings?:ScrollTuning;start?:number}={}){
  let state=initial,active=true,now=start;
  const positions:number[]=[];
  for(let i=0;i<Math.ceil(seconds/dt)&&active;i++){
    now+=dt*1000;
    const result=stepScrollParticle(state,dt,now,points,max,settings);
    state=result.state;active=result.active;positions.push(state.position);
  }
  return {state,active,positions,now};
}

describe('scroll landscape',()=>{
  it('normalizes stops without losing fractional minima',()=>{
    expect(normalizeStops([900,-20,660,660,1363.993,Infinity,NaN],1000)).toEqual([0,660,900,1000]);
    expect(normalizeStops(stops,maximum)).toEqual(stops);
    expect(normalizeStops([20,-20],-10)).toEqual([0]);
  });
  it('uses the same normalized quartic and derivative as the debugger',()=>{
    expect(sampleScrollLandscape(0,[0,100],100)).toEqual({potential:0,gradient:0,target:0});
    expect(sampleScrollLandscape(50,[0,100],100)).toEqual({potential:1,gradient:0,target:0});
    expect(sampleScrollLandscape(25,[0,100],100).potential).toBe(.5625);
    expect(sampleScrollLandscape(25,[0,100],100).gradient).toBe(.03);
    expect(sampleScrollLandscape(75,[0,100],100).gradient).toBe(-.03);
    for(const stop of stops){
      expect(sampleScrollLandscape(stop,stops,maximum).potential).toBe(0);
      expect(sampleScrollLandscape(stop,stops,maximum).gradient).toBe(0);
      expect(sampleScrollLandscape(stop,stops,maximum).target).toBe(stop);
    }
  });
  it('normalizes invalid tuning and bounds editable values',()=>{
    expect(normalizeScrollTuning({})).toEqual(DEFAULT_SCROLL_TUNING);
    expect(DEFAULT_SCROLL_TUNING.enabled).toBe(false);
    expect(normalizeScrollTuning({enabled:false,pull:100,damping:.1,response:40})).toEqual({enabled:false,pull:18,damping:.7,response:28});
    expect(normalizeScrollTuning({pull:NaN,damping:Infinity,response:-5})).toEqual({...DEFAULT_SCROLL_TUNING,response:8});
  });
});

describe('one damped scroll particle',()=>{
  it.each(stops.map((stop,index)=>[index,stop]))('settles exactly at minimum %i from both sides, including03',(_,stop)=>{
    for(const direction of [-1,1]){
      const state=createScrollParticle(stop+direction*36,0);
      state.velocity=direction*120;state.direction=direction;
      const result=run(state);
      expect(result.active).toBe(false);
      expect(result.state.position).toBe(stop);
      expect(result.state.velocity).toBe(0);
    }
  });
  it('catches03 after forward and reverse modest overshoots',()=>{
    for(const direction of [-1,1]){
      const state={...createScrollParticle(stops[4]+direction*28,0),velocity:direction*240,direction};
      const result=run(state);
      expect(result.state.position).toBe(stops[4]);
      expect(result.active).toBe(false);
    }
  });
  it('approaches a valley without a default spring wobble',()=>{
    const result=run(createScrollParticle(stops[4]-80,0));
    expect(result.state.position).toBe(stops[4]);
    expect(result.positions.every((position,index)=>index===0||position>=result.positions[index-1])).toBe(true);
    expect(Math.max(...result.positions)).toBe(stops[4]);
  });
  it('preserves small departures instead of repeatedly snapping to their origin',()=>{
    let state=createScrollParticle(0,0),now=0;
    for(let i=0;i<3;i++){
      state=pushScrollParticle(state,20,now,stops,maximum,tuning);
      const result=run(state,{start:now});state=result.state;now=result.now;
      expect(result.active).toBe(false);expect(state.blockedStop).toBe(0);
      expect(state.position).toBeCloseTo((i+1)*20,0);
      expect(state.position).toBeGreaterThan(i*20+19.8);
    }
  });
  it('lets a browser-quantized completed stop depart without relaxing exact landing',()=>{
    const state=pushScrollParticle(createScrollParticle(stops[4]+.25,0),20,0,stops,maximum,tuning);
    expect(state.blockedStop).toBe(stops[4]);
    const result=run(state);
    expect(result.active).toBe(false);expect(result.state.position).toBeCloseTo(stops[4]+20.25,0);
    expect(run(createScrollParticle(stops[4]+.25,0)).state.position).toBe(stops[4]);
  });
  it('releases departure protection after crossing into the next basin',()=>{
    const state=pushScrollParticle(createScrollParticle(0,0),440,0,stops,maximum,tuning);
    const result=run(state);
    expect(result.state.blockedStop).toBe(null);
    expect(result.state.position).toBe(stops[1]);expect(result.active).toBe(false);
  });
  it('reverses immediately and permits returning to a departed valley',()=>{
    const forward=pushScrollParticle(createScrollParticle(0,0),80,0,stops,maximum,tuning);
    const moving=stepScrollParticle(forward,.04,40,stops,maximum,tuning).state;
    expect(moving.velocity).toBeGreaterThan(0);
    const reversed=pushScrollParticle(moving,-10,40,stops,maximum,tuning);
    expect(reversed.velocity).toBe(-10*tuning.response);
    expect(reversed.blockedStop).toBe(null);
    const result=run(reversed,{start:40});expect(result.state.position).toBe(0);
  });
  it('integrates free impulses to their requested distance across response settings',()=>{
    for(const response of [8,16,28]){
      const settings={...tuning,response};
      let state=pushScrollParticle(createScrollParticle(1000,0),100,0,[],maximum,settings);
      state=pushScrollParticle(state,25,0,[],maximum,settings);
      const result=run(state,{points:[],settings});
      expect(result.state.position).toBeCloseTo(1125,0);
      expect(Math.abs(result.state.position-1125)).toBeLessThan(.1);
      expect(result.active).toBe(false);
    }
  });
  it('keeps damping ratio active near a valley even above the free response rate',()=>{
    const initial={...createScrollParticle(stops[4],-10000),velocity:100,direction:1};
    for(const response of [16,28]){
      const light=stepScrollParticle(initial,1/120,0,stops,maximum,{...tuning,response,damping:.7});
      const critical=stepScrollParticle(initial,1/120,0,stops,maximum,{...tuning,response,damping:1});
      const heavy=stepScrollParticle(initial,1/120,0,stops,maximum,{...tuning,response,damping:1.5});
      expect(light.state.velocity).toBeGreaterThan(critical.state.velocity);
      expect(critical.state.velocity).toBeGreaterThan(heavy.state.velocity);
    }
    const goal={...initial,goal:stops[4]};
    const light=stepScrollParticle(goal,1/120,0,stops,maximum,{...tuning,response:28,damping:.7});
    const heavy=stepScrollParticle(goal,1/120,0,stops,maximum,{...tuning,response:28,damping:1.5});
    expect(light.state.velocity).toBeGreaterThan(heavy.state.velocity);
  });
  it('ramps well attraction continuously without an idle timer',()=>{
    const state=createScrollParticle(stops[4]-50,0);
    const start=stepScrollParticle(state,0,0,stops,maximum,tuning);
    expect(start.force).toBe(0);expect(start.active).toBe(true);
    const next=stepScrollParticle(state,1/120,1000/120,stops,maximum,tuning);
    expect(next.force).toBeGreaterThan(0);expect(next.state.velocity).toBeGreaterThan(0);
  });
  it('matches30,60 and120Hz trajectories and exact endpoints',()=>{
    const initial={...createScrollParticle(2490,0),velocity:2000,direction:1};
    const samples=[1/30,1/60,1/120].map(dt=>run(initial,{dt,seconds:.8}));
    for(const sample of samples){
      expect(sample.state.position).toBeCloseTo(samples[0].state.position,6);
      expect(sample.state.velocity).toBeCloseTo(samples[0].state.velocity,6);
    }
    for(const dt of [1/30,1/60,1/120])expect(run(initial,{dt}).state.position).toBe(stops[4]);
  });
  it('keeps long gaps, repeated large input and malformed values finite and bounded',()=>{
    let state=pushScrollParticle(createScrollParticle(1500,0),1e9,0,stops,maximum,tuning);
    expect(state.velocity).toBeLessThanOrEqual(12000);
    const result=stepScrollParticle(state,120,120000,stops,maximum,tuning);
    expect(Number.isFinite(result.state.position)).toBe(true);
    expect(result.state.position).toBeGreaterThanOrEqual(0);expect(result.state.position).toBeLessThanOrEqual(maximum);
    expect(Math.abs(result.state.position-state.position)).toBeLessThan(800);
    state=stepScrollParticle({...state,position:NaN,velocity:Infinity},NaN,NaN,[NaN],maximum,tuning).state;
    expect(Number.isFinite(state.position)).toBe(true);expect(Number.isFinite(state.velocity)).toBe(true);
  });
  it('clamps edges and releases outward velocity',()=>{
    for(const [position,delta] of [[0,-100],[maximum,100]]){
      const state=pushScrollParticle(createScrollParticle(position,0),delta,0,[0,maximum],maximum,tuning);
      const result=stepScrollParticle(state,.016,16,[0,maximum],maximum,tuning);
      expect(result.state.position).toBe(position);expect(result.state.velocity).toBe(0);expect(result.active).toBe(false);
    }
  });
  it('uses the same particle for explicit goals and makes them interruptible',()=>{
    const state={...createScrollParticle(200,0),goal:stops[4],velocity:400};
    const result=run(state);
    expect(result.state.position).toBe(stops[4]);expect(result.state.goal).toBe(null);expect(result.active).toBe(false);
    const moving=stepScrollParticle(state,.016,16,stops,maximum,tuning).state;
    const interrupted=pushScrollParticle(moving,-8,16,stops,maximum,tuning);
    expect(interrupted.goal).toBe(null);expect(interrupted.velocity).toBeLessThan(0);
  });
  it('supports disabled tuning and does not mutate its input',()=>{
    const initial=Object.freeze(createScrollParticle(100,0));
    const disabled={...tuning,enabled:false};
    const pushed=pushScrollParticle(initial,20,0,stops,maximum,disabled);
    expect(pushed.position).toBe(120);expect(initial.position).toBe(100);
    expect(stepScrollParticle(pushed,.016,16,stops,maximum,disabled).active).toBe(false);
  });
});
