/** Stable imported source identities. Editorial grouping does not alter this hierarchy. */
export type SourceNode = {nodeIndex:number;parentIndex:number|null;name:string;localMatrix:number[];boundsM:[number[],number[]];drawable:boolean;hasMesh:boolean};
export type PartPose = {translationM:number[];rotationXyzw:number[];scale?:number;pivotM?:number[]};
export const sourcePartId=(componentId:string,index:number)=>`${componentId}::node:${index}`;
export function sourcePart(scene:any,id:string):{component:any;node:SourceNode}|null {
  for(const component of scene?.product?.components??[]) {
    const prefix=`${component.id}::node:`;
    if(!id.startsWith(prefix))continue;
    const suffix=id.slice(prefix.length), index=Number(suffix);
    if(!Number.isSafeInteger(index)||String(index)!==suffix)return null;
    const node:SourceNode|undefined=component.sourceNodes?.find((candidate:SourceNode)=>candidate.nodeIndex===index&&candidate.drawable);
    if(node)return {component,node};
  }
  return null;
}
export function partTargetIds(scene:any,includeRemoved=false):string[] {
  const removed=includeRemoved?new Set<string>():removedPartIds(scene);
  return (scene?.product?.components??[]).flatMap((component:any)=>[component.id,
    ...(component.sourceNodes??[]).filter((node:SourceNode)=>node.drawable).map((node:SourceNode)=>sourcePartId(component.id,node.nodeIndex))]).filter((id:string)=>!removed.has(id));
}
export function partPose(scene:any,id:string,create=false):PartPose|undefined {
  const part=sourcePart(scene,id);
  if(!part)return scene?.product?.components?.find((component:any)=>component.id===id)?.assembly;
  const existing=part.component.partTransforms?.[String(part.node.nodeIndex)];
  if(existing)return existing;
  const pose:PartPose={translationM:[0,0,0],rotationXyzw:[0,0,0,1],scale:1};
  if(create){part.component.partTransforms??={};part.component.partTransforms[String(part.node.nodeIndex)]=pose;}
  return pose;
}
export function sourcePartPivot(scene:any,id:string):number[]|null {
  const part=sourcePart(scene,id);if(!part)return null;
  const existing=part.component.partTransforms?.[String(part.node.nodeIndex)]?.pivotM;
  if(existing)return [...existing];
  const {localMatrix:m,boundsM:b}=part.node,centre=b[0].map((value,index)=>(value+b[1][index])/2);
  return [0,1,2].map(row=>m[12+row]+centre.reduce((sum,value,column)=>sum+m[column*4+row]*value,0));
}

/** Persistent removal includes native descendants even if the editorial tree was reorganized. */
export function removedPartIds(scene:any):Set<string> {
  const removed=new Set<string>(scene?.product?.removedPartIds??[]);
  if(!removed.size)return removed;
  for(const component of scene?.product?.components??[]) {
    const nodes:SourceNode[]=component.sourceNodes??[];
    const children=new Map<number|null,number[]>();
    for(const node of nodes){const list=children.get(node.parentIndex)??[];list.push(node.nodeIndex);children.set(node.parentIndex,list);}
    const pending=removed.has(component.id)?nodes.map(node=>node.nodeIndex):nodes.filter(node=>removed.has(sourcePartId(component.id,node.nodeIndex))).map(node=>node.nodeIndex);
    const seen=new Set<number>();
    while(pending.length) {
      const index=pending.pop()!;if(seen.has(index))continue;seen.add(index);
      removed.add(sourcePartId(component.id,index));
      pending.push(...(children.get(index)??[]));
    }
  }
  return removed;
}
