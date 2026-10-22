import {partPose,partTargetIds} from './partTargets';
import {Euler, Quaternion} from 'three';
import {displayPartName} from './hierarchy';
import {PRODUCT_SCALE_RANGE_MESSAGE,transformScaleLimits,type TransformAxis,type TransformMode,type TransformTarget} from './transforms';

export type KeyframeProperty = 'position.x'|'position.y'|'position.z'|'rotation.x'|'rotation.y'|'rotation.z'|'scale'|'motion';
export type KeyframeInterpolation = 'linear'|'ease'|'hold';
export interface AnimationKey {frame:number;value:number;interpolation:KeyframeInterpolation}
export interface AnimationTrack {id:string;componentId:string;property:KeyframeProperty;enabled:boolean;keys:AnimationKey[]}
export const PRODUCT_TARGET = '$product';
export const TRANSFORM_PROPERTIES:KeyframeProperty[] = ['position.x','position.y','position.z','rotation.x','rotation.y','rotation.z','scale'];
const AXES = ['x','y','z'] as const;
const smooth = (value:number) => {const u=Math.max(0,Math.min(1,value));return u*u*(3-2*u);};
export const lastAnimationFrame = (scene:any):number => scene.shots?.at(-1)?.endFrame ?? 1;
export const animationTracks = (scene:any):AnimationTrack[] => scene.animation?.tracks ?? [];
export const getTrack = (scene:any,componentId:string,property:KeyframeProperty):AnimationTrack|undefined => animationTracks(scene).find(track=>track.componentId===componentId&&track.property===property);
export const getMotion = (scene:any,componentId:string):any => scene.actions?.find((action:any)=>action.componentId===componentId);

/** Parent-relative mechanics currently require a static reference component. */
export function animationBlockReason(scene:any,componentId:string,_property:KeyframeProperty):string|null {
  if(componentId===PRODUCT_TARGET)return null;
  const dependent=scene.actions?.find((action:any)=>action.relativeTo===componentId);
  if(!dependent)return null;
  const name=(id:string)=>displayPartName(scene,id);
  return `${name(componentId)} anchors ${name(dependent.componentId)} movement. Animate Whole product to move them together.`;
}

