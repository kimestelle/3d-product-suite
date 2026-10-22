import {resolveHierarchy,type HierarchyPart} from './hierarchy';
import {partTargetIds,removedPartIds,sourcePartId,type SourceNode} from './partTargets';

/** Freeze the selected branch into explicit IDs. Later regrouping cannot restore it. */
export function partRemovalPlan(scene:any,parts:HierarchyPart[],id:string):{ids:string[];nextId:string|null} {
  const available=new Set(partTargetIds(scene));
  if(!available.has(id))throw new Error('This part is no longer available.');
  const {parents}=resolveHierarchy(scene,parts);
  const children=new Map<string,string[]>();
  const edge=(parent:string|null,child:string)=>{if(parent){const list=children.get(parent)??[];list.push(child);children.set(parent,list);}};
  for(const part of parts)edge(parents[part.id],part.id);
  // Source descendants still belong to their physical parent, even after list regrouping.
  for(const component of scene.product.components)for(const node of component.sourceNodes??[] as SourceNode[])
    edge(node.parentIndex===null?component.id:sourcePartId(component.id,node.parentIndex),sourcePartId(component.id,node.nodeIndex));
  const pending=[id], visited=new Set<string>();
  while(pending.length){const current=pending.pop()!;if(visited.has(current))continue;visited.add(current);pending.push(...(children.get(current)??[]));}
  const ids=[...available].filter(target=>visited.has(target));
  const removed=new Set([...removedPartIds(scene),...ids]);
  let nextId=parents[id];
  const checked=new Set<string>();
  while(nextId&&removed.has(nextId)&&!checked.has(nextId)){checked.add(nextId);nextId=parents[nextId];}
  if(!nextId||removed.has(nextId))nextId=parts.find(part=>available.has(part.id)&&!removed.has(part.id))?.id??null;
  return {ids,nextId};
}

export function removeProductPart(scene:any,parts:HierarchyPart[],id:string):void {
  const {ids}=partRemovalPlan(scene,parts,id);
  scene.product.removedPartIds=[...new Set<string>([...(scene.product.removedPartIds??[]),...ids])];
}
