import * as THREE from 'three';
import {disposeSceneObject,loadVerifiedGlb,prepareImportedMesh} from './sceneObjects';

export type CurveProduct={root:THREE.Group;name:string;partCount:number;triangleCount:number};
const MAX_TRIANGLES=250_000;
const missing='The local Nessino campaign is unavailable. Open or import the lamp in the editor, then retry.';
const checkAbort=(signal:AbortSignal)=>{if(signal.aborted)throw new DOMException('Product loading was cancelled.','AbortError');};
async function json(url:string,signal:AbortSignal):Promise<any>{
  checkAbort(signal);
  const response=await fetch(url,{signal,credentials:'same-origin'});
  if(!response.ok)throw new Error(`Could not read the local product (${response.status}).`);
  const value=await response.json();checkAbort(signal);return value;
}
const finiteVector=(value:unknown,length:number)=>Array.isArray(value)&&value.length===length&&value.every(item=>typeof item==='number'&&Number.isFinite(item));

/** Read the existing local lamp, never the campaign's world or a public copy of its CAD. */
export async function loadCurveProduct(signal:AbortSignal):Promise<CurveProduct>{
  const projects=await json('/api/projects',signal);
  if(!Array.isArray(projects))throw new Error('The local project list is invalid.');
  // The list gives campaign names; confirm the actual product before loading bytes.
  const candidates=projects.filter(item=>typeof item?.id==='string'&&/^[a-z0-9-]{1,64}$/.test(item.id)
    &&typeof item.name==='string'&&/\bnessino\b/i.test(item.name)).slice(0,8);
  let source:any;
  for(const candidate of candidates){
    const project=await json(`/api/projects/${candidate.id}`,signal);
    if(typeof project?.scene?.product?.displayName==='string'&&project.scene.product.displayName.trim().toLowerCase()==='artemide nessino'){
      source=project.scene.product;break;
    }
  }
  if(!source)throw new Error(missing);
  if(!Array.isArray(source.components)||!source.components.length||source.components.length>8)
    throw new Error('The lamp must contain between one and eight imported components.');
  const root=new THREE.Group();root.name=source.displayName;
  let partCount=0,triangleCount=0;
  try{
    for(const component of source.components){
      checkAbort(signal);
      const assembly=component.assembly;
      if(component.shape!=='mesh'||!finiteVector(assembly?.translationM,3)||!finiteVector(assembly?.rotationXyzw,4)
        ||(assembly.scale!==undefined&&(!Number.isFinite(assembly.scale)||assembly.scale<=0)))
        throw new Error('The lamp component has an unsupported geometry or transform.');
      const imported=await loadVerifiedGlb(component.asset,signal);
      if(signal.aborted){disposeSceneObject(imported);checkAbort(signal);}
      prepareImportedMesh(imported);
      const group=new THREE.Group();group.name=String(component.id||'product');
      group.position.fromArray(assembly.translationM);group.quaternion.fromArray(assembly.rotationXyzw);
      group.scale.setScalar(assembly.scale??1);group.add(imported);root.add(group);
      imported.traverse(object=>{
        if(!(object instanceof THREE.Mesh))return;
        partCount++;
        const count=object.geometry.index?.count??object.geometry.getAttribute('position')?.count??0;
        triangleCount+=count/3;
      });
      if(triangleCount>MAX_TRIANGLES)throw new Error('This product exceeds the study’s 250,000-triangle preview limit.');
    }
    checkAbort(signal);
    if(!partCount||!Number.isFinite(triangleCount)||triangleCount<=0)throw new Error('The lamp contains no renderable mesh.');
    root.updateMatrixWorld(true);
    return {root,name:source.displayName,partCount,triangleCount};
  }catch(error){disposeSceneObject(root);throw error;}
}
