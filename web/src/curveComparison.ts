import {createFrameTransition,frameTransitionScale} from './frameMorph';
import {interpolateFrameNodes,transformFrameNodes,type FrameNodes} from './frameGeometry';
import type {AperturePoint} from './landingMorph';

export type ComparisonMethod='current'|'sdf'|'radial';
type Point=AperturePoint;
type Segment={x:number;y:number;dx:number;dy:number;lengthSquared:number};
const COUNT=64,CHECKPOINTS=33,TAU=Math.PI*2,STEP=TAU/COUNT;
const TOLERANCE=.08;
const ANGULAR_SOFTNESS=.12;
const KEYS=['point','in','out'] as const;
const clamp=(t:number)=>Number.isNaN(t)?0:Math.max(0,Math.min(1,t));
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
const midpoint=(a:Point,b:Point):Point=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
const cross=(a:Point,b:Point)=>a.x*b.y-a.y*b.x;
const subtract=(a:Point,b:Point):Point=>({x:a.x-b.x,y:a.y-b.y});
const envelope=(t:number)=>16*t*t*(1-t)*(1-t);
const rays=Array.from({length:COUNT},(_,i)=>({x:Math.cos(i*STEP),y:Math.sin(i*STEP)}));

function radialOrigin(nodes:FrameNodes):Point {
  const p=nodes[0].point,q=nodes[16].point,a=subtract(nodes[32].point,p),b=subtract(nodes[48].point,q);
  const determinant=cross(a,b);
  if(Math.abs(determinant)<1e-8)throw new Error('The comparison needs a nondegenerate radial contour.');
  const t=cross(subtract(q,p),b)/determinant;
  const origin={x:p.x+a.x*t,y:p.y+a.y*t};
  for(let i=0;i<COUNT;i++) {
    const p=subtract(nodes[i].point,origin),radius=Math.hypot(p.x,p.y);
    if(radius<1e-5||Math.abs(cross(p,rays[i]))>radius*1e-7||p.x*rays[i].x+p.y*rays[i].y<=0)
      throw new Error('These comparison methods require matching radial anchors.');
  }
  return origin;
}

/** Flatten the actual cubics, with a control-hull distance bound. This is a
 * distance field of the authored outline, not an analytic replacement star. */
function flatten(nodes:FrameNodes,origin:Point):Segment[] {
  const points:Point[]=[];
  const distanceToChord=(p:Point,a:Point,b:Point)=>{
    const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;
    const t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;
    return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
  };
  const visit=(a:Point,b:Point,c:Point,d:Point,depth:number)=>{
    if(depth===12||Math.max(distanceToChord(b,a,d),distanceToChord(c,a,d))<=TOLERANCE){points.push(subtract(a,origin));return;}
    const ab=midpoint(a,b),bc=midpoint(b,c),cd=midpoint(c,d),abc=midpoint(ab,bc),bcd=midpoint(bc,cd),m=midpoint(abc,bcd);
    visit(a,ab,abc,m,depth+1);visit(m,bcd,cd,d,depth+1);
  };
  nodes.forEach((node,i)=>{const next=nodes[(i+1)%COUNT];visit(node.point,node.out,next.in,next.point,0);});
  return points.map((p,i)=>{
    const q=points[(i+1)%points.length],dx=q.x-p.x,dy=q.y-p.y;
    return {x:p.x,y:p.y,dx,dy,lengthSquared:dx*dx+dy*dy};
  });
}

function signedDistance(x:number,y:number,segments:Segment[]):number {
  let minimum=Infinity,inside=false;
  for(const edge of segments) {
    const px=x-edge.x,py=y-edge.y;
    const t=edge.lengthSquared?Math.max(0,Math.min(1,(px*edge.dx+py*edge.dy)/edge.lengthSquared)):0;
    const dx=px-t*edge.dx,dy=py-t*edge.dy;
    minimum=Math.min(minimum,dx*dx+dy*dy);
    if((edge.y>y)!==(edge.y+edge.dy>y)&&x<edge.x+(y-edge.y)*edge.dx/edge.dy)inside=!inside;
  }
  return Math.sqrt(minimum)*(inside?-1:1);
}

