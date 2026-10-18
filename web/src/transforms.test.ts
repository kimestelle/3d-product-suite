import {describe,expect,it} from 'vitest';
import {Euler,Quaternion} from 'three';
import {commitHistory,createHistory} from './state';
import {
  copyTransform,nudgeTransformAmount,pointerTransformAmount,rotationSampleDelta,supportsTransform,transformKeyIntent,transformScene,typedTransformAmount,
  type TransformKeyInput,
} from './transforms';

const fixture = ():any => ({placement:{translationM:[.2,.3,.4],restsOn:'floor'},product:{components:[
  {id:'cap',assembly:{translationM:[.01,.02,.03],rotationXyzw:[0,0,0,1]},material:{name:'metal'}},
  {id:'body',assembly:{translationM:[0,0,0],rotationXyzw:[0,0,0,1],scale:2}},
]},actions:[{componentId:'cap',type:'slide',distanceM:.1}]});
const cap = {kind:'part',componentId:'cap'} as const;
const product = {kind:'product'} as const;
const key = (value:string,overrides:Partial<TransformKeyInput>={}):TransformKeyInput => ({key:value,ctrlKey:false,metaKey:false,altKey:false,shiftKey:false,repeat:false,isComposing:false,...overrides});

describe('transform drafts',()=>{
  it('keeps neutral scale drafts identical without adding optional fields or undo entries',()=>{
    const source=fixture(),history=createHistory(source);
    for (const target of [cap,product,{kind:'part',componentId:'body'} as const]) {
      const next=transformScene(source,target,'scale','x',1);
      expect(next).toEqual(source);
      expect(next).not.toBe(source);
      expect(commitHistory(history,next)).toBe(history);
    }
    expect(transformScene(source,cap,'scale','x',1).product.components[0].assembly).not.toHaveProperty('scale');
    expect(transformScene(source,product,'scale','x',1).placement).not.toHaveProperty('scale');
  });
  it('keeps zero and complete-turn rotations exact instead of round-tripping the quaternion',()=>{
    const source=fixture();
    source.product.components[0].assembly.rotationXyzw=new Quaternion().setFromEuler(new Euler(.2,.3,.4)).toArray().map(value=>-value);
    const history=createHistory(source);
    for (const angle of [0,360,-360,720]) {
      const next=transformScene(source,cap,'rotate','y',angle);
      expect(next).toEqual(source);
      expect(commitHistory(history,next)).toBe(history);
    }
  });
  it('moves only the selected component in metres without mutating the source',()=>{
    const source=fixture(),before=structuredClone(source);
    const next=transformScene(source,cap,'translate','y',.005);
    expect(next.product.components[0].assembly.translationM).toEqual([.01,.025,.03]);
    expect(next.product.components[1]).toEqual(source.product.components[1]);
    expect(next.actions).toEqual(source.actions);
    expect(source).toEqual(before);
  });
  it('moves product placement independently from component transforms',()=>{
    const source=fixture(),next=transformScene(source,product,'translate','z',-.1);
    expect(next.placement.translationM[2]).toBeCloseTo(.3);
    expect(next.product).toEqual(source.product);
  });
  it('uses local XYZ Euler degrees to match the existing rotation fields',()=>{
    const source=fixture();
    source.product.components[0].assembly.rotationXyzw=new Quaternion().setFromEuler(new Euler(.1,.2,.3,'XYZ')).toArray();
    const next=transformScene(source,cap,'rotate','y',15);
    const euler=new Euler().setFromQuaternion(new Quaternion().fromArray(next.product.components[0].assembly.rotationXyzw),'XYZ');
    expect(euler.x).toBeCloseTo(.1); expect(euler.y).toBeCloseTo(.2+Math.PI/12); expect(euler.z).toBeCloseTo(.3);
    expect(new Quaternion().fromArray(next.product.components[0].assembly.rotationXyzw).length()).toBeCloseTo(1);
  });
  it('scales uniformly from the starting scale and rejects values outside the source-scale limits',()=>{
    const source=fixture();
    expect(transformScene(source,cap,'scale','x',2).product.components[0].assembly.scale).toBe(2);
    expect(transformScene(source,{kind:'part',componentId:'body'},'scale','z',2).product.components[1].assembly.scale).toBe(4);
    expect(transformScene(source,product,'scale','y',.01).placement.scale).toBe(.01);
    expect(transformScene(source,product,'scale','y',100).placement.scale).toBe(100);
    expect(()=>transformScene(source,product,'scale','y',.00001)).toThrow('1% and 10000%');
    expect(()=>transformScene(source,product,'scale','y',1000)).toThrow('1% and 10000%');
    expect(()=>transformScene(source,{kind:'part',componentId:'body'},'scale','z',60)).toThrow('1% and 10000%');
    expect(source.product.components[0].assembly).not.toHaveProperty('scale');
  });
  it('rejects invalid targets, non-finite values, non-positive scale and unsupported product rotation',()=>{
    expect(()=>transformScene(fixture(),{kind:'part',componentId:'missing'},'translate','x',1)).toThrow();
    expect(()=>transformScene(fixture(),cap,'translate','x',NaN)).toThrow();
    expect(()=>transformScene(fixture(),cap,'scale','x',0)).toThrow();
    expect(()=>transformScene(fixture(),cap,'scale','x',-1)).toThrow();
    expect(()=>transformScene(fixture(),product,'rotate','x',1)).toThrow('Whole-product rotation');
    expect(supportsTransform(fixture(),product,'rotate')).toBe(false);
    expect(supportsTransform(fixture(),null,'scale')).toBe(false);
  });
  it('commits only the manipulated field from the preview',()=>{
    const source=fixture(),preview=transformScene(source,cap,'translate','x',.1),destination=fixture();
    destination.product.components[0].material.name='rubber';
    destination.product.components[0].assembly.scale=2;
    copyTransform(destination,preview,cap,'translate');
    expect(destination.product.components[0].assembly.translationM[0]).toBeCloseTo(.11);
    expect(destination.product.components[0].material.name).toBe('rubber');
    expect(destination.product.components[0].assembly.scale).toBe(2);
  });
});

