import * as THREE from 'three';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {loadCurveProduct} from './curveProductAsset';
import {disposeSceneObject,loadVerifiedGlb,prepareImportedMesh} from './sceneObjects';
vi.mock('./sceneObjects',()=>({loadVerifiedGlb:vi.fn(),prepareImportedMesh:vi.fn(),disposeSceneObject:vi.fn()}));
const asset={format:'glb',path:`assets/${'a'.repeat(64)}.glb`,sha256:'a'.repeat(64),sourceUp:'Y'};
const product=()=>({displayName:'Artemide Nessino',components:[{id:'product',shape:'mesh',asset,assembly:{translationM:[0,.111,0],rotationXyzw:[0,0,0,1],scale:2}}]});
const mesh=()=>{const root=new THREE.Group(),material=new THREE.MeshStandardMaterial({color:0xf4652e});root.add(new THREE.Mesh(new THREE.BoxGeometry(),material));return root;};
function responses(values:unknown[]){return vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>values.shift()})));}

beforeEach(()=>{vi.clearAllMocks();vi.mocked(loadVerifiedGlb).mockResolvedValue(mesh());});
afterEach(()=>vi.unstubAllGlobals());

describe('local curve-study product',()=>{
  it('loads only the verified lamp and retains imported geometry, finish and component transforms',async()=>{
    const imported=mesh(),geometry=(imported.children[0] as THREE.Mesh).geometry,material=(imported.children[0] as THREE.Mesh).material;
    vi.mocked(loadVerifiedGlb).mockResolvedValue(imported);
    responses([[{id:'bottle',name:'Perfume bottle'},{id:'lamp',name:'Nessino / Campaign 01'}],{scene:{product:product(),environment:{asset:{path:'large-room.glb'}}}}]);
    const signal=new AbortController().signal,result=await loadCurveProduct(signal);
    expect(result.name).toBe('Artemide Nessino');expect(result.partCount).toBe(1);expect(result.triangleCount).toBe(12);
    expect(result.root.children[0].position.toArray()).toEqual([0,.111,0]);expect(result.root.children[0].scale.toArray()).toEqual([2,2,2]);
    expect(result.root.children[0].children[0]).toBe(imported);
    expect((imported.children[0] as THREE.Mesh).geometry).toBe(geometry);expect((imported.children[0] as THREE.Mesh).material).toBe(material);
    expect(loadVerifiedGlb).toHaveBeenCalledExactlyOnceWith(asset,signal);expect(prepareImportedMesh).toHaveBeenCalledWith(imported);
    expect(vi.mocked(fetch).mock.calls.map(call=>call[0])).toEqual(['/api/projects','/api/projects/lamp']);
  });
  it('requires product identity, not just a campaign name, and never falls back to another product',async()=>{
    responses([[{id:'fake',name:'Nessino reference'},{id:'lamp',name:'Nessino / Campaign 01'}],{scene:{product:{...product(),displayName:'Bottle'}}},{scene:{product:product()}}]);
    expect((await loadCurveProduct(new AbortController().signal)).name).toBe('Artemide Nessino');
    expect(loadVerifiedGlb).toHaveBeenCalledTimes(1);
  });
  it('reports a missing lamp without fetching models or creating a project',async()=>{
    responses([[{id:'bottle',name:'Perfume bottle'}]]);
    await expect(loadCurveProduct(new AbortController().signal)).rejects.toThrow('local Nessino campaign is unavailable');
    expect(loadVerifiedGlb).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('aborts before fetching and disposes a model whose load completed after cancellation',async()=>{
    const controller=new AbortController();controller.abort();responses([]);
    await expect(loadCurveProduct(controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(fetch).not.toHaveBeenCalled();
    const late=new AbortController(),imported=mesh();
    responses([[{id:'lamp',name:'Nessino'}],{scene:{product:product()}}]);
    vi.mocked(loadVerifiedGlb).mockImplementation(async()=>{late.abort();return imported;});
    await expect(loadCurveProduct(late.signal)).rejects.toMatchObject({name:'AbortError'});expect(disposeSceneObject).toHaveBeenCalledWith(imported);
  });
  it('rejects over-budget geometry and disposes the owned scene',async()=>{
    const imported=new THREE.Group(),geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(750_003*3),3));
    imported.add(new THREE.Mesh(geometry,new THREE.MeshBasicMaterial()));vi.mocked(loadVerifiedGlb).mockResolvedValue(imported);
    responses([[{id:'lamp',name:'Nessino'}],{scene:{product:product()}}]);
    await expect(loadCurveProduct(new AbortController().signal)).rejects.toThrow('250,000-triangle');
    expect(disposeSceneObject).toHaveBeenCalled();
  });
});
