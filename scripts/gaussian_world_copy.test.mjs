import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync,deflateSync} from 'node:zlib';
import {parseSpz,subsetSpz,selectCameraRecords,pngPixelsDigest,prepareWorldCopy,acceptWorldCopy,captureWithWorldCopy,writeWorldCopyEvidence,
  worldCopyCacheBudget,cacheAdmissionReason,gateStagingReason} from './gaussian_world_copy.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const camera=(x=0,focalLengthMm=50,target=[0,0,-1])=>({positionM:[x,0,0],targetM:target,focalLengthMm});
const frame=(n=1,pose=camera())=>({frame:n,camera:pose});
const asset={format:'spz',sourceUp:'Y',scaleToMeters:1,translationM:[0,0,0],rotationXyzw:[0,0,0,1]};
function source(points) {
  const raw=Buffer.alloc(16+points.length*19);raw.writeUInt32LE(0x5053474e,0);raw.writeUInt32LE(2,4);raw.writeUInt32LE(points.length,8);raw[13]=12;
  let offset=16;
  for(let i=0;i<points.length;i++)for(let j=0;j<3;j++)raw.writeIntLE(Math.round(points[i][j]*4096),offset+i*9+j*3,3);
  offset+=points.length*9;
  for(const stride of [1,3,3,3]){for(let i=0;i<points.length*stride;i++)raw[offset+i]=(i*37+offset)%256;offset+=points.length*stride;}
  return gzipSync(raw);
}
function png(pixels=[10,20,30,255],filter=0) {
  const chunk=(name,bytes)=>{const b=Buffer.alloc(bytes.length+12);b.writeUInt32BE(bytes.length,0);b.write(name,4);bytes.copy(b,8);return b;};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([filter,...pixels]))),chunk('IEND',Buffer.alloc(0))]);
}
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gesso-copy-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bytes=source([[0,0,-3],[0,0,3],[8,0,-3],[-8,0,-3]]),filename=path.join(dir,'source.spz');await fs.writeFile(filename,bytes);
  return {dir,bytes,options:{assetPath:filename,asset:{...asset,sha256:hash(bytes)},frames:[frame()],width:270,height:480,
    runtimeDigest:'a'.repeat(64),execution:{backend:'hardware',renderer:'fixture'},cacheRoot:path.join(dir,'cache')}};
}

test('SPZ subset preserves every retained encoded attribute byte and source order',()=>{
  const bytes=source([[1,2,3],[4,5,6],[7,8,9]]),parsed=parseSpz(bytes),out=parseSpz(subsetSpz(parsed,[0,2]));
  assert.equal(out.count,2);assert.deepEqual(gunzipSync(bytes),parsed.raw);
  for(let b=0;b<parsed.blocks.length;b++)for(let i=0;i<2;i++) {
    const from=parsed.blocks[b],to=out.blocks[b],index=[0,2][i];
    assert.deepEqual(out.raw.subarray(to.offset+i*to.stride,to.offset+(i+1)*to.stride),parsed.raw.subarray(from.offset+index*from.stride,from.offset+(index+1)*from.stride));
  }
  assert.throws(()=>subsetSpz(parsed,[2,0]),/increase/);
});

test('padded shader center coverage retains outside-image contributors and all-camera union',()=>{
  // At 50mm and square aspect, the image halfwidth is .36*depth. The
  // renderer accepts centers to 1.4× that; a normal image-edge crop is wrong.
  const parsed=parseSpz(source([[0,0,-2],[.95,0,-2],[1.2,0,-2],[0,0,2],[6,0,-2]]));
  assert.deepEqual(selectCameraRecords(parsed,asset,[frame()],400,400),[0,1]);
  const two=selectCameraRecords(parsed,asset,[frame(),frame(2,camera(0,50,[1,0,-1]))],400,400);
  assert(two.includes(2));assert(two.includes(4));assert(!two.includes(3));
});

test('world transforms and packing-boundary uncertainty stay conservative',()=>{
  const parsed=parseSpz(source([[0,0,2],[0,0,-2],[.54,0,-1]]));
  const turned={...asset,rotationXyzw:[0,1,0,0]};
  assert.deepEqual(selectCameraRecords(parsed,turned,[frame()],400,400),[0]);
  assert(selectCameraRecords(parsed,asset,[frame()],400,400).includes(2));
});

