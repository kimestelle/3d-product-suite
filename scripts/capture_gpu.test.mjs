import assert from 'node:assert/strict';
import test from 'node:test';
import { captureDevicePolicy, launchModes, openCaptureRuntime, webglBackend } from './capture_gpu.mjs';

const gpu = { version: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)', unmaskedRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5, Unspecified Version)' };
const cpu = { ...gpu, unmaskedRenderer: 'ANGLE (Google, Vulkan SwiftShader Device (Subzero), SwiftShader driver)' };

test('capture policy only accepts explicit supported modes', () => {
  assert.equal(captureDevicePolicy('AUTO'), 'auto');
  assert.throws(() => captureDevicePolicy('cpu'), /must be/);
  assert.deepEqual(launchModes('auto', 'darwin').map(mode => mode.mode), ['hardware', 'software']);
  assert.ok(launchModes('hardware', 'darwin')[0].args.includes('--use-angle=metal'));
  assert.ok(!launchModes('hardware', 'linux')[0].args.some(arg => arg.includes('swiftshader')));
});

test('renderer detection distinguishes actual hardware from software and unknown contexts', () => {
  assert.equal(webglBackend(gpu), 'hardware');
  assert.equal(webglBackend(cpu), 'software');
  assert.equal(webglBackend({ ...gpu, unmaskedRenderer: 'llvmpipe (LLVM)' }), 'software');
  assert.equal(webglBackend({ ...gpu, unmaskedRenderer: '' }), 'unavailable');
  assert.equal(webglBackend({ ...gpu, version: 'WebGL 1.0' }), 'unavailable');
});

function fakeChromium(renderers) {
  const attempts = [];
  return { attempts, async launch(options) {
    const index = attempts.length, attempt = { options, closed: false }; attempts.push(attempt);
    const renderer = renderers[index];
    if (renderer instanceof Error) throw renderer;
    return { version: () => '140.0.7339.16', close: async () => { attempt.closed = true; }, newPage: async () => ({
      setDefaultTimeout() {}, route: async () => {}, on() {}, goto: async () => ({ok: () => true}), waitForFunction: async () => {},
      locator: () => ({ evaluate: async () => renderer }),
    }) };
  } };
}

test('auto validates hardware and closes rejected context before software fallback', async () => {
  const chromium = fakeChromium([cpu, cpu]);
  const runtime = await openCaptureRuntime(chromium, {device: 'auto',width: 2,height: 2,timeout: 1000,origin: 'http://127.0.0.1'}, {});
  assert.equal(chromium.attempts.length, 2);
  assert.equal(chromium.attempts[0].closed, true);
  assert.equal(runtime.execution.backend, 'software');
  assert.ok(runtime.execution.fallbackReason);
  await runtime.browser.close();
});

test('explicit hardware refuses software and cancellation prevents fallback launches', async () => {
  await assert.rejects(openCaptureRuntime(fakeChromium([cpu]), {device:'hardware',width:2,height:2,timeout:1000,origin:'http://127.0.0.1'}, {}), /Requested hardware/);
  const chromium = fakeChromium([gpu]);
  await assert.rejects(openCaptureRuntime(chromium, {device:'auto',isCancelled:()=>true}, {}), /cancelled/);
  assert.equal(chromium.attempts.length, 0);
});
