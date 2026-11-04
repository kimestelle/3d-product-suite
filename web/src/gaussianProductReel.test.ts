import {describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MathUtils,PerspectiveCamera,Vector3} from 'three';
import fixture from '../../examples/bottle.scene.json';
import {generateProductReel,gaussianPoseCovered,gaussianReelPathCovered,productReelPathSafe,productReelSettings,productReelMovement,productReelCutKind} from './productReel';
import {productBounds} from './randomSetupFraming';
import {filmCameraPoseAtFrame} from './filmMotion';
import type {CameraPose} from './camera';

function source(size=[.1,.32,.1],aspect=[1080,1920]):any {
  const s=structuredClone(fixture) as any;s.actions=[];delete s.animation;delete s.motions;
  s.product.components=[{id:'body',shape:'box',sizeM:size,bevelM:0,material:{baseColor:[.2,.3,.4,1],roughness:.4,metallic:0},assembly:{translationM:[0,size[1]/2,0],rotationXyzw:[0,0,0,1]}}];s.product.dimensionsM=size;delete s.product.label;
  Object.assign(s.render,{width:aspect[0],height:aspect[1]});
  const first=generateProductReel(s,productReelSettings(s),87).scene.shots[0];
  s.shots[0].camera.from=structuredClone(first.camera.from);s.shots[0].camera.to=structuredClone(first.camera.from);
  s.environment={...s.environment,kind:'splat',revisionId:'gaussian-fixture',displayName:'Synthetic Gaussian fixture',reviewStatus:'unreviewed',
    provenance:{source:'Synthetic Gaussian test',owner:'Gesso tests',reuseBasis:'Original fixture',allowedExternalDestinations:[]},
    asset:{path:`assets/${'a'.repeat(64)}.spz`,sha256:'a'.repeat(64),format:'spz',sourceUp:'Y',scaleToMeters:1,translationM:[0,0,0],rotationXyzw:[0,0,0,1]},
    previewAsset:{path:`assets/${'b'.repeat(64)}.spz`,sha256:'b'.repeat(64),format:'spz'}};
  return s;
}
function camera(pose:CameraPose,aspect:number) {
  const value=new PerspectiveCamera(MathUtils.radToDeg(2*Math.atan(18/pose.focalLengthMm)),aspect,.001,1000);
  value.position.fromArray(pose.positionM);value.lookAt(new Vector3().fromArray(pose.targetM));value.updateMatrixWorld();return value;
}

