import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { atomicWrite, openManifest, parseArgs, requestedFrames, sampleDigests, validatePng } from './capture_splats.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const camera = { positionM: [1, 2, 3], targetM: [0, 1, 0], focalLengthMm: 50 };
const sampled = { frames: [1, 2, 3].map((frame) => ({ frame, camera })) };

function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  }
  return (result ^ 0xffffffff) >>> 0;
}

function png(width = 2, height = 2) {
  function chunk(type, data) {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-capture-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function identity() {
  return {
    schemaVersion: 1, sourceDigest: 'a'.repeat(64), samplesDigest: 'b'.repeat(64), assetSha256: 'c'.repeat(64), assetFormat: 'ply',
    profile: { width: 2, height: 2, frameNumbers: [1, 2], renderer: 'spark', runtimeDigest: 'd'.repeat(64), colorSpace: 'srgb', toneMapping: 'none', contents: 'gaussian-world-only', depthOfField: 'sampled-camera' },
    limitations: ['Background color plates only; no near-field occlusion, reflections, or glass transmission.'],
  };
}

test('CLI rejects cross-origin assets and accepts only immutable local asset URLs', () => {
  const args = ['--url', 'http://127.0.0.1:8787', '--samples', 'samples.json', '--output', 'plate', '--asset-url', `/api/assets/${'a'.repeat(64)}.ply`, '--width', '270', '--height', '480'];
  const result = parseArgs(args);
  assert.equal(result.assetUrl, `http://127.0.0.1:8787/api/assets/${'a'.repeat(64)}.ply`);
  assert.equal(result.width, 270);
  const crossOrigin = [...args];
  crossOrigin[7] = 'https://example.com/a.ply';
  assert.throws(() => parseArgs(crossOrigin), /same-origin/);
  assert.throws(() => parseArgs([...args, '--width', '540']), /Duplicate/);
  const remote = [...args];
  remote[1] = 'https://example.com';
  assert.throws(() => parseArgs(remote), /loopback/);
});

test('requested frames stay tied to exact sampled cameras', () => {
  assert.deepEqual(requestedFrames(sampled), [1, 2, 3]);
  assert.deepEqual(requestedFrames(sampled, '3,1'), [1, 3]);
  assert.throws(() => requestedFrames(sampled, '4'), /present/);
  assert.throws(() => requestedFrames(sampled, '1,1'), /unique/);
  assert.throws(() => requestedFrames({ frames: [{ frame: 1, camera: { ...camera, focalLengthMm: NaN } }] }), /camera/);
});

test('source digest preserves Python float notation and escaped Unicode', async (t) => {
  const directory = await temporary(t);
  const samples = path.join(directory, 'samples.json');
  await fs.writeFile(samples, '{"scene":{"value":1.0,"text":"café"}}');
  const result = await sampleDigests(samples);
  assert.equal(result.sourceDigest, hash('{"text":"caf\\u00e9","value":1.0}'));
  assert.equal(result.samplesDigest, hash('{"scene":{"text":"caf\\u00e9","value":1.0}}'));
  assert.notEqual(result.sourceDigest, hash(JSON.stringify({ text: 'café', value: 1 })));
});

test('PNG validation checks decoded dimensions and catches corrupt CRCs', () => {
  const bytes = png();
  assert.equal(validatePng(bytes, 2, 2), true);
  assert.equal(validatePng(bytes, 3, 2), false);
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] ^= 1;
  assert.equal(validatePng(corrupt, 2, 2), false);
  assert.equal(validatePng(bytes.subarray(0, -1), 2, 2), false);
});

test('resume reuses only recorded matching PNGs and rejects different capture profiles', async (t) => {
  const directory = await temporary(t);
  const expected = identity();
  const first = await openManifest(directory, expected);
  assert.equal(first.verified.size, 0);
  const bytes = png();
  first.manifest.frames['1'] = hash(bytes);
  await atomicWrite(path.join(directory, '000001.png'), bytes);
  await atomicWrite(path.join(directory, 'capture-manifest.json'), JSON.stringify(first.manifest));
  assert.deepEqual([...(await openManifest(directory, expected)).verified], [1]);
  await assert.rejects(openManifest(directory, { ...expected, sourceDigest: 'e'.repeat(64) }), /differs/);
  await assert.rejects(openManifest(directory, { ...expected, profile: { ...expected.profile, width: 4 } }), /differs/);
  await fs.writeFile(path.join(directory, '000001.png'), png(3, 2));
  await assert.rejects(openManifest(directory, expected), /failed its recorded hash/);
});

test('resume rejects unrecorded images and detects a missing image as needing capture', async (t) => {
  const directory = await temporary(t);
  const expected = identity();
  const { manifest } = await openManifest(directory, expected);
  manifest.frames['1'] = hash(png());
  await atomicWrite(path.join(directory, 'capture-manifest.json'), JSON.stringify(manifest));
  assert.equal((await openManifest(directory, expected)).verified.size, 0);
  await atomicWrite(path.join(directory, '000002.png'), png());
  await assert.rejects(openManifest(directory, expected), /Unrecorded plate/);
});

test('a directory containing unknown frames cannot establish a new manifest', async (t) => {
  const directory = await temporary(t);
  await atomicWrite(path.join(directory, '000001.png'), png());
  await assert.rejects(openManifest(directory, identity()), /without a manifest/);
});


test('sampled optical focus validates the physical lens and accepts legacy sharp cameras', () => {
  const withOptics = optics => ({frames: [{frame: 1, camera: {...camera, depthOfField: optics}}]});
  assert.deepEqual(requestedFrames(withOptics({enabled: true, fStop: .7, focusDistanceM: .5})), [1]);
  assert.deepEqual(requestedFrames(withOptics({enabled: false, fStop: 32, focusDistanceM: .5})), [1]);
  assert.deepEqual(requestedFrames(sampled), [1, 2, 3]);
  for (const optics of [null, {}, {enabled: 1, fStop: 2.8, focusDistanceM: .5},
    {enabled: true, fStop: NaN, focusDistanceM: .5}, {enabled: true, fStop: .69, focusDistanceM: .5},
    {enabled: true, fStop: 33, focusDistanceM: .5}, {enabled: true, fStop: 2.8, focusDistanceM: .05},
    {enabled: true, fStop: 2.8, focusDistanceM: .03}, {enabled: false, fStop: 2.8, focusDistanceM: Infinity}]) {
    assert.throws(() => requestedFrames(withOptics(optics)), /optical focus/);
  }
});

test('resume refuses a sharp-only capture identity for the optical camera profile', async t => {
  const directory = await temporary(t), expected = identity();
  await openManifest(directory, expected);
  const sharp = structuredClone(expected); delete sharp.profile.depthOfField;
  await assert.rejects(openManifest(directory, sharp), /differs/);
});
