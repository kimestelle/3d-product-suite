import {
  frameBounds, interpolateFrameNodes, loadingFrameNodes, roundedFrameNodes, transformFrameNodes,
  type FrameNodes, type FrameRadii, type FrameRect,
} from './frameGeometry';
import {landingMorphNodes, type AperturePoint} from './landingMorph';

type Point=AperturePoint;
type Pose={x:number;y:number;width:number;height:number;rotation:number;radii:FrameRadii};
type Cross={x:number;y:number;radius:number};
const CORNERS=['topLeft','topRight','bottomRight','bottomLeft'] as const;
const KEYS=['point','in','out'] as const;
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const clamp=(t:number)=>Number.isNaN(t)?0:Math.max(0,Math.min(1,t));
const ease=(t:number)=>t*t*(3-2*t);
const deltaAngle=(a:number,b:number)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
const length=(p:Point)=>Math.hypot(p.x,p.y);
const subtract=(a:Point,b:Point):Point=>({x:a.x-b.x,y:a.y-b.y});
export const DEFAULT_FRAME_SHRINK=.3;
export function normalizeFrameShrink(value:unknown):number {
  return typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(.5,value)):DEFAULT_FRAME_SHRINK;
}

/** A reversible size envelope with zero slope at either finished composition.
 * This is presentation timing, separate from the catalog's pure interpolation. */
export function frameTransitionScale(progress:number,shrink=DEFAULT_FRAME_SHRINK):number {
  const t=clamp(progress);
  return 1-normalizeFrameShrink(shrink)*16*t*t*(1-t)*(1-t);
}

/** Route windows share cardinal anchors, so their center needs no layout read
 * or cubic-extrema solve. Scale handles and anchors together after clearance. */
export function createFrameTransition(from:FrameNodes,to:FrameNodes,shrink=DEFAULT_FRAME_SHRINK):(progress:number)=>FrameNodes {
  const morph=createFrameMorph(from,to);
  // Initial mounting and same-page navigation must not pulse a stationary frame.
  if(from.every((node,i)=>KEYS.every(key=>node[key].x===to[i][key].x&&node[key].y===to[i][key].y)))return morph;
  return progress=>{
    const t=clamp(progress),nodes=morph(t);
    if(t===0||t===1)return nodes;
    return transformFrameNodes(nodes,{scaleX:frameTransitionScale(t,shrink),
      origin:{x:(nodes[0].point.x+nodes[32].point.x)/2,y:(nodes[0].point.y+nodes[32].point.y)/2}});
  };
}

function cubic(a:Point,b:Point,c:Point,d:Point,t:number):Point {
  const u=1-t;
  return {x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x,
    y:u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*d.y};
}

/** Read the object represented by the contour, independent of how each page
 * allocated its 64 anchors. Validation rejects freeform and concave outlines.
 */
