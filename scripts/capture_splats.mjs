#!/usr/bin/env node
/** Capture real Spark-rendered Gaussian worlds from the shared sampled cameras. */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestName = 'capture-manifest.json';
const shaPattern = /^[a-f0-9]{64}$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const execFileAsync = promisify(execFile);

export const usage = `Capture Gaussian world plates with the exact sampled camera poses.

node scripts/capture_splats.mjs --url http://127.0.0.1:8787 \\
  --samples /absolute/samples.json --output /absolute/plate \\
  --asset-url /api/assets/<sha256>.ply --width 270 --height 480 [--frames 1,2]

Options:
  --source-digest SHA256   Cross-check the Python scene digest (optional).
  --timeout-ms 120000      Maximum load or per-frame render time.
  --help                  Show this help.

Setup: cd web && npm ci && npx playwright install chromium
No provider API or API key is used. Plates contain only the Gaussian world;
depth, near-field occlusion, reflections, and glass transmission are not solved.
Resume uses the same command and verifies the manifest and every saved PNG.
Use a new output directory if the source, profile, browser build, or hashes differ.
`;

export function parseArgs(argv) {
  const allowed = new Set(['url', 'samples', 'output', 'asset-url', 'width', 'height', 'frames', 'source-digest', 'timeout-ms']);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') return { help: true };
    if (!option.startsWith('--') || !allowed.has(option.slice(2))) throw new Error(`Unknown option: ${option}`);
    const key = option.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${option}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    options[key] = value;
  }
  for (const key of ['url', 'samples', 'output', 'asset-url', 'width', 'height']) {
    if (!options[key]) throw new Error(`Missing required --${key}. Run with --help for usage.`);
  }
  for (const key of ['width', 'height']) {
    if (!/^\d+$/.test(options[key]) || Number(options[key]) < 2 || Number(options[key]) > 16384) {
      throw new Error(`--${key} must be an integer from 2 to 16384`);
    }
    options[key] = Number(options[key]);
  }
  options.timeout = options['timeout-ms'] === undefined ? 120000 : Number(options['timeout-ms']);
  if (!Number.isInteger(options.timeout) || options.timeout < 1000 || options.timeout > 600000) {
    throw new Error('--timeout-ms must be an integer from 1000 to 600000');
  }
  if (options['source-digest'] && !shaPattern.test(options['source-digest'])) throw new Error('--source-digest must be a lowercase SHA256');
  const base = new URL(options.url);
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('--url must be a loopback HTTP(S) origin, for example http://127.0.0.1:8787');
  }
  const asset = new URL(options['asset-url'], base);
  if (asset.origin !== base.origin || asset.username || asset.password || asset.search || asset.hash
      || !/^\/api\/assets\/[a-f0-9]{64}\.(ply|spz)$/.test(asset.pathname)) {
    throw new Error('--asset-url must be a same-origin immutable /api/assets/<sha256>.ply or .spz URL');
  }
  return { ...options, origin: base.origin, assetUrl: asset.href, samples: path.resolve(options.samples), output: path.resolve(options.output) };
}

