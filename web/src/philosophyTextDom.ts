import {clearCache,prepareWithSegments,type PreparedTextWithSegments} from '@chenglou/pretext';
import {layoutContourText,type LineFlowLeaf} from './philosophyLineLayout';
import type {ContourQuery} from './philosophyContour';
import {prepareTextTokens,placeTextTokens,createTokenMotion,updateTokenMotion,constrainTokenMotion,
  type TextToken,type TokenMotion} from './philosophyTextMotion';

export type ContourTextCache=Map<string,PreparedTextWithSegments>;
type MountedToken={span:HTMLSpanElement;source:TextToken;motion:TokenMotion|null};
type MountedLeaf={element:HTMLElement;original:Node[];style:string|null;lines:HTMLSpanElement[];
  tokens:MountedToken[]|null;mode:'lines'|'tokens'|null;measure:LineFlowLeaf};
export type ContourTextBlock={leaves:MountedLeaf[];height:number};

/** Cold path only: read loaded type metrics before replacing the text with
 * selectable line spans. Original React-owned nodes are retained for cleanup. */
export function mountContourText(element:HTMLElement,rect:DOMRect,cache:ContourTextCache):ContourTextBlock {
  const nodes=element.matches('p,h1,h2')?[element]:[...element.querySelectorAll<HTMLElement>('p,h1,h2')];
  const leaves=nodes.map(leaf=>{
    const bounds=leaf.getBoundingClientRect(),style=getComputedStyle(leaf);
    const font=`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const lineHeight=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2;
    const letterSpacing=parseFloat(style.letterSpacing)||0;
    const text=[...leaf.childNodes].map(node=>node.nodeName==='BR'?'\n':node.textContent??'').join('');
    const whiteSpace=text.includes('\n')?'pre-wrap':'normal';
    const key=JSON.stringify([text,font,letterSpacing,whiteSpace]);
    let prepared=cache.get(key);
    if(!prepared){prepared=prepareWithSegments(text,font,{letterSpacing,whiteSpace});cache.set(key,prepared);}
    const tokens=prepareTextTokens(prepared,letterSpacing)?.map(source=>{
      const span=document.createElement('span');
      span.className='shape-light-text-token';span.textContent=source.text;span.dataset.source=source.key;
      return {span,source,motion:null};
    })??null;
    return {element:leaf,original:[...leaf.childNodes],style:leaf.getAttribute('style'),lines:[],tokens,mode:null,
      measure:{prepared,lineHeight,preserveWords:leaf.matches('h1,h2'),left:bounds.left-rect.left,top:bounds.top-rect.top,width:bounds.width,naturalHeight:bounds.height}};
  });
  const block:ContourTextBlock={leaves,height:rect.height};
  for(const leaf of leaves){leaf.element.replaceChildren();leaf.element.dataset.pretextLeaf='';}
  return block;
}

export function unmountContourText(block:ContourTextBlock|null) {
  if(!block)return;
  for(const leaf of block.leaves){
    leaf.element.replaceChildren(...leaf.original);delete leaf.element.dataset.pretextLeaf;
    if(leaf.style===null)leaf.element.removeAttribute('style');else leaf.element.setAttribute('style',leaf.style);
  }
}

export function contourTextMoving(block:ContourTextBlock|null):boolean {
  return Boolean(block?.leaves.some(leaf=>leaf.mode==='tokens'&&leaf.tokens?.some(token=>token.motion?.active)));
}

/** The warm path computes ranges and transforms stable source tokens. It never
 * rewrites a word at a normal wrap, measures layout, or starts a separate RAF.
 * The page's existing frame loop continues while contourTextMoving is true. */
export function paintContourText(block:ContourTextBlock,options:{left:number;top:number;right:number;side:'left'|'right';query:ContourQuery;animate?:boolean;now?:number}):number {
  const result=layoutContourText(block.leaves.map(leaf=>leaf.measure),options);
  const now=options.now??performance.now();
  const groups=block.leaves.map(()=>[] as typeof result.lines);
  for(const line of result.lines)groups[line.leaf].push(line);
  block.leaves.forEach((leaf,index)=>{
    const lines=groups[index],height=`${result.leafHeights[index]}px`;
    if(leaf.element.style.height!==height)leaf.element.style.height=height;
    const positions=leaf.tokens&&placeTextTokens(leaf.tokens.map(token=>token.source),lines);
    if(leaf.tokens&&positions){
      if(leaf.mode!=='tokens'){
        leaf.element.replaceChildren(...leaf.tokens.map(token=>token.span));leaf.mode='tokens';
        for(const token of leaf.tokens)token.motion=null;
      }
      leaf.tokens.forEach((token,i)=>{
        const target=positions[i];
        token.motion??=createTokenMotion(target);
        updateTokenMotion(token.motion,target,now,Boolean(options.animate));
        const shown=constrainTokenMotion(token.motion,token.source.width,{
          ...options,minimumLeft:leaf.measure.left,lineHeight:leaf.measure.lineHeight,
        });
        const transform=`translate(${shown.left-leaf.measure.left}px, ${shown.top-result.leafTops[index]}px)`;
        if(token.span.style.transform!==transform)token.span.style.transform=transform;
      });
      return;
    }
    // Preserve the original complete-line renderer for scripts with joining
    // behavior or emergency grapheme breaks. No glyph is sacrificed to motion.
    if(leaf.mode!=='lines'){
      leaf.element.replaceChildren(...leaf.lines);leaf.mode='lines';
      for(const token of leaf.tokens??[])token.motion=null;
    }
    lines.forEach((line,i)=>{
      let span=leaf.lines[i];
      if(!span){span=document.createElement('span');span.className='shape-light-text-line';leaf.lines.push(span);leaf.element.append(span);}
      // Whitespace between block lines preserves paragraph reading/copy order.
      if(span.dataset.range!==line.key){span.textContent=line.text+line.separator;span.dataset.range=line.key;}
      const transform=`translate(${line.left-leaf.measure.left}px, ${line.top-result.leafTops[index]}px)`;
      if(span.style.transform!==transform)span.style.transform=transform;
    });
    while(leaf.lines.length>lines.length)leaf.lines.pop()!.remove();
  });
  // The contents links occupy the authored left lane and stay in native flow
  // below the title. Treating their full grid column as a collision box made
  // empty space push all four anchors down in 24px jumps during scrolling.
  return block.height+result.height-(block.leaves.at(-1)!.measure.top+block.leaves.at(-1)!.measure.naturalHeight);
}

export function resetContourText(cache:ContourTextCache){cache.clear();clearCache();}
