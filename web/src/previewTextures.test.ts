import * as THREE from 'three';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {capPreviewTextures} from './previewTextures';

class Bitmap {
  close = vi.fn();
  constructor(public width: number, public height: number) {}
}
function texture(image: Bitmap) {return new THREE.Texture(image as unknown as ImageBitmap);}
function rootWith(...materials: THREE.Material[]) {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BufferGeometry(), materials));
  return root;
}
function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
beforeEach(() => {vi.stubGlobal('ImageBitmap', Bitmap);});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('owned GLB preview textures', () => {
  it('resizes a shared bitmap once while preserving sources, materials and color/sampling settings', async () => {
    const original = new Bitmap(8192, 4096), map = texture(original), normal = map.clone(), independent = texture(original);
    map.colorSpace = THREE.SRGBColorSpace; map.flipY = false; map.repeat.set(3, 2);
    normal.colorSpace = THREE.NoColorSpace; normal.channel = 1; normal.wrapS = THREE.RepeatWrapping;
    const source = map.source, independentSource = independent.source;
    const material = new THREE.MeshPhysicalMaterial({map, normalMap:normal, roughnessMap:independent, roughness:.3, transmission:.8});
    const resized = new Bitmap(2048, 1024);
    const decode = vi.fn(async () => resized); vi.stubGlobal('createImageBitmap', decode);
    const root = rootWith(material);
    expect(await capPreviewTextures(root)).toEqual({
      resizedImages:1, failedImages:0, originalPixels:8192 * 4096, previewPixels:2048 * 1024,
    });
    expect(decode).toHaveBeenCalledExactlyOnceWith(original, {
      resizeWidth:2048, resizeHeight:1024, resizeQuality:'high',
      imageOrientation:'none', premultiplyAlpha:'none', colorSpaceConversion:'none',
    });
    expect(map.source).toBe(source); expect(normal.source).toBe(source);
    expect(independent.source).toBe(independentSource);
    for (const entry of [map, normal, independent]) {expect(entry.image).toBe(resized); expect(entry.version).toBeGreaterThan(0);}
    expect(map.colorSpace).toBe(THREE.SRGBColorSpace); expect(map.flipY).toBe(false);
    expect(map.repeat.toArray()).toEqual([3, 2]); expect(normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(normal.channel).toBe(1); expect(normal.wrapS).toBe(THREE.RepeatWrapping);
    expect(material.map).toBe(map); expect(material.roughness).toBe(.3); expect(material.transmission).toBe(.8);
    expect(original.close).toHaveBeenCalledOnce(); expect(resized.close).not.toHaveBeenCalled();
    expect((await capPreviewTextures(root)).resizedImages).toBe(0);
    expect(decode).toHaveBeenCalledOnce();
  });

  it('retains small, empty, data and manual-mipmap maps, including shared unsupported bitmap sources', async () => {
    const small = new Bitmap(2048, 1024), protectedImage = new Bitmap(8192, 8192), manualImage = new Bitmap(4096, 4096);
    const map = texture(small), empty = new THREE.Texture(), shared = texture(protectedImage);
    const cube = new THREE.CubeTexture(Array.from({length:6}, () => protectedImage));
    const manual = texture(manualImage); manual.mipmaps = [{} as ImageData];
    const data = new THREE.DataTexture(new Uint8Array(4), 8192, 8192);
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    const root = rootWith(new THREE.MeshPhysicalMaterial({map, normalMap:empty, roughnessMap:shared, envMap:cube, metalnessMap:manual, alphaMap:data}));
    expect((await capPreviewTextures(root)).resizedImages).toBe(0);
    expect(decode).not.toHaveBeenCalled(); expect(shared.image).toBe(protectedImage);
    for (const image of [small, protectedImage, manualImage]) expect(image.close).not.toHaveBeenCalled();
  });

  it('bounds concurrent resize work and releases each old bitmap before starting the next', async () => {
    const first = new Bitmap(4096, 8192), second = new Bitmap(8192, 8192);
    const pending = deferred<Bitmap>(), firstResult = new Bitmap(1024, 2048), secondResult = new Bitmap(2048, 2048);
    const decode = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementationOnce(async () => {
      expect(first.close).toHaveBeenCalledOnce(); return secondResult;
    });
    vi.stubGlobal('createImageBitmap', decode);
    const work = capPreviewTextures(rootWith(new THREE.MeshPhysicalMaterial({map:texture(first), normalMap:texture(second)})));
    expect(decode).toHaveBeenCalledOnce();
    pending.resolve(firstResult);
    expect((await work).resizedImages).toBe(2);
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('does no decoding when already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    await expect(capPreviewTextures(rootWith(), {signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['abort', 'dispose', 'replace'])('does not publish or leak a late resize after %s', async action => {
    const original = new Bitmap(8192, 4096), map = texture(original), pending = deferred<Bitmap>();
    vi.stubGlobal('createImageBitmap', vi.fn(() => pending.promise));
    const controller = new AbortController();
    const work = capPreviewTextures(rootWith(new THREE.MeshPhysicalMaterial({map})), {signal:controller.signal});
    const replacement = new Bitmap(512, 512);
    if (action === 'abort') controller.abort();
    if (action === 'dispose') map.dispose();
    if (action === 'replace') map.image = replacement as unknown as ImageBitmap;
    const late = new Bitmap(2048, 1024); pending.resolve(late);
    if (action === 'abort') await expect(work).rejects.toMatchObject({name:'AbortError'});
    else expect((await work).resizedImages).toBe(0);
    expect(map.image).toBe(action === 'replace' ? replacement : original);
    expect(late.close).toHaveBeenCalledOnce(); expect(original.close).not.toHaveBeenCalled();
  });

  it('retains a working original if resizing fails or produces the wrong dimensions', async () => {
    for (const failure of ['reject', 'dimensions']) {
      const original = new Bitmap(8192, 4096), map = texture(original), invalid = new Bitmap(8192, 4096);
      vi.stubGlobal('createImageBitmap', vi.fn(async () => {if (failure === 'reject') throw new Error('Decode failed'); return invalid;}));
      const report = await capPreviewTextures(rootWith(new THREE.MeshPhysicalMaterial({map})));
      expect(report.failedImages).toBe(1); expect(report.resizedImages).toBe(0);
      expect(map.image).toBe(original); expect(original.close).not.toHaveBeenCalled();
      if (failure === 'dimensions') expect(invalid.close).toHaveBeenCalledOnce();
    }
  });
});
