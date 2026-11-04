import {Box3, Matrix4, Quaternion, Vector3} from 'three';
import {filmCameraPoseAtFrame} from './filmMotion';
import {partTargetIds} from './partTargets';
import {productBounds, projectedProductBounds} from './randomSetupFraming';
import {defaultRandomSetupSettings, type RandomSetupSettings, type RandomSetupResult} from './randomSetup';
import {randomSetupMovement} from './randomSetupMovement';
import {sceneFloorY} from './sceneGraph';
import {sequenceEnd, type Shot} from './sequence';
import {validateCamera, type CameraPose} from './camera';

export type ProductReelContext={referenceCamera?:CameraPose};

export function productReelSettings(scene:any):RandomSetupSettings {
  return {...defaultRandomSetupSettings(scene),workflow:'product-film',focusTarget:'$product',shotCount:3,
    policies:{stage:'keep',lighting:'keep',materials:'keep',colors:'keep',framing:'random',motion:'random'}};
}
const corners=(b:Box3)=>Array.from({length:8},(_,i)=>new Vector3(i&1?b.max.x:b.min.x,i&2?b.max.y:b.min.y,i&4?b.max.z:b.min.z));
function obstacleBoxes(scene:any):Box3[] {
  return (scene.environment.props??[]).filter((p:any)=>p.visible!==false).map((p:any)=>{
    if(p.relationship)throw new Error('Resolve object relationships before generating a checked film.');
    const matrix=new Matrix4().compose(new Vector3().fromArray(p.translationM),new Quaternion().fromArray(p.rotationXyzw??[0,0,0,1]),new Vector3(1,1,1));
    const half=new Vector3().fromArray(p.sizeM).multiplyScalar(.5);
    return new Box3().setFromPoints(corners(new Box3(half.clone().negate(),half)).map(v=>v.applyMatrix4(matrix)));
  });
}
function segmentHits(a:Vector3,b:Vector3,box:Box3):boolean {
  let lo=0,hi=1;
  for(const axis of ['x','y','z'] as const){
    const d=b[axis]-a[axis];
    if(Math.abs(d)<1e-12){if(a[axis]<box.min[axis]||a[axis]>box.max[axis])return false;continue;}
    const t0=(box.min[axis]-a[axis])/d,t1=(box.max[axis]-a[axis])/d;
    lo=Math.max(lo,Math.min(t0,t1));hi=Math.min(hi,Math.max(t0,t1));if(lo>hi)return false;
  }
  return true;
}
/** Bounds-based exterior check. Whole-segment separation is conservative; it
 * never treats sparse endpoint samples as proof of collision clearance. */
export function productReelPathSafe(scene:any,shot:Shot,focusId='$product'):boolean {
  const body=productBounds(scene),subject=focusId==='$product'?body:productBounds(scene,focusId);
  const clearance=Math.max(.005,body.getSize(new Vector3()).length()*.03);
  const obstacles=obstacleBoxes(scene).map(b=>b.expandByScalar(clearance));
  const from=new Vector3().fromArray(shot.camera.from.positionM),to=new Vector3().fromArray(shot.camera.to.positionM);
  if(segmentHits(from,to,body.clone().expandByScalar(clearance))||obstacles.some(b=>segmentHits(from,to,b)))return false;
  const checks=scene.environment.kind==='splat'?Math.max(1,shot.endFrame-shot.startFrame):32;
  if(!Number.isSafeInteger(checks)||checks>10000)return false;
  for(let i=0;i<=checks;i++){
    const pose=filmCameraPoseAtFrame(scene,shot,shot.startFrame+(shot.endFrame-shot.startFrame)*i/checks);
    const p=new Vector3().fromArray(pose.positionM),t=new Vector3().fromArray(pose.targetM);
    // Keep an exterior, front-side view; never orbit behind or below the object.
    if(p.z<=body.max.z+clearance||p.y<sceneFloorY(scene)+clearance)return false;
    const whole=projectedProductBounds(body,pose,scene.render.width/scene.render.height);
    const selected=projectedProductBounds(subject,pose,scene.render.width/scene.render.height);
    if(!Object.values(selected).every(Number.isFinite)||whole.minDepth<=clearance)return false;
    if(Math.max(Math.abs(selected.left),Math.abs(selected.right),Math.abs(selected.top),Math.abs(selected.bottom))>.96)return false;
    if(obstacles.some(b=>segmentHits(p,t,b)))return false;
  }
  return true;
}