function windowPose(nodes:FrameNodes):Pose|null {
  const horizontal=subtract(nodes[0].point,nodes[32].point);
  const vertical=subtract(nodes[16].point,nodes[48].point);
  const width=length(horizontal),height=length(vertical);
  if(width<1e-7||height<1e-7)return null;
  const x=(nodes[0].point.x+nodes[32].point.x)/2,y=(nodes[0].point.y+nodes[32].point.y)/2;
  const cos=horizontal.x/width,sin=horizontal.y/width;
  const tolerance=.002+Math.max(width,height)*1e-6;
  if(Math.abs(vertical.x*cos+vertical.y*sin)>tolerance ||
    vertical.y*cos-vertical.x*sin<=0 ||
    Math.hypot((nodes[16].point.x+nodes[48].point.x)/2-x,
      (nodes[16].point.y+nodes[48].point.y)/2-y)>tolerance)return null;
  const local=(p:Point):Point=>({x:(p.x-x)*cos+(p.y-y)*sin,y:-(p.x-x)*sin+(p.y-y)*cos});
  const points=nodes.map(node=>local(node.point)),hw=width/2,hh=height/2,cap=Math.min(hw,hh);
  const corner=(p:Point):keyof FrameRadii=>p.y<0?(p.x<0?'topLeft':'topRight'):(p.x<0?'bottomLeft':'bottomRight');
  const radii:FrameRadii={topLeft:cap,topRight:cap,bottomRight:cap,bottomLeft:cap};
  for(const p of points) {
    const dx=hw-Math.abs(p.x),dy=hh-Math.abs(p.y);
    if(dx < -tolerance || dy < -tolerance)return null;
    // A point on a circular corner satisfies r = dx + dy + sqrt(2 dx dy).
    // Straight-edge samples give a larger bound; the smallest bound is r.
    const a=Math.max(0,dx),b=Math.max(0,dy),key=corner(p);
    radii[key]=Math.min(radii[key],a+b+Math.sqrt(2*a*b));
  }
  for(let i=0;i<nodes.length;i++) {
    const start=nodes[i],end=nodes[(i+1)%nodes.length];
    for(let sample=0;sample<8;sample++) {
      const p=local(cubic(start.point,start.out,end.in,end.point,sample/8));
      const r=radii[corner(p)],qx=Math.abs(p.x)-(hw-r),qy=Math.abs(p.y)-(hh-r);
      const distance=Math.hypot(Math.max(0,qx),Math.max(0,qy))+Math.min(Math.max(qx,qy),0)-r;
      if(Math.abs(distance)>tolerance)return null;
    }
  }
  return {x,y,width,height,rotation:Math.atan2(sin,cos),radii};
}

function drawPose(pose:Pose):FrameNodes {
  return transformFrameNodes(roundedFrameNodes({left:-pose.width/2,top:-pose.height/2,
    right:pose.width/2,bottom:pose.height/2},pose.radii),
  {translateX:pose.x,translateY:pose.y,rotation:pose.rotation*180/Math.PI});
}

/** The four corner arcs give the rotated extent directly; no 64-segment
 * extrema solve is needed while animating. Coordinates remain local to pose.
 */
function poseBounds(pose:Pose):FrameRect {
  const cos=Math.cos(pose.rotation),sin=Math.sin(pose.rotation),hw=pose.width/2,hh=pose.height/2;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  const include=(x:number,y:number)=>{left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);};
  const arc=(x:number,y:number,r:number,start:number)=>{
    const cx=x*cos-y*sin,cy=x*sin+y*cos,from=start+pose.rotation,to=from+Math.PI/2;
    include(cx+r*Math.cos(from),cy+r*Math.sin(from));
    include(cx+r*Math.cos(to),cy+r*Math.sin(to));
    for(let cardinal=Math.ceil(from/(Math.PI/2));cardinal*Math.PI/2<to;cardinal++) {
      const angle=cardinal*Math.PI/2;include(cx+r*Math.cos(angle),cy+r*Math.sin(angle));
    }
  };
  const r=pose.radii;
  arc(hw-r.bottomRight,hh-r.bottomRight,r.bottomRight,0);
  arc(-hw+r.bottomLeft,hh-r.bottomLeft,r.bottomLeft,Math.PI/2);
  arc(-hw+r.topLeft,-hh+r.topLeft,r.topLeft,Math.PI);
  arc(hw-r.topRight,-hh+r.topRight,r.topRight,Math.PI*1.5);
  return {left,top,right,bottom};
}

const travelBounds=(a:FrameNodes,b:FrameNodes):FrameRect=>{
  const start=frameBounds(a),end=frameBounds(b);
  return {left:Math.min(start.left,end.left),top:Math.min(start.top,end.top),
    right:Math.max(start.right,end.right),bottom:Math.max(start.bottom,end.bottom)};
};