test('360 fixed-center cameras use one conservative cone while large traveling sets fall back',()=>{
  const parsed=parseSpz(source([[0,0,-2],[8,0,-2],[0,0,2]]));
  const frames=Array.from({length:360},(_,i)=>frame(i+1,camera(0,50+i/10,[Math.sin(i/100)*.02,0,-1])));
  assert.deepEqual(selectCameraRecords(parsed,asset,frames,270,480),[0]);
  assert.throws(()=>selectCameraRecords(parsed,asset,frames.map((f,i)=>frame(i+1,camera(i/100))),270,480),/Traveling/);
});

test('exact RGBA digest ignores PNG filters but detects a one-channel pixel change',()=>{
  assert.equal(pngPixelsDigest(png()),pngPixelsDigest(png([10,20,30,255],1)));
  assert.notEqual(pngPixelsDigest(png()),pngPixelsDigest(png([11,20,30,255])));
  assert.throws(()=>pngPixelsDigest(Buffer.from('not png')),/PNG/);
});

test('cache admission is bounded and gate space includes worst-case PNGs plus cushion',()=>{
  const mib=1024*1024;
  assert.equal(worldCopyCacheBudget(),256*mib);assert.equal(worldCopyCacheBudget('0'),0);
  assert.throws(()=>worldCopyCacheBudget('-1'),/integer/);
  assert.match(cacheAdmissionReason({usedBytes:250*mib,incomingBytes:7*mib,availableBytes:1024*mib,budgetBytes:256*mib}),/budget is full/);
  assert.match(cacheAdmissionReason({usedBytes:0,incomingBytes:7*mib,availableBytes:32*mib,budgetBytes:256*mib}),/free disk/);
  assert.equal(cacheAdmissionReason({usedBytes:0,incomingBytes:7*mib,availableBytes:100*mib,budgetBytes:256*mib}),null);
  assert.match(gateStagingReason({width:1080,height:1920,frameCount:360,availableBytes:1024*mib}),/quality gate/);
  assert.equal(gateStagingReason({width:1080,height:1920,frameCount:1,availableBytes:100*mib}),null);
});

test('low disk or cache budget keeps canonical source before creating a derivative',async t=>{
  const f=await fixture(t);
  const lowDisk=await prepareWorldCopy({...f.options,spaceProbe:async()=>1024});
  assert.equal(lowDisk.receipt.status,'full-source');assert.match(lowDisk.receipt.reason,/free disk/);
  await assert.rejects(fs.access(f.options.cacheRoot),{code:'ENOENT'});
  const fullCache=await prepareWorldCopy({...f.options,spaceProbe:async()=>1024**3,cacheBudgetBytes:0});
  assert.equal(fullCache.receipt.status,'full-source');assert.match(fullCache.receipt.reason,/budget is full/);
  assert.deepEqual(await fs.readFile(f.options.assetPath),f.bytes);
  const noSpace=await prepareWorldCopy({...f.options,spaceProbe:async()=>{throw Object.assign(new Error('fixture full disk'),{code:'ENOSPC'});}});
  assert.equal(noSpace.receipt.status,'full-source');assert.match(noSpace.receipt.reason,/free disk/);
});

test('cache admission is serialized and releases a dead worker lease without evicting assets',async t=>{
  const f=await fixture(t);await fs.mkdir(f.options.cacheRoot);const lock=path.join(f.options.cacheRoot,'admission.lock');
  await fs.writeFile(lock,JSON.stringify({pid:process.pid}));
  const busy=await prepareWorldCopy(f.options);assert.equal(busy.receipt.status,'full-source');assert.match(busy.receipt.reason,/busy/);
  await fs.writeFile(lock,JSON.stringify({pid:2147483647}));
  const admitted=await prepareWorldCopy(f.options);assert.equal(admitted.receipt.status,'candidate');await assert.rejects(fs.access(lock),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(f.options.assetPath),f.bytes);
});

test('candidate cache preserves original, pins all optics and rejects modified derivative',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options);
  assert.equal(copy.receipt.status,'candidate');assert.equal(copy.receipt.copyPoints,1);
  assert.deepEqual(await fs.readFile(f.options.assetPath),f.bytes);
  const changed=await prepareWorldCopy({...f.options,frames:[frame(1,{...camera(),depthOfField:{enabled:true,fStop:2,focusDistanceM:1}})]});
  assert.notEqual(copy.receipt.key,changed.receipt.key);
  await fs.writeFile(copy.path,'changed');await assert.rejects(prepareWorldCopy(f.options),/modified/);
});

