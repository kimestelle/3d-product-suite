/** Export-only SPZ subsets. Originals and source scene identities never change.
 *
 * The pinned Spark 2.3.1 vertex shader rejects centers beyond clipXY=1.4
 * BEFORE covariance expansion and optical blur. We retain a larger 1.5 cone,
 * plus packing/transform error bounds, for every requested output camera.
 * This deliberately does not crop by center against the visible image edge.
 * A copy is usable only after EVERY requested frame matches full-source pixels.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';

const filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(filename), '..');
const THREE = createRequire(path.join(root, 'web/package.json'))('three');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
export const WORLD_COPY_POLICY = 'spark-2.3.1-center-clip-1.5-spz2-byte-subset-all-frame-exact-v1';
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const MiB=1024*1024,SPACE_CUSHION=32*MiB;
const spaceError=error=>['ENOSPC','EDQUOT'].includes(error.code);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const finiteVector = (value, count) => Array.isArray(value) && value.length === count && value.every(Number.isFinite);

export function worldCopyCacheBudget(value=process.env.GESSO_GAUSSIAN_CACHE_MAX_MIB??'256') {
  const mib=Number(value);
  if(!Number.isInteger(mib)||mib<0||mib>4096)throw new Error('GESSO_GAUSSIAN_CACHE_MAX_MIB must be an integer from 0 to 4096.');
  return mib*MiB;
}

export function cacheAdmissionReason({usedBytes,incomingBytes,availableBytes,budgetBytes,evidenceBytes=0}) {
  if(usedBytes+incomingBytes>budgetBytes)return 'Camera-copy cache budget is full; the full source is retained without deleting any assets.';
  if(availableBytes<incomingBytes+evidenceBytes+SPACE_CUSHION)return 'Insufficient free disk for camera-copy cache admission; the full source is retained.';
  return null;
}

export function gateStagingReason({width,height,frameCount,availableBytes}) {
  // RGBA8 scanlines + deflate overhead + PNG chunks. One extra frame allows
  // atomic final publication before releasing its staged reference.
  const maxPng=Math.ceil((width*height*4+height)*1.01)+64*1024;
  if(!Number.isSafeInteger(maxPng*(frameCount+1))||availableBytes<maxPng*(frameCount+1)+SPACE_CUSHION)
    return 'Insufficient free disk for the all-frame camera-copy quality gate; rendering the unchanged full source without staging.';
  return null;
}

export async function availableDiskBytes(directory) {
  while(true) {
    try{const stat=await fs.statfs(directory);return Number(stat.bavail)*Number(stat.bsize);}
    catch(error){const parent=path.dirname(directory);if(error.code!=='ENOENT'||parent===directory)throw error;directory=parent;}
  }
}

async function cacheUsedBytes(directory) {
  let total=0,entries=[];try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const entry of entries) {
    if(!entry.isDirectory()||!digestPattern.test(entry.name))continue;
    const dir=path.join(directory,entry.name),files=await fs.readdir(dir,{withFileTypes:true});let quality=false,reservation;
    for(const file of files)if(file.isFile()) {
      total+=(await fs.stat(path.join(dir,file.name))).size;
      if(file.name==='quality.json')quality=true;
      if(file.name==='budget.json')reservation=JSON.parse(await fs.readFile(path.join(dir,file.name),'utf8')).reservedQualityBytes;
    }
    if(!quality&&Number.isInteger(reservation)&&reservation>=0&&reservation<=32*MiB)total+=reservation;
  }
  return total;
}

async function cacheAdmissionLock(directory,retry=true) {
  const lockPath=path.join(directory,'admission.lock');
  try {
    const handle=await fs.open(lockPath,'wx');
    try{await handle.writeFile(JSON.stringify({pid:process.pid}));return handle;}
    catch(error){await handle.close();await fs.rm(lockPath,{force:true});throw error;}
  }catch(error){
    if(error.code!=='EEXIST')throw error;
    if(retry) {
      let stale=false;
      try {
        const record=JSON.parse(await fs.readFile(lockPath,'utf8'));
        if(Number.isInteger(record.pid)&&record.pid>0)try{process.kill(record.pid,0);}catch(error){if(error.code==='ESRCH')stale=true;}
      }catch(error){if((await fs.stat(lockPath).catch(()=>({mtimeMs:Date.now()}))).mtimeMs<Date.now()-60000)stale=true;}
      if(stale){await fs.rm(lockPath,{force:true});return cacheAdmissionLock(directory,false);}
    }
    return null;
  }
}

async function atomicWrite(destination, bytes) {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, {force: true}); }
}

export function parseSpz(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) throw new Error('SPZ source exceeds the bounded input size.');
  const raw = gunzipSync(bytes, {maxOutputLength: MAX_DECODED_BYTES});
  if (raw.length < 16 || raw.readUInt32LE(0) !== 0x5053474e) throw new Error('SPZ header is invalid.');
  const version = raw.readUInt32LE(4), count = raw.readUInt32LE(8), degree = raw[12], bits = raw[13];
  // Unknown flags may alter decoding. Keep the full source for those formats.
  if (version !== 2 || degree !== 0 || bits > 24 || raw[14] !== 0 || raw[15] !== 0
      || count < 1 || count > 2_000_000 || raw.length !== 16 + count * 19) throw new Error('Camera copies currently require exact SPZ v2 / SH0 / flags0 sources.');
  let offset = 16;
  const blocks = [9, 1, 3, 3, 3].map(stride => {
    const block = {offset, stride}; offset += stride * count; return block;
  });
  return {raw, count, bits, blocks};
}

/** Copy each selected attribute record verbatim, in original relative order. */
export function subsetSpz(parsed, selected) {
  if (!selected.length || selected.length >= parsed.count) throw new Error('SPZ subset must retain a nonempty proper subset.');
  const raw = Buffer.alloc(16 + selected.length * 19);
  parsed.raw.copy(raw, 0, 0, 16); raw.writeUInt32LE(selected.length, 8);
  let offset = 16;
  for (const block of parsed.blocks) {
    for (let index = 0; index < selected.length; index += 1) {
      const source = selected[index];
      if (!Number.isInteger(source) || source < 0 || source >= parsed.count || (index && source <= selected[index - 1])) throw new Error('SPZ subset indices must increase in source order.');
      const start = block.offset + source * block.stride;
      parsed.raw.copy(raw, offset + index * block.stride, start, start + block.stride);
    }
    offset += selected.length * block.stride;
  }
  return gzipSync(raw, {level: 6, mtime: 0});
}

