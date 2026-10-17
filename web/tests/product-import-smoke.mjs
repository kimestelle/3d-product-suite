/** Real file -> Blender normalization -> editor preview -> reopen -> Cycles still. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.PRODUCT_SUITE_URL || 'http://127.0.0.1:8791';
const output = new URL('../../.cache/mesh-import-qa/', import.meta.url).pathname;
await mkdir(output, {recursive:true});
const source = Buffer.from([
  '# Original off-center millimeter cube, Z up',
  'v 1000 2000 3000', 'v 1060 2000 3000', 'v 1060 2040 3000', 'v 1000 2040 3000',
  'v 1000 2000 3120', 'v 1060 2000 3120', 'v 1060 2040 3120', 'v 1000 2040 3120',
  'f 1 4 3 2', 'f 5 6 7 8', 'f 1 2 6 5', 'f 2 3 7 6', 'f 3 4 8 7', 'f 4 1 5 8', '',
].join('\n'));
const browser = await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page = await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
const errors=[];
page.on('pageerror', error=>errors.push(error.message));
const request = async path => {
  const response = await page.request.get(origin+path);
  assert(response.ok(), `${path}: ${await response.text()}`);
  return response.json();
};
try {
  await page.goto(origin);
  await page.waitForFunction(()=>!document.querySelector('.glass-button')?.disabled);
  await page.getByRole('button',{name:'Import a product mesh'}).click();
  await page.getByLabel('Product name',{exact:true}).fill('Original mesh browser trial');
  await page.getByLabel('Product owner',{exact:true}).fill('3d-product-suite');
  await page.getByLabel('Source URL or reference',{exact:true}).fill('Original browser integration cube');
  await page.getByLabel('Usage permission or license',{exact:true}).fill('Original test geometry');
  const picker=page.getByLabel('Product mesh file',{exact:true});
  await picker.setInputFiles({name:'native.step',mimeType:'application/octet-stream',buffer:Buffer.from('not a mesh export')});
  await page.getByRole('alert').filter({hasText:'Export native STEP / IGES'}).waitFor();
  assert(await page.getByRole('button',{name:'Import product',exact:true}).isDisabled());
  await picker.setInputFiles({name:'original-cube.obj',mimeType:'text/plain',buffer:source});
  assert(await page.getByRole('button',{name:'Import product',exact:true}).isDisabled());
  await page.getByLabel('Source units',{exact:true}).selectOption('mm');
  await page.getByLabel('Source up axis',{exact:true}).selectOption('Z');
  const uploaded=page.waitForResponse(response=>response.url().includes('/api/products/import?')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Import product',exact:true}).click();
  const response=await uploaded;
  const project=await response.json();
  assert.equal(response.status(),201,JSON.stringify(project));
  const product=project.scene.product;
  for(const [index,value]of [.06,.12,.04].entries())assert(Math.abs(product.dimensionsM[index]-value)<1e-6);
  assert.equal(product.metadata.meshImport.sourceSha256,createHash('sha256').update(source).digest('hex'));
  assert.equal(product.metadata.meshImport.sourceFormat,'obj');
  assert.equal(product.metadata.meshImport.sourceUp,'Z');
  assert.equal(product.metadata.meshImport.units,'mm');
  assert.deepEqual(project.scene.actions,[]);
  await page.waitForFunction(()=>!document.querySelector('.glass-button')?.disabled);
  await page.getByText('60 mm × 120 mm × 40 mm',{exact:true}).waitFor();
  const asset=product.components[0].asset;
  const assetResponse=await page.request.get(origin+'/api/'+asset.path);
  assert(assetResponse.ok());
  assert.equal(createHash('sha256').update(await assetResponse.body()).digest('hex'),asset.sha256);
  await page.reload();
  await page.waitForFunction(()=>!document.querySelector('.glass-button')?.disabled);
  await page.getByText('60 mm × 120 mm × 40 mm',{exact:true}).waitFor();
  assert.deepEqual((await request(`/api/projects/${project.id}`)).scene.product,product);
  await page.screenshot({path:output+'imported-product.png',fullPage:true});
  await page.getByRole('button',{name:'Request Cycles still'}).click();
  const deadline=Date.now()+90000;
  let job;
  while(Date.now()<deadline){
    job=(await request('/api/jobs'))[0];
    if(['succeeded','failed','cancelled'].includes(job?.state))break;
    await page.waitForTimeout(500);
  }
  assert.equal(job?.state,'succeeded',JSON.stringify(job));
  assert(job.artifacts.some(artifact=>artifact.name==='still.png'));
  assert.equal(await page.getByRole('alert').count(),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks:['unsupported CAD guidance','explicit units/up','actual OBJ conversion','measured scale','pinned GLB integrity','preview','reopen','Cycles still'],projectId:project.id,jobId:job.id,screenshot:output+'imported-product.png'}));
} catch(error) {
  await page.screenshot({path:output+'failure.png',fullPage:true});
  console.error('Browser errors',errors,await page.getByRole('alert').allTextContents());
  throw error;
} finally {await browser.close()}