test('only complete matching all-frame pixel evidence enables verified reuse',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options),pixel=pngPixelsDigest(png());
  await assert.rejects(acceptWorldCopy(copy,[]),/Every requested frame/);
  await assert.rejects(acceptWorldCopy(copy,[{frame:1,reference:pixel,copy:'b'.repeat(64)}]),/Every requested frame/);
  await acceptWorldCopy(copy,[{frame:1,reference:pixel,copy:pixel}]);
  const cached=await prepareWorldCopy(f.options);assert.equal(cached.receipt.status,'verified');
  assert.equal(cached.receipt.qualityDigest,hash(await fs.readFile(cached.qualityPath)));
});

test('verified reuse bypasses a busy admission lease and a subsequently lowered budget',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options),pixel=pngPixelsDigest(png());
  await acceptWorldCopy(copy,[{frame:1,reference:pixel,copy:pixel}]);
  await fs.writeFile(path.join(f.options.cacheRoot,'admission.lock'),JSON.stringify({pid:process.pid}));
  const reused=await prepareWorldCopy({...f.options,cacheBudgetBytes:0,spaceProbe:async()=>{assert.fail('verified reuse admits no cache bytes');}});
  assert.equal(reused.receipt.status,'verified');assert.deepEqual(reused.receipt,copy.receipt);
});

test('unsupported source layout keeps full source and source identity mismatch fails',async t=>{
  const f=await fixture(t),raw=gunzipSync(f.bytes);raw[14]=1;const bytes=gzipSync(raw);await fs.writeFile(f.options.assetPath,bytes);
  const fallback=await prepareWorldCopy({...f.options,asset:{...f.options.asset,sha256:hash(bytes)}});
  assert.equal(fallback.receipt.status,'full-source');assert.match(fallback.receipt.reason,/flags0/);
  await assert.rejects(prepareWorldCopy(f.options),/SHA256/);
});

test('export evidence restores missing copies but rejects mutated recorded inputs',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options),pixel=pngPixelsDigest(png()),out=path.join(f.dir,'plate');
  await fs.mkdir(out);await assert.rejects(writeWorldCopyEvidence(copy,out),/verified/);
  await acceptWorldCopy(copy,[{frame:1,reference:pixel,copy:pixel}]);await writeWorldCopyEvidence(copy,out);
  await fs.rm(path.join(out,'world-copy.spz'));await writeWorldCopyEvidence(copy,out);
  assert.deepEqual(await fs.readFile(path.join(out,'world-copy.spz')),copy.bytes);
  await fs.writeFile(path.join(out,'world-copy-quality.json'),'changed');await assert.rejects(writeWorldCopyEvidence(copy,out),/changed/);
});

test('complete pinned evidence skips free-space admission; only missing bytes require room',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options),pixel=pngPixelsDigest(png()),out=path.join(f.dir,'plate');
  await fs.mkdir(out);await acceptWorldCopy(copy,[{frame:1,reference:pixel,copy:pixel}]);
  await assert.rejects(writeWorldCopyEvidence(copy,out,{spaceProbe:async()=>0}),/missing camera-copy export evidence/);
  assert.deepEqual(await fs.readdir(out),[]);
  await writeWorldCopyEvidence(copy,out,{spaceProbe:async()=>1024**3});
  await writeWorldCopyEvidence(copy,out,{spaceProbe:async()=>{assert.fail('existing evidence needs no new disk admission');}});
});

test('first gate renders both sources, publishes original PNGs, then verified reuse renders only copy',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options),loads=[],renders=[],published=[],decisions=[];let mode;
  const callbacks={frameNumbers:[1],loadAsset:async c=>{mode=c?'copy':'full';loads.push(mode);},renderFrameBytes:async n=>{renders.push([mode,n]);return png();},
    publishFrame:async(n,b)=>published.push([n,b]),temporaryRoot:path.join(f.dir,'gates'),onDecision:async r=>decisions.push(r.status)};
  const r=await captureWithWorldCopy({copy,...callbacks});assert.equal(r.status,'verified');assert.deepEqual(loads,['full','copy']);
  assert.deepEqual(renders,[['full',1],['copy',1]]);assert.deepEqual(decisions,['verified']);assert.deepEqual(published[0][1],png());
  assert.deepEqual(await fs.readdir(path.join(f.dir,'gates')),[]);
  loads.length=0;renders.length=0;await captureWithWorldCopy({copy:await prepareWorldCopy(f.options),...callbacks});
  assert.deepEqual(loads,['copy']);assert.deepEqual(renders,[['copy',1]]);
});

