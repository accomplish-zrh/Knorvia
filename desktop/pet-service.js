'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const P=require('./studio-providers'),A=require('./pet-atlas');
const {validatePackage,exportPackage}=require('./pet-package');const {createPetWorkflow}=require('./pet-workflow');const {withLock,tryLock}=require('./media-lock');
const METHODS=['studio/pet/list','studio/pet/read','studio/pet/create','studio/pet/resume','studio/pet/cancel','studio/pet/select','studio/pet/import','studio/pet/export','studio/pet/repair','studio/pet/retry'];
function createPetService({home,rpc,studio,playback}){
  const root=path.join(studio.root,'pets'),selection=path.join(home,'config','studio','pet-selection.json');fs.mkdirSync(root,{recursive:true});
  const workflow=createPetWorkflow({studio,packagesRoot:root}),active=new Map(),cache=new Map();let closed=false;
  const folder=id=>path.join(root,P.id(id));
  const selected=()=>{try{return JSON.parse(fs.readFileSync(selection,'utf8'));}catch{return {id:null};}};
  const record=id=>{const dir=folder(id),sheetFile=path.join(dir,'spritesheet.png');let stamp;try{stamp=fs.statSync(sheetFile).mtimeMs+':'+fs.statSync(path.join(dir,'pet.json')).mtimeMs;}catch{}
    if(stamp&&cache.get(id)?.stamp===stamp)return cache.get(id).value;const v=validatePackage(dir);const value={id,manifest:v.manifest,atlasSha256:v.atlasSha256,layout:v.layout,qa:v.qa};if(stamp)cache.set(id,{stamp,value});return value;};
  const view=job=>({id:job.id,status:job.status,...job.checkpoint});
  async function readJob(id){const job=await rpc('job/read',{id:P.id(id)});if(job.type!=='pet.hatch')P.fail('此任务不是宠物创建任务');return job;}
  async function run(id,controller){const lock=tryLock(path.join(root,`${id}.lock`));if(!lock)return;try{
    const job=await readJob(id);if(job.status!=='running')return;let c=job.checkpoint;
    try{const result=await workflow.createFromImagegen({...c.input,agent:c.agentRequested,idempotencyKey:id,signal:controller.signal,state:c.pipeline??{},checkpoint:async pipeline=>{c={...c,pipeline,phase:pipeline.phase};await rpc('job/checkpoint',{jobId:id,checkpoint:c});}});
      c={...c,phase:'candidate',candidateId:result.manifest.id,qa:result.qa};await rpc('job/checkpoint',{jobId:id,checkpoint:c});await rpc('job/finish',{jobId:id,status:'succeeded'});
    }catch(error){const message=error.rpc?.message||'宠物生成暂时停止，已保存进度';await rpc('job/checkpoint',{jobId:id,checkpoint:{...c,phase:controller.signal.aborted?'paused':'needs-attention',error:message}});}
  }finally{lock.release();}}
  function schedule(id){if(closed||active.has(id))return;const controller=new AbortController();const promise=run(id,controller).catch(e=>console.error('[pet-service]',e)).finally(()=>active.delete(id));active.set(id,{controller,promise});}
  async function create(p,agent=false){await studio.initialize();const profile=studio.profiles.get(P.id(p.profileId));if(profile.kind!=='image'||!P.inputCapabilities(profile).maxReferences)P.fail('请选择支持参考图的图片模型');if(agent&&!profile.agentEnabled)P.fail('此模型未允许 Agent 使用');
    const key=P.id(p.idempotencyKey||crypto.randomUUID()), input={profileId:profile.id,prompt:P.text(p.prompt,4000),name:P.text(p.name||'新伙伴',80),...(p.reference?{reference:p.reference}:{}),...(p.repairRow?{repairRow:p.repairRow,repairSource:p.repairSource}:{})};
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return withLock(path.join(root,`create-${key}.lock`),async()=>{const made=await rpc('job/create',{workspaceId:studio.workspaceId(),type:'pet.hatch',idempotencyKey:`hatch-${key}`});let job=await readJob(made.id);
      if(job.checkpoint){if(job.checkpoint.fingerprint!==fingerprint)P.fail('同一创建标识不能用于不同宠物描述');return view(job);}
      job=await rpc('job/checkpoint',{jobId:job.id,checkpoint:{input,fingerprint,agentRequested:agent,phase:'queued',pipeline:{steps:{}}}});schedule(job.id);return view(job);});}
  const handlers={
    'studio/pet/list':async()=>{await studio.initialize();const packages=[],invalid=[];for(const item of fs.readdirSync(root,{withFileTypes:true})){if(!item.isDirectory()||!fs.existsSync(path.join(root,item.name,'pet.json')))continue;try{packages.push(record(item.name));}catch{invalid.push(item.name);}}
      const jobs=await rpc('job/list',{workspaceId:studio.workspaceId(),typePrefix:'pet.hatch',limit:50,offset:0});return {packages,invalid,selected:selected(),jobs:jobs.jobs.map(job=>({...view(job),active:active.has(job.id)}))};},
    'studio/pet/read':async p=>{if(p.jobId)return view(await readJob(p.jobId));const item=record(p.id);const file=path.join(folder(item.id),item.manifest.spritesheetPath);const media=await playback.issue({file,name:item.manifest.spritesheetPath,mime:/\.webp$/i.test(file)?'image/webp':'image/png',sha256:item.atlasSha256});return {...item,...media};},
    'studio/pet/create':p=>create({name:p.name,prompt:p.prompt,profileId:p.profileId,reference:p.reference,idempotencyKey:p.idempotencyKey}),
    'studio/pet/resume':async p=>{const job=await readJob(p.id);if(job.status!=='running')P.fail('此宠物任务已结束');schedule(job.id);return view(job);},
    'studio/pet/cancel':async p=>{const job=await readJob(p.id),running=active.get(job.id);running?.controller.abort();await running?.promise;return view(await readJob(job.id));},
    'studio/pet/retry':async p=>{if(p.confirmRegenerate!==true)P.fail('重新生成会新建图片请求，可能再次计费，请明确确认');const id=P.id(p.id),running=active.get(id);running?.controller.abort();await running?.promise;await withLock(path.join(root,`${id}.lock`),async()=>{const job=await readJob(id);if(job.status!=='running')P.fail('已完成的宠物请使用单行修复');const stage=p.stage;if(!['base',...A.ROWS].includes(stage))P.fail('未知宠物动作');const old=job.checkpoint.pipeline?.steps?.[stage];if(!old?.jobId)P.fail('此动作尚未提交');if(stage==='base'&&Object.keys(job.checkpoint.pipeline.steps).length>1)P.fail('已有动作依赖身份图，请新建宠物以保持身份一致');const pipeline=structuredClone(job.checkpoint.pipeline);pipeline.steps[stage]={attempt:(old.attempt??0)+1,priorAttempts:[...(old.priorAttempts??[]),{jobId:old.jobId,attempt:old.attempt??0}]};await rpc('job/checkpoint',{jobId:id,checkpoint:{...job.checkpoint,pipeline,phase:'queued',error:undefined}});});schedule(id);return view(await readJob(id));},
    'studio/pet/select':async p=>{if(p.id===null){P.atomic(selection,{id:null});return {id:null};}const item=record(p.id);if(!item.qa.passed)P.fail('宠物图集未通过检查');if(p.reviewed!==true)P.fail('请预览全部动作后确认选用');const value={id:item.id,atlasSha256:item.atlasSha256,reviewedAt:new Date().toISOString()};P.atomic(selection,value);return value;},
    'studio/pet/import':async p=>{const source=validatePackage(P.text(p.directory,4096));if(!source.qa.passed)P.fail(`宠物包检查失败：${source.qa.errors.join('；')}`);const id=`import-${crypto.randomUUID()}`,dir=folder(id);exportPackage({sourceDir:source.dir,targetDir:dir});return record(id);},
    'studio/pet/export':async p=>{const item=record(p.id),target=path.join(home,'exports','pets',`${item.id}-${crypto.randomUUID().slice(0,8)}`);return exportPackage({sourceDir:folder(item.id),targetDir:target});},
    'studio/pet/repair':async p=>{const item=record(p.id);if(!A.ROWS.includes(p.row))P.fail('请选择需要修复的动作');let provenance;try{provenance=JSON.parse(fs.readFileSync(path.join(folder(item.id),'provenance.json'),'utf8'));}catch{P.fail('此宠物没有可修复的生成记录');}return create({...p,name:item.manifest.displayName,prompt:p.prompt||item.manifest.description,repairRow:p.row,repairSource:{...provenance,id:item.id,dir:folder(item.id)}},p.agentRequested===true);},
  };
  return {handlers,create,async close(){closed=true;for(const a of active.values())a.controller.abort();await Promise.allSettled([...active.values()].map(a=>a.promise));}};
}
module.exports={createPetService,METHODS};
