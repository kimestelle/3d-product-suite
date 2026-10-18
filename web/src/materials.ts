import * as THREE from 'three';

export type ImageAsset = { path: string; sha256: string; format: 'png' };
export type MaterialTextureChannel = 'basecolor' | 'normal' | 'roughness' | 'metalness' | 'height';
export type MaterialSpecification = {
  name?: string; baseColor: [number, number, number, number]; roughness: number; metallic: number;
  transmission?: number; ior?: number; textures?: Partial<Record<MaterialTextureChannel, ImageAsset>>;
  textureRepeat?: [number, number]; normalScale?: number; heightScaleM?: number;
};
export type MaterialPreview = { componentIds: string[]; material: MaterialSpecification };
export type MaterialPreset = { id: string; name: string; material: MaterialSpecification };

// Linear RGB values, the same inputs used by the product and Blender's Principled shader.
export const MATERIAL_PRESETS: MaterialPreset[] = [
  { id: 'glass', name: 'Glass', material: { name: 'Glass', baseColor: [.96, .98, 1, 1], roughness: .06, metallic: 0, transmission: .96, ior: 1.5 } },
  { id: 'plastic', name: 'Plastic', material: { name: 'Plastic', baseColor: [.52, .55, .57, 1], roughness: .28, metallic: 0, transmission: 0, ior: 1.46 } },
  { id: 'metal', name: 'Metal', material: { name: 'Metal', baseColor: [.78, .8, .82, 1], roughness: .23, metallic: 1, transmission: 0, ior: 1.5 } },
  { id: 'ceramic', name: 'Ceramic', material: { name: 'Ceramic', baseColor: [.84, .82, .77, 1], roughness: .19, metallic: 0, transmission: 0, ior: 1.52 } },
  { id: 'rubber', name: 'Rubber', material: { name: 'Rubber', baseColor: [.025, .028, .027, 1], roughness: .85, metallic: 0, transmission: 0, ior: 1.52 } },
  { id: 'paper', name: 'Paper', material: { name: 'Paper', baseColor: [.9, .87, .8, 1], roughness: .92, metallic: 0, transmission: 0, ior: 1.47 } },
];

/** One physical material implementation for product geometry and preview spheres. */
export function createSurfaceMaterial(specification: MaterialSpecification): THREE.MeshPhysicalMaterial {
  const rgba = specification.baseColor, transmission = specification.transmission ?? 0;
  const material = new THREE.MeshPhysicalMaterial({
    name: specification.name || '',
    color: new THREE.Color().setRGB(rgba[0], rgba[1], rgba[2], THREE.LinearSRGBColorSpace),
    roughness: specification.roughness, metalness: specification.metallic,
    opacity: rgba[3], transparent: rgba[3] < 1, transmission,
    ior: specification.ior ?? 1.5, thickness: transmission ? .006 : 0,
    normalScale: new THREE.Vector2(specification.normalScale ?? 1, specification.normalScale ?? 1),
    bumpScale: specification.heightScaleM ?? 0,
  });
  return material;
}

const TEXTURE_SLOTS = {
  basecolor: 'map', normal: 'normalMap', roughness: 'roughnessMap', metalness: 'metalnessMap', height: 'bumpMap',
} as const;
const PNG_LIMIT = 16 * 1024 * 1024;
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Material loading was superseded.', 'AbortError');
}
function disposeTextures(textures: Iterable<THREE.Texture>): void {
  const unique = new Set(textures), images = new Set(Array.from(unique, texture => texture.image));
  unique.forEach(texture => texture.dispose());
  images.forEach(image => { if (typeof image?.close === 'function') image.close(); });
}

/** Dispose only this material's owned map textures, then the material itself. */
export function disposeSurfaceMaterial(material: THREE.MeshPhysicalMaterial): void {
  disposeTextures(Object.values(TEXTURE_SLOTS).map(slot => material[slot]).filter((texture): texture is THREE.Texture => !!texture));
  material.dispose();
}

async function loadTexture(asset: ImageAsset, channel: MaterialTextureChannel, assetUrl: (asset: ImageAsset) => string, signal?: AbortSignal): Promise<THREE.Texture> {
  if (asset?.format !== 'png' || !/^[a-f0-9]{64}$/.test(asset?.sha256 || '') || asset.path !== `assets/${asset.sha256}.png`) {
    throw new Error('Material textures must declare a safe, content-addressed PNG.');
  }
  aborted(signal);
  const response = await fetch(assetUrl(asset), { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Could not load material texture (${response.status}).`);
  const declared = response.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > PNG_LIMIT)) throw new Error('Material textures must be no larger than 16 MiB.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < 33 || bytes.byteLength > PNG_LIMIT) throw new Error('Material texture PNG is empty, truncated, or exceeds 16 MiB.');
  const header = new DataView(bytes);
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) {
    throw new Error('Material texture must contain a PNG image.');
  }
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16 * 1024 * 1024) {
    throw new Error('Material texture dimensions must be between 1 and 4096 pixels per side.');
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== asset.sha256) throw new Error('Material texture SHA-256 does not match its immutable scene revision.');
  aborted(signal);
  // ImageBitmap orientation is immutable: perform the usual Three texture flip
  // here, and prevent host color conversion on linear data maps.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
    imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  if (signal?.aborted) { bitmap.close(); aborted(signal); }
  if (bitmap.width !== width || bitmap.height !== height) { bitmap.close(); throw new Error('Decoded material texture dimensions differ from its PNG header.'); }
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.colorSpace = channel === 'basecolor' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  texture.name = `${channel}:${asset.sha256}`;
  texture.needsUpdate = true;
  return texture;
}

/** Verify and decode all maps before publishing any of them. Failed or aborted
 * replacement loads preserve the existing material and release their GPU inputs. */
export async function loadMaterialTextures(material: THREE.MeshPhysicalMaterial, specification: MaterialSpecification,
    assetUrl: (asset: ImageAsset) => string, options: { signal?: AbortSignal } = {}): Promise<void> {
  const entries = Object.entries(specification.textures || {}) as [MaterialTextureChannel, ImageAsset][];
  const results = await Promise.allSettled(entries.map(async ([channel, asset]) => {
    if (!(channel in TEXTURE_SLOTS)) throw new Error(`Unsupported material texture channel: ${channel}`);
    return { channel, texture: await loadTexture(asset, channel, assetUrl, options.signal) };
  }));
  const loaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected' || options.signal?.aborted) {
    disposeTextures(loaded.map(item => item.texture));
    if (failure?.status === 'rejected') throw failure.reason;
    aborted(options.signal);
  }
  const repeat = specification.textureRepeat || [1, 1];
  const previous = Object.values(TEXTURE_SLOTS).map(slot => material[slot]).filter((texture): texture is THREE.Texture => !!texture);
  for (const slot of Object.values(TEXTURE_SLOTS)) material[slot] = null;
  for (const { channel, texture } of loaded) {
    texture.repeat.set(repeat[0], repeat[1]);
    material[TEXTURE_SLOTS[channel]] = texture;
  }
  material.normalScale.setScalar(specification.normalScale ?? 1);
  material.bumpScale = specification.heightScaleM ?? 0;
  material.needsUpdate = true;
  disposeTextures(previous);
}
