import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {applyStaticScene} from './staticScene';
import {duplicateShot, sequenceEnd} from './sequence';

const asset = {path:`assets/${'a'.repeat(64)}.png`,sha256:'a'.repeat(64),format:'png' as const,width:1920,height:1080};
const textCard = {version:1 as const,text:'Made for another angle.',color:'#ffffff',background:'#181818'};
describe('static scene commit',()=>{
  it('inserts one timed scene after the selection and keeps its editable source and image together',()=>{
    const scene:any=structuredClone(fixture), original=structuredClone(scene);
    const id=applyStaticScene(scene,asset,{name:'Title',durationFrames:48,textCard},{afterId:scene.shots[0].id});
    const shot=scene.shots[1];
    expect(shot.id).toBe(id);expect(shot.kind).toBe('image');
    expect(shot.startFrame).toBe(original.shots[0].endFrame+1);
    expect(shot.endFrame-shot.startFrame+1).toBe(48);
    expect(scene.shots[2].startFrame).toBe(original.shots[1].startFrame+48);
    expect(shot.image).toEqual({asset,fit:'contain',textCard});
    expect(shot.image.textCard).not.toBe(textCard);
    const copy=duplicateShot(scene,id);
    expect(scene.shots.find((item:any)=>item.id===copy).image).toEqual(shot.image);
  });
  it('edits the same static scene and removes stale text source when replacing it with an image',()=>{
    const scene:any=structuredClone(fixture);
    const id=applyStaticScene(scene,asset,{name:'Title',durationFrames:48,textCard});
    const count=scene.shots.length,total=sequenceEnd(scene);
    const edited=applyStaticScene(scene,{...asset,sha256:'b'.repeat(64),path:`assets/${'b'.repeat(64)}.png`},{name:'Photograph',durationFrames:24},{shotId:id});
    expect(edited).toBe(id);expect(scene.shots).toHaveLength(count);expect(sequenceEnd(scene)).toBe(total-24);
    const shot=scene.shots.find((item:any)=>item.id===id);
    expect(shot.image.textCard).toBeUndefined();expect(shot.name).toBe('Photograph');
    expect(shot.image.asset.sha256).toBe('b'.repeat(64));
  });
  it('rejects a stale target without touching another scene',()=>{
    const scene:any=structuredClone(fixture),before=structuredClone(scene);
    expect(()=>applyStaticScene(scene,asset,{name:'Title',durationFrames:48,textCard},{shotId:scene.shots[0].id})).toThrow('no longer available');
    expect(scene).toEqual(before);
  });
});
