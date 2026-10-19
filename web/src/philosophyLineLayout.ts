import {
  layoutNextLineRange, materializeLineRange,
  type LayoutCursor, type LayoutLineRange, type PreparedTextWithSegments,
} from '@chenglou/pretext';

export type LineFlowLeaf = {
  prepared:PreparedTextWithSegments; lineHeight:number; top:number; left:number;
  width:number; naturalHeight:number; preserveWords?:boolean;
};
export type FlowLine = {
  leaf:number; left:number; top:number; width:number; text:string; separator:string; key:string;
  start:LayoutCursor; end:LayoutCursor;
};
type ContourOptions = {
  left:number; top:number; right:number; side:'left'|'right';
  query:(top:number,bottom:number)=>{left:number;right:number}|null;
  gap?:number;
};

const textCache = new WeakMap<PreparedTextWithSegments, Map<string,string>>();
const wordEndsCache = new WeakMap<PreparedTextWithSegments, Set<number>>();
const RANGE_CACHE_LIMIT = 512;
const MAX_BLOCKED_ROWS = 4096;
const VERTICAL_CLEARANCE = 4;
const rangeKey = (range:LayoutLineRange) =>
  `${range.start.segmentIndex}:${range.start.graphemeIndex}-${range.end.segmentIndex}:${range.end.graphemeIndex}`;

/** Preserve whitespace-delimited title words, including attached punctuation.
 * A segment boundary alone can still be inside a word in some languages/fonts. */
function endsWholeWord(prepared:PreparedTextWithSegments, range:LayoutLineRange):boolean {
  if (range.end.graphemeIndex !== 0) return false;
  let ends = wordEndsCache.get(prepared);
  if (!ends) {
    ends = new Set([prepared.segments.length]);
    for (let i=1;i<prepared.segments.length;i++) {
      if (/\s$/u.test(prepared.segments[i-1]) || /^\s/u.test(prepared.segments[i])
        || prepared.kinds[i-1] === 'hard-break' || prepared.kinds[i] === 'hard-break') ends.add(i);
    }
    wordEndsCache.set(prepared,ends);
  }
  return ends.has(range.end.segmentIndex);
}

function lineText(prepared:PreparedTextWithSegments, range:LayoutLineRange, key:string) {
  let cached = textCache.get(prepared);
  if (!cached) {cached = new Map(); textCache.set(prepared,cached);}
  const existing = cached.get(key);
  if (existing !== undefined) return existing;
  const text = materializeLineRange(prepared,range).text;
  if (cached.size >= RANGE_CACHE_LIMIT) cached.delete(cached.keys().next().value!);
  cached.set(key,text);
  return text;
}

/** Stream text through the actual contour, one line-height band at a time.
 * Preparation/font measurement belongs to the caller's cold path. Results are
 * relative to the block origin; every line keeps its authored side and padding.
 * A skipped row consumes height, never source text. Impossible lanes fail
 * explicitly rather than returning missing words or drawing through the shape.
 */
export function layoutContourText(leaves:LineFlowLeaf[], options:ContourOptions):{
  height:number; lines:FlowLine[]; leafHeights:number[]; leafTops:number[];
} {
  if (![options.left,options.top,options.right].every(Number.isFinite)
    || options.right <= options.left) throw new RangeError('Text flow requires a positive padded lane.');
  const gap = Math.max(0,options.gap ?? 24);
  if (!Number.isFinite(gap)) throw new RangeError('Text flow gap must be finite.');
  const lines:FlowLine[] = [], leafHeights:number[] = [], leafTops:number[] = [];
  let delta = 0, height = 0;
  leaves.forEach((leaf,index) => {
    if (![leaf.left,leaf.top,leaf.width,leaf.lineHeight,leaf.naturalHeight].every(Number.isFinite)
      || leaf.width <= 0 || leaf.lineHeight <= 0 || leaf.naturalHeight < 0)
      throw new RangeError('Text flow requires finite leaf metrics and positive line widths.');
    const originLeft = Math.max(options.left,options.left + leaf.left);
    const openWidth = Math.min(leaf.width,options.right - originLeft);
    if (openWidth <= 0) throw new RangeError('Text begins outside the padded lane.');
    const minimumWidth = Math.min(openWidth,120);
    const startTop = leaf.top + delta;
    leafTops.push(startTop);
    let rowTop = startTop, cursor:LayoutCursor|undefined, blockedRows = 0;
    while (true) {
      // First check exhaustion without letting a blocked final empty row add
      // height. Pretext returns null for empty text and after the last cursor.
      const remaining = layoutNextLineRange(leaf.prepared,openWidth,cursor);
      if (!remaining) break;
      // Pretext's keep-all still emergency-breaks long Latin segments. A title
      // waits for a wider contour band instead of leaving a trailing letter.
      // Fail immediately if even its unblocked lane cannot fit the next word.
      if (leaf.preserveWords && !endsWholeWord(leaf.prepared,remaining))
        throw new RangeError('The padded lane is narrower than one heading word.');
      const viewportTop = options.top + rowTop;
      const edge = options.query(viewportTop - VERTICAL_CLEARANCE,
        viewportTop + leaf.lineHeight + VERTICAL_CLEARANCE);
      let left = originLeft, right = Math.min(options.right,originLeft + leaf.width);
      if (edge) {
        if (![edge.left,edge.right].every(Number.isFinite))
          throw new RangeError('Text contour must return finite coordinates.');
        if (options.side === 'left') right = Math.min(right,edge.left - gap);
        else {
          left = Math.max(left,edge.right + gap);
          right = Math.min(options.right,left + leaf.width);
        }
      }
      const width = Math.max(0,right - left);
      const range = width >= minimumWidth ?
        (width === openWidth ? remaining : layoutNextLineRange(leaf.prepared,width,cursor)) : null;
      const splitsWord = leaf.preserveWords && range && !endsWholeWord(leaf.prepared,range);
      if (!range || range.width > width + .001 || splitsWord) {
        if (!edge && range && range.width > openWidth + .001)
          throw new RangeError('The padded lane is narrower than one text grapheme.');
        if (++blockedRows > MAX_BLOCKED_ROWS)
          throw new RangeError('The contour leaves no readable text lane.');
        rowTop += leaf.lineHeight;
        continue;
      }
      const key = rangeKey(range);
      if (cursor && range.end.segmentIndex === cursor.segmentIndex
        && range.end.graphemeIndex === cursor.graphemeIndex)
        throw new RangeError('The text cursor did not advance.');
      // Materialized ranges already retain spaces/tabs at ordinary wraps. Only
      // hard breaks are omitted from their text. Never synthesize a space when
      // the cursor continues the same word on the next painted line.
      const separator=range.end.graphemeIndex===0
        && leaf.prepared.kinds[range.end.segmentIndex-1]==='hard-break'?'\n':'';
      lines.push({leaf:index,left:left-options.left,top:rowTop,width:range.width,
        text:lineText(leaf.prepared,range,key),separator,key:`${index}:${key}`,
        start:range.start,end:range.end});
      cursor = range.end;
      rowTop += leaf.lineHeight;
      blockedRows = 0;
    }
    const leafHeight = rowTop - startTop;
    leafHeights.push(leafHeight);
    delta += leafHeight - leaf.naturalHeight;
    height = Math.max(height,rowTop);
  });
  return {height,lines,leafHeights,leafTops};
}
