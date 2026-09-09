'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {createMediaStudio}=require('../media-studio'),{createFakeRpc,waitFor}=require('./fixtures/sequence-harness'),A=require('../pet-atlas'),F=require('./fixtures/video-fixtures');
process.env.KNORVIA_FFMPEG_DIR ??= path.dirname(F.ffmpeg());
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
// Deliberate synthetic structural fixtures, not production artwork and not
// evidence of semantic identity quality from a paid image model.
function strip(count){const image={width:count*64,height:80,rgba:Buffer.alloc(count*64*80*4)};for(let frame=0;frame<count;frame++)for(let y=17+frame%2;y<65;y++)for(let x=18;x<46;x++){const n=(y*image.width+frame*64+x)*4;image.rgba.set([90+frame*5,180,150,255],n);}return A.encodePng(image);}
function library(){const entries=new Map(),bytes=new Map();return {handlers:{'library/list':async()=>({entries:[...entries.values()]}),'library/read':async({id,version,offset=0})=>{const entry=entries.get(id);assert.equal(version,entry.sha256);const value=bytes.get(id),chunk=value.subarray(offset,offset+512*1024);return {entry,size:value.length,base64:chunk.toString('base64'),nextOffset:offset+chunk.length<value.length?offset+chunk.length:null};}},async put(file,destination){const value=fs.readFileSync(file);let e=[...entries.values()].find(v=>v.path===destination&&v.sha256===sha(value));if(!e){e={id:`lib-${entries.size+1}`,path:destination,name:path.basename(destination),sha256:sha(value),size:value.length};entries.set(e.id,e);bytes.set(e.id,value);}return e;}};}
test('pet hatch uses real createMediaStudio and ten HTTP image jobs, persists selection, repairs one row only',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'kn-pet-http-')),baseRpc=createFakeRpc(),lib=library(),requests=[];let art=0;
  const rpc=async(method,params)=>method==='artifact/create'?{id:`artifact-${++art}`} :method.startsWith('artifact/')?{}:baseRpc(method,params);
  const server=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{const body=Buffer.concat(chunks).toString();requests.push({url:req.url,body});const state=/State: ([a-z-]+)\./.exec(body)?.[1],row=A.ROWS.indexOf(state);assert.ok(req.url.endsWith('/images/generations')||req.url.endsWith('/images/edits'));res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{b64_json:strip(row<0?1:A.COUNTS[row]).toString('base64')}],usage:{input_tokens:12,output_tokens:5}}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const studio=createMediaStudio({home,rpc,library:lib,pollMs:5});t.after(()=>studio.close());
  studio.profiles.save({id:'pet-image',name:'Loopback',kind:'image',protocol:'openai',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'gpt-image-fixture',agentEnabled:true,apiKey:'fixture'});
  const create={name:'小伙伴',prompt:'a small jade cat',profileId:'pet-image',idempotencyKey:'pet-real-flow'};
  const job=await studio.pets.create(create,true);await waitFor(async()=>{const j=await studio.handlers['studio/pet/read']({jobId:job.id});if(j.phase==='needs-attention')throw new Error(j.error);return j.status==='succeeded';},'ten real image requests and candidate',40000);
  const finished=await studio.handlers['studio/pet/read']({jobId:job.id});assert.equal(requests.length,10);assert.equal(requests.filter(v=>v.url.endsWith('/images/edits')).length,9);for(const req of requests.slice(1))assert.match(req.body,/name="image\[\]"/);
  const candidate=await studio.handlers['studio/pet/read']({id:finished.candidateId});assert.ok(candidate.qa.passed);assert.equal(candidate.qa.visualReviewRequired,true);assert.equal((await fetch(candidate.url)).status,200);
  const replay=await studio.pets.create(create,true);assert.equal(replay.id,job.id);assert.equal(requests.length,10);
  await assert.rejects(studio.pets.create({...create,prompt:'different'},true),/同一/);
  await assert.rejects(studio.handlers['studio/pet/select']({id:candidate.id}),/预览/);
  await studio.handlers['studio/pet/select']({id:candidate.id,reviewed:true});const exported=await studio.handlers['studio/pet/export']({id:candidate.id});assert.equal(exported.atlasSha256,candidate.atlasSha256);assert.equal(fs.existsSync(path.join(exported.exportedTo,'base-source.png')),false);
  const original=fs.readFileSync(path.join(studio.root,'pets',candidate.id,'spritesheet.png'));
  const repair=await studio.handlers['studio/pet/repair']({id:candidate.id,row:'waiting',profileId:'pet-image',idempotencyKey:'repair-one'});
  await waitFor(async()=>{const j=await studio.handlers['studio/pet/read']({jobId:repair.id});if(j.phase==='needs-attention')throw new Error(j.error);return j.status==='succeeded';},'single-row repair',15000);assert.equal(requests.length,11);assert.deepEqual(fs.readFileSync(path.join(studio.root,'pets',candidate.id,'spritesheet.png')),original);
  await studio.close();const reopened=createMediaStudio({home,rpc,library:lib,pollMs:5});t.after(()=>reopened.close());const index=await reopened.handlers['studio/pet/list']();assert.equal(index.selected.id,candidate.id);assert.equal(index.packages.length,2);assert.equal(requests.length,11);
  const mediaJobs=[...baseRpc.state.jobs.values()].filter(v=>v.type==='media.image');assert.equal(mediaJobs.length,11);assert.ok(mediaJobs.every(v=>v.checkpoint.usage.providerId==='pet-image'&&v.checkpoint.usage.attempts[0].recordedAtMs>0));
});
test('pet structural checks reject forged PNG, opaque atlas and missing poses',()=>{const bytes=strip(6);assert.throws(()=>A.pngInfo(bytes.subarray(0,24)),/截断|无效/);const damaged=Buffer.from(bytes);damaged[30]^=1;assert.throws(()=>A.pngInfo(damaged),/校验/);const blank={width:1536,height:1872,rgba:Buffer.alloc(1536*1872*4)};assert.equal(A.inspectAtlas(blank).passed,false);blank.rgba.fill(255);assert.equal(A.inspectAtlas(blank).passed,false);});

