'use strict';
// Grounded hatch pipeline: one identity image, then nine distinct pose rows.
// Only real studio outputs are processed. No copied/tiled pose substitutes.
const crypto = require('node:crypto'); const fs = require('node:fs'); const path = require('node:path');
const P = require('./studio-providers'); const A = require('./pet-atlas'); const { validatePackage } = require('./pet-package');
const terminal = job => ['succeeded','failed','cancelled'].includes(job.status);
const instructions = 'One isolated full-body pet, transparent background, no scene, labels, shadows, guide lines or detached effects. Preserve the same identity, face, markings, materials, colors and proportions in all poses.';
function createPetWorkflow({studio, packagesRoot}){
  fs.mkdirSync(packagesRoot,{recursive:true});
  return {async createFromImagegen({prompt,profileId,reference,name,idempotencyKey,signal,timeoutMs=240000,agent=false,state={},checkpoint=async()=>{},repairRow,repairSource}={}){
    const cleanPrompt=P.text(prompt,4000), safeName=P.text(name,80)||'新伙伴', key=P.id(idempotencyKey||crypto.randomUUID());if(!cleanPrompt)P.fail('创建宠物需要描述提示词');
    const profile=studio.profiles.get(P.id(profileId)); if(profile.kind!=='image'||!P.inputCapabilities(profile).maxReferences)P.fail('请选择支持参考图的图片模型来创建宠物');
    const petId=`pet-${key}`.slice(0,90), dir=path.join(path.resolve(packagesRoot),petId);fs.mkdirSync(dir,{recursive:true});
    state.steps ??= {}; const save=async patch=>{Object.assign(state,patch);await checkpoint({...state,steps:{...state.steps}});};
    const generate=async(stage,stagePrompt,refs)=>{
      signal?.throwIfAborted();let step=state.steps[stage];
      if(!step?.jobId){await save({phase:`generating-${stage}`});const attempt=step?.attempt??0;const job=await studio.create({profileId,prompt:stagePrompt,references:refs,count:1,size:stage==='base'?'1024x1024':'1536x1024',idempotencyKey:`hatch-${key}-${stage}-${attempt}`},agent);step={...step,attempt,jobId:job.id};state.steps[stage]=step;await save({});}
      let job=await studio.handlers['studio/read']({id:step.jobId}),until=Date.now()+timeoutMs;
      while(!terminal(job)){
        signal?.throwIfAborted(); if(['unknown','paused','needs-connection','stopped'].includes(job.phase))P.fail(`宠物动作 ${stage} 的生成已暂停或结果未知，请先处理创作任务 ${job.id}`);
        if(Date.now()>until)P.fail('生成仍在进行，稍后继续会追踪原任务');
        await new Promise(r=>setTimeout(r,200));job=await studio.handlers['studio/read']({id:job.id});
      }
      if(job.status!=='succeeded'||!job.outputs?.length)P.fail(`宠物动作 ${stage} 生成失败：${job.error||job.status}`);
      const file=path.join(dir,`${stage}-${step.attempt??0}-source.png`);
      if(!fs.existsSync(file)){let offset=0,chunks=[],size=0;for(;;){const part=await studio.handlers['studio/content']({id:job.id,index:0,offset});const bytes=Buffer.from(part.base64,'base64');chunks.push(bytes);size+=bytes.length;if(size>32*1024*1024)P.fail('宠物源图片过大');if(part.nextOffset===null)break;if(part.nextOffset<=offset)P.fail('宠物图片读取未前进');offset=part.nextOffset;}fs.writeFileSync(file,Buffer.concat(chunks),{flag:'wx'});}
      if(!step.reference){const entry=await studio.handlers['studio/library']({id:job.id,index:0,path:`宠物/素材/${petId}/${stage}-${step.attempt??0}.png`});step.reference={id:entry.id,version:entry.sha256};await save({});}
      return {file,step};
    };
    let base;
    if(repairSource){base={step:{reference:repairSource.baseReference}};if(!base.step.reference)P.fail('原宠物缺少身份参考，无法只修复一行');}
    else base=await generate('base',`${cleanPrompt}\n\n${instructions}`,reference?[reference]:[]);
    const rows=[],sources=[];
    for(let row=0;row<9;row++){
      const stage=A.ROWS[row], target=path.join(dir,`${stage}-row.png`);
      if(repairSource&&repairRow!==stage){const original=path.join(repairSource.dir,`${stage}-row.png`);if(!fs.existsSync(target))fs.copyFileSync(original,target,fs.constants.COPYFILE_EXCL);rows.push(A.readImage(target));sources.push(repairSource.sources?.[row]);continue;}
      const generated=await generate(stage,`${cleanPrompt}\n\n${instructions}\nCreate a horizontal strip of exactly ${A.COUNTS[row]} evenly spaced, separate frames in left-to-right chronological order. State: ${stage}. Each frame shows the entire same pet from the attached identity reference. Give every frame generous transparent padding. No grid or labels. ${stage==='running'?'Focused working/thinking poses, not physical running.':''} ${stage==='running-right'?'Face and move right, alternating gait.':''} ${stage==='running-left'?'Face and move left, alternating gait.':''}`, [base.step.reference]);
      const normalized=A.normalizeRow(A.readImage(generated.file),row),versionFile=path.join(dir,`${stage}-row-${generated.step.attempt??0}.png`);if(!fs.existsSync(versionFile))fs.writeFileSync(versionFile,A.encodePng(normalized),{flag:'wx'});const rowTemp=`${target}.${crypto.randomUUID()}.tmp`;fs.copyFileSync(versionFile,rowTemp);fs.renameSync(rowTemp,target);rows.push(normalized);sources.push({state:stage,jobId:generated.step.jobId,reference:generated.step.reference});await save({completedRows:row+1});
    }
    await save({phase:'checking'});const atlas=A.assemble(rows),qa=A.inspectAtlas(atlas);P.atomic(path.join(dir,'qa.json'),qa);if(!qa.passed)P.fail(`宠物图集未通过检查：${qa.errors.join('；')}`);
    const sheet=path.join(dir,'spritesheet.png');if(!fs.existsSync(sheet))fs.writeFileSync(sheet,A.encodePng(atlas),{flag:'wx'});
    const manifest={schemaVersion:1,id:petId,displayName:safeName,description:cleanPrompt.slice(0,300),spritesheetPath:'spritesheet.png'};
    P.atomic(path.join(dir,'pet.json'),manifest);P.atomic(path.join(dir,'manifest.json'),manifest);
    const provenance={strategy:'grounded-rows-stable-slots-v1',baseReference:base.step.reference,sources,repairOf:repairSource?.id,repairRow,generatedAt:new Date().toISOString(),visualReviewRequired:true};P.atomic(path.join(dir,'provenance.json'),provenance);
    const validated=validatePackage(dir);return {packageDir:dir,manifest:validated.manifest,atlasSha256:validated.atlasSha256,qa:validated.qa,baseReference:base.step.reference,sources,jobId:state.steps.base?.jobId};
  }};
}
module.exports={createPetWorkflow};
