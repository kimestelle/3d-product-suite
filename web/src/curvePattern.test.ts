import {describe,expect,it} from 'vitest';
import {CURVE_PRESETS} from './curvePresets';
import {frameBounds} from './frameGeometry';
import {createFrameMorph} from './frameMorph';
import {advancePatternProgress,compileCurvePattern,DEFAULT_CURVE_PATTERN,MAX_CURVE_PATTERN_LENGTH,readCurvePattern,reorderPattern} from './curvePattern';

const ids=['studio-cross','studio-circle','studio-landing'];
const nodes=(id:string)=>CURVE_PRESETS.find(preset=>preset.id===id)!.nodes;

describe('Curve pattern links',()=>{
  it('starts with a three-shape pattern and a duration per transition',()=>{
    expect(readCurvePattern('')).toEqual({ids:[...DEFAULT_CURVE_PATTERN],progress:0,duration:2400,loop:false});
  });
  it('migrates a pair link including aliases and its scrub position',()=>{
    expect(readCurvePattern('?a=symbols-chevron&b=studio-cross&t=.75')).toEqual({ids:['primitives-oval','studio-cross'],progress:.75,duration:2400,loop:false});
    expect(readCurvePattern('?a=unknown&b=studio-circle').ids).toEqual(['studio-cross','studio-circle']);
  });
  it('keeps order and repeats while discarding invalid entries',()=>{
    expect(readCurvePattern('?pattern=studio-circle,unknown,studio-cross,studio-circle&duration=1200&loop=1&t=.4')).toEqual({ids:['studio-circle','studio-cross','studio-circle'],progress:.4,duration:1200,loop:true});
  });
  it('accepts one shape and gives an explicit pattern priority over legacy keys',()=>{
    expect(readCurvePattern('?pattern=studio-circle&a=studio-cross&b=studio-landing').ids).toEqual(['studio-circle']);
  });
  it('recovers invalid patterns and bounds hostile numeric input',()=>{
    for(const pattern of ['',',unknown,'])expect(readCurvePattern(`?pattern=${pattern}`).ids).toEqual([...DEFAULT_CURVE_PATTERN]);
    for(const t of ['NaN','Infinity','-Infinity','oops'])expect(readCurvePattern(`?t=${t}&duration=NaN&loop=true`)).toMatchObject({progress:0,duration:2400,loop:false});
    expect(readCurvePattern('?t=-1').progress).toBe(0);
    expect(readCurvePattern('?t=2').progress).toBe(1);
    expect(readCurvePattern('?duration=4800').duration).toBe(4800);
  });
  it('bounds saved sequence size without removing repeated shapes',()=>{
    expect(readCurvePattern(`?pattern=${Array(100).fill('studio-circle').join(',')}`).ids).toHaveLength(MAX_CURVE_PATTERN_LENGTH);
  });
});

