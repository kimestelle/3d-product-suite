import {describe,expect,it} from 'vitest';
import {sceneDropTarget,sceneReorderIndexForKey,frameAfterSceneReorder} from './sceneReorder';
import {type Shot} from './sequence';

const shots:Shot[]=[
  {id:'a',name:'Wide',startFrame:1,endFrame:24,camera:{}},
  {id:'b',name:'Detail',startFrame:25,endFrame:96,camera:{}},
  {id:'c',name:'Image',startFrame:97,endFrame:108,camera:{},kind:'image'},
];
describe('Scene drop coordinates',()=>{
  it('moves directly between distant cuts, excluding the dragged scene from destination indexes',()=>{
    expect(sceneDropTarget(shots,'a',1120,40,1080,108)).toEqual({index:2,beforeId:undefined,boundary:108});
    expect(sceneDropTarget(shots,'c',-100,40,1080,108)).toEqual({index:0,beforeId:'a',boundary:0});
    expect(sceneDropTarget(shots,'a',800,40,1080,108)).toEqual({index:1,beforeId:'c',boundary:96});
  });
  it('uses actual unequal durations rather than equal-width card positions',()=>{
    expect(sceneDropTarget(shots,'c',639.9,40,1080,108).index).toBe(1);
    expect(sceneDropTarget(shots,'c',640.1,40,1080,108).index).toBe(2);
    expect(sceneDropTarget(shots,'b',500,40,1080,108).index).toBe(1);
    expect(sceneDropTarget([shots[0]],'a',100,40,240,24).index).toBe(0);
  });
  it('uses fresh scroll bounds without changing time or scene content',()=>{
    const before=structuredClone(shots);
    expect(sceneDropTarget(shots,'a',300,-600,1080,108)).toEqual(sceneDropTarget(shots,'a',940,40,1080,108));
    expect(shots).toEqual(before);
  });
  it('offers bounded keyboard placement without changing unrelated shortcuts',()=>{
    expect(sceneReorderIndexForKey('ArrowLeft',0,3)).toBe(0);
    expect(sceneReorderIndexForKey('ArrowRight',2,3)).toBe(2);
    expect(sceneReorderIndexForKey('ArrowRight',0,3)).toBe(1);
    expect(sceneReorderIndexForKey('Home',2,3)).toBe(0);
    expect(sceneReorderIndexForKey('End',0,3)).toBe(2);
    expect(sceneReorderIndexForKey('Enter',0,3)).toBeUndefined();
  });
  it('retains the edited scene and exact local frame when another scene crosses it',()=>{
    const after={shots:[{...shots[2],startFrame:1,endFrame:12},{...shots[0],startFrame:13,endFrame:36},{...shots[1],startFrame:37,endFrame:108}]};
    expect(frameAfterSceneReorder({shots},after,40)).toBe(52);
    expect(frameAfterSceneReorder({shots},after,108)).toBe(12);
    expect(frameAfterSceneReorder({shots},after,1)).toBe(13);
  });
});