/** Same-apex frustum containment: every new corner ray must remain inside the
 * saved source frustum. This says nothing about unmeasured room geometry. */
export function gaussianPoseCovered(reference:CameraPose,pose:CameraPose,aspect:number):boolean {
  if(!Number.isFinite(aspect)||aspect<=0||!Number.isFinite(reference.focalLengthMm)||reference.focalLengthMm<1
    ||!Number.isFinite(pose.focalLengthMm)||pose.focalLengthMm<reference.focalLengthMm)return false;
  const sourcePosition=new Vector3().fromArray(reference.positionM),position=new Vector3().fromArray(pose.positionM);
  if(!sourcePosition.toArray().concat(position.toArray(),reference.targetM,pose.targetM).every(Number.isFinite)
    ||sourcePosition.distanceToSquared(position)>1e-18)return false;
  const basis=(target:number[],origin:Vector3)=>{
    const forward=new Vector3().fromArray(target).sub(origin);
    if(forward.lengthSq()<1e-12)return null;
    forward.normalize();const right=forward.clone().cross(new Vector3(0,1,0));
    if(right.lengthSq()<1e-12)return null;
    right.normalize();return {forward,right,up:right.clone().cross(forward)};
  };
  const source=basis(reference.targetM,sourcePosition),next=basis(pose.targetM,position);
  if(!source||!next)return false;
  const sourceV=18/reference.focalLengthMm,sourceH=sourceV*aspect,v=18/pose.focalLengthMm,h=v*aspect;
  for(const x of [-1,1])for(const y of [-1,1]){
    const ray=next.forward.clone().addScaledVector(next.right,x*h).addScaledVector(next.up,y*v);
    const depth=ray.dot(source.forward);
    if(depth<=0||Math.abs(ray.dot(source.right))>depth*sourceH+1e-10
      ||Math.abs(ray.dot(source.up))>depth*sourceV+1e-10)return false;
  }
  return true;
}

/** Check every rasterized film frame. The camera never translates, so it
 * cannot cross an unknown room surface between those frames either. */
export function gaussianReelPathCovered(scene:any,shot:Shot,reference:CameraPose):boolean {
  const count=shot.endFrame-shot.startFrame;
  if(!Number.isSafeInteger(count)||count<1||count>10000)return false;
  for(let frame=shot.startFrame;frame<=shot.endFrame;frame++){
    if(!gaussianPoseCovered(reference,filmCameraPoseAtFrame(scene,shot,frame),scene.render.width/scene.render.height))return false;
  }
  return true;
}

