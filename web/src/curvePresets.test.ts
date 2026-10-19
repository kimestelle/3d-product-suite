import {describe,expect,it} from 'vitest';
import {CURVE_FAMILIES,CURVE_PRESETS,CURVE_VIEWBOX,CURVE_PRESET_ALIASES,roundedPolygonNodes} from './curvePresets';
import {createFrameMorph} from './frameMorph';
import {frameBounds,framePath,type FrameNodes} from './frameGeometry';

const keys=['point','in','out'] as const;
type Point={x:number;y:number};
const finite=(nodes:FrameNodes)=>nodes.length===64&&nodes.every(node=>
  keys.every(key=>Number.isFinite(node[key].x)&&Number.isFinite(node[key].y)));
const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function sample(nodes:FrameNodes):Point[] {
  return nodes.flatMap((node,index)=>{
    const next=nodes[(index+1)%nodes.length];
    return Array.from({length:4},(_,sample)=>{
      const t=sample/4,u=1-t;
      return {x:u**3*node.point.x+3*u*u*t*node.out.x+3*u*t*t*next.in.x+t**3*next.point.x,
        y:u**3*node.point.y+3*u*u*t*node.out.y+3*u*t*t*next.in.y+t**3*next.point.y};
    });
  });
}
function selfIntersects(nodes:FrameNodes):boolean {
  // Four samples per cubic catch folds between the shared anchors. This
  // checks catalog coverage; frameMorph tests also exercise curved joins.
  const points=sample(nodes);
  for(let i=0;i<points.length;i++)for(let j=i+2;j<points.length;j++) {
    if(i===0&&j===points.length-1)continue;
    const a=points[i],b=points[(i+1)%points.length],c=points[j],d=points[(j+1)%points.length];
    if(cross(a,b,c)*cross(a,b,d)<-1e-6&&cross(c,d,a)*cross(c,d,b)<-1e-6)return true;
  }
  return false;
}
function inside(nodes:FrameNodes):boolean {
  const b=frameBounds(nodes),{width,height,inset}=CURVE_VIEWBOX;
  return b.left>=inset-.001&&b.top>=inset-.001&&b.right<=width-inset+.001&&b.bottom<=height-inset+.001;
}