function framePlanes(asset, frame, width, height, coveringBounds) {
  const pose = frame.camera;
  if (!finiteVector(pose?.positionM, 3) || !finiteVector(pose.targetM, 3) || !(pose.focalLengthMm >= 1)
      || !Number.isFinite(pose.focalLengthMm) || pose.positionM.every((v, i) => v === pose.targetM[i])) throw new Error('Camera copy requires finite sampled perspective cameras.');
  const scale = asset.scaleToMeters ?? 1, translation = asset.translationM ?? [0, 0, 0], rotation = asset.rotationXyzw ?? [0, 0, 0, 1];
  if (!(scale > 0) || !Number.isFinite(scale) || !finiteVector(translation, 3) || !finiteVector(rotation, 4)
      || !['Y', 'Z', undefined].includes(asset.sourceUp) || Math.abs(Math.hypot(...rotation) - 1) > 1e-5) throw new Error('Unsupported Gaussian alignment.');
  const sourceUp = new THREE.Quaternion();
  if (asset.sourceUp === 'Z') sourceUp.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const q = new THREE.Quaternion().fromArray(rotation).multiply(sourceUp);
  const world = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(translation), q, new THREE.Vector3(scale, scale, scale));
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(18 / pose.focalLengthMm) * 180 / Math.PI, width / height, .001, 100);
  camera.position.fromArray(pose.positionM); camera.lookAt(new THREE.Vector3().fromArray(pose.targetM)); camera.updateMatrixWorld(true);
  const m = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, world).elements;
  const x = [m[0], m[4], m[8], m[12]], y = [m[1], m[5], m[9], m[13]], d = [-m[2], -m[6], -m[10], -m[14]];
  const px = pose.focalLengthMm / 18 / (width / height), py = pose.focalLengthMm / 18;
  // Additional error allows source fixed-point -> Spark half-float packing and
  // float32 accumulation/rebasing. Boundary cases are retained, never removed.
  if(coveringBounds) {
    const [left,right,bottom,top]=coveringBounds;
    return [d,d.map((v,i)=>right*v-x[i]),d.map((v,i)=>x[i]-left*v),d.map((v,i)=>top*v-y[i]),d.map((v,i)=>y[i]-bottom*v)];
  }
  const plane = (axis, sign, projection) => d.map((value, i) => 1.5 * value + sign * projection * axis[i]);
  return [d, plane(x, 1, px), plane(x, -1, px), plane(y, 1, py), plane(y, -1, py)];
}

