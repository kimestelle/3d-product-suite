import {describe,expect,it} from 'vitest';
import {createFrameMorph} from './frameMorph';
import {aboutFrameNodes,frameBounds,roundedFrameNodes,type FrameNodes} from './frameGeometry';
import {philosophySequenceNodes} from './philosophySequence';

const sizes=[[1000,740],[1280,832],[1440,540],[1600,1100],[2560,900]] as const;
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const center=(nodes:FrameNodes)=>({
  x:(nodes[0].point.x+nodes[32].point.x)/2,
  y:(nodes[0].point.y+nodes[32].point.y)/2,
});
const dimensions=(nodes:FrameNodes)=>({
  width:Math.hypot(nodes[0].point.x-nodes[32].point.x,nodes[0].point.y-nodes[32].point.y),
  height:Math.hypot(nodes[16].point.x-nodes[48].point.x,nodes[16].point.y-nodes[48].point.y),
});

function withinEndpoints(nodes:FrameNodes,from:FrameNodes,to:FrameNodes) {
  const actual=frameBounds(nodes),a=frameBounds(from),b=frameBounds(to);
  expect(actual.left).toBeGreaterThanOrEqual(Math.min(a.left,b.left)-.001);
  expect(actual.top).toBeGreaterThanOrEqual(Math.min(a.top,b.top)-.001);
  expect(actual.right).toBeLessThanOrEqual(Math.max(a.right,b.right)+.001);
  expect(actual.bottom).toBeLessThanOrEqual(Math.max(a.bottom,b.bottom)+.001);
}

function expectStraightCenter(from:FrameNodes,to:FrameNodes) {
  const morph=createFrameMorph(from,to),a=center(from),b=center(to);
  let prior=a;
  for(let step=0;step<=500;step++) {
    const t=step/500,nodes=morph(t),position=center(nodes);
    expect(position.x).toBeCloseTo(mix(a.x,b.x,t),7);
    expect(position.y).toBeCloseTo(mix(a.y,b.y,t),7);
    // Every step advances toward the destination; the edge constraint cannot
    // hold, reverse, then release either component of the route's trajectory.
    if(step)for(const axis of ['x','y'] as const) {
      expect((position[axis]-prior[axis])*Math.sign(b[axis]-a[axis])).toBeGreaterThanOrEqual(-1e-8);
    }
    withinEndpoints(nodes,from,to);
    prior=position;
  }
}

describe('Prepared frame clearance',()=>{
  it.each(sizes)('keeps About ↔ cover on a direct path inside the endpoint envelope at %s × %s',(width,height)=>{
    const about=aboutFrameNodes(width,height),cover=philosophySequenceNodes(width,height,0);
    expectStraightCenter(about,cover);
    expectStraightCenter(cover,about);
  });

  it.each(sizes)('changes size continuously without an edge-release speed jump at %s × %s',(width,height)=>{
    const morph=createFrameMorph(aboutFrameNodes(width,height),philosophySequenceNodes(width,height,0));
    const samples=Array.from({length:501},(_,index)=>dimensions(morph(index/500)));
    // A 0.2% progress step should not contain a new velocity branch. Testing
    // semantic dimensions avoids depending on each endpoint's anchor spacing.
    const limit=Math.max(width,height)*.00002;
    for(let index=1;index<500;index++)for(const axis of ['width','height'] as const) {
      const acceleration=samples[index+1][axis]-2*samples[index][axis]+samples[index-1][axis];
      expect(Math.abs(acceleration),`${axis}, sample ${index}`).toBeLessThan(limit);
    }
  });

  it('preserves exact authored endpoints and retraces the same contour in reverse',()=>{
    for(const [width,height] of sizes) {
      const about=aboutFrameNodes(width,height),cover=philosophySequenceNodes(width,height,0);
      const forward=createFrameMorph(about,cover),reverse=createFrameMorph(cover,about);
      expect(forward(0)).toEqual(about);expect(forward(1)).toEqual(cover);
      expect(reverse(0)).toEqual(cover);expect(reverse(1)).toEqual(about);
      for(const t of [.00001,.01,.13,.37,.5,.79,.99,.99999]) {
        const a=forward(t),b=reverse(1-t);
        for(let index=0;index<a.length;index++)for(const key of ['point','in','out'] as const) {
          expect(a[index][key].x).toBeCloseTo(b[index][key].x,6);
          expect(a[index][key].y).toBeCloseTo(b[index][key].y,6);
        }
      }
    }
  });

  it('leaves unrotated size interpolation untouched when clearance is already sufficient',()=>{
    const a=roundedFrameNodes({left:40,top:81,right:1240,bottom:832},
      {topLeft:40,topRight:40,bottomLeft:0,bottomRight:0});
    const b=roundedFrameNodes({left:420,top:220,right:1100,bottom:640},40);
    const from=dimensions(a),to=dimensions(b),morph=createFrameMorph(a,b);
    for(const t of [.00001,.05,.2,.5,.8,.95,.99999]) {
      const current=dimensions(morph(t));
      expect(current.width).toBeCloseTo(mix(from.width,to.width,t),7);
      expect(current.height).toBeCloseTo(mix(from.height,to.height,t),7);
    }
  });

  it('retargets from the displayed window without a jump or another edge slide',()=>{
    const about=aboutFrameNodes(1280,832),cover=philosophySequenceNodes(1280,832,0);
    const initial=createFrameMorph(about,cover);
    for(const t of [.1,.45,.7,.9]) {
      const displayed=initial(t),next=createFrameMorph(displayed,about);
      expect(next(0)).toEqual(displayed);expect(next(1)).toEqual(about);
      expectStraightCenter(displayed,about);
    }
  });
});