describe('Gaussian product films',()=>{
  it('preserves sources, product and stage while generating energetic optical shots at the exact saved position',()=>{
    const s=source(),before=structuredClone(s),reference=s.shots[0].camera.from;
    const a=generateProductReel(s,productReelSettings(s),87),b=generateProductReel(s,productReelSettings(s),87);
    expect(a).toEqual(b);expect(s).toEqual(before);expect(a.scene.environment).toEqual(s.environment);expect(a.scene.product).toEqual(s.product);
    expect(a.changes).toContain('Gaussian: fixed source-camera position; optical zoom and aim stay inside its saved view');
    expect(a.scene.shots.map((shot:any)=>shot.name)).toEqual(['Establish','Reveal','Hero']);
    for(const shot of a.scene.shots){
      expect(shot.camera.from.positionM).toEqual(reference.positionM);expect(shot.camera.to.positionM).toEqual(reference.positionM);
      expect(productReelPathSafe(a.scene,shot)).toBe(true);expect(gaussianReelPathCovered(a.scene,shot,reference)).toBe(true);
      expect(productReelMovement(a.scene,shot).screenTravel).toBeGreaterThanOrEqual(.08);
    }
    const native=JSON.parse(execFileSync('python3',['-c','import json,sys;from film.scene import sample_scene;print(json.dumps([frame["camera"] for frame in sample_scene(json.load(sys.stdin))["frames"]]))'],{input:JSON.stringify(a.scene),cwd:fileURLToPath(new URL('../..',import.meta.url)),encoding:'utf8'}));
    expect(native).toHaveLength(a.scene.render.durationFrames);
    for(let frame=1;frame<=native.length;frame++){
      const shot=a.scene.shots.find((shot:any)=>frame>=shot.startFrame&&frame<=shot.endFrame),ui=filmCameraPoseAtFrame(a.scene,shot,frame);
      expect(gaussianPoseCovered(reference,native[frame-1],s.render.width/s.render.height)).toBe(true);
      for(let axis=0;axis<3;axis++){expect(ui.positionM[axis]).toBeCloseTo(native[frame-1].positionM[axis],10);expect(ui.targetM[axis]).toBeCloseTo(native[frame-1].targetM[axis],10);}
      expect(ui.focalLengthMm).toBeCloseTo(native[frame-1].focalLengthMm,10);
    }
  });
  it('stays inside the reference frustum at every actual frame across shapes, output aspects and seeds',()=>{
    for(const size of [[.8,.08,.1],[.04,.5,.04],[.1,.1,.6]])for(const aspect of [[1920,1080],[1080,1920],[1080,1080]])for(const seed of [0,1,87,129]){
      const s=source(size,aspect),reference=s.shots[0].camera.from,{scene}=generateProductReel(s,productReelSettings(s),seed),original=camera(reference,aspect[0]/aspect[1]);
      for(const shot of scene.shots)for(let frame=shot.startFrame;frame<=shot.endFrame;frame++){
        const p=filmCameraPoseAtFrame(scene,shot,frame),view=camera(p,aspect[0]/aspect[1]);
        expect(p.positionM).toEqual(reference.positionM);
        // Independent production-camera projection, not the containment helper.
        for(const x of [-1,1])for(const y of [-1,1]){
          const projected=new Vector3(x,y,.5).unproject(view).project(original);
          expect(Math.abs(projected.x)).toBeLessThanOrEqual(1+1e-7);expect(Math.abs(projected.y)).toBeLessThanOrEqual(1+1e-7);
        }
      }
    }
  });
  it('carries one visible angular direction across connected optical views, with wider views moving farther',()=>{
    for(const seed of [0,1,87,129]){
      const s=source(),{scene,changes}=generateProductReel(s,productReelSettings(s),seed);
      expect(changes).toContain('One directional optical pan across connected views; wider framing carries more aim movement');
      const yaw=(pose:CameraPose)=>Math.atan2(pose.positionM[0]-pose.targetM[0],pose.positionM[2]-pose.targetM[2]);
      const direction=Math.sign(yaw(scene.shots[0].camera.to)-yaw(scene.shots[0].camera.from));
      const angles=scene.shots.map((shot:any)=>{
        const a=new Vector3().fromArray(shot.camera.from.targetM).sub(new Vector3().fromArray(shot.camera.from.positionM));
        const b=new Vector3().fromArray(shot.camera.to.targetM).sub(new Vector3().fromArray(shot.camera.to.positionM));
        return a.angleTo(b);
      });
      for(let index=0;index<scene.shots.length;index++){
        const shot=scene.shots[index];
        expect(angles[index]).toBeGreaterThan(.001);
        expect(Math.sign(yaw(shot.camera.to)-yaw(shot.camera.from))).toBe(direction);
        expect(productReelMovement(scene,shot).screenTravel).toBeGreaterThanOrEqual(.08);
        if(index)expect(shot.camera.from).toEqual(scene.shots[index-1].camera.to);
      }
      expect(angles[0]).toBeGreaterThan(angles[1]);
      expect(angles[2]).toBeGreaterThan(angles[1]);
    }
  });
  it('checks an off-center selected feature and connects small changes or cuts substantial reframing',()=>{
    const s=source(),part=structuredClone(s.product.components[0]);part.id='feature';part.sizeM=[.025,.035,.025];part.assembly.translationM=[.045,.22,.015];s.product.components.push(part);
    const settings=productReelSettings(s);settings.focusTarget='feature';
    const reference=s.shots[0].camera.from,{scene,changes}=generateProductReel(s,settings,9);
    expect(changes.some(change=>change.includes('whole-product optical move'))).toBe(false);
    for(const shot of scene.shots){expect(gaussianReelPathCovered(scene,shot,reference)).toBe(true);}
    const kind=productReelCutKind(scene,scene.shots[0],scene.shots[1],'$product','feature');
    expect(kind).toBe('cut');expect(productReelMovement(scene,scene.shots[1],'feature').screenTravel).toBeGreaterThanOrEqual(.08);
    for(let index=1;index<scene.shots.length;index++){
      const previous=scene.shots[index-1],next=scene.shots[index];
      if(productReelCutKind(scene,previous,next,index===2?'feature':'$product',index===1?'feature':'$product')==='connect')expect(next.camera.from).toEqual(previous.camera.to);
    }
  });
  it('never translates or widens a view to force unsupported coverage',()=>{
    const s=source(),reference=s.shots[0].camera.from;
    expect(gaussianPoseCovered(reference,{...reference,focalLengthMm:reference.focalLengthMm*.99},s.render.width/s.render.height)).toBe(false);
    expect(gaussianPoseCovered(reference,{...reference,positionM:reference.positionM.map((v:number,i:number)=>v+(i===0?.01:0))},s.render.width/s.render.height)).toBe(false);
    expect(gaussianPoseCovered(reference,{...reference,targetM:[100,100,-100],focalLengthMm:500},s.render.width/s.render.height)).toBe(false);
    const tight={...reference,focalLengthMm:reference.focalLengthMm*1.82};
    expect(()=>generateProductReel(s,productReelSettings(s),1,{referenceCamera:tight})).toThrow(/too tight|full-product/);
  });
  it('uses the supplied evaluated reference and rejects blocked source positions without changing the original',()=>{
    const s=source(),before=structuredClone(s),reference=structuredClone(s.shots[0].camera.from);
    reference.positionM[0]+=.01;
    const result=generateProductReel(s,productReelSettings(s),3,{referenceCamera:reference});
    for(const shot of result.scene.shots)expect(shot.camera.to.positionM).toEqual(reference.positionM);
    const body=productBounds(s),bad={...reference,positionM:body.getCenter(new Vector3()).toArray()};
    expect(()=>generateProductReel(s,productReelSettings(s),3,{referenceCamera:bad})).toThrow(/viewing direction|full-product/);
    expect(s).toEqual(before);
    s.environment.props=[{id:'wall',visible:true,sizeM:[10,10,.1],translationM:[0,0,.4],rotationXyzw:[0,0,0,1]}];
    expect(()=>generateProductReel(s,productReelSettings(s),3)).toThrow('clear, full-product');
  });
});
