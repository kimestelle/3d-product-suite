import {sampleCampaignReplacement} from './campaign-geometry/campaign-timing';

/** Scroll samples the guide's Pass score: close, exchange while closed,
 * reopen. Only the boundary moves; the image stays registered underneath.
 * The same offset reproduces the same pose in either direction. */
export function landingScrollPose(progress:number, quiet=false) {
  const value=Math.max(0,Math.min(5.3,Number.isFinite(progress)?progress:0));
  const from=Math.min(5,Math.floor(value));
  const turn=from===5?0:Math.max(0,Math.min(1,(value-from-.22)/.64));
  const replacement=sampleCampaignReplacement(turn);
  const index=Math.min(5,from+(replacement.owner==='to'?1:0));
  const opening=quiet?1:replacement.openness;
  return {index,from,turn,opening,phase:quiet?'held':replacement.phase,
    copy:quiet||![2,4].includes(from)?1:opening};
}
export const landingScrollStep=(height:number)=>Math.max(320,height*.68);
