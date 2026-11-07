#!/usr/bin/env node
/** Offline proposals only. Dense voxels do not prove that a Gaussian is hidden.
 * A proposed byte subset needs the shared renderer's exact finite-sweep gate.
 * The distinct policy is deliberately rejected by normal export consumers.
 */
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {availableDiskBytes,MAX_SOURCE_BYTES,parseSpz,subsetSpz} from './gaussian_world_copy.mjs';
import {atomicWrite, capture, parseArgs as captureArgs} from './capture_splats.mjs';

const scriptPath=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(scriptPath),'..');
const THREE=createRequire(path.join(root,'web/package.json'))('three');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const INTERIOR_POLICY='spz2-sh0-dense-interior-proposal-finite-sweep-exact-v1';
const limitations=[
  'Dense opacity is a proposal heuristic and does not establish a solid physical surface.',
  'Exact pixels cover only the declared finite cameras, optics, resolution and renderer.',
  'A verified subset cannot be installed for unrestricted navigation or other cameras.',
];
const keyOf=([x,y,z])=>`${x},${y},${z}`;
const finiteVector=(value,length)=>Array.isArray(value)&&value.length===length&&value.every(Number.isFinite);

function inverseAlignment(asset) {
  const scale=asset.scaleToMeters??1, translation=asset.translationM??[0,0,0],rotation=asset.rotationXyzw??[0,0,0,1];
  if(!(scale>0)||!Number.isFinite(scale)||!finiteVector(translation,3)||!finiteVector(rotation,4)
    ||Math.abs(Math.hypot(...rotation)-1)>1e-5||!['Y','Z',undefined].includes(asset.sourceUp))throw new Error('Unsupported Gaussian alignment.');
  const sourceUp=new THREE.Quaternion();
  if(asset.sourceUp==='Z')sourceUp.setFromAxisAngle(new THREE.Vector3(1,0,0),-Math.PI/2);
  const q=new THREE.Quaternion().fromArray(rotation).multiply(sourceUp);
  return {scale,inverse:new THREE.Matrix4().compose(new THREE.Vector3().fromArray(translation),q,new THREE.Vector3(scale,scale,scale)).invert()};
}

/** Preserve the outer two cell layers and every ambiguous record. The final
 * raster comparison, rather than this occupancy heuristic, decides acceptance.
 * SPZ scale and alpha follow Niantic's documented v2 encoding.
 */
