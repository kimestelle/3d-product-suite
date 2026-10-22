import {describe,it,expect,vi} from 'vitest';
import * as THREE from 'three';
import {createModelOutline,renderModelOutline} from './modelOutline';

function product() {
 const root=new THREE.Group();root.position.set(1,2,3);
 const body=new THREE.Mesh(new THREE.BoxGeometry(.3,.2,.2),new THREE.MeshStandardMaterial());
 const cap=new THREE.Mesh(new THREE.CylinderGeometry(.04,.04,.03,12),new THREE.MeshStandardMaterial());cap.position.y=.12;
 root.add(body,cap);
 return {root,body,cap,components:new Map([['product',root]]),parts:new Map<string,THREE.Object3D>([['product',root],['body',body],['cap',cap]])};
}
describe('model outline from loaded geometry',()=>{
 it('shares geometry while preserving source transforms, materials and visibility',()=>{
  const source=product(),material=source.body.material;source.body.visible=false;
  const outline=createModelOutline(source.components,source.parts,new Set());
  const meshes=outline.scene.children as THREE.Mesh[];
  expect(meshes.some(mesh=>mesh.geometry===source.body.geometry)).toBe(true);
  expect(meshes[0].matrix.elements).toEqual(source.body.matrixWorld.elements);
  expect(source.body.material).toBe(material);expect(source.body.visible).toBe(false);
  const dispose=vi.spyOn(source.body.geometry,'dispose');outline.dispose();expect(dispose).not.toHaveBeenCalled();
 });
 it('fills only the hovered part, including its native descendants',()=>{
  const source=product(),outline=createModelOutline(source.components,source.parts,new Set());
  outline.highlight(['cap']);
  const fills=outline.scene.children.filter(item=>item.renderOrder===1);
  expect(fills.map(item=>item.visible)).toEqual([false,true]);
  outline.highlight(['product']);expect(fills.every(item=>item.visible)).toBe(true);
  outline.highlight([]);expect(fills.every(item=>!item.visible)).toBe(true);outline.dispose();
 });
 it('leaves removed parts and their geometry out of the cover',()=>{
  const source=product(),outline=createModelOutline(source.components,source.parts,new Set(['cap']));
  expect(outline.scene.children).toHaveLength(2);
  expect((outline.scene.children as THREE.Mesh[]).every(mesh=>mesh.geometry!==source.cap.geometry)).toBe(true);
  outline.dispose();
  const empty=createModelOutline(source.components,source.parts,new Set(['product']));expect(empty.empty).toBe(true);empty.dispose();
 });
 it('keeps the complete bounds in a stable camera when the highlight changes',()=>{
  const source=product(),outline=createModelOutline(source.components,source.parts,new Set());
  const projection=outline.camera.projectionMatrix.clone(),pose=outline.camera.matrixWorld.clone();
  outline.highlight(['cap']);expect(outline.camera.projectionMatrix.equals(projection)).toBe(true);expect(outline.camera.matrixWorld.equals(pose)).toBe(true);
  const bounds=new THREE.Box3().setFromObject(source.root),corner=new THREE.Vector3();
  for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){corner.set(x,y,z).project(outline.camera);expect(Math.abs(corner.x)).toBeLessThan(1);expect(Math.abs(corner.y)).toBeLessThan(1);}
  outline.dispose();
 });
});

it.each([.5,2])('renders all outline pixels independently of the live pixel ratio %s',ratio=>{
 const source=product(),outline=createModelOutline(source.components,source.parts,new Set());
 const original=new THREE.WebGLRenderTarget(640,480),viewport=new THREE.Vector4();
 let target=original;
 const renderer={autoClear:false,getRenderTarget:()=>target,getActiveCubeFace:()=>0,getActiveMipmapLevel:()=>0,
  setRenderTarget:vi.fn((next:THREE.WebGLRenderTarget)=>{target=next;viewport.copy(next.viewport);}),
  setViewport:(x:number,y:number,w:number,h:number)=>viewport.set(x,y,w,h).multiplyScalar(ratio),
  render:()=>expect(viewport.toArray()).toEqual([0,0,320,200]),readRenderTargetPixels:vi.fn()};
 const context={createImageData:(w:number,h:number)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:vi.fn()};
 vi.stubGlobal('document',{createElement:()=>({getContext:()=>context})});
 try {renderModelOutline(renderer as unknown as THREE.WebGLRenderer,outline);expect(target).toBe(original);expect(renderer.autoClear).toBe(false);}
 finally {vi.unstubAllGlobals();outline.dispose();original.dispose();}
});
