import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function runtime(demo: string, base: string) {
  vi.stubEnv('VITE_STATIC_DEMO', demo);
  vi.stubEnv('BASE_URL', base);
  vi.resetModules();
  return import('./runtime');
}

describe('static deployment URLs', () => {
  it('keeps local editor and capture asset routes unchanged', async () => {
    const { assetUrl, isStaticDemo } = await runtime('', '/');
    expect(isStaticDemo).toBe(false);
    expect(assetUrl('assets/product.glb')).toBe('/api/assets/product.glb');
    expect(assetUrl('assets/label.png')).toBe('/api/assets/label.png');
  });

  it('resolves all bundled data and images under the repository Pages path', async () => {
    const { assetUrl, demoDataUrl, isStaticDemo } = await runtime('1', '/3d-product-suite/');
    expect(isStaticDemo).toBe(true);
    expect(demoDataUrl()).toBe('/3d-product-suite/demo/bootstrap.json');
    expect(demoDataUrl('samples.json')).toBe('/3d-product-suite/demo/samples.json');
    expect(assetUrl('assets/product.glb')).toBe('/3d-product-suite/demo/assets/product.glb');
    expect(assetUrl('assets/label.png')).toBe('/3d-product-suite/demo/assets/label.png');
  });

  it('uses a root base for Vercel without a backend route', async () => {
    const { assetUrl, demoDataUrl } = await runtime('1', '/');
    expect(demoDataUrl()).toBe('/demo/bootstrap.json');
    expect(assetUrl('assets/label.jpg')).toBe('/demo/assets/label.jpg');
  });

  it('rejects absolute URLs and paths that could escape the demo bundle', async () => {
    const { assetUrl, demoDataUrl } = await runtime('1', '/3d-product-suite/');
    for (const path of ['', '/api/assets/x.glb', '../x.glb', 'assets/../x.glb', 'assets//x.glb',
      'https://example.com/x.glb', 'assets\\x.glb', 'assets/%2e%2e/x.glb', 'assets/x.glb?secret=1']) {
      expect(() => assetUrl(path)).toThrow('safe relative');
      expect(() => demoDataUrl(path)).toThrow('safe relative');
    }
  });
});