function generateGaussianReel<T>(source:T,settings:RandomSetupSettings,seed:number,focus:string,context:ProductReelContext):RandomSetupResult<T> {
  const original:any=source,scene:any=structuredClone(source),body=productBounds(scene),aspect=scene.render.width/scene.render.height;
  const first=original.shots.find((shot:Shot)=>shot.kind!=='image');
  if(!context.referenceCamera&&!first)throw new Error('Open a full-product 3D view before generating a Gaussian film.');
  const reference=structuredClone(context.referenceCamera??filmCameraPoseAtFrame(original,first,first.startFrame));
  validateCamera({from:reference,to:reference});
  const sourceShot:Shot={id:'gaussian-source',name:'Source view',startFrame:1,endFrame:2,camera:{from:reference,to:structuredClone(reference)}};
  if(!productReelPathSafe(scene,sourceShot))throw new Error('Open a clear, full-product front view before generating a Gaussian film. The camera stays at that position.');
  const subject=focus==='$product'?body:productBounds(scene,focus);
  if(subject.min.distanceTo(body.min)+subject.max.distanceTo(body.max)<Math.max(1e-9,body.getSize(new Vector3()).length()*1e-6))focus='$product';
  const changes=['Three shots: establish → reveal → hero','Gaussian: fixed source-camera position; optical zoom and aim stay inside its saved view',
    'Every output frame checked against source-view coverage and product/prop bounds; unknown room collision geometry is not inferred',
    'Stage, lighting, product finishes and artwork kept'];
  const total=Math.max(6,Math.round(Math.max(6,Math.min(18,sequenceEnd(scene)/scene.render.fps))*scene.render.fps));
  scene.motions=(scene.motions??[]).filter((motion:any)=>motion.target!=='$camera');scene.shots=[];
  const variation=((seed>>>1)%1009)/1009;
  const pose=(bounds:Box3,fill:number):CameraPose=>{
    const target=bounds.getCenter(new Vector3()).toArray();
    const unit={positionM:[...reference.positionM],targetM:target,focalLengthMm:reference.focalLengthMm};
    const p=projectedProductBounds(bounds,unit,aspect),extent=Math.max(Math.abs(p.left),Math.abs(p.right),Math.abs(p.top),Math.abs(p.bottom));
    if(!Number.isFinite(extent)||extent<=0||p.minDepth<=0)throw new Error('The selected product detail is not visible from this saved camera.');
    const maximum=Math.max(reference.focalLengthMm,500),desired=Math.min(maximum,Math.max(reference.focalLengthMm,reference.focalLengthMm*fill/extent));
    let lo=reference.focalLengthMm,hi=maximum;
    if(!gaussianPoseCovered(reference,{...unit,focalLengthMm:hi},aspect))throw new Error('This feature needs a different source view. Frame it before generating a Gaussian film.');
    for(let i=0;i<40;i++){const mid=(lo+hi)/2;if(gaussianPoseCovered(reference,{...unit,focalLengthMm:mid},aspect))hi=mid;else lo=mid;}
    return {...unit,focalLengthMm:Math.max(hi*(1+1e-8),desired)};
  };
  const valid=(shot:Shot,target:string)=>productReelPathSafe(scene,shot,target)&&gaussianReelPathCovered(scene,shot,reference)
    &&productReelMovement(scene,shot,target).screenTravel>=.08;
  const shotFocuses:string[]=[];
  let cursor=1,previousFocus='$product';
  for(let index=0;index<3;index++){
    const length=index===2?total-cursor+1:Math.floor(total/3),previous:Shot|undefined=scene.shots[index-1];
    const selected=index===1?focus:'$product',bounds=selected==='$product'?body:subject;
    const goals=focus==='$product'?[[.50,.70],[.70,.90],[.90,.66]][index]:[[.50,.70],[.58,.86],[.70,.90]][index];
    let actualFocus=selected;
    const make=(from:CameraPose,to:CameraPose):Shot=>({id:`product-reel-${index+1}`,name:['Establish','Reveal','Hero'][index],startFrame:cursor,endFrame:cursor+length-1,
      camera:{from,to,interpolation:'linear'}});
    let shot:Shot;
    try{shot=make(pose(bounds,goals[0]+variation*.01),pose(bounds,goals[1]+variation*.01));}
    catch(error){
      if(selected==='$product')throw error;
      actualFocus='$product';shot=make(pose(body,.70),pose(body,.90));
      changes.push(`${shot.name}: whole-product optical move; selected detail cannot fit inside the saved source view`);
    }
    if(previous&&productReelCutKind(scene,previous,shot,previousFocus,actualFocus)==='connect')shot.camera.from=structuredClone(previous.camera.to);
    if(!valid(shot,actualFocus)&&actualFocus!=='$product'){
      // Very small features may hit the lens limit before the requested fill.
      // Use their real covered optical range rather than a near-still zoom.
      shot=make(pose(bounds,.01),pose(bounds,.95));
      if(previous&&productReelCutKind(scene,previous,shot,previousFocus,actualFocus)==='connect')shot.camera.from=structuredClone(previous.camera.to);
    }
    if(!valid(shot,actualFocus)){
      // A tight original view may lack three successive zoom-in ranges. Use
      // the full safe optical range in alternating directions before refusing.
      actualFocus='$product';
      const low=pose(body,.01),high=pose(body,.95);
      shot.camera={from:index%2?high:low,to:index%2?low:high,interpolation:'linear'};
      if(previous&&productReelCutKind(scene,previous,shot,previousFocus,actualFocus)==='connect')shot.camera.from=structuredClone(previous.camera.to);
      if(!valid(shot,actualFocus))throw new Error('This saved view is too tight for a useful covered move. Widen the full-product view, then generate again. The original film is unchanged.');
      if(selected!=='$product')changes.push(`${shot.name}: whole-product optical move; selected detail has insufficient covered framing range`);
    }
    validateCamera(shot.camera);scene.shots.push(shot);shotFocuses.push(actualFocus);cursor+=length;previousFocus=actualFocus;
  }
  // A fixed camera center still permits a real angular pan. Do not leave the
  // targets pinned to the subject center and call three zooms a camera sweep.
  // Wider shots carry a larger part of one directional aim movement. Scale
  // cuts may reset that aim; similar views keep the exact preceding endpoint.
  const sourceDirection=new Vector3().fromArray(reference.targetM).sub(new Vector3().fromArray(reference.positionM)).normalize();
  const right=sourceDirection.cross(new Vector3(0,1,0)).normalize();
  const side=(seed&1)?1:-1,sweep=[-.5,-.10,.15,.5];
  const centeredShots:Shot[]=scene.shots,groups:number[][]=[[0]];
  for(let index=1;index<centeredShots.length;index++){
    if(productReelCutKind(scene,centeredShots[index-1],centeredShots[index],shotFocuses[index-1],shotFocuses[index])==='cut')groups.push([]);
    groups[groups.length-1].push(index);
  }
  let panned=false;
  for(const group of groups){
    let accepted=false;
    // A substantial cut may exchange directions; a connected run may not.
    for(const direction of group[0]?[side,-side]:[side]){
      for(const strength of [1,.75,.5,.35,.2,.1]){
        const candidate:Shot[]=structuredClone(scene.shots);let safe=true;
        for(const index of group){
          const shot=candidate[index],bounds=shotFocuses[index]==='$product'?body:subject;
          const span=Math.min(body.getSize(new Vector3()).length()*.45,bounds.getSize(new Vector3()).length()*.55)*strength;
          for(const [end,offset] of [['from',sweep[index]],['to',sweep[index+1]]] as const){
            const pose=shot.camera[end];
            pose.targetM=new Vector3().fromArray(pose.targetM).addScaledVector(right,offset*span*direction).toArray();
            // Narrow only as much as source coverage requires. Full-detail source
            // pixels, camera position and physical clearance remain unchanged.
            if(!gaussianPoseCovered(reference,pose,aspect)){
              let lo=pose.focalLengthMm,hi=Math.max(lo,500);
              if(!gaussianPoseCovered(reference,{...pose,focalLengthMm:hi},aspect)){safe=false;break;}
              for(let i=0;i<32;i++){
                const middle=(lo+hi)/2;
                if(gaussianPoseCovered(reference,{...pose,focalLengthMm:middle},aspect))hi=middle;else lo=middle;
              }
              pose.focalLengthMm=hi*(1+1e-8);
            }
          }
          if(!safe)break;
          if(index!==group[0]){
            shot.camera.from=structuredClone(candidate[index-1].camera.to);
          }
          if(!valid(shot,shotFocuses[index])){safe=false;break;}
        }
        if(safe){scene.shots=candidate;panned=true;accepted=true;break;}
      }
      if(accepted)break;
    }
  }
  if(panned)changes.push('One directional optical pan across connected views; wider framing carries more aim movement');
  else changes.push('Source coverage only permits the checked optical zooms; widen the saved view for angular movement');
  for(let index=1;index<scene.shots.length;index++){
    const previous=scene.shots[index-1],shot=scene.shots[index];
    const kind=productReelCutKind(scene,previous,shot,shotFocuses[index-1],shotFocuses[index]);
    if(kind==='connect'){
      shot.camera.from=structuredClone(previous.camera.to);
      if(!valid(shot,shotFocuses[index]))throw new Error('This source view cannot support a useful connected pan. Widen the full-product view, then generate again. The original film is unchanged.');
    }
    changes.push(`${previous.name} → ${shot.name}: ${kind==='cut'?'clean cut · substantial scale or subject change':'connected optical handoff'}`);
  }
  for(const shot of scene.shots)validateCamera(shot.camera);
  scene.render.durationFrames=total;
  return {scene,seed,changes};
}