/** A continuous periodic low-pass, strongest halfway through the transition.
 * Both experimental methods get the same filter. It removes fine ripples;
 * it is not a feature correspondence solver and may soften intended corners. */
function smoothRadii(radii:number[],t:number):{radii:number[];derivatives:number[]} {
  const sigmaSquared=ANGULAR_SOFTNESS**2*envelope(t),values=Array(COUNT).fill(0),derivatives=Array(COUNT).fill(0);
  for(let frequency=0;frequency<=COUNT/2;frequency++) {
    let cosine=0,sine=0;
    for(let i=0;i<COUNT;i++) {
      cosine+=radii[i]*Math.cos(frequency*i*STEP);sine+=radii[i]*Math.sin(frequency*i*STEP);
    }
    const weight=(frequency===0||frequency===COUNT/2?1:2)/COUNT*Math.exp(-.5*sigmaSquared*frequency*frequency);
    cosine*=weight;sine*=weight;
    for(let i=0;i<COUNT;i++) {
      const c=Math.cos(frequency*i*STEP),s=Math.sin(frequency*i*STEP);
      values[i]+=cosine*c+sine*s;
      derivatives[i]+=frequency*(-cosine*s+sine*c);
    }
  }
  return {radii:values,derivatives};
}

function fitRadii(radii:number[],t:number,origin:Point):FrameNodes {
  const smooth=smoothRadii(radii,t),handle=4/3*Math.tan(STEP/4);
  return rays.map((ray,i)=>{
    const radius=smooth.radii[i],derivative=smooth.derivatives[i];
    const point={x:origin.x+radius*ray.x,y:origin.y+radius*ray.y};
    const dx=(derivative*ray.x-radius*ray.y)*handle,dy=(derivative*ray.y+radius*ray.x)*handle;
    return {point,in:{x:point.x-dx,y:point.y-dy},out:{x:point.x+dx,y:point.y+dy}};
  });
}

/** Keep authored endpoint handles rather than snapping from a reconstructed
 * spline on the first frame. The correction smoothly disappears inward. */
function restoreEndpoints(nodes:FrameNodes,a:FrameNodes,b:FrameNodes,fitA:FrameNodes,fitB:FrameNodes,t:number):FrameNodes {
  const weight=(u:number)=>{const v=Math.min(1,u/.22);return 1-v*v*(3-2*v);};
  const wa=weight(t),wb=weight(1-t);
  return nodes.map((node,i)=>Object.fromEntries(KEYS.map(key=>[key,{
    x:node[key].x+(a[i][key].x-fitA[i][key].x)*wa+(b[i][key].x-fitB[i][key].x)*wb,
    y:node[key].y+(a[i][key].y-fitA[i][key].y)*wa+(b[i][key].y-fitB[i][key].y)*wb,
  }])) as FrameNodes[number]);
}

/** Cubic Hermite interpolation shares the derivative on both sides of every
 * checkpoint. There are no local ease-in/out pauses at those checkpoints. */
function checkpointSampler(checkpoints:FrameNodes[]):(t:number)=>FrameNodes {
  const last=checkpoints.length-1;
  return t=>{
    if(t===0)return checkpoints[0];if(t===1)return checkpoints[last];
    const position=t*last,index=Math.min(last-1,Math.floor(position)),u=position-index;
    const h00=2*u*u*u-3*u*u+1,h10=u*u*u-2*u*u+u,h01=-2*u*u*u+3*u*u,h11=u*u*u-u*u;
    const a=checkpoints[index],b=checkpoints[index+1],previous=checkpoints[Math.max(0,index-1)],next=checkpoints[Math.min(last,index+2)];
    return a.map((node,i)=>Object.fromEntries(KEYS.map(key=>[key,{
      x:h00*node[key].x+h01*b[i][key].x+h10*(b[i][key].x-previous[i][key].x)/(index===0?1:2)+h11*(next[i][key].x-node[key].x)/(index+1===last?1:2),
      y:h00*node[key].y+h01*b[i][key].y+h10*(b[i][key].y-previous[i][key].y)/(index===0?1:2)+h11*(next[i][key].y-node[key].y)/(index+1===last?1:2),
    }])) as FrameNodes[number]);
  };
}

