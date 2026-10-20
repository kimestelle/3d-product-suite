import {describe,expect,it} from 'vitest';
import {createFrameMorph,createFrameTransition,frameTransitionScale,normalizeFrameShrink} from './frameMorph';
import {aboutFrameNodes,frameBounds,framePath,landingFrameNodes,loadingFrameNodes,roundedFrameNodes,transformFrameNodes,type FrameNodes} from './frameGeometry';
import {philosophySequenceNodes} from './philosophySequence';
import type {AperturePoint} from './landingMorph';

const origin={x:640,y:416,width:960,viewportWidth:1280,viewportHeight:832,aperture:0};
const cross=(aperture=0)=>landingFrameNodes({...origin,aperture});
const studio=()=>roundedFrameNodes({left:320,top:115,right:1240,bottom:800},
  {topLeft:28,topRight:40,bottomRight:24,bottomLeft:50});
const windows=()=>[aboutFrameNodes(1280,832),studio(),...Array.from({length:6},(_,i)=>philosophySequenceNodes(1280,832,i))];

describe('Window transition contraction',()=>{
  it('supports zero and half-size contraction while clamping saved invalid values',()=>{
    const a=windows()[0],b=studio(),raw=createFrameMorph(a,b)(.5);
    expect(frameBounds(createFrameTransition(a,b,0)(.5)).width).toBeCloseTo(frameBounds(raw).width,7);
    expect(frameBounds(createFrameTransition(a,b,.5)(.5)).width).toBeCloseTo(frameBounds(raw).width*.5,7);
    expect(normalizeFrameShrink(-1)).toBe(0);expect(normalizeFrameShrink(2)).toBe(.5);
    for(const invalid of [null,'30',NaN,Infinity])expect(normalizeFrameShrink(invalid)).toBe(.3);
    for(const shrink of [0,.08,.25,.5])for(const endpoint of [0,1])expect(frameTransitionScale(endpoint,shrink)).toBe(1);
  });
  it('contracts by 30% at the midpoint without moving the center or changing the endpoints',()=>{
    const a=roundedFrameNodes({left:100,top:100,right:700,bottom:500},40);
    const b=roundedFrameNodes({left:200,top:200,right:1000,bottom:600},80);
    const pure=createFrameMorph(a,b),travel=createFrameTransition(a,b),reverse=createFrameTransition(b,a);
    expect(travel(0)).toEqual(a);expect(travel(1)).toEqual(b);
    const raw=frameBounds(pure(.5)),middle=frameBounds(travel(.5));
    expect(middle.width).toBeCloseTo(raw.width*.7,7);
    expect(middle.height).toBeCloseTo(raw.height*.7,7);
    expect(middle.left+middle.width/2).toBeCloseTo(raw.left+raw.width/2,7);
    expect(middle.top+middle.height/2).toBeCloseTo(raw.top+raw.height/2,7);
    for(const t of [.1,.25,.5,.75,.9]) {
      const forward=travel(t),back=reverse(1-t);
      for(let i=0;i<64;i++)for(const key of ['point','in','out'] as const) {
        expect(forward[i][key].x).toBeCloseTo(back[i][key].x,7);
        expect(forward[i][key].y).toBeCloseTo(back[i][key].y,7);
      }
    }
    expect(createFrameTransition(travel(.4),a)(0)).toEqual(travel(.4));
  });
  it('leaves identical contours stationary and has no scale impulse at finished poses',()=>{
    const a=studio(),travel=createFrameTransition(a,structuredClone(a));
    for(const t of [0,.1,.5,.9,1])expect(travel(t)).toEqual(createFrameMorph(a,a)(t));
    expect(frameTransitionScale(0)).toBe(1);expect(frameTransitionScale(1)).toBe(1);
    expect((1-frameTransitionScale(.000001))/.000001).toBeLessThan(.00001);
    expect(frameTransitionScale(NaN)).toBe(1);expect(frameTransitionScale(Infinity)).toBe(1);
  });
});
type Point=AperturePoint;
function sample(nodes:FrameNodes,steps=3):Point[] {
  return nodes.flatMap((start,i)=>Array.from({length:steps},(_,j)=>{
    const end=nodes[(i+1)%nodes.length],t=j/steps,u=1-t;
    return {x:u*u*u*start.point.x+3*u*u*t*start.out.x+3*u*t*t*end.in.x+t*t*t*end.point.x,
      y:u*u*u*start.point.y+3*u*u*t*start.out.y+3*u*t*t*end.in.y+t*t*t*end.point.y};
  }));
}
const orientation=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function crosses(nodes:FrameNodes):boolean {
  const points=sample(nodes);
  for(let i=0;i<points.length;i++)for(let j=i+2;j<points.length;j++) {
    if(i===0&&j===points.length-1)continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if(orientation(a,b,c)*orientation(a,b,d)<-1e-7&&orientation(c,d,a)*orientation(c,d,b)<-1e-7)return true;
  }
  return false;
}
function localWindow(nodes:FrameNodes):Point[] {
  const center={x:(nodes[0].point.x+nodes[32].point.x)/2,y:(nodes[0].point.y+nodes[32].point.y)/2};
  const angle=-Math.atan2(nodes[0].point.y-nodes[32].point.y,nodes[0].point.x-nodes[32].point.x);
  const c=Math.cos(angle),s=Math.sin(angle);
  return nodes.map(({point:p})=>({x:(p.x-center.x)*c-(p.y-center.y)*s,y:(p.x-center.x)*s+(p.y-center.y)*c}));
}
function expectWindow(nodes:FrameNodes) {
  const points=localWindow(nodes);
  expect(points[0].y).toBeCloseTo(0,7);expect(points[16].x).toBeCloseTo(0,7);
  expect(points[32].y).toBeCloseTo(0,7);expect(points[48].x).toBeCloseTo(0,7);
  for(const start of [0,16,32,48])for(let i=start;i<=start+6;i++) {
    const axis=start%32===0?'x':'y';
    expect(points[i][axis]).toBeCloseTo(points[start][axis],7);
  }
  for(const start of [6,22,38,54]) {
    const a=points[start],b=points[start+4];
    const center=start===6||start===38?{x:b.x,y:a.y}:{x:a.x,y:b.y};
    const radius=Math.hypot(a.x-center.x,a.y-center.y);
    for(let i=start;i<=start+4;i++)expect(Math.hypot(points[i].x-center.x,points[i].y-center.y)).toBeCloseTo(radius,7);
  }
}
function expectCircle(nodes:FrameNodes) {
  const bounds=frameBounds(nodes),x=(bounds.left+bounds.right)/2,y=(bounds.top+bounds.bottom)/2;
  expect(bounds.width).toBeCloseTo(bounds.height,6);
  for(const p of sample(nodes,6))expect(Math.hypot(p.x-x,p.y-y)).toBeCloseTo(bounds.width/2,3);
}
function expectTangents(nodes:FrameNodes) {
  for(const node of nodes) {
    const ax=node.point.x-node.in.x,ay=node.point.y-node.in.y,bx=node.out.x-node.point.x,by=node.out.y-node.point.y;
    const scale=Math.hypot(ax,ay)*Math.hypot(bx,by);
    if(scale<1e-9)continue;
    expect(Math.abs(ax*by-ay*bx)/scale).toBeLessThan(1e-7);
    expect((ax*bx+ay*by)/scale).toBeGreaterThan(1-1e-7);
  }
}

