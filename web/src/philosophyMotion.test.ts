import {describe,expect,it} from 'vitest';
import {choosePhilosophyStop,createScrollSettle,philosophyScrollProgress,scrollSettlePosition} from './philosophyMotion';

describe('Native philosophy scroll playhead',()=>{
  const stops=[0,660,1363.993,2067.986,2771.979,3475.972];

  it('reaches every finished pose at its fractional native snap offset',()=>{
    stops.forEach((offset,index)=>expect(philosophyScrollProgress(offset,stops)).toBe(index));
    expect(philosophyScrollProgress((stops[2]+stops[3])/2,stops)).toBeCloseTo(2.5,12);
  });

  it('reverses and interrupts immediately, with no history or settling tail',()=>{
    const scrolls=[0,450,660,920,1200,950,660,200,0];
    const forward=scrolls.map(scroll=>philosophyScrollProgress(scroll,stops));
    expect([...scrolls].reverse().map(scroll=>philosophyScrollProgress(scroll,stops)).reverse()).toEqual(forward);
    expect(forward[5]).toBeLessThan(forward[4]);
    expect(forward[6]).toBe(1);
    expect(forward.at(-1)).toBe(0);
  });

  it('clamps rubber-band overscroll and handles an unmeasured layout',()=>{
    expect(philosophyScrollProgress(-80,stops)).toBe(0);
    expect(philosophyScrollProgress(4000,stops)).toBe(5);
    expect(philosophyScrollProgress(100,[])).toBe(0);
    expect(philosophyScrollProgress(100,[0])).toBe(0);
    expect(philosophyScrollProgress(NaN,stops)).toBe(0);
  });
});

describe('Philosophy stop selection',()=>{
  const stops=[0,660,1363.993,2067.986];

  it('finishes only a nearby stop ahead in the final movement direction',()=>{
    expect(choosePhilosophyStop(612,.4,500,stops,2200)).toBe(660);
    expect(choosePhilosophyStop(708,-.4,800,stops,2200)).toBe(660);
    expect(choosePhilosophyStop(1300,.4,1100,stops,2200)).toBe(1363.993);
    expect(choosePhilosophyStop(1363.993,.4,1100,stops,2200)).toBe(1363.993);
  });

  it('does not pull backward after crossing a stop or reverse the last gesture',()=>{
    expect(choosePhilosophyStop(680,.4,500,stops,2200)).toBe(680);
    expect(choosePhilosophyStop(640,-.4,800,stops,2200)).toBe(640);
    expect(choosePhilosophyStop(620,-.4,500,stops,2200)).toBe(620);
    expect(choosePhilosophyStop(90,-.4,0,stops,2200)).toBe(0);
  });

  it('preserves single notches and intermediate reading positions regardless of speed',()=>{
    for(const position of [12,80,120,300,400,800,1000]){
      for(const velocity of [.1,1,100]){
        expect(choosePhilosophyStop(position,velocity,0,stops,2200)).toBe(position);
      }
    }
    expect(choosePhilosophyStop(580,-.1,660,stops,2200)).toBe(580);
  });

  it('uses the completed gesture direction when its final velocity has decayed to zero',()=>{
    expect(choosePhilosophyStop(600,0,500,stops,2200)).toBe(660);
    expect(choosePhilosophyStop(700,0,800,stops,2200)).toBe(660);
    expect(choosePhilosophyStop(960,0,700,stops,2200)).toBe(960);
    expect(choosePhilosophyStop(600,0,600,stops,2200)).toBe(600);
  });

  it('limits attraction to 14 percent of the neighboring gap and at most 96 pixels',()=>{
    expect(choosePhilosophyStop(86,1,0,[0,100],100)).toBe(100);
    expect(choosePhilosophyStop(85.9,1,0,[0,100],100)).toBe(85.9);
    expect(choosePhilosophyStop(14,-1,100,[0,100],100)).toBe(0);
    expect(choosePhilosophyStop(14.1,-1,100,[0,100],100)).toBe(14.1);
    expect(choosePhilosophyStop(904,1,0,[0,1000],1000)).toBe(1000);
    expect(choosePhilosophyStop(903.9,1,0,[0,1000],1000)).toBe(903.9);
  });

  it('clamps unreachable stops, removes duplicates, and tolerates an unmeasured page',()=>{
    expect(choosePhilosophyStop(1920,.4,1800,[...stops,2600],2000)).toBe(2000);
    expect(choosePhilosophyStop(40,-.4,100,[-20,0,660],2000)).toBe(0);
    expect(choosePhilosophyStop(600,.4,0,[0,660,660],2000)).toBe(660);
    expect(choosePhilosophyStop(120,.4,0,[],2000)).toBe(120);
  });
});