export function proposeInteriorRecords(parsed,asset,frames,{voxelSizeM=.1,minRecords=8,maxCells=200000,maxRaySteps=2000000}={}) {
  if(!Number.isFinite(voxelSizeM)||voxelSizeM<.01||voxelSizeM>1||!Number.isInteger(minRecords)||minRecords<4
    ||!frames.length||frames.length>64)throw new Error('Use a 1 cm to 1 m voxel, at least four records per cell, and 1 to 64 sweep cameras.');
  const {scale,inverse}=inverseAlignment(asset),cellSize=voxelSizeM/scale;
  const cameras=frames.map(frame=>{
    if(!finiteVector(frame.camera?.positionM,3)||!finiteVector(frame.camera?.targetM,3)||!Number.isFinite(frame.camera.focalLengthMm)
      ||frame.camera.focalLengthMm<1||frame.camera.positionM.every((value,axis)=>value===frame.camera.targetM[axis]))
      throw new Error('Sweep cameras must have finite sampled positions, targets and optics.');
    return new THREE.Vector3().fromArray(frame.camera.positionM).applyMatrix4(inverse).toArray();
  });
  const cells=new Map(),factor=2**-parsed.bits;
  const counts={sourcePoints:parsed.count,denseCells:0,interiorCells:0,proposedCells:0,proposedPoints:0};
  const all=()=>({selected:Array.from({length:parsed.count},(_,index)=>index),counts});
  for(let index=0;index<parsed.count;index++) {
    const offset=parsed.blocks[0].offset+index*9;
    const p=[0,1,2].map(axis=>parsed.raw.readIntLE(offset+axis*3,3)*factor);
    const coordinates=p.map(value=>Math.floor(value/cellSize)),key=keyOf(coordinates);
    let cell=cells.get(key);
    if(!cell){cell={coordinates,indices:[],ambiguous:false};cells.set(key,cell);}
    if(cells.size>maxCells)return {...all(),reason:'Voxel budget exceeded; all source records retained.'};
    const alpha=parsed.raw[parsed.blocks[1].offset+index];
    const sigma=Math.exp(Math.max(...[0,1,2].map(axis=>parsed.raw[parsed.blocks[3].offset+index*3+axis]))/16-10);
    const margin=Math.min(...p.map((value,axis)=>Math.min(value-coordinates[axis]*cellSize,(coordinates[axis]+1)*cellSize-value)));
    const packingError=Math.max(.001,...p.map(value=>Math.abs(value)*.004));
    if(alpha<254||sigma*3+packingError>=margin||sigma*scale>voxelSizeM/12)cell.ambiguous=true;
    cell.indices.push(index);
  }
  const dense=new Set([...cells].filter(([,cell])=>!cell.ambiguous&&cell.indices.length>=minRecords).map(([key])=>key));
  counts.denseCells=dense.size;
  const interior=new Set();
  for(const key of dense) {
    const p=cells.get(key).coordinates;
    let enclosed=true;
    for(let x=-2;x<=2&&enclosed;x++)for(let y=-2;y<=2&&enclosed;y++)for(let z=-2;z<=2;z++)
      if(!dense.has(keyOf([p[0]+x,p[1]+y,p[2]+z]))){enclosed=false;break;}
    if(enclosed)interior.add(key);
  }
  counts.interiorCells=interior.size;
  if(interior.size>4096)return {...all(),reason:'Interior proposal budget exceeded; all source records retained.'};
  let raySteps=0;
  const shellBlocks=(camera,cell)=>{
    const end=cell.coordinates.map(value=>(value+.5)*cellSize),delta=end.map((value,axis)=>value-camera[axis]);
    const start=camera.map(value=>Math.floor(value/cellSize)),target=cell.coordinates;
    const steps=Math.ceil(Math.max(...target.map((value,axis)=>Math.abs(value-start[axis])))*4)+1;
    if(steps>2048)return false;
    const crossed=new Set();
    for(let step=1;step<steps;step++) {
      if(++raySteps>maxRaySteps)return false;
      const key=keyOf(camera.map((value,axis)=>Math.floor((value+delta[axis]*step/steps)/cellSize)));
      if(dense.has(key)&&!interior.has(key))crossed.add(key);
    }
    return crossed.size>=2;
  };
  const removed=new Set();
  for(const key of interior) {
    const cell=cells.get(key);
    if(cameras.every(camera=>shellBlocks(camera,cell))) {
      if(removed.size+cell.indices.length>Math.max(minRecords,Math.floor(parsed.count*.05)))continue;
      for(const index of cell.indices)removed.add(index);
      counts.proposedCells++;
    }
    if(raySteps>maxRaySteps)return {...all(),counts:{...counts,proposedCells:0,proposedPoints:0},reason:'Sweep work budget exceeded; all source records retained.'};
  }
  counts.proposedPoints=removed.size;
  return {selected:Array.from({length:parsed.count},(_,index)=>index).filter(index=>!removed.has(index)),counts,
    reason:removed.size?'Interior redundancy is proposed only; exact finite-sweep pixels are required.':'No conservatively enclosed records found; all source records retained.'};
}

export async function prepareInteriorCopy({assetPath,asset,frames,width,height,runtimeDigest,execution,cacheRoot,voxelSizeM=.1}) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width>16384||height>16384)
    throw new Error('Declare a finite sweep resolution from 2 to 16384 pixels per side.');
  const sourceStat=await fs.stat(assetPath);
  if(!sourceStat.isFile()||sourceStat.size>MAX_SOURCE_BYTES)throw new Error('Interior source exceeds the bounded SPZ input size.');
  const bytes=await fs.readFile(assetPath);
  if(hash(bytes)!==asset.sha256)throw new Error('Source SPZ does not match its immutable SHA256.');
  let parsed,proposal;
  try{parsed=parseSpz(bytes);proposal=proposeInteriorRecords(parsed,asset,frames,{voxelSizeM});}
  catch(error){return {receipt:{status:'full-source',policy:INTERIOR_POLICY,sourceSha256:asset.sha256,reason:error.message,limitations,interactiveInstallAllowed:false}};}
  const receipt={status:'full-source',policy:INTERIOR_POLICY,sourceSha256:asset.sha256,...proposal.counts,reason:proposal.reason,
    frameNumbers:frames.map(frame=>frame.frame),width,height,voxelSizeM,limitations,interactiveInstallAllowed:false};
  if(proposal.selected.length===parsed.count)return {receipt};
  const copyBytes=subsetSpz(parsed,proposal.selected),copySha256=hash(copyBytes);
  const key=hash(canonical({policy:INTERIOR_POLICY,module:hash(await fs.readFile(scriptPath)),asset,frames,width,height,runtimeDigest,execution,voxelSizeM}));
  const directory=path.join(cacheRoot,key),copyPath=path.join(directory,`${copySha256}.spz`);
  if(await availableDiskBytes(cacheRoot)<copyBytes.length+32*1024*1024)return {receipt:{...receipt,reason:'Insufficient free disk for an immutable proposal; all source records retained.'}};
  await fs.mkdir(directory,{recursive:true});
  try{if(hash(await fs.readFile(copyPath))!==copySha256)throw new Error('Immutable interior proposal changed.');}
  catch(error){if(error.code!=='ENOENT')throw error;await atomicWrite(copyPath,copyBytes);}
  return {path:copyPath,bytes:copyBytes,qualityPath:path.join(directory,'quality.json'),receipt:{...receipt,status:'candidate',key,copySha256,
    sourceBytes:bytes.length,copyBytes:copyBytes.length,copyPoints:proposal.selected.length}};
}

