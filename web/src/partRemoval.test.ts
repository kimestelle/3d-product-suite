import {describe,it,expect} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {partRemovalPlan,removeProductPart} from './partRemoval';
import {sceneParts} from './hierarchy';
import {partTargetIds,removedPartIds} from './partTargets';
import {createHistory,commitHistory,undoHistory,redoHistory} from './state';

const bottle=()=>structuredClone(fixture) as any;
const imported=()=>({product:{components:[{id:'lamp',shape:'mesh',sourceNodes:[
  {nodeIndex:0,parentIndex:null,drawable:true,name:'Assembly',boundsM:[[0,0,0],[1,1,1]]},
  {nodeIndex:1,parentIndex:0,drawable:false,name:'Pivot',boundsM:[[0,0,0],[1,1,1]]},
  {nodeIndex:2,parentIndex:1,drawable:true,name:'Shade',boundsM:[[0,0,0],[1,1,1]]},
  {nodeIndex:3,parentIndex:null,drawable:true,name:'Base',boundsM:[[0,0,0],[1,1,1]]},
]}]}} as any);

describe('reversible product removal',()=>{
  it('removes one part without discarding its geometry, motion or finish',()=>{
    const scene=bottle(),before=bottle();
    removeProductPart(scene,sceneParts(scene),'cap');
    expect(scene.product.removedPartIds).toEqual(['cap']);
    expect(scene.product.components).toEqual(before.product.components);
    expect(scene.actions).toEqual(before.actions);
    expect(partTargetIds(scene)).not.toContain('cap');
    expect(partRemovalPlan(before,sceneParts(before),'cap').nextId).not.toBe('cap');
  });
  it('includes editorial children without removing siblings',()=>{
    const scene=bottle();
    const plan=partRemovalPlan(scene,sceneParts(scene),'bottle-body');
    expect(new Set(plan.ids)).toEqual(new Set(['bottle-body','label']));
    expect(plan.nextId).not.toBe('bottle-body');
    removeProductPart(scene,sceneParts(scene),'bottle-body');
    expect(partTargetIds(scene)).toEqual(expect.arrayContaining(['cap','neck']));
    expect(scene.product.label).toEqual(fixture.product.label);
  });
  it('retains native descendants through hidden transforms and editorial regrouping',()=>{
    const scene=imported();
    scene.editorHierarchy={version:1,overrides:{'lamp::node:2':{parentId:null,status:'edited'}}};
    removeProductPart(scene,sceneParts(scene),'lamp::node:0');
    expect(scene.product.removedPartIds).toEqual(['lamp::node:0','lamp::node:2']);
    expect(partTargetIds(scene)).toEqual(['lamp','lamp::node:3']);
    // Canonical parent-only removals received from saved revisions expand identically.
    scene.product.removedPartIds=['lamp::node:0'];
    expect(removedPartIds(scene).has('lamp::node:2')).toBe(true);
    expect(partTargetIds(scene)).toEqual(['lamp','lamp::node:3']);
  });
  it('lets a whole imported product be removed and restored exactly with Undo/Redo',()=>{
    const scene=imported(),history=createHistory(scene),next=structuredClone(scene);
    expect(partRemovalPlan(next,sceneParts(next),'lamp').nextId).toBeNull();
    removeProductPart(next,sceneParts(next),'lamp');
    const removed=commitHistory(history,next);
    expect(partTargetIds(removed.present)).toEqual([]);
    const restored=undoHistory(removed);
    expect(restored.present).toEqual(scene);
    expect(redoHistory(restored).present).toEqual(next);
  });
  it('rejects stale or invalid targets instead of editing another part',()=>{
    const scene=bottle();
    expect(()=>removeProductPart(scene,sceneParts(scene),'missing')).toThrow('no longer available');
    removeProductPart(scene,sceneParts(scene),'cap');
    const before=JSON.stringify(scene);
    expect(()=>removeProductPart(scene,sceneParts(scene),'cap')).toThrow('no longer available');
    expect(JSON.stringify(scene)).toBe(before);
  });
});
