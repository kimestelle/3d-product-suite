import {APERTURE_NODE_COUNT,landingMorphNodes,type AperturePoint} from './landingMorph';
import {
  loadingFrameNodes,roundedFrameNodes,transformFrameNodes,type FrameNodes,type FrameRadii,
} from './frameGeometry';

export const CURVE_VIEWBOX = {width:1000,height:600,inset:48} as const;
export const CURVE_FAMILIES = [
  {id:'primitives',name:'primitives'},
  {id:'polygons',name:'polygons'},
  {id:'architectural',name:'architectural'},
  {id:'symbols',name:'symbols'},
] as const;
export type CurveFamily = typeof CURVE_FAMILIES[number]['id'];
export type CurvePreset = {id:string;name:string;family:CurveFamily;nodes:FrameNodes};

const center={x:500,y:300};
const corners=(topLeft:number,topRight:number,bottomRight:number,bottomLeft:number):FrameRadii=>
  ({topLeft,topRight,bottomRight,bottomLeft});
const window=(width:number,height:number,radii:number|Partial<FrameRadii>=24):FrameNodes=>
  roundedFrameNodes({left:500-width/2,top:300-height/2,right:500+width/2,bottom:300+height/2},radii);
const landing=(progress:number):FrameNodes=>
  transformFrameNodes(landingMorphNodes(progress),{scaleX:.9,origin:center});
const preset=(id:string,name:string,family:CurveFamily,nodes:FrameNodes):CurvePreset=>({id,name,family,nodes});
const mix=(a:AperturePoint,b:AperturePoint,t:number):AperturePoint=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
const cross=(a:AperturePoint,b:AperturePoint)=>a.x*b.y-a.y*b.x;
const dot=(a:AperturePoint,b:AperturePoint)=>a.x*b.x+a.y*b.y;
const distance=(a:AperturePoint,b:AperturePoint)=>Math.hypot(a.x-b.x,a.y-b.y);

/** Author a rounded polygon in the live renderer's clockwise 64-anchor format.
 * Vertices must be clockwise and star-shaped around origin. Each ray samples
 * the actual trimmed planes / quadratic corner, starting at the right ray.
 * Shared tangents keep corners smooth; short handles avoid overshoot where a
 * small fillet falls between samples. This only authors endpoints: all motion
 * remains createFrameMorph's responsibility.
 */
