import {describe,expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {CURVE_PRODUCT_BUFFER,normalizeCurveProductRotation,normalizeCurveProductSettings,prepareCurveProductObject} from './curveProductRenderer';

function fixture(){
  const root=new THREE.Group(),geometry=new THREE.BoxGeometry(.32,.22,.32),material=new THREE.MeshStandardMaterial({color:'#f4652e',roughness:.3});
  const first=new THREE.Mesh(geometry,material),second=new THREE.Mesh(geometry,material);
  first.position.set(.1,.3,0);first.rotation.z=.1;second.position.set(-.1,.2,0);second.scale.setScalar(.4);root.add(first,second);
  return {root,first,second,geometry,material};
}
const wire={mode:'wireframe' as const,opacity:.2,edges:.5,backEdges:false};

describe('real product inspection renderer',()=>{
  it('keeps the draw buffer below the preview budget at exact specimen aspect',()=>{
    expect(CURVE_PRODUCT_BUFFER.width*CURVE_PRODUCT_BUFFER.height).toBeLessThan(350_000);
    expect(CURVE_PRODUCT_BUFFER.width/CURVE_PRODUCT_BUFFER.height).toBe(1000/600);
  });
  it('bounds inputs without inventing object transformations',()=>{
    expect(normalizeCurveProductSettings({...wire,opacity:-2,edges:9})).toEqual({...wire,opacity:0,edges:1});
    expect(normalizeCurveProductRotation({yaw:450,pitch:1000})).toEqual({yaw:90,pitch:80});
    expect(normalizeCurveProductRotation({yaw:NaN,pitch:NaN})).toEqual({yaw:0,pitch:0});
  });
  it('normalizes using parents, retaining CAD transforms and shared geometry',()=>{
    const {root,first,second,geometry}=fixture();root.updateMatrixWorld(true);
    const transforms=[first.matrix.clone(),second.matrix.clone()],positions=Array.from(geometry.attributes.position.array);
    const product=prepareCurveProductObject(root);
    product.apply(wire,{yaw:34,pitch:12});
    expect(first.matrix.equals(transforms[0])).toBe(true);expect(second.matrix.equals(transforms[1])).toBe(true);
    expect(Array.from(geometry.attributes.position.array)).toEqual(positions);
    expect(first.children).toHaveLength(2);
    for(const child of first.children)expect((child as THREE.Mesh).geometry).toBe(geometry);
    product.dispose();
  });
  it('changes the object surface itself and restores original solid materials',()=>{
    const {root,first,material}=fixture(),product=prepareCurveProductObject(root);
    product.apply(wire,{yaw:0,pitch:0});
    const fill=first.material as THREE.MeshStandardMaterial;
    expect(fill).not.toBe(material);expect(fill.color.equals(material.color)).toBe(true);expect(fill.opacity).toBe(.2);
    const edges=first.children.find(child=>child.name==='Inspection triangle edges') as THREE.Mesh;
    const depth=first.children.find(child=>child.name==='Inspection depth') as THREE.Mesh;
    expect((edges.material as THREE.MeshBasicMaterial).wireframe).toBe(true);expect(edges.visible).toBe(true);expect(depth.visible).toBe(true);
    product.apply({...wire,opacity:0,backEdges:true},{yaw:0,pitch:0});
    expect(fill.visible).toBe(false);expect(edges.visible).toBe(true);expect(depth.visible).toBe(false);
    expect((edges.material as THREE.Material).depthTest).toBe(false);
    product.apply({...wire,mode:'solid'},{yaw:0,pitch:0});
    expect(first.material).toBe(material);expect(edges.visible).toBe(false);expect(depth.visible).toBe(false);
    product.dispose();
  });
  it('disposes shared source buffers once, including after repeated cleanup',()=>{
    const {root,geometry,material}=fixture(),geometryDispose=vi.spyOn(geometry,'dispose'),materialDispose=vi.spyOn(material,'dispose');
    const product=prepareCurveProductObject(root);product.apply(wire,{yaw:0,pitch:0});product.dispose();product.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(()=>product.apply(wire,{yaw:0,pitch:0})).toThrow(/disposed/);
  });
});

it('uses the same normalized settings as the controls and URL model',async()=>{
  const {normalizeProductSettings,DEFAULT_PRODUCT_SETTINGS}=await import('./curveProductSettings');
  expect(normalizeCurveProductSettings).toBe(normalizeProductSettings);
  expect(normalizeCurveProductSettings({mode:'wireframe',opacity:NaN,edges:NaN,backEdges:false})).toEqual({...DEFAULT_PRODUCT_SETTINGS,mode:'wireframe'});
});

it('rejects instanced and morph-target geometry before attaching overlays',()=>{
  const geometry=new THREE.BoxGeometry(),material=new THREE.MeshBasicMaterial();
  const instanceRoot=new THREE.Group(),instance=new THREE.InstancedMesh(geometry,material,1);instanceRoot.add(instance);
  expect(()=>prepareCurveProductObject(instanceRoot)).toThrow(/instanced/);
  expect(instanceRoot.parent).toBeNull();expect(instance.children).toHaveLength(0);
  const morphRoot=new THREE.Group(),morph=new THREE.Mesh(geometry,material);morphRoot.add(morph);
  geometry.morphAttributes.position=[geometry.attributes.position.clone()];
  expect(()=>prepareCurveProductObject(morphRoot)).toThrow(/morph targets/);
  expect(morphRoot.parent).toBeNull();expect(morph.children).toHaveLength(0);
  geometry.dispose();material.dispose();
});

it('rolls back partial material preparation without disposing the source',()=>{
  const {root,geometry,material,second}=fixture();
  const firstClone=new THREE.MeshStandardMaterial(),cloneDispose=vi.spyOn(firstClone,'dispose');
  vi.spyOn(material,'clone').mockReturnValue(firstClone);
  const broken=new THREE.MeshStandardMaterial();second.material=broken;
  vi.spyOn(broken,'clone').mockImplementation(()=>{throw new Error('Material clone failed');});
  const geometryDispose=vi.spyOn(geometry,'dispose'),sourceDispose=vi.spyOn(material,'dispose');
  expect(()=>prepareCurveProductObject(root)).toThrow('Material clone failed');
  expect(root.parent).toBeNull();expect(root.children.every(child=>child.children.length===0)).toBe(true);
  expect(cloneDispose).toHaveBeenCalledTimes(1);expect(geometryDispose).not.toHaveBeenCalled();expect(sourceDispose).not.toHaveBeenCalled();
});
