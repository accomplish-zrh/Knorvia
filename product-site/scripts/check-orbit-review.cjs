const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('../../web/node_modules/playwright');
const base=process.env.SITE_URL||'http://127.0.0.1:4490';
const out=process.env.SITE_CHECK_OUT||path.resolve(__dirname,'../../work/product-polish-20260912-round2/acceptance');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const checks=[],errors=[];
 const observe=p=>p.on('pageerror',e=>errors.push(e.message));
 const settled=p=>p.waitForFunction(()=>[...document.querySelectorAll('dialog[open]')].every(d=>d.getAnimations({subtree:true}).every(a=>a.playState==='finished'||a.effect.getTiming().iterations===Infinity)));
 const closeAll=async p=>{await p.keyboard.press('Escape');await p.waitForFunction(()=>!document.querySelector('dialog.is-closing'));};
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000}});observe(p);
  await p.goto(base+'/?inspect');await p.waitForFunction(()=>window.__orbit&&document.body.classList.contains('scene-ready'));
  await p.locator('[data-feature="library"]').last().click();
  assert.notEqual(await p.evaluate(()=>__orbit.getState().targetPhase),null);
  await p.locator('.feature-dock [data-feature="library"]').click();
  await p.locator('#feature-dialog[open]').waitFor();
  assert.equal(await p.locator('#detail-category').textContent(),'资料库');
  checks.push('A second click opens the selected feature while its photo is still settling');
  await settled(p);await p.locator('[data-page-next]').focus();
  for(let i=0;i<4;i++)await p.keyboard.press('Enter');
  assert.equal(await p.locator('#detail-page-count').textContent(),'4 / 4');
  assert.equal(await p.evaluate(()=>document.activeElement.dataset.detailPage),'3');
  checks.push('Repeated keyboard activation at the last chapter stays there without reversing direction');
  await p.locator('[data-detail-page="0"]').click();await p.locator('#open-screenshot.is-loaded').waitFor();
  await p.locator('#open-screenshot').click();await settled(p);
  assert.equal(await p.evaluate(()=>document.activeElement.id),'zoom-stage');
  await p.locator('#zoom-in').focus();await p.keyboard.press('Enter');await p.keyboard.press('Enter');
  assert.equal(await p.evaluate(()=>document.activeElement.id),'zoom-stage');
  const desktopFrame=await p.locator('#zoom-stage').boundingBox();
  const desktopLeft=await p.locator('#zoom-stage').evaluate(e=>e.scrollLeft);
  await p.mouse.move(desktopFrame.x+desktopFrame.width*.5,desktopFrame.y+desktopFrame.height*.5);
  await p.mouse.down();await p.mouse.move(desktopFrame.x+desktopFrame.width*.5-150,desktopFrame.y+desktopFrame.height*.5-70,{steps:8});await p.mouse.up();
  assert(await p.locator('#zoom-stage').evaluate((e,left)=>e.scrollLeft>left+100,desktopLeft));
  await p.keyboard.press('0');assert(await p.locator('#zoom-out').isDisabled());
  checks.push('Desktop image zoom preserves keyboard focus at limits, pans by mouse, and resets with 0');
  await p.goBack();
  await p.waitForFunction(()=>!document.querySelector('dialog[open]'));
  checks.push('Browser Back closes both the feature and its image viewer without an orphan dialog');
  const mobile=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});observe(mobile);
  await mobile.bringToFront();
  await mobile.goto(base+'/?inspect#library');await settled(mobile);await mobile.locator('#open-screenshot.is-loaded').waitFor();
  const cdp=await mobile.context().newCDPSession(mobile);
  const swipe=async(x,y,dx,dy,park=0)=>{
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   for(let i=1;i<=10;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/10,y:y+dy*i/10}]});
   if(park)await mobile.waitForTimeout(park);
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const preview=await mobile.locator('#open-screenshot').boundingBox();
  // End this chapter swipe at rest. An in-flight native fling consumes the next tap to stop itself.
  // The image-panning check below separately exercises that native momentum path.
  await swipe(preview.x+preview.width-35,preview.y+preview.height/2,-180,3,180);
  assert.equal(await mobile.locator('#detail-page-count').textContent(),'2 / 4');
  assert.equal(await mobile.locator('#zoom-dialog').evaluate(d=>d.open),false);
  checks.push('Swiping across the overview screenshot turns the page without accidentally opening the viewer');
  // The next independent tap starts immediately after touchEnd, without a post-swipe delay.
  const overviewTab=await mobile.locator('[data-detail-page="0"]').boundingBox();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:overviewTab.x+overviewTab.width/2,y:overviewTab.y+overviewTab.height/2}]});
  await mobile.waitForTimeout(80);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await mobile.waitForFunction(()=>document.getElementById('detail-page-count').textContent==='1 / 4');
  await mobile.locator('#open-screenshot').tap();await settled(mobile);
  await mobile.waitForFunction(()=>document.getElementById('zoom-screenshot').naturalWidth===1440);
  const fit=await mobile.locator('#zoom-screenshot').boundingBox();assert(fit.width<390);
  for(let i=0;i<4&&!await mobile.locator('#zoom-in').isDisabled();i++)await mobile.locator('#zoom-in').tap();
  assert((await mobile.locator('#zoom-screenshot').boundingBox()).width>=1400);
  const scrollBefore=await mobile.locator('#zoom-stage').evaluate(e=>({x:e.scrollLeft,y:e.scrollTop}));
  const frame=await mobile.locator('#zoom-stage').boundingBox();
  await swipe(frame.x+frame.width*.7,frame.y+frame.height*.65,-130,-100);
  const scrollAfter=await mobile.locator('#zoom-stage').evaluate(e=>({x:e.scrollLeft,y:e.scrollTop}));
  assert(Math.abs(scrollAfter.x-scrollBefore.x)>20||Math.abs(scrollAfter.y-scrollBefore.y)>20);
  // A tap during native momentum stops scrolling; wait for the gesture to settle before testing Fit.
  await mobile.locator('#zoom-stage').evaluate(el=>new Promise(resolve=>{
   let x=el.scrollLeft,y=el.scrollTop,stable=performance.now();const start=stable;
   const tick=now=>{if(el.scrollLeft!==x||el.scrollTop!==y){x=el.scrollLeft;y=el.scrollTop;stable=now;}
    if((now-stable>250&&now-start>450)||now-start>4000)resolve();else requestAnimationFrame(tick);};requestAnimationFrame(tick);
  }));
  await mobile.screenshot({path:path.join(out,'mobile-image-detail.png')});
  await mobile.locator('#zoom-fit').tap();
  assert((await mobile.locator('#zoom-screenshot').boundingBox()).width<390);
  await mobile.screenshot({path:path.join(out,'mobile-image-viewer.png')});
  await mobile.addScriptTag({path:require.resolve('../../web/node_modules/axe-core/axe.js')});
  const viewerAxe=await mobile.evaluate(async()=>await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  assert.equal(viewerAxe.violations.length,0,JSON.stringify(viewerAxe.violations.map(v=>v.id)));
  await closeAll(mobile);assert.equal(await mobile.evaluate(()=>document.activeElement.id),'open-screenshot');
  checks.push('Mobile screenshots enlarge to original pixels, pan with real touch, fit again, and restore focus');
  for(const viewport of [{width:320,height:568},{width:844,height:390},{width:1024,height:600}]){
   await p.bringToFront();
   await p.setViewportSize(viewport);await p.goto(base+'/#library');await settled(p);
   assert(await p.locator('.detail-body').evaluate(e=>e.clientHeight>=180),'Short viewport reading area');
   assert(await p.locator('.detail-shell').evaluate(e=>e.scrollWidth<=e.clientWidth),'Detail horizontal overflow');
   assert(await p.locator('#feature-dialog').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
   await p.screenshot({path:path.join(out,`reading-${viewport.width}x${viewport.height}.png`)});
  }
  checks.push('320×568, 844×390 and 1024×600 retain at least 180 px of reading space without overflow');
  await mobile.bringToFront();
  for(const selector of ['[data-page-next]','[aria-label="关闭详情"]','[data-detail-page="0"]']){
   const box=await mobile.locator(selector).boundingBox();assert(box.width>=44&&box.height>=44,selector);
  }
  await closeAll(mobile);
  for(const selector of ['#motion-toggle','#reset-view','.header-actions>[aria-label="GitHub 源码"]','.feature-dock a']){
   for(const node of await mobile.locator(selector).all()){const box=await node.boundingBox();assert(box.width>=44&&box.height>=44,selector);}
  }
  checks.push('Key mobile controls and feature links have actual 44 px touch targets');
  await mobile.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
  await mobile.waitForFunction(()=>window.__orbit&&document.body.classList.contains('scene-ready'));
  await mobile.locator('#motion-toggle').tap();
  await mobile.waitForTimeout(600);
  const point=await mobile.evaluate(()=>__orbit.getState().panels.reduce((a,b)=>a.z>b.z?a:b));
  const radiusBefore=await mobile.evaluate(()=>__orbit.getState().targetRadius);
  await swipe(point.x,point.y,2,-180);await mobile.waitForTimeout(150);
  assert(await mobile.evaluate(()=>scrollY>30),'Vertical swipe on a photo should scroll the page');
  assert.equal(await mobile.evaluate(()=>__orbit.getState().targetRadius),radiusBefore);
  checks.push('Vertical touch scrolling works from a photograph and does not resize its orbit');
  const copy=await browser.newPage({viewport:{width:390,height:844}});observe(copy);
  await copy.context().grantPermissions(['clipboard-read','clipboard-write']);
  await copy.goto(base+'/#install');await settled(copy);
  const closeBox=await copy.locator('[aria-label="关闭下载"]').boundingBox();
  const downloadBox=await copy.locator('#download-dialog').boundingBox();
  assert(closeBox.x>downloadBox.x+downloadBox.width/2&&closeBox.y<downloadBox.y+30,'Download close belongs in the top right corner');
  await copy.locator('#copy-download-link').click();
  assert.equal(await copy.evaluate(()=>navigator.clipboard.readText()),'https://knorvia.xyz/#install');
  await copy.screenshot({path:path.join(out,'mobile-download.png')});
  await copy.context().clearPermissions();
  await copy.context().grantPermissions([]);
  await copy.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new DOMException('Denied','NotAllowedError'))}}));
  await copy.locator('#copy-download-link').click();assert(await copy.locator('#download-page-link').isVisible());
  assert.equal(await copy.evaluate(()=>document.activeElement.id),'download-page-link');
  checks.push('Download handoff copies the public link and offers a selectable link when clipboard access fails');
  await copy.addScriptTag({path:require.resolve('../../web/node_modules/axe-core/axe.js')});
  const downloadAxe=await copy.evaluate(async()=>await axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  assert.equal(downloadAxe.violations.length,0,JSON.stringify(downloadAxe.violations.map(v=>v.id)));
  fs.writeFileSync(path.join(out,'review-axe.json'),JSON.stringify({viewer:viewerAxe.violations,download:downloadAxe.violations},null,2));
  checks.push('Image viewer and download fallback pass automated WCAG 2.1 AA checks; close stays at top right');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'review-polish.json'),JSON.stringify({date:new Date().toISOString(),passed:checks.length,checks,errors},null,2));
  console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