/** A fixed-center film's padded cones can be enclosed once. This avoids
 * O(points × frames) filtering while deliberately retaining the larger union. */
function fixedCenterBounds(frames,width,height) {
  const first=frames[0].camera;
  if(!frames.every(frame=>frame.camera.positionM.every((value,i)=>value===first.positionM[i])))return null;
  const reference=new THREE.PerspectiveCamera();reference.position.fromArray(first.positionM);
  reference.lookAt(new THREE.Vector3().fromArray(first.targetM));reference.updateMatrixWorld(true);
  const inverse=reference.quaternion.clone().invert();let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity;
  for(const frame of frames) {
    const pose=frame.camera,camera=new THREE.PerspectiveCamera();camera.position.fromArray(pose.positionM);
    camera.lookAt(new THREE.Vector3().fromArray(pose.targetM));camera.updateMatrixWorld(true);
    for(const sx of [-1,1])for(const sy of [-1,1]) {
      const ray=new THREE.Vector3(sx*1.5*18/pose.focalLengthMm*width/height,sy*1.5*18/pose.focalLengthMm,-1)
        .applyQuaternion(camera.quaternion).applyQuaternion(inverse);
      if(-ray.z<=.001)throw new Error('Camera coverage spans beyond a bounded source cone.');
      const x=ray.x/-ray.z,y=ray.y/-ray.z;left=Math.min(left,x);right=Math.max(right,x);bottom=Math.min(bottom,y);top=Math.max(top,y);
    }
  }
  return [left-.002,right+.002,bottom-.002,top+.002];
}

export function selectCameraRecords(parsed, asset, frames, width, height) {
  if (!frames.length || frames.length > 100000 || !Number.isInteger(width) || !Number.isInteger(height)
      || width < 2 || height < 2 || width > 16384 || height > 16384) throw new Error('Invalid camera-copy frame range or dimensions.');
  // Identical poses need only one conservative test. Optics stay in the key.
  const cameras = [...new Map(frames.map(frame => [canonical(frame.camera), frame])).values()];
  // Validate every camera before using it to build a covering cone.
  for(const frame of cameras)framePlanes(asset,frame,width,height);
  const bounds=fixedCenterBounds(cameras,width,height);
  if(!bounds&&cameras.length>12)throw new Error('Traveling camera coverage keeps the full source rather than an expensive uncertain subset.');
  const planes = bounds?[framePlanes(asset,cameras[0],width,height,bounds)]:cameras.map(frame => framePlanes(asset, frame, width, height));
  const selected = [], factor = 2 ** -parsed.bits;
  for (let index = 0; index < parsed.count; index += 1) {
    const start = 16 + index * 9;
    const p = [parsed.raw.readIntLE(start, 3) * factor, parsed.raw.readIntLE(start + 3, 3) * factor, parsed.raw.readIntLE(start + 6, 3) * factor];
    const errors = p.map(v => Math.max(.001, Math.abs(v) * .004));
    const kept = planes.some(view => view.every(plane => {
      const value = plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] + plane[3];
      const error = Math.abs(plane[0]) * errors[0] + Math.abs(plane[1]) * errors[1] + Math.abs(plane[2]) * errors[2]
        + .001 * (1 + Math.abs(plane[3]));
      return value >= -error;
    }));
    if (kept) selected.push(index);
  }
  return selected;
}

