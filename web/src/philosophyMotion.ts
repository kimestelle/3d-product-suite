/** The actual scroll offset is the single playhead for text and contour.
 * Stops retain fractional layout coordinates, including the header inset.
 */
export function philosophyScrollProgress(scroll:number,stops:readonly number[]):number {
  if(stops.length<2||!Number.isFinite(scroll)||scroll<=stops[0])return 0;
  for(let i=0;i<stops.length-1;i++) {
    if(scroll<stops[i+1])return i+(scroll-stops[i])/(stops[i+1]-stops[i]);
  }
  return stops.length-1;
}

const clamp=(value:number,low:number,high:number)=>Math.max(low,Math.min(high,value));
export type ScrollSettle={from:number;to:number;start:number;duration:number;tangent:number};

/** Project only within the neighboring poses. A decisive gesture can leave its
 * starting pose; a slow stop chooses the closest one, including in reverse. */
export function choosePhilosophyStop(position:number,velocity:number,origin:number,stops:readonly number[],maximum:number):number {
  const points=[...new Set(stops.map(stop=>clamp(stop,0,maximum)))];
  if(!points.length)return position;
  const lower=points.filter(stop=>stop<=position).at(-1)??points[0];
  const upper=points.find(stop=>stop>position)??points.at(-1)!;
  const gap=Math.max(1,upper-lower);
  const projected=position+clamp(velocity*200,-gap*.45,gap*.45);
  let target=points.reduce((best,stop)=>Math.abs(stop-projected)<Math.abs(best-projected)?stop:best,points[0]);
  const startedAt=points.find(stop=>Math.abs(stop-origin)<=4);
  const direction=Math.sign(position-origin);
  if(startedAt!==undefined&&target===startedAt&&direction&&Math.sign(velocity)===direction&&Math.abs(velocity)>.08) {
    const neighbor=direction>0?points.find(stop=>stop>startedAt):points.filter(stop=>stop<startedAt).at(-1);
    if(neighbor!==undefined&&Math.abs(position-origin)>=Math.min(80,Math.abs(neighbor-startedAt)*.12))target=neighbor;
  }
  return target;
}

/** Quintic endpoint interpolation: bounded initial velocity, zero final
 * velocity/acceleration, no overshoot or spring. Always starts where we are. */
export function createScrollSettle(from:number,to:number,velocity:number,start:number):ScrollSettle {
  const distance=to-from;
  let duration=clamp(280+Math.abs(distance)*.35,320,620);
  if(distance*velocity>0)duration=Math.min(duration,Math.max(120,2*Math.abs(distance/velocity)));
  const tangent=distance?clamp(velocity*duration/distance,0,2):0;
  return {from,to,start,duration,tangent};
}
export function scrollSettlePosition(plan:ScrollSettle,now:number):number {
  const t=clamp((now-plan.start)/plan.duration,0,1);
  const ease=t*t*t*(10+t*(-15+6*t));
  const velocity=t+t*t*t*(-6+t*(8-3*t));
  return plan.from+(plan.to-plan.from)*(ease+plan.tangent*velocity);
}