export async function main(argv) {
  const options={};
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if(flag==='--verify'){options.verify=true;continue;}
    if(!['--samples','--output','--voxel-size-m','--url','--width','--height','--device'].includes(flag)||options[flag.slice(2)]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))
      throw new Error('Usage: --samples FILE --output EMPTY_DIR [--voxel-size-m .1] [--verify --url http://127.0.0.1:8787 --width 1280 --height 720 --device auto]');
    options[flag.slice(2)]=argv[++i];
  }
  if(!options.samples||!options.output)throw new Error('--samples and --output are required.');
  const samples=path.resolve(options.samples),output=path.resolve(options.output),sampled=JSON.parse(await fs.readFile(samples,'utf8'));
  const asset=sampled.scene?.environment?.asset;
  if(sampled.scene?.environment?.kind!=='splat'||asset?.format!=='spz'||!/^[a-f0-9]{64}$/.test(asset.sha256)
    ||asset.path!==`assets/${asset.sha256}.spz`)throw new Error('An immutable SPZ scene and sampled inside-camera sweep are required.');
  const sourceRoot=await fs.realpath(path.dirname(samples)),source=await fs.realpath(path.resolve(path.dirname(samples),asset.path));
  if(!source.startsWith(`${sourceRoot}${path.sep}`))throw new Error('The immutable source must stay inside the samples directory.');
  const optionsForCopy={assetPath:path.resolve(path.dirname(samples),asset.path),asset,frames:sampled.frames,
    width:Number(options.width??sampled.scene.render.width),height:Number(options.height??sampled.scene.render.height),
    voxelSizeM:Number(options['voxel-size-m']??.1),cacheRoot:path.join(output,'proposal')};
  if(options.verify) {
    if(!options.url||!options.width||!options.height)throw new Error('Verification needs --url, --width and --height to state its exact scope.');
    const parsed=captureArgs(['--url',options.url,'--samples',samples,'--output',path.join(output,'plate'),
      '--asset-url',`/api/${asset.path}`,'--width',options.width,'--height',options.height,'--device',options.device??'auto']);
    const result=await capture({...parsed,prepareWorldCopy:context=>prepareInteriorCopy({...context,
      voxelSizeM:optionsForCopy.voxelSizeM,cacheRoot:optionsForCopy.cacheRoot})});
    process.stdout.write(`${JSON.stringify(result.profile.worldCopy)}\n`);
  } else {
    await fs.mkdir(output,{recursive:true});
    const prepared=await prepareInteriorCopy(optionsForCopy);
    const receipt={...prepared.receipt,canApply:false};
    const receiptPath=path.join(output,'interior-proposal.json'),receiptBytes=Buffer.from(`${JSON.stringify(receipt,null,2)}\n`);
    try{if(!(await fs.readFile(receiptPath)).equals(receiptBytes))throw new Error('Existing interior proposal differs; choose a new output directory.');}
    catch(error){if(error.code!=='ENOENT')throw error;await atomicWrite(receiptPath,receiptBytes);}
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===scriptPath)main(process.argv.slice(2)).catch(error=>{
  process.stderr.write(`Interior proposal failed: ${error.message}\n`);process.exitCode=1;
});