function windowMorph(from:Pose,to:Pose,limit:FrameRect):(t:number)=>FrameNodes {
  const fromCap=Math.min(from.width,from.height)/2,toCap=Math.min(to.width,to.height)/2;
  const rotation=deltaAngle(from.rotation,to.rotation);
  const radii=CORNERS.map(key=>[fromCap?from.radii[key]/fromCap:0,toCap?to.radii[key]/toCap:0]);
  const poseAt=(t:number):Pose=>{
    const width=mix(from.width,to.width,t),height=mix(from.height,to.height,t),cap=Math.min(width,height)/2;
    return {x:mix(from.x,to.x,t),y:mix(from.y,to.y,t),width,height,
      rotation:from.rotation+rotation*t,
      radii:Object.fromEntries(CORNERS.map((key,i)=>[key,cap*mix(radii[i][0],radii[i][1],t)])) as FrameRadii};
  };
  const bend=(t:number)=>4*t*(1-t);
  const clearanceAt=(t:number)=>{
    const pose=poseAt(t),bounds=poseBounds(pose);
    const fit=Math.max(1e-12,Math.min(1,
      bounds.left<0?(pose.x-limit.left)/-bounds.left:1,
      bounds.right>0?(limit.right-pose.x)/bounds.right:1,
      bounds.top<0?(pose.y-limit.top)/-bounds.top:1,
      bounds.bottom>0?(limit.bottom-pose.y)/bounds.bottom:1));
    return -Math.log(fit)/bend(t);
  };
  // Plan clearance before the trip. A per-frame clamp pins an edge, changes
  // the center's direction, then abruptly releases it as rotation makes room.
  // This smooth, reversible scale envelope keeps the center on its direct path.
  const count=96,positions=Array.from({length:count+1},(_,i)=>i===0?1e-5:i===count?1-1e-5:i/count);
  const needs=positions.map(clearanceAt);
  let strength=Math.max(...needs);
  for(let i=1;i<count;i++) {
    if(needs[i]<=0||needs[i]<needs[i-1]||needs[i]<needs[i+1])continue;
    // Refine local peaks so narrow rotation/edge extrema cannot be skipped by
    // the sampling grid. Only the compiled scalar is used during rendering.
    let low=positions[i-1],high=positions[i+1];
    for(let pass=0;pass<24;pass++) {
      const a=low+(high-low)/3,b=high-(high-low)/3;
      if(clearanceAt(a)<clearanceAt(b))low=a;else high=b;
    }
    strength=Math.max(strength,clearanceAt((low+high)/2));
  }
  // A small conservative reserve covers numerical arc/extrema differences.
  strength=strength>1e-9?strength*1.01+1e-5:0;
  return t=>{
    const pose=poseAt(t),scale=Math.exp(-strength*bend(t));
    pose.width*=scale;pose.height*=scale;
    for(const key of CORNERS)pose.radii[key]*=scale;
    return drawPose(pose);
  };
}

// The landing cross and its partial hover states are an exact linear blend of
// these two radial templates. Recognizing that family avoids routing unrelated
// freeform shapes through a circle merely because they are not rectangles.
const X=landingMorphNodes(0),CIRCLE=landingMorphNodes(.5),RECTANGLE=landingMorphNodes(1);
const crossVectors=X.flatMap(node=>KEYS.flatMap(key=>[node[key].x-500,node[key].y-300]));
const circleVectors=CIRCLE.flatMap(node=>KEYS.flatMap(key=>[node[key].x-500,node[key].y-300]));
const dot=(a:number[],b:number[])=>a.reduce((sum,value,i)=>sum+value*b[i],0);
const xx=dot(crossVectors,crossVectors),cc=dot(circleVectors,circleVectors),xc=dot(crossVectors,circleVectors);
const determinant=xx*cc-xc*xc;
/** Landing's fully open rectangle uses radial samples, which approximate the
 * corner a little differently. Match the authored template, rather than relax
 * window validation enough to mistake a partial hover for a rectangle.
 */