/** Decode PNG filters before hashing, so metadata/compression never count as quality. */
export function pngPixelsDigest(bytes) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (!Buffer.isBuffer(bytes) || !bytes.subarray(0, 8).equals(signature)) throw new Error('Quality gate requires PNG bytes.');
  let width, height, channels, offset = 8; const blocks = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8), end = offset + size + 12;
    if (end > bytes.length) throw new Error('Truncated quality-gate PNG.');
    if (kind === 'IHDR') {
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      const type = bytes[offset + 17]; channels = type === 6 ? 4 : type === 2 ? 3 : 0;
      if (!channels || bytes[offset + 16] !== 8 || bytes[offset + 18] || bytes[offset + 19] || bytes[offset + 20]) throw new Error('Unsupported quality-gate PNG format.');
    }
    if (kind === 'IDAT') blocks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset = end; if (kind === 'IEND') break;
  }
  if (!width || !height || width * height * 4 > MAX_DECODED_BYTES) throw new Error('Quality-gate PNG exceeds bounds.');
  const stride = width * channels, raw = inflateSync(Buffer.concat(blocks), {maxOutputLength: (stride + 1) * height});
  if (raw.length !== (stride + 1) * height) throw new Error('Quality-gate PNG rows are incomplete.');
  const rows = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
  for (let y=0; y<height; y+=1) {
    const filter = raw[y*(stride+1)]; if (filter > 4) throw new Error('Unsupported quality-gate PNG filter.');
    for (let x=0; x<stride; x+=1) {
      const i=y*stride+x, a=x>=channels?rows[i-channels]:0, b=y?rows[i-stride]:0, c=y&&x>=channels?rows[i-stride-channels]:0;
      rows[i]=(raw[y*(stride+1)+1+x]+(filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c)))&255;
    }
  }
  const rgba = channels === 4 ? rows : Buffer.alloc(width*height*4);
  if (channels === 3) for (let i=0; i<width*height; i+=1) { rows.copy(rgba, i*4, i*3, i*3+3); rgba[i*4+3]=255; }
  return hash(Buffer.concat([Buffer.from(`${width}x${height}:rgba8\0`), rgba]));
}

