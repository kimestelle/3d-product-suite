/** Production Gaussian capture backend selection. Never lower the image profile. */
import os from 'node:os';
export function captureDevicePolicy(value = process.env.GESSO_CAPTURE_DEVICE || 'auto') {
  const policy = String(value).toLowerCase();
  if (!['auto', 'hardware', 'software'].includes(policy)) throw new Error('Capture device must be auto, hardware or software');
  return policy;
}

export function launchModes(policy, platform = process.platform) {
  policy = captureDevicePolicy(policy);
  const common = ['--disable-dev-shm-usage'];
  // Linux headless hosts have no X server. Request ANGLE's offscreen Vulkan
  // path; the actual capture canvas below must still prove hardware WebGL2.
  const hardwareArgs = platform === 'darwin' ? ['--use-angle=metal'] : platform === 'linux'
    ? ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] : [];
  const hardware = { mode: 'hardware', args: [...common, ...hardwareArgs] };
  const software = { mode: 'software', args: [...common, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
  return policy === 'auto' ? [hardware, software] : [policy === 'hardware' ? hardware : software];
}

export function webglBackend(info) {
  if (!info || !info.unmaskedRenderer || !info.version?.startsWith('WebGL 2')) return 'unavailable';
  return /swiftshader|llvmpipe|softpipe|software|microsoft basic|lavapipe/i.test(info.unmaskedRenderer) ? 'software' : 'hardware';
}

/** Load the real capture surface and inspect the context it will actually use.
 * Fallback happens before a manifest/frame is pinned, never midway through it. */
export async function openCaptureRuntime(chromium, options, authHeaders, onBrowser = () => {}) {
  const policy = captureDevicePolicy(options.device);
  const modes = launchModes(policy);
  const failures = [];
  for (const candidate of modes) {
    if (options.isCancelled?.()) throw new Error('Gaussian capture cancelled before renderer initialization');
    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: candidate.args });
      onBrowser(browser);
      const page = await browser.newPage({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      page.setDefaultTimeout(options.timeout);
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === options.origin) return route.continue({ headers: { ...route.request().headers(), ...authHeaders } });
        return ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient');
      });
      const browserErrors = [];
      page.on('pageerror', error => browserErrors.push(error.message));
      const response = await page.goto(`${options.origin}/capture`, { waitUntil: 'domcontentloaded', timeout: options.timeout });
      if (!response?.ok()) throw new Error(`Capture route returned HTTP ${response?.status() ?? 'unknown'}`);
      await page.waitForFunction(() => typeof window.productSuiteCapture?.load === 'function' && typeof window.productSuiteCapture?.frame === 'function', undefined, { timeout: Math.min(options.timeout, 30000) });
      const info = await page.locator('canvas#splat-capture').evaluate(canvas => {
        const gl = canvas.getContext('webgl2');
        if (!gl || gl.isContextLost()) return null;
        const extension = gl.getExtension('WEBGL_debug_renderer_info');
        return { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
          unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : '',
          unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : '' };
      });
      const backend = webglBackend(info);
      if (backend !== candidate.mode) throw new Error(`Requested ${candidate.mode} WebGL2 but found ${backend}: ${info?.unmaskedRenderer || 'no identifiable renderer'}`);
      const execution = { policy, backend, ...info, browserVersion: browser.version(), platform: process.platform,
        osRelease: os.release(), osVersion: os.version(), architecture: process.arch, launchMode: candidate.mode,
        ...(failures.length ? { fallbackReason: 'Hardware WebGL2 unavailable; using verified software renderer' } : {}) };
      return { browser, page, browserErrors, execution };
    } catch (error) {
      failures.push(`${candidate.mode}: ${error.message}`);
      await browser?.close().catch(() => {});
      onBrowser(undefined);
      if (options.isCancelled?.()) throw new Error('Gaussian capture cancelled during renderer initialization');
      if (candidate === modes.at(-1)) throw new Error(`Cannot initialize Gaussian capture renderer: ${failures.join('; ')}. Install the pinned Chromium runtime and check GPU availability.`);
      process.stderr.write(`Hardware Gaussian capture unavailable; trying software: ${error.message}\n`);
    }
  }
}
