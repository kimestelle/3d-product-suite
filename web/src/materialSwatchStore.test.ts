import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createMaterialSwatchStore} from './materialSwatchStore';
import type {MaterialSpecification} from './materials';

const plain: MaterialSpecification = {baseColor: [.6, .4, .2, 1], roughness: .5, metallic: .2};
const item = (material: MaterialSpecification) => [{id: 'draft', material}];
const assetUrl = (asset: {path: string}) => `/api/${asset.path}`;
function texture(seed = 0) {
  const bytes = new ArrayBuffer(33), header = new DataView(bytes);
  header.setUint32(0, 0x89504e47); header.setUint32(4, 0x0d0a1a0a); header.setUint32(8, 13);
  header.setUint32(12, 0x49484452); header.setUint32(16, 2); header.setUint32(20, 2); header.setUint8(32, seed);
  const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const material: MaterialSpecification = {...plain, textures: {basecolor: {path: `assets/${sha256}.png`, sha256, format: 'png'}}};
  return {bytes, material};
}
const bitmap = () => ({width: 2, height: 2, close: vi.fn()});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('live swatch resources', () => {
  it('keeps the same physical material and shader across repeated scalar edits', () => {
    const invalidate = vi.fn(), store = createMaterialSwatchStore(assetUrl, invalidate);
    store.sync(item(plain)); const material = store.get('draft')!, version = material.version;
    const dispose = vi.spyOn(material, 'dispose');
    for (let index = 0; index < 30; index++) store.sync(item({...plain, roughness: index / 30, metallic: index / 60}));
    expect(store.get('draft')).toBe(material); expect(dispose).not.toHaveBeenCalled();
    expect(material.version).toBe(version); expect(material.roughness).toBe(29 / 30);
    expect(store.states()).toEqual({draft: 'ready'});
    const count = invalidate.mock.calls.length;
    store.sync(item({...plain, roughness: 29 / 30, metallic: 29 / 60}));
    expect(invalidate).toHaveBeenCalledTimes(count);
    store.dispose(); expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains decoded textures through slider, UV repeat and normal strength edits', async () => {
    const fixture = texture(), image = bitmap(), fetch = vi.fn(async () => new Response(fixture.bytes));
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('createImageBitmap', vi.fn(async () => image));
    const store = createMaterialSwatchStore(assetUrl, vi.fn()); store.sync(item(fixture.material));
    await vi.waitFor(() => expect(store.states().draft).toBe('ready'));
    const material = store.get('draft')!, map = material.map!, dispose = vi.spyOn(map, 'dispose');
    store.sync(item({...fixture.material, roughness: .17, textureRepeat: [3, 4], normalScale: .2, heightScaleM: .003}));
    expect(store.get('draft')).toBe(material); expect(material.map).toBe(map);
    expect(map.repeat.toArray()).toEqual([3, 4]); expect(material.normalScale.toArray()).toEqual([.2, .2]);
    expect(material.bumpScale).toBe(.003); expect(fetch).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled(); store.dispose();
    expect(dispose).toHaveBeenCalledOnce(); expect(image.close).toHaveBeenCalledOnce();
  });

  it('does not restart a pending map when sliders move and publishes their latest values', async () => {
    const fixture = texture(), fetch = vi.fn(async () => new Response(fixture.bytes));
    let finish!: (image: unknown) => void;
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => {finish = resolve;})));
    const store = createMaterialSwatchStore(assetUrl, vi.fn()); store.sync(item(fixture.material));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    store.sync(item({...fixture.material, roughness: .11, textureRepeat: [5, 6], normalScale: .3}));
    finish(bitmap()); await vi.waitFor(() => expect(store.states().draft).toBe('ready'));
    expect(store.get('draft')!.roughness).toBe(.11); expect(store.get('draft')!.normalScale.toArray()).toEqual([.3, .3]);
    expect(store.get('draft')!.map!.repeat.toArray()).toEqual([5, 6]); expect(fetch).toHaveBeenCalledOnce();
    store.dispose();
  });

  it('holds the current sample while maps load and rejects late superseded decodes', async () => {
    const a = texture(1), b = texture(2), finish: Array<(image: unknown) => void> = [];
    vi.stubGlobal('fetch', async (url: string) => new Response(url.includes(a.material.textures!.basecolor!.sha256) ? a.bytes : b.bytes));
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => finish.push(resolve))));
    const store = createMaterialSwatchStore(assetUrl, vi.fn()); store.sync(item(plain)); const original = store.get('draft');
    store.sync(item(a.material)); await vi.waitFor(() => expect(finish).toHaveLength(1));
    expect(store.get('draft')).toBe(original);
    store.sync(item(b.material)); await vi.waitFor(() => expect(finish).toHaveLength(2));
    const latest = bitmap(); finish[1](latest);
    await vi.waitFor(() => expect(store.get('draft')!.map?.image).toBe(latest));
    const stale = bitmap(); finish[0](stale); await vi.waitFor(() => expect(stale.close).toHaveBeenCalledOnce());
    expect(store.get('draft')!.map!.image).toBe(latest); store.dispose();
    expect(latest.close).toHaveBeenCalledOnce();
  });

  it.each(['remove', 'dispose'])('releases a pending decode after %s without publishing or invalidating', async action => {
    const fixture = texture(); let finish!: (image: unknown) => void;
    vi.stubGlobal('fetch', async () => new Response(fixture.bytes));
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise(resolve => {finish = resolve;})));
    const invalidate = vi.fn(), store = createMaterialSwatchStore(assetUrl, invalidate); store.sync(item(fixture.material));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (action === 'remove') store.sync([]); else store.dispose();
    const count = invalidate.mock.calls.length, image = bitmap(); finish(image);
    await vi.waitFor(() => expect(image.close).toHaveBeenCalledOnce());
    expect(store.get('draft')).toBeNull(); expect(invalidate).toHaveBeenCalledTimes(count);
    store.dispose();
  });

  it('keeps a working sample on map failure, then allows texture removal', async () => {
    const fixture = texture(); vi.stubGlobal('fetch', async () => new Response('', {status: 404}));
    const store = createMaterialSwatchStore(assetUrl, vi.fn()); store.sync(item(plain)); const original = store.get('draft');
    store.sync(item(fixture.material)); await vi.waitFor(() => expect(store.states().draft).toBe('stale'));
    expect(store.get('draft')).toBe(original);
    store.sync(item(plain)); expect(store.get('draft')).toBe(original); expect(store.states().draft).toBe('ready');
    store.dispose();
  });
});
