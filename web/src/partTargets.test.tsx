import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import fixture from '../../examples/bottle.scene.json';
import {partPose,partTargetIds,sourcePart,sourcePartPivot} from './partTargets';
import {addMotion,availableMotionKinds,validateFilmMotions} from './filmMotion';
import {getPropertyValue,materializeAnimatedPose,toggleTrack,upsertKey,writeProperty} from './keyframes';
import {FilmObjects,filmTargetName} from './FilmWorkspace';
import FilmPoseInspector from './FilmPoseInspector';
import {createFrameSetup,setFrameObjects,setFrameCamera} from './frameSetup';
import {cameraTarget} from './camera';
import {transformScene,copyTransform} from './transforms';
import {Matrix4} from 'three';

const identity=new Matrix4().toArray();
function source(){
  const scene=structuredClone(fixture) as any,component=scene.product.components[0];
  component.id='product';component.sourceNodes=[{nodeIndex:0,parentIndex:null,name:'Body',localMatrix:identity,boundsM:[[-.1,-.2,-.1],[.1,.2,.1]],drawable:true,hasMesh:true},
    {nodeIndex:1,parentIndex:0,name:'Cap',localMatrix:new Matrix4().makeTranslation(0,.2,0).toArray(),boundsM:[[-.05,-.05,-.05],[.05,.05,.05]],drawable:true,hasMesh:true}];
  scene.product.components=[component];delete scene.product.label;scene.actions=[];return scene;
}
const id='product::node:1';

describe('imported part identities and motion controls',()=>{
  it('keeps aliases across target lists without changing source IDs',()=>{
    const scene=source();scene.editorPartNames={[id]:'Brass cap'};
    expect(partTargetIds(scene)).toEqual(['product','product::node:0',id]);
    expect(filmTargetName(scene,id)).toBe('Brass cap');
    expect(sourcePart(scene,'product::node:01')).toBeNull();
    expect(availableMotionKinds(scene,id)).toEqual(['move','rotate','scale']);
    const before=structuredClone(scene);
    const html=renderToStaticMarkup(<FilmObjects scene={scene} frame={1} selectedTarget={id} selectedMotionId={null} onFrame={()=>{}} onChange={()=>{}} onTargetChange={()=>{}} onMotionSelect={()=>{}} onPlay={()=>{}}/>);
    expect(html).toContain('Brass cap');expect(scene).toEqual(before);
  });
  it('reads zero source-relative pose without introducing an unsaved edit',()=>{
    const scene=source(),before=structuredClone(scene);
    expect(partPose(scene,id)).toEqual({translationM:[0,0,0],rotationXyzw:[0,0,0,1],scale:1});
    expect(sourcePartPivot(scene,id)).toEqual([0,.2,0]);
    expect(getPropertyValue(scene,id,'position.x',1)).toBe(0);expect(scene).toEqual(before);
    writeProperty(scene,id,'position.x',1,.03);
    expect(scene.product.components[0].partTransforms['1'].translationM).toEqual([.03,0,0]);
    expect(scene.product.components[0].sourceNodes).toEqual(before.product.components[0].sourceNodes);
  });
  it('uses the same named actions and direct keys for imported parts',()=>{
    const scene=source();const motion=addMotion(scene,scene.shots[0].id,id,'rotate');
    expect(scene.shots[0].motions[0]).toMatchObject({id:motion,target:id,kind:'rotate'});
    expect(()=>validateFilmMotions(scene)).not.toThrow();
    upsertKey(scene,id,'rotation.x',1,0);upsertKey(scene,id,'rotation.x',25,90);
    expect(getPropertyValue(scene,id,'rotation.x',13)).toBe(45);
    const posed=materializeAnimatedPose(scene,13);
    expect(getPropertyValue({...posed,animation:undefined},id,'rotation.x',13)).toBeCloseTo(45);
  });
  it('includes parts in new-frame selection and fixed camera targeting',()=>{
    const scene=source(),setup=createFrameSetup(scene);
    const next=setFrameObjects(scene,setup,[id],'move');
    expect(next.targets).toEqual([id]);
    expect(scene.shots.find((shot:any)=>shot.id===setup.shotId).motions[0].target).toBe(id);
    const sample={components:{product:{translationM:[0,0,0],rotationXyzw:[0,0,0,1]}},parts:{[id]:{worldMatrix:new Matrix4().makeTranslation(.1,.25,0).toArray()}}};
    expect(cameraTarget(scene,sample,id)).toEqual([.1,.25,0]);
  });
  it('aims at the selected source bounds in the current sample, independent of its alias or source origin',()=>{
    const scene=source();scene.editorPartNames={[id]:'Renamed cap'};
    scene.product.components[0].sourceNodes[1].boundsM=[[.1,0,0],[.3,.2,.1]];
    const sample={components:{product:{}},parts:{[id]:{worldMatrix:new Matrix4().makeTranslation(.1,.25,0).multiply(new Matrix4().makeRotationZ(Math.PI/2)).toArray()}}};
    const first=cameraTarget(scene,sample,id);
    [0,.45,.05].forEach((value,index)=>expect(first[index]).toBeCloseTo(value));
    sample.parts[id].worldMatrix=new Matrix4().makeTranslation(.5,-.2,0).toArray();
    const next=cameraTarget(scene,sample,id);
    [.7,-.1,.05].forEach((value,index)=>expect(next[index]).toBeCloseTo(value));
    expect(()=>cameraTarget(scene,{components:{product:{}}},id)).toThrow('selected part to update');
  });
  it('offers a measured pivot and preserves source transforms during G/R/S edits',()=>{
    const scene=source(),before=structuredClone(scene);
    const html=renderToStaticMarkup(<FilmPoseInspector scene={scene} frame={1} target={id} onChange={()=>{}} onMotionSelect={()=>{}}/>);
    expect(html).toContain('Part pivot X');expect(html).toContain('Center pivot');expect(scene).toEqual(before);
    const preview=transformScene(scene,{kind:'part',componentId:id},'translate','y',.1);
    copyTransform(scene,preview,{kind:'part',componentId:id},'translate');
    expect(scene.product.components[0].partTransforms['1'].translationM).toEqual([0,.1,0]);
    expect(scene.product.components[0].sourceNodes).toEqual(before.product.components[0].sourceNodes);
  });
});
