import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync,deflateSync} from 'node:zlib';
import {parseSpz,captureWithWorldCopy} from './gaussian_world_copy.mjs';
import {INTERIOR_POLICY,proposeInteriorRecords,prepareInteriorCopy} from './gaussian_interior_cleanup.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const asset={format:'spz',sourceUp:'Y',scaleToMeters:1,translationM:[0,0,0],rotationXyzw:[0,0,0,1]};
const frames=[{frame:1,camera:{positionM:[-1,2.5,2.5],targetM:[2.5,2.5,2.5],focalLengthMm:50}}];
function denseCube() {
  const points=[];
  for(let x=0;x<5;x++)for(let y=0;y<5;y++)for(let z=0;z<5;z++)
    for(const a of [.45,.55])for(const b of [.45,.55])for(const c of [.45,.55])points.push([x+a,y+b,z+c]);
  const raw=Buffer.alloc(16+points.length*19);raw.writeUInt32LE(0x5053474e,0);raw.writeUInt32LE(2,4);raw.writeUInt32LE(points.length,8);raw[13]=12;
  for(let index=0;index<points.length;index++)for(let axis=0;axis<3;axis++)raw.writeIntLE(Math.round(points[index][axis]*4096),16+index*9+axis*3,3);
  const alpha=16+points.length*9,scales=alpha+points.length*4;
  raw.fill(255,alpha,alpha+points.length);raw.fill(50,scales,scales+points.length*3);
  return {raw,points,alpha,scales,bytes:gzipSync(raw)};
}
function png(red=10) {
  const chunk=(name,bytes)=>{const out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);out.write(name,4);bytes.copy(out,8);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,red,20,30,255]))),chunk('IEND',Buffer.alloc(0))]);
}

test('only a dense center behind two retained cell layers is proposed',()=>{
  const fixture=denseCube(),parsed=parseSpz(fixture.bytes);
  const proposal=proposeInteriorRecords(parsed,asset,frames,{voxelSizeM:1});
  assert.equal(proposal.counts.proposedCells,1);assert.equal(proposal.counts.proposedPoints,8);
  assert.equal(proposal.selected.length,992);
  const removed=fixture.points.filter((_,index)=>!proposal.selected.includes(index));
  assert(removed.every(p=>p.every(value=>value>2&&value<3)),'both shell layers are retained');
  assert.deepEqual(parsed.raw,fixture.raw,'proposal never edits source bytes');
});

test('transparent, large and sparse cells retain all ambiguous records',()=>{
  for(const kind of ['transparent','large','sparse']) {
    const fixture=denseCube(),center=fixture.points.findIndex(p=>p.every(value=>value>2&&value<3));
    if(kind==='transparent')fixture.raw[fixture.alpha+center]=100;
    if(kind==='large')fixture.raw[fixture.scales+center*3]=200;
    const parsed=parseSpz(gzipSync(fixture.raw));
    const proposal=proposeInteriorRecords(parsed,asset,frames,{voxelSizeM:1,minRecords:kind==='sparse'?9:8});
    assert.equal(proposal.selected.length,parsed.count,kind);
  }
});

test('unoccluded or budget-limited sweeps retain the source',()=>{
  const parsed=parseSpz(denseCube().bytes);
  const inside=[{frame:1,camera:{...frames[0].camera,positionM:[2.5,2.5,2.5],targetM:[2.5,2.5,1.5]}}];
  assert.equal(proposeInteriorRecords(parsed,asset,inside,{voxelSizeM:1}).counts.proposedPoints,0);
  for(const budget of [{maxCells:4},{maxRaySteps:1}]) {
    const proposal=proposeInteriorRecords(parsed,asset,frames,{voxelSizeM:1,...budget});
    assert.equal(proposal.selected.length,parsed.count);assert.match(proposal.reason,/budget exceeded/);
  }
});

test('a proposal is immutable and keeps its distinct policy through pixel rejection',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gesso-interior-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const {bytes}=denseCube(),source=path.join(directory,'source.spz');await fs.writeFile(source,bytes);
  const options={assetPath:source,asset:{...asset,sha256:hash(bytes)},frames,width:2,height:2,
    runtimeDigest:'a'.repeat(64),execution:{backend:'fixture'},cacheRoot:path.join(directory,'cache'),voxelSizeM:1};
  const copy=await prepareInteriorCopy(options);
  assert.equal(copy.receipt.status,'candidate');assert.equal(copy.receipt.policy,INTERIOR_POLICY);
  assert.deepEqual(await fs.readFile(source),bytes);
  let candidate=false;
  const receipt=await captureWithWorldCopy({copy,frameNumbers:[1],loadAsset:async value=>{candidate=!!value;},
    renderFrameBytes:async()=>png(candidate?11:10),publishFrame:async(_frame,pixels)=>assert.deepEqual(pixels,png()),
    temporaryRoot:path.join(directory,'gate')});
  assert.equal(receipt.status,'full-source');assert.equal(receipt.policy,INTERIOR_POLICY);
  assert.match(receipt.reason,/pixels differ/);
  await fs.writeFile(copy.path,'changed');await assert.rejects(prepareInteriorCopy(options),/changed/);
});

test('an accepted proposal proves only its finite sampled pixels',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gesso-interior-gate-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const {bytes}=denseCube(),source=path.join(directory,'source.spz');await fs.writeFile(source,bytes);
  const copy=await prepareInteriorCopy({assetPath:source,asset:{...asset,sha256:hash(bytes)},frames,width:2,height:2,
    runtimeDigest:'a'.repeat(64),execution:{backend:'fixture'},cacheRoot:path.join(directory,'cache'),voxelSizeM:1});
  const receipt=await captureWithWorldCopy({copy,frameNumbers:[1],loadAsset:async()=>{},renderFrameBytes:async()=>png(),
    publishFrame:async()=>{},temporaryRoot:path.join(directory,'gate')});
  assert.equal(receipt.status,'verified');assert.equal(receipt.policy,INTERIOR_POLICY);
  assert.match(receipt.limitations.join(' '),/finite cameras/);
  const quality=JSON.parse(await fs.readFile(copy.qualityPath,'utf8'));
  assert.equal(quality.policy,INTERIOR_POLICY);assert.equal(quality.frameProofs.length,1);
});