export type CurveComparison={
  sample:(progress:number,method:ComparisonMethod)=>FrameNodes;
  sampleUnscaled:(progress:number,method:ComparisonMethod)=>FrameNodes;
  diagnostics:{compileMs:number;checkpoints:number;contourTolerance:number;sourceSegments:number;targetSegments:number};
};

/** Experimental comparison only. Progress is the already-eased shape time.
 * Compilation does the distance solves; playback only evaluates cached cubics.
 * This deliberately supports the two radial test pairs, not arbitrary topology.
 */
export function compileCurveComparison(from:FrameNodes,to:FrameNodes):CurveComparison {
  const started=performance.now(),a=interpolateFrameNodes(from,to,0),b=interpolateFrameNodes(from,to,1);
  const originA=radialOrigin(a),originB=radialOrigin(b);
  const radiiA=a.map(node=>Math.hypot(node.point.x-originA.x,node.point.y-originA.y));
  const radiiB=b.map(node=>Math.hypot(node.point.x-originB.x,node.point.y-originB.y));
  const edgesA=flatten(a,originA),edgesB=flatten(b,originB);
  const fitA=fitRadii(radiiA,0,originA),fitB=fitRadii(radiiB,1,originB);
  const sdf:FrameNodes[]=[],radial:FrameNodes[]=[];
  for(let checkpoint=0;checkpoint<CHECKPOINTS;checkpoint++) {
    const t=checkpoint/(CHECKPOINTS-1),origin={x:mix(originA.x,originB.x,t),y:mix(originA.y,originB.y,t)};
    if(checkpoint===0||checkpoint===CHECKPOINTS-1){sdf.push(t===0?a:b);radial.push(t===0?a:b);continue;}
    const radii=radiiA.map((r,i)=>mix(r,radiiB[i],t));
    const fieldRadii=rays.map((ray,i)=>{
      // For these centered star-shaped inputs, the only root lies between the
      // two endpoint radii. A small reserve covers the flattening tolerance.
      let low=Math.max(0,Math.min(radiiA[i],radiiB[i])-TOLERANCE*2),high=Math.max(radiiA[i],radiiB[i])+TOLERANCE*2;
      for(let iteration=0;iteration<15;iteration++) {
        const radius=(low+high)/2,x=ray.x*radius,y=ray.y*radius;
        const distance=mix(signedDistance(x,y,edgesA),signedDistance(x,y,edgesB),t);
        if(distance<0)low=radius;else high=radius;
      }
      return (low+high)/2;
    });
    radial.push(restoreEndpoints(fitRadii(radii,t,origin),a,b,fitA,fitB,t));
    sdf.push(restoreEndpoints(fitRadii(fieldRadii,t,origin),a,b,fitA,fitB,t));
  }
  const current=createFrameTransition(a,b),unscaledCurrent=createFrameTransition(a,b,0);
  const sdfAt=checkpointSampler(sdf),radialAt=checkpointSampler(radial);
  const sampleUnscaled=(progress:number,method:ComparisonMethod)=>{
    const t=clamp(progress);
    return method==='current'?unscaledCurrent(t):method==='sdf'?sdfAt(t):radialAt(t);
  };
  return {
    sampleUnscaled,
    sample(progress,method){
      const t=clamp(progress);
      if(method==='current')return current(t);
      const nodes=sampleUnscaled(t,method);
      if(t===0||t===1)return nodes;
      return transformFrameNodes(nodes,{scaleX:frameTransitionScale(t),origin:{x:mix(originA.x,originB.x,t),y:mix(originA.y,originB.y,t)}});
    },
    diagnostics:{compileMs:performance.now()-started,checkpoints:CHECKPOINTS,contourTolerance:TOLERANCE,sourceSegments:edgesA.length,targetSegments:edgesB.length},
  };
}
