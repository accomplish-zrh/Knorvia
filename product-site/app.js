(() => {
 'use strict';
 const reduce=matchMedia('(prefers-reduced-motion: reduce)');
 if('IntersectionObserver' in window){const lazy=new IntersectionObserver(entries=>{if(!entries.some(e=>e.isIntersecting))return;lazy.disconnect();import('./creation-scene.js').then(m=>m.mount()).catch(()=>{});},{rootMargin:'300px'});lazy.observe(document.querySelector('.frame-scene'));}
 const navButton=document.querySelector('.menu-toggle'),mobileNav=document.querySelector('#mobile-menu');
 function setMenu(open,restore=false){navButton.setAttribute('aria-expanded',String(open));navButton.setAttribute('aria-label',open?'关闭导航':'打开导航');mobileNav.hidden=!open;if(restore)navButton.focus();}
 navButton.addEventListener('click',()=>setMenu(mobileNav.hidden));
 mobileNav.addEventListener('click',e=>{if(e.target.closest('a'))setMenu(false);});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!mobileNav.hidden)setMenu(false,true);});
 document.addEventListener('click',e=>{if(!mobileNav.hidden&&!e.target.closest('.site-header'))setMenu(false);});
 matchMedia('(min-width: 901px)').addEventListener('change',e=>{if(e.matches)setMenu(false);});
 const tabs=[...document.querySelectorAll('[data-screen]')],panels=tabs.map(t=>document.getElementById(t.getAttribute('aria-controls')));
 const descriptions=[['把一句想法，交给工作台。','按项目整理任务，在对话里推进目标，让文件、工具和预览始终在手边。'],['把资料展开，也把思路展开。','收藏、查看、修改个人资料，让完成的内容成为下一次创作的起点。'],['从一个画面，走到下一帧。','围绕同一个创作过程，组织参考图、提示词、图片和分镜队列。'],['让不同擅长的伙伴，坐在一起。','给 Bot 各自的角色和上下文。单独交流，或一起完成需要配合的工作。'],['留住有用的，整理记住的。','看看工作台保存了什么，按自己的需要整理、修改和删除。']];
 let story=null,selected=0;
 function select(i,focus=false){selected=i;tabs.forEach((tab,j)=>{const active=i===j;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;panels[j].hidden=story?false:!active;panels[j].inert=!active;panels[j].setAttribute('aria-hidden',String(!active));});document.querySelector('#story-number').textContent=String(i+1).padStart(2,'0');document.querySelector('#story-heading').textContent=descriptions[i][0];document.querySelector('#preview-description').textContent=descriptions[i][1];if(!story&&!reduce.matches)panels[i].animate([{opacity:.45,transform:'translateY(9px)'},{opacity:1,transform:'translateY(0)'}],{duration:350,easing:'cubic-bezier(.2,.8,.2,1)'});if(focus)tabs[i].focus({preventScroll:true});}
 function activate(i,focus=false){if(story){const st=story.trigger,y=st.start+(st.end-st.start)*story.stops[i]/story.timeline.duration();window.scrollTo({top:y+1,behavior:'smooth'});if(focus)tabs[i].focus({preventScroll:true});}else select(i,focus);}
 tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>activate(i));tab.addEventListener('keydown',e=>{const next={ArrowRight:(i+1)%tabs.length,ArrowLeft:(i+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[e.key];if(next===undefined)return;e.preventDefault();activate(next,true);});});
 select(0);
 if(window.gsap&&window.ScrollTrigger){
  const {gsap,ScrollTrigger}=window;gsap.registerPlugin(ScrollTrigger);const media=gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)',()=>{
   gsap.fromTo('.enter',{y:24,opacity:0},{y:0,opacity:1,duration:1.1,stagger:.1,ease:'power3.out',clearProps:'transform,opacity'});
   gsap.fromTo('.hero-wordmark',{y:0},{y:75,ease:'none',scrollTrigger:{trigger:'.hero',start:'top top',end:'bottom top',scrub:true}});
   gsap.to('.ring-one',{rotationZ:20,ease:'none',scrollTrigger:{trigger:'.capabilities',start:'top bottom',end:'bottom top',scrub:1}});
   gsap.to('.ring-two',{rotationZ:-25,ease:'none',scrollTrigger:{trigger:'.capabilities',start:'top bottom',end:'bottom top',scrub:1}});
   gsap.fromTo('.ownership-statement',{opacity:.35,y:22},{opacity:1,y:0,ease:'none',scrollTrigger:{trigger:'.ownership',start:'top 80%',end:'top 30%',scrub:.5}});
  });
  media.add('(min-width: 901px) and (min-height: 650px) and (prefers-reduced-motion: no-preference)',()=>{
   const showcase=document.querySelector('[data-showcase]');showcase.classList.add('scroll-story');panels.forEach(p=>{p.hidden=false;});
   const timeline=gsap.timeline({paused:true}),stops=[.35];
   gsap.set(panels,{xPercent:0,yPercent:0,scale:1,opacity:1,rotation:0,rotationY:0});gsap.set(panels.slice(1),{autoAlpha:0});
   gsap.set(panels[1],{xPercent:118,rotation:8});gsap.set(panels[2],{xPercent:-118,rotation:-7});gsap.set(panels[3],{yPercent:115,rotation:3});gsap.set(panels[4],{scale:1.23,opacity:0});
   timeline.to({},{duration:.8});
   panels.slice(1).forEach((panel,i)=>{const at=timeline.duration();timeline.to(panels[i],{scale:.90,opacity:.2,rotationY:i%2?8:-8,duration:1.2,ease:'power2.inOut'},at);timeline.to(panel,{xPercent:0,yPercent:0,rotation:0,scale:1,autoAlpha:1,duration:1.2,ease:'power2.inOut'},at);stops.push(timeline.duration()+.35);timeline.to({},{duration:.8});});
   story={timeline,stops,trigger:null};
   timeline.eventCallback('onUpdate',()=>{const time=timeline.time();let current=0;stops.forEach((stop,i)=>{if(time>=stop-.7)current=i;});if(current!==selected)select(current);document.querySelector('.story-track>span').style.transform=`scaleX(${timeline.progress()})`;});
   story.trigger=ScrollTrigger.create({trigger:showcase,start:'top top',end:()=>'+='+Math.round(innerHeight*4.2),pin:true,pinSpacing:true,scrub:.65,animation:timeline,anticipatePin:1,invalidateOnRefresh:true});
   select(0);
   return()=>{story=null;showcase.classList.remove('scroll-story');panels.forEach(p=>gsap.set(p,{clearProps:'all'}));select(selected);};
  });
 }
 const prompts={morning:'清晨，薄雾里的弧形建筑被第一束日光照亮。柔和银绿色，细腻材质，镜头缓慢推进，安静而开阔。',rain:'雨后，弧形建筑倒映在潮湿地面上。通透的冷绿色，漫射天光，水面泛起细小涟漪，镜头低机位缓慢向前。',night:'夜色中，一轮月光落在弧形建筑边缘。深邃墨绿色，柔和轮廓光，细腻石材表面，镜头缓慢向上抬起。'};
 document.querySelectorAll('[data-mood]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-mood]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));document.querySelector('[data-mood-scene]').dataset.moodScene=button.dataset.mood;const result=document.querySelector('#prompt-result');result.textContent=prompts[button.dataset.mood];document.querySelector('.copy-status').textContent='';if(!reduce.matches)result.animate([{opacity:.3,transform:'translateY(7px)'},{opacity:1,transform:'translateY(0)'}],{duration:380,easing:'ease-out'});}));
 document.querySelector('.copy-prompt').addEventListener('click',async()=>{const status=document.querySelector('.copy-status');try{await navigator.clipboard.writeText(document.querySelector('#prompt-result').textContent);status.textContent='已复制，可以带到创作台继续使用。';}catch{status.textContent='暂时无法复制，可以选中上面的提示词手动复制。';}});
 const zoom=document.querySelector('#image-dialog');
 document.querySelectorAll('[data-zoom]').forEach(button=>button.addEventListener('click',()=>{const img=document.querySelector('#zoom-image');img.src=button.dataset.zoom;img.alt=button.querySelector('img').alt;document.querySelector('#image-dialog-title').textContent=button.dataset.caption;zoom.showModal();}));
 zoom.querySelector('[data-close-dialog]').addEventListener('click',()=>zoom.close());
 zoom.addEventListener('click',e=>{const r=zoom.getBoundingClientRect();if(e.target===zoom&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))zoom.close();});
 document.querySelectorAll('.faq details').forEach(details=>{let animation=null;const summary=details.querySelector('summary');summary.addEventListener('click',e=>{if(reduce.matches)return;e.preventDefault();if(animation){animation.cancel();animation=null;details.style.height='';details.style.overflow='';}const from=details.offsetHeight,opening=!details.open;if(opening)details.open=true;const to=opening?details.offsetHeight:summary.offsetHeight+2;details.style.overflow='hidden';animation=details.animate([{height:from+'px'},{height:to+'px'}],{duration:320,easing:'cubic-bezier(.2,.8,.2,1)'});animation.onfinish=()=>{if(!opening)details.open=false;details.style.overflow='';animation=null;};});});
 if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(!entry.isIntersecting)return;observer.unobserve(entry.target);if(!reduce.matches)entry.target.animate([{opacity:.2,transform:'translateY(28px)'},{opacity:1,transform:'translateY(0)'}],{duration:850,easing:'cubic-bezier(.2,.8,.2,1)'});}),{threshold:.08});document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));}
})();
