import {describe,expect,it} from 'vitest';
import {aboutPanelBounds,aboutPanelNodes,aboutTransitionNodes,aboutTransitionPath} from './aboutTransition';
import {landingMorphNodes,type ApertureNode,type AperturePoint} from './landingMorph';

const origin={x:640,y:420,width:960,viewportWidth:1280,viewportHeight:832,aperture:0};
function sample(nodes:ApertureNode[]) {
  const points:AperturePoint[]=[];
  for(let i=0;i<nodes.length;i++) {
    const start=nodes[i],end=nodes[(i+1)%nodes.length];
    for(let part=0;part<8;part++) {
      const t=part/8,u=1-t;
      points.push({x:u**3*start.point.x+3*u**2*t*start.out.x+3*u*t**2*end.in.x+t**3*end.point.x,y:u**3*start.point.y+3*u**2*t*start.out.y+3*u*t**2*end.in.y+t**3*end.point.y});
    }
  }
  return points;
}
const cross=(a:AperturePoint,b:AperturePoint,c:AperturePoint)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function intersects(a:AperturePoint,b:AperturePoint,c:AperturePoint,d:AperturePoint) {
  return cross(a,b,c)*cross(a,b,d)<-1e-6&&cross(c,d,a)*cross(c,d,b)<-1e-6;
}

describe('Landing to About aperture',()=>{
  it.each([0,.23,.5,.78,1])('starts at the actual visible landing contour (%s)',aperture=>{
    const source=landingMorphNodes(aperture),nodes=aboutTransitionNodes({...origin,aperture},0);
    expect(nodes).toHaveLength(64);
    nodes.forEach((node,i)=>{for(const handle of ['point','in','out'] as const){expect(node[handle].x).toBeCloseTo(origin.x+(source[i][handle].x-500)*.96,8);expect(node[handle].y).toBeCloseTo(origin.y+(source[i][handle].y-300)*.96,8);}});
  });
  it('settles on the Figma panel with rounded top corners and square bottom corners',()=>{
    const nodes=aboutTransitionNodes(origin,1),box=aboutPanelBounds(1280,832);
    expect(box).toEqual({left:40,top:81,right:1240,bottom:832,radius:40});
    expect(nodes).toEqual(aboutPanelNodes(1280,832));
    expect(nodes[8].point).toEqual({x:1240,y:832});
    expect(nodes[24].point).toEqual({x:40,y:832});
    for(const p of sample(nodes)){expect(p.x).toBeGreaterThanOrEqual(40-1e-6);expect(p.x).toBeLessThanOrEqual(1240+1e-6);expect(p.y).toBeGreaterThanOrEqual(81-1e-6);expect(p.y).toBeLessThanOrEqual(832+1e-6);}
    for(const i of [38,39,40,41,42])expect(Math.hypot(nodes[i].point.x-80,nodes[i].point.y-121)).toBeCloseTo(40,8);
  });
  it('uses the matching mobile inset and radius',()=>{
    expect(aboutPanelBounds(390,844)).toEqual({left:16,top:80,right:374,bottom:844,radius:28});
  });
  it.each([0,.2,.5,.8,1])('keeps one finite closed contour without crossing at %s',progress=>{
    for(const aperture of [0,.5,1]) {
      const nodes=aboutTransitionNodes({...origin,aperture},progress),points=sample(nodes);
      expect(aboutTransitionPath({...origin,aperture},progress).match(/C/g)).toHaveLength(64);
      expect(aboutTransitionPath(origin,progress).endsWith(' Z')).toBe(true);
      nodes.forEach(node=>Object.values(node).forEach(p=>expect(Number.isFinite(p.x)&&Number.isFinite(p.y)).toBe(true)));
      let crossing=false;
      for(let i=0;i<points.length;i++)for(let j=i+2;j<points.length;j++) {
        if(i===0&&j===points.length-1)continue;
        crossing ||= intersects(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length]);
      }
      expect(crossing).toBe(false);
    }
  });
  it('clamps progress and can reproject the same curve into the live landing SVG',()=>{
    expect(aboutTransitionNodes(origin,-1)).toEqual(aboutTransitionNodes(origin,0));
    expect(aboutTransitionNodes(origin,2)).toEqual(aboutTransitionNodes(origin,1));
    expect(aboutTransitionNodes(origin,NaN)).toEqual(aboutTransitionNodes(origin,0));
    const absolute=aboutTransitionPath(origin,.6).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const local=aboutTransitionPath(origin,.6,'landing').match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    local.forEach((n,i)=>expect((n-(i%2?300:500))*.96+(i%2?origin.y:origin.x)).toBeCloseTo(absolute[i],2));
  });
});
