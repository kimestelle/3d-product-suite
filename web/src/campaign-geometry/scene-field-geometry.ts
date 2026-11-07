import {CURVE_PRESETS} from '../curvePresets';
import {framePath,type FrameNodes} from '../frameGeometry';
import {expansionGeometry} from './registered-expansion';

export type FieldShape='circle'|'square'|'diamond'|'hexagon';
export const FIELD_SHAPES:readonly {id:FieldShape;name:string;preset:string}[]=[
  {id:'circle',name:'Circle',preset:'studio-circle'},
  {id:'square',name:'Square',preset:'windows-square'},
  {id:'diamond',name:'Diamond',preset:'polygons-diamond'},
  {id:'hexagon',name:'Hexagon',preset:'polygons-hexagon'},
];
type Point={x:number;y:number};
export type FieldOptions={shape:FieldShape;cx:number;cy:number;progress:number;angle:number;distance?:number;farScale?:number;opticalOffset?:number};
export type ProjectedField={path:string;nearCenter:Point;farCenter:Point;nearPath:string;farPath:string};
type NativeSection={points:Point[];nodes:FrameNodes};
const NEAR_RADIUS=135,OPENING_RADIUS=92;
const cache=new Map<FieldShape,NativeSection>();
const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const midpoint=(a:Point,b:Point):Point=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const finite=(name:string,value:number)=>{
  if(!Number.isFinite(value))throw new RangeError(`Scene field: ${name} must be finite.`);
  return value;
};

/** Counterclockwise convex hull, with coincident and collinear samples removed. */
function hull(points:Point[]):Point[] {
  const sorted=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y).filter((p,i,list)=>!i||p.x!==list[i-1].x||p.y!==list[i-1].y);
  if(sorted.length<3)throw new RangeError('Scene field: a section needs at least three distinct boundary points.');
  const half=(list:Point[])=>{
    const result:Point[]=[];
    for(const p of list){while(result.length>1&&cross(result[result.length-2],result[result.length-1],p)<=0)result.pop();result.push(p);}
    result.pop();return result;
  };
  return [...half(sorted),...half(sorted.slice().reverse())];
}

/** De Casteljau subdivision: both controls lie within .01 source units of
 * each accepted chord. This retains native corner geometry, not a redraw. */
function sampleCubic(a:Point,b:Point,c:Point,d:Point,out:Point[],depth=0):void {
  const length=Math.hypot(d.x-a.x,d.y-a.y);
  const deviation=length?Math.max(Math.abs(cross(a,d,b)),Math.abs(cross(a,d,c)))/length:
    Math.max(Math.hypot(b.x-a.x,b.y-a.y),Math.hypot(c.x-a.x,c.y-a.y));
  if(deviation<=.01||depth===12){out.push(d);return;}
  const ab=midpoint(a,b),bc=midpoint(b,c),cd=midpoint(c,d),abc=midpoint(ab,bc),bcd=midpoint(bc,cd),middle=midpoint(abc,bcd);
  sampleCubic(a,ab,abc,middle,out,depth+1);sampleCubic(middle,bcd,cd,d,out,depth+1);
}

function nativeSection(shape:FieldShape):NativeSection {
  const existing=cache.get(shape);if(existing)return existing;
  const definition=FIELD_SHAPES.find(entry=>entry.id===shape)!;
  const preset=CURVE_PRESETS.find(entry=>entry.id===definition.preset);
  if(!preset)throw new Error(`Scene field: native preset ${definition.preset} is unavailable.`);
  const samples:Point[]=[preset.nodes[0].point];
  preset.nodes.forEach((node,i)=>{
    const next=preset.nodes[(i+1)%preset.nodes.length];
    sampleCubic(node.point,node.out,next.in,next.point,samples);
  });
  const local=hull(samples.map(p=>({x:p.x-500,y:p.y-300})));
  // Distance to each polygon support line is conservative for its convex
  // cubic source. Scaling by this inradius encloses the circular opening.
  let inradius=Infinity;
  for(let i=0;i<local.length;i++){
    const a=local[i],b=local[(i+1)%local.length];
    inradius=Math.min(inradius,(a.x*b.y-a.y*b.x)/Math.hypot(b.x-a.x,b.y-a.y));
  }
  if(!(inradius>0))throw new Error('Scene field: the native section must be convex around its registered center.');
  // The .001 guard also covers framePath's three-decimal serialization.
  const scale=(NEAR_RADIUS+.001)/inradius;
  const normalize=(p:Point)=>({x:(p.x-500)*scale,y:(p.y-300)*scale});
  const result={points:local.map(p=>({x:p.x*scale,y:p.y*scale})),
    nodes:preset.nodes.map(node=>({point:normalize(node.point),in:normalize(node.in),out:normalize(node.out)}))};
  cache.set(shape,result);return result;
}

