const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('../../web/node_modules/playwright');
const base=process.env.SITE_URL||'http://127.0.0.1:4490';
const out=process.env.SITE_CHECK_OUT||path.resolve(__dirname,'../../work/product-polish-20260912-final/acceptance');
fs.mkdirSync(out,{recursive:true});
const settled=p=>p.waitForFunction(()=>[...document.querySelectorAll('dialog[open]')].every(d=>d.getAnimations({subtree:true}).every(a=>a.playState==='finished'||a.effect.getTiming().iterations===Infinity)));
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const checks=[],errors=[];
try{
 const p=await browser.newPage({viewport:{width:390,height:640},isMobile:true,hasTouch:true});p.on('pageerror',e=>errors.push(e.message));
 await p.goto(base+'/#library');await p.locator('#open-screenshot.is-loaded').waitFor();await settled(p);
 await p.locator('[data-page-next]').click();await settled(p);
 const scroll=await p.locator('.detail-body').evaluate(e=>{e.scrollTop=65;return e.scrollTop;});assert(scroll>20);
 await p.locator('[data-detail-page="1"]').click();
 assert.equal(await p.locator('.detail-body').evaluate(e=>e.scrollTop),scroll);
 assert.equal(await p.locator('.detail-body').evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
 checks.push('Reactivating the current chapter preserves the reading position without replaying motion');

 await p.locator('[data-page-next]').click();await p.locator('[data-page-next]').click();await p.locator('[data-page-previous]').click();await settled(p);
 assert.equal(await p.locator('#detail-page-count').textContent(),'3 / 4');
 const expected=await p.evaluate(()=>JSON.parse(document.getElementById('feature-data').textContent).find(f=>f.id==='library').pages[2].headline);
 assert.equal(await p.locator('#detail-title').textContent(),expected);
 const selected=await p.locator('[data-detail-page="2"]').boundingBox(),marker=await p.locator('.chapter-marker').boundingBox();
 assert(Math.abs(marker.x-selected.x)<1&&Math.abs(marker.width-selected.width)<1);
 assert.equal(await p.locator('.chapter-marker').getAttribute('aria-hidden'),'true');
 checks.push('Rapid chapter changes retain only the newest content and align the decorative indicator');

 await p.locator('[data-page-previous]').click();await p.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await p.locator('.detail-body').evaluate(e=>e.getAnimations({subtree:true}).filter(a=>a.playState==='running').length),0);
 await p.locator('[data-page-previous]').click();
 assert.equal(await p.locator('#detail-page-count').textContent(),'1 / 4');
 assert.equal(await p.locator('.chapter-marker').evaluate(e=>e.getAnimations().length),0);
 checks.push('Enabling reduced motion cancels ongoing chapter motion and makes later navigation immediate');
 await p.emulateMedia({reducedMotion:'no-preference'});await settled(p);

 await p.locator('#open-screenshot').click();await settled(p);
 assert.equal(await p.locator('#zoom-stage').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
 const image=await p.locator('#zoom-screenshot').boundingBox();assert(image.width<390);
 await p.locator('#zoom-in').click();
 assert(await p.locator('#zoom-stage').evaluate(e=>e.classList.contains('is-zoomed')&&getComputedStyle(e).backgroundImage!=='none'));
 await p.locator('#zoom-fit').click();assert((await p.locator('#zoom-screenshot').boundingBox()).width<390);
 checks.push('Fitted images keep a floating edge and enlarged images restore the full scrolling surface');

 await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.getElementById('zoom-dialog').open);
 await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('dialog[open]'));
 const trigger=p.locator('.site-header [data-open-download]');await trigger.click();
 const entrance=await p.locator('#download-dialog').evaluate(e=>{
  const motion=e.getAnimations().find(a=>a.animationName==='dialog-in');
  if(!motion)throw new Error('Missing dialog entrance');motion.pause();motion.currentTime=70;
  return {transform:getComputedStyle(e).transform,opacity:getComputedStyle(e).opacity};
 });
 await p.keyboard.press('Escape');
 const from=await p.locator('#download-dialog').evaluate(e=>e.getAnimations().find(a=>!(a instanceof CSSAnimation))?.effect.getKeyframes()[0]);
 assert(from,'Exit must be an active continuation');assert.equal(from.transform,entrance.transform);assert.equal(String(from.opacity),entrance.opacity);
 await p.waitForFunction(()=>!document.getElementById('download-dialog').open);
 assert(await trigger.evaluate(e=>document.activeElement===e));
 checks.push('Early Escape continues from the exact visible entrance pose and restores the source focus');

 assert.deepEqual(errors,[]);const report={date:new Date().toISOString(),passed:checks.length,checks,errors};
 fs.writeFileSync(path.join(out,'finish-checks.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
