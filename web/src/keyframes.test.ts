import {describe,expect,it} from 'vitest';
import {Euler,Quaternion} from 'three';
import {transformScene} from './transforms';
import {PRODUCT_TARGET,animationBlockReason,animationTracks,commitAnimatedTransform,formatAnimationTime,getPropertyValue,getTrack,materializeAnimatedPose,moveKey,propertyPresentation,removeKey,sampleTrack,setKeyInterpolation,toggleTrack,upsertKey,writeProperty,type AnimationTrack} from './keyframes';

const fixture=():any=>({sceneId:'bottle',render:{fps:30},shots:[{id:'a',startFrame:1,endFrame:180},{id:'b',startFrame:181,endFrame:360}],placement:{translationM:[.1,0,0]},product:{components:[
  {id:'body',assembly:{translationM:[0,.05,0],rotationXyzw:[0,0,0,1]}},
  {id:'cap',assembly:{translationM:[0,.2,0],rotationXyzw:[0,0,0,1]}},
]},actions:[{componentId:'cap',type:'lift',distanceM:.055,startSeconds:5.4,durationSeconds:3,axis:[0,1,0],pivotM:[0,0,0]}]});
const part={kind:'part',componentId:'cap'} as const;
const makeTrack=(interpolation:'linear'|'ease'|'hold'):AnimationTrack=>({id:'track',componentId:'cap',property:'position.y',enabled:true,keys:[{frame:10,value:0,interpolation},{frame:30,value:10,interpolation:'linear'}]});

describe('keyframe sampling',()=>{
  it('holds endpoints, interpolates on reel frames, and treats the key itself as its exact value',()=>{
    for(const interpolation of ['linear','ease','hold'] as const){
      const track=makeTrack(interpolation);
      expect(sampleTrack(track,1)).toBe(0);expect(sampleTrack(track,10)).toBe(0);expect(sampleTrack(track,30)).toBe(10);expect(sampleTrack(track,80)).toBe(10);
    }
    expect(sampleTrack(makeTrack('linear'),15)).toBe(2.5);
    expect(sampleTrack(makeTrack('ease'),15)).toBe(1.5625);
    expect(sampleTrack(makeTrack('hold'),29)).toBe(0);
  });
  it('uses interpolation from the outgoing key and keeps motion continuous across camera cuts',()=>{
    const scene=fixture();upsertKey(scene,'cap','position.y',1,0,'linear');upsertKey(scene,'cap','position.y',360,.359);
    expect(getPropertyValue(scene,'cap','position.y',180)).toBeCloseTo(.179);
    expect(getPropertyValue(scene,'cap','position.y',181)).toBeCloseTo(.180);
    setKeyInterpolation(scene,getTrack(scene,'cap','position.y')!.id,1,'hold');
    expect(getPropertyValue(scene,'cap','position.y',359)).toBe(0);
    expect(getPropertyValue(scene,'cap','position.y',360)).toBe(.359);
  });
  it('preserves the timed cap lift when it becomes editable motion keys',()=>{
    const scene=fixture(),frames=[1,162,163,180,208,252,253,360];
    const before=frames.map(frame=>getPropertyValue(scene,'cap','motion',frame));
    toggleTrack(scene,'cap','motion',180,true);
    expect(getTrack(scene,'cap','motion')!.keys.map(key=>[key.frame,key.value])).toEqual([[163,0],[253,1]]);
    frames.forEach((frame,index)=>expect(getPropertyValue(scene,'cap','motion',frame)).toBeCloseTo(before[index],12));
    upsertKey(scene,'cap','motion',253,0);toggleTrack(scene,'cap','motion',253,false);
    expect(getPropertyValue(scene,'cap','motion',253)).toBe(1);
    expect(getTrack(scene,'cap','motion')!.keys.at(-1)!.value).toBe(0);
  });
});

