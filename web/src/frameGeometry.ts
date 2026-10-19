import {APERTURE_NODE_COUNT, landingMorphNodes, type ApertureNode, type AperturePoint} from './landingMorph';
import {aboutPanelNodes} from './aboutTransition';
import {philosophyGeometry} from './philosophyFlow';
import {LOADING_RADIUS, type EntranceOrigin} from './studioEntrance';

/** All page frames share clockwise cubics, starting at the right midpoint.
 * The other cardinal anchors are 16 (bottom), 32 (left), and 48 (top).
 * Coordinates are viewport pixels; content does not need a separate SVG scale.
 */
export type FrameNodes = ApertureNode[];
export type FrameRect = {left:number; top:number; right:number; bottom:number};
export type FrameBounds = FrameRect & {width:number; height:number};
export type FrameRadii = {topLeft:number; topRight:number; bottomRight:number; bottomLeft:number};
export type FrameTransform = {
  scaleX?:number; scaleY?:number; translateX?:number; translateY?:number;
  /** Rotation in degrees, applied after scaling around origin. */
  rotation?:number; origin?:AperturePoint;
};

const finite = (value:number, fallback=0) => Number.isFinite(value) ? value : fallback;
const progress = (value:number) => Number.isNaN(value) ? 0 : Math.max(0,Math.min(1,value));
const point = (x:number,y:number):AperturePoint => ({x,y});
const mix = (a:AperturePoint,b:AperturePoint,t:number):AperturePoint => point(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t);

function assertFrame(nodes:readonly ApertureNode[]):void {
  if(nodes.length!==APERTURE_NODE_COUNT || Array.from(nodes).some(node=>!node ||
    (['point','in','out'] as const).some(key=>!node[key] || !Number.isFinite(node[key].x) || !Number.isFinite(node[key].y)))) {
    throw new Error(`A frame needs ${APERTURE_NODE_COUNT} finite cubic anchors.`);
  }
}

