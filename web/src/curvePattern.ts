import {CURVE_PRESETS, CURVE_PRESET_ALIASES} from './curvePresets';
import {createFrameTransition} from './frameMorph';
import type {FrameNodes} from './frameGeometry';

export const DEFAULT_CURVE_PATTERN = ['studio-cross','studio-circle','studio-landing'] as const;
export const MAX_CURVE_PATTERN_LENGTH = 64;
const presets = new Map(CURVE_PRESETS.map(preset=>[preset.id,preset]));
const clamp = (value:number) => Number.isFinite(value)?Math.max(0,Math.min(1,value)):0;
const durationOrDefault = (value:number) => [1200,2400,4800].includes(value)?value:2400;
const resolve = (id:string|null) => {
  const candidate=id?.trim();
  return candidate ? CURVE_PRESET_ALIASES[candidate]??candidate : '';
};
const validIds = (ids:readonly string[]) => ids.map(resolve).filter(id=>presets.has(id)).slice(0,MAX_CURVE_PATTERN_LENGTH);

export type CurvePatternState = {ids:string[];progress:number;duration:number;loop:boolean};
export type CurvePatternSample = {nodes:FrameNodes;from:number;to:number;localProgress:number};

/** Links save the ordered pattern, including repeats. Two-shape links retain
 * their original endpoints and normalized progress when first opened. */
export function readCurvePattern(search:string):CurvePatternState {
  const params=new URLSearchParams(search);
  let ids:string[];
  if(params.has('pattern'))ids=validIds((params.get('pattern')??'').split(','));
  else if(params.has('a')||params.has('b')){
    const a=resolve(params.get('a')),b=resolve(params.get('b'));
    ids=[presets.has(a)?a:'studio-cross',presets.has(b)?b:'studio-landing'];
  } else ids=[...DEFAULT_CURVE_PATTERN];
  return {
    ids:ids.length?ids:[...DEFAULT_CURVE_PATTERN],
    progress:clamp(Number(params.get('t')??0)),
    duration:durationOrDefault(Number(params.get('duration'))),
    loop:params.get('loop')==='1',
  };
}

/** Compile only when the sequence changes. The closing loop is a real morph,
 * and each leg uses the production 30% size envelope. No extra renderer. */
export function compileCurvePattern(ids:readonly string[],loop:boolean) {
  const normalized=validIds(ids),sequence=normalized.length?normalized:[...DEFAULT_CURVE_PATTERN];
  const nodes=sequence.map(id=>presets.get(id)!.nodes);
  const legs=nodes.length<2?0:loop?nodes.length:nodes.length-1;
  const cache=new Map<string,ReturnType<typeof createFrameTransition>>();
  const morphs=Array.from({length:legs},(_,index)=>{
    const next=(index+1)%nodes.length,key=`${sequence[index]}:${sequence[next]}`;
    let morph=cache.get(key);
    if(!morph){
      // A repeated entry is a hold, including its visible construction anchors.
      morph=sequence[index]===sequence[next]?()=>nodes[index]:createFrameTransition(nodes[index],nodes[next],.3);
      cache.set(key,morph);
    }
    return morph;
  });
  return {legs,sample(progress:number):CurvePatternSample {
    if(!legs)return {nodes:nodes[0],from:0,to:0,localProgress:0};
    const position=clamp(progress)*legs,from=Math.min(legs-1,Math.floor(position));
    const localProgress=position-from,to=(from+1)%nodes.length;
    const eased=localProgress*localProgress*(3-2*localProgress);
    return {nodes:morphs[from](eased),from,to,localProgress};
  }};
}

/** Elapsed time crosses any number of leg boundaries without dropping time.
 * Hidden-tab pauses are owned by the component, not a second animation clock. */
export function advancePatternProgress(progress:number,elapsedMs:number,duration:number,legs:number,direction:1|-1,loop:boolean):{progress:number;done:boolean} {
  const current=clamp(progress);
  if(!Number.isFinite(legs)||legs<=0)return {progress:current,done:true};
  const elapsed=Number.isFinite(elapsedMs)?Math.max(0,elapsedMs):0;
  if(elapsed===0)return {progress:current,done:!loop&&(direction===1?current===1:current===0)};
  const total=durationOrDefault(duration)*legs;
  const next=current+elapsed/total*direction;
  if(loop)return {progress:((next%1)+1)%1,done:false};
  return {progress:clamp(next),done:direction===1?next>=1:next<=0};
}

export function reorderPattern<T>(ids:readonly T[],from:number,to:number):T[] {
  const next=[...ids];
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=next.length||to>=next.length||from===to)return next;
  const [id]=next.splice(from,1);next.splice(to,0,id);return next;
}