/** Fit the chosen subject in output coordinates while staying ahead of all product depth. */
function reelPose(scene:any,subject:Box3,yaw:number,occupancy:number) {
  const body=productBounds(scene),target=subject.getCenter(new Vector3());
  const direction=new Vector3(Math.sin(yaw)*Math.cos(.10),Math.sin(.10),Math.cos(yaw)*Math.cos(.10));
  const clearance=Math.max(.005,body.getSize(new Vector3()).length()*.03);
  let near=Math.max(clearance,(body.max.z+clearance-target.z)/direction.z,(sceneFloorY(scene)+clearance-target.y)/direction.y,...corners(body).map(p=>p.sub(target).dot(direction)+clearance))*1.001;
  let far=Math.max(near*2,body.getSize(new Vector3()).length()*4);
  const pose=(distance:number)=>({positionM:target.clone().addScaledVector(direction,distance).toArray(),targetM:target.toArray(),focalLengthMm:50});
  const fill=(distance:number)=>{const p=projectedProductBounds(subject,pose(distance),scene.render.width/scene.render.height);return Math.max(Math.abs(p.left),Math.abs(p.right),Math.abs(p.top),Math.abs(p.bottom));};
  for(let i=0;i<16&&fill(far)>occupancy;i++)far*=2;
  for(let i=0;i<40;i++){const middle=(near+far)/2;if(fill(middle)>occupancy)near=middle;else far=middle;}
  return pose(far);
}
export function productReelMovement(scene:any,shot:Shot,focusId='$product') {
  const bounds=productBounds(scene,focusId==='$product'?undefined:focusId),aspect=scene.render.width/scene.render.height;
  const start=projectedProductBounds(bounds,shot.camera.from,aspect);let screenTravel=0;
  for(let i=1;i<=32;i++){
    const p=projectedProductBounds(bounds,filmCameraPoseAtFrame(scene,shot,shot.startFrame+(shot.endFrame-shot.startFrame)*i/32),aspect);
    for(const edge of ['left','right','top','bottom'] as const)screenTravel=Math.max(screenTravel,Math.abs(p[edge]-start[edge])/2);
  }
  const yaw=(p:any)=>Math.atan2(p.positionM[0]-p.targetM[0],p.positionM[2]-p.targetM[2]);
  return {screenTravel,angularTravel:Math.abs(yaw(shot.camera.to)-yaw(shot.camera.from))};
}