describe('transform keyboard intent',()=>{
  it('starts conventional G/R/S modes without accepting held or modified keys',()=>{
    expect(transformKeyIntent(key('g'),false)).toEqual({type:'start',mode:'translate'});
    expect(transformKeyIntent(key('r'),false)).toEqual({type:'start',mode:'rotate'});
    expect(transformKeyIntent(key('s'),false)).toEqual({type:'start',mode:'scale'});
    for(const modifier of ['ctrlKey','metaKey','altKey','shiftKey','repeat','isComposing','editable'] as const) {
      expect(transformKeyIntent(key('g',{[modifier]:true}),false)).toBeNull();
    }
  });
  it('scopes axis, arrows, typing and confirm to active transforms',()=>{
    expect(transformKeyIntent(key('x'),false)).toBeNull();
    expect(transformKeyIntent(key('1'),false)).toBeNull();
    expect(transformKeyIntent(key('Enter'),false)).toBeNull();
    expect(transformKeyIntent(key('Z'),true)).toEqual({type:'axis',axis:'z'});
    expect(transformKeyIntent(key('ArrowDown',{shiftKey:true,repeat:true}),true)).toEqual({type:'nudge',direction:-1,fine:true});
    expect(transformKeyIntent(key('1'),true)).toEqual({type:'type',key:'1'});
    expect(transformKeyIntent(key('Enter'),true)).toEqual({type:'confirm'});
    expect(transformKeyIntent(key('Escape'),true)).toEqual({type:'cancel'});
    expect(transformKeyIntent(key('ArrowUp',{editable:true}),true)).toBeNull();
    expect(transformKeyIntent(key('s',{metaKey:true}),true)).toBeNull();
  });
  it('parses visible mm, degree and factor units without accepting partial numbers',()=>{
    expect(typedTransformAmount('translate','-2.5')).toBe(-.0025);
    expect(typedTransformAmount('rotate','90')).toBe(90);
    expect(typedTransformAmount('scale','2')).toBe(2);
    expect(typedTransformAmount('scale','.5')).toBe(.5);
    for(const value of ['', '-', '.', '1.2.3','Infinity','2x']) expect(typedTransformAmount('translate',value)).toBeNull();
    expect(typedTransformAmount('scale','0')).toBeNull();
    expect(typedTransformAmount('scale','-1')).toBeNull();
  });
  it('nudges by mm, degrees or one percentage point, with a tenfold fine mode',()=>{
    expect(nudgeTransformAmount('translate',0,1)).toBe(.001);
    expect(nudgeTransformAmount('translate',0,-1,true)).toBe(-.0001);
    expect(nudgeTransformAmount('rotate',0,1,true)).toBe(.1);
    expect(nudgeTransformAmount('scale',1,1)).toBe(1.01);
    expect(nudgeTransformAmount('scale',1,-1,true)).toBe(.999);
    expect(nudgeTransformAmount('scale',.001,-1)).toBeGreaterThan(0);
  });
});


describe('pointer continuation',()=>{
  it('re-anchors relative movement and rotation at the current amount',()=>{
    expect(pointerTransformAmount('translate',.2,0)).toBe(.2);
    expect(pointerTransformAmount('translate',.2,.01,true)).toBeCloseTo(.201);
    expect(pointerTransformAmount('rotate',45,0,true)).toBe(45);
    expect(pointerTransformAmount('rotate',45,20,true)).toBe(47);
  });
  it('re-anchors scale multiplicatively, preserving its value through precision changes',()=>{
    expect(pointerTransformAmount('scale',2,1)).toBe(2);
    expect(pointerTransformAmount('scale',2,1,true)).toBe(2);
    expect(pointerTransformAmount('scale',2,1.5)).toBe(3);
    expect(pointerTransformAmount('scale',2,Math.pow(1.1,10),true)).toBeCloseTo(2.2);
  });
  it('unwraps signed camera rotation angles across the half-turn boundary',()=>{
    expect(rotationSampleDelta(179,-179)).toBe(2);
    expect(rotationSampleDelta(-179,179)).toBe(-2);
    expect(rotationSampleDelta(20,35)).toBe(15);
    expect(rotationSampleDelta(35,20)).toBe(-15);
  });
});