export function roundedPolygonNodes(vertices:readonly AperturePoint[],rounding=18,origin:AperturePoint=center):FrameNodes {
  if(vertices.length<3||!Number.isFinite(rounding)||rounding<0||
    !Number.isFinite(origin.x)||!Number.isFinite(origin.y)||
    vertices.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new Error('A polygon needs finite vertices and a nonnegative corner trim.');
  const local=vertices.map(p=>({x:p.x-origin.x,y:p.y-origin.y}));
  for(let i=0;i<local.length;i++){
    const a=local[i],b=local[(i+1)%local.length],edge={x:b.x-a.x,y:b.y-a.y};
    if(distance(a,b)<1e-6||cross(edge,{x:-a.x,y:-a.y})<=1e-6)
      throw new Error('Polygon vertices must wind clockwise around an interior origin.');
  }
  const bends=local.map((point,index)=>{
    const previous=local[(index+local.length-1)%local.length],next=local[(index+1)%local.length];
    const trim=Math.min(rounding,distance(point,previous)*.22,distance(point,next)*.22);
    return {start:mix(point,previous,trim/distance(point,previous)),control:point,
      end:mix(point,next,trim/distance(point,next))};
  });
  const edges=bends.flatMap((bend,index)=>{
    const next=bends[(index+1)%bends.length];
    return [bend,{start:bend.end,control:mix(bend.end,next.start,.5),end:next.start}];
  });
  const roots=(a:number,b:number,c:number):number[]=>{
    if(Math.abs(a)<1e-9)return Math.abs(b)<1e-9?[]:[-c/b];
    const determinant=b*b-4*a*c;
    if(determinant < -1e-8)return [];
    const root=Math.sqrt(Math.max(0,determinant));
    return [(-b-root)/(2*a),(-b+root)/(2*a)];
  };
  const angle=Math.PI*2/APERTURE_NODE_COUNT,handle=4/3*Math.tan(angle/4);
  const samples=Array.from({length:APERTURE_NODE_COUNT},(_,index)=>{
    const ray={x:Math.cos(index*angle),y:Math.sin(index*angle)};
    let hit:{point:AperturePoint;tangent:AperturePoint;radius:number}|undefined;
    for(const edge of edges){
      const a={x:edge.start.x-2*edge.control.x+edge.end.x,y:edge.start.y-2*edge.control.y+edge.end.y};
      const b={x:2*(edge.control.x-edge.start.x),y:2*(edge.control.y-edge.start.y)};
      for(const root of roots(cross(a,ray),cross(b,ray),cross(edge.start,ray))){
        if(root < -1e-8||root>1+1e-8)continue;
        const t=Math.max(0,Math.min(1,root));
        const point={x:a.x*t*t+b.x*t+edge.start.x,y:a.y*t*t+b.y*t+edge.start.y};
        const radius=dot(point,ray);
        if(radius<=0||hit&&radius<=hit.radius)continue;
        hit={point,tangent:{x:2*a.x*t+b.x,y:2*a.y*t+b.y},radius};
      }
    }
    if(!hit)throw new Error('Every polygon ray must intersect its boundary.');
    const perpendicular={x:-ray.y,y:ray.x};
    const derivativeLength=hit.radius*Math.hypot(hit.tangent.x,hit.tangent.y)/dot(hit.tangent,perpendicular);
    const tangentLength=Math.hypot(hit.tangent.x,hit.tangent.y);
    return {point:hit.point,tangent:{x:hit.tangent.x/tangentLength,y:hit.tangent.y/tangentLength},handle:derivativeLength*handle};
  });
  return samples.map((sample,index)=>{
    const previous=samples[(index+samples.length-1)%samples.length],next=samples[(index+1)%samples.length];
    const reach=Math.min(sample.handle,.30*Math.min(distance(sample.point,previous.point),distance(sample.point,next.point)));
    const point={x:sample.point.x+origin.x,y:sample.point.y+origin.y};
    return {point,in:{x:point.x-sample.tangent.x*reach,y:point.y-sample.tangent.y*reach},
      out:{x:point.x+sample.tangent.x*reach,y:point.y+sample.tangent.y*reach}};
  });
}
const polygon=(vertices:readonly (readonly [number,number])[],width:number,height:number,rounding=18):FrameNodes=>
  roundedPolygonNodes(vertices.map(([x,y])=>({x:500+x*width/2,y:300+y*height/2})),rounding);
const regular=(count:number,rotation=-Math.PI/2):FrameNodes=>
  polygon(Array.from({length:count},(_,index)=>[Math.cos(rotation+index*Math.PI*2/count),Math.sin(rotation+index*Math.PI*2/count)] as const),480,480);

/** Sixteen distinct silhouettes; 64 cubic anchors remain shared by every one.
 * Existing cross, circle and window endpoints keep their real constructors.
 */
export const CURVE_PRESETS:readonly CurvePreset[] = [
  preset('studio-circle','circle','primitives',landing(.5)),
  preset('windows-square','square','primitives',window(440,440)),
  preset('studio-landing','rectangle','primitives',landing(1)),
  preset('poses-capsule','capsule','primitives',window(680,260,130)),

  preset('polygons-triangle','triangle','polygons',regular(3)),
  preset('polygons-diamond','diamond','polygons',polygon([[1,0],[0,1],[-1,0],[0,-1]],480,480)),
  preset('polygons-pentagon','pentagon','polygons',regular(5)),
  preset('polygons-hexagon','hexagon','polygons',regular(6,0)),

  preset('architectural-trapezoid','trapezoid','architectural',polygon([[-.6,-1],[.6,-1],[1,1],[-1,1]],600,420)),
  preset('architectural-octagon','octagon','architectural',regular(8,Math.PI/8)),
  preset('corners-arch','arch','architectural',window(400,480,corners(200,200,20,20))),
  preset('corners-single','corner','architectural',window(500,460,corners(230,20,20,20))),

  preset('studio-cross','cross','symbols',landing(0)),
  preset('symbols-plus','plus','symbols',polygon([[.36,-1],[.36,-.36],[1,-.36],[1,.36],[.36,.36],[.36,1],[-.36,1],[-.36,.36],[-1,.36],[-1,-.36],[-.36,-.36],[-.36,-1]],480,480,20)),
  preset('symbols-star','star','symbols',polygon(Array.from({length:16},(_,index)=>{
    const angle=-Math.PI/2+index*Math.PI/8,radius=index%2?.5:1;
    return [Math.cos(angle)*radius,Math.sin(angle)*radius] as const;
  }),500,500,16)),
  preset('primitives-oval','oval','primitives',transformFrameNodes(loadingFrameNodes(center,220),{scaleX:1.5,scaleY:.85,origin:center})),
];

/** Retired specimen links retain their closest remaining silhouette. */
export const CURVE_PRESET_ALIASES:Readonly<Record<string,string>> = {
  'symbols-chevron':'primitives-oval',
  'studio-editor':'studio-landing',
  'windows-about':'studio-landing',
  'windows-portrait':'studio-landing',
  'windows-panorama':'studio-landing',
  'corners-bowl':'corners-arch',
  'corners-diagonal':'corners-single',
  'poses-vertical':'poses-capsule',
  'poses-cover':'studio-landing',
  'poses-interface':'corners-single',
};