/** Build/cache an unapproved candidate; caller performs the real renderer gate. */
export async function prepareWorldCopy({assetPath, asset, frames, width, height, runtimeDigest, execution, cacheRoot,spaceProbe=availableDiskBytes,cacheBudgetBytes}) {
  const fallback = reason => ({receipt:{status:'full-source',policy:WORLD_COPY_POLICY,sourceSha256:asset.sha256,reason}});
  if (process.env.GESSO_GAUSSIAN_WORLD_COPY === '0') return fallback('Camera-specific copies disabled by server configuration.');
  if (asset.format !== 'spz') return fallback('Only the exact supported SPZ layout is eligible.');
  const spark=JSON.parse(await fs.readFile(path.join(root,'web/node_modules/@sparkjsdev/spark/package.json'),'utf8'));
  if(spark.version!=='2.3.1')return fallback('Camera-copy clipping requires the pinned Spark 2.3.1 shader.');
  if (!digestPattern.test(runtimeDigest ?? '') || !execution || !cacheRoot) throw new Error('Camera-copy runtime, execution and cache identity are required.');
  const stat=await fs.stat(assetPath);if(!stat.isFile()||stat.size>MAX_SOURCE_BYTES)return fallback('Camera-copy source exceeds the bounded input size.');
  const bytes = await fs.readFile(assetPath);
  if (hash(bytes) !== asset.sha256) throw new Error('Camera-copy source differs from its immutable SHA256.');
  let parsed, selected;
  try { parsed=parseSpz(bytes); selected=selectCameraRecords(parsed, asset, frames, width, height); }
  catch (error) { return fallback(error.message); }
  if (!selected.length || selected.length >= parsed.count * .95) return fallback('Conservative camera coverage does not remove enough records.');
  const key = hash(canonical({policy:WORLD_COPY_POLICY, module:hash(await fs.readFile(filename)), sourceSha256:asset.sha256,
    asset, frames:frames.map(frame=>({frame:frame.frame,camera:frame.camera})), width,height,runtimeDigest,execution}));
  const directory = path.join(cacheRoot, key);
  const copyBytes = subsetSpz(parsed, selected), copySha256 = hash(copyBytes), copyPath = path.join(directory, `${copySha256}.spz`);
  let existing;
  try { existing=await fs.readFile(copyPath); } catch(error) { if(error.code!=='ENOENT')throw error; }
  if (existing && hash(existing)!==copySha256) throw new Error('Immutable camera-copy cache was modified.');
  const receipt={status:'candidate',policy:WORLD_COPY_POLICY,key,sourceSha256:asset.sha256,copySha256,
    sourcePoints:parsed.count,copyPoints:selected.length,sourceBytes:bytes.length,copyBytes:copyBytes.length,
    frameNumbers:frames.map(frame=>frame.frame),width,height};
  const qualityPath=path.join(directory,'quality.json'); let quality;
  try {
    const qualityBytes=await fs.readFile(qualityPath);quality=JSON.parse(qualityBytes);
    if(quality.schemaVersion!==1||quality.policy!==WORLD_COPY_POLICY||quality.key!==key||quality.copySha256!==copySha256||quality.sourceSha256!==asset.sha256)throw new Error('Camera-copy quality receipt is invalid.');
    if(quality.status==='rejected'&&typeof quality.reason==='string')return fallback(quality.reason);
    if(quality.status!=='verified'
        ||quality.frameProofs?.length!==frames.length||quality.frameProofs.some((proof,i)=>proof.frame!==frames[i].frame
          ||!digestPattern.test(proof.reference??'')||proof.reference!==proof.copy)) throw new Error('Camera-copy quality receipt is invalid.');
    receipt.status='verified';receipt.qualityDigest=hash(qualityBytes);
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  // Verified reuse admits no new cache bytes. A later budget reduction or an
  // unrelated writer's lease must not change a pinned partial job's inputs.
  if(existing&&receipt.status==='verified')return {path:copyPath,bytes:copyBytes,receipt,qualityPath,quality};
  // Admission is serialized, bounded and non-evicting. Reserve the future proof
  // size so concurrent new cameras cannot each consume the same cache budget.
  let lock;
  try {
    const availableBytes=await spaceProbe(cacheRoot),budgetBytes=cacheBudgetBytes??worldCopyCacheBudget();
    const qualityReserve=quality?0:frames.length*256+2048;
    const incomingBytes=(existing?0:copyBytes.length)+qualityReserve+(quality?0:1024),evidenceBytes=copyBytes.length+qualityReserve;
    const reason=cacheAdmissionReason({usedBytes:await cacheUsedBytes(cacheRoot),incomingBytes,availableBytes,budgetBytes,evidenceBytes})
      ||(receipt.status==='candidate'?gateStagingReason({width,height,frameCount:frames.length,availableBytes:availableBytes-incomingBytes-copyBytes.length}):null);
    if(reason)return fallback(reason);
    await fs.mkdir(cacheRoot,{recursive:true});
    lock=await cacheAdmissionLock(cacheRoot);
    if(!lock)return fallback('Camera-copy cache admission is busy; the full source is retained.');
    // Recheck after obtaining the lock; another job may have just admitted data.
    const currentReason=cacheAdmissionReason({usedBytes:await cacheUsedBytes(cacheRoot),incomingBytes,availableBytes:await spaceProbe(cacheRoot),budgetBytes,evidenceBytes});
    if(currentReason)return fallback(currentReason);
    await fs.mkdir(directory,{recursive:true});
    if(!existing)await atomicWrite(copyPath,copyBytes);
    if(!quality)await atomicWrite(path.join(directory,'budget.json'),`${JSON.stringify({reservedQualityBytes:qualityReserve})}\n`);
  } catch(error) {
    if(spaceError(error))return fallback('Insufficient free disk for camera-copy cache admission; the full source is retained.');
    throw error;
  } finally {if(lock){await lock.close();await fs.rm(path.join(cacheRoot,'admission.lock'),{force:true});}}
  return {path:copyPath,bytes:copyBytes,receipt,qualityPath,quality};
}

export async function acceptWorldCopy(copy, frameProofs) {
  if(!copy.qualityPath||frameProofs.length!==copy.receipt.frameNumbers.length
      ||frameProofs.some((proof,i)=>proof.frame!==copy.receipt.frameNumbers[i]||!digestPattern.test(proof.reference??'')||proof.reference!==proof.copy)) {
    throw new Error('Every requested frame must match exact full-source pixels before a camera copy is accepted.');
  }
  const quality={schemaVersion:1,status:'verified',policy:WORLD_COPY_POLICY,key:copy.receipt.key,sourceSha256:copy.receipt.sourceSha256,
    copySha256:copy.receipt.copySha256,frameProofs};
  const bytes=Buffer.from(`${JSON.stringify(quality,null,2)}\n`);await atomicWrite(copy.qualityPath,bytes);
  copy.quality=quality;copy.receipt={...copy.receipt,status:'verified',qualityDigest:hash(bytes)};
  return copy.receipt;
}

export async function rejectWorldCopy(copy, reason) {
  const rejected={schemaVersion:1,status:'rejected',policy:WORLD_COPY_POLICY,key:copy.receipt.key,sourceSha256:copy.receipt.sourceSha256,
    copySha256:copy.receipt.copySha256,reason};
  try{await atomicWrite(copy.qualityPath,`${JSON.stringify(rejected,null,2)}\n`);}catch(error){if(!spaceError(error))throw error;}
  return {status:'full-source',policy:WORLD_COPY_POLICY,sourceSha256:copy.receipt.sourceSha256,reason};
}

/** Resume may restore a missing input from the immutable cache, but a changed
 * recorded input is an integrity error and must never be silently repaired. */
export async function writeWorldCopyEvidence(copy, output,{spaceProbe=availableDiskBytes}={}) {
  if(copy.receipt.status!=='verified')throw new Error('Only verified camera copies can enter export evidence.');
  const qualityBytes=await fs.readFile(copy.qualityPath);
  if(hash(copy.bytes)!==copy.receipt.copySha256||hash(qualityBytes)!==copy.receipt.qualityDigest)throw new Error('Camera-copy bytes or quality receipt changed.');
  const missing=[];
  for(const [name,bytes,digest] of [['world-copy.spz',copy.bytes,copy.receipt.copySha256],['world-copy-quality.json',qualityBytes,copy.receipt.qualityDigest]]) {
    const destination=path.join(output,name);let present;
    try {const stat=await fs.lstat(destination);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==bytes.length)throw new Error('Recorded camera-copy input changed.');present=await fs.readFile(destination);}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(present){if(hash(present)!==digest)throw new Error('Recorded camera-copy input changed.');}
    else missing.push({destination,bytes});
  }
  const required=missing.reduce((sum,item)=>sum+item.bytes.length,0);
  if(required&&await spaceProbe(output)<required+SPACE_CUSHION)throw new Error('Insufficient free disk to write missing camera-copy export evidence. Free space before resuming this pinned job.');
  for(const {destination,bytes} of missing)await atomicWrite(destination,bytes);
}