function landingRectanglePose(nodes:FrameNodes):Pose|null {
  const x=(nodes[0].point.x+nodes[32].point.x)/2,y=(nodes[0].point.y+nodes[32].point.y)/2;
  const scale=(nodes[0].point.x-nodes[32].point.x)/936;
  if(scale<=0)return null;
  const tolerance=.002+scale*.001;
  for(let i=0;i<nodes.length;i++)for(const key of KEYS) {
    if(Math.abs(nodes[i][key].x-x-(RECTANGLE[i][key].x-500)*scale)>tolerance ||
      Math.abs(nodes[i][key].y-y-(RECTANGLE[i][key].y-300)*scale)>tolerance)return null;
  }
  const r=95*scale;
  return {x,y,width:936*scale,height:540*scale,rotation:0,
    radii:{topLeft:r,topRight:r,bottomRight:r,bottomLeft:r}};
}
function landingCross(nodes:FrameNodes):Cross|null {
  const x=(nodes[0].point.x+nodes[32].point.x)/2,y=(nodes[0].point.y+nodes[32].point.y)/2;
  const values=nodes.flatMap(node=>KEYS.flatMap(key=>[node[key].x-x,node[key].y-y]));
  const xp=dot(crossVectors,values),cp=dot(circleVectors,values);
  const a=(xp*cc-cp*xc)/determinant,b=(cp*xx-xp*xc)/determinant;
  if(a<1e-8||b < -1e-8||a+b<=0)return null;
  const tolerance=.002+(a+b)*.001;
  if(values.some((value,i)=>Math.abs(value-a*crossVectors[i]-b*circleVectors[i])>tolerance))return null;
  return {x,y,radius:260*(a+b)};
}

function circlePose(circle:Cross):Pose {
  const {x,y,radius}=circle;
  return {x,y,width:2*radius,height:2*radius,rotation:0,
    radii:{topLeft:radius,topRight:radius,bottomRight:radius,bottomLeft:radius}};
}

type RadialTangent={derivative:Point;before:number;after:number};
type RadialContour={angle:number;tangents:RadialTangent[]};
const crossProduct=(a:Point,b:Point)=>a.x*b.y-a.y*b.x;

/** Radially authored contours share an angle parameter, but their constructors
 * shorten handles by different amounts. Recover dp/d(angle) independently of
 * that shortening so moving anchors and tangents describe the same edge.
 * Semantic windows have another sampling scheme and must not enter this path.
 */
function radialContour(nodes:FrameNodes):RadialContour|null {
  const count=nodes.length,half=count/2,quarter=count/4;
  const p=nodes[0].point,q=nodes[quarter].point;
  const horizontal=subtract(nodes[half].point,p),vertical=subtract(nodes[quarter+half].point,q);
  const determinant=crossProduct(horizontal,vertical);
  if(Math.abs(determinant)<1e-9)return null;
  // Intersect opposite rays: the pole need not be the contour's bounding center
  // (for example, a triangle or pentagon).
  const distance=crossProduct(subtract(q,p),vertical)/determinant;
  const pole={x:p.x+horizontal.x*distance,y:p.y+horizontal.y*distance};
  const angle=Math.atan2(p.y-pole.y,p.x-pole.x),step=2*Math.PI/count;
  const tangents:RadialTangent[]=[];
  for(let i=0;i<count;i++) {
    const node=nodes[i],radius=subtract(node.point,pole),r=length(radius);
    if(r<1e-7||Math.abs(deltaAngle(angle+i*step,Math.atan2(radius.y,radius.x)))>1e-7)return null;
    const incoming=subtract(node.point,node.in),outgoing=subtract(node.out,node.point);
    const before=crossProduct(radius,incoming)/(r*r),after=crossProduct(radius,outgoing)/(r*r);
    if(before<1e-9||after<1e-9)return null;
    const derivative={x:outgoing.x/after,y:outgoing.y/after};
    // Preserve deliberate corners and zero handles through the general path.
    if(Math.hypot(incoming.x/before-derivative.x,incoming.y/before-derivative.y)>length(derivative)*1e-7)return null;
    tangents.push({derivative,before,after});
  }
  return {angle,tangents};
}

function radialMorph(from:FrameNodes,to:FrameNodes):((t:number)=>FrameNodes)|null {
  const a=radialContour(from),b=radialContour(to);
  if(!a||!b||Math.abs(deltaAngle(a.angle,b.angle))>1e-7)return null;
  return t=>from.map((node,i)=>{
    const point={x:mix(node.point.x,to[i].point.x,t),y:mix(node.point.y,to[i].point.y,t)};
    const start=a.tangents[i],end=b.tangents[i];
    const dx=mix(start.derivative.x,end.derivative.x,t),dy=mix(start.derivative.y,end.derivative.y,t);
    const before=mix(start.before,end.before,t),after=mix(start.after,end.after,t);
    return {point,in:{x:point.x-dx*before,y:point.y-dy*before},
      out:{x:point.x+dx*after,y:point.y+dy*after}};
  });
}