export async function fileSha256(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

/** Keep the existing Python JSON canonicalization, including 1.0 and Unicode. */
export async function sampleDigests(samplesPath, python = process.env.PYTHON || 'python3') {
  const code = 'import hashlib,json,sys\ns=json.load(open(sys.argv[1],encoding="utf-8"))\ndef digest(v): return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()\nprint(json.dumps({"sourceDigest":digest(s["scene"]),"samplesDigest":digest(s)}))';
  try {
    const result = await execFileAsync(python, ['-c', code, samplesPath], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Cannot compute the canonical scene digest with Python: ${error.stderr?.trim() || error.message}`);
  }
}

async function optionalTreeHash(root, digest, prefix = '') {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = `${prefix}${entry.name}`;
    const filename = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Capture runtime must not contain symlinks: ${filename}`);
    if (entry.isDirectory()) await optionalTreeHash(filename, digest, `${name}/`);
    else if (entry.isFile()) digest.update(`${name}\0${await fileSha256(filename)}\n`);
  }
}

async function runtimeFingerprint() {
  const digest = createHash('sha256').update(`helper\0${await fileSha256(scriptPath)}\n`);
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(projectRoot, 'web', name);
    try { digest.update(`web/${name}\0${await fileSha256(file)}\n`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const name of ['src', 'dist']) await optionalTreeHash(path.join(projectRoot, 'web', name), digest, `web/${name}/`);
  return digest.digest('hex');
}

export function requestedFrames(sampled, input) {
  if (!Array.isArray(sampled.frames) || sampled.frames.length === 0 || sampled.frames.length > 100000) {
    throw new Error('Samples must contain a nonempty frames array (maximum 100000 frames)');
  }
  const available = new Set();
  for (const item of sampled.frames) {
    if (!Number.isInteger(item.frame) || item.frame < 1 || item.frame > 999999 || available.has(item.frame)) {
      throw new Error('Sampled frame numbers must be unique positive integers up to 999999');
    }
    available.add(item.frame);
    if (!item.camera || !['positionM', 'targetM'].every((key) => Array.isArray(item.camera[key])
      && item.camera[key].length === 3 && item.camera[key].every(Number.isFinite))
      || !Number.isFinite(item.camera.focalLengthMm) || item.camera.focalLengthMm < 1) {
      throw new Error(`Frame ${item.frame} has no valid sampled camera`);
    }
  }
  if (input === undefined) return [...available].sort((a, b) => a - b);
  if (!/^\d+(,\d+)*$/.test(input)) throw new Error('--frames must be comma-separated frame numbers');
  const frames = input.split(',').map(Number);
  if (new Set(frames).size !== frames.length || frames.some((frame) => !available.has(frame))) {
    throw new Error('--frames must select unique frame numbers present in the sample file');
  }
  return frames.sort((a, b) => a - b);
}

export async function prepareCapture(options) {
  const sampled = JSON.parse(await fs.readFile(options.samples, 'utf8'));
  const asset = sampled.scene?.environment?.asset;
  if (sampled.scene?.environment?.kind !== 'splat' || !asset || !shaPattern.test(asset.sha256)
      || !['ply', 'spz'].includes(asset.format)) throw new Error('Capture requires a splat scene with an immutable PLY or SPZ asset');
  const expectedPath = `assets/${asset.sha256}.${asset.format}`;
  if (asset.path !== expectedPath || new URL(options.assetUrl).pathname !== `/api/${expectedPath}`) {
    throw new Error('Scene asset path and --asset-url must agree with the immutable asset SHA256 and format');
  }
  const localAsset = path.resolve(path.dirname(options.samples), asset.path);
  const realAsset = await fs.realpath(localAsset);
  const realRoot = await fs.realpath(path.dirname(options.samples));
  if (!realAsset.startsWith(`${realRoot}${path.sep}`)) throw new Error('Scene asset must stay inside the samples directory');
  if (await fileSha256(realAsset) !== asset.sha256) throw new Error('Bundled Gaussian asset SHA256 does not match the scene');
  const digests = await sampleDigests(options.samples);
  if (options['source-digest'] && options['source-digest'] !== digests.sourceDigest) {
    throw new Error('--source-digest does not match the canonical sampled source scene');
  }
  const frames = requestedFrames(sampled, options.frames);
  const identity = {
    schemaVersion: 1,
    ...digests,
    assetSha256: asset.sha256,
    assetFormat: asset.format,
    profile: {
      width: options.width, height: options.height, frameNumbers: frames,
      renderer: 'spark', runtimeDigest: await runtimeFingerprint(),
      colorSpace: 'srgb', toneMapping: 'none', contents: 'gaussian-world-only',
    },
    limitations: ['Background color plates only; no near-field occlusion, reflections, or glass transmission.'],
  };
  return { sampled, frames, identity };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Validate the decoded browser PNG, its dimensions, chunks, CRCs and row data. */
export function validatePng(bytes, width, height) {
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 8).equals(pngSignature)) return false;
    let offset = 8, header, ended = false, closed = false;
    const compressed = [];
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
      if (end > bytes.length) return false;
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, end - 4);
      if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
      if (!header && kind !== 'IHDR') return false;
      if (kind === 'IHDR') {
        if (header || size !== 13) return false;
        header = data;
      } else if (kind === 'IDAT') {
        if (closed) return false;
        compressed.push(data);
      } else if (kind === 'IEND') {
        if (size !== 0 || end !== bytes.length) return false;
        ended = true;
        break;
      } else if (kind !== 'PLTE' && !(bytes[offset + 4] & 32)) return false;
      if (compressed.length && kind !== 'IDAT') closed = true;
      offset = end;
    }
    if (!header || !ended || compressed.length === 0 || header.readUInt32BE(0) !== width
        || header.readUInt32BE(4) !== height || header[8] !== 8 || ![2, 6].includes(header[9])
        || header[10] || header[11] || header[12]) return false;
    const stride = width * (header[9] === 6 ? 4 : 3) + 1;
    const expected = stride * height;
    if (expected > 256 * 1024 * 1024) return false;
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected + 1 });
    return raw.length === expected && Array.from({ length: height }, (_, row) => raw[row * stride]).every((filter) => filter <= 4);
  } catch { return false; }
}