describe('editing scope',()=>{
  it('edits unanimated values in the base pose without creating a track',()=>{
    const scene=fixture();writeProperty(scene,'cap','position.x',180,.15);writeProperty(scene,PRODUCT_TARGET,'scale',180,1.5);
    expect(scene.product.components[1].assembly.translationM[0]).toBe(.15);expect(scene.placement.scale).toBe(1.5);
    expect(animationTracks(scene)).toHaveLength(0);
    expect(getPropertyValue(scene,'cap','position.x',1)).toBe(.15);expect(getPropertyValue(scene,'cap','position.x',360)).toBe(.15);
  });
  it('starts a single property at its current value and records only that enabled property',()=>{
    const scene=fixture();toggleTrack(scene,'cap','position.y',20,true);writeProperty(scene,'cap','position.y',70,.4);writeProperty(scene,'cap','position.x',70,.1);
    expect(animationTracks(scene)).toHaveLength(1);
    expect(getTrack(scene,'cap','position.y')!.keys.map(key=>[key.frame,key.value])).toEqual([[20,.2],[70,.4]]);
    expect(scene.product.components[1].assembly.translationM).toEqual([.1,.2,0]);
    writeProperty(scene,'cap','position.y',70,.5);
    expect(getTrack(scene,'cap','position.y')!.keys).toHaveLength(2);expect(getPropertyValue(scene,'cap','position.y',70)).toBe(.5);
  });
  it('keeps disabled keys while static edits change all frames, and restores the keys on enable',()=>{
    const scene=fixture();toggleTrack(scene,'cap','scale',1,true);writeProperty(scene,'cap','scale',100,2);
    const keys=structuredClone(getTrack(scene,'cap','scale')!.keys);
    toggleTrack(scene,'cap','scale',100,false);writeProperty(scene,'cap','scale',100,3);
    expect(getPropertyValue(scene,'cap','scale',100)).toBe(3);expect(getTrack(scene,'cap','scale')!.keys).toEqual(keys);
    toggleTrack(scene,'cap','scale',100,true);expect(getPropertyValue(scene,'cap','scale',100)).toBe(2);
  });
  it('edits and keys a small whole product while retaining part limits',()=>{
    const scene=fixture();writeProperty(scene,PRODUCT_TARGET,'scale',1,.00148);
    toggleTrack(scene,PRODUCT_TARGET,'scale',1,true);writeProperty(scene,PRODUCT_TARGET,'scale',25,.00296);
    expect(getPropertyValue(scene,PRODUCT_TARGET,'scale',13)).toBeCloseTo(.00222);
    expect(materializeAnimatedPose(scene,13).placement.scale).toBeCloseTo(.00222);
    expect(propertyPresentation(scene,PRODUCT_TARGET,'scale')).toMatchObject({min:.0001,max:1e8,precision:8});
    expect(propertyPresentation(scene,'cap','scale')).toMatchObject({min:1,max:10000});
    expect(()=>writeProperty(scene,'cap','scale',1,.00148)).toThrow('1% and 10000%');
    for(const value of [1e-6,1e6])expect(()=>upsertKey(scene,PRODUCT_TARGET,'scale',25,value)).not.toThrow();
    for(const value of [1e-7,1e7])expect(()=>upsertKey(scene,PRODUCT_TARGET,'scale',25,value)).toThrow('Product scale');
  });
  it('rejects invalid channels, time, and scale before mutating',()=>{
    const scene=fixture(),before=structuredClone(scene);
    expect(()=>upsertKey(scene,'missing','scale',10,1)).toThrow();expect(()=>upsertKey(scene,PRODUCT_TARGET,'rotation.x',10,1)).toThrow();
    expect(()=>upsertKey(scene,'cap','scale',0,1)).toThrow();expect(()=>upsertKey(scene,'cap','scale',361,1)).toThrow();expect(()=>upsertKey(scene,'cap','scale',1.5,1)).toThrow();
    expect(()=>writeProperty(scene,'cap','scale',10,.001)).toThrow();expect(()=>writeProperty(scene,'cap','scale',10,101)).toThrow();expect(()=>writeProperty(scene,'cap','position.x',10,NaN)).toThrow();
    expect(()=>writeProperty(scene,'cap','motion',10,.5)).toThrow('Enable');expect(()=>toggleTrack(scene,'body','motion',10)).toThrow('no mechanical');
    expect(scene).toEqual(before);
  });
});

