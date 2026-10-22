import {describe,it,expect} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {animatedTransformScene,copyAnimatedTransform} from './animatedTransforms';
import {getPropertyValue,getTrack,toggleTrack,writeProperty} from './keyframes';
const target={kind:'part',componentId:'cap'} as const;
describe('Viewport transforms at the playhead',()=>{
  it('changes an unanimated property for every frame without creating animation',()=>{
    const scene=structuredClone(fixture) as any;
    const draft=animatedTransformScene(scene,target,'translate','x',.012,91);
    expect(draft.animation).toBeUndefined();
    expect(draft.product.components.find((c:any)=>c.id==='cap').assembly.translationM[0]).toBeCloseTo(.012);
    expect(scene).toEqual(fixture);
  });
  it('previews and applies one keyed axis without changing base pose or unrelated tracks',()=>{
    const scene=structuredClone(fixture) as any;
    toggleTrack(scene,'cap','position.x',1);writeProperty(scene,'cap','position.x',121,.1);
    toggleTrack(scene,'cap','scale',1);writeProperty(scene,'cap','scale',121,2);
    const snapshot=structuredClone(scene),value=getPropertyValue(scene,'cap','position.x',61);
    const preview=animatedTransformScene(scene,target,'translate','x',.02,61);
    expect(getPropertyValue(preview,'cap','position.x',61)).toBeCloseTo(value+.02);
    expect(scene).toEqual(snapshot);
    copyAnimatedTransform(scene,preview,target,'translate','x',61);
    expect(getTrack(scene,'cap','position.x')?.keys).toHaveLength(3);
    expect(getTrack(scene,'cap','scale')).toEqual(getTrack(snapshot,'cap','scale'));
    expect(scene.product).toEqual(snapshot.product);
  });
  it('preserves a complete authored rotation rather than reducing it to a neutral pose',()=>{
    const scene=structuredClone(fixture) as any;toggleTrack(scene,'cap','rotation.y',1);
    const preview=animatedTransformScene(scene,target,'rotate','y',360,121);
    copyAnimatedTransform(scene,preview,target,'rotate','y',121);
    expect(getPropertyValue(scene,'cap','rotation.y',121)).toBe(360);
    expect(getPropertyValue(scene,'cap','rotation.y',61)).toBeCloseTo(180);
  });
  it('previews and commits a sub-percent product scale without changing source parts',()=>{
    const scene=structuredClone(fixture) as any,product={kind:'product'} as const;
    scene.placement.scale=.00148;toggleTrack(scene,'$product','scale',1);
    const before=structuredClone(scene),preview=animatedTransformScene(scene,product,'scale','x',2,25);
    expect(getPropertyValue(preview,'$product','scale',25)).toBe(.00296);
    copyAnimatedTransform(scene,preview,product,'scale','x',25);
    expect(getPropertyValue(scene,'$product','scale',25)).toBe(.00296);
    expect(scene.placement).toEqual(before.placement);expect(scene.product).toEqual(before.product);
  });
  it('leaves a neutral gesture unchanged and rejects invalid animated scale',()=>{
    const scene=structuredClone(fixture) as any;toggleTrack(scene,'cap','scale',1);
    expect(animatedTransformScene(scene,target,'scale','x',1,100)).toEqual(scene);
    expect(()=>animatedTransformScene(scene,target,'scale','x',0,100)).toThrow('Scale');
  });
});