/** A jump earns a cut only when scale or the chosen subject changes visibly. */
export function productReelCutKind(scene:any,previous:Shot,next:Shot,previousFocus='$product',nextFocus='$product'):'cut'|'connect' {
  const body=productBounds(scene),aspect=scene.render.width/scene.render.height;
  const before=projectedProductBounds(body,previous.camera.to,aspect).occupancy;
  const after=projectedProductBounds(body,next.camera.from,aspect).occupancy;
  if(Math.max(before,after)/Math.max(1e-9,Math.min(before,after))>=1.45)return 'cut';
  if(previousFocus!==nextFocus){
    const a=previousFocus==='$product'?body:productBounds(scene,previousFocus);
    const b=nextFocus==='$product'?body:productBounds(scene,nextFocus);
    const diagonal=body.getSize(new Vector3()).length();
    const sizeA=a.getSize(new Vector3()).length(),sizeB=b.getSize(new Vector3()).length();
    if(Math.min(sizeA,sizeB)/Math.max(sizeA,sizeB)<=.7||a.getCenter(new Vector3()).distanceTo(b.getCenter(new Vector3()))>=diagonal*.25)return 'cut';
  }
  return 'connect';
}

/** One subject, three roles, bounded front-side movement. No material/world edits. */
export function generateProductReel<T>(source:T,settings:RandomSetupSettings,seed:number,context:ProductReelContext={}):RandomSetupResult<T> {
  const original:any=source;
  if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw new Error('Use a valid generation seed.');
  if(!['authored','splat'].includes(original.environment.kind)||original.comparison)throw new Error('Checked film generation supports authored studios and fixed-view Gaussian worlds. Imported meshes and comparisons need mesh collision checks.');
  if((original.environment.props??[]).some((p:any)=>p.relationship)||original.placement.restsOn!==original.environment.plinth.id)throw new Error('Place the product on its studio support before generating a checked film.');
  if([...(original.motions??[]),...original.shots.flatMap((s:Shot)=>s.motions??[])].some((m:any)=>m.enabled&&m.target!=='$camera')||original.shots.some((s:Shot)=>s.kind!=='image'&&randomSetupMovement(original,s).cameraMustHold))throw new Error('This product or its lights are animated. Use a stationary product and lights for checked film generation.');
  let focus=settings.focusTarget??'$product';
  if(focus!=='$product'&&!partTargetIds(original).includes(focus))throw new Error('The selected focus part is no longer available. Choose the whole product or another part.');
  if(original.environment.kind==='splat')return generateGaussianReel(source,settings,seed,focus,context);
  const scene:any=structuredClone(source);const body=productBounds(scene);
  const subject=focus==='$product'?body:productBounds(scene,focus);
  if(subject.min.distanceTo(body.min)+subject.max.distanceTo(body.max)<Math.max(1e-9,body.getSize(new Vector3()).length()*1e-6))focus='$product';
  const side=(seed&1)?1:-1;
  const variation=((seed>>>1)%1009)/1009;
  const duration=Math.max(6,Math.min(18,sequenceEnd(scene)/scene.render.fps));
  const total=Math.max(6,Math.round(duration*scene.render.fps));
  const changes=['Three shots: establish → reveal → hero','Similar views connect; substantial scale or subject changes cut cleanly','Moving shots change the subject edges by at least 8% of the output frame','Stage, lighting, product finishes and artwork kept'];
  scene.motions=(scene.motions??[]).filter((m:any)=>m.target!=='$camera');
  scene.shots=[];let cursor=1;
  // One angular direction across cuts. Farther whole-body views get more
  // angular breadth than the close reveal, rather than a tiny distant dolly.
  const breadth=body.getSize(new Vector3()).length();
  const spans=[body,subject,body].map((bounds,index)=>{
    const start=reelPose(scene,bounds,0,index===0?.54:.60);
    const distance=new Vector3().fromArray(start.positionM).distanceTo(new Vector3().fromArray(start.targetM));
    return Math.max(12,Math.min(36,10+10*distance/breadth))*(.94+.06*variation);
  });
  const sum=spans.reduce((a,b)=>a+b,0);
  if(sum>80)for(let i=0;i<spans.length;i++)spans[i]*=80/sum;
  const totalAngle=spans.reduce((a,b)=>a+b,0);
  let yaw=-totalAngle/2;
  let previousFocus='$product';
  for(let index=0;index<3;index++){
    const shotSubject=index===1?subject:body;
    const previous:Shot|undefined=scene.shots[index-1];
    const priorPose=previous?.camera.to;
    const startYaw=priorPose?Math.atan2(priorPose.positionM[0]-priorPose.targetM[0],priorPose.positionM[2]-priorPose.targetM[2]):yaw*Math.PI/180*side;
    yaw+=spans[index];const endYaw=Math.max(-40,Math.min(40,startYaw*180/Math.PI+spans[index]*side))*Math.PI/180;
    const length=index===2?total-cursor+1:Math.floor(total/3);
    const framing=focus==='$product'?[[.50,.70],[.70,.90],[.90,.66]][index]:[[.50,.70],[.60,.84],[.70,.90]][index];
    let shot:Shot={id:`product-reel-${index+1}`,name:['Establish','Reveal','Hero'][index],startFrame:cursor,endFrame:cursor+length-1,
      camera:{from:reelPose(scene,shotSubject,startYaw,framing[0]),to:reelPose(scene,shotSubject,endYaw,framing[1]),interpolation:'linear'}};
    const selected=index===1?focus:'$product';
    if(previous&&index===1&&focus!=='$product'){
      const close:Shot={...shot,camera:{from:reelPose(scene,subject,side*12*Math.PI/180,framing[0]),to:reelPose(scene,subject,-side*8*Math.PI/180,framing[1]),interpolation:'linear'}};
      if(productReelCutKind(scene,previous,close,previousFocus,selected)==='cut'&&productReelPathSafe(scene,close,selected))shot=close;
    }
    if(previous&&productReelCutKind(scene,previous,shot,previousFocus,selected)==='connect')shot.camera.from=structuredClone(previous.camera.to);
    let actualFocus=selected;
    const energetic=()=>productReelMovement(scene,shot,selected).screenTravel>=.08;
    if(!productReelPathSafe(scene,shot,selected)||!energetic()){
      // Keep the handoff angle and direction when a selected detail has no
      // safe room. Use the complete body instead of weakening the move.
      actualFocus='$product';
      shot.camera={from:reelPose(scene,body,startYaw,.54),to:reelPose(scene,body,endYaw,.84),interpolation:'linear'};
      if(!productReelPathSafe(scene,shot)||productReelMovement(scene,shot).screenTravel<.08){
        const safe=reelPose(scene,body,startYaw,.80);shot.camera={from:safe,to:structuredClone(safe)};
        if(!productReelPathSafe(scene,shot))throw new Error('No clear exterior view is available. Move surrounding objects or choose another focus. The original film is unchanged.');
        changes.push(`${shot.name}: tight stationary whole-product fallback for clearance`);
      }else if(selected!=='$product')changes.push(`${shot.name}: whole-product move; selected detail has no safe moving view`);
    }
    if(previous){
      const kind=productReelCutKind(scene,previous,shot,previousFocus,actualFocus);
      if(kind==='connect'){
        shot.camera.from=structuredClone(previous.camera.to);
        if(!productReelPathSafe(scene,shot,actualFocus))throw new Error('No safe connected view is available. Try a different focus or move surrounding objects. The original film is unchanged.');
      }
      const travel=productReelMovement(scene,shot,actualFocus).screenTravel;
      if(travel>1e-8&&travel<.08)throw new Error('The connected move would be too subtle. Try another focus or regenerate. The original film is unchanged.');
      changes.push(`${previous.name} → ${shot.name}: ${kind==='cut'?'clean cut · substantial scale or subject change':'connected camera handoff'}`);
    }
    previousFocus=actualFocus;
    validateCamera(shot.camera);scene.shots.push(shot);cursor+=length;
  }
  scene.render.durationFrames=total;
  // Sampling/evaluation will still validate the resulting native scene before export.
  return {scene,seed,changes};
}
