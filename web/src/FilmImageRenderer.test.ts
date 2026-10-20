import {afterEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three';
import {FilmImageRenderer, imagePlaneSize} from './FilmImageRenderer';

afterEach(() => {vi.unstubAllGlobals();});
describe('timed image playback', () => {
  it('contains the full image or crops symmetrically without stretching', () => {
    expect(imagePlaneSize(1600, 900, 1, 'contain')).toEqual({x: 1, y: 9 / 16});
    expect(imagePlaneSize(900, 1600, 1, 'cover')).toEqual({x: 1, y: 16 / 9});
    expect(imagePlaneSize(1600, 900, 16 / 9, 'cover')).toEqual({x: 1, y: 1});
  });
  it('preloads each verified bitmap once, uses sRGB without film grading, and releases it', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    const asset = {path: `assets/${hash}.png`, sha256: hash, width: 16, height: 9};
    const close = vi.fn();
    const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({close})));
    const images = new FilmImageRenderer();
    await images.prepare([{kind: 'image', image: {asset}}, {kind: 'image', image: {asset}}], new AbortController().signal);
    await images.prepare([{kind: 'image', image: {asset}}], new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    const renderer = {getClearColor: () => new THREE.Color(0xffffff), getClearAlpha: () => 0,
      setClearColor: vi.fn(), clear: vi.fn(), setViewport: vi.fn(), setScissor: vi.fn(), setScissorTest: vi.fn(), render: vi.fn((_scene: THREE.Scene, _camera: THREE.Camera) => {})};
    images.draw(renderer as any, {kind: 'image', asset, fit: 'contain'}, {width: 800, height: 600}, {x: 100, y: 100, width: 600, height: 400});
    const scene = renderer.render.mock.calls[0][0] as THREE.Scene;
    const mesh = scene.children[0] as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    expect(mesh.visible).toBe(true); expect(mesh.material.toneMapped).toBe(false);
    expect(mesh.material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(renderer.setScissor).toHaveBeenCalledWith(100, 100, 600, 400);
    expect(renderer.setViewport).toHaveBeenLastCalledWith(0, 0, 800, 600);
    images.draw(renderer as any, {kind: 'black'}, {width: 800, height: 600}, {x: 0, y: 0, width: 800, height: 600});
    expect(mesh.visible).toBe(false); expect((scene.background as THREE.Color).getHex()).toBe(0);
    images.dispose(); expect(close).toHaveBeenCalledTimes(1);
  });
  it('rejects an image whose bytes differ from the saved asset', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1])));
    const images = new FilmImageRenderer(), signal = new AbortController().signal;
    await expect(images.prepare([{kind: 'image', image: {asset: {path: `assets/${'a'.repeat(64)}.png`, sha256: 'a'.repeat(64)}}}], signal)).rejects.toThrow('changed');
    images.dispose();
  });
});