describe('Shared semantic window morph',()=>{
  it('preserves exact endpoint snapshots, finite 64-node output and caller input',()=>{
    for(const from of [cross(),cross(.7),...windows()]) {
      const to=studio(),original=structuredClone(from),morph=createFrameMorph(from,to);
      expect(morph(0)).toEqual(from);expect(morph(1)).toEqual(to);
      expect(morph(-Infinity)).toEqual(from);expect(morph(NaN)).toEqual(from);expect(morph(Infinity)).toEqual(to);
      expect(morph(0)).not.toBe(from);
      for(const t of [.01,.25,.5,.75,.99]) {
        expect(morph(t)).toHaveLength(64);expect(framePath(morph(t))).not.toMatch(/NaN|Infinity/);
      }
      expect(from).toEqual(original);
    }
  });
  it('keeps every About, studio and philosophy pairing a true rounded window through the middle',()=>{
    const frames=windows();
    for(const from of frames)for(const to of frames) {
      const morph=createFrameMorph(from,to);
      for(const t of [.2,.5,.8]){expectWindow(morph(t));expectTangents(morph(t));}
    }
  });
  it('does not take an unrelated circle detour for windows or erase their unequal corner radii',()=>{
    const a=roundedFrameNodes({left:100,top:100,right:700,bottom:500},
      {topLeft:20,topRight:100,bottomRight:160,bottomLeft:40});
    const b=roundedFrameNodes({left:200,top:200,right:1000,bottom:600},
      {topLeft:80,topRight:120,bottomRight:180,bottomLeft:60});
    const middle=createFrameMorph(a,b)(.5),bounds=frameBounds(middle),p=localWindow(middle);
    expect(bounds.width).toBeCloseTo(700,7);expect(bounds.height).toBeCloseTo(400,7);
    expect(p[0].x-p[10].x).toBeCloseTo(170,7);
    expect(p[48].y-p[38].y).toBeCloseTo(-50,7);
    expectWindow(middle);
  });
  it('recognizes the fully expanded landing rectangle despite its different radial corner sampling',()=>{
    const expanded=cross(1);
    for(const target of windows()) {
      const morph=createFrameMorph(expanded,target),reverse=createFrameMorph(target,expanded);
      expect(morph(0)).toEqual(expanded);expect(reverse(1)).toEqual(expanded);
      for(const t of [.1,.5,.9]){expectWindow(morph(t));expectTangents(morph(t));expectWindow(reverse(t));}
    }
  });
  it('uses the shortest rotation while retaining the shape at interruptions',()=>{
    const rect=roundedFrameNodes({left:-300,top:-150,right:300,bottom:150},70);
    const a=transformFrameNodes(rect,{rotation:170,translateX:600,translateY:400});
    const b=transformFrameNodes(rect,{rotation:-170,translateX:640,translateY:420});
    const middle=createFrameMorph(a,b)(.5);
    const angle=Math.atan2(middle[0].point.y-middle[32].point.y,middle[0].point.x-middle[32].point.x);
    expect(Math.abs(angle)).toBeCloseTo(Math.PI,7);
    const next=createFrameMorph(middle,studio());
    expect(next(0)).toEqual(middle);expectWindow(next(.001));expectWindow(next(.5));expect(next(1)).toEqual(studio());
  });
  it('keeps rotated window midpoints inside the union of the actual endpoint silhouettes',()=>{
    for(const [width,height] of [[1280,832],[1440,540],[1600,1100]]) {
      const frames=[aboutFrameNodes(width,height),
        roundedFrameNodes({left:320,top:115,right:width-40,bottom:height-32},32),
        ...Array.from({length:6},(_,i)=>philosophySequenceNodes(width,height,i))];
      for(let i=0;i<frames.length;i++)for(let j=i+1;j<frames.length;j++) {
        const a=frameBounds(frames[i]),b=frameBounds(frames[j]),morph=createFrameMorph(frames[i],frames[j]);
        for(let step=1;step<30;step++) {
          const current=morph(step/30),bounds=frameBounds(current);
          expect(bounds.left,`${width}×${height}, ${i}→${j}, ${step}: left`).toBeGreaterThanOrEqual(Math.min(a.left,b.left)-.001);
          expect(bounds.top,`${width}×${height}, ${i}→${j}, ${step}: top`).toBeGreaterThanOrEqual(Math.min(a.top,b.top)-.001);
          expect(bounds.right,`${width}×${height}, ${i}→${j}, ${step}: right`).toBeLessThanOrEqual(Math.max(a.right,b.right)+.001);
          expect(bounds.bottom,`${width}×${height}, ${i}→${j}, ${step}: bottom`).toBeLessThanOrEqual(Math.max(a.bottom,b.bottom)+.001);
        }
      }
    }
  });
  it('shrinks a rotated midpoint uniformly only when its extent cannot fit by translation',()=>{
    const rect=roundedFrameNodes({left:-300,top:-120,right:300,bottom:120},20);
    const a=transformFrameNodes(rect,{rotation:-45,translateX:600,translateY:400});
    const b=transformFrameNodes(rect,{rotation:45,translateX:600,translateY:400});
    const middle=createFrameMorph(a,b)(.5),p=localWindow(middle);
    expect(p[0].x*2).toBeLessThan(600);
    expect(p[0].x/p[16].y).toBeCloseTo(600/240,7);
    expect((p[0].x-p[10].x)/(p[16].y*2)).toBeCloseTo(20/240,7);
    expectWindow(middle);expectTangents(middle);
  });
});

