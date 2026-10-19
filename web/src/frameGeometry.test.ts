import {describe,expect,it} from 'vitest';
import {aboutPanelNodes} from './aboutTransition';
import {landingMorphNodes,type ApertureNode,type AperturePoint} from './landingMorph';
import {philosophyGeometry} from './philosophyFlow';
import {aboutFrameNodes,frameBounds,framePath,interpolateFrameNodes,landingFrameNodes,loadingFrameNodes,
  philosophyFrameNodes,roundedFrameNodes,transformFrameNodes} from './frameGeometry';

const origin={x:640,y:420,width:960,viewportWidth:1280,viewportHeight:832,aperture:0};
const keys=['point','in','out'] as const;
const near=(actual:AperturePoint,expected:AperturePoint,digits=7)=>{
  expect(actual.x).toBeCloseTo(expected.x,digits);expect(actual.y).toBeCloseTo(expected.y,digits);
};
function sample(nodes:ApertureNode[],steps=4):AperturePoint[] {
  return nodes.flatMap((start,i)=>Array.from({length:steps},(_,j)=>{
    const end=nodes[(i+1)%nodes.length],t=j/steps,u=1-t;
    return {x:u**3*start.point.x+3*u*u*t*start.out.x+3*u*t*t*end.in.x+t**3*end.point.x,
      y:u**3*start.point.y+3*u*u*t*start.out.y+3*u*t*t*end.in.y+t**3*end.point.y};
  }));
}
const cross=(a:AperturePoint,b:AperturePoint,c:AperturePoint)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function hasCrossing(points:AperturePoint[]):boolean {
  for(let i=0;i<points.length;i++)for(let j=i+2;j<points.length;j++) {
    if(i===0&&j===points.length-1)continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if(cross(a,b,c)*cross(a,b,d)<-1e-6&&cross(c,d,a)*cross(c,d,b)<-1e-6)return true;
  }
  return false;
}
const editor=()=>roundedFrameNodes({left:330,top:100,right:950,bottom:800},{topLeft:28,topRight:28,bottomLeft:40,bottomRight:40});

describe('Shared page frame geometry',()=>{
  it.each([0,.23,.5,.79,1])('preserves every visible landing handle at hover progress %s',aperture=>{
    const local=landingMorphNodes(aperture),actual=landingFrameNodes({...origin,aperture});
    actual.forEach((node,i)=>keys.forEach(key=>near(node[key],{
      x:origin.x+(local[i][key].x-500)*.96,y:origin.y+(local[i][key].y-300)*.96,
    })));
  });
  it.each([[1280,832],[390,844]])('reuses the exact About endpoint at %s × %s',(width,height)=>{
    expect(aboutFrameNodes(width,height)).toEqual(aboutPanelNodes(width,height));
  });
  it('keeps editor bounds and independently authored corner radii',()=>{
    const nodes=editor();
    expect(frameBounds(nodes)).toEqual({left:330,top:100,right:950,bottom:800,width:620,height:700});
    near(nodes[0].point,{x:950,y:450});near(nodes[16].point,{x:640,y:800});
    near(nodes[32].point,{x:330,y:450});near(nodes[48].point,{x:640,y:100});
    for(const [first,cx,cy,r] of [[6,910,760,40],[22,370,760,40],[38,358,128,28],[54,922,128,28]])
      for(let i=first;i<=first+4;i++)expect(Math.hypot(nodes[i].point.x-cx,nodes[i].point.y-cy)).toBeCloseTo(r,7);
  });
  it.each([0,.25,.5,.75,1])('matches the existing rotated philosophy perimeter at %s',amount=>{
    const g=philosophyGeometry(1280,832,amount),nodes=philosophyFrameNodes(1280,832,amount);
    const a=-g.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
    for(const p of sample(nodes,8)) {
      const dx=p.x-g.x,dy=p.y-g.y,x=dx*c-dy*s,y=dx*s+dy*c;
      const cornerX=Math.max(0,Math.abs(x)-(g.width/2-g.radius));
      const cornerY=Math.max(0,Math.abs(y)-(g.height/2-g.radius));
      // Four cubics per quarter arc keep the actual CSS perimeter within 0.001px.
      expect(Math.abs(Math.hypot(cornerX,cornerY)-g.radius)).toBeLessThan(.001);
    }
  });
  it('retains the loading circle size and angular correspondence with landing',()=>{
    const nodes=loadingFrameNodes({x:640,y:420});
    expect(frameBounds(nodes)).toEqual({left:594,top:374,right:686,bottom:466,width:92,height:92});
    near(nodes[0].point,{x:686,y:420});near(nodes[16].point,{x:640,y:466});
    near(nodes[32].point,{x:594,y:420});near(nodes[48].point,{x:640,y:374});
    for(const p of sample(nodes,8))expect(Math.abs(Math.hypot(p.x-640,p.y-420)-46)).toBeLessThan(.000001);
  });
  it('uses identical path structure for every route and loading state',()=>{
    for(const nodes of [landingFrameNodes(origin),aboutFrameNodes(1280,832),philosophyFrameNodes(1280,832,.3),editor(),loadingFrameNodes({x:400,y:300})]) {
      expect(nodes).toHaveLength(64);expect(framePath(nodes).match(/ C /g)).toHaveLength(64);
      expect(framePath(nodes).startsWith('M ')).toBe(true);expect(framePath(nodes).endsWith(' Z')).toBe(true);
      expect(framePath(nodes)).not.toMatch(/NaN|Infinity/);
    }
  });
  it('keeps viewport factories finite for missing or degenerate measurements',()=>{
    for(const nodes of [
      landingFrameNodes({...origin,x:NaN,y:Infinity,width:NaN,aperture:NaN}),aboutFrameNodes(NaN,Infinity),
      philosophyFrameNodes(-100,Infinity,NaN),loadingFrameNodes({x:NaN,y:Infinity},Infinity),
      roundedFrameNodes({left:NaN,right:Infinity,top:30,bottom:-40},{topLeft:Infinity,topRight:-20}),
    ])nodes.forEach(node=>keys.forEach(key=>expect(Number.isFinite(node[key].x)&&Number.isFinite(node[key].y)).toBe(true)));
  });
});

