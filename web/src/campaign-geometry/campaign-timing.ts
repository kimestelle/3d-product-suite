/** Designed light-inspired timings, not a physical light simulation.
 * Boundary motion is quick; scene ownership changes only behind a closed mask. */
const unit=(v:number)=>Math.max(0,Math.min(1,Number.isFinite(v)?v:0));
export const MOTION_TIMING={OPEN:240,SEARCH:480,REPLACE:320,OPENER:420,CLOSE:120,HOLD:16,REOPEN:184} as const;
export const easeLightOpen=(value:number)=>1-Math.pow(1-unit(value),3);
export const easeLightClose=(value:number)=>Math.pow(unit(value),3);
export const easeExposure=(value:number)=>(1-Math.exp(-6*unit(value)))/(1-Math.exp(-6));
export function sampleCampaignReplacement(progress:number,fromOpening=1,toOpening=1){
  const elapsed=unit(progress)*MOTION_TIMING.REPLACE;
  const from=unit(fromOpening),to=unit(toOpening);
  if(elapsed<MOTION_TIMING.CLOSE)return {openness:from*(1-easeLightClose(elapsed/MOTION_TIMING.CLOSE)),owner:'from' as const,phase:'closing' as const};
  if(elapsed<MOTION_TIMING.CLOSE+MOTION_TIMING.HOLD)return {openness:0,owner:elapsed<MOTION_TIMING.CLOSE+MOTION_TIMING.HOLD/2?'from' as const:'to' as const,phase:'closed' as const};
  return {openness:to*easeLightOpen((elapsed-MOTION_TIMING.CLOSE-MOTION_TIMING.HOLD)/MOTION_TIMING.REOPEN),owner:'to' as const,phase:'opening' as const};
}
