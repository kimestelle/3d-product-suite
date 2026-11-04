import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {disposeSceneObject,loadVerifiedGlb} from './sceneObjects';
import {createWorldCleanupOverlay} from './worldCleanupSelection';

function fixture(materials:any[], textured=false, configure?:(document:any)=>void) {
  const binary=new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0, 1,0, 0,1]);
  const document={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],materials,
    ...(materials.some(material=>material.extensions?.KHR_materials_unlit)?{extensionsUsed:['KHR_materials_unlit']}:{}),
    buffers:[{byteLength:binary.byteLength}],bufferViews:[{buffer:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},
      {bufferView:1,componentType:5126,count:3,type:'VEC2'}],
    ...(textured?{images:[{uri:'data:image/png;base64,AA=='}],textures:[{source:0}]}:{})};
  configure?.(document);
  const json=new TextEncoder().encode(JSON.stringify(document)),jsonLength=Math.ceil(json.length/4)*4;
  const bytes=new ArrayBuffer(28+jsonLength+binary.byteLength),header=new DataView(bytes);
  header.setUint32(0,0x46546c67,true);header.setUint32(4,2,true);header.setUint32(8,bytes.byteLength,true);
  header.setUint32(12,jsonLength,true);header.setUint32(16,0x4e4f534a,true);
  new Uint8Array(bytes,20,jsonLength).fill(32);new Uint8Array(bytes,20,json.length).set(json);
  header.setUint32(20+jsonLength,binary.byteLength,true);header.setUint32(24+jsonLength,0x004e4942,true);
  new Uint8Array(bytes,28+jsonLength).set(new Uint8Array(binary.buffer));
  const sha256=createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  return {bytes,asset:{format:'glb',sourceUp:'Y',sha256,path:`assets/${sha256}.glb`}};
}
const colorMaterial={extensions:{KHR_materials_unlit:{}},pbrMetallicRoughness:{baseColorTexture:{index:0}}};
function serve(input:ReturnType<typeof fixture>, decode:()=>Promise<unknown>) {
  vi.stubGlobal('self',{URL});
  vi.stubGlobal('createImageBitmap',vi.fn(decode));
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(url.startsWith('data:')?new Uint8Array([0]):input.bytes)));
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('verified GLB source color maps',()=>{
  it('rejects an actually used baked color map when GLTFLoader swallows its decode failure, releasing the parsed scene',async()=>{
    const input=fixture([colorMaterial],true);
    serve(input,async()=>{throw new Error('decode failed');});
    const geometry=vi.spyOn(THREE.BufferGeometry.prototype,'dispose'),material=vi.spyOn(THREE.Material.prototype,'dispose');
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    await expect(loadVerifiedGlb(input.asset,new AbortController().signal)).rejects.toThrow('source color texture could not be loaded');
    expect(createImageBitmap).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("THREE.GLTFLoader: Couldn't load texture",'data:image/png;base64,AA==');
    expect(geometry).toHaveBeenCalled();expect(material).toHaveBeenCalled();
  });

  it('preserves a decoded baked map and its immutable source material identity',async()=>{
    const input=fixture([colorMaterial],true),image={width:2,height:2};serve(input,async()=>image);
    const root=await loadVerifiedGlb(input.asset,new AbortController().signal);
    const mesh=root.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshBasicMaterial>;
    expect(mesh.material.map?.image).toBe(image);expect(mesh.material.userData.gessoSourceMaterial).toBe(0);
    expect(mesh.userData.gessoSourceNode?.index).toBe(0);
    expect(mesh.userData.gessoSourcePrimitive).toEqual({meshIndex:0,primitiveIndex:0,mode:4});
    disposeSceneObject(root);
  });

  it('identifies primitive faces through actual repeated nodes and primitive groups',async()=>{
    const input=fixture([{}],false,document=>{
      document.scenes[0].nodes=[0,1];document.nodes=[{mesh:0},{mesh:0,translation:[2,0,0]}];
      document.meshes[0].primitives.push({...document.meshes[0].primitives[0]});
    });
    serve(input,async()=>{throw new Error('unused');});
    const root=await loadVerifiedGlb(input.asset,new AbortController().signal);
    const overlay=createWorldCleanupOverlay(root,{sourceSha256:input.asset.sha256,groups:[
      {nodeIndex:1,meshIndex:0,primitiveIndex:1,faceIndices:[0]},
    ]},input.asset.sha256)!;
    expect(overlay.meshes[0].parent?.userData.gessoSourcePrimitive).toEqual({meshIndex:0,primitiveIndex:1,mode:4});
    expect(overlay.bounds().min.toArray()).toEqual([2,0,0]);expect(overlay.bounds().max.toArray()).toEqual([3,1,0]);
    overlay.dispose();disposeSceneObject(root);
  });

  it('does not load or reject an unused textured material',async()=>{
    const input=fixture([{},colorMaterial],true);serve(input,async()=>{throw new Error('unused');});
    const root=await loadVerifiedGlb(input.asset,new AbortController().signal);
    expect(createImageBitmap).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledOnce();disposeSceneObject(root);
  });

  it('retains valid untextured geometry and ignores unknown material extension texture fields',async()=>{
    const input=fixture([{extensions:{VENDOR_unknown:{colorTexture:{index:0}}}}],true);
    serve(input,async()=>{throw new Error('unused');});
    const root=await loadVerifiedGlb(input.asset,new AbortController().signal);
    expect(createImageBitmap).not.toHaveBeenCalled();expect(root.children[0]).toBeInstanceOf(THREE.Mesh);disposeSceneObject(root);
  });
});
