import {describe,expect,it} from 'vitest';
import {philosophyScrollProgress} from './philosophyMotion';

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