test('one pixel mismatch falls back to captured originals and caches rejection without third render',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options);let mode;const loads=[],published=[];
  const r=await captureWithWorldCopy({copy,frameNumbers:[1],loadAsset:async c=>{mode=c?'copy':'full';loads.push(mode);},
    renderFrameBytes:async()=>mode==='copy'?png([11,20,30,255]):png(),publishFrame:async(n,b)=>published.push(b),temporaryRoot:path.join(f.dir,'gates')});
  assert.equal(r.status,'full-source');assert.match(r.reason,/pixels differ/);assert.deepEqual(loads,['full','copy']);assert.deepEqual(published,[png()]);
  assert.equal((await prepareWorldCopy(f.options)).receipt.status,'full-source');
});

test('cancellation cleans temporary reference images without caching a false quality rejection',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options);let cancelled=false;
  await assert.rejects(captureWithWorldCopy({copy,frameNumbers:[1],loadAsset:async c=>{if(c)cancelled=true;},renderFrameBytes:async()=>png(),
    publishFrame:async()=>assert.fail('cancelled frames must not publish'),temporaryRoot:path.join(f.dir,'gates'),isCancelled:()=>cancelled}),/cancelled/);
  assert.deepEqual(await fs.readdir(path.join(f.dir,'gates')),[]);assert.equal((await prepareWorldCopy(f.options)).receipt.status,'candidate');
});

test('low staging space renders unchanged full pixels without staging or a false rejection',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options),loads=[],published=[],decisions=[],temporaryRoot=path.join(f.dir,'no-stage');
  const r=await captureWithWorldCopy({copy,frameNumbers:[1],loadAsset:async c=>loads.push(c?'copy':'full'),renderFrameBytes:async()=>png(),
    publishFrame:async(n,b)=>published.push(b),temporaryRoot,onDecision:async r=>decisions.push(r.status),spaceProbe:async()=>1024});
  assert.equal(r.status,'full-source');assert.match(r.reason,/quality gate/);assert.deepEqual(loads,['full']);assert.deepEqual(published,[png()]);
  assert.deepEqual(decisions,['full-source']);await assert.rejects(fs.access(temporaryRoot),{code:'ENOENT'});
  assert.equal((await prepareWorldCopy(f.options)).receipt.status,'candidate');
});

test('fresh verified-cache load failure chooses full-source receipt before publication',async t=>{
  const f=await fixture(t),copy=await prepareWorldCopy(f.options),pixel=pngPixelsDigest(png()),decisions=[],loads=[],published=[];
  await acceptWorldCopy(copy,[{frame:1,reference:pixel,copy:pixel}]);
  const r=await captureWithWorldCopy({copy,frameNumbers:[1],loadAsset:async c=>{loads.push(c?'copy':'full');if(c)throw new Error('fixture load failed');},
    renderFrameBytes:async()=>png(),publishFrame:async(n,b)=>{assert.deepEqual(decisions,['full-source']);published.push(b);},
    temporaryRoot:path.join(f.dir,'gates'),onDecision:async r=>decisions.push(r.status)});
  assert.equal(r.status,'full-source');assert.deepEqual(loads,['copy','full']);assert.deepEqual(decisions,['full-source']);assert.deepEqual(published,[png()]);
});

test('verified partial resume renders only missing frames under the original all-frame proof',async t=>{
  const f=await fixture(t),frames=[frame(),frame(2)],copy=await prepareWorldCopy({...f.options,frames}),pixel=pngPixelsDigest(png()),rendered=[];
  await acceptWorldCopy(copy,frames.map(({frame})=>({frame,reference:pixel,copy:pixel})));
  const r=await captureWithWorldCopy({copy,frameNumbers:[2],loadAsset:async c=>assert(c),renderFrameBytes:async n=>{rendered.push(n);return png();},
    publishFrame:async()=>{},temporaryRoot:path.join(f.dir,'gates'),onDecision:async r=>assert.deepEqual(r.frameNumbers,[1,2])});
  assert.equal(r.status,'verified');assert.deepEqual(rendered,[2]);
});

test('proof scheduling during candidate comparison leaves no false quality rejection', async t => {
  const {options,dir}=await fixture(t),copy=await prepareWorldCopy(options);
  let renders=0;
  const yielded=Object.assign(new Error('proof waiting'),{code:'GESSO_PROOF_YIELD'});
  await assert.rejects(captureWithWorldCopy({copy,frameNumbers:[1],loadAsset:async()=>{},
    renderFrameBytes:async()=>{renders+=1;if(renders===2)throw yielded;return png();},publishFrame:async()=>assert.fail('Unapproved candidate was published'),
    temporaryRoot:path.join(dir,'staging')}),error=>error===yielded);
  await assert.rejects(fs.access(copy.qualityPath),/ENOENT/);
  assert.deepEqual(await fs.readdir(path.join(dir,'staging')),[]);
});
