import * as THREE from 'three';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {artworkSurface, replaceSurfaceArtwork, type SurfaceArtwork} from './artworkRenderer';
import {loadTexture} from './materials';
vi.mock('./materials',()=>({loadTexture:vi.fn()}));
const loader=vi.mocked(loadTexture);
const asset=(c='a')=>({path:`assets/${c.repeat(64)}.png`,sha256:c.repeat(64),format:'png' as const});
const assign=(partId:string,finish:'paper'|'original'='paper',c='a'):SurfaceArtwork=>({componentId:'product',partId,finish,asset:asset(c)});
const url=(value:{path:string})=>'/api/'+value.path;
const signal=()=>new AbortController().signal;
function bitmap(){return {width:8,height:4,close:vi.fn()};}
function map(image=bitmap()){const t=new THREE.Texture(image);t.colorSpace=THREE.SRGBColorSpace;vi.spyOn(t,'dispose');return t;}
function surface(){
  const m=new THREE.MeshPhysicalMaterial({name:'Printed finish',color:0x964431,roughness:.2,metalness:.8,transmission:.4,ior:1.4,opacity:.4,transparent:true});
  m.map=map();m.map.channel=1;m.map.offset.set(.3,.2);m.map.repeat.set(2,3);
  m.roughnessMap=map();m.metalnessMap=m.roughnessMap;m.roughnessMap.channel=1;
  m.normalMap=map();m.normalMap.channel=1;m.alphaMap=map();m.alphaTest=.2;m.userData={source:'approved'};vi.spyOn(m,'dispose');return m;
}
const mesh=(m:THREE.Material|THREE.Material[])=>new THREE.Mesh(new THREE.PlaneGeometry(),m);
beforeEach(()=>loader.mockReset());afterEach(()=>vi.restoreAllMocks());

describe('label surface semantics',()=>{
  it('plain label removes baked glyph channels without changing the source material',()=>{
    const original=surface(),texture=map(),sourceMap=original.map,result=artworkSurface(original,texture,'paper');
    expect(result).not.toBe(original);expect(result.map).toBe(texture);expect(result.color.toArray()).toEqual([1,1,1]);
    expect(result.roughness).toBe(.53);expect(result.metalness).toBe(0);expect(result.normalMap).toBeNull();
    expect(result.roughnessMap).toBeNull();expect(result.metalnessMap).toBeNull();expect(result.alphaMap).toBeNull();
    expect(result.transparent).toBe(false);expect(result.opacity).toBe(1);expect(result.alphaTest).toBe(.5);expect(result.side).toBe(THREE.DoubleSide);
    expect(original.map).toBe(sourceMap);expect(original.color.toArray()).not.toEqual([1,1,1]);expect(original.opacity).toBe(.4);
    expect(result.name).toBe('Printed finish');expect(result.userData.source).toBe('approved');
  });
  it('original finish preserves physical parameters and UV1 maps while the new image uses UV0',()=>{
    const original=surface(),texture=map(),result=artworkSurface(original,texture,'original') as THREE.MeshPhysicalMaterial;
    expect(result).toBeInstanceOf(THREE.MeshPhysicalMaterial);expect(result.roughness).toBe(.2);expect(result.metalness).toBe(.8);
    expect(result.transmission).toBe(.4);expect(result.ior).toBe(1.4);expect(result.normalMap).toBe(original.normalMap);expect(result.normalMap!.channel).toBe(1);
    expect(result.roughnessMap).toBe(original.roughnessMap);expect(result.metalnessMap).toBe(original.metalnessMap);
    expect(result.map).toBe(texture);expect(result.map!.channel).toBe(0);expect(result.map!.offset.toArray()).toEqual([0,0]);expect(result.map!.repeat.toArray()).toEqual([1,1]);
    expect(result.color.toArray()).toEqual([1,1,1]);expect(result.alphaMap).toBeNull();expect(result.alphaTest).toBe(.5);expect(result.opacity).toBe(1);
  });
});

