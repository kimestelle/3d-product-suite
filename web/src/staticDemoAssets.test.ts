import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();});

describe('packaged media without a backend', () => {
  it('loads artwork and audio from the bundle at the configured base', async () => {
    vi.stubEnv('VITE_STATIC_DEMO', '1');
    vi.stubEnv('BASE_URL', '/preview/');
    vi.resetModules();
    const {artworkAssetUrl} = await import('./artwork');
    const {filmAudioUrl} = await import('./filmAudio');
    const hash = 'a'.repeat(64);
    expect(artworkAssetUrl({path: `assets/${hash}.png`, sha256: hash, format: 'png', width: 512, height: 512}))
      .toBe(`/preview/demo/assets/${hash}.png`);
    expect(filmAudioUrl({path: `assets/${hash}.mp3`, sha256: hash, format: 'mp3'}))
      .toBe(`/preview/demo/assets/${hash}.mp3`);
  });

  it('rejects unsupported media imports before sending a request or rasterizing text', async () => {
    vi.stubEnv('VITE_STATIC_DEMO', '1');
    vi.resetModules();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const {uploadArtwork, canonicalizeDecalArtwork} = await import('./artwork');
    const {importFilmAudio} = await import('./filmAudio');
    await expect(uploadArtwork(new Blob(['artwork']), 'label.png')).rejects.toThrow('local server');
    await expect(canonicalizeDecalArtwork({text: 'New artwork'} as any)).rejects.toThrow('local server');
    await expect(importFilmAudio(new File(['audio'], 'music.mp3'))).rejects.toThrow('local server');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