/** Project local contours, or move an already projected frame without mutating it. */
export function transformFrameNodes(nodes:readonly ApertureNode[], transform:FrameTransform):FrameNodes {
  assertFrame(nodes);
  const sx=finite(transform.scaleX??1,1),sy=finite(transform.scaleY??sx,sx);
  const tx=finite(transform.translateX??0),ty=finite(transform.translateY??0);
  const ox=finite(transform.origin?.x??0),oy=finite(transform.origin?.y??0);
  const angle=finite(transform.rotation??0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const project=(p:AperturePoint) => {
    const x=(p.x-ox)*sx,y=(p.y-oy)*sy;
    return point(ox+x*cos-y*sin+tx,oy+x*sin+y*cos+ty);
  };
  return nodes.map(node=>({point:project(node.point),in:project(node.in),out:project(node.out)}));
}

/** The exact existing landing curve at its measured position and hover progress. */
export function landingFrameNodes(origin:EntranceOrigin):FrameNodes {
  return transformFrameNodes(landingMorphNodes(origin.aperture),{
    scaleX:Math.max(0,finite(origin.width))/1000,
    origin:{x:500,y:300},translateX:finite(origin.x)-500,translateY:finite(origin.y)-300,
  });
}

/** Preserve the existing About endpoint, including its square bottom corners. */
export function aboutFrameNodes(width:number,height:number):FrameNodes {
  return aboutPanelNodes(Math.max(0,finite(width)),Math.max(0,finite(height)));
}

/** Exact straight edges and quarter arcs, with fixed quadrant correspondence.
 * Arc cubics approximate circular corners to better than 0.00001 × radius.
 * Zero-length edge segments are retained as a circle grows from a rectangle;
 * this keeps every anchor continuous rather than reallocating nodes mid-morph.
 */
export function roundedFrameNodes(rect:FrameRect, radii:number|Partial<FrameRadii>=0):FrameNodes {
  const left=finite(rect.left),top=finite(rect.top);
  const right=Math.max(left,finite(rect.right,left)),bottom=Math.max(top,finite(rect.bottom,top));
  const cx=(left+right)/2,cy=(top+bottom)/2;
  const cap=Math.min((right-left)/2,(bottom-top)/2);
  const radius=(key:keyof FrameRadii) => Math.max(0,Math.min(cap,finite(typeof radii==='number'?radii:radii[key]??0)));
  const br=radius('bottomRight'),bl=radius('bottomLeft'),tl=radius('topLeft'),tr=radius('topRight');
  const nodes:FrameNodes=[];
  let incoming:AperturePoint|null=null;
  const cubic=(start:AperturePoint,first:AperturePoint,second:AperturePoint) => {
    nodes.push({point:start,in:incoming??start,out:first});incoming=second;
  };
  const line=(start:AperturePoint,end:AperturePoint,count:number) => {
    for(let i=0;i<count;i++) {
      const a=mix(start,end,i/count),b=mix(start,end,(i+1)/count);
      cubic(a,mix(a,b,1/3),mix(a,b,2/3));
    }
  };
  const arc=(center:AperturePoint,r:number,from:number) => {
    const step=Math.PI/8,handle=4/3*Math.tan(step/4)*r;
    for(let i=0;i<4;i++) {
      const a=from+i*step,b=a+step;
      const start=point(center.x+r*Math.cos(a),center.y+r*Math.sin(a));
      const end=point(center.x+r*Math.cos(b),center.y+r*Math.sin(b));
      cubic(start,point(start.x-handle*Math.sin(a),start.y+handle*Math.cos(a)),
        point(end.x+handle*Math.sin(b),end.y-handle*Math.cos(b)));
    }
  };
  line(point(right,cy),point(right,bottom-br),6);
  arc(point(right-br,bottom-br),br,0);
  line(point(right-br,bottom),point(cx,bottom),6);
  line(point(cx,bottom),point(left+bl,bottom),6);
  arc(point(left+bl,bottom-bl),bl,Math.PI/2);
  line(point(left,bottom-bl),point(left,cy),6);
  line(point(left,cy),point(left,top+tl),6);
  arc(point(left+tl,top+tl),tl,Math.PI);
  line(point(left+tl,top),point(cx,top),6);
  line(point(cx,top),point(right-tr,top),6);
  arc(point(right-tr,top+tr),tr,Math.PI*1.5);
  line(point(right,top+tr),point(right,cy),6);
  nodes[0].in=incoming!;
  return nodes;
}

/** The same bounded, rotated geometry used by Shape + Light's text flow. */
export function philosophyFrameNodes(width:number,height:number,amount:number):FrameNodes {
  const g=philosophyGeometry(width,height,amount);
  return transformFrameNodes(roundedFrameNodes({left:g.x-g.width/2,top:g.y-g.height/2,
    right:g.x+g.width/2,bottom:g.y+g.height/2},g.radius),{origin:point(g.x,g.y),rotation:g.rotation});
}

/** Uniform circular nodes preserve the landing circle's angular correspondence. */
export function loadingFrameNodes(center:AperturePoint,radius=LOADING_RADIUS):FrameNodes {
  const cx=finite(center.x),cy=finite(center.y),r=Math.max(0,finite(radius));
  const angle=Math.PI*2/APERTURE_NODE_COUNT,handle=4/3*Math.tan(angle/4)*r;
  return Array.from({length:APERTURE_NODE_COUNT},(_,i)=>{
    const a=i*angle,x=cx+r*Math.cos(a),y=cy+r*Math.sin(a),dx=-Math.sin(a)*handle,dy=Math.cos(a)*handle;
    return {point:point(x,y),in:point(x-dx,y-dy),out:point(x+dx,y+dy)};
  });
}

/** Linear interpolation: the wrapper owns timing/easing and interruption state. */
export function interpolateFrameNodes(from:readonly ApertureNode[],to:readonly ApertureNode[],amount:number):FrameNodes {
  assertFrame(from);assertFrame(to);
  const t=progress(amount);
  if(t===0||t===1)return (t===0?from:to).map(node=>({point:{...node.point},in:{...node.in},out:{...node.out}}));
  return from.map((node,i)=>({point:mix(node.point,to[i].point,t),in:mix(node.in,to[i].in,t),out:mix(node.out,to[i].out,t)}));
}

/** One serialized contour can serve the frame fill, clip, halo, and hit shape. */
export function framePath(nodes:readonly ApertureNode[]):string {
  assertFrame(nodes);
  const coordinates=(p:AperturePoint) => `${Math.round(p.x*1000)/1000} ${Math.round(p.y*1000)/1000}`;
  let path=`M ${coordinates(nodes[0].point)}`;
  for(let i=0;i<nodes.length;i++) {
    const next=nodes[(i+1)%nodes.length];
    path+=` C ${coordinates(nodes[i].out)} ${coordinates(next.in)} ${coordinates(next.point)}`;
  }
  return `${path} Z`;
}

function extrema(a:number,b:number,c:number,d:number):number[] {
  const qa=-a+3*b-3*c+d,qb=2*(a-2*b+c),qc=b-a;
  if(Math.abs(qa)<1e-10)return Math.abs(qb)<1e-10?[]:[-qc/qb];
  const discriminant=qb*qb-4*qa*qc;
  if(discriminant<0)return [];
  const root=Math.sqrt(discriminant);
  return [(-qb-root)/(2*qa),(-qb+root)/(2*qa)];
}

/** True cubic bounds, including extrema between anchors (not control-handle bounds). */
export function frameBounds(nodes:readonly ApertureNode[]):FrameBounds {
  assertFrame(nodes);
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  const include=(p:AperturePoint)=>{left=Math.min(left,p.x);right=Math.max(right,p.x);top=Math.min(top,p.y);bottom=Math.max(bottom,p.y);};
  for(let i=0;i<nodes.length;i++) {
    const a=nodes[i].point,b=nodes[i].out,c=nodes[(i+1)%nodes.length].in,d=nodes[(i+1)%nodes.length].point;
    include(a);
    for(const t of [...extrema(a.x,b.x,c.x,d.x),...extrema(a.y,b.y,c.y,d.y)]) {
      if(t<=0||t>=1)continue;
      const u=1-t;
      include(point(u**3*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t**3*d.x,u**3*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t**3*d.y));
    }
  }
  return {left,top,right,bottom,width:right-left,height:bottom-top};
}
