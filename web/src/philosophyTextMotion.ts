import type {PreparedTextWithSegments} from '@chenglou/pretext';
import type {FlowLine} from './philosophyLineLayout';
import type {ContourQuery} from './philosophyContour';

export type TextToken={key:string;text:string;start:number;end:number;advance:number;width:number};
export type TokenPosition={left:number;top:number;line:string};
export type TokenMotion={
  target:TokenPosition; shown:TokenPosition; offsetX:number; offsetY:number; started:number; active:boolean;
};
export const TEXT_REFLOW_DURATION=180;

/** Keep the source's words and their following spaces together. Pretext's
 * public widths already include each segment's kerning and internal tracking;
 * the gap between segments is the authored letter spacing. No hot-path font
 * or DOM measurement is needed. Complex scripts and emergency word breaks use
 * the original complete-line renderer so shaping/graphemes remain intact. */
export function prepareTextTokens(prepared:PreparedTextWithSegments,letterSpacing:number):TextToken[]|null {
  if(prepared.kinds.some(kind=>!['text','space','preserved-space','hard-break'].includes(kind))
    || prepared.segments.some(text=>/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\s]/u.test(text)))return null;
  const tokens:TextToken[]=[];
  for(let start=0;start<prepared.segments.length;){
    let end=start,advance=0,width=0,text='';
    if(prepared.kinds[start]==='hard-break')end++;
    else {
      // Adjacent text segments may be one word with punctuation. Never split it
      // just because the engine has an additional legal break opportunity.
      while(end<prepared.segments.length&&prepared.kinds[end]==='text')end++;
      while(end<prepared.segments.length&&['space','preserved-space'].includes(prepared.kinds[end]))end++;
    }
    if(end===start)return null;
    for(let i=start;i<end;i++){
      text+=prepared.segments[i];
      if(prepared.kinds[i]!=='hard-break'){
        advance+=prepared.widths[i]+letterSpacing;
        if(prepared.kinds[i]==='text')width=advance;
      }
    }
    tokens.push({key:`${start}:${end}`,text,start,end,advance,width:Math.max(0,width)});
    start=end;
  }
  return tokens;
}

/** A source-keyed layout, retaining the exact line range chosen by Pretext.
 * Returning null keeps emergency grapheme breaks on the complete-line path. */
export function placeTextTokens(tokens:readonly TextToken[],lines:readonly FlowLine[]):TokenPosition[]|null {
  const positions:TokenPosition[]=[];
  let index=0;
  for(const line of lines){
    if(line.start.graphemeIndex||line.end.graphemeIndex)return null;
    let left=line.left;
    const lineIdentity=`${line.start.segmentIndex}:${line.start.graphemeIndex}`;
    while(index<tokens.length&&tokens[index].start<line.end.segmentIndex){
      const token=tokens[index];
      if(token.start<line.start.segmentIndex||token.end>line.end.segmentIndex)return null;
      positions.push({left,top:line.top,line:lineIdentity});
      left+=token.advance;
      index++;
    }
  }
  return index===tokens.length?positions:null;
}

export function createTokenMotion(position:TokenPosition):TokenMotion {
  return {target:position,shown:position,offsetX:0,offsetY:0,started:0,active:false};
}

/** Reflow is an offset from the *current* contour layout, not a second follower
 * for scrolling. Horizontal contour changes remain synchronous. An interrupted
 * wrap starts at the last drawn position, never at a stale animation endpoint. */
export function updateTokenMotion(motion:TokenMotion,target:TokenPosition,now:number,animate:boolean):TokenPosition {
  if(!animate){
    motion.target=target;motion.shown=target;motion.active=false;
    motion.offsetX=motion.offsetY=0;
    return target;
  }
  // The edge of a flat-sided window can leave a line's vertical band in one
  // frame. Ease that discrete lane release too, without trailing small moves.
  const reflow=target.top!==motion.target.top||target.line!==motion.target.line
    || Math.abs(target.left-motion.target.left)>32;
  if(reflow){
    motion.offsetX=motion.shown.left-target.left;
    motion.offsetY=motion.shown.top-target.top;
    motion.started=now;
    motion.active=Math.abs(motion.offsetX)>.01||Math.abs(motion.offsetY)>.01;
  }
  motion.target=target;
  const progress=Math.max(0,Math.min(1,(now-motion.started)/TEXT_REFLOW_DURATION));
  if(progress>=1)motion.active=false;
  const remaining=motion.active?(1-progress)**3:0;
  motion.shown={...target,left:target.left+motion.offsetX*remaining,top:target.top+motion.offsetY*remaining};
  return motion.shown;
}

/** During a wrap a word may travel across a row, so checking only its final
 * line is insufficient. Project the displayed word into the current outside
 * lane. If the moving contour closes that entire row, settle the word at its
 * safe final line instead of clipping it behind the window. */
export function constrainTokenMotion(motion:TokenMotion,width:number,options:{
  left:number;top:number;right:number;minimumLeft:number;lineHeight:number;side:'left'|'right';query:ContourQuery;
}):TokenPosition {
  if(!motion.active||width===0)return motion.shown;
  const position=motion.shown;
  const edge=options.query(options.top+position.top-4,options.top+position.top+options.lineHeight+4);
  let left=options.minimumLeft,right=options.right-options.left;
  if(edge){
    if(options.side==='left')right=Math.min(right,edge.left-options.left-24);
    else left=Math.max(left,edge.right-options.left+24);
  }
  if(right-left<width){
    motion.shown=motion.target;motion.active=false;
    motion.offsetX=motion.offsetY=0;
  }else motion.shown={...position,left:Math.max(left,Math.min(position.left,right-width))};
  return motion.shown;
}
