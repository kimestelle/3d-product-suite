/** Measure the actual production renderer with native pointer input in Chrome.
 * PRODUCT_SUITE_URL selects a staged build; no scene edits or API writes occur.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';

const origin=process.env.PRODUCT_SUITE_URL||'http://127.0.0.1:4177';
const output=process.env.GESSO_PERFORMANCE_OUTPUT||'/private/tmp/gesso-preview-performance';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL||'chrome'});
try {
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
  await context.addInitScript(()=>{
    const contexts=new Set(),draws=new Map();
    const getContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(...args){
      const result=getContext.apply(this,args);
      if(result&&(args[0]==='webgl2'||args[0]==='webgl'))contexts.add(result);
      return result;
    };
    for(const prototype of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype])
      for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
        if(!Object.hasOwn(prototype,name))continue;
        const original=prototype[name];
        prototype[name]=function(...args){draws.set(this,(draws.get(this)||0)+1);return original.apply(this,args);};
      }
    window.__gessoPreviewPerf={read:()=>({contexts:contexts.size,
      mainDraws:[...draws].filter(([gl])=>gl.canvas.closest('.viewport')).reduce((sum,[,count])=>sum+count,0),
      otherDraws:[...draws].filter(([gl])=>!gl.canvas.closest('.viewport')).reduce((sum,[,count])=>sum+count,0)})};
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const cdp=await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  let transferredBytes=0;
  cdp.on('Network.loadingFinished',event=>{transferredBytes+=event.encodedDataLength;});
  const taskSeconds=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value])).TaskDuration;
  const read=()=>page.evaluate(()=>window.__gessoPreviewPerf.read());
  const delta=(before,after)=>Object.fromEntries(Object.keys(before).map(key=>[key,after[key]-before[key]]));
  const began=Date.now(),initialTasks=await taskSeconds();
  await page.goto(origin+'/?step=world&layer=lights');
  await page.waitForFunction(()=>document.querySelector('.comparison-stage')?.getAttribute('aria-busy')==='false'
    &&document.querySelector('.gesso-studio')&&window.__gessoPreviewPerf.read().mainDraws>0,{},{timeout:90000});
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(900);
  const cold={milliseconds:Date.now()-began,taskMilliseconds:(await taskSeconds()-initialTasks)*1000,transferredBytes,...await read()};
  const canvas=page.locator('.viewport canvas').first();
  const initialImage=await canvas.screenshot();
  await writeFile(path.join(output,'initial.png'),initialImage);
  const idleBefore=await read(),idleTasks=await taskSeconds();
  await page.waitForTimeout(1000);
  const idle={...delta(idleBefore,await read()),taskMilliseconds:(await taskSeconds()-idleTasks)*1000};
  const box=await canvas.boundingBox();assert(box);
  const orbitBefore=await read(),orbitTasks=await taskSeconds(),orbitBegan=Date.now();
  await page.mouse.move(box.x+box.width*.52,box.y+box.height*.53);
  await page.mouse.down();
  for(let step=1;step<=30;step++)await page.mouse.move(box.x+box.width*.52+step*3,box.y+box.height*.53+step*.7);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const orbit={...delta(orbitBefore,await read()),taskMilliseconds:(await taskSeconds()-orbitTasks)*1000,milliseconds:Date.now()-orbitBegan};
  const finalImage=await canvas.screenshot();await writeFile(path.join(output,'orbit.png'),finalImage);
  await page.getByRole('link',{name:'gesso home',exact:true}).first().click();
  await page.locator('.dynamic-frame-shell[data-page="landing"][data-navigation="settled"]').waitFor();
  await page.waitForTimeout(500);
  const hiddenBefore=await read();await page.waitForTimeout(1000);
  const hidden=delta(hiddenBefore,await read());
  assert.equal(idle.mainDraws,0,'a settled studio must not redraw continuously');
  assert.equal(hidden.mainDraws,0,'the retained hidden studio must stop drawing');
  assert.deepEqual(errors,[]);
  const result={origin,cold,idle,orbit,hidden,initialPngSha256:createHash('sha256').update(initialImage).digest('hex'),
    orbitPngSha256:createHash('sha256').update(finalImage).digest('hex')};
  await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {await browser.close();}