const polygonPath=(points:Point[])=>`M ${points.map(p=>`${p.x} ${p.y}`).join(' L ')} Z`;
const circlePath=(center:Point,r:number)=>`M ${center.x+r} ${center.y} A ${r} ${r} 0 1 0 ${center.x-r} ${center.y} A ${r} ${r} 0 1 0 ${center.x+r} ${center.y} Z`;

/** A compact, centered section expands into the convex hull of two registered
 * homothetic sections. Polygon main paths use the same cached approximation
 * at progress zero and above, so there is no zero-progress geometry switch.
 * nearPath/farPath retain the source's actual cubic construction for guides. */
export function projectedField(options:FieldOptions):ProjectedField {
  if(!options||typeof options!=='object')throw new TypeError('Scene field requires an options object.');
  const {shape}=options;
  if(!FIELD_SHAPES.some(entry=>entry.id===shape))throw new RangeError('Scene field shape must be circle, square, diamond, or hexagon.');
  const cx=finite('cx',options.cx),cy=finite('cy',options.cy);
  const t=Math.max(0,Math.min(1,finite('progress',options.progress)));
  const angle=(finite('angle',options.angle)%360)*Math.PI/180,ux=Math.cos(angle),uy=Math.sin(angle);
  const distance=Math.max(0,finite('distance',options.distance??600))*t;
  const scale=1+(Math.max(1,finite('farScale',options.farScale??2.45))-1)*t;
  // Never let an optional optical shift remove the guaranteed r92 opening
  // from the near section, including zero-reach and containment cases.
  const offset=Math.max(0,Math.min(NEAR_RADIUS-OPENING_RADIUS,finite('opticalOffset',options.opticalOffset??12)))*t;
  const nearCenter={x:cx-offset*ux,y:cy-offset*uy};
  const farCenter={x:nearCenter.x+distance*ux,y:nearCenter.y+distance*uy};
  if(!Number.isFinite(scale)||[nearCenter,farCenter].some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new RangeError('Scene field coordinates overflow finite drawing units.');
  if(shape==='circle'){
    const farRadius=NEAR_RADIUS*scale;
    if(!Number.isFinite(farRadius)||[nearCenter.x+NEAR_RADIUS,nearCenter.x-NEAR_RADIUS,nearCenter.y+NEAR_RADIUS,nearCenter.y-NEAR_RADIUS,farCenter.x+farRadius,farCenter.x-farRadius,farCenter.y+farRadius,farCenter.y-farRadius].some(value=>!Number.isFinite(value)))throw new RangeError('Scene field circles overflow finite drawing units.');
    const nearPath=circlePath(nearCenter,NEAR_RADIUS),farPath=circlePath(farCenter,farRadius);
    const path=distance<=farRadius-NEAR_RADIUS?farPath:expansionGeometry({cx:nearCenter.x,cy:nearCenter.y,nearRadius:NEAR_RADIUS,farRadius,distance,angle:options.angle}).path;
    return {path,nearCenter,farCenter,nearPath,farPath};
  }
  const native=nativeSection(shape);
  const project=(point:Point,center:Point,amount=1):Point=>({x:center.x+point.x*amount,y:center.y+point.y*amount});
  const nearPoints=native.points.map(p=>project(p,nearCenter)),farPoints=native.points.map(p=>project(p,farCenter,scale));
  if([...nearPoints,...farPoints].some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new RangeError('Scene field boundary overflows finite drawing units.');
  const sectionPath=(center:Point,amount=1)=>framePath(native.nodes.map(node=>({point:project(node.point,center,amount),in:project(node.in,center,amount),out:project(node.out,center,amount)})));
  const nearPath=sectionPath(nearCenter),farPath=sectionPath(farCenter,scale);
  if(/NaN|Infinity/.test(nearPath+farPath))throw new RangeError('Scene field cubic serialization overflows finite drawing units.');
  return {path:polygonPath(hull([...nearPoints,...farPoints])),nearCenter,farCenter,nearPath,farPath};
}