describe('Compiled curve pattern',()=>{
  it('reaches every exact shape on its boundary and stops on the final shape',()=>{
    const pattern=compileCurvePattern(ids,false);
    expect(pattern.legs).toBe(2);
    for(const [index,progress] of [0,.5,1].entries())expect(pattern.sample(progress).nodes).toEqual(nodes(ids[index]));
    expect(pattern.sample(.5)).toMatchObject({from:1,to:2,localProgress:0});
    expect(pattern.sample(1)).toMatchObject({from:1,to:2,localProgress:1});
  });
  it('contracts every leg to 70% of the interpolated dimensions at its midpoint',()=>{
    const pattern=compileCurvePattern(ids,false);
    for(let leg=0;leg<2;leg++){
      const raw=frameBounds(createFrameMorph(nodes(ids[leg]),nodes(ids[leg+1]))(.5));
      const middle=frameBounds(pattern.sample((leg+.5)/2).nodes);
      expect(middle.width).toBeCloseTo(raw.width*.7,7);
      expect(middle.height).toBeCloseTo(raw.height*.7,7);
      expect(middle.left+middle.width/2).toBeCloseTo(raw.left+raw.width/2,7);
      expect(middle.top+middle.height/2).toBeCloseTo(raw.top+raw.height/2,7);
    }
  });
  it('adds an actual last-to-first transition in a loop',()=>{
    const pattern=compileCurvePattern(ids,true);
    expect(pattern.legs).toBe(3);
    expect(pattern.sample(2/3).nodes).toEqual(nodes(ids[2]));
    expect(pattern.sample(5/6)).toMatchObject({from:2,to:0,localProgress:.5});
    expect(pattern.sample(1).nodes).toEqual(nodes(ids[0]));
    expect(pattern.sample(1).nodes).toEqual(pattern.sample(0).nodes);
  });
  it('settles at each shape and is reversible without a scale jump',()=>{
    const forward=compileCurvePattern(ids,false),backward=compileCurvePattern([...ids].reverse(),false);
    for(const t of [.1,.25,.4,.6,.75,.9]){
      const a=forward.sample(t).nodes,b=backward.sample(1-t).nodes;
      for(let i=0;i<64;i++)for(const key of ['point','in','out'] as const){
        expect(a[i][key].x).toBeCloseTo(b[i][key].x,7);
        expect(a[i][key].y).toBeCloseTo(b[i][key].y,7);
      }
    }
    // The shared renderer may redistribute anchors around an equivalent circle.
    // Its displayed extent, rather than its parameterization, must settle.
    const shape=frameBounds(forward.sample(.5).nodes),near=frameBounds(forward.sample(.5+1e-6).nodes);
    for(const key of ['left','top','right','bottom'] as const)expect(Math.abs(near[key]-shape[key])).toBeLessThan(1e-7);
  });
  it('holds a repeated shape instead of making it pulse',()=>{
    const pattern=compileCurvePattern(['studio-circle','studio-circle','studio-landing'],false);
    expect(pattern.sample(.25).nodes).toEqual(nodes('studio-circle'));
    for(const loop of [false,true]){
      const still=compileCurvePattern(['primitives-oval'],loop);
      expect(still.legs).toBe(0);
      for(const t of [0,.3,1])expect(still.sample(t)).toMatchObject({nodes:nodes('primitives-oval'),from:0,to:0,localProgress:0});
    }
  });
});

describe('Curve playback clock',()=>{
  it('preserves elapsed time when a frame crosses a leg boundary',()=>{
    expect(advancePatternProgress(.49,96,2400,2,1,false)).toEqual({progress:.51,done:false});
    expect(advancePatternProgress(.1,2400*3,2400,2,1,false)).toEqual({progress:1,done:true});
    expect(advancePatternProgress(.1,480,2400,2,-1,false)).toEqual({progress:0,done:true});
  });
  it('wraps through the closing transition forward and backward',()=>{
    expect(advancePatternProgress(.99,144,2400,3,1,true).progress).toBeCloseTo(.01,12);
    expect(advancePatternProgress(.01,144,2400,3,-1,true).progress).toBeCloseTo(.99,12);
    expect(advancePatternProgress(.2,2400*3*4,2400,3,1,true)).toMatchObject({done:false});
    expect(advancePatternProgress(.2,2400*3*4,2400,3,1,true).progress).toBeCloseTo(.2,12);
  });
  it('is independent of render frame rate',()=>{
    const run=(hz:number)=>{let t=.1;for(let i=0;i<hz;i++)t=advancePatternProgress(t,1000/hz,2400,3,1,true).progress;return t;};
    expect(run(30)).toBeCloseTo(run(60),12);expect(run(60)).toBeCloseTo(run(120),12);
  });
  it('does not advance for invalid or negative elapsed times',()=>{
    for(const elapsed of [-1,NaN,Infinity,-Infinity,0])expect(advancePatternProgress(.4,elapsed,2400,2,1,false)).toEqual({progress:.4,done:false});
    expect(advancePatternProgress(.4,20,2400,0,1,false)).toEqual({progress:.4,done:true});
    expect(advancePatternProgress(.4,20,2400,Infinity,1,false)).toEqual({progress:.4,done:true});
  });
});

describe('Pattern ordering',()=>{
  it('moves an occurrence while keeping duplicates and the original array intact',()=>{
    const pattern=['a','b','a','c'];
    expect(reorderPattern(pattern,0,3)).toEqual(['b','a','c','a']);
    expect(reorderPattern(pattern,3,0)).toEqual(['c','a','b','a']);
    expect(pattern).toEqual(['a','b','a','c']);
  });
  it('ignores invalid indices and stationary moves',()=>{
    for(const [from,to] of [[-1,1],[0,4],[1.5,2],[1,1],[NaN,0]])expect(reorderPattern(ids,from,to)).toEqual(ids);
  });
});
