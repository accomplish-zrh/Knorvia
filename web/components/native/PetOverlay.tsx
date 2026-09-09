"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cat, Settings2, X } from 'lucide-react';
import { createPetRuntime, PET_LAYOUTS, type PetCandidate, type PetIndex, type PetState } from '@/lib/native-pet';
import { useLocalPreference } from './useLocalPreference';
import { useWorkbench } from './NativeWorkbenchProvider';
import { PetManager } from './PetManager';
type Translater=(zh:string,en:string)=>string;
export function PetOverlay({t,state='idle'}:{t:Translater;state?:PetState}){
  const {request,connection}=useWorkbench();
  const [enabled,setEnabled]=useLocalPreference('knorvia-pet-enabled-v1',raw=>raw==='true');
  const [scale,setScale]=useLocalPreference('knorvia-pet-scale-v1',raw=>Math.min(1,Math.max(.5,Number(raw)||.75)));
  const [position,setPosition]=useLocalPreference('knorvia-pet-pos-v1',parsePosition);
  const [draft,setDraft]=useState<{x:number;y:number}|null>(null),[dragging,setDragging]=useState(false),[manager,setManager]=useState(false),[reduced,setReduced]=useState(false),[visible,setVisible]=useState(true);
  const [pet,setPet]=useState<PetCandidate|null>(null),[cell,setCell]=useState({index:0,x:0,y:0});const offset=useRef({x:0,y:0});
  const refresh=useCallback(async()=>{try{const data=await request<PetIndex>('studio/pet/list');setPet(data.selected.id?await request<PetCandidate>('studio/pet/read',{id:data.selected.id}):null);}catch{/* Keep the current companion if the service reconnects. */}},[request]);
  useEffect(()=>{if(!enabled)return;const initial=setTimeout(()=>void refresh(),0);const renewal=setInterval(()=>{if(!document.hidden)void refresh();},20*60*1000);return()=>{clearTimeout(initial);clearInterval(renewal);};},[enabled,connection,refresh]);
  useEffect(()=>{const open=()=>setManager(true);window.addEventListener('knorvia-open-pets',open);return()=>window.removeEventListener('knorvia-open-pets',open);},[]);
  useEffect(()=>{const query=matchMedia('(prefers-reduced-motion: reduce)');const sync=()=>{setReduced(query.matches||!!document.querySelector('[data-reduce-motion="true"]'));setVisible(!document.hidden);};sync();query.addEventListener('change',sync);document.addEventListener('visibilitychange',sync);const observer=new MutationObserver(sync);observer.observe(document.documentElement,{attributes:true,subtree:true,attributeFilter:['data-reduce-motion']});return()=>{query.removeEventListener('change',sync);document.removeEventListener('visibilitychange',sync);observer.disconnect();};},[]);
  const runtime=useMemo(()=>createPetRuntime({layout:pet?.layout??PET_LAYOUTS[1],reducedMotion:reduced}),[pet?.layout,reduced]);
  useEffect(()=>{runtime.setState(state);},[runtime,state]);
  useEffect(()=>{if(!enabled||!visible)return;const update=()=>{const next=runtime.frame();if(next)setCell(old=>old.index===next.index?old:{index:next.index,x:next.x,y:next.y});};update();if(reduced)return;const timer=setInterval(update,60);return()=>clearInterval(timer);},[enabled,visible,reduced,runtime,state]);
  const clamp=useCallback((p:{x:number;y:number})=>({x:Math.max(8,Math.min(window.innerWidth-192*scale-8,p.x)),y:Math.max(40,Math.min(window.innerHeight-208*scale-48,p.y))}),[scale]);
  const [screen,setScreen]=useState({width:1000,height:800});useEffect(()=>{const sync=()=>setScreen({width:innerWidth,height:innerHeight});sync();addEventListener('resize',sync);return()=>removeEventListener('resize',sync);},[]);
  const initial={x:screen.width-192*scale-20,y:screen.height-208*scale-74},pos=draft??(position.x===0&&position.y===0?initial:position);
  const safe={x:Math.max(8,Math.min(screen.width-192*scale-8,pos.x)),y:Math.max(40,Math.min(screen.height-208*scale-48,pos.y))};
  const finish=()=>{if(draft)setPosition(()=>clamp(draft));setDraft(null);setDragging(false);};
  return <>{!enabled?<button className="pet-toggle" aria-label={t('宠物伙伴','Companions')} onClick={()=>setManager(true)}><Cat size={16}/></button>:<div className={`pet-overlay${dragging?' is-dragging':''}`} style={{transform:`translate(${safe.x}px,${safe.y}px)`,['--pet-scale' as string]:String(scale)}} data-pet-state={state}>
    <div className="pet-canvas" role="button" tabIndex={0} aria-label={t('移动宠物伙伴，方向键微调','Move companion; arrow keys adjust position')} onKeyDown={e=>{const moves:Record<string,[number,number]>={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]};const m=moves[e.key];if(m){e.preventDefault();setPosition(()=>clamp({x:safe.x+m[0],y:safe.y+m[1]}));}}} onPointerDown={e=>{if(e.button!==0)return;offset.current={x:e.clientX-safe.x,y:e.clientY-safe.y};setDragging(true);e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(dragging)setDraft(clamp({x:e.clientX-offset.current.x,y:e.clientY-offset.current.y}));}} onPointerUp={finish} onPointerCancel={finish}>
      {pet?.url?<div className="pet-sprite" style={{backgroundImage:`url("${pet.url}")`,backgroundPosition:`-${cell.x}px -${cell.y}px`,width:192,height:208}}/>:<svg className={`pet-builtin ${reduced?'is-still':''}`} viewBox="0 0 192 208" aria-hidden="true"><defs><linearGradient id="kn-pet-body" x2="0" y2="1"><stop stopColor="#d9fff2"/><stop offset="1" stopColor="#69bba9"/></linearGradient></defs><g className="pet-builtin-body"><path d="M49 77 43 39Q65 34 78 57Q95 50 114 58Q134 34 151 41L143 81Q160 98 153 139Q149 172 128 176L128 184Q113 196 102 182L90 182Q78 195 65 185L64 175Q39 170 38 139Q31 99 49 77Z" fill="url(#kn-pet-body)" stroke="#397c70" strokeWidth="3"/><path d="m50 46 5 25 15-12m57 2 15-14-4 28" fill="#efa9b4" opacity=".75"/><g className="pet-builtin-eyes" fill="#214c49"><ellipse cx="71" cy="106" rx="6" ry="8"/><ellipse cx="119" cy="106" rx="6" ry="8"/></g><path d="m89 120 7 5 7-5m-7 5v7m0 0q-8 9-16 0m16 0q8 9 16 0" stroke="#397c70" strokeWidth="3" fill="none" strokeLinecap="round"/><ellipse cx="60" cy="123" rx="8" ry="4" fill="#eaa9b8" opacity=".7"/><ellipse cx="132" cy="123" rx="8" ry="4" fill="#eaa9b8" opacity=".7"/></g></svg>}
    </div><div className="pet-controls"><button className="pet-control" aria-label={t('宠物设置','Companion settings')} onClick={()=>setManager(true)}><Settings2 size={13}/></button><button className="pet-control" aria-label={t('缩小','Smaller')} onClick={()=>setScale(n=>Math.max(.5,n-.125))}>−</button><button className="pet-control" aria-label={t('放大','Larger')} onClick={()=>setScale(n=>Math.min(1,n+.125))}>+</button><button className="pet-control" aria-label={t('复位位置','Reset position')} onClick={()=>setPosition(()=>({x:0,y:0}))}>⟲</button><button className="pet-control" aria-label={t('隐藏伙伴','Hide companion')} onClick={()=>setEnabled(()=>false)}><X size={13}/></button></div></div>}
    {manager&&<PetManager close={()=>setManager(false)} changed={()=>{setEnabled(()=>true);void refresh();}}/>}
  </>;
}
function parsePosition(raw:string):{x:number;y:number}{try{const p=JSON.parse(raw);if(Number.isFinite(p?.x)&&Number.isFinite(p?.y))return p;}catch{}return{x:0,y:0};}