describe('key timing and recovery',()=>{
  it('sorts keys and retains interpolation while retiming; a collision does not destroy either key',()=>{
    const scene=fixture();upsertKey(scene,'cap','position.x',100,.1,'linear');upsertKey(scene,'cap','position.x',10,0,'hold');upsertKey(scene,'cap','position.x',200,.2);
    const track=getTrack(scene,'cap','position.x')!;
    moveKey(scene,track.id,10,150);expect(track.keys.map(key=>key.frame)).toEqual([100,150,200]);expect(track.keys[1].interpolation).toBe('hold');
    const before=structuredClone(scene);expect(()=>moveKey(scene,track.id,100,150)).toThrow('already');expect(scene).toEqual(before);
    removeKey(scene,track.id,150);expect(track.keys.map(key=>key.frame)).toEqual([100,200]);
    removeKey(scene,track.id,100);removeKey(scene,track.id,200);expect(animationTracks(scene)).toHaveLength(0);
  });
  it('allows reverse and repeated mechanical travel within the canonical limits',()=>{
    const scene=fixture();toggleTrack(scene,'cap','motion',1,true);writeProperty(scene,'cap','motion',200,-.5);writeProperty(scene,'cap','motion',300,2);
    expect(getPropertyValue(scene,'cap','motion',200)).toBe(-.5);expect(getPropertyValue(scene,'cap','motion',300)).toBe(2);
    expect(()=>writeProperty(scene,'cap','motion',300,101)).toThrow();
  });
});

describe('viewport transform handoff',()=>{
  it('materializes transform channels without applying mechanical movement or mutating source',()=>{
    const scene=fixture();upsertKey(scene,'cap','position.y',1,.2,'linear');upsertKey(scene,'cap','position.y',301,.5);upsertKey(scene,'cap','rotation.z',1,0,'linear');upsertKey(scene,'cap','rotation.z',301,90);upsertKey(scene,PRODUCT_TARGET,'scale',1,2);
    const before=structuredClone(scene),posed=materializeAnimatedPose(scene,151);
    expect(posed.product.components[1].assembly.translationM[1]).toBeCloseTo(.35);
    const euler=new Euler().setFromQuaternion(new Quaternion().fromArray(posed.product.components[1].assembly.rotationXyzw),'XYZ');expect(euler.z*180/Math.PI).toBeCloseTo(45);
    expect(posed.placement.scale).toBe(2);expect(posed.actions).toEqual(scene.actions);expect(scene).toEqual(before);
  });
  it('commits changed values through enabled tracks and keeps other channels static',()=>{
    const scene=fixture();upsertKey(scene,'cap','position.y',1,.2,'linear');upsertKey(scene,'cap','position.y',301,.5);
    const posed=materializeAnimatedPose(scene,151),preview=transformScene(posed,part,'translate','y',.01);
    commitAnimatedTransform(scene,preview,part,'translate',151,'y');
    expect(getPropertyValue(scene,'cap','position.y',151)).toBeCloseTo(.36);expect(getTrack(scene,'cap','position.y')!.keys).toHaveLength(3);expect(animationTracks(scene)).toHaveLength(1);
    expect(scene.product.components[1].assembly.translationM[1]).toBe(.2);
    const same=structuredClone(scene);commitAnimatedTransform(scene,materializeAnimatedPose(scene,151),part,'translate',151);expect(scene).toEqual(same);
  });
  it('keeps authored revolutions when a quaternion round trip wraps the viewport angle',()=>{
    const scene=fixture();upsertKey(scene,'cap','rotation.z',1,400);const posed=materializeAnimatedPose(scene,1),preview=transformScene(posed,part,'rotate','z',10);
    commitAnimatedTransform(scene,preview,part,'rotate',1,'z');expect(getPropertyValue(scene,'cap','rotation.z',1)).toBeCloseTo(410);
    expect(animationTracks(scene)).toHaveLength(1);
  });
});

