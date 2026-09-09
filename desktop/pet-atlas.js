'use strict';
// Geometry follows openai/skills hatch-pet (Apache-2.0):
// references/animation-rows.md and codex-pet-contract.md. This module only
// processes existing generated images; it never invents missing poses.
const fs = require('node:fs'); const zlib = require('node:zlib'); const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { resolveBinaries } = require('./media-frame-worker');
const ROWS = ['idle', 'running-right', 'running-left', 'waving', 'jumping', 'failed', 'waiting', 'running', 'review'];
const COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6];
const DURATIONS = [[280,110,110,140,140,320], [120,120,120,120,120,120,120,220], [120,120,120,120,120,120,120,220], [140,140,140,280], [140,140,140,140,280], [140,140,140,140,140,140,140,240], [150,150,150,150,150,260], [120,120,120,120,120,220], [150,150,150,150,150,280]];
const fail = message => { const e = new Error(message); e.rpc = { code: -32602, message }; throw e; };
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const table = Array.from({length:256}, (_, n) => { for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0; });
const crc = bytes => { let c=0xffffffff; for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0; };
function pngInfo(bytes) {
  if(!bytes.subarray(0,8).equals(signature)) fail('图片不是 PNG');
  let at=8,header,idat=[],ended=false;
  while(at+12<=bytes.length){ const n=bytes.readUInt32BE(at),type=bytes.toString('ascii',at+4,at+8);if(n>bytes.length-at-12)fail('PNG 文件被截断'); const payload=bytes.subarray(at+8,at+8+n);if(crc(bytes.subarray(at+4,at+8+n))!==bytes.readUInt32BE(at+8+n))fail('PNG 校验失败');
    if(!header&&type!=='IHDR')fail('PNG 头部无效');if(type==='IHDR'){if(header||n!==13)fail('PNG 头部无效');header={width:payload.readUInt32BE(0),height:payload.readUInt32BE(4),depth:payload[8],color:payload[9],interlace:payload[12]};}if(type==='IDAT')idat.push(payload);at+=n+12;if(type==='IEND'){ended=true;break;}}
  if(!ended||!idat.length||!header||header.width<1||header.height<1||header.width*header.height>16*1024*1024)fail('PNG 尺寸或内容无效');
  // Decode is delegated to FFmpeg for all legal PNG color/interlace formats.
  return header;
}
function readImage(file) {
  const bytes=fs.readFileSync(file); if(bytes.length>32*1024*1024)fail('宠物素材超过 32 MB');
  const binaries=resolveBinaries({}); let width,height;
  if(bytes.subarray(0,8).equals(signature)){({width,height}=pngInfo(bytes));}
  else {let meta;try{meta=JSON.parse(execFileSync(binaries.ffprobe,['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',file],{windowsHide:true,timeout:15000,maxBuffer:65536}).toString());}catch{fail('宠物图片无法解码');}({width,height}=meta.streams?.[0]??{});}
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>16*1024*1024)fail('宠物图片尺寸无效');
  let rgba;try{rgba=execFileSync(binaries.ffmpeg,['-nostdin','-v','error','-xerror','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{windowsHide:true,timeout:20000,maxBuffer:width*height*4+65536});}catch{fail('宠物图片无法完整解码');}
  if(rgba.length!==width*height*4)fail('宠物图片像素不完整');return {width,height,rgba};
}
function chunk(type,payload){const out=Buffer.alloc(payload.length+12);out.writeUInt32BE(payload.length,0);out.write(type,4,'ascii');payload.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out;}
function encodePng({width,height,rgba}){if(rgba.length!==width*height*4)fail('像素长度不匹配');const h=Buffer.alloc(13);h.writeUInt32BE(width,0);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;const scan=Buffer.alloc((width*4+1)*height);for(let y=0;y<height;y++)rgba.copy(scan,y*(width*4+1)+1,y*width*4,(y+1)*width*4);return Buffer.concat([signature,chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(scan,{level:9})),chunk('IEND',Buffer.alloc(0))]);}
function bounds(image,x0,y0,w,h){let left=w,top=h,right=-1,bottom=-1,opaque=0,nonzero=0,edge=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const a=image.rgba[((y0+y)*image.width+x0+x)*4+3];if(a)nonzero++;if(a>16){opaque++;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);if(x===0||y===0||x===w-1||y===h-1)edge++;}}return {left,top,right,bottom,opaque,nonzero,edge,width:right-left+1,height:bottom-top+1};}
function inspectAtlas(image,{rows=9}={}){
  if(image.width!==1536||image.height!==rows*208)fail('精灵图尺寸必须与 192×208 固定格子匹配');
  const errors=[],warnings=[],frames=[];for(let row=0;row<rows;row++){const hashes=[];for(let col=0;col<8;col++){const b=bounds(image,col*192,row*208,192,208),used=col<(COUNTS[row]??8);if(used&&b.opaque<80)errors.push(`${ROWS[row]??row} 第 ${col+1} 帧为空`);if(used&&b.opaque>192*208*.95)errors.push(`${ROWS[row]??row} 第 ${col+1} 帧背景不透明`);if(!used&&b.nonzero)errors.push(`${ROWS[row]} 未使用格子必须透明`);if(used&&b.edge>6)warnings.push(`${ROWS[row]??row} 第 ${col+1} 帧贴近边缘，请检查裁切`);const cell=Buffer.alloc(192*208*4);for(let y=0;y<208;y++)image.rgba.copy(cell,y*192*4,((row*208+y)*1536+col*192)*4,((row*208+y)*1536+(col+1)*192)*4);if(used)hashes.push(crypto.createHash('sha256').update(cell).digest('hex'));frames.push({row,col,used,opaque:b.opaque});}if(new Set(hashes).size<2)warnings.push(`${ROWS[row]??row} 各帧相同，需要检查动作`);}
  return {passed:!errors.length,errors,warnings,frames,visualReviewRequired:true};
}
// Every row comes from its own grounded model output. Fixed slots retain
// original frame order; one scale per row avoids per-frame size popping.
function normalizeRow(image,row){const count=COUNTS[row];if(!count)fail('未知宠物动作');if(image.width/count<16||image.height<16)fail('动作条分辨率太小');const sw=Math.floor(image.width/count),parts=Array.from({length:count},(_,i)=>bounds(image,i*sw,0,sw,image.height));if(parts.some(b=>b.opaque<32||b.opaque>sw*image.height*.95))fail(`${ROWS[row]} 动作条存在空白或不透明背景`);if(parts.some(b=>b.edge>Math.max(8,sw*.1)))fail(`${ROWS[row]} 动作触及格子边缘，可能被裁切，请修复该行`);const maxW=Math.max(...parts.map(b=>b.width)),maxH=Math.max(...parts.map(b=>b.height));const scale=Math.min(172/maxW,188/maxH);const out={width:1536,height:208,rgba:Buffer.alloc(1536*208*4)};parts.forEach((b,col)=>{const w=Math.max(1,Math.round(b.width*scale)),h=Math.max(1,Math.round(b.height*scale));for(let y=0;y<h;y++)for(let x=0;x<w;x++){const sx=col*sw+b.left+Math.min(b.width-1,Math.floor(x/scale)),sy=b.top+Math.min(b.height-1,Math.floor(y/scale));const from=(sy*image.width+sx)*4,to=((198-h+y)*1536+col*192+Math.floor((192-w)/2)+x)*4;image.rgba.copy(out.rgba,to,from,from+4);}});return out;}
function assemble(rows){if(rows.length!==9)fail('需要九种完整动作');const out={width:1536,height:1872,rgba:Buffer.alloc(1536*1872*4)};rows.forEach((row,index)=>{if(row.width!==1536||row.height!==208)fail('动作条尺寸不匹配');row.rgba.copy(out.rgba,index*1536*208*4);});return out;}
module.exports={ROWS,COUNTS,DURATIONS,pngInfo,readImage,encodePng,inspectAtlas,normalizeRow,assemble};
