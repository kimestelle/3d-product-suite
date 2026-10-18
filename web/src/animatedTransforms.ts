import {getPropertyValue,getTrack,writeProperty,PRODUCT_TARGET,type KeyframeProperty} from './keyframes';
import {copyTransform,transformScene,type TransformAxis,type TransformMode,type TransformTarget} from './transforms';

/** Modal transforms remain transient; only their manipulated channel is keyed on Apply. */
export function animatedTransformScene(scene:any,target:TransformTarget,mode:TransformMode,axis:TransformAxis,amount:number,frame:number):any {
  const id=target.kind==='product'?PRODUCT_TARGET:target.componentId;
  const property:KeyframeProperty=mode==='scale'?'scale':`${mode==='translate'?'position':'rotation'}.${axis}`;
  if(!getTrack(scene,id,property)?.enabled)return transformScene(scene,target,mode,axis,amount);
  const next=structuredClone(scene);
  if(mode==='scale'&&amount===1||mode==='rotate'&&amount===0||mode==='translate'&&amount===0)return next;
  const base=getPropertyValue(scene,id,property,frame);
  writeProperty(next,id,property,frame,mode==='scale'?base*amount:base+amount);
  return next;
}

export function copyAnimatedTransform(destination:any,preview:any,target:TransformTarget,mode:TransformMode,axis:TransformAxis,frame:number):void {
  const id=target.kind==='product'?PRODUCT_TARGET:target.componentId;
  const property:KeyframeProperty=mode==='scale'?'scale':`${mode==='translate'?'position':'rotation'}.${axis}`;
  if(getTrack(destination,id,property)?.enabled)writeProperty(destination,id,property,frame,getPropertyValue(preview,id,property,frame));
  else copyTransform(destination,preview,target,mode);
}