function transform(scene:any,componentId:string,create=false):any {
  const result=componentId===PRODUCT_TARGET?scene.placement:partPose(scene,componentId,create);
  if (!result) throw new Error('That component is no longer available.');
  return result;
}
function validateProperty(scene:any,componentId:string,property:KeyframeProperty):void {
  transform(scene,componentId);
  if (componentId===PRODUCT_TARGET && (property.startsWith('rotation.')||property==='motion')) throw new Error('Select a part for rotation or mechanical movement.');
  if (property==='motion'&&!getMotion(scene,componentId)) throw new Error('This part has no mechanical movement.');
}
function validateValue(componentId:string,property:KeyframeProperty,value:number):void {
  if (!Number.isFinite(value)) throw new Error('Enter a finite value.');
  if (property==='scale') {
    const product=componentId===PRODUCT_TARGET,{min,max}=transformScaleLimits(product?{kind:'product'}:{kind:'part',componentId});
    if(value<min||value>max)throw new Error(product?PRODUCT_SCALE_RANGE_MESSAGE:'Scale must stay between 1% and 10000%.');
  }
  if (property==='motion'&&(value < -100 || value > 100)) throw new Error('Movement must stay within 100 times its original travel.');
}
function validateFrame(scene:any,frame:number):void {
  if (!Number.isInteger(frame)||frame<1||frame>lastAnimationFrame(scene)) throw new Error(`Choose a frame from 1 to ${lastAnimationFrame(scene)}.`);
}
function baseValue(scene:any,componentId:string,property:KeyframeProperty,frame:number):number {
  const pose=transform(scene,componentId);
  if (property==='scale') return pose.scale??1;
  if (property.startsWith('position.')) return pose.translationM[AXES.indexOf(property.slice(-1) as TransformAxis)];
  if (property.startsWith('rotation.')) return new Euler().setFromQuaternion(new Quaternion().fromArray(pose.rotationXyzw),'XYZ')[property.slice(-1) as TransformAxis]*180/Math.PI;
  const action=getMotion(scene,componentId);
  return action?smooth(((frame-1)/scene.render.fps-action.startSeconds)/action.durationSeconds):0;
}
export function sampleTrack(track:AnimationTrack,frame:number):number {
  if (!track.keys.length) throw new Error('An animation track needs a keyframe.');
  const keys=track.keys;
  if(frame<=keys[0].frame)return keys[0].value;
  for(let index=1;index<keys.length;index++){
    const left=keys[index-1],right=keys[index];
    if(frame===right.frame)return right.value;
    if(frame<right.frame){
      const u=(frame-left.frame)/(right.frame-left.frame);
      return left.value+(right.value-left.value)*(left.interpolation==='hold'?0:left.interpolation==='ease'?smooth(u):u);
    }
  }
  return keys.at(-1)!.value;
}
export function getPropertyValue(scene:any,componentId:string,property:KeyframeProperty,frame:number):number {
  const track=getTrack(scene,componentId,property);
  return track?.enabled&&track.keys.length?sampleTrack(track,frame):baseValue(scene,componentId,property,frame);
}
function createTrack(scene:any,componentId:string,property:KeyframeProperty):AnimationTrack {
  scene.animation??={tracks:[]};scene.animation.tracks??=[];
  const track:AnimationTrack={id:`kf:${encodeURIComponent(componentId)}:${property}`,componentId,property,enabled:true,keys:[]};
  scene.animation.tracks.push(track);return track;
}
export function upsertKey(scene:any,componentId:string,property:KeyframeProperty,frame:number,value:number,interpolation?:KeyframeInterpolation):AnimationTrack {
  validateProperty(scene,componentId,property);validateFrame(scene,frame);validateValue(componentId,property,value);
  const existingTrack=getTrack(scene,componentId,property);
  const blocked=animationBlockReason(scene,componentId,property);
  if(blocked&&existingTrack?.enabled!==false)throw new Error(blocked);
  const track=existingTrack??createTrack(scene,componentId,property);
  const existing=track.keys.find(key=>key.frame===frame);
  if(existing){existing.value=value;if(interpolation)existing.interpolation=interpolation;}
  else {
    const preceding=track.keys.filter(key=>key.frame<frame).at(-1);
    track.keys.push({frame,value,interpolation:interpolation??preceding?.interpolation??'ease'});
    track.keys.sort((a,b)=>a.frame-b.frame);
  }
  return track;
}
export function toggleTrack(scene:any,componentId:string,property:KeyframeProperty,frame:number,enabled?:boolean):void {
  validateProperty(scene,componentId,property);validateFrame(scene,frame);
  const track=getTrack(scene,componentId,property);
  const next=enabled??!track?.enabled;
  const blocked=next?animationBlockReason(scene,componentId,property):null;
  if(blocked)throw new Error(blocked);
  if(track){track.enabled=next;return;}
  if(!next)return;
  if(property==='motion'){
    const action=getMotion(scene,componentId),fps=scene.render.fps;
    const start=Math.max(1,Math.min(lastAnimationFrame(scene),Math.round(action.startSeconds*fps)+1));
    const end=Math.max(start,Math.min(lastAnimationFrame(scene),Math.round((action.startSeconds+action.durationSeconds)*fps)+1));
    upsertKey(scene,componentId,property,start,0,'ease');
    upsertKey(scene,componentId,property,end,1,'ease');
  }else upsertKey(scene,componentId,property,frame,baseValue(scene,componentId,property,frame),'ease');
}
function setBaseValue(scene:any,componentId:string,property:KeyframeProperty,value:number):void {
  const pose=transform(scene,componentId,true);
  if(property==='scale')pose.scale=value;
  else if(property.startsWith('position.'))pose.translationM[AXES.indexOf(property.slice(-1) as TransformAxis)]=value;
  else if(property.startsWith('rotation.')){
    const euler=new Euler().setFromQuaternion(new Quaternion().fromArray(pose.rotationXyzw),'XYZ');
    euler[property.slice(-1) as TransformAxis]=value*Math.PI/180;
    pose.rotationXyzw=new Quaternion().setFromEuler(euler).toArray();
  }else throw new Error('Enable the movement track before editing its travel.');
}
/** Mutates the supplied scene: animated properties key at time; static properties edit the base pose. */
export function writeProperty(scene:any,componentId:string,property:KeyframeProperty,frame:number,value:number):void {
  validateProperty(scene,componentId,property);validateFrame(scene,frame);validateValue(componentId,property,value);
  if(getTrack(scene,componentId,property)?.enabled)upsertKey(scene,componentId,property,frame,value);
  else setBaseValue(scene,componentId,property,value);
}
export function moveKey(scene:any,trackId:string,fromFrame:number,toFrame:number):void {
  validateFrame(scene,toFrame);
  const track=animationTracks(scene).find(item=>item.id===trackId),key=track?.keys.find(item=>item.frame===fromFrame);
  if(!track||!key)throw new Error('That keyframe is no longer available.');
  if(fromFrame===toFrame)return;
  if(track.keys.some(item=>item.frame===toFrame))throw new Error(`A keyframe already occupies frame ${toFrame}.`);
  key.frame=toFrame;track.keys.sort((a,b)=>a.frame-b.frame);
}
export function removeKey(scene:any,trackId:string,frame:number):void {
  const track=animationTracks(scene).find(item=>item.id===trackId);
  if(!track)return;
  track.keys=track.keys.filter(key=>key.frame!==frame);
  if(!track.keys.length)scene.animation.tracks=animationTracks(scene).filter(item=>item.id!==trackId);
}
export function setKeyInterpolation(scene:any,trackId:string,frame:number,interpolation:KeyframeInterpolation):void {
  const key=animationTracks(scene).find(item=>item.id===trackId)?.keys.find(item=>item.frame===frame);
  if(key)key.interpolation=interpolation;
}
/** A calculation copy for G/R/S: sampled transform channels become its base pose. Mechanical motion stays separate. */
export function materializeAnimatedPose(scene:any,frame:number):any {
  const next=structuredClone(scene);
  // Removed parts retain their authored pose for Undo and any source dependencies.
  const ids=[PRODUCT_TARGET,...partTargetIds(scene,true)];
  for(const id of ids){
    const properties=TRANSFORM_PROPERTIES.filter(property=>id!==PRODUCT_TARGET||!property.startsWith('rotation.'));
    const enabled=properties.filter(property=>getTrack(scene,id,property)?.enabled);
    if(!enabled.length)continue;
    const pose=transform(next,id,true);
    for(const property of enabled.filter(property=>!property.startsWith('rotation.')))setBaseValue(next,id,property,getPropertyValue(scene,id,property,frame));
    if(enabled.some(property=>property.startsWith('rotation.'))){
      pose.rotationXyzw=new Quaternion().setFromEuler(new Euler(...AXES.map(axis=>getPropertyValue(scene,id,`rotation.${axis}`,frame)*Math.PI/180) as [number,number,number],'XYZ')).toArray();
    }
  }
  return next;
}
/** Route a transformed calculation copy back to canonical tracks/base fields without keying unchanged channels. */
export function commitAnimatedTransform(destination:any,preview:any,target:TransformTarget,mode:TransformMode,frame:number,axis?:TransformAxis):void {
  const id=target.kind==='product'?PRODUCT_TARGET:target.componentId;
  const properties:KeyframeProperty[]=mode==='scale'?['scale']:(mode==='translate'?'xyz'.split(''):axis?[axis]:'xyz'.split('')).map(channel=>`${mode==='translate'?'position':'rotation'}.${channel}` as KeyframeProperty);
  const before=materializeAnimatedPose(destination,frame);
  for(const property of properties){
    const oldValue=baseValue(before,id,property,frame),nextValue=baseValue(preview,id,property,frame);
    if(Math.abs(oldValue-nextValue)<1e-9)continue;
    // Quaternion conversion wraps angles. Retain the authored revolution nearest the current key value.
    const value=property.startsWith('rotation.')?nextValue+360*Math.round((getPropertyValue(destination,id,property,frame)-nextValue)/360):nextValue;
    writeProperty(destination,id,property,frame,value);
  }
}

