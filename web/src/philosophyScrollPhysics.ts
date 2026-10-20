/** One scroll position and velocity move through the landscape shown by the
 * debugger. Units are pixels, seconds and milliseconds for input times. */
export type ScrollTuning={enabled:boolean;pull:number;damping:number;response:number};
export const DEFAULT_SCROLL_TUNING:ScrollTuning={enabled:false,pull:10,damping:1,response:16};
export type ScrollParticle={position:number;velocity:number;lastInput:number;blockedStop:number|null;direction:number;goal?:number|null};
const clamp=(value:number,low:number,high:number)=>Math.max(low,Math.min(high,value));
const finite=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
const maximumOf=(maximum:number)=>Math.max(0,finite(maximum,0));
const MAX_VELOCITY=12000;
const INPUT_RELEASE_SECONDS=.08;
const MAX_ELAPSED_SECONDS=1/15;
const MAX_SUBSTEP_SECONDS=1/120;
const POSITION_EPSILON=.16;
// DOM scrollTop can round a settled fractional stop to a device-pixel boundary.
const DEPARTURE_EPSILON=1;
const VELOCITY_EPSILON=.6;

export function normalizeScrollTuning(partial:Partial<ScrollTuning>={}):ScrollTuning {
  return {enabled:typeof partial.enabled==='boolean'?partial.enabled:DEFAULT_SCROLL_TUNING.enabled,
    pull:clamp(finite(partial.pull,DEFAULT_SCROLL_TUNING.pull),4,18),
    damping:clamp(finite(partial.damping,DEFAULT_SCROLL_TUNING.damping),.7,1.5),
    response:clamp(finite(partial.response,DEFAULT_SCROLL_TUNING.response),8,28)};
}
export function normalizeStops(stops:readonly number[],maximum:number):number[] {
  const max=maximumOf(maximum);
  return [...new Set(stops.filter(Number.isFinite).map(stop=>clamp(stop,0,max)))].sort((a,b)=>a-b);
}
export function createScrollParticle(position:number,now:number):ScrollParticle {
  return {position:finite(position,0),velocity:0,lastInput:finite(now,0),blockedStop:null,direction:0,goal:null};
}
function nearestStop(position:number,points:readonly number[],direction=0):number|null {
  if(!points.length)return null;
  let target=points[0];
  for(let i=1;i<points.length;i++){
    const distance=Math.abs(points[i]-position),previous=Math.abs(target-position);
    if(distance<previous||(distance===previous&&direction>0))target=points[i];
  }
  return target;
}
function intervalAt(position:number,points:readonly number[]):{left:number;right:number}|null {
  for(let i=0;i<points.length-1;i++){
    if(position>=points[i]&&position<=points[i+1])return {left:points[i],right:points[i+1]};
  }
  return null;
}
/** Plot potential is dimensionless (0 = valley, 1 = crest), gradient is per px.
 * Physical height is pull² * interval² / 32, giving equal valley curvature. */
export function sampleScrollLandscape(position:number,stops:readonly number[],maximum:number):{potential:number;gradient:number;target:number|null} {
  const points=normalizeStops(stops,maximum),x=clamp(finite(position,0),0,maximumOf(maximum));
  const interval=intervalAt(x,points),target=nearestStop(x,points);
  if(!interval)return {potential:0,gradient:0,target};
  const length=interval.right-interval.left,t=clamp((x-interval.left)/length,0,1);
  return {potential:16*t*t*(1-t)*(1-t),gradient:32*t*(1-t)*(1-2*t)/length||0,target};
}
function sanitize(state:ScrollParticle,maximum:number):ScrollParticle {
  return {position:clamp(finite(state.position,0),0,maximumOf(maximum)),
    velocity:clamp(finite(state.velocity,0),-MAX_VELOCITY,MAX_VELOCITY),
    lastInput:finite(state.lastInput,0),blockedStop:state.blockedStop!==null&&Number.isFinite(state.blockedStop)?state.blockedStop:null,
    direction:Math.sign(finite(state.direction,0)),goal:state.goal!==undefined&&state.goal!==null&&Number.isFinite(state.goal)?clamp(state.goal,0,maximumOf(maximum)):null};
}

