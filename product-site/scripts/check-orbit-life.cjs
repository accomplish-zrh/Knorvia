const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('../../web/node_modules/playwright');
const out=process.env.SITE_CHECK_OUT||path.resolve(__dirname,'../../work/product-poollife-20260912/acceptance');
fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const checks=[],errors=[],measurements={};
try{
 const p=await browser.newPage({viewport:{width:1440,height:1000}});p.on('pageerror',e=>errors.push(e.message));
 await p.goto((process.env.SITE_URL||'http://127.0.0.1:4490')+'/?inspect');
 await p.waitForFunction(()=>window.__orbit&&document.body.classList.contains('scene-ready'));await p.waitForTimeout(1800);
 const before=await p.evaluate(()=>({life:__orbit.getLifeState(),poses:__orbit.getPanelPoses()}));
 await p.waitForTimeout(1100);
 const after=await p.evaluate(()=>({life:__orbit.getLifeState(),poses:__orbit.getPanelPoses()}));
 assert(after.life.visible);assert.equal(after.life.fish.length,3);assert.equal(new Set(after.life.fish.map(f=>f.color)).size,3);
 assert(Math.max(...after.life.fish.map(f=>f.x))-Math.min(...after.life.fish.map(f=>f.x))>800);
 for(let i=0;i<3;i++){
  assert.equal(after.life.fish[i].depth.state,'submerged');
  // Random routes can briefly slow down at a turn; every fish must move, but
  // requiring all fish to cover the same minimum distance rejects valid motion.
  assert(Math.hypot(after.life.fish[i].x-before.life.fish[i].x,after.life.fish[i].y-before.life.fish[i].y)>.001);
  assert.notEqual(after.life.fish[i].tail,before.life.fish[i].tail);
 }
 assert(after.life.fish.filter((f,i)=>Math.hypot(f.x-before.life.fish[i].x,f.y-before.life.fish[i].y)>.3).length>=2);
 assert.equal(after.life.ring.depth.state,'crossing');assert.notEqual(after.life.ring.z,before.life.ring.z);
 checks.push('Three subtly patterned fish roam separate water areas while the ring follows the surface');
 measurements.poseChanges=after.poses.map((pose,i)=>({id:pose.id,y:pose.y-before.poses[i].y,pitch:pose.pitch-before.poses[i].pitch,roll:pose.roll-before.poses[i].roll}));
 assert(measurements.poseChanges.some(pose=>pose.y>.005));assert(measurements.poseChanges.some(pose=>pose.y<-.005));
 assert(measurements.poseChanges.every(pose=>Math.abs(pose.pitch)+Math.abs(pose.roll)>.001));
 assert(after.poses.every(pose=>Math.abs(pose.pitch)<.05&&Math.abs(pose.roll)<.03&&Math.abs(pose.turnLag)<=.14));
 checks.push('Six photos drift at different phases with bounded pitch, roll and turn lag');
 await p.waitForFunction(()=>__orbit.getLifeState().fish.some(f=>f.depth.state==='above'),null,{timeout:20000});
 const jump=await p.evaluate(()=>__orbit.getLifeState());assert(jump.fish.some(f=>f.jumping&&f.depth.state==='above'));
 await p.waitForFunction(()=>__orbit.getLifeState().fish.some(f=>f.landings>0&&f.splash),null,{timeout:4000});
 measurements.firstLanding=await p.evaluate(()=>__orbit.getLifeState());
 await p.waitForTimeout(900);assert(await p.evaluate(()=>__orbit.getLifeState().fish.some(f=>f.landings>0&&!f.jumping&&f.depth.state==='submerged')));
 checks.push('A fish rises fully above the real water, lands with a splash, then returns underwater');
 const boatBefore=await p.evaluate(()=>__orbit.getLifeState().boats.find(b=>b.visible));assert(boatBefore);
 await p.waitForTimeout(650);const boatAfter=await p.evaluate(()=>__orbit.getLifeState().boats.find(b=>b.visible));
 assert(boatAfter);assert(Math.hypot(boatAfter.x-boatBefore.x,boatAfter.y-boatBefore.y)>1);
 assert(boatAfter.x<220||boatAfter.x>1220);assert.equal(await p.evaluate(()=>__orbit.getLifeState().boats.filter(b=>b.visible).length),1);
 checks.push('A small sailboat passes along the outer water margin without overlapping another boat');
 await p.locator('.feature-dock [data-feature="library"]').click();await p.waitForFunction(()=>__orbit.getState().targetPhase===null);await p.waitForTimeout(600);
 const focused=await p.evaluate(()=>({state:__orbit.getState(),pose:__orbit.getPanelPoses().find(p=>p.id==='library')}));
 assert.equal(focused.state.focused,3);assert(Math.abs(focused.pose.y)<.003&&Math.abs(focused.pose.pitch)<.002&&Math.abs(focused.pose.roll)<.002);
 checks.push('A selected navigation photo settles into a stable reading position');
 await p.locator('#motion-toggle').click();await p.waitForTimeout(1200);
 const frozen=await p.evaluate(()=>({life:__orbit.getLifeState(),poses:__orbit.getPanelPoses(),frames:__orbit.getState().frames}));
 await p.waitForTimeout(500);
 assert.deepEqual(await p.evaluate(()=>({life:__orbit.getLifeState(),poses:__orbit.getPanelPoses(),frames:__orbit.getState().frames})),frozen);
 checks.push('Pause freezes fish, ring and individual photo poses and stops the render loop');
 await p.emulateMedia({reducedMotion:'reduce'});await p.waitForTimeout(200);
 const reduced=await p.evaluate(()=>({life:__orbit.getLifeState(),poses:__orbit.getPanelPoses(),frames:__orbit.getState().frames}));
 assert(reduced.poses.every(pose=>pose.y===0&&pose.pitch===0&&pose.roll===0&&pose.turnLag===0));
 await p.waitForTimeout(350);assert.deepEqual(await p.evaluate(()=>({life:__orbit.getLifeState(),poses:__orbit.getPanelPoses(),frames:__orbit.getState().frames})),reduced);
 checks.push('Reduced motion removes photo drift immediately and leaves decorative objects still');
 measurements.layouts=[];
 for(const viewport of [{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
  await p.setViewportSize(viewport);await p.waitForTimeout(150);
  const life=await p.evaluate(()=>__orbit.getLifeState());measurements.layouts.push({viewport,life});
  assert.equal(life.visible,viewport.width===390);
  assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(life.visible){
   const dock=await p.locator('.feature-dock').boundingBox();
   assert.equal(life.fish.filter(f=>f.visible).length,2);
   for(const object of [...life.fish.filter(f=>f.visible),life.ring]){assert(object.x>25&&object.x<viewport.width-25);assert(object.y<dock.y-20);}
  }
 }
 checks.push('Portrait phones fit smaller decorations above navigation; short and landscape screens omit them');
 assert.deepEqual(errors,[]);const report={date:new Date().toISOString(),passed:checks.length,checks,measurements,errors};
 fs.writeFileSync(path.join(out,'life-checks.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:checks.length,checks,errors},null,2));
}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
