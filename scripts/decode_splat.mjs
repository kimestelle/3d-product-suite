#!/usr/bin/env node
/** Decode pinned Spark Gaussian assets for the bounded Cycles density adapter. */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { createGunzip } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
export const MAX_SPLATS = 2_000_000;
export const MAX_INPUT_BYTES = 128 * 1024 * 1024;
export const FIELDS = ['x', 'y', 'z', 'qw', 'qx', 'qy', 'qz', 'sx', 'sy', 'sz', 'opacity', 'r', 'g', 'b'];
export const STRIDE = FIELDS.length;
const SPARK_VERSION = '2.3.1';
const workers = new Set();
let sparkPromise;

/** Spark's embedded decoder uses only this small subset of the Worker API. */
class NodeDecoderWorker {
  constructor(url) {
    const prefix = 'data:text/javascript;charset=utf-8,';
    if (typeof url !== 'string' || !url.startsWith(prefix)) throw new Error('Spark decoder worker must use its embedded JavaScript data URL');
    const source = decodeURIComponent(url.slice(prefix.length));
    const bridge = `const {parentPort}=require('node:worker_threads');
globalThis.self=globalThis;
const listeners=new Map();
self.addEventListener=(kind,fn)=>{if(!listeners.has(kind))listeners.set(kind,new Set());listeners.get(kind).add(fn);};
self.removeEventListener=(kind,fn)=>listeners.get(kind)?.delete(fn);
self.postMessage=(value,options)=>parentPort.postMessage(value,Array.isArray(options)?options:options?.transfer);
parentPort.on('message',data=>{const event={data};for(const fn of [...(listeners.get('message')||[])])fn(event);self.onmessage?.(event);});
`;
    this.listeners = new Map();
    this.pending = new Set();
    this.worker = new ThreadWorker(bridge + source, { eval: true, execArgv: [], stdout: true, stderr: true });
    // Keep stdout machine-readable, including if a future decoder logs a warning.
    this.worker.stdout.pipe(process.stderr);
    this.worker.stderr.pipe(process.stderr);
    this.worker.on('message', (data) => {
      if (data?.id !== undefined && data.status === undefined) this.pending.delete(data.id);
      this.dispatch('message', { data });
      if (this.pending.size === 0) this.worker.unref();
    });
    this.worker.on('error', (error) => {
      this.dispatch('error', { error, message: error.message });
      for (const id of this.pending) this.dispatch('message', { data: { id, error: `Spark worker failed: ${error.message}` } });
      this.pending.clear();
    });
    this.worker.on('exit', (code) => {
      workers.delete(this);
      if (this.pending.size) {
        for (const id of this.pending) this.dispatch('message', { data: { id, error: `Spark worker exited before decoding completed (code ${code})` } });
        this.pending.clear();
      }
    });
    workers.add(this);
  }
  dispatch(kind, event) {
    this[`on${kind}`]?.(event);
    for (const listener of this.listeners.get(kind) ?? []) listener(event);
  }
  addEventListener(kind, listener) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind).add(listener);
  }
  removeEventListener(kind, listener) { this.listeners.get(kind)?.delete(listener); }
  postMessage(value, options) {
    this.worker.ref();
    if (value?.id !== undefined) this.pending.add(value.id);
    this.worker.postMessage(value, Array.isArray(options) ? options : options?.transfer);
  }
  terminate() { return this.worker.terminate(); }
}

export const usage = `Decode a local Gaussian PLY or SPZ with pinned Spark ${SPARK_VERSION}.

node scripts/decode_splat.mjs --input /absolute/world.spz --output /absolute/world.f32

Options:
  --max-splats ${MAX_SPLATS}  Declared and decoded Gaussian count limit (1..${MAX_SPLATS}).
  --help                    Show this help.

Output is little-endian float32, 14 values per Gaussian:
  ${FIELDS.join(', ')}
Positions retain the source asset coordinate frame. Quaternion order is wxyz;
scales are positive linear standard deviations, opacity and SH0 RGB are 0..1.
No source alignment, metric conversion, SH view-dependent color, or rendering is
performed. A JSON manifest is the only successful stdout output.
Setup: cd web && npm ci
`;

export function parseArgs(argv) {
  const values = {};
  const allowed = new Set(['input', 'output', 'max-splats']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help') return { help: true };
    if (!option.startsWith('--') || !allowed.has(option.slice(2))) throw new Error(`Unknown option: ${option}`);
    const key = option.slice(2);
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate option: ${option}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    values[key] = value;
  }
  for (const key of ['input', 'output']) if (!values[key]) throw new Error(`Missing required --${key}. Run with --help for usage.`);
  const maxSplats = values['max-splats'] === undefined ? MAX_SPLATS : Number(values['max-splats']);
  if (!Number.isInteger(maxSplats) || maxSplats < 1 || maxSplats > MAX_SPLATS) {
    throw new Error(`--max-splats must be an integer from 1 to ${MAX_SPLATS}`);
  }
  const input = path.resolve(values.input);
  const output = path.resolve(values.output);
  const sourceType = path.extname(input).slice(1).toLowerCase();
  if (!['ply', 'spz'].includes(sourceType)) throw new Error('Input must have a .ply or .spz extension');
  if (input === output) throw new Error('Input and output paths must differ');
  return { input, output, sourceType, maxSplats };
}

