/** Real UI guard regression. Use VITE_STATIC_DEMO=1 and a small fixture bundle.
 * python scripts/build_static_demo.py --output /tmp/gesso-readonly-fixture
 * PRODUCT_SUITE_URL=http://127.0.0.1:5182 GESSO_DEMO_FIXTURE_DIR=/tmp/gesso-readonly-fixture node web/tests/readonly-demo-smoke.mjs
 * The fixture is routed only in this browser; the published campaign is untouched.
 */
import assert from 'node:assert/strict';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const origin=process.env.PRODUCT_SUITE_URL||'http://127.0.0.1:5182';
const fixture=process.env.GESSO_DEMO_FIXTURE_DIR;
assert(fixture,'Set GESSO_DEMO_FIXTURE_DIR to a separately built original fixture bundle.');
const output=process.env.GESSO_QA_OUTPUT||new URL('../../.cache/readonly-demo-qa/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL||'chrome'});
const page=await browser.newPage({viewport:{width:1440,height:1050},deviceScaleFactor:1,reducedMotion:'reduce'});
page.setDefaultTimeout(10000);
const errors=[],apiCalls=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))apiCalls.push(request.url());});
await page.route('**/demo/**',async route=>{
  const relative=decodeURIComponent(new URL(route.request().url()).pathname.split('/demo/')[1]);
  assert(relative&&!relative.split('/').includes('..'),'safe fixture path');
  const contentType=relative.endsWith('.json')?'application/json':relative.endsWith('.png')?'image/png':relative.endsWith('.glb')?'model/gltf-binary':'application/octet-stream';
  await route.fulfill({body:await readFile(path.join(fixture,relative)),contentType});
});
async function unchanged(){
  assert(await page.getByRole('button',{name:'Undo',exact:true}).isDisabled(),'no undo entry from a rejected edit');
  assert(await page.getByRole('button',{name:'Redo',exact:true}).isDisabled(),'no redo entry from a rejected edit');
  await page.locator('.gesso-save-status[data-state="saved"]').waitFor();
  const alerts=await page.getByRole('alert').allTextContents();
  assert(alerts.some(message=>/backend/i.test(message)),`visible backend explanation: ${alerts}`);
  assert(!alerts.some(message=>/Browser demo:|Changing.*needs|Choose one of|cannot evaluate|unsupported/i.test(message)),`no evaluation failure: ${alerts}`);
}
async function commitNumber(input,value){await input.fill(String(value));await input.press('Enter');}
try{
  await page.goto(origin+'/?step=product&layer=model');
  const name=page.getByRole('textbox',{name:'Object name',exact:true});
  await name.waitFor();
  await page.waitForFunction(()=>!document.querySelector('.gesso-render-still')?.disabled&&document.querySelector('.gesso-save-status[data-state="saved"]'));
  assert.deepEqual(await page.getByRole('alert').allTextContents(),[]);
  const original=await name.inputValue();
  await name.fill('Rejected renamed part');await name.press('Enter');await unchanged();
  assert.equal(await name.inputValue(),original);checks.push('rename restores original value');
  const rows=page.locator('[aria-label="Objects"] .gesso-part-select');
  const rowNames=await rows.allTextContents();
  await page.getByRole('button',{name:'Part options: '+original,exact:true}).click();
  await page.getByRole('menuitem',{name:/^Remove /}).click();
  const confirm=page.getByRole('alertdialog');
  if(await confirm.count())await confirm.getByRole('button',{name:/Remove/}).click();
  await unchanged();assert.deepEqual(await rows.allTextContents(),rowNames);assert.equal(await name.inputValue(),original);
  checks.push('remove retains parts and selection');
  const visibleEye=page.locator('[aria-label="Objects"] .gesso-visibility').first();
  const eyeState=await visibleEye.getAttribute('aria-pressed');await visibleEye.click();
  assert.notEqual(await visibleEye.getAttribute('aria-pressed'),eyeState);await visibleEye.click();
  checks.push('visibility inspection still works');

  await page.getByRole('button',{name:'Materials',exact:true}).click();
  const materialRows=page.locator('[data-material-id]');await materialRows.first().waitFor();
  await materialRows.first().locator('.gesso-material-swatch').click();
  const roughness=page.getByRole('spinbutton',{name:'Roughness',exact:true});await roughness.waitFor();
  const oldRoughness=await roughness.inputValue();await commitNumber(roughness,oldRoughness==='17'?23:17);await unchanged();
  assert.equal(await roughness.inputValue(),oldRoughness);
  assert.equal(await page.locator('.gesso-viewport-preview-label').count(),0);
  await page.getByRole('button',{name:'Cube sample',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Cube sample',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Save',exact:true}).click();await unchanged();
  assert(!await page.getByText('Updated for this session',{exact:true}).count());
  checks.push('material edits and save refused; sample inspection works');

  await page.getByRole('button',{name:'Stage',exact:true}).click();
  await page.getByRole('button',{name:'Environment',exact:true}).click();
  const worldCards=page.getByRole('group',{name:'World library'}).getByRole('button');
  await worldCards.first().waitFor();
  const selectedWorld=await page.locator('[data-world-id][aria-pressed="true"]').getAttribute('data-world-id');
  await page.locator('[data-world-id][aria-pressed="false"]').first().click();await unchanged();
  assert.equal(await page.locator('[data-world-id][aria-pressed="true"]').getAttribute('data-world-id'),selectedWorld);
  checks.push('world choice retains current world');

  await page.getByRole('button',{name:'Film',exact:true}).click();
  const play=page.getByRole('button',{name:'Play film',exact:true});await play.waitFor();
  assert(!await play.isDisabled());
  const duration=page.getByRole('spinbutton',{name:'Movie duration in seconds',exact:true});
  const oldDuration=await duration.inputValue();await commitNumber(duration,Number(oldDuration)+3);await unchanged();
  assert.equal(await duration.inputValue(),oldDuration);checks.push('duration rejected without invalidating playback');
  const aspect=page.getByRole('combobox',{name:'Camera aspect ratio',exact:true});
  if(await aspect.isVisible()){
    const oldAspect=await aspect.inputValue();const choice=await aspect.locator('option').evaluateAll((elements,value)=>elements.find(element=>element.value!==value&&element.value!=='custom')?.value,oldAspect);
    await aspect.selectOption(choice);await unchanged();assert.equal(await aspect.inputValue(),oldAspect);checks.push('camera aspect unchanged');
  }
  await page.getByRole('button',{name:'New scene',exact:true}).click();await unchanged();
  assert.equal(await page.locator('.frame-setup-stages').count(),0);assert.equal(await duration.inputValue(),oldDuration);
  checks.push('new scene never enters a partial setup');
  await page.locator('.film-parts-disclosure:not(.film-lights-disclosure)>summary').click();
  await page.locator('.film-parts-list .film-object-name').first().click();
  const transform=page.locator('.gesso-transform-shortcuts');await transform.waitFor();
  for(const key of ['g','r','s']){await transform.focus();await page.keyboard.press(key);await unchanged();assert.equal(await page.locator('.gesso-transform-shortcuts.is-active').count(),0);}
  checks.push('G / R / S refuse before starting a viewport transform');
  const playhead=page.getByRole('slider',{name:'Film playhead',exact:true});const startFrame=await playhead.inputValue();
  await play.click();await page.getByRole('button',{name:'Pause film',exact:true}).waitFor();
  await page.waitForFunction(start=>document.querySelector('.film-shot-seek')?.value!==start,startFrame);
  await page.getByRole('button',{name:'Pause film',exact:true}).click();
  assert(!await play.isDisabled());checks.push('playback works after repeated refusals');

  await page.getByRole('button',{name:'Random setup',exact:true}).click();
  await page.getByRole('button',{name:'Generate setup',exact:true}).click();await unchanged();
  assert.equal(await page.getByRole('region',{name:'Preview changes',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Reroll setup',exact:true}).count(),0);
  checks.push('random generation leaves original scene');
  await page.getByRole('button',{name:'Product',exact:true}).click();
  await page.getByRole('button',{name:'Model',exact:true}).click();
  await rows.filter({hasText:original}).click();
  assert.equal(await name.inputValue(),original);assert.deepEqual(await rows.allTextContents(),rowNames);
  await unchanged();assert.deepEqual(errors,[]);assert.deepEqual(apiCalls,[],'no backend requests from static demo');
  await page.screenshot({path:path.join(output,'readonly-demo.png')});
  console.log(JSON.stringify({checks,pageErrors:errors,apiCalls,output},null,2));
}catch(error){await page.screenshot({path:path.join(output,'failure.png')});console.error('UI alerts:',await page.getByRole('alert').allTextContents());throw error;}
finally{await browser.close();}
