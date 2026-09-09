'use strict';
// ComfyUI HTTP API adapter. Reuses a user's exported API workflow; no nodes,
// Python modules, models or third-party ComfyUI code are shipped or installed.
// Source: Comfy-Org/ComfyUI server.py /prompt, /history/{id}, /view, /upload/image.
const crypto=require('node:crypto');
const { inspectWorkflow }=require('./studio-workflow');
const fail=message=>{const e=new Error(message);e.rpc={code:-32602,message};throw e;};
function binding(p,key){const value=p.custom?.bindings?.[key];return value&&typeof value.node==='string'&&typeof value.input==='string'?value:null;}
function bind(workflow,p,key,value){const b=binding(p,key);if(!b){if(value!==undefined)fail(`ComfyUI 工作流未配置 ${key} 输入位置`);return;}const node=workflow[b.node];if(!node?.inputs||!Object.hasOwn(node.inputs,b.input)||['__proto__','constructor','prototype'].includes(b.input))fail(`ComfyUI ${key} 绑定不存在`);node.inputs[b.input]=value;}
module.exports={
  inputCapabilities(p){return {maxReferences:p.kind==='image'&&binding(p,'reference')?1:0,firstFrame:p.kind==='video'&&!!binding(p,'firstFrame'),lastFrame:p.kind==='video'&&!!binding(p,'lastFrame'),requiresFirstFrame:false,requiresLastFrame:false};},
  async submit(p,input,refs,{request,signal}){
    inspectWorkflow(p.custom?.workflow,p.custom?.bindings);
    const graph=structuredClone(p.custom?.workflow);if(!graph||Array.isArray(graph)||typeof graph!=='object'||!Object.keys(graph).length||Object.keys(graph).length>500)fail('请在 ComfyUI 连接中配置导出的 API 工作流');
    bind(graph,p,'prompt',input.prompt);for(const key of ['seconds','size','aspect','count'])if(binding(p,key))bind(graph,p,key,input[key]);
    for(const ref of refs){const key=p.kind==='image'?'reference':ref.role;if(!binding(p,key))fail(`ComfyUI 未声明 ${key} 支持`);const form=new FormData();form.append('image',new Blob([ref.bytes],{type:ref.mime}),`knorvia-${crypto.randomUUID()}.png`);form.append('overwrite','false');const uploaded=await request(p,'upload/image',{method:'POST',body:form,signal});if(typeof uploaded.name!=='string'||uploaded.name.includes('..')||typeof uploaded.subfolder==='string'&&uploaded.subfolder.includes('..'))fail('ComfyUI 返回无效素材路径');bind(graph,p,key,[uploaded.subfolder,uploaded.name].filter(Boolean).join('/'));}
    return {endpoint:'prompt',method:'POST',body:{prompt:graph,client_id:crypto.randomUUID()}};
  },
  normalizeState(p,result,previous={}){const id=result.prompt_id??previous.id;if(!id)fail('ComfyUI 未返回 prompt_id');const item=result[id];const outputs=[];if(item)for(const [node,value]of Object.entries(item.outputs??{})){if(p.custom.outputNode&&node!==p.custom.outputNode)continue;for(const media of [...(value.images??[]),...(value.gifs??[]),...(value.videos??[])])if(typeof media.filename==='string'){const query=new URLSearchParams({filename:media.filename,subfolder:media.subfolder??'',type:media.type??'output'});outputs.push({apiContent:`view?${query}`});}}
    return {id,statusUrl:`history/${encodeURIComponent(id)}`,done:item?.status?.completed===true,failed:item?.status?.status_str==='error'||!!result.error,outputs,...(p.custom.targetedCancel===true?{cancelUrl:`api/jobs/${encodeURIComponent(id)}/cancel`,cancelMethod:'POST'}:{})};},
  poll:(p,remote,{request,signal})=>request(p,remote.statusUrl,{signal}),normalizeUsage:()=>undefined,
};