describe('Interruptible shared interpolation',()=>{
  it('clamps progress, keeps exact endpoints, and never aliases caller-owned nodes',()=>{
    const from=landingFrameNodes(origin),to=editor(),copy=structuredClone(from);
    expect(interpolateFrameNodes(from,to,-1)).toEqual(from);
    expect(interpolateFrameNodes(from,to,NaN)).toEqual(from);
    expect(interpolateFrameNodes(from,to,2)).toEqual(to);
    const result=interpolateFrameNodes(from,to,0);result[0].point.x+=100;
    expect(from).toEqual(copy);
  });
  it('can reverse from any current contour without a positional jump',()=>{
    const a=landingFrameNodes(origin),b=philosophyFrameNodes(1280,832,.7);
    for(const p of [0,.17,.5,.93,1]) {
      const current=interpolateFrameNodes(a,b,p),reverse=interpolateFrameNodes(b,a,1-p);
      current.forEach((node,i)=>keys.forEach(key=>near(node[key],reverse[i][key])));
      expect(interpolateFrameNodes(current,a,0)).toEqual(current);
    }
  });
  it('preserves perimeter ordering across every route pair, including a rotated frame',()=>{
    const routes=[landingFrameNodes(origin),landingFrameNodes({...origin,aperture:1}),aboutFrameNodes(1280,832),
      philosophyFrameNodes(1280,832,0),philosophyFrameNodes(1280,832,1),editor(),loadingFrameNodes({x:640,y:420})];
    for(let a=0;a<routes.length;a++)for(let b=a+1;b<routes.length;b++)for(const p of [.2,.5,.8]) {
      expect(hasCrossing(sample(interpolateFrameNodes(routes[a],routes[b],p)))).toBe(false);
    }
  });
  it('rejects malformed or non-finite geometry before it reaches SVG',()=>{
    expect(()=>framePath([])).toThrow(/64 finite/);
    const nodes=editor();nodes[20].out.x=NaN;
    expect(()=>interpolateFrameNodes(nodes,editor(),.5)).toThrow(/finite/);
    expect(()=>frameBounds(nodes)).toThrow(/finite/);
  });
});

describe('Frame projection and bounds',()=>{
  it('applies scale, rotation, and translation in declared order without modifying the source',()=>{
    const nodes=loadingFrameNodes({x:0,y:0},10),before=structuredClone(nodes);
    const moved=transformFrameNodes(nodes,{scaleX:2,scaleY:3,rotation:90,translateX:100,translateY:200});
    near(moved[0].point,{x:100,y:220});near(moved[16].point,{x:70,y:200});
    expect(nodes).toEqual(before);
  });
  it('finds extrema inside cubics instead of using their control handles as bounds',()=>{
    const nodes=roundedFrameNodes({left:0,top:0,right:100,bottom:100});
    nodes[0].out.x=200;nodes[1].in.x=200;
    const box=frameBounds(nodes);
    expect(box.right).toBeCloseTo(175,8);expect(box.right).toBeLessThan(200);
    for(const p of sample(nodes,30)) {
      expect(p.x).toBeGreaterThanOrEqual(box.left-1e-7);expect(p.x).toBeLessThanOrEqual(box.right+1e-7);
      expect(p.y).toBeGreaterThanOrEqual(box.top-1e-7);expect(p.y).toBeLessThanOrEqual(box.bottom+1e-7);
    }
  });
});