describe('Curve catalog',()=>{
  it('has 16 named, unique specimens with valid families',()=>{
    expect(CURVE_PRESETS).toHaveLength(16);
    expect(new Set(CURVE_PRESETS.map(p=>p.id)).size).toBe(16);
    expect(new Set(CURVE_PRESETS.map(p=>framePath(p.nodes))).size).toBe(16);
    expect(CURVE_FAMILIES).toHaveLength(4);
    for(const preset of CURVE_PRESETS)expect(CURVE_FAMILIES.some(family=>family.id===preset.family)).toBe(true);
    for(const preset of CURVE_PRESETS){
      expect(preset.name.length).toBeGreaterThan(0);
      expect(finite(preset.nodes),preset.id).toBe(true);
      expect(inside(preset.nodes),preset.id).toBe(true);
      for(const node of preset.nodes)for(const key of keys){
        expect(node[key].x,preset.id).toBeGreaterThanOrEqual(CURVE_VIEWBOX.inset);
        expect(node[key].x,preset.id).toBeLessThanOrEqual(CURVE_VIEWBOX.width-CURVE_VIEWBOX.inset);
        expect(node[key].y,preset.id).toBeGreaterThanOrEqual(CURVE_VIEWBOX.inset);
        expect(node[key].y,preset.id).toBeLessThanOrEqual(CURVE_VIEWBOX.height-CURVE_VIEWBOX.inset);
      }
    }
  });

  it('keeps normalized silhouettes visibly distinct, rather than counting moved windows as new shapes',()=>{
    const contains=(points:Point[],x:number,y:number)=>{
      let inside=false;
      for(let i=0,j=points.length-1;i<points.length;j=i++){
        const a=points[i],b=points[j];
        if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
      }
      return inside;
    };
    const silhouettes=CURVE_PRESETS.map(preset=>{
      const bounds=frameBounds(preset.nodes),scale=Math.max(bounds.width,bounds.height);
      const points=sample(preset.nodes).map(p=>({x:(p.x-(bounds.left+bounds.right)/2)/scale,
        y:(p.y-(bounds.top+bounds.bottom)/2)/scale}));
      return Array.from({length:64*64},(_,i)=>contains(points,(i%64+.5)/64-.5,(Math.floor(i/64)+.5)/64-.5));
    });
    for(let i=0;i<silhouettes.length;i++)for(let j=i+1;j<silhouettes.length;j++){
      let intersection=0,union=0;
      for(let pixel=0;pixel<64*64;pixel++){
        if(silhouettes[i][pixel]&&silhouettes[j][pixel])intersection++;
        if(silhouettes[i][pixel]||silhouettes[j][pixel])union++;
      }
      expect(intersection/union,`${CURVE_PRESETS[i].name} / ${CURVE_PRESETS[j].name}`).toBeLessThan(.97);
    }
  });

  it('resolves every retired link to a surviving specimen',()=>{
    expect(Object.keys(CURVE_PRESET_ALIASES)).toHaveLength(10);
    for(const [previous,next] of Object.entries(CURVE_PRESET_ALIASES)){
      expect(CURVE_PRESETS.some(p=>p.id===previous)).toBe(false);
      expect(CURVE_PRESETS.some(p=>p.id===next)).toBe(true);
    }
    for(const id of ['studio-cross','studio-circle','studio-landing','windows-square','poses-capsule','corners-arch','corners-single'])
      expect(CURVE_PRESETS.some(p=>p.id===id),id).toBe(true);
  });

  it('rounds polygon corners while preserving clockwise winding, straight planes and shared tangents',()=>{
    const vertices=[{x:500,y:70},{x:730,y:430},{x:270,y:430}];
    const nodes=roundedPolygonNodes(vertices),points=sample(nodes);
    const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-q.x*p.y;},0)/2;
    expect(area).toBeGreaterThan(0);expect(selfIntersects(nodes)).toBe(false);
    // Every authored edge survives as a plane between its small rounded corners.
    for(let i=0;i<vertices.length;i++){
      const a=vertices[i],b=vertices[(i+1)%vertices.length];
      expect(nodes.some((node,index)=>{
        const next=nodes[(index+1)%nodes.length];
        return Math.abs(cross(a,b,node.point))<1e-6&&Math.abs(cross(a,b,node.out))<1e-6&&
          Math.abs(cross(a,b,next.in))<1e-6&&Math.abs(cross(a,b,next.point))<1e-6;
      })).toBe(true);
    }
    for(const node of nodes){
      const incoming={x:node.point.x-node.in.x,y:node.point.y-node.in.y};
      const outgoing={x:node.out.x-node.point.x,y:node.out.y-node.point.y};
      expect(Math.abs(incoming.x*outgoing.y-incoming.y*outgoing.x)).toBeLessThan(1e-7);
      expect(incoming.x*outgoing.x+incoming.y*outgoing.y).toBeGreaterThan(0);
    }
    expect(()=>roundedPolygonNodes(vertices.slice().reverse())).toThrow(/clockwise/);
    expect(()=>roundedPolygonNodes(vertices,-1)).toThrow(/nonnegative/);
    expect(()=>roundedPolygonNodes([{x:NaN,y:0},...vertices])).toThrow(/finite/);
    expect(()=>roundedPolygonNodes(vertices,18,{x:900,y:0})).toThrow(/interior/);
  });

  it('keeps exact endpoints and inputs while every pair produces finite, bounded, uncrossed contours',()=>{
    const before=JSON.stringify(CURVE_PRESETS);
    for(let i=0;i<CURVE_PRESETS.length;i++)for(let j=0;j<CURVE_PRESETS.length;j++) {
      const a=CURVE_PRESETS[i],b=CURVE_PRESETS[j],morph=createFrameMorph(a.nodes,b.nodes);
      const pair=`${a.id} → ${b.id}`;
      expect(morph(0),pair).toEqual(a.nodes);expect(morph(1),pair).toEqual(b.nodes);
      for(let step=1;step<20;step++) {
        const progress=step/20;
        const nodes=morph(progress),label=`${pair} at ${progress}`;
        expect(finite(nodes),label).toBe(true);
        expect(inside(nodes),label).toBe(true);
        expect(selfIntersects(nodes),label).toBe(false);
      }
    }
    expect(JSON.stringify(CURVE_PRESETS)).toBe(before);
  },15000);
});