describe('Cross-specific circle handoff',()=>{
  it.each([0,.1,.25,.4])('unfolds a cross or partial hover at %s through a circle before each window',aperture=>{
    for(const target of windows()) {
      const morph=createFrameMorph(cross(aperture),target);
      expectCircle(morph(.5));expectTangents(morph(.25));expectWindow(morph(.75));
      expect(morph(0)).toEqual(cross(aperture));expect(morph(1)).toEqual(target);
    }
  });
  it('reverses the same circle handoff without folding or switching the endpoint',()=>{
    const from=cross(),to=philosophySequenceNodes(1280,832,5);
    const forward=createFrameMorph(from,to),reverse=createFrameMorph(to,from);
    for(const t of [.1,.3,.5,.7,.9]) {
      const a=frameBounds(forward(t)),b=frameBounds(reverse(1-t));
      expect(a.left).toBeCloseTo(b.left,3);expect(a.top).toBeCloseTo(b.top,3);
      expect(a.width).toBeCloseTo(b.width,3);expect(a.height).toBeCloseTo(b.height,3);
      expect(crosses(forward(t))).toBe(false);expect(crosses(reverse(t))).toBe(false);
    }
  });
  it('restarts from the current cross stage or current window stage without a geometric jump',()=>{
    const trip=createFrameMorph(cross(),studio());
    for(const t of [.15,.35,.5,.65,.85]) {
      const current=trip(t),next=createFrameMorph(current,aboutFrameNodes(1280,832));
      expect(next(0)).toEqual(current);
      expect(crosses(next(.01))).toBe(false);expect(crosses(next(.5))).toBe(false);
      if(t<.5)expectCircle(next(.5));else expectWindow(next(.5));
    }
  });
  it('preserves the actual loading circle and subsequent studio destination',()=>{
    const loading=loadingFrameNodes({x:640,y:416});
    const contract=createFrameMorph(cross(),loading);
    expectCircle(contract(.5));expectCircle(contract(.75));expect(contract(1)).toEqual(loading);
    const expand=createFrameMorph(loading,studio());expectWindow(expand(.5));expect(expand(1)).toEqual(studio());
  });
});

