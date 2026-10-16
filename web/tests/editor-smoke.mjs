/** Real browser smoke check. Requires a running local server and pinned Chromium. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const origin = process.env.PRODUCT_SUITE_URL || 'http://127.0.0.1:8789';
const output = new URL('../../.cache/editor-qa/', import.meta.url).pathname;
await mkdir(output, {recursive:true});
const browser = await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const page = await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1});
const errors=[];
page.on('pageerror', error=>errors.push(error.message));
const request=async(path,method='GET',data)=>{
 const response=await page.request.fetch(origin+path,{method,headers:{'X-Product-Suite':'1'},data});
 assert(response.ok(), `${path}: ${await response.text()}`);return response.json();
};
try {
 const bootstrap=await request('/api/bootstrap');
 await request('/api/projects','POST',{name:'Browser verification',scene:bootstrap.project.scene});
 await page.goto(origin);
 await page.evaluate(()=>document.fonts.ready);
 await page.getByRole('button',{name:'Request Cycles still'}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('.glass-button')?.disabled);
 assert.equal(await page.getByLabel('Frame',{exact:true}).inputValue(),'1');
 assert.equal(await page.getByLabel('Play preview').count(),1);
 const label=page.getByLabel('Label name',{exact:true});
 const original=await label.inputValue();
 const testLabel=original==='MORA QA'?'MORA QA 2':'MORA QA';
 await label.fill(testLabel);
 await page.waitForTimeout(300);

 await page.getByLabel('Undo',{exact:true}).click();
 assert.equal(await label.inputValue(),original);
 await page.getByLabel('Redo',{exact:true}).click();
 assert.equal(await label.inputValue(),testLabel);
 await page.getByRole('button',{name:'Save revision',exact:true}).click();
 await page.getByText('Revision saved',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Approve saved revision'}).click();
 await page.getByText('Approved revision preserved',{exact:true}).waitFor();
 await label.fill('EXPERIMENT');
 await page.getByRole('button',{name:'Restore approved scene'}).click();
 await page.getByText('Approved scene restored as an editable draft',{exact:true}).waitFor();
 assert.equal(await label.inputValue(),testLabel);
 await page.getByLabel('Frame',{exact:true}).fill('180');
 assert.equal(await page.getByLabel('Frame',{exact:true}).inputValue(),'180');
 await page.getByRole('button',{name:'World',exact:true}).click();
 const select=page.getByLabel('World revision',{exact:true});
 const options=await select.locator('option').allTextContents();
 assert(options.some(x=>x.includes('Default · Gallery')));
 assert(options.some(x=>x.includes('Default · Botanical')));
 await select.selectOption({label:options.find(x=>x.includes('Default · Gallery'))});
 await page.getByText('Original default environment. No image or API key required.',{exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('.glass-button')?.disabled);
 await page.waitForTimeout(700);
 await page.screenshot({path:output+'editor-gallery.png',fullPage:true});
 assert.equal(await page.getByLabel('Reference image URL (optional)',{exact:true}).count(),1);
 await page.getByRole('button',{name:'Request Cycles still'}).click();
 const deadline=Date.now()+90000;
 let job;
 while(Date.now()<deadline){
  job=(await request('/api/jobs'))[0];
  if(['succeeded','failed','cancelled'].includes(job?.state))break;
  await page.waitForTimeout(500);
 }
 assert.equal(job?.state,'succeeded',JSON.stringify(job));
 assert(job.artifacts.some(a=>a.name==='still.png'));
 await page.getByRole('button',{name:'World',exact:true}).click();
 await select.selectOption({label:options.find(x=>x.includes('Fixture room · Gaussian'))});
 await page.waitForFunction(()=>!document.querySelector('.glass-button')?.disabled);
 await page.waitForTimeout(1200);
 await page.screenshot({path:output+'editor-gaussians.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(700);
 await page.screenshot({path:output+'editor-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile overflow');
 assert.deepEqual(errors,[]);
 assert.equal(await page.getByRole('alert').count(),0);
 console.log(JSON.stringify({checks:['paused start','undo/redo','save/approve/restore','scrubbing','offline defaults','reference image controls','Cycles still','native Gaussian preview','mobile layout'],jobId:job.id,screenshots:output}));
} catch(error) {await page.screenshot({path:output+'failure.png',fullPage:true});console.error('Browser errors',errors,await page.getByRole('alert').allTextContents());throw error} finally {await browser.close()}
