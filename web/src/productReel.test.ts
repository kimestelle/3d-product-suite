import {describe,it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fixture from '../../examples/bottle.scene.json';
import {generateProductReel,productReelPathSafe,productReelSettings,productReelMovement,productReelCutKind} from './productReel';
import {filmCameraPoseAtFrame} from './filmMotion';
import {productBounds,projectedProductBounds} from './randomSetupFraming';
function source(size=[.1,.32,.1]):any {
  const s=structuredClone(fixture) as any;s.actions=[];delete s.animation;delete s.motions;
  s.product.components=[{id:'body',shape:'box',sizeM:size,bevelM:0,material:{baseColor:[.2,.3,.4,1],roughness:.4,metallic:0},assembly:{translationM:[0,size[1]/2,0],rotationXyzw:[0,0,0,1]}}];s.product.dimensionsM=size;delete s.product.label;
  return s;
}
describe('whole-product film workflow',()=>{
  it('is deterministic, leaves the source untouched, and preserves authored appearance',()=>{
    const s=source(),before=structuredClone(s),settings=productReelSettings(s);
    const a=generateProductReel(s,settings,87),b=generateProductReel(s,settings,87);
    expect(a).toEqual(b);expect(s).toEqual(before);
    expect(a.scene.environment).toEqual(s.environment);expect(a.scene.product).toEqual(s.product);
    expect(a.scene.shots.map((shot:any)=>shot.name)).toEqual(['Establish','Reveal','Hero']);
    expect(generateProductReel(s,settings,88).scene).not.toEqual(a.scene);
    execFileSync('python3',['-c','import json,sys;from film.scene import validate_scene;validate_scene(json.load(sys.stdin))'],{input:JSON.stringify(a.scene),cwd:fileURLToPath(new URL('../..',import.meta.url))});
  });
  it('keeps wide, tall and deep objects in frame throughout all shots and output aspects',()=>{
    for(const size of [[.8,.08,.1],[.04,.5,.04],[.1,.1,.6]])for(const [width,height] of [[1920,1080],[1080,1920],[1080,1080]]){
      const s=source(size);Object.assign(s.render,{width,height});
      let scene:any;try{scene=generateProductReel(s,productReelSettings(s),123).scene}catch(e){throw new Error(`${size} ${width}x${height}: ${e}`)}
      for(const shot of scene.shots){expect(productReelPathSafe(scene,shot)).toBe(true);
        for(let i=0;i<=100;i++){
          const p=projectedProductBounds(productBounds(scene),filmCameraPoseAtFrame(scene,shot,shot.startFrame+(shot.endFrame-shot.startFrame)*i/100),width/height);
          expect(Math.max(Math.abs(p.left),Math.abs(p.right),Math.abs(p.top),Math.abs(p.bottom))).toBeLessThanOrEqual(.96);
        }
      }
    }
  });
  it('hands off the same angular direction and angle at cuts with measurable output movement',()=>{
    const s=source(),{scene}=generateProductReel(s,productReelSettings(s),87);
    const yaw=(p:any)=>Math.atan2(p.positionM[0]-p.targetM[0],p.positionM[2]-p.targetM[2]);
    const direction=Math.sign(yaw(scene.shots[0].camera.to)-yaw(scene.shots[0].camera.from));
    for(let i=0;i<3;i++){
      const shot=scene.shots[i];expect(shot.camera.interpolation).toBe('linear');
      expect(Math.sign(yaw(shot.camera.to)-yaw(shot.camera.from))).toBe(direction);
      expect(productReelMovement(scene,shot).screenTravel).toBeGreaterThanOrEqual(.08);
      if(i){expect(yaw(scene.shots[i-1].camera.to)).toBeCloseTo(yaw(shot.camera.from),10);expect(scene.shots[i-1].camera.to).toEqual(shot.camera.from);}
    }
  });
  it('allows a decisive scale cut but connects small framing changes',()=>{
    const s=source(),{scene}=generateProductReel(s,productReelSettings(s),87);
    const previous=scene.shots[0],next=structuredClone(scene.shots[1]);
    const start=previous.camera.to,target=start.targetM;
    const closer=(amount:number)=>({...start,positionM:start.positionM.map((x:number,i:number)=>target[i]+(x-target[i])*amount)});
    next.camera.from=closer(.98);expect(productReelCutKind(scene,previous,next)).toBe('connect');
    next.camera.from=closer(.6);expect(productReelCutKind(scene,previous,next)).toBe('cut');
  });
  it('uses matching native and UI linear timing between endpoints',()=>{
    const s=source(),{scene}=generateProductReel(s,productReelSettings(s),14),shot=scene.shots[0];
    const frame=Math.round(shot.startFrame+(shot.endFrame-shot.startFrame)*.25),t=(frame-shot.startFrame)/(shot.endFrame-shot.startFrame);
    const native=JSON.parse(execFileSync('python3',['-c','import json,sys;from film.scene import evaluate;s=json.load(sys.stdin);print(json.dumps(evaluate(s,'+frame+')["camera"]))'],{input:JSON.stringify(scene),cwd:fileURLToPath(new URL('../..',import.meta.url)),encoding:'utf8'}));
    const ui=filmCameraPoseAtFrame(scene,shot,frame);
    for(let i=0;i<3;i++)expect(ui.positionM[i]).toBeCloseTo(native.positionM[i],10);
    expect(ui.positionM[0]).toBeCloseTo(shot.camera.from.positionM[0]+(shot.camera.to.positionM[0]-shot.camera.from.positionM[0])*t,10);
  });
  it('rejects a path through the object even when both endpoints are outside',()=>{
    const s=source(),shot=structuredClone(s.shots[0]);shot.camera.from.positionM=[0,.16,1];shot.camera.to.positionM=[0,.16,-1];
    expect(productReelPathSafe(s,shot)).toBe(false);
  });
  it('refuses unsupported mesh-world and moving-product safety claims',()=>{
    const s=source();s.environment.kind='generated';expect(()=>generateProductReel(s,productReelSettings(s),1)).toThrow('mesh collision');
    const moving=structuredClone(fixture);expect(()=>generateProductReel(moving,productReelSettings(moving),1)).toThrow('animated');
  });
  it('refuses an obstructed view and leaves source unchanged',()=>{
    const s=source();s.environment.props=[{id:'wall',visible:true,sizeM:[10,10,.1],translationM:[0,0,.4],rotationXyzw:[0,0,0,1]}];
    const before=structuredClone(s);expect(()=>generateProductReel(s,productReelSettings(s),1)).toThrow('No clear exterior');expect(s).toEqual(before);
  });
  it('validates selected focus instead of guessing a feature',()=>{
    const s=source(),settings=productReelSettings(s);settings.focusTarget='removed';
    expect(()=>generateProductReel(s,settings,1)).toThrow('no longer available');
    settings.focusTarget='body';expect(generateProductReel(s,settings,1).scene.shots).toHaveLength(3);
  });
});
