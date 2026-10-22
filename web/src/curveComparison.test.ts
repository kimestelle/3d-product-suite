import {describe,expect,it} from 'vitest';
import {compileCurveComparison,type ComparisonMethod} from './curveComparison';
import {CURVE_PRESETS} from './curvePresets';
import {createFrameTransition} from './frameMorph';
import {frameBounds,type FrameNodes} from './frameGeometry';

const methods:ComparisonMethod[]=['current','sdf','radial'];
const keys=['point','in','out'] as const;
const preset=(id:string)=>CURVE_PRESETS.find(preset=>preset.id===id)!.nodes;
const pairs=[['studio-landing','symbols-star'],['symbols-star','symbols-plus']] as const;
type Point={x:number;y:number};
function samples(nodes:FrameNodes):Point[] {
  return nodes.flatMap((node,i)=>Array.from({length:5},(_,j)=>{
    const next=nodes[(i+1)%nodes.length],t=j/5,u=1-t;
    return {x:u**3*node.point.x+3*u*u*t*node.out.x+3*u*t*t*next.in.x+t**3*next.point.x,
      y:u**3*node.point.y+3*u*u*t*node.out.y+3*u*t*t*next.in.y+t**3*next.point.y};
  }));
}
function crosses(nodes:FrameNodes):boolean {
  const points=samples(nodes),side=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for(let i=0;i<points.length;i++)for(let j=i+2;j<points.length;j++) {
    if(i===0&&j===points.length-1)continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if(side(a,b,c)*side(a,b,d)<-1e-7&&side(c,d,a)*side(c,d,b)<-1e-7)return true;
  }
  return false;
}
function maxDifference(a:FrameNodes,b:FrameNodes):number {
  return Math.max(...a.flatMap((node,i)=>keys.map(key=>Math.hypot(node[key].x-b[i][key].x,node[key].y-b[i][key].y))));
}

describe.each(pairs)('Curve comparison %s → %s',(source,target)=>{
  const a=preset(source),b=preset(target),compiled=compileCurveComparison(a,b);
  it('keeps the production baseline and exact endpoint contours',()=>{
    const originalA=structuredClone(a),originalB=structuredClone(b),current=createFrameTransition(a,b);
    for(const method of methods) {
      expect(compiled.sample(0,method)).toEqual(a);expect(compiled.sample(1,method)).toEqual(b);
      expect(maxDifference(compiled.sample(1e-7,method),a)).toBeLessThan(.002);
      expect(maxDifference(compiled.sample(1-1e-7,method),b)).toBeLessThan(.002);
    }
    for(const t of [.01,.125,.25,.5,.625,.75,.99])expect(compiled.sample(t,'current')).toEqual(current(t));
    expect(a).toEqual(originalA);expect(b).toEqual(originalB);
    expect(compiled.diagnostics.checkpoints).toBe(33);
  });
  it('returns one finite, non-crossing symmetric 64-anchor contour',()=>{
    for(const method of methods)for(const t of [.01,.05,.125,.25,.375,.5,.625,.75,.875,.95,.99]) {
      const nodes=compiled.sample(t,method);
      expect(nodes).toHaveLength(64);expect(crosses(nodes),`${method} ${t}`).toBe(false);
      for(let i=0;i<64;i++)for(const key of keys) {
        expect(Number.isFinite(nodes[i][key].x)&&Number.isFinite(nodes[i][key].y)).toBe(true);
        expect(nodes[i][key].x+nodes[(i+32)%64][key].x).toBeCloseTo(1000,5);
        expect(nodes[i][key].y+nodes[(i+32)%64][key].y).toBeCloseTo(600,5);
      }
    }
  });
  it('reverses the path without changing its geometry and applies 30% shrink independently',()=>{
    const reverse=compileCurveComparison(b,a);
    for(const method of methods) {
      for(const t of [.01,.125,.25,.5,.7,.875,.99])expect(maxDifference(compiled.sample(t,method),reverse.sample(1-t,method))).toBeLessThan(1e-6);
      const raw=frameBounds(compiled.sampleUnscaled(.5,method)),shrunk=frameBounds(compiled.sample(.5,method));
      expect(shrunk.width).toBeCloseTo(raw.width*.7,6);expect(shrunk.height).toBeCloseTo(raw.height*.7,6);
    }
  });
  it('passes checkpoints with continuous velocity instead of stopping at them',()=>{
    const epsilon=1e-6;
    for(const method of ['sdf','radial'] as const)for(const checkpoint of [1,4,8,16,24,28,31]) {
      const t=checkpoint/32,before=compiled.sampleUnscaled(t-epsilon,method),middle=compiled.sampleUnscaled(t,method),after=compiled.sampleUnscaled(t+epsilon,method);
      let speed=0,error=0;
      for(let i=0;i<64;i++)for(const key of keys)for(const axis of ['x','y'] as const) {
        const left=(middle[i][key][axis]-before[i][key][axis])/epsilon,right=(after[i][key][axis]-middle[i][key][axis])/epsilon;
        speed=Math.max(speed,Math.abs(left));error=Math.max(error,Math.abs(left-right));
      }
      expect(error).toBeLessThan(.2);expect(speed).toBeGreaterThan(1);
    }
  });
  it('makes two genuinely different experimental paths',()=>{
    expect(maxDifference(compiled.sample(.5,'current'),compiled.sample(.5,'radial'))).toBeGreaterThan(2);
    expect(maxDifference(compiled.sample(.5,'sdf'),compiled.sample(.5,'radial'))).toBeGreaterThan(2);
  });
});

it('rejects incompatible anchor layouts rather than silently replacing their geometry',()=>{
  expect(()=>compileCurveComparison(preset('windows-square'),preset('symbols-star'))).toThrow(/radial/);
});