function boundedCount(count, maxSplats) {
  if (!Number.isInteger(count) || count < 1 || count > maxSplats) {
    throw new Error(`Gaussian count ${count} is outside the supported range 1..${maxSplats}`);
  }
  return count;
}

/** Check declared counts before Spark allocates arrays or starts decompression. */
export async function preflight(bytes, sourceType, maxSplats = MAX_SPLATS) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) {
    throw new Error(`Gaussian input must contain 1..${MAX_INPUT_BYTES} bytes (128 MiB maximum)`);
  }
  if (sourceType === 'ply') {
    const prefix = bytes.subarray(0, 65536).toString('ascii');
    const end = /(?:^|\n)end_header\r?\n/.exec(prefix);
    if (!prefix.startsWith('ply\n') && !prefix.startsWith('ply\r\n')) throw new Error('PLY magic is missing');
    if (!end) throw new Error('PLY header must end within 64 KiB');
    const header = prefix.slice(0, end.index + end[0].length);
    const matches = [...header.matchAll(/^element vertex (\d+)\r?$/gm)];
    if (matches.length !== 1) throw new Error('PLY must declare exactly one vertex element');
    if (!/^format (ascii|binary_little_endian) 1\.0\r?$/m.test(header)) {
      throw new Error('Unsupported PLY codec; use ASCII or binary_little_endian PLY 1.0');
    }
    for (const field of ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']) {
      if (!new RegExp(`^property (?:float|float32|double|float64) ${field}\\r?$`, 'm').test(header)) {
        throw new Error(`PLY is missing Gaussian property ${field}; point clouds and compressed PLY layouts are unsupported`);
      }
    }
    return { count: boundedCount(Number(matches[0][1]), maxSplats) };
  }
  if (sourceType !== 'spz') throw new Error(`Unsupported Gaussian source type: ${sourceType}`);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Unsupported SPZ codec; expected a gzip-compressed SPZ asset');
  const compressed = Readable.from([bytes]);
  const unpacked = createGunzip();
  compressed.pipe(unpacked);
  let header = Buffer.alloc(0);
  let decodedHeader;
  let expandedBytes = 0;
  let expectedBytes;
  try {
    for await (const chunk of unpacked) {
      expandedBytes += chunk.length;
      if (header.length < 16) header = Buffer.concat([header, chunk.subarray(0, 16 - header.length)]);
      if (header.length === 16 && !decodedHeader) {
        if (header.readUInt32LE(0) !== 0x5053474e) throw new Error('SPZ NGSP header is missing');
        const version = header.readUInt32LE(4);
        if (![1, 2, 3].includes(version)) throw new Error(`Unsupported SPZ version ${version}; this adapter accepts versions 1, 2, and 3`);
        const count = boundedCount(header.readUInt32LE(8), maxSplats);
        const shDegree = header[12];
        if (shDegree > 3 || header[13] > 24) throw new Error('Unsupported SPZ spherical harmonic degree or position precision');
        const shCoefficients = ((shDegree + 1) ** 2 - 1) * 3;
        const recordBytes = (version === 1 ? 6 : 9) + 1 + 3 + 3 + (version === 3 ? 4 : 3) + shCoefficients;
        expectedBytes = 16 + count * recordBytes;
        decodedHeader = { count, version, shDegree };
      }
      if (expectedBytes !== undefined && expandedBytes > expectedBytes) throw new Error('SPZ expanded data exceeds its bounded declared layout');
    }
  } catch (error) {
    throw new Error(`SPZ preflight failed: ${error.message}`);
  } finally {
    compressed.destroy();
    unpacked.destroy();
  }
  if (!decodedHeader || expandedBytes !== expectedBytes) throw new Error('SPZ data is truncated or does not match its declared Gaussian layout');
  return decodedHeader;
}

