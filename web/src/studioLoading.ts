import {interpolateFrameNodes,loadingFrameNodes,transformFrameNodes,type FrameNodes} from './frameGeometry';
import {createFrameMorph} from './frameMorph';
import {LOADING_RADIUS} from './studioEntrance';

export const STUDIO_LOADING_CYCLE_MS=5600;
const origin={x:0,y:0};
const circle=loadingFrameNodes(origin);
const ease=(t:number)=>t*t*(3-2*t);
const mix=(a:number,b:number,t:number)=>a+(b-a)*t;

/** One circle seen at changing angles. Projecting the same cached cubics keeps
 * every waiting pose an exact ellipse, without compiling catalog morphs. */
export function studioLoadingNodes(elapsedMs:number,center:{x:number;y:number}):FrameNodes {
  const elapsed=Number.isFinite(elapsedMs)?Math.max(0,elapsedMs):0;
  const phase=(elapsed%STUDIO_LOADING_CYCLE_MS)/STUDIO_LOADING_CYCLE_MS;
  if(phase===0)return loadingFrameNodes(center);
  return transformFrameNodes(circle,{
    // A near-edge-on view makes the changing perspective visible at loader size.
    // Keep a finite minor axis so the disk never disappears or flips winding.
    scaleY:1-.82*Math.sin(Math.PI*phase)**2,
    rotation:360*phase,translateX:center.x,translateY:center.y,
  });
}

/** The loading disk faces forward while still small, then opens into the real
 * editor window. Never stretch rotated ellipse handles into full-size edges.
 * Non-ellipse inputs (a resize after expansion began) use the shared morph. */
export function createStudioExpansion(from:FrameNodes,to:FrameNodes):(progress:number)=>FrameNodes {
  const start=interpolateFrameNodes(from,from,0);
  const center={x:(start[0].point.x+start[32].point.x)/2,y:(start[0].point.y+start[32].point.y)/2};
  const x=start[0].point.x-center.x,y=start[0].point.y-center.y;
  const rx=Math.hypot(x,y),ry=Math.hypot(start[16].point.x-center.x,start[16].point.y-center.y);
  const angle=Math.atan2(y,x)*180/Math.PI;
  const ellipse=(amount:number)=>transformFrameNodes(circle,{
    scaleX:mix(rx/LOADING_RADIUS,1,amount),scaleY:mix(ry/LOADING_RADIUS,1,amount),
    rotation:angle*(1-amount),translateX:center.x,translateY:center.y,
  });
  const initial=ellipse(0);
  const exactEllipse=start.every((node,i)=>(['point','in','out'] as const).every(key=>
    Math.hypot(node[key].x-initial[i][key].x,node[key].y-initial[i][key].y)<1e-5));
  if(!exactEllipse)return createFrameMorph(start,to);
  const forward=loadingFrameNodes(center),expand=createFrameMorph(forward,to);
  // A circle already faces forward regardless of how its anchors are rotated.
  const settle=Math.max(Math.abs(rx-LOADING_RADIUS),Math.abs(ry-LOADING_RADIUS))<1e-5?0:.24;
  return progress=>{
    const t=Number.isNaN(progress)?0:Math.max(0,Math.min(1,progress));
    if(t===0)return start;
    if(t===1)return expand(1);
    if(t<settle)return ellipse(ease(t/settle));
    return expand(ease((t-settle)/(1-settle)));
  };
}
