import * as THREE from 'three';
import {loadTexture, type ImageAsset} from './materials';

export type SurfaceArtwork = {partId:string; componentId:string; finish:'paper'|'original'; asset:ImageAsset};

/** Replacement uses the source UV0, including its seams. One immutable image
 * supplies both color and cutout; old printed masks cannot tint the new label. */
export function artworkSurface(original:THREE.Material, texture:THREE.Texture, finish:'paper'|'original'):THREE.MeshStandardMaterial {
  const surface = finish === 'original' && original instanceof THREE.MeshStandardMaterial
    ? original.clone() : new THREE.MeshStandardMaterial({roughness:.53,metalness:0,side:THREE.DoubleSide});
  surface.name = original.name;
  surface.userData = {...original.userData, gessoArtworkReplacement:true};
  surface.map = texture;
  surface.color.setRGB(1,1,1);
  surface.alphaMap = null;
  surface.opacity = 1;
  surface.transparent = false;
  surface.alphaTest = .5;
  surface.needsUpdate = true;
  return surface;
}

/** Commit only decoded images; replace the exact source node’s own surfaces.
 * Dispose maps removed from the scene, retaining maps shared by other parts. */
export async function replaceSurfaceArtwork(content:THREE.Object3D, parts:Map<string,THREE.Object3D>,
    assignments:SurfaceArtwork[], assetUrl:(asset:ImageAsset)=>string, signal:AbortSignal):Promise<void> {
  if (!assignments.length) return;
  const bindings = new Map<THREE.Object3D,SurfaceArtwork>();
  const sourceNodes = new Set(parts.values());
  for (const assignment of assignments) {
    const node = parts.get(assignment.partId);
    if (!node) throw new Error('The selected artwork surface is no longer available.');
    bindings.set(node,assignment);
  }
  const loaded = new Map<string,THREE.Texture>();
  try {
    for (const {asset} of assignments) if (!loaded.has(asset.sha256))
      loaded.set(asset.sha256, await loadTexture(asset,'basecolor',assetUrl,signal));
    if (signal.aborted) throw new DOMException('Artwork loading was superseded.','AbortError');
  } catch (error) {
    for (const texture of loaded.values()) { texture.dispose(); texture.image?.close?.(); }
    throw error;
  }
  const retired = new Set<THREE.Material>();
  const used = new Set<THREE.Texture>();
  const created = new Map<string,THREE.MeshStandardMaterial>();
  content.traverse(object => {
    if (!(object instanceof THREE.Mesh) || object.userData.gessoArtwork) return;
    let binding:SurfaceArtwork|undefined;
    for (let node:THREE.Object3D|null=object;node;node=node.parent) {
      binding=bindings.get(node);
      if(binding || sourceNodes.has(node))break;
    }
    if (!binding) return;
    const texture = loaded.get(binding.asset.sha256)!;
    used.add(texture);
    const replace = (original:THREE.Material) => {
      retired.add(original);
      const key = `${original.uuid}:${binding!.asset.sha256}:${binding!.finish}`;
      if (!created.has(key)) created.set(key,artworkSurface(original,texture,binding!.finish));
      return created.get(key)!;
    };
    object.material = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
  });
  const live = new Set<THREE.Material>(), retained = new Set<THREE.Texture>();
  content.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material)?object.material:[object.material]) {
      live.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) retained.add(value);
    }
  });
  const discarded = new Set<THREE.Texture>();
  for (const material of retired) if (!live.has(material)) {
    for(const value of Object.values(material)) if(value instanceof THREE.Texture&&!retained.has(value))discarded.add(value);
    material.dispose();
  }
  for(const texture of loaded.values())if(!used.has(texture))discarded.add(texture);
  const retainedImages=new Set(Array.from(retained,texture=>texture.image));
  for(const texture of discarded)texture.dispose();
  for(const bitmap of new Set(Array.from(discarded,texture=>texture.image)))
    if(!retainedImages.has(bitmap))bitmap?.close?.();
}