test('invalid generated row survives reload without resubmission and requires explicit retry of only that row', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-pet-retry-')), baseRpc = createFakeRpc(), lib = library(), requests = [];
  let badWaiting = true;
  const rpc = async (method, params) => method.startsWith('artifact/') ? { id: 'artifact' } : baseRpc(method, params);
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', b => chunks.push(b)); req.on('end', () => {
      const body = Buffer.concat(chunks).toString(), state = /State: ([a-z-]+)\./.exec(body)?.[1], row = A.ROWS.indexOf(state);
      requests.push(state || 'base');
      const broken = state === 'waiting' && badWaiting; if (broken) badWaiting = false;
      const bytes = broken ? A.encodePng({ width: 512, height: 80, rgba: Buffer.alloc(512 * 80 * 4) }) : strip(row < 0 ? 1 : A.COUNTS[row]);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const studio = createMediaStudio({ home, rpc, library: lib, pollMs: 5 }); t.after(() => studio.close());
  studio.profiles.save({ id: 'pet-image', name: 'Loopback', kind: 'image', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', agentEnabled: true });
  const made = await studio.handlers['studio/pet/create']({ name: 'retry', prompt: 'jade cat', profileId: 'pet-image', idempotencyKey: 'invalid-row', repairRow: 'waiting', repairSource: { dir: 'C:/must-not-be-read' } });
  await waitFor(async () => (await studio.handlers['studio/pet/read']({ jobId: made.id })).phase === 'needs-attention', 'invalid waiting row', 40000);
  const failed = await studio.handlers['studio/pet/read']({ jobId: made.id });
  assert.equal(failed.input.repairSource, undefined, 'public create cannot inject private filesystem repair source');
  const requestCount = requests.length, oldJob = failed.pipeline.steps.waiting.jobId;
  await studio.close();
  const reopened = createMediaStudio({ home, rpc, library: lib, pollMs: 5 }); t.after(() => reopened.close());
  await reopened.handlers['studio/pet/resume']({ id: made.id });
  await waitFor(async () => {
    const index = await reopened.handlers['studio/pet/list']();
    return index.jobs.find(job => job.id === made.id)?.active === false;
  }, 'retry reads the existing invalid row', 20000);
  assert.equal(requests.length, requestCount, 'ordinary resume cannot charge another generation');
  await assert.rejects(reopened.handlers['studio/pet/retry']({ id: made.id, stage: 'waiting' }), /明确确认/);
  await reopened.handlers['studio/pet/retry']({ id: made.id, stage: 'waiting', confirmRegenerate: true });
  await waitFor(async () => (await reopened.handlers['studio/pet/read']({ jobId: made.id })).status === 'succeeded', 'explicit single stage retry', 40000);
  const done = await reopened.handlers['studio/pet/read']({ jobId: made.id });
  assert.equal(requests.length, 11); assert.equal(requests.filter(v => v === 'waiting').length, 2);
  assert.equal(done.pipeline.steps.waiting.attempt, 1);
  assert.equal(done.pipeline.steps.waiting.priorAttempts[0].jobId, oldJob);
  assert.notEqual(done.pipeline.steps.waiting.jobId, oldJob);
});
