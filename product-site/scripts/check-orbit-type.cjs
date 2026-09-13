const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('../../web/node_modules/playwright');
const root=path.resolve(__dirname,'..'),features=require('./orbit-content.cjs');
const coverage=require('./handwriting-coverage.json');
const base=process.env.SITE_URL||'http://127.0.0.1:4490';
const out=process.env.SITE_CHECK_OUT||path.resolve(root,'../work/product-lettering-20260912/acceptance');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const checks=[],errors=[];
 try{
  const p=await browser.newPage({viewport:{width:1440,height:1000}});
  p.on('pageerror',e=>errors.push(e.message));
  await p.goto(base+'/?inspect');await p.waitForFunction(()=>document.body.classList.contains('scene-ready'));await p.evaluate(()=>document.fonts.ready);
  const display=await p.locator('h1,h2,.handwritten-note').allTextContents();
  for(const title of [...display,...features.flatMap(f=>f.pages.map(p=>p.headline))])
   for(const char of title.trim())assert(coverage.characters.includes(char),'Missing display character: '+char);
  const bytes=fs.readFileSync(path.join(root,'assets/fonts/knorvia-hand.woff2'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),coverage.sha256);
  assert(bytes.length<60000);assert(fs.readFileSync(path.join(root,'assets/WENKAI-LICENSE.txt'),'utf8').includes('SIL OPEN FONT LICENSE'));
  checks.push('All 24 guide headings and static display copy are covered by the licensed, self-hosted font subset');
  const cdp=await p.context().newCDPSession(p);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
  const {root:dom}=await cdp.send('DOM.getDocument');
  const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'.hero-outcome'});
  const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
  assert(fonts.some(f=>f.isCustomFont&&f.familyName==='Knorvia Hand'&&f.glyphCount>5),JSON.stringify(fonts));
  assert.equal(await p.locator('h1').evaluate(e=>getComputedStyle(e).fontWeight),'300');
  assert(await p.locator('body,.feature-dock a,.hero-copy p').evaluateAll(nodes=>nodes.every(e=>!getComputedStyle(e).fontFamily.includes('Knorvia Hand'))));
  checks.push('Chrome renders the actual Light handwritten glyphs; reading text and controls retain the original type');
  const layouts=[];
  for(const viewport of [{width:1440,height:1000},{width:1366,height:768},{width:768,height:1024},{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
   await p.setViewportSize(viewport);await p.waitForTimeout(250);
   const layout=await p.evaluate(()=>{
    const heading=document.querySelector('h1'),r=heading.getBoundingClientRect();
    return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,headingHeight:r.height,fragments:[...heading.children].map(e=>{const b=e.getBoundingClientRect();return{x:b.x,right:b.right}})};
   });
   assert(!layout.overflow);assert(layout.fragments.every(r=>r.x>=0&&r.right<=viewport.width));layouts.push(layout);
  }
  await p.emulateMedia({reducedMotion:'reduce'});await p.evaluate(()=>location.hash='library');await p.locator('#feature-dialog[open]').waitFor();
  await p.locator('[data-page-next]').click();
  assert.equal(await p.locator('#detail-title').textContent(),features.find(f=>f.id==='library').pages[1].headline);
  assert.equal(await p.locator('.hero-outcome').evaluate(e=>e.getAnimations().filter(a=>a.playState==='running').length),0);
  checks.push('Display text fits six desktop, phone and landscape sizes; reduced motion preserves readable chapter navigation');
  const fallback=await browser.newPage({viewport:{width:320,height:568},reducedMotion:'reduce'});
  fallback.on('pageerror',e=>errors.push(e.message));
  await fallback.route('**/knorvia-hand.woff2',route=>route.abort());
  await fallback.goto(base+'/#library');await fallback.evaluate(()=>document.fonts.ready);await fallback.locator('#feature-dialog[open]').waitFor();
  assert(await fallback.locator('#detail-title').isVisible());await fallback.locator('[data-page-next]').click();
  assert.equal(await fallback.locator('#detail-page-count').textContent(),'2 / 4');
  assert(await fallback.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await fallback.screenshot({path:path.join(out,'font-unavailable.png')});
  checks.push('Unavailable handwriting font falls back to visible text with working phone chapter navigation');
  assert.deepEqual(errors,[]);
  const report={date:new Date().toISOString(),passed:checks.length,checks,fonts,layouts,errors};
  fs.writeFileSync(path.join(out,'type-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
