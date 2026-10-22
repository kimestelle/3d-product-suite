/** Real retained-page navigation: run against Vite or the built local server. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const origin=process.env.PRODUCT_SUITE_URL||'http://127.0.0.1:5173';
const browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[];
try {
  for(const compact of [false,true]) {
    const page=await browser.newPage({viewport:compact?{width:390,height:844}:{width:1440,height:900},reducedMotion:compact?'reduce':'no-preference'});
    page.on('pageerror',error=>errors.push(error.message));
    const settled=route=>page.locator(`.dynamic-frame-shell[data-page="${route}"][data-navigation="settled"]`).waitFor();
    const top=selector=>page.locator(selector).evaluate(element=>element.scrollTop);
    const scroll=async selector=>{
      await page.locator(selector).evaluate(element=>element.scrollTo({top:1200,behavior:'instant'}));
      await page.waitForFunction(selector=>document.querySelector(selector).scrollTop>100,selector);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    };
    await page.goto(origin+'/about');await settled('about');
    assert.equal(await page.evaluate(()=>history.scrollRestoration),'manual');
    await scroll('.about-scroll');
    await page.locator('.about-header .site-study-link').click();await settled('philosophy');
    await scroll('.gesso-shape-light');
    await page.locator('.shape-light-header .site-about-link').click();
    assert.equal(await top('.about-scroll'),0,'About resets before route motion finishes');
    await settled('about');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'about-title');
    await page.locator('.about-header .site-study-link').click();
    assert.equal(await top('.gesso-shape-light'),0,'Form + Light resets before destination sampling');
    assert.equal(await page.locator('.gesso-shape-light').getAttribute('data-frame'),'ground');
    await settled('philosophy');
    await scroll('.gesso-shape-light');
    await page.goBack();await settled('about');assert.equal(await top('.about-scroll'),0);
    await scroll('.about-scroll');
    await page.goForward();await settled('philosophy');assert.equal(await top('.gesso-shape-light'),0);
    await scroll('.gesso-shape-light');
    await page.locator('.shape-light-header .site-about-link').click();
    await page.goBack();await settled('philosophy');
    assert.equal(await top('.gesso-shape-light'),0,'An interrupted return also starts at the cover');
    assert.equal(await page.locator('.gesso-shape-light').getAttribute('data-frame'),'ground');
    // Explicit destinations within the page still work, including history.
    await page.locator('a[href="#principle-product"]').evaluate(link=>link.click());
    await page.waitForFunction(()=>location.hash==='#principle-product'&&document.querySelector('.gesso-shape-light').scrollTop>100);
    await page.goto(origin+'/aperture#principle-interface');await settled('philosophy');
    await page.waitForFunction(()=>document.querySelector('.gesso-shape-light').scrollTop>100);
    console.log(`${compact?'compact / reduced motion':'desktop'}: page entry, Back/Forward, focus and explicit anchors passed`);
    await page.close();
  }
  assert.deepEqual(errors,[]);
} finally {await browser.close();}