export interface PropertyPresentation {label:string;axis?:string;unit:string;factor:number;min?:number;max?:number;step:number;precision?:number}
export function propertyPresentation(scene:any,id:string,property:KeyframeProperty):PropertyPresentation {
  if(property.startsWith('position.'))return {label:'Position',axis:property.slice(-1).toUpperCase(),unit:'mm',factor:1000,step:.1};
  if(property.startsWith('rotation.'))return {label:'Rotation',axis:property.slice(-1).toUpperCase(),unit:'°',factor:1,step:1};
  if(property==='scale'){
    const product=id===PRODUCT_TARGET,{min,max}=transformScaleLimits(product?{kind:'product'}:{kind:'part',componentId:id});
    return {label:'Scale',unit:'%',factor:100,min:Number((min*100).toPrecision(12)),max:Number((max*100).toPrecision(12)),step:1,...(product?{precision:8}:{})};
  }
  const action=getMotion(scene,id),factor=action?.type==='screw'?(action.turns*action.directionSign||1):(action?.distanceM*1000||1);
  return {label:action?.type==='screw'?'Turns':'Travel',unit:action?.type==='screw'?'rev':'mm',factor,min:-100*Math.abs(factor),max:100*Math.abs(factor),step:.1};
}
export function formatAnimationTime(frame:number,fps:number):string {
  const totalMs=Math.round((frame-1)/fps*1000),minutes=Math.floor(totalMs/60000),seconds=Math.floor(totalMs/1000)%60;
  return `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(totalMs%1000).padStart(3,'0')}`;
}