async function loadSpark() {
  if (sparkPromise) return sparkPromise;
  const require = createRequire(path.join(projectRoot, 'web', 'package.json'));
  let entry;
  try { entry = require.resolve('@sparkjsdev/spark'); }
  catch { throw new Error('Spark is missing. Run: cd web && npm ci'); }
  let directory = path.dirname(entry);
  let metadata;
  while (directory !== path.dirname(directory)) {
    try {
      const candidate = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (candidate.name === '@sparkjsdev/spark') { metadata = candidate; break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
  if (metadata?.version !== SPARK_VERSION) throw new Error(`Spark ${SPARK_VERSION} is required; found ${metadata?.version ?? 'unknown'}`);
  if (typeof globalThis.Worker === 'undefined') globalThis.Worker = NodeDecoderWorker;
  // require.resolve selects the CJS entry, whose .js extension is incompatible
  // with this package's type:module in Node. Select its declared ESM entry.
  sparkPromise = import(pathToFileURL(path.resolve(directory, metadata.module)).href);
  return sparkPromise;
}

export function splatRow(splat, index) {
  const { center, scales, quaternion, opacity, color } = splat;
  const row = [center.x, center.y, center.z, quaternion.w, quaternion.x, quaternion.y, quaternion.z,
    scales.x, scales.y, scales.z, opacity, color.r, color.g, color.b];
  if (!row.every(Number.isFinite)) throw new Error(`Gaussian ${index} contains a non-finite decoded value`);
  if (row.slice(7, 10).some((scale) => scale <= 0)) throw new Error(`Gaussian ${index} has a nonpositive decoded scale; it cannot form a covariance`);
  if (row.slice(10).some((value) => value < 0 || value > 1)) throw new Error(`Gaussian ${index} has opacity or SH0 color outside 0..1`);
  const norm = Math.hypot(...row.slice(3, 7));
  if (norm < 1e-8) throw new Error(`Gaussian ${index} has an invalid zero quaternion`);
  for (let component = 3; component < 7; component += 1) row[component] /= norm;
  return row;
}

/** Decode actual Spark PackedSplats; no browser, canvas, WebGL, or network. */
export async function decodeFile(options) {
  const maxSplats = options.maxSplats ?? MAX_SPLATS;
  boundedCount(maxSplats, MAX_SPLATS);
  if (path.resolve(options.input) === path.resolve(options.output)) throw new Error('Input and output paths must differ');
  const sourceType = options.sourceType ?? path.extname(options.input).slice(1).toLowerCase();
  const handle = await fs.open(options.input, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INPUT_BYTES) throw new Error('Gaussian input must be a regular nonempty file no larger than 128 MiB');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  const declared = await preflight(bytes, sourceType, maxSplats);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const { PackedSplats, SplatFileType } = await loadSpark();
  const packed = new PackedSplats({ fileBytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    fileType: sourceType === 'spz' ? SplatFileType.SPZ : SplatFileType.PLY, fileName: path.basename(options.input),
    maxSplats, lod: false, nonLod: true });
  const output = path.resolve(options.output);
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  let outputHandle;
  let timer;
  try {
    await Promise.race([packed.initialized, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Spark Gaussian decoding exceeded 120 seconds')), 120000);
    })]);
    clearTimeout(timer);
    const count = boundedCount(packed.numSplats, maxSplats);
    if (count !== declared.count) throw new Error(`Decoded Gaussian count ${count} differs from declared count ${declared.count}`);
    outputHandle = await fs.open(temporary, 'wx');
    const chunkRows = 4096;
    const chunk = Buffer.alloc(chunkRows * STRIDE * 4);
    const digest = createHash('sha256');
    for (let base = 0; base < count; base += chunkRows) {
      const length = Math.min(chunkRows, count - base);
      for (let local = 0; local < length; local += 1) {
        const row = splatRow(packed.getSplat(base + local), base + local);
        for (let field = 0; field < STRIDE; field += 1) chunk.writeFloatLE(row[field], (local * STRIDE + field) * 4);
      }
      const block = chunk.subarray(0, length * STRIDE * 4);
      digest.update(block);
      await outputHandle.writeFile(block);
    }
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = undefined;
    await fs.rename(temporary, output);
    return { format: 'gaussian-f32-v1', count, stride: STRIDE, fields: [...FIELDS], output, sourceType,
      byteOrder: 'little-endian', byteLength: count * STRIDE * 4, sourceSha256, sha256: digest.digest('hex'),
      decoder: `@sparkjsdev/spark@${SPARK_VERSION}:PackedSplats`, coordinateFrame: 'source-native',
      quaternionOrder: 'wxyz', scaleEncoding: 'linear-standard-deviation', colorEncoding: 'clamped-SH0-RGB',
      packedEncoding: { ...packed.splatEncoding }, limitations: ['Spark packed splat quantization; degree-zero color only; no source alignment applied.'] };
  } catch (error) {
    throw new Error(`Cannot decode ${sourceType.toUpperCase()} Gaussian asset: ${error.message ?? error}`);
  } finally {
    clearTimeout(timer);
    packed.dispose();
    await outputHandle?.close();
    await fs.rm(temporary, { force: true });
  }
}

export async function closeDecoderWorkers() {
  await Promise.all([...workers].map((worker) => worker.terminate()));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage);
    else process.stdout.write(`${JSON.stringify(await decodeFile(options))}\n`);
  } catch (error) {
    process.stderr.write(`Gaussian decode failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally { await closeDecoderWorkers(); }
}
