import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceMaterial, disposeSurfaceMaterial, loadMaterialTextures, MATERIAL_PRESETS, type ImageAsset, type MaterialSpecification } from './materials';
const specification: MaterialSpecification = { baseColor: [.2, .4, .6, 1], roughness: .3, metallic: .4 };
function png(width = 2, height = 2) {
  // Header fixture; the actual browser decoder is mocked independently below.
  const bytes = new ArrayBuffer(33), header = new DataView(bytes);
  header.setUint32(0, 0x89504e47); header.setUint32(4, 0x0d0a1a0a);
  header.setUint32(8, 13); header.setUint32(12, 0x49484452);
  header.setUint32(16, width); header.setUint32(20, height);
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const asset: ImageAsset = { format: 'png', sha256, path: `assets/${sha256}.png` };
  return { bytes, asset };
}
function bitmap(width = 2, height = 2) { return { width, height, close: vi.fn() } as unknown as ImageBitmap; }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shared physical material rendering', () => {
  it('preserves linear color, opacity, physical scalars, and stable presets', () => {
    const material = createSurfaceMaterial({ ...specification, baseColor: [.2, .4, .6, .5], transmission: .8, ior: 1.46 });
    expect(material.color.toArray()).toEqual([.2, .4, .6]);
    expect(material.roughness).toBe(.3); expect(material.metalness).toBe(.4);
    expect(material.transparent).toBe(true); expect(material.opacity).toBe(.5);
    expect(material.transmission).toBe(.8); expect(material.ior).toBe(1.46);
    expect(material.thickness).toBe(.006); expect(material.bumpScale).toBe(0);
    expect(material.normalScale.toArray()).toEqual([1, 1]);
    expect(MATERIAL_PRESETS.map(item => item.name)).toEqual(['Glass', 'Plastic', 'Metal', 'Ceramic', 'Rubber', 'Paper']);
    expect(MATERIAL_PRESETS.find(item => item.id === 'metal')!.material.metallic).toBe(1);
    expect(MATERIAL_PRESETS.find(item => item.id === 'glass')!.material.transmission).toBeGreaterThan(.9);
  });

  it('loads all five maps with correct color spaces, channels, repeat, and physical strength', async () => {
    const fixture = png(); vi.stubGlobal('fetch', vi.fn(async () => new Response(fixture.bytes)));
    const decode = vi.fn(async () => bitmap()); vi.stubGlobal('createImageBitmap', decode);
    const material = createSurfaceMaterial(specification);
    await loadMaterialTextures(material, { ...specification, textureRepeat: [2, 3], normalScale: .6, heightScaleM: .0004,
      textures: { basecolor: fixture.asset, normal: fixture.asset, roughness: fixture.asset, metalness: fixture.asset, height: fixture.asset } }, asset => `/api/${asset.path}`);
    expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace);
    for (const texture of [material.normalMap, material.roughnessMap, material.metalnessMap, material.bumpMap]) expect(texture!.colorSpace).toBe(THREE.NoColorSpace);
    for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.bumpMap]) {
      expect(texture!.repeat.toArray()).toEqual([2, 3]); expect(texture!.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture!.wrapT).toBe(THREE.RepeatWrapping); expect(texture!.flipY).toBe(false);
    }
    expect(material.normalScale.toArray()).toEqual([.6, .6]); expect(material.bumpScale).toBe(.0004);
    expect(material.roughness).toBe(.3); expect(material.metalness).toBe(.4); // maps multiply these source values
    expect(decode).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  });

  it('retains the previous texture until complete decode and disposes it after replacement', async () => {
    const fixture = png(); vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    let finish!: (value: ImageBitmap) => void;
    const decode = vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve; })); vi.stubGlobal('createImageBitmap', decode);
    const oldImage = bitmap(), previous = new THREE.Texture(oldImage), dispose = vi.spyOn(previous, 'dispose');
    const material = createSurfaceMaterial(specification); material.map = previous;
    const pending = loadMaterialTextures(material, { ...specification, textures: { basecolor: fixture.asset } }, () => '/api/image.png');
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    expect(material.map).toBe(previous); expect(dispose).not.toHaveBeenCalled();
    const image = bitmap(); finish(image); await pending;
    expect(material.map!.image).toBe(image); expect(dispose).toHaveBeenCalledOnce(); expect(oldImage.close).toHaveBeenCalledOnce();
  });

  it('aborts stale texture decodes without publishing or leaking their bitmap', async () => {
    const fixture = png(); vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    let finish!: (value: ImageBitmap) => void;
    const decode = vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve; })); vi.stubGlobal('createImageBitmap', decode);
    const material = createSurfaceMaterial(specification), previous = new THREE.Texture(); material.map = previous;
    const controller = new AbortController();
    const pending = loadMaterialTextures(material, { ...specification, textures: { basecolor: fixture.asset } }, () => '/api/image.png', { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    controller.abort(); const image = bitmap(); finish(image); await rejected;
    expect(material.map).toBe(previous); expect(image.close).toHaveBeenCalledOnce();
  });

  it('rejects hash mismatch, unsafe paths, and oversized images before decoding', async () => {
    const fixture = png(); const fetch = vi.fn(async () => new Response(fixture.bytes)); vi.stubGlobal('fetch', fetch);
    const decode = vi.fn(async () => bitmap()); vi.stubGlobal('createImageBitmap', decode);
    const material = createSurfaceMaterial(specification), load = (asset: ImageAsset) => loadMaterialTextures(material, { ...specification, textures: { normal: asset } }, () => '/api/image.png');
    await expect(load({ ...fixture.asset, path: '../private.png' })).rejects.toThrow('safe'); expect(fetch).not.toHaveBeenCalled();
    await expect(load({ ...fixture.asset, sha256: '0'.repeat(64), path: `assets/${'0'.repeat(64)}.png` })).rejects.toThrow('SHA-256');
    const large = png(4097, 2); fetch.mockImplementation(async () => new Response(large.bytes));
    await expect(load(large.asset)).rejects.toThrow('dimensions'); expect(decode).not.toHaveBeenCalled();
  });

  it('releases successfully decoded siblings when another map fails and keeps the old surface', async () => {
    const fixture = png(); vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    const image = bitmap(); vi.stubGlobal('createImageBitmap', async () => image);
    const material = createSurfaceMaterial(specification), previous = new THREE.Texture(); material.map = previous;
    await expect(loadMaterialTextures(material, { ...specification, textures: { basecolor: fixture.asset,
      normal: { ...fixture.asset, sha256: '0'.repeat(64), path: `assets/${'0'.repeat(64)}.png` } } }, () => '/api/image.png')).rejects.toThrow('SHA-256');
    expect(image.close).toHaveBeenCalledOnce(); expect(material.map).toBe(previous); expect(material.normalMap).toBeNull();
  });

  it('closes each shared image once during normal material teardown', () => {
    const image = bitmap(), material = createSurfaceMaterial(specification), texture = new THREE.Texture(image);
    material.map = texture; material.bumpMap = texture;
    const dispose = vi.spyOn(texture, 'dispose'), materialDispose = vi.spyOn(material, 'dispose');
    disposeSurfaceMaterial(material);
    expect(image.close).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); expect(materialDispose).toHaveBeenCalledOnce();
  });
});
