import * as THREE from './assets/three.module.js';
import { RoomEnvironment } from './assets/RoomEnvironment.js';

// Original, parametric folded-ribbon sculpture. The object's overlapping bands
// echo the current Knorvia mark. No model, shader or paid asset is taken from a reference site.
const host=document.getElementById('sculpture-scene');
const canvas=document.getElementById('sculpture-canvas');
const controls=document.querySelector('.material-controls');
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
let renderer,disposed=false;
try { init(); } catch(error) { host.classList.remove('ready');controls.hidden=true;renderer?.dispose();console.warn('3D enhancement unavailable; brand image retained.',error.message); }
function init(){
 renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true,powerPreference:'low-power'});
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));
 renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.13;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(35,1,.1,60);
 camera.position.set(.1,.3,8);camera.lookAt(0,-.03,0);
 const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
 const environment=pmrem.fromScene(room,.025);scene.environment=environment.texture;room.dispose();pmrem.dispose();
 const key=new THREE.DirectionalLight(0xf1fff3,4);key.position.set(-3,5,5);scene.add(key);
 const rim=new THREE.DirectionalLight(0xc5eccd,3.5);rim.position.set(4,1,-2);scene.add(rim);
 const fill=new THREE.DirectionalLight(0xffffff,1.3);fill.position.set(-4,-2,3);scene.add(fill);
 const sculpture=new THREE.Group();scene.add(sculpture);
 const grainData=new Uint8Array(128*128*4);let seed=29;
 for(let i=0;i<128*128;i++){seed=(seed*1664525+1013904223)>>>0;const n=229+(seed%9);grainData.set([n,n,n,255],i*4);}
 const grain=new THREE.DataTexture(grainData,128,128);grain.wrapS=grain.wrapT=THREE.RepeatWrapping;grain.magFilter=grain.minFilter=THREE.LinearFilter;grain.repeat.set(4,18);grain.needsUpdate=true;
 const silver=new THREE.MeshPhysicalMaterial({color:0xcbd3cc,metalness:.95,roughness:.27,roughnessMap:grain,clearcoat:.8,clearcoatRoughness:.18,envMapIntensity:1.45,side:THREE.DoubleSide});
 const inner=new THREE.MeshPhysicalMaterial({color:0x5a9a80,metalness:.68,roughness:.27,clearcoat:1,envMapIntensity:1.3,side:THREE.DoubleSide});
 const edge=new THREE.MeshPhysicalMaterial({color:0xdce8d7,metalness:.9,roughness:.21,envMapIntensity:1.4,side:THREE.DoubleSide});
 const V=(x,y,z)=>new THREE.Vector3(x,y,z);
 const front=[V(-.98,1.74,-.10),V(-1.28,1.16,.07),V(-1.23,.18,.35),V(-.56,-.60,.5),V(.40,-1.23,.30),V(1.20,-1.62,.02)];
 const back=[V(-1.13,-.36,-.28),V(-.51,.20,-.26),V(.32,.99,-.2),V(1.16,1.76,-.10)];
 function band(points,width,depth,phase,material){
  const curve=new THREE.CatmullRomCurve3(points),N=150,M=28,pos=[],uv=[],idx=[];
  const p=new THREE.Vector3(),t=new THREE.Vector3(),n=new THREE.Vector3(),b=new THREE.Vector3(),u=new THREE.Vector3(),v=new THREE.Vector3();
  for(let i=0;i<=N;i++){
   const s=i/N;curve.getPointAt(s,p);curve.getTangentAt(s,t);n.set(-t.y,t.x,0).normalize();b.crossVectors(t,n).normalize();
   const twist=phase+Math.sin(s*Math.PI)*.48-.28*s;
   u.copy(n).multiplyScalar(Math.cos(twist)).addScaledVector(b,Math.sin(twist));v.copy(b).multiplyScalar(Math.cos(twist)).addScaledVector(n,-Math.sin(twist));
   const end=Math.min(s*32,(1-s)*32,1),round=Math.sqrt(Math.max(0,1-(1-end)**2));
   for(let j=0;j<=M;j++){const a=j/M*Math.PI*2,c=Math.cos(a),d=Math.sin(a);const x=Math.sign(c)*Math.abs(c)**.3*width*.5*round,z=Math.sign(d)*Math.abs(d)**.6*depth*.5*round;pos.push(p.x+u.x*x+v.x*z,p.y+u.y*x+v.y*z,p.z+u.z*x+v.z*z);uv.push(j/M,s);if(i<N&&j<M){const k=i*(M+1)+j;idx.push(k,k+M+1,k+1,k+1,k+M+1,k+M+2);}}
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(idx);geometry.computeVertexNormals();
  const mesh=new THREE.Mesh(geometry,material);sculpture.add(mesh);return mesh;
 }
 band(back,.78,.19,-.05,inner);band(front,.91,.21,-.78,silver);
 const backCover=band(back,.77,.085,-.05,silver);backCover.position.z=.1;
 const innerFront=band(front,.88,.12,-.78,inner);innerFront.position.z=-.19;innerFront.position.x=.06;
 // Three hairline inlays catch grazing light, giving a sense of scale and finish.
 for(let i=0;i<3;i++){const inlay=band(front,.91-i*.05,.008,-.78,edge);inlay.position.z=-.123-i*.038;}
 const shadowTexture=(()=>{const el=document.createElement('canvas');el.width=el.height=128;const c=el.getContext('2d');const g=c.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,'rgba(0,0,0,.58)');g.addColorStop(.4,'rgba(0,0,0,.25)');g.addColorStop(1,'rgba(0,0,0,0)');c.fillStyle=g;c.fillRect(0,0,128,128);return new THREE.CanvasTexture(el);})();
 const shadow=new THREE.Mesh(new THREE.PlaneGeometry(5,2),new THREE.MeshBasicMaterial({map:shadowTexture,transparent:true,depthWrite:false,opacity:.55}));shadow.position.set(.25,-2.13,-.7);shadow.rotation.x=-.85;scene.add(shadow);
 // A small orbital glint sits behind the mark, never over the headline.
 const arc=new THREE.Mesh(new THREE.TorusGeometry(2.3,.003,5,160,Math.PI*1.4),new THREE.MeshBasicMaterial({color:0x99b7a1,transparent:true,opacity:.20}));arc.position.set(.05,-.12,-.8);arc.rotation.set(.48,.40,-.4);scene.add(arc);
 const state={x:0,y:0,scroll:0,paused:reduce.matches,visible:true,last:0,raf:0,activeTime:0};
 let targetX=0,targetY=0,drag=false,dragStart=0,dragRotation=0,targetRotation=0,first=true;
 const colors={titanium:{color:0xcbd3cc,metalness:.95,roughness:.27},carbon:{color:0x26342d,metalness:.72,roughness:.40},jade:{color:0x87b898,metalness:.48,roughness:.20}};
 let colorTarget=new THREE.Color(colors.titanium.color),materialTarget=colors.titanium;
 function request(){if(!state.raf&&!disposed&&state.visible&&!document.hidden)state.raf=requestAnimationFrame(frame);}
 function frame(now){state.raf=0;if(disposed||!state.visible||document.hidden)return;const dt=Math.min((now-(state.last||now))/1000,.04);state.last=now;
  const moving=!state.paused&&!reduce.matches;if(moving)state.activeTime+=dt;
  const damping=1-Math.exp(-dt*5);state.x+=(targetX-state.x)*damping;state.y+=(targetY-state.y)*damping;dragRotation+=(targetRotation-dragRotation)*damping;
  const t=state.activeTime;
  sculpture.rotation.set(-.11+(moving?state.y*.12+Math.sin(t*.43)*.028:0),-.27+dragRotation+(moving?state.x*.19+Math.sin(t*.3)*.075:0),-.095+(moving?Math.sin(t*.35)*.018:0));
  sculpture.position.y=.05+(moving?Math.sin(t*.56)*.055:0)-state.scroll*.24;
  sculpture.rotation.y+=state.scroll*.45;sculpture.rotation.z-=state.scroll*.08;
  silver.color.lerp(colorTarget,.12);silver.metalness+=(materialTarget.metalness-silver.metalness)*.12;silver.roughness+=(materialTarget.roughness-silver.roughness)*.12;
  renderer.render(scene,camera);
  if(first){first=false;host.classList.add('ready');controls.hidden=false;}
  const unsettled=Math.abs(silver.roughness-materialTarget.roughness)>.001||Math.abs(silver.color.r-colorTarget.r)>.001;
  if(moving||Math.abs(dragRotation-targetRotation)>.001||unsettled)request();
 }
 function size(){const {width,height}=host.getBoundingClientRect();if(!width||!height)return;renderer.setSize(width,height,false);camera.aspect=width/height;camera.position.z=width<600?8.8:7.8;camera.updateProjectionMatrix();request();}
 const resizeObserver=new ResizeObserver(size);resizeObserver.observe(host);size();
 host.addEventListener('pointermove',e=>{if(reduce.matches||state.paused)return;const r=host.getBoundingClientRect();targetX=(e.clientX-r.left)/r.width*2-1;targetY=(e.clientY-r.top)/r.height*2-1;if(drag)targetRotation=(e.clientX-dragStart)*.006;request();});
 host.addEventListener('pointerdown',e=>{if(e.pointerType!=='mouse'||state.paused)return;drag=true;dragStart=e.clientX-targetRotation/.006;host.setPointerCapture(e.pointerId);});
 host.addEventListener('pointerup',()=>{drag=false;});host.addEventListener('pointercancel',()=>{drag=false;});host.addEventListener('pointerleave',()=>{if(!drag){targetX=targetY=0;}});
 const pause=document.querySelector('.motion-toggle');
 function pauseLabel(){pause.setAttribute('aria-pressed',String(state.paused));pause.setAttribute('aria-label',state.paused?'播放装置动效':'暂停装置动效');pause.title=state.paused?'播放装置动效':'暂停装置动效';pause.querySelector('.pause-glyph').hidden=state.paused;pause.querySelector('.play-glyph').hidden=!state.paused;}
 pause.addEventListener('click',()=>{state.paused=!state.paused;pauseLabel();state.last=0;request();});pauseLabel();
 reduce.addEventListener('change',()=>{state.paused=reduce.matches;targetX=targetY=0;pauseLabel();request();});
 document.querySelectorAll('[data-material]').forEach(button=>button.addEventListener('click',()=>{materialTarget=colors[button.dataset.material];colorTarget.set(materialTarget.color);if(state.paused||reduce.matches){silver.color.copy(colorTarget);silver.metalness=materialTarget.metalness;silver.roughness=materialTarget.roughness;}document.querySelectorAll('[data-material]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));request();}));
 const visibility=new IntersectionObserver(([entry])=>{state.visible=entry.isIntersecting;state.last=0;if(state.visible)request();else if(state.raf){cancelAnimationFrame(state.raf);state.raf=0;}},{rootMargin:'40px'});visibility.observe(host);
 document.addEventListener('visibilitychange',()=>{state.last=0;if(document.hidden&&state.raf){cancelAnimationFrame(state.raf);state.raf=0;}else request();});
 window.addEventListener('scroll',()=>{state.scroll=reduce.matches?0:Math.min(1,scrollY/document.querySelector('.hero').offsetHeight);request();},{passive:true});
 canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();host.classList.remove('ready');controls.hidden=true;if(state.raf)cancelAnimationFrame(state.raf);state.raf=0;state.visible=false;});
 canvas.addEventListener('webglcontextrestored',()=>{state.visible=true;first=true;request();});
 window.addEventListener('pagehide',e=>{if(e.persisted)return;disposed=true;cancelAnimationFrame(state.raf);resizeObserver.disconnect();visibility.disconnect();scene.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of [].concat(o.material))m.dispose();}});grain.dispose();shadowTexture.dispose();environment.dispose();renderer.dispose();},{once:true});
 request();
}