describe('Philosophy settle trajectory',()=>{
  it('is bounded and monotone for every supported initial tangent in either direction',()=>{
    for(const [from,to] of [[120,660],[660,120]])for(const velocity of [-10,-.8,0,.8,10]){
      const plan=createScrollSettle(from,to,velocity,1000);
      const points=Array.from({length:201},(_,index)=>scrollSettlePosition(plan,1000+plan.duration*index/200));
      expect(points[0]).toBe(from);expect(points.at(-1)).toBe(to);
      for(let index=1;index<points.length;index++){
        expect(points[index]).toBeGreaterThanOrEqual(Math.min(from,to)-1e-7);
        expect(points[index]).toBeLessThanOrEqual(Math.max(from,to)+1e-7);
        expect((points[index]-points[index-1])*Math.sign(to-from)).toBeGreaterThanOrEqual(-1e-7);
      }
    }
  });

  it('carries the release velocity rather than restarting from rest',()=>{
    for(const [from,to,velocity] of [[0,200,1],[0,200,2],[0,200,3],[200,0,-1],[200,0,-3]]){
      const plan=createScrollSettle(from,to,velocity,1000);
      const initialSpeed=(scrollSettlePosition(plan,1000+.001)-from)/.001;
      expect(initialSpeed).toBeCloseTo(velocity,5);
    }
  });

  it('shortens a fast continuation and clamps extreme speed to a monotone tangent of 2',()=>{
    const slow=createScrollSettle(0,200,0,0);
    const fast=createScrollSettle(0,200,3,0);
    expect(fast.duration).toBeLessThan(slow.duration);
    expect(fast.duration).toBeCloseTo(400/3,8);
    const extreme=createScrollSettle(0,200,10,0);
    expect(extreme.duration).toBe(120);expect(extreme.tangent).toBe(2);
    const points=Array.from({length:201},(_,index)=>scrollSettlePosition(extreme,extreme.duration*index/200));
    for(let index=1;index<points.length;index++){
      expect(points[index]).toBeGreaterThanOrEqual(points[index-1]-1e-7);
      expect(points[index]).toBeLessThanOrEqual(200+1e-7);
    }
  });

  it('begins at the interrupted position and ends stationary without overshoot',()=>{
    const plan=createScrollSettle(284.125,660,.7,500);
    expect(scrollSettlePosition(plan,0)).toBe(284.125);
    expect(scrollSettlePosition(plan,500)).toBe(284.125);
    expect(scrollSettlePosition(plan,500+plan.duration+1000)).toBe(660);
    const end=scrollSettlePosition(plan,500+plan.duration);
    expect(end-scrollSettlePosition(plan,500+plan.duration-.1)).toBeLessThan(.00001);
    const reverse=createScrollSettle(scrollSettlePosition(plan,620),0,-.4,620);
    expect(scrollSettlePosition(reverse,620)).toBe(scrollSettlePosition(plan,620));
  });

  it('bounds duration and safely handles an already-settled frame',()=>{
    expect(createScrollSettle(0,1,0,0).duration).toBe(160.65);
    expect(createScrollSettle(0,60,0,0).duration).toBe(199);
    expect(createScrollSettle(0,10000,0,0).duration).toBe(240);
    const plan=createScrollSettle(660,660,1,0);
    expect(plan.tangent).toBe(0);
    expect(scrollSettlePosition(plan,100)).toBe(660);
  });
});
