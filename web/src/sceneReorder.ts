import {shotFrames, type Shot} from './sequence';

/** Destination is the final index, using the other scenes' visible midpoints. */
export function sceneDropTarget(shots: Shot[], id: string, x: number, left: number, width: number, total: number) {
  const others=shots.filter(shot=>shot.id!==id);
  const time=(x-left)/Math.max(1,width)*total;
  const index=others.filter(shot=>(shot.startFrame-1)+shotFrames(shot)/2<time).length;
  const before=others[index];
  return {index, beforeId:before?.id, boundary:before ? before.startFrame-1 : total};
}

export function sceneReorderIndexForKey(key: string, index: number, count: number): number | undefined {
  if(key==='Home')return 0;
  if(key==='End')return count-1;
  if(key==='ArrowLeft')return Math.max(0,index-1);
  if(key==='ArrowRight')return Math.min(count-1,index+1);
}

/** Preserve the editing scene and its local time when its position changes. */
export function frameAfterSceneReorder(before: any, after: any, frame: number): number {
  const owner=before.shots.find((shot:Shot)=>frame>=shot.startFrame&&frame<=shot.endFrame);
  const next=owner&&after.shots.find((shot:Shot)=>shot.id===owner.id);
  return next ? next.startFrame+Math.min(shotFrames(next)-1,Math.max(0,frame-owner.startFrame)) : frame;
}
