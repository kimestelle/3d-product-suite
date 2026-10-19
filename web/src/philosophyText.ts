import {clearCache,layout,prepare,walkLineRanges,type PreparedText} from '@chenglou/pretext';

export type FlowRect={left:number;top:number;width:number;height:number};
export type FlowMetrics={height:number;lines:FlowRect[]};
export type TextMeasure={
  prepared:PreparedText;lineHeight:number;left:number;top:number;width:number;naturalHeight:number;
};
export type PreparedFlowBlock={height:number;texts:TextMeasure[]};
export type FlowTextCache=Map<string,PreparedText>;

/** Only this cold path reads typography or DOM boxes. A paragraph, caption and
 * heading keep their own Halyard metrics; margins and padding remain CSS-owned. */
export function prepareFlowText(element:HTMLElement,rect:DOMRect,cache:FlowTextCache):PreparedFlowBlock {
  const leaves=element.matches('p,h1,h2')?[element]:[...element.querySelectorAll<HTMLElement>('p,h1,h2')];
  const texts=leaves.map(leaf=>{
    const bounds=leaf.getBoundingClientRect(),style=getComputedStyle(leaf);
    const font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;
    const letterSpacing=parseFloat(style.letterSpacing)||0;
    // Explicit <br> stays explicit, without measuring or rewriting native text.
    const text=[...leaf.childNodes].map(node=>node.nodeName==='BR'?'\n':node.textContent??'').join('');
    const whiteSpace=text.includes('\n')?'pre-wrap':'normal';
    const key=JSON.stringify([text,font,letterSpacing,whiteSpace]);
    let prepared=cache.get(key);
    if(!prepared){prepared=prepare(text,font,{letterSpacing,whiteSpace});cache.set(key,prepared);}
    return {prepared,lineHeight,left:bounds.left-rect.left,top:bounds.top-rect.top,
      width:bounds.width,naturalHeight:bounds.height};
  });
  return {height:rect.height,texts};
}

/** Reflow measurements use prepared glyph widths, never the rendered document.
 * The natural DOM height calibrates balanced headings; only added/removed lines
 * shift the following text. Native links and all structural gaps stay intact. */
export function measureFlowText(block:PreparedFlowBlock,width:number):FlowMetrics {
  let delta=0;
  const lines:FlowRect[]=[];
  const available=Number.isFinite(width)?Math.max(1,width):1;
  for(const text of block.texts) {
    const lineWidth=Math.max(1,Math.min(text.width,available-text.left));
    let count=0;
    walkLineRanges(text.prepared,lineWidth,range=>{
      lines.push({left:text.left,top:text.top+delta+count*text.lineHeight,width:range.width,height:text.lineHeight});
      count++;
    });
    const natural=layout(text.prepared,Math.max(1,text.width),text.lineHeight).height;
    delta+=count*text.lineHeight-natural;
  }
  return {height:Math.max(0,block.height+delta),lines};
}

/** A newly loaded face invalidates both our handles and Pretext's glyph cache. */
export function resetFlowText(cache:FlowTextCache) {cache.clear();clearCache();}
