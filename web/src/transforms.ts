import {Euler, Quaternion} from 'three';

export type TransformTarget = {kind:'product'} | {kind:'part';componentId:string};
export type TransformMode = 'translate' | 'rotate' | 'scale';
export type TransformAxis = 'x' | 'y' | 'z';
export const TRANSFORM_SCALE_MIN = .01;
export const TRANSFORM_SCALE_MAX = 100;

export function transformTargetKey(target:TransformTarget|null):string {
  return target?.kind === 'part' ? `part:${target.componentId}` : target?.kind ?? '';
}

function targetTransform(scene:any,target:TransformTarget):any {
  const transform = target.kind === 'product' ? scene?.placement
    : scene?.product?.components?.find((part:any)=>part.id === target.componentId)?.assembly;
  if (!transform) throw new Error('The selected component is no longer available.');
  return transform;
}

export function supportsTransform(scene:any,target:TransformTarget|null,mode:TransformMode):boolean {
  if (!target || mode === 'rotate' && target.kind === 'product') return false;
  try {targetTransform(scene,target); return true;} catch {return false;}
}

/** amount is metres for movement, degrees for rotation, and a multiplier for scale. */
export function transformScene(scene:any,target:TransformTarget,mode:TransformMode,axis:TransformAxis,amount:number):any {
  if (!Number.isFinite(amount)) throw new Error('Enter a finite transform value.');
  if (!supportsTransform(scene,target,mode)) throw new Error(mode === 'rotate' && target.kind === 'product'
    ? 'Select a part to rotate. Whole-product rotation is not available.' : 'Select a component to transform.');
  const next = structuredClone(scene);
  if (mode === 'scale' && amount === 1 || mode === 'rotate' && amount % 360 === 0) return next;
  const transform = targetTransform(next,target);
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  if (mode === 'translate') {
    transform.translationM[index] += amount;
    if (!Number.isFinite(transform.translationM[index])) throw new Error('Position must be a finite value.');
  } else if (mode === 'rotate') {
    const euler = new Euler().setFromQuaternion(new Quaternion().fromArray(transform.rotationXyzw),'XYZ');
    euler[axis] += (amount % 360)*Math.PI/180;
    transform.rotationXyzw = new Quaternion().setFromEuler(euler).toArray();
  } else {
    if (amount <= 0) throw new Error('Scale must be greater than zero.');
    const scale = (transform.scale ?? 1)*amount;
    if (scale < TRANSFORM_SCALE_MIN || scale > TRANSFORM_SCALE_MAX) throw new Error('Scale must stay between 1% and 10000% of the original size.');
    transform.scale = scale;
  }
  return next;
}

/** Commit only the manipulated fields, preserving unrelated state in the destination. */
export function copyTransform(destination:any,preview:any,target:TransformTarget,mode:TransformMode):void {
  const from = targetTransform(preview,target), to = targetTransform(destination,target);
  if (mode === 'translate') to.translationM = [...from.translationM];
  else if (mode === 'rotate') to.rotationXyzw = [...from.rotationXyzw];
  else to.scale = from.scale ?? 1;
}

export function typedTransformAmount(mode:TransformMode,text:string):number|null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || mode === 'scale' && number <= 0) return null;
  return mode === 'translate' ? number/1000 : number;
}

export function nudgeTransformAmount(mode:TransformMode,value:number,direction:1|-1,fine=false):number {
  const step = (mode === 'translate' ? .001 : mode === 'rotate' ? 1 : .01)*(fine ? .1 : 1);
  const next = Number((value+direction*step).toFixed(12));
  return mode === 'scale' ? Math.max(.0001,next) : next;
}

export type TransformKeyIntent = {type:'start';mode:TransformMode} | {type:'axis';axis:TransformAxis}
  | {type:'nudge';direction:1|-1;fine:boolean} | {type:'type';key:string}
  | {type:'confirm'} | {type:'cancel'};
export type TransformKeyInput = Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'altKey'|'shiftKey'|'repeat'|'isComposing'> & {editable?:boolean};

/** Pure key routing, shared by the viewport interaction and its conflict tests. */
export function transformKeyIntent(event:TransformKeyInput,active:boolean):TransformKeyIntent|null {
  if (event.editable || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (active) {
    if (key === 'escape') return {type:'cancel'};
    if (key === 'enter' && !event.repeat) return {type:'confirm'};
    if (key === 'arrowright' || key === 'arrowup') return {type:'nudge',direction:1,fine:event.shiftKey};
    if (key === 'arrowleft' || key === 'arrowdown') return {type:'nudge',direction:-1,fine:event.shiftKey};
    if (key === 'x' || key === 'y' || key === 'z') return {type:'axis',axis:key};
    if (/^[0-9.+-]$/.test(key) || key === 'backspace') return {type:'type',key};
  }
  if (!event.repeat && !event.shiftKey) {
    if (key === 'g') return {type:'start',mode:'translate'};
    if (key === 'r') return {type:'start',mode:'rotate'};
    if (key === 's') return {type:'start',mode:'scale'};
  }
  return null;
}

/** Re-anchored pointer samples preserve the current amount when precision changes. */
export function pointerTransformAmount(mode:TransformMode,base:number,sample:number,fine=false):number {
  const precision = fine ? .1 : 1;
  return mode === 'scale' ? base*Math.pow(sample,precision) : base+sample*precision;
}

export function rotationSampleDelta(previous:number,next:number):number {
  let delta = next-previous;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}