describe('exact artwork binding and lifetime',()=>{
  it('replaces exact source primitive slots, not descendants or shared siblings',async()=>{
    const content=new THREE.Group(),parent=new THREE.Group(),childNode=new THREE.Group(),original=surface(),other=surface();
    const a=mesh(original),b=mesh([original,other]),child=mesh(original),sibling=mesh(original);
    childNode.add(child);parent.add(a,b,childNode);content.add(parent,sibling);
    const decal=mesh(original);decal.userData.gessoArtwork=true;a.add(decal);
    const parts=new Map<string,THREE.Object3D>([['product::node:1',parent],['product::node:2',childNode],['product::node:3',sibling]]);
    const texture=map();loader.mockResolvedValue(texture);const geometry=a.geometry;
    await replaceSurfaceArtwork(content,parts,[assign('product::node:1')],url,signal());
    expect(a.material).not.toBe(original);expect((b.material as THREE.Material[])[0]).toBe(a.material);
    expect(child.material).toBe(original);expect(sibling.material).toBe(original);expect(decal.material).toBe(original);expect(a.geometry).toBe(geometry);
    expect(original.dispose).not.toHaveBeenCalled();expect(original.map!.dispose).not.toHaveBeenCalled();
    expect(other.dispose).toHaveBeenCalledOnce();expect(other.map!.image.close).toHaveBeenCalledOnce();
  });
  it('deduplicates decoded images and replacement materials; closes retired shared maps only once',async()=>{
    const content=new THREE.Group(),original=surface(),a=mesh(original),b=mesh(original);content.add(a,b);
    const texture=map();loader.mockResolvedValue(texture);
    await replaceSurfaceArtwork(content,new Map([['product::node:1',a],['product::node:2',b]]),[assign('product::node:1'),assign('product::node:2')],url,signal());
    expect(loader).toHaveBeenCalledTimes(1);expect(a.material).toBe(b.material);expect(original.dispose).toHaveBeenCalledOnce();
    expect(original.roughnessMap!.dispose).toHaveBeenCalledOnce();expect(original.roughnessMap!.image.close).toHaveBeenCalledOnce();
    expect(texture.dispose).not.toHaveBeenCalled();expect(texture.image.close).not.toHaveBeenCalled();
  });
  it('retains finish maps and shared bitmaps when retiring unused texture objects',async()=>{
    const content=new THREE.Group(),original=surface(),a=mesh(original),b=mesh(original);content.add(a,b);
    const shared=bitmap();original.map!.image=shared;original.normalMap!.image=shared;const texture=map();loader.mockResolvedValue(texture);
    await replaceSurfaceArtwork(content,new Map([['product::node:1',a],['product::node:2',b]]),[assign('product::node:1','paper'),assign('product::node:2','original')],url,signal());
    expect(a.material).not.toBe(b.material);expect((b.material as THREE.MeshStandardMaterial).normalMap).toBe(original.normalMap);
    expect(original.map!.dispose).toHaveBeenCalledOnce();expect(original.normalMap!.dispose).not.toHaveBeenCalled();expect(shared.close).not.toHaveBeenCalled();
    expect((a.material as THREE.MeshStandardMaterial).map).toBe((b.material as THREE.MeshStandardMaterial).map);
  });
  it('rejects an unavailable target before loading',async()=>{
    await expect(replaceSurfaceArtwork(new THREE.Group(),new Map(),[assign('product::node:99')],url,signal())).rejects.toThrow(/no longer available/);
    expect(loader).not.toHaveBeenCalled();
  });
  it('keeps original materials on failed decode and releases completed loads',async()=>{
    const content=new THREE.Group(),original=surface(),a=mesh(original),b=mesh(original);content.add(a,b);
    const texture=map();loader.mockResolvedValueOnce(texture).mockRejectedValueOnce(new Error('Image corrupt'));
    await expect(replaceSurfaceArtwork(content,new Map([['product::node:1',a],['product::node:2',b]]),[assign('product::node:1'),assign('product::node:2','paper','b')],url,signal())).rejects.toThrow('Image corrupt');
    expect(a.material).toBe(original);expect(b.material).toBe(original);expect(original.dispose).not.toHaveBeenCalled();
    expect(texture.dispose).toHaveBeenCalledOnce();expect(texture.image.close).toHaveBeenCalledOnce();
  });
  it('does not publish late pixels after cancellation',async()=>{
    const content=new THREE.Group(),original=surface(),a=mesh(original);content.add(a);const texture=map(),controller=new AbortController();
    loader.mockImplementation(async()=>{controller.abort();return texture;});
    await expect(replaceSurfaceArtwork(content,new Map([['product::node:1',a]]),[assign('product::node:1')],url,controller.signal)).rejects.toThrow(/superseded/);
    expect(a.material).toBe(original);expect(texture.dispose).toHaveBeenCalledOnce();expect(texture.image.close).toHaveBeenCalledOnce();
  });
  it('releases decoded images with no drawable surface',async()=>{
    const content=new THREE.Group(),empty=new THREE.Group();content.add(empty);const texture=map();loader.mockResolvedValue(texture);
    await replaceSurfaceArtwork(content,new Map([['product::node:1',empty]]),[assign('product::node:1')],url,signal());
    expect(texture.dispose).toHaveBeenCalledOnce();expect(texture.image.close).toHaveBeenCalledOnce();
  });
});
