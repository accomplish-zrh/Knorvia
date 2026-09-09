const path=require('node:path');const sharp=require('../../web/node_modules/sharp');
const bytes=Buffer.alloc(128*128*4);let seed=79;for(let i=0;i<128*128;i++){seed=(seed*1664525+1013904223)>>>0;const n=seed%255;bytes.set([n,n,n,80],i*4);}
sharp(bytes,{raw:{width:128,height:128,channels:4}}).png().toFile(path.join(__dirname,'../assets/grain.png'));