export async function atomicWrite(filename, bytes) {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;
const frameFile = (number) => `${String(number).padStart(6, '0')}.png`;
const freshDirectory = 'Use a new --output directory, or remove this directory after reviewing the mismatched capture.';

export async function openManifest(output, identity) {
  await fs.mkdir(output, { recursive: true });
  const filename = path.join(output, manifestName);
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read capture manifest: ${error.message}. ${freshDirectory}`);
    const existing = (await fs.readdir(output)).filter((name) => !name.endsWith('.tmp'));
    if (existing.length) throw new Error(`Capture directory has files without a manifest. ${freshDirectory}`);
    manifest = { ...identity, createdAt: new Date().toISOString(), frames: {} };
    await atomicWrite(filename, serialize(manifest));
  }
  const actualIdentity = Object.fromEntries(Object.keys(identity).map((key) => [key, manifest[key]]));
  if (JSON.stringify(actualIdentity) !== JSON.stringify(identity) || typeof manifest.frames !== 'object'
      || manifest.frames === null || Array.isArray(manifest.frames)) {
    throw new Error(`Capture source or profile differs from its manifest. ${freshDirectory}`);
  }
  const allowed = new Set(identity.profile.frameNumbers.map(String));
  for (const [number, digest] of Object.entries(manifest.frames)) {
    if (!allowed.has(number) || !shaPattern.test(digest)) throw new Error(`Invalid capture frame record ${number}. ${freshDirectory}`);
  }
  const verified = new Set();
  for (const name of await fs.readdir(output)) {
    if (!name.endsWith('.png')) continue;
    const number = /^\d{6}\.png$/.test(name) ? String(Number(name.slice(0, 6))) : '';
    if (!allowed.has(number) || !manifest.frames[number]) throw new Error(`Unrecorded plate ${name}. ${freshDirectory}`);
    const bytes = await fs.readFile(path.join(output, name));
    if (sha256(bytes) !== manifest.frames[number] || !validatePng(bytes, identity.profile.width, identity.profile.height)) {
      throw new Error(`Plate ${name} failed its recorded hash or PNG validation. ${freshDirectory}`);
    }
    verified.add(Number(number));
  }
  return { manifest, verified };
}

async function verifyServedAsset(url, expected, timeout) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (!response.ok) throw new Error(`Asset server returned HTTP ${response.status} for the Gaussian world`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 512 * 1024 * 1024) throw new Error('Served Gaussian asset exceeds 512 MiB');
    hash.update(chunk);
  }
  if (hash.digest('hex') !== expected) throw new Error('Served Gaussian asset SHA256 differs from the pinned scene asset');
}

async function withTimeout(promise, milliseconds, operation) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out after ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export async function capture(options) {
  const { sampled, frames, identity } = await prepareCapture(options);
  const { manifest, verified } = await openManifest(options.output, identity);
  const missing = frames.filter((number) => !verified.has(number));
  if (!missing.length) {
    process.stdout.write(`Verified ${verified.size} existing Gaussian plates; capture complete.\n`);
    return manifest;
  }
  await verifyServedAsset(options.assetUrl, identity.assetSha256, options.timeout);
  let chromium;
  try { ({ chromium } = createRequire(path.join(projectRoot, 'web', 'package.json'))('playwright')); }
  catch { throw new Error('Playwright is missing. Run: cd web && npm ci && npx playwright install chromium'); }
  let browser;
  let interrupted;
  const onInterrupt = (signal) => {
    interrupted = signal;
    // Closing Chromium interrupts pending frame/sort promises and prevents an
    // orphan browser from continuing to render after the Python job cancels.
    void browser?.close().catch(() => {});
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    try {
      browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
    } catch (error) {
      throw new Error(`Chromium could not start: ${error.message}\nInstall the pinned browser: cd web && npx playwright install chromium`);
    }
    if (interrupted) throw new Error(`Capture cancelled by ${interrupted}`);
    const page = await browser.newPage({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    page.setDefaultTimeout(options.timeout);
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === options.origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient');
    });
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    const response = await page.goto(`${options.origin}/capture`, { waitUntil: 'domcontentloaded', timeout: options.timeout });
    if (!response?.ok()) throw new Error(`Capture route returned HTTP ${response?.status() ?? 'unknown'}. Build web/dist and start python -m film serve.`);
    await page.waitForFunction(() => typeof window.productSuiteCapture?.load === 'function' && typeof window.productSuiteCapture?.frame === 'function');
    await withTimeout(page.evaluate((payload) => window.productSuiteCapture.load(payload), {
      scene: sampled.scene, frames: sampled.frames, width: options.width, height: options.height, assetUrl: options.assetUrl,
    }), options.timeout, 'Gaussian world load');
    const canvas = page.locator('canvas#splat-capture');
    await canvas.waitFor({ state: 'visible' });
    for (const number of missing) {
      // frame() resolves only after Spark loading, camera sorting, and the draw.
      await withTimeout(page.evaluate((frame) => window.productSuiteCapture.frame(frame), number), options.timeout, `Gaussian frame ${number}`);
      if (browserErrors.length) throw new Error(`Capture browser error: ${browserErrors.join('; ')}`);
      const dimensions = await canvas.evaluate((element) => ({ width: element.width, height: element.height, cssWidth: element.getBoundingClientRect().width, cssHeight: element.getBoundingClientRect().height }));
      if (dimensions.width !== options.width || dimensions.height !== options.height || dimensions.cssWidth !== options.width || dimensions.cssHeight !== options.height) {
        throw new Error(`Capture canvas dimensions differ from the requested ${options.width}x${options.height}: ${JSON.stringify(dimensions)}`);
      }
      const bytes = await canvas.screenshot({ type: 'png', animations: 'disabled', timeout: options.timeout });
      if (!validatePng(bytes, options.width, options.height)) throw new Error(`Browser returned an invalid ${options.width}x${options.height} PNG for frame ${number}`);
      await atomicWrite(path.join(options.output, frameFile(number)), bytes);
      manifest.frames[String(number)] = sha256(bytes);
      manifest.updatedAt = new Date().toISOString();
      await atomicWrite(path.join(options.output, manifestName), serialize(manifest));
      if (interrupted) throw new Error(`Capture cancelled by ${interrupted}`);
      process.stdout.write(`Captured Gaussian plate ${frameFile(number)} (${Object.keys(manifest.frames).length}/${frames.length}).\n`);
    }
    return manifest;
  } finally {
    try { await browser?.close(); }
    finally {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else await capture(options);
  } catch (error) {
    process.stderr.write(`Gaussian capture failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