describe('reel time labels',()=>{
  it('uses one-based frames but zero-based seconds',()=>{
    expect(formatAnimationTime(1,30)).toBe('00:00.000');expect(formatAnimationTime(163,30)).toBe('00:05.400');expect(formatAnimationTime(1816,30)).toBe('01:00.500');
  });
});


describe('mechanical reference constraints',()=>{
  it('blocks animated reference parts before mutation but leaves static edits and whole-product animation available',()=>{
    const scene=fixture();scene.actions[0].relativeTo='body';scene.product.components[0].name='Body';
    expect(animationBlockReason(scene,'body','position.x')).toBe('Body anchors Cap movement. Animate Whole product to move them together.');
    expect(animationBlockReason(scene,PRODUCT_TARGET,'scale')).toBeNull();expect(animationBlockReason(scene,'cap','motion')).toBeNull();
    const before=structuredClone(scene);
    expect(()=>toggleTrack(scene,'body','position.x',1,true)).toThrow('anchors Cap');
    expect(()=>upsertKey(scene,'body','scale',1,2)).toThrow('anchors Cap');expect(scene).toEqual(before);
    writeProperty(scene,'body','position.x',1,.5);expect(scene.product.components[0].assembly.translationM[0]).toBe(.5);
    toggleTrack(scene,PRODUCT_TARGET,'scale',1,true);writeProperty(scene,PRODUCT_TARGET,'scale',40,2);
    expect(getPropertyValue(scene,PRODUCT_TARGET,'scale',40)).toBe(2);
  });
  it('retains disabled tracks and permits disabling an unsupported existing track',()=>{
    const scene=fixture();upsertKey(scene,'body','position.x',1,0);upsertKey(scene,'body','position.x',20,.1);
    scene.actions[0].relativeTo='body';
    toggleTrack(scene,'body','position.x',1,false);
    const track=getTrack(scene,'body','position.x')!;expect(track.enabled).toBe(false);expect(track.keys).toHaveLength(2);
    upsertKey(scene,'body','position.x',20,.2);expect(track.keys[1].value).toBe(.2);
    const before=structuredClone(scene);expect(()=>toggleTrack(scene,'body','position.x',20,true)).toThrow('anchors');expect(scene).toEqual(before);
    writeProperty(scene,'body','position.x',20,.3);expect(getPropertyValue(scene,'body','position.x',20)).toBe(.3);expect(track.keys[1].value).toBe(.2);
  });
});


describe('removed source poses',()=>{
  it.each(['component','source branch'] as const)('materializes retained %s tracks without changing source or dropping keys',scope=>{
    const scene=fixture(), cap=scene.product.components[1];
    cap.sourceNodes=[
      {nodeIndex:3,parentIndex:null,name:'Assembly',drawable:true,hasMesh:false},
      {nodeIndex:7,parentIndex:3,name:'Shell',drawable:true,hasMesh:true},
    ];
    const target=scope==='component'?'cap':'cap::node:7';
    upsertKey(scene,target,'position.y',1,.2,'linear');upsertKey(scene,target,'position.y',301,.5);
    upsertKey(scene,target,'rotation.z',1,0,'linear');upsertKey(scene,target,'rotation.z',301,90);
    const visible=materializeAnimatedPose(scene,151);
    scene.product.removedPartIds=[scope==='component'?'cap':'cap::node:3'];
    const before=structuredClone(scene), hidden=materializeAnimatedPose(scene,151);
    expect(hidden.product.components).toEqual(visible.product.components);
    expect(hidden.animation).toEqual(visible.animation);
    expect(hidden.product.removedPartIds).toEqual(scene.product.removedPartIds);
    expect(scene).toEqual(before);
    delete scene.product.removedPartIds;
    expect(materializeAnimatedPose(scene,151)).toEqual(visible);
  });
});
