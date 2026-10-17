/** Real UI relationship edits, world-surface placement, persistence and render. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin=process.env.PRODUCT_SUITE_URL||'http://127.0.0.1:8792';
const output=new URL('../../.cache/scene-objects-qa/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
function floorGlb(){
  const binary=Buffer.alloc(48);
  [-1,0,-1,-1,0,1,1,0,1,1,0,-1].forEach((value,index)=>binary.writeFloatLE(value,index*4));
  const indices=Buffer.from([0,0,1,0,2,0,0,0,2,0,3,0]);
  const document={asset:{version:'2.0',generator:'Original scene interaction QA floor'},scene:0,scenes:[{nodes:[0]}],
    nodes:[{name:'Original QA floor',mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:[.4,.4,.4,1],roughnessFactor:.8,metallicFactor:0}}],
    accessors:[{bufferView:0,componentType:5126,count:4,type:'VEC3',min:[-1,0,-1],max:[1,0,1]},
      {bufferView:1,componentType:5123,count:6,type:'SCALAR'}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:48,target:34962},{buffer:0,byteOffset:48,byteLength:12,target:34963}],buffers:[{byteLength:60}]};
  let json=Buffer.from(JSON.stringify(document));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(20);header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+60,8);header.writeUInt32LE(json.length,12);header.write('JSON',16);
  const binHeader=Buffer.alloc(8);binHeader.writeUInt32LE(60);binHeader.write('BIN\0',4);
  return Buffer.concat([header,json,binHeader,binary,indices]);
}
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const ready=()=>page.waitForFunction(()=>!document.querySelector('.glass-button')?.disabled,{},{timeout:30000});
const api=async(path,method='GET',data)=>{
  const response=await page.request.fetch(origin+path,{method,headers:{'X-Product-Suite':'1'},data});
  assert(response.ok(),`${path}: ${await response.text()}`);return response.json();
};
const edit=async(action)=>{
  const response=page.waitForResponse(response=>response.url()===origin+'/api/evaluate'&&response.request().method()==='POST');
  await action();const value=await (await response).json();assert(!value.error,JSON.stringify(value));await ready();return value;
};
try{
  const query=new URLSearchParams({name:'QA contact floor',owner:'3d-product-suite',reuseBasis:'Original test geometry',sourceUp:'Y'});
  const upload=await page.request.post(origin+'/api/worlds/import?'+query,{headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':'qa-floor.glb'},data:floorGlb()});
  assert.equal(upload.status(),201,await upload.text());const floorWorld=await upload.json();
  const fresh=await api('/api/projects','POST',{name:'Scene object browser verification'});
  fresh.scene.sceneId=`scene-object-qa-${fresh.id}`;
  await api(`/api/projects/${fresh.id}`,'PUT',{scene:fresh.scene,expectedRevisionId:fresh.revisionId});
  await page.goto(origin);await ready();
  await page.getByRole('tree',{name:'Scene object tree'}).waitFor();
  const initial=await api('/api/bootstrap');
  assert.equal(initial.project.scene.environment.plinth.visible,false);
  assert.equal(initial.project.scene.placement.restsOn,'floor');
  assert.equal(await page.locator('[data-tree-id="plinth:plinth"]').count(),0);
  let evaluated=await edit(()=>page.getByRole('button',{name:'＋ Cylinder',exact:true}).click());
  const supportId=evaluated.scene.environment.props[0].id;
  assert.equal(evaluated.scene.environment.props[0].relationship.targetId,'product');
  evaluated=await edit(()=>page.getByRole('button',{name:'Rest product on this object',exact:true}).click());
  assert.equal(evaluated.scene.placement.restsOn,supportId);
  assert.equal(evaluated.scene.environment.props[0].relationship,undefined);
  assert(Math.abs(evaluated.objects.product.boundsM[0][1]-evaluated.objects.props[supportId].boundsM[1][1])<1e-8);
  const originalSupportX=evaluated.objects.props[supportId].translationM[0];
  evaluated=await edit(()=>page.getByRole('group',{name:'Position',exact:true}).getByLabel('X (m)',{exact:true}).fill(String(originalSupportX+.03)));
  assert(Math.abs(evaluated.objects.product.translationM[0]-originalSupportX-.03)<1e-8);
  evaluated=await edit(()=>page.getByRole('button',{name:'＋ Box',exact:true}).click());
  const otherId=evaluated.scene.environment.props[1].id;
  evaluated=await edit(()=>page.getByLabel('Interaction',{exact:true}).selectOption('behind'));
  evaluated=await edit(()=>page.getByLabel('Gap (m)',{exact:true}).fill('.025'));
  assert(Math.abs(evaluated.objects.product.boundsM[0][2]-evaluated.objects.props[otherId].boundsM[1][2]-.025)<1e-8);
  await page.locator('[data-tree-id="product-root"]').click();
  evaluated=await edit(()=>page.getByLabel('Product rotation (°)',{exact:true}).fill('45'));
  assert.equal(evaluated.scene.placement.rotationYDegrees,45);
  assert(Math.abs(evaluated.objects.product.boundsM[0][2]-evaluated.objects.props[otherId].boundsM[1][2]-.025)<1e-8);
  evaluated=await edit(()=>page.getByRole('button',{name:'Frame product and objects',exact:true}).click());
  await page.getByRole('button',{name:'Save revision',exact:true}).click();
  await page.getByText('Revision saved',{exact:true}).waitFor();
  await page.reload();await ready();
  assert.equal(await page.locator(`[data-tree-id="prop:${supportId}"]`).count(),1);
  assert.equal(await page.locator(`[data-tree-id="prop:${otherId}"]`).count(),1);
  const reopened=(await api('/api/bootstrap')).project;
  assert.equal(reopened.scene.placement.restsOn,supportId);
  assert.equal(reopened.scene.environment.props[1].relationship.type,'behind');
  await page.getByRole('button',{name:'World',exact:true}).click();
  evaluated=await edit(()=>page.getByLabel('World revision',{exact:true}).selectOption(floorWorld.id));
  assert.equal(evaluated.scene.environment.plinth.visible,false);
  await page.getByRole('button',{name:'Scene',exact:true}).click();
  await page.locator('[data-tree-id="product-root"]').click();
  await page.getByRole('button',{name:'Pick a surface in the world',exact:true}).click();
  const canvas=page.locator('.comparison-pane').first().locator('canvas');
  const bounds=await canvas.boundingBox();assert(bounds);
  evaluated=await edit(()=>page.mouse.click(bounds.x+bounds.width*.5,bounds.y+bounds.height*.7));
  assert.equal(evaluated.scene.placement.restsOn,'world-surface');
  assert(Math.abs(evaluated.scene.placement.contactPointM[1])<1e-6);
  assert.deepEqual(evaluated.objects.supportOriginM,evaluated.scene.placement.contactPointM);
  assert(Math.abs(evaluated.objects.product.boundsM[0][1])<1e-6);
  await page.locator('.controls').evaluate(element=>{element.scrollTop=0});
  await page.screenshot({path:output+'scene-tree.png',fullPage:true});
  await page.getByRole('button',{name:'Save revision',exact:true}).click();await page.getByText('Revision saved',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Request Cycles still'}).click();
  const deadline=Date.now()+90000;let job;
  while(Date.now()<deadline){job=(await api('/api/jobs'))[0];if(['succeeded','failed','cancelled'].includes(job?.state))break;await page.waitForTimeout(500)}
  assert.equal(job?.state,'succeeded',JSON.stringify(job));
  assert(job.artifacts.some(artifact=>artifact.name==='still.png'));
  assert.deepEqual(errors,[]);assert.equal(await page.getByRole('alert').count(),0);
  console.log(JSON.stringify({checks:['no default rectangle','scene tree','support reparenting','dependent movement','behind clearance','yaw','camera framing','save/reopen','actual mesh surface pick','Cycles still'],jobId:job.id,screenshot:output+'scene-tree.png'}));
}catch(error){await page.screenshot({path:output+'failure.png',fullPage:true});console.error('Browser errors',errors,await page.getByRole('alert').allTextContents());throw error}
finally{await browser.close()}