/** When no named window geometry fits, preserve each node's shared tangent.
 * Independent handle-vector lerps can turn an originally smooth join into a
 * kink when the two handles have different lengths. Direction and length are
 * interpolated separately, retaining deliberately sharp endpoint corners.
 */
function freeformMorph(from:FrameNodes,to:FrameNodes):(t:number)=>FrameNodes {
  const radial=radialMorph(from,to);
  if(radial)return radial;
  const tangents=(nodes:FrameNodes,index:number)=>{
    const node=nodes[index],incoming=subtract(node.point,node.in),outgoing=subtract(node.out,node.point);
    const before=length(incoming),after=length(outgoing);
    const fallback=subtract(nodes[(index+1)%nodes.length].point,nodes[(index+nodes.length-1)%nodes.length].point);
    let inAngle=Math.atan2(incoming.y,incoming.x),outAngle=Math.atan2(outgoing.y,outgoing.x);
    if(before<1e-9)inAngle=after<1e-9?Math.atan2(fallback.y,fallback.x):outAngle;
    if(after<1e-9)outAngle=inAngle;
    if(before*after>1e-12&&(incoming.x*outgoing.x+incoming.y*outgoing.y)/(before*after)>1-1e-8)inAngle=outAngle;
    return {before,after,inAngle,outAngle};
  };
  const handles=from.map((_,i)=>({from:tangents(from,i),to:tangents(to,i)}));
  return t=>from.map((node,i)=>{
    const point={x:mix(node.point.x,to[i].point.x,t),y:mix(node.point.y,to[i].point.y,t)};
    const a=handles[i].from,b=handles[i].to;
    const before=mix(a.before,b.before,t),after=mix(a.after,b.after,t);
    const inAngle=a.inAngle+deltaAngle(a.inAngle,b.inAngle)*t;
    const outAngle=a.outAngle+deltaAngle(a.outAngle,b.outAngle)*t;
    return {point,in:{x:point.x-Math.cos(inAngle)*before,y:point.y-Math.sin(inAngle)*before},
      out:{x:point.x+Math.cos(outAngle)*after,y:point.y+Math.sin(outAngle)*after}};
  });
}

/** Prepare correspondence once per trip, including after an interruption.
 * Windows retain straight edges, circular corners and their own pose. Only the
 * landing cross family unfolds through a circle; all other contours retain
 * their shape. Input arrays are never mutated. Returned endpoint snapshots are
 * cached read-only values; callers must not mutate the returned nodes.
 */
export function createFrameMorph(from:FrameNodes,to:FrameNodes):(progress:number)=>FrameNodes {
  const start=interpolateFrameNodes(from,to,0),end=interpolateFrameNodes(from,to,1);
  const a=windowPose(start)??landingRectanglePose(start),b=windowPose(end)??landingRectanglePose(end);
  let sample:(t:number)=>FrameNodes;
  if(a&&b)sample=windowMorph(a,b,travelBounds(start,end));
  else {
    const crossA=a?null:landingCross(start),crossB=b?null:landingCross(end);
    if(crossA&&!crossB) {
      const circle=loadingFrameNodes(crossA,crossA.radius);
      const expand=b?windowMorph(circlePose(crossA),b,travelBounds(circle,end)):freeformMorph(circle,end);
      sample=t=>t<=.5?interpolateFrameNodes(start,circle,ease(t*2)):expand(ease((t-.5)*2));
    } else if(crossB&&!crossA) {
      const circle=loadingFrameNodes(crossB,crossB.radius);
      const contract=a?windowMorph(a,circlePose(crossB),travelBounds(start,circle)):freeformMorph(start,circle);
      sample=t=>t<.5?contract(ease(t*2)):interpolateFrameNodes(circle,end,ease((t-.5)*2));
    } else if(crossA&&crossB)sample=t=>interpolateFrameNodes(start,end,t);
    else sample=freeformMorph(start,end);
  }
  return progress=>{const t=clamp(progress);return t===0?start:t===1?end:sample(t);};
}