/** First use compares every actual output frame, retaining full PNGs on disk
 * until the gate finishes. If the copy differs or fails, publish those already
 * captured originals; never pay for a third render or substitute fewer points.
 * On a verified hit only the derivative is loaded and rendered.
 * loadAsset(undefined) means the unchanged canonical source.
 */
export async function captureWithWorldCopy({copy, frameNumbers, loadAsset, renderFrameBytes, publishFrame, temporaryRoot, onDecision=async()=>{},isCancelled=()=>false,spaceProbe=availableDiskBytes}) {
  const checkCancelled=()=>{if(isCancelled())throw new Error('Gaussian camera-copy capture cancelled.');};checkCancelled();
  if(copy.receipt.status==='full-source') {
    await onDecision(copy.receipt);
    await loadAsset();
    for(const frame of frameNumbers){checkCancelled();await publishFrame(frame,await renderFrameBytes(frame));}
    return copy.receipt;
  }
  if(copy.receipt.status==='verified') {
    try { await loadAsset(copy); }
    catch(error) {
      checkCancelled();
      const receipt=await rejectWorldCopy(copy,`Verified camera copy could not load: ${error.message}`);
      await onDecision(receipt);
      await loadAsset();
      for(const frame of frameNumbers){checkCancelled();await publishFrame(frame,await renderFrameBytes(frame));}
      return receipt;
    }
    await onDecision(copy.receipt);
    for(const frame of frameNumbers){checkCancelled();await publishFrame(frame,await renderFrameBytes(frame));}
    return copy.receipt;
  }
  const stagingReason=gateStagingReason({width:copy.receipt.width,height:copy.receipt.height,frameCount:frameNumbers.length,availableBytes:await spaceProbe(temporaryRoot)});
  if(stagingReason)return captureWithWorldCopy({copy:{receipt:{status:'full-source',policy:WORLD_COPY_POLICY,sourceSha256:copy.receipt.sourceSha256,reason:stagingReason}},
    frameNumbers,loadAsset,renderFrameBytes,publishFrame,temporaryRoot,onDecision,isCancelled,spaceProbe});
  let staging;
  try{await fs.mkdir(temporaryRoot,{recursive:true});staging=await fs.mkdtemp(path.join(temporaryRoot,'world-copy-gate-'));}
  catch(error){
    if(!spaceError(error))throw error;
    return captureWithWorldCopy({copy:{receipt:{status:'full-source',policy:WORLD_COPY_POLICY,sourceSha256:copy.receipt.sourceSha256,
      reason:'Insufficient free disk to start the camera-copy quality gate; rendering the unchanged full source without staging.'}},
      frameNumbers,loadAsset,renderFrameBytes,publishFrame,temporaryRoot,onDecision,isCancelled,spaceProbe});
  }
  const proofs=[]; let receipt;
  const name=frame=>path.join(staging,`${String(frame).padStart(6,'0')}.png`);
  try {
    await loadAsset();
    for(const frame of frameNumbers) {
      checkCancelled();
      const bytes=await renderFrameBytes(frame);
      proofs.push({frame,reference:pngPixelsDigest(bytes)});
      await fs.writeFile(name(frame),bytes,{flag:'wx'});
    }
    try {
      await loadAsset(copy);
      for(const proof of proofs) {
        checkCancelled();
        proof.copy=pngPixelsDigest(await renderFrameBytes(proof.frame));
        if(proof.copy!==proof.reference)throw new Error(`Full-source pixels differ at frame ${proof.frame}.`);
      }
      receipt=await acceptWorldCopy(copy,proofs);
    } catch(error) { checkCancelled();receipt=await rejectWorldCopy(copy,`Exact full-source quality gate kept the original: ${error.message}`); }
    await onDecision(receipt);
    for(const frame of frameNumbers){
      checkCancelled();await publishFrame(frame,await fs.readFile(name(frame)));
      // The caller has durably published/hash-recorded this PNG. Release its
      // temporary reference now so a long film does not duplicate a sequence.
      await fs.rm(name(frame));
    }
    return receipt;
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}
