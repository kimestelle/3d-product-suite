import {clearCache,prepareWithSegments,type PreparedTextWithSegments} from '@chenglou/pretext';
import {layoutContourText,type FlowLine,type LineFlowLeaf} from './philosophyLineLayout';
import type {ContourQuery} from './philosophyContour';

export type ContourTextCache=Map<string,PreparedTextWithSegments>;
type MountedLine={span:HTMLSpanElement;source:Readonly<FlowLine>;shownX:number};
type MountedLeaf={element:HTMLElement;original:Node[];style:string|null;lines:MountedLine[];
  measure:LineFlowLeaf;height:number;top:number;alignRight:boolean};
export type ContourTextBlock={leaves:MountedLeaf[];height:number;width:number;blockedLines:number};
type PaintOptions={left:number;top:number;right?:number;laneLeft?:number;laneRight?:number;
  side:'left'|'right';query:ContourQuery;animate?:boolean;now?:number};
const GAP=24,VERTICAL_CLEARANCE=4,SOFT_SHOULDER=64;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(value,max));

/** Measure and wrap once, after fonts load or the reading width changes. Every
 * line keeps its source range, baseline and selectable span until cleanup. */
export function mountContourText(element:HTMLElement,rect:DOMRect,cache:ContourTextCache):ContourTextBlock {
  const nodes=element.matches('p,h1,h2')?[element]:[...element.querySelectorAll<HTMLElement>('p,h1,h2')];
  const leaves:MountedLeaf[]=nodes.map(leaf=>{
    const bounds=leaf.getBoundingClientRect(),style=getComputedStyle(leaf);
    const font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;
    const letterSpacing=parseFloat(style.letterSpacing)||0;
    const text=[...leaf.childNodes].map(node=>node.nodeName==='BR'?'\n':node.textContent??'').join('');
    const whiteSpace=text.includes('\n')?'pre-wrap':'normal';
    const key=JSON.stringify([text,font,letterSpacing,whiteSpace]);
    let prepared=cache.get(key);
    if(!prepared){prepared=prepareWithSegments(text,font,{letterSpacing,whiteSpace});cache.set(key,prepared);}
    return {element:leaf,original:[...leaf.childNodes],style:leaf.getAttribute('style'),lines:[],height:0,top:0,alignRight:style.textAlign==='right',
      measure:{prepared,lineHeight,left:bounds.left-rect.left,top:bounds.top-rect.top,width:bounds.width,naturalHeight:bounds.height}};
  });
  const width=Math.max(rect.width,...leaves.map(leaf=>leaf.measure.left+leaf.measure.width));
  const layout=layoutContourText(leaves.map(leaf=>leaf.measure),{left:0,top:0,right:width,side:'left',query:()=>null});
  for(const line of layout.lines){
    const leaf=leaves[line.leaf],span=document.createElement('span');
    span.className='shape-light-text-line';span.textContent=line.text+line.separator;span.dataset.range=line.key;
    span.style.width=`${line.width}px`;
    span.style.top=`${line.top-layout.leafTops[line.leaf]}px`;
    span.style.transform='translateX(0px)';
    leaf.lines.push({span,source:Object.freeze(line),shownX:0});
  }
  leaves.forEach((leaf,index)=>{
    leaf.height=layout.leafHeights[index];leaf.top=layout.leafTops[index];
    leaf.element.replaceChildren(...leaf.lines.map(line=>line.span));leaf.element.dataset.pretextLeaf='';
    leaf.element.style.height=`${leaf.height}px`;
  });
  const last=leaves.at(-1);
  const height=last?rect.height+layout.height-(last.measure.top+last.measure.naturalHeight):rect.height;
  return {leaves,height,width,blockedLines:0};
}

export function unmountContourText(block:ContourTextBlock|null) {
  if(!block)return;
  for(const leaf of block.leaves){
    leaf.element.replaceChildren(...leaf.original);delete leaf.element.dataset.pretextLeaf;
    if(leaf.style===null)leaf.element.removeAttribute('style');else leaf.element.setAttribute('style',leaf.style);
  }
}

/** Position is a function of the current contour, with no trailing animation. */
export function contourTextMoving(_block:ContourTextBlock|null):boolean {return false;}

function contact(query:ContourQuery,top:number,bottom:number) {
  const exact=query(top,bottom);
  if(exact)return {edge:exact,weight:1,hard:true};
  if(!query(top-SOFT_SHOULDER,bottom+SOFT_SHOULDER))return null;
  // Near a flat top/bottom, ease the displacement over a vertical shoulder.
  // Binary search finds actual distance rather than quantizing whole rows.
  let low=0,high=SOFT_SHOULDER;
  for(let step=0;step<12;step++){
    const distance=(low+high)/2;
    if(query(top-distance,bottom+distance))high=distance;else low=distance;
  }
  const edge=query(top-high,bottom+high);
  if(!edge)return null;
  const t=1-high/SOFT_SHOULDER;
  return {edge,weight:t*t*(3-2*t),hard:false};
}

/** The warm path only translates complete lines horizontally. No font/layout
 * reads, new wraps, vertical offsets, text writes or height changes occur. */
export function paintContourText(block:ContourTextBlock,options:PaintOptions):number {
  const laneLeft=options.laneLeft??options.left;
  const laneRight=options.laneRight??options.right??options.left+block.width;
  block.blockedLines=0;
  for(const leaf of block.leaves)for(const line of leaf.lines){
    const source=line.source,anchor=options.left+source.left+(leaf.alignRight?leaf.measure.width-source.width:0);
    const maximum=laneRight-source.width;
    const bandTop=options.top+source.top-VERTICAL_CLEARANCE;
    const bandBottom=options.top+source.top+leaf.measure.lineHeight+VERTICAL_CLEARANCE;
    const collision=contact(options.query,bandTop,bandBottom);
    let target=anchor,min=laneLeft,max=maximum;
    if(collision){
      const edge=options.side==='left'?collision.edge.left-GAP-source.width:collision.edge.right+GAP;
      const displaced=options.side==='left'?Math.min(anchor,edge):Math.max(anchor,edge);
      target=anchor+(displaced-anchor)*collision.weight;
      if(collision.hard){
        if(options.side==='left')max=Math.min(max,edge);else min=Math.max(min,edge);
      }
    }
    if(max<min){
      // Geometry must leave a complete-line lane. Keep every word in the
      // interior region and expose the conflict instead of rewrapping/hiding.
      block.blockedLines++;
      target=options.side==='left'?laneLeft:Math.max(laneLeft,maximum);
    }else target=clamp(target,min,max);
    const x=target-(options.left+leaf.measure.left);
    if(x!==line.shownX){line.span.style.transform=`translateX(${x}px)`;line.shownX=x;}
  }
  return block.height;
}

export function resetContourText(cache:ContourTextCache){cache.clear();clearCache();}
