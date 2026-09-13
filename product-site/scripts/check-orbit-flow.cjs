const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('../../web/node_modules/playwright');
const out=process.env.SITE_CHECK_OUT||path.resolve(__dirname,'../../work/product-polish-20260912-round3/acceptance');
fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const checks=[],errors=[],measurements={};
try{
 const p=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 // Supply a 60 Hz display clock to the real application in Chrome. This host's
 // headless native rAF runs around 300 Hz, which hides the old 45 -> 30 fps bug.
 await p.addInitScript(()=>{
  const nativeRAF=window.requestAnimationFrame.bind(window),nativeCancel=window.cancelAnimationFrame.bind(window);
  const pending=new Map();let id=0,scheduled=0,previousTick=-1;
  function pump(time){scheduled=0;const tick=Math.floor(time/(1000/60));
   if(tick!==previousTick){previousTick=tick;const batch=[...pending.values()];pending.clear();for(const callback of batch)callback(time);}
   if(pending.size&&!scheduled)scheduled=nativeRAF(pump);
  }
  window.requestAnimationFrame=callback=>{pending.set(++id,callback);if(!scheduled)scheduled=nativeRAF(pump);return id;};
  window.cancelAnimationFrame=key=>{pending.delete(key);if(!pending.size&&scheduled){nativeCancel(scheduled);scheduled=0;}};
 });
 await p.goto((process.env.SITE_URL||'http://127.0.0.1:4490')+'/?inspect');
 await p.waitForFunction(()=>window.__orbit&&document.body.classList.contains('scene-ready'));await p.waitForTimeout(1800);
 measurements.display60=await p.evaluate(async()=>{const before=__orbit.getState(),start=performance.now();await new Promise(r=>setTimeout(r,2200));const after=__orbit.getState(),seconds=(performance.now()-start)/1000;return {seconds,frames:after.frames-before.frames,fps:(after.frames-before.frames)/seconds,clock:after.clock-before.clock};});
 assert(measurements.display60.fps>53&&measurements.display60.fps<64,JSON.stringify(measurements.display60));
 checks.push('Real mobile application sustains its 60 fps budget under a 60 Hz browser-frame driver');
 measurements.stalls=await p.evaluate(async()=>{const start=performance.now(),clock=__orbit.getState().clock;
  for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,25));const end=performance.now()+65;while(performance.now()<end){}}
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  return {seconds:(performance.now()-start)/1000,clock:__orbit.getState().clock-clock};
 });
 assert(Math.abs(measurements.stalls.clock-measurements.stalls.seconds)<.14,JSON.stringify(measurements.stalls));
 checks.push('Slow visible frames preserve elapsed fluid time instead of permanently losing animation time');
 await p.locator('#motion-toggle').tap();await p.waitForTimeout(1100);
 const frozen=await p.evaluate(()=>__orbit.getState());await p.waitForTimeout(450);const still=await p.evaluate(()=>__orbit.getState());
 assert.equal(still.clock,frozen.clock);assert.equal(still.frames,frozen.frames);
 await p.locator('#motion-toggle').tap();await p.waitForFunction(clock=>__orbit.getState().clock>clock,frozen.clock);
 assert((await p.evaluate(()=>__orbit.getState().clock))-frozen.clock<.25);
 checks.push('Pause stops rendering after settling and resumes without counting the paused interval');
 const lossClock=await p.evaluate(()=>{const gl=document.getElementById('orbit-canvas').getContext('webgl2');window.testContextLoss=gl.getExtension('WEBGL_lose_context');if(!testContextLoss)throw Error('Context loss extension unavailable');const clock=__orbit.getState().clock;testContextLoss.loseContext();return clock;});
 await p.waitForFunction(()=>document.body.classList.contains('scene-failed'));await p.waitForTimeout(850);
 assert.equal(await p.evaluate(()=>__orbit.getState().clock),lossClock);
 await p.evaluate(()=>testContextLoss.restoreContext());await p.waitForFunction(()=>document.body.classList.contains('scene-ready'));
 await p.waitForFunction(clock=>__orbit.getState().clock>clock,lossClock);
 assert((await p.evaluate(()=>__orbit.getState().clock))-lossClock<.25);
 checks.push('Actual WebGL loss and restoration preserve the fluid phase and recover the scene');
 await p.locator('.feature-dock [data-feature="videos"]').tap();await p.waitForFunction(()=>__orbit.getState().targetPhase===null);
 await p.locator('#motion-toggle').tap();const beforeReset=await p.evaluate(()=>__orbit.getState().phase);
 await p.locator('#reset-view').tap();const resetStart=await p.evaluate(()=>__orbit.getState());
 assert.notEqual(resetStart.targetPhase,null);assert(Math.abs(resetStart.phase-beforeReset)<.8);
 await p.waitForFunction(()=>__orbit.getState().targetPhase===null);
 assert(await p.evaluate(()=>Math.abs(Math.atan2(Math.sin(__orbit.getState().phase+.42),Math.cos(__orbit.getState().phase+.42)))<.002));
 checks.push('Reset visibly eases along the short angular path and settles at the original orientation');
 await p.emulateMedia({reducedMotion:'reduce'});await p.waitForTimeout(250);
 assert(await p.evaluate(()=>!document.getAnimations().some(a=>a.playState==='running')));
 assert.deepEqual(errors,[]);
 checks.push('New shader programs compile without errors and reduced motion leaves no running CSS animation');
 fs.writeFileSync(path.join(out,'flow-checks.json'),JSON.stringify({date:new Date().toISOString(),passed:checks.length,checks,measurements,errors},null,2));
 console.log(JSON.stringify({passed:checks.length,checks,measurements,errors},null,2));
}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