describe('Freeform fallback and geometry limits',()=>{
  it('keeps shared tangents in non-window hover states with unequal incoming/outgoing handle lengths',()=>{
    const a=cross(.68),b=philosophySequenceNodes(1280,832,4),morph=createFrameMorph(a,b);
    for(const t of [.01,.2,.5,.8,.99]){expectTangents(morph(t));expect(crosses(morph(t))).toBe(false);}
    expect(morph(0)).toEqual(a);expect(morph(1)).toEqual(b);
  });
  it('does not force a generic freeform contour to become a circle',()=>{
    const a=transformFrameNodes(loadingFrameNodes({x:0,y:0},200),{scaleX:2,scaleY:1,translateX:600,translateY:400});
    const b=transformFrameNodes(loadingFrameNodes({x:0,y:0},200),{scaleX:3,scaleY:1,translateX:600,translateY:400});
    const mid=createFrameMorph(a,b)(.5),bounds=frameBounds(mid);
    expect(bounds.width/bounds.height).toBeGreaterThan(2);expectTangents(mid);
  });
  it('keeps zero-size geometry finite and rejects malformed input before animation',()=>{
    const zero=roundedFrameNodes({left:0,top:0,right:0,bottom:0});
    for(const from of [zero,studio()])for(const to of [zero,studio()]) {
      const morph=createFrameMorph(from,to);
      for(const t of [0,.2,.5,.8,1])expect(framePath(morph(t))).not.toMatch(/NaN|Infinity/);
    }
    expect(()=>createFrameMorph([],studio())).toThrow(/64 finite/);
    const bad=studio();bad[5].out.x=NaN;expect(()=>createFrameMorph(bad,studio())).toThrow(/finite/);
  });
  it('does not cross itself across real route shapes and interrupted hover shapes',()=>{
    const shapes=[cross(),cross(.2),cross(.68),...windows(),loadingFrameNodes({x:640,y:416})];
    for(let i=0;i<shapes.length;i++)for(let j=i+1;j<shapes.length;j++) {
      const morph=createFrameMorph(shapes[i],shapes[j]);
      for(const t of [.2,.5,.8])expect(crosses(morph(t)),`pair ${i}/${j} at ${t}`).toBe(false);
    }
  });
});
