/** Exercise the actual homepage using native scroll, including media recovery. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const base=process.env.PRODUCT_SUITE_URL||'http://127.0.0.1:5173';
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL||'chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[];
const labels=['Blue studio','Velvet curtain','Concrete atrium','Blue dial','Green dial','The Film workspace'];
const settle=(page,route='landing')=>page.locator(`.dynamic-frame-shell[data-page="${route}"][data-navigation=settled]`).waitFor();
const card=(page,index)=>page.locator(`[data-story-card="${index}"]`);
const video=page=>page.locator('[data-story-card="5"] video');
const nextPaint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
// Native keyboard/wheel scrolling can continue after the first visible step.
// Let that user gesture finish before issuing a deterministic capture offset.
const scrollSettled=page=>page.evaluate(()=>new Promise(resolve=>{
  const host=document.querySelector('main.public-landing');let previous=host.scrollTop,stable=0;
  function frame(){const current=host.scrollTop;stable=Math.abs(current-previous)<.1?stable+1:0;previous=current;if(stable>=4)resolve();else requestAnimationFrame(frame);}requestAnimationFrame(frame);
}));
const held=async(page,index)=>{
  await page.waitForFunction(index=>document.querySelector('.public-landing').dataset.storyIndex===String(index),index);
  await nextPaint(page);
};
async function scrollTo(page,progress,index) {
  await page.locator('main.public-landing').evaluate((host,progress)=>host.scrollTo({top:Math.max(320,host.clientHeight*.68)*progress,behavior:'instant'}),progress);
  await held(page,index);
}
async function open(context,hash='') {
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/landing'+hash);await settle(page);await page.evaluate(()=>document.fonts.ready);
  return page;
}
async function readyImage(page,index) {
  const img=card(page,index).locator(index<3?'.landing-projection-photo':'.landing-finish-proof__stage img[aria-hidden="false"]');
  await img.evaluate(image=>image.decode());
  return img;
}
async function pose(page) {
  return page.evaluate(()=>{
    const root=document.querySelector('.public-landing'),panel=root.querySelector('[data-active=true]');
    const source=panel.querySelector('[data-landing-frame]');
    const image=panel.querySelector('.landing-projection-photo, .landing-finish-proof__stage img[aria-hidden="false"]');
    const projection=panel.querySelector('.landing-projection'),origin=panel.querySelector('[data-projection-origin]');
    const gap=panel.querySelector('.landing-projection-throw mask circle');
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    return {index:Number(root.dataset.storyIndex),scroll:root.scrollTop,opening:parseFloat(root.style.getPropertyValue('--story-opening')),
      phase:root.dataset.storyPhase,reach:projection?Number(projection.dataset.projectionReach):null,
      transform:getComputedStyle(source).transform,clip:getComputedStyle(source).clipPath,source:rect(source),image:image?rect(image):null,
      origin:origin?rect(origin):null,gap:gap?['cx','cy','r'].map(name=>gap.getAttribute(name)):null,
      closed:source.dataset.projectionClosed??null,visibility:getComputedStyle(source).visibility,
      sourceCard:source.closest('[data-story-card]').dataset.storyCard,subjectCard:root.querySelector('[data-frame-subject]')?.closest('[data-story-card]').dataset.storyCard,
      routePath:document.querySelector('.dynamic-frame-artwork defs path').getAttribute('d')};
  });
}
async function frameMatches(page) {
  await page.waitForFunction(()=>{
    const root=document.querySelector('.public-landing'),source=root.querySelector('[data-active=true] [data-landing-frame]');
    if(!source?.hasAttribute('data-frame-subject'))return false;
    const r=source.getBoundingClientRect();
    // CSS clipping does not change layout bounds. The shared route frame must
    // follow the visible aperture, including a closed Finish/Film window.
    const clip=getComputedStyle(source).clipPath;
    const inset=clip.startsWith('inset(')?parseFloat(clip.slice(6))/100:0;
    const expected={x:r.left+r.width*inset,y:r.top+r.height*inset,width:r.width*(1-2*inset),height:r.height*(1-2*inset)};
    const actual=document.querySelector('.dynamic-frame-artwork defs path').getBBox();
    return Math.max(Math.abs(actual.x-expected.x),Math.abs(actual.y-expected.y),Math.abs(actual.width-expected.width),Math.abs(actual.height-expected.height))<.25;
  });
}
async function plays(page) {
  await page.waitForFunction(()=>{const v=document.querySelector('[data-story-card="5"] video');return v.controls&&v.muted&&!v.paused&&v.currentTime>0;});
}
function sameRect(actual,expected,label) {
  for(const key of ['x','y','width','height'])assert(Math.abs(actual[key]-expected[key])<.15,label+' '+key);
}
try {
  for(const [width,height] of [[1440,900],[760,850],[390,844],[320,700]]){
    const context=await browser.newContext({viewport:{width,height},reducedMotion:'no-preference'});
    const page=await open(context);
    const root=page.locator('main.public-landing');
    assert.equal(await root.locator('[data-story-card]').count(),6);
    assert.equal(await root.locator('[role=tab],input[type=radio]').count(),0,'story does not require tabs or radio choices');
    assert.equal(await root.evaluate(e=>['auto','scroll'].includes(getComputedStyle(e).overflowY)),true,'main is a native scrollport');
    const step=await root.evaluate(e=>Math.max(320,e.clientHeight*.68));
    assert(await root.evaluate(e=>e.scrollHeight>e.clientHeight*4),'native document has room for six held cards');
    if(width===1440){
      await page.mouse.move(width*.6,height*.6);await page.mouse.wheel(0,step);await held(page,1);await scrollSettled(page);
      assert.equal(await page.evaluate(()=>window.scrollY),0,'wheel advances the main scrollport, not the browser page');
      await scrollTo(page,0,0);await root.focus();await page.keyboard.press('PageDown');
      await page.waitForFunction(()=>document.querySelector('.public-landing').scrollTop>100);
      await scrollSettled(page);
      await scrollTo(page,0,0);
    }
    const worldBounds=[],finishBounds=[],sources=new Set();
    for(let index=0;index<6;index++){
      await scrollTo(page,index+.1,index);await frameMatches(page);
      assert.equal(await root.locator('[data-active=true]').count(),1,'one scene is active');
      assert.equal(await card(page,index).getAttribute('aria-label'),labels[index]);
      assert.equal(await card(page,index).getAttribute('aria-hidden'),'false',`${width}px card ${index} is accessible at its held offset`);
      assert.equal(await card(page,index).evaluate(e=>e.inert),false);
      assert.equal(await root.evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,width+'px has no horizontal overflow');
      const current=await pose(page);
      assert(current.opening>.999,'each source has a readable held pose');
      const visual=await card(page,index).locator('[data-landing-frame]').boundingBox();
      assert(visual.width>90&&visual.height>90,'the native picture has usable area');
      assert(visual.x>=-.2&&visual.x+visual.width<=width+.2&&visual.y>=-.2&&visual.y+visual.height<=height+.2,'active picture fits the viewport');
      if(index<3){
        const img=await readyImage(page,index);sources.add(await img.getAttribute('src'));
        assert.deepEqual(await img.evaluate(e=>[e.naturalWidth,e.naturalHeight]),[960,960]);
        assert(Math.abs(visual.width-visual.height)<.1,'world aperture remains square');
        worldBounds.push(await img.boundingBox());
        if(index) sameRect(worldBounds[index],worldBounds[0],'world plate remains registered');
      } else if(index<5){
        const img=await readyImage(page,index);sources.add(await img.getAttribute('src'));
        assert.deepEqual(await img.evaluate(e=>[e.naturalWidth,e.naturalHeight]),[1120,840],'uses native Auden finish plates');
        assert(Math.abs(visual.width/visual.height-4/3)<.001,'finish uses native 4:3 window');
        finishBounds.push(await img.boundingBox());
        if(index===4)sameRect(finishBounds[1],finishBounds[0],'finish edit leaves case/crown registered');
      } else {
        await plays(page);
        const shown=await card(page,index).locator('[data-film-window]').boundingBox();
        assert(Math.abs(shown.width/shown.height-16/9)<.001,'Film automatically opens to its full native frame');
        assert.equal(await video(page).evaluate(v=>v.playsInline),true);
      }
      if((width===1440&&[0,3,5].includes(index))||(width<900&&index===0))await page.screenshot({path:`/private/tmp/gesso-scroll-${width}-card-${index}.jpg`,type:'jpeg',quality:84});
    }
    assert.equal(sources.size,5,'scroll reveals five distinct real plates without choosing controls');
    await scrollTo(page,4.1,4);
    assert(await video(page).evaluate(v=>v.paused),'retracting away from Film pauses it');
    const stopped=await video(page).evaluate(v=>v.currentTime);
    await nextPaint(page);assert(Math.abs(await video(page).evaluate(v=>v.currentTime)-stopped)<.05,'inactive film playhead stays still');

    // Pass moves only the native field boundary. The photo, product origin and
    // circular clearance remain registered through close, exchange and reopen.
    await scrollTo(page,.1,0);const heldWorld=await pose(page);
    await scrollTo(page,.42,0);await frameMatches(page);
    const forward=await pose(page);
    assert.equal(forward.phase,'closing');
    assert(forward.opening>.1&&forward.opening<.8,'the field retracts partway');
    assert.equal(forward.transform,'none','the image aperture has no card transform');
    assert(forward.source.width<heldWorld.source.width*.8,'the native field aperture contracts');
    assert(Math.abs(forward.source.width-forward.source.height)<.1,'the contracting field stays square');
    sameRect(forward.image,heldWorld.image,'the photo stays fixed while the boundary retracts');
    sameRect(forward.origin,heldWorld.origin,'the product origin stays fixed while closing');
    assert.deepEqual(forward.gap,heldWorld.gap,'circular clearance never contracts with the field');
    assert(Math.abs(forward.reach-forward.opening)<.0002,'projection extent follows the shared Pass pose');
    await scrollTo(page,.468,0);await frameMatches(page);const before=await pose(page);
    await scrollTo(page,.484,1);await frameMatches(page);const after=await pose(page);
    for(const compact of [before,after]){
      assert.equal(compact.phase,'closed');assert.equal(compact.opening,0,'scene ownership changes only during the closed hold');
      assert.equal(compact.closed,'true','the image face records its closed state');
      assert.equal(compact.visibility,'hidden','no outgoing or incoming photo fragment remains at compact');
      assert.equal(compact.transform,'none');
      assert(Math.abs(compact.source.width-compact.source.height)<.1,'compact uses the native square');
      sameRect(compact.image,heldWorld.image,'the compact photo retains its original coordinates');
      sameRect(compact.origin,heldWorld.origin,'origin stays registered across the handoff');
      assert.deepEqual(compact.gap,heldWorld.gap,'empty circular clearance survives ownership exchange');
    }
    sameRect(after.source,before.source,'both worlds share the same compact boundary');
    await scrollTo(page,.62,1);await frameMatches(page);const reopening=await pose(page);
    assert.equal(reopening.phase,'opening');
    assert(reopening.opening>0&&reopening.opening<1,'the next world reopens from compact');
    sameRect(reopening.image,heldWorld.image,'incoming photo stays registered while opening');
    sameRect(reopening.origin,heldWorld.origin,'product stays fixed while reopening');
    assert.deepEqual(reopening.gap,heldWorld.gap);
    await scrollTo(page,1.1,1);await scrollTo(page,.42,0);await frameMatches(page);
    assert.deepEqual(await pose(page),forward,'reverse scroll reproduces the exact registered Pass pose');
    // Finish uses the real 4:3 window: its mask closes, its image never scales.
    await scrollTo(page,3.1,3);const heldFinish=await pose(page);
    await scrollTo(page,3.42,3);await frameMatches(page);const closingFinish=await pose(page);
    assert.equal(closingFinish.transform,'none');
    assert(closingFinish.clip.startsWith('inset('),'Finish moves a clipping boundary');
    sameRect(closingFinish.source,heldFinish.source,'Finish keeps its layout registration');
    sameRect(closingFinish.image,heldFinish.image,'Finish does not move or scale the watch');
    await scrollTo(page,3.468,3);await frameMatches(page);const finishBefore=await pose(page);
    await scrollTo(page,3.484,4);await frameMatches(page);const finishAfter=await pose(page);
    assert.equal(finishBefore.opening,0);assert.equal(finishAfter.opening,0);
    sameRect(finishAfter.image,heldFinish.image,'the next finish uses the same fixed watch coordinates');
    await scrollTo(page,.42,0);await frameMatches(page);
    if(width===1440){
      await page.screenshot({path:'/private/tmp/gesso-scroll-mid-pass.jpg',type:'jpeg',quality:86});
      const outgoing=forward.routePath;
      await page.getByRole('link',{name:'About',exact:true}).click();
      await page.waitForFunction(path=>document.querySelector('.dynamic-frame-shell').dataset.navigation==='moving'&&document.querySelector('.dynamic-frame-artwork defs path').getAttribute('d')!==path,outgoing);
      await settle(page,'about');await page.goBack();await settle(page);await held(page,0);
      assert.equal(await root.evaluate(e=>e.scrollTop),0,'Back follows the public page reading-start policy');
      await scrollTo(page,.42,0);await frameMatches(page);
      assert.deepEqual(await pose(page),forward,'the same native scroll pose remains recoverable after route navigation');
    }
    await context.close();console.log(width+'px: six scroll-only states, registered held plates, registered Pass transitions and paused inactive Film');
  }

  for(const mode of ['reduced','saveData']){
    const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:mode==='reduced'?'reduce':'no-preference'});
    if(mode==='saveData')await context.addInitScript(()=>Object.defineProperty(navigator,'connection',{value:Object.assign(new EventTarget(),{saveData:true})}));
    const mediaRequests=[];context.on('request',request=>{if(request.url().includes('gesso-studio-editor.mp4'))mediaRequests.push(request.url());});
    const page=await open(context);
    for(let index=0;index<6;index++){
      await scrollTo(page,index+.1,index);await frameMatches(page);
      const current=await pose(page);
      assert.equal(await page.locator('.public-landing').getAttribute('data-story-quiet'),'true');
      assert.equal(current.opening,1,mode+' retains the complete image');
      assert.equal(current.transform,'none',mode+' preserves untransformed media');
      if(index<5)await readyImage(page,index);
    }
    await page.waitForTimeout(200);
    assert(await video(page).evaluate(v=>v.paused),'quiet Film remains paused');
    assert.equal(mediaRequests.length,0,mode+' does not fetch autoplay media');
    const stage=await page.locator('.public-film-stage').boundingBox(),window=await page.locator('[data-film-window]').boundingBox();
    assert(Math.abs(window.width/window.height-16/9)<.001,'quiet Film keeps its full native poster');
    const playButton=page.getByRole('button',{name:'Watch the studio film',exact:true});
    const control=await playButton.boundingBox();assert(control.y>=stage.y+stage.height-.2,'quiet play control does not cover the editor');
    await scrollTo(page,.42,0);assert.equal((await pose(page)).opening,1,'quiet mode stays open at transition offsets');
    await context.close();console.log(mode+': all six views, complete stationary plates, no autoplay fetch');
  }

  const shortContext=await browser.newContext({viewport:{width:320,height:500}});
  const shortPage=await open(shortContext);
  const shortRoot=shortPage.locator('main.public-landing');
  assert.equal(await shortRoot.getAttribute('data-story-quiet'),'true','short portrait uses the ordinary reading flow');
  for(let index=0;index<6;index++){
    await card(shortPage,index).evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));
    await held(shortPage,index);
    assert(await shortRoot.locator('[data-story-card]').evaluateAll(panels=>panels.every(panel=>!panel.inert&&panel.getAttribute('aria-hidden')==='false')),'all six flow sections remain available to keyboard and assistive technology');
    assert.equal(await card(shortPage,index).evaluate(e=>getComputedStyle(e).position),'relative','short portrait sections occupy normal document flow');
    assert.equal((await pose(shortPage)).transform,'none','short portrait preserves untransformed reading content');
    if(index<5)await readyImage(shortPage,index);
    assert(await shortRoot.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'short portrait has no horizontal overflow');
  }
  await shortContext.close();console.log('320×500: all six ordinary-flow sections remain readable and accessible');

  const recoveryContext=await browser.newContext({viewport:{width:1440,height:900}});
  const recovery=await open(recoveryContext),recoveryRoot=recovery.locator('main.public-landing');
  await scrollTo(recovery,2.42,2);
  const progress=await recoveryRoot.evaluate(e=>e.scrollTop/Math.max(320,e.clientHeight*.68));
  await recovery.setViewportSize({width:1440,height:760});
  await recovery.waitForFunction(()=>document.querySelector('.public-landing').style.getPropertyValue('--story-height')==='760px');
  await held(recovery,2);await frameMatches(recovery);
  const resized=await recoveryRoot.evaluate(e=>e.scrollTop/Math.max(320,e.clientHeight*.68));
  assert(Math.abs(resized-progress)<.002,'height resize preserves story progress, allowing native scroll pixel rounding');
  await scrollTo(recovery,5.1,5);await plays(recovery);
  await video(recovery).focus();
  assert(await video(recovery).evaluate(e=>document.activeElement===e),'native video can receive keyboard focus');
  await scrollTo(recovery,4.1,4);
  assert(await recoveryRoot.evaluate(e=>document.activeElement===e),'retracting a focused card restores focus to the native scrollport');
  const focusPosition=await recoveryRoot.evaluate(e=>e.scrollTop);
  assert(Math.abs(focusPosition/Math.max(320,760*.68)-4.1)<.002,'focus recovery does not jump to another story position');
  await recovery.keyboard.press('PageUp');
  await recovery.waitForFunction(position=>document.querySelector('.public-landing').scrollTop<position-50,focusPosition);
  await recoveryContext.close();console.log('height resize preserves progress; hidden-card focus returns to working native keyboard scroll');

  // Real media failures are isolated; the app and navigation are never mocked.
  const imageContext=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await imageContext.route('**/velvet*.webp',route=>route.abort('failed'));
  const imageFailure=await open(imageContext);await scrollTo(imageFailure,1.1,1);
  await card(imageFailure,1).getByRole('status').waitFor();
  assert(await card(imageFailure,1).getByRole('heading').isVisible(),'world failure retains its product explanation');
  await imageContext.unroute('**/velvet*.webp');
  await card(imageFailure,1).getByRole('button',{name:'Retry',exact:true}).click();
  await readyImage(imageFailure,1);await frameMatches(imageFailure);
  await imageContext.close();console.log('world failure has a native retry and restores the same frame');

  const finishContext=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  await finishContext.route('**/auden-dial-green*.webp',route=>route.abort('failed'));
  const finishFailure=await open(finishContext);await scrollTo(finishFailure,4.1,4);
  await card(finishFailure,4).getByRole('status').waitFor();
  assert.equal(await card(finishFailure,4).locator('img[aria-hidden="false"]').count(),0,'a failed green finish is not silently replaced with a blue dial');
  await scrollTo(finishFailure,3.1,3);await readyImage(finishFailure,3);
  await finishContext.close();console.log('fixed-finish failure is explicit; the other finish remains usable');

  const filmContext=await browser.newContext({viewport:{width:1440,height:900}});
  await filmContext.route('**/gesso-studio-editor.mp4',route=>route.abort('failed'));
  const filmFailure=await open(filmContext);await scrollTo(filmFailure,5.1,5);
  await filmFailure.getByRole('button',{name:'Try the film again',exact:true}).waitFor();
  assert(await video(filmFailure).evaluate(v=>v.paused));
  assert(await filmFailure.getByRole('link',{name:'Open the MP4',exact:true}).isVisible());
  await filmContext.unroute('**/gesso-studio-editor.mp4');
  await filmFailure.getByRole('button',{name:'Try the film again',exact:true}).click();await plays(filmFailure);
  await filmContext.close();console.log('automatic Film failure offers a working explicit retry');

  const pendingContext=await browser.newContext({viewport:{width:1440,height:900}});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let requested;const requestSeen=new Promise(resolve=>{requested=resolve;});
  await pendingContext.route('**/gesso-studio-editor.mp4',async route=>{requested();await gate;await route.continue();});
  const pending=await open(pendingContext);await scrollTo(pending,5.1,5);await requestSeen;
  await scrollTo(pending,3.1,3);release();
  await pending.waitForFunction(()=>document.querySelector('[data-story-card="5"] video').readyState>=2);
  assert(await video(pending).evaluate(v=>v.paused),'late decoding cannot start playback behind another card');
  await scrollTo(pending,5.1,5);await plays(pending);
  await pendingContext.close();console.log('pending autoplay cancels on retraction and resumes only after reveal');
  assert.deepEqual(errors,[]);
} finally {await browser.close();}