export function pushScrollParticle(state:ScrollParticle,delta:number,now:number,stops:readonly number[],maximum:number,tuning:ScrollTuning):ScrollParticle {
  const next=sanitize(state,maximum),settings=normalizeScrollTuning(tuning),amount=finite(delta,0);
  if(!amount)return next;
  const direction=Math.sign(amount),points=normalizeStops(stops,maximum);
  next.goal=null;
  if(!settings.enabled)return {...next,position:clamp(next.position+amount,0,maximumOf(maximum)),velocity:0,lastInput:finite(now,next.lastInput),blockedStop:null,direction};
  if(next.blockedStop!==null&&!points.includes(next.blockedStop))next.blockedStop=null;
  if(next.blockedStop!==null&&direction===Math.sign(next.blockedStop-next.position))next.blockedStop=null;
  const nearest=nearestStop(next.position,points,direction);
  if(nearest!==null&&Math.abs(next.position-nearest)<=DEPARTURE_EPSILON&&Math.abs(next.velocity)<=VELOCITY_EPSILON)next.blockedStop=nearest;
  // Opposing input takes control without first cancelling old momentum.
  const prior=Math.sign(next.velocity)!==direction?0:next.velocity;
  next.velocity=clamp(prior+amount*settings.response,-MAX_VELOCITY,MAX_VELOCITY);
  next.direction=direction;next.lastInput=finite(now,next.lastInput);
  return next;
}

type ForceSample={target:number|null;force:number;drag:number};
function sampleForce(position:number,state:ScrollParticle,points:readonly number[],now:number,settings:ScrollTuning):ForceSample {
  const omegaSquared=settings.pull*settings.pull;
  if(state.goal!==undefined&&state.goal!==null)return {target:state.goal,force:-omegaSquared*(position-state.goal),drag:2*settings.pull*settings.damping};
  const target=nearestStop(position,points,state.direction);
  if(target===null||target===state.blockedStop)return {target:null,force:0,drag:settings.response};
  const release=1-Math.exp(-Math.max(0,now-state.lastInput)/(INPUT_RELEASE_SECONDS*1000));
  const interval=intervalAt(position,points);
  let force:number,wellDepth=1;
  if(interval){
    const length=interval.right-interval.left,t=(position-interval.left)/length;
    force=-omegaSquared*length*t*(1-t)*(1-2*t);
    wellDepth=1-16*t*t*(1-t)*(1-t);
    // An exact crest is unstable: retain input direction rather than get stuck.
    if(Math.abs(t-.5)<1e-9)force=(state.direction||-1)*.001;
  }else force=-omegaSquared*(position-target);
  return {target,force:force*release,
    drag:settings.response+(2*settings.pull*settings.damping-settings.response)*release*wellDepth};
}
function releaseBlocked(state:ScrollParticle,points:readonly number[]){
  if(state.blockedStop!==null&&nearestStop(state.position,points,state.direction)!==state.blockedStop)state.blockedStop=null;
}

/** Bounded midpoint substeps preserve the trajectory across refresh rates. A
 * stalled tab resumes its last visible position rather than simulating a leap. */
export function stepScrollParticle(state:ScrollParticle,elapsedSeconds:number,now:number,stops:readonly number[],maximum:number,tuning:ScrollTuning):{state:ScrollParticle;active:boolean;target:number|null;force:number} {
  const next=sanitize(state,maximum),settings=normalizeScrollTuning(tuning),points=normalizeStops(stops,maximum),max=maximumOf(maximum);
  if(!settings.enabled)return {state:{...next,velocity:0,blockedStop:null,goal:null},active:false,target:null,force:0};
  if(next.blockedStop!==null&&!points.includes(next.blockedStop))next.blockedStop=null;
  const elapsed=clamp(finite(elapsedSeconds,0),0,MAX_ELAPSED_SECONDS),time=finite(now,next.lastInput);
  const count=Math.max(1,Math.ceil(elapsed/MAX_SUBSTEP_SECONDS)),dt=elapsed/count;
  let sample=sampleForce(next.position,next,points,time-elapsed*1000,settings);
  for(let i=0;i<count;i++){
    releaseBlocked(next,points);
    const at=time-(elapsed-i*dt)*1000;
    sample=sampleForce(next.position,next,points,at,settings);
    const acceleration=sample.force-sample.drag*next.velocity;
    const middlePosition=next.position+next.velocity*dt/2;
    const middleVelocity=next.velocity+acceleration*dt/2;
    const middle=sampleForce(middlePosition,next,points,at+dt*500,settings);
    next.position+=middleVelocity*dt;
    next.velocity=clamp(next.velocity+(middle.force-middle.drag*middleVelocity)*dt,-MAX_VELOCITY,MAX_VELOCITY);
    if(next.position<=0){next.position=0;if(next.velocity<0)next.velocity=0;}
    if(next.position>=max){next.position=max;if(next.velocity>0)next.velocity=0;}
  }
  releaseBlocked(next,points);
  sample=sampleForce(next.position,next,points,time,settings);
  if(sample.target!==null&&Math.abs(next.position-sample.target)<=POSITION_EPSILON&&Math.abs(next.velocity)<=VELOCITY_EPSILON){
    next.position=sample.target;next.velocity=0;next.goal=null;
    return {state:next,active:false,target:sample.target,force:0};
  }
  if(sample.target===null&&Math.abs(next.velocity)<=VELOCITY_EPSILON){
    next.velocity=0;return {state:next,active:false,target:null,force:0};
  }
  return {state:next,active:true,target:sample.target,force:sample.force};
}
