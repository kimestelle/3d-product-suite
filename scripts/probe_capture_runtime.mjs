#!/usr/bin/env node
/** Verify the production capture canvas, without importing or changing a scene. */
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openCaptureRuntime} from './capture_gpu.mjs';
import {captureAuthHeaders,projectBrowserCache} from './capture_splats.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let runtime;
try {
  const origin = new URL(process.argv[2]);
  if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Capture runtime probe requires a loopback HTTP(S) origin');
  }
  const cache = await projectBrowserCache();
  if (cache) process.env.PLAYWRIGHT_BROWSERS_PATH=cache;
  const {chromium} = createRequire(path.join(projectRoot, 'web', 'package.json'))('playwright');
  runtime = await openCaptureRuntime(chromium, {origin:origin.origin,device:process.argv[3]||'auto',width:32,height:32,timeout:60000}, captureAuthHeaders());
  if (runtime.browserErrors.length) throw new Error('Capture page reported errors: '+runtime.browserErrors.join('; '));
  process.stdout.write(JSON.stringify({contextVerified:true,execution:runtime.execution,
    limitations:'WebGL2 initialization only; run a saved Gaussian export to verify full source capture.'})+'\n');
} catch (error) {
  process.stderr.write(`Capture runtime proof failed: ${error.message}\n`);
  process.exitCode=1;
} finally {await runtime?.browser.close();}
