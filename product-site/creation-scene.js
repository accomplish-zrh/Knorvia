import * as THREE from './assets/three.module.js';
// A local, real-time lighting study, explicitly presented as an illustration,
// never as an AI-generated output. Lazy loaded only near the creation chapter.
export function mount(){
 const host=document.querySelector('.frame-scene'),canvas=document.createElement('canvas');canvas.setAttribute('aria-hidden','true');canvas.className='creation-canvas';host.append(canvas);
 let renderer;
 try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'low-power'});}catch{canvas.remove();return;}
 renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(37,1,.1,80);camera.position.set(6,2.8,9.2);camera.lookAt(.1,1.65,-.6);
 const sky=new THREE.HemisphereLight(0xecf3dd,0x263b30,2.5);scene.add(sky);
 const sun=new THREE.DirectionalLight(0xfff3cd,4);sun.position.set(-4,7,-2);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=-9;sun.shadow.camera.right=9;sun.shadow.camera.top=9;sun.shadow.camera.bottom=-9;sun.shadow.normalBias=.04;sun.shadow.bias=-.0003;scene.add(sun);
 const fill=new THREE.DirectionalLight(0xdbefdb,1.2);fill.position.set(3,4,5);scene.add(fill);
 const stone=new THREE.MeshStandardMaterial({color:0xc3ccb6,roughness:.74});
 function arch(x,z,scale,rotation){const shape=new THREE.Shape();shape.moveTo(-1.22,0);shape.lineTo(-1.22,1.55);shape.absarc(0,1.55,1.22,Math.PI,0,true);shape.lineTo(1.22,0);shape.lineTo(.73,0);shape.lineTo(.73,1.55);shape.absarc(0,1.55,.73,0,Math.PI,false);shape.lineTo(-.73,0);shape.closePath();const geo=new THREE.ExtrudeGeometry(shape,{depth:.62,bevelEnabled:true,bevelSize:.05,bevelThickness:.05,bevelSegments:4,steps:1,curveSegments:48});const mesh=new THREE.Mesh(geo,stone);mesh.position.set(x,0,z);mesh.scale.setScalar(scale);mesh.rotation.y=rotation;mesh.castShadow=true;mesh.receiveShadow=true;scene.add(mesh);}
 arch(1.4,0,1.4,-.3);arch(-1.5,-1.4,.92,-.06);arch(-3.1,-3.6,.55,.05);
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x667961,roughness:.38,metalness:.12}));ground.rotation.x=-Math.PI/2;ground.position.y=-.07;ground.receiveShadow=true;scene.add(ground);
 const disc=new THREE.Mesh(new THREE.SphereGeometry(.58,32,20),new THREE.MeshBasicMaterial({color:0xf8f1c9}));disc.position.set(-3,4.5,-6);scene.add(disc);
 const moods={morning:{background:0x9bab94,stone:0xc3ccb6,ground:0x667961,light:0xfff3cd,intensity:4,ambient:2.5},rain:{background:0x748e89,stone:0x9cbbb2,ground:0x4b6864,light:0xd5e9dd,intensity:2,ambient:2.4},night:{background:0x142d28,stone:0x748f77,ground:0x283d30,light:0xe2efbf,intensity:2.8,ambient:1.1}};
 let target=moods.morning,raf=0,remaining=0,visible=true,px=0,py=0,currentX=0,currentY=0;
 scene.background=new THREE.Color(target.background);scene.fog=new THREE.FogExp2(target.background,.045);
 const reduce=matchMedia('(prefers-reduced-motion: reduce)');const c=new THREE.Color();
 function render(){raf=0;if(!visible||document.hidden)return;const amount=reduce.matches?1:.13;scene.background.lerp(c.set(target.background),amount);scene.fog.color.copy(scene.background);stone.color.lerp(c.set(target.stone),amount);ground.material.color.lerp(c.set(target.ground),amount);sun.color.lerp(c.set(target.light),amount);sun.intensity+=(target.intensity-sun.intensity)*amount;sky.intensity+=(target.ambient-sky.intensity)*amount;currentX+=(px-currentX)*.09;currentY+=(py-currentY)*.09;camera.position.set(6+currentX*.32,2.8+currentY*.18,9.2);camera.lookAt(.1,1.65,-.6);renderer.render(scene,camera);host.classList.add('scene-ready');if(--remaining>0&&!reduce.matches)raf=requestAnimationFrame(render);}
 function request(){remaining=48;if(!raf&&visible&&!document.hidden)raf=requestAnimationFrame(render);}
 const resize=new ResizeObserver(()=>{const r=host.getBoundingClientRect();renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();request();});resize.observe(host);
 host.addEventListener('pointermove',e=>{if(reduce.matches)return;const r=host.getBoundingClientRect();px=(e.clientX-r.left)/r.width-.5;py=(e.clientY-r.top)/r.height-.5;request();});host.addEventListener('pointerleave',()=>{px=py=0;request();});
 const mood=new MutationObserver(()=>{target=moods[host.dataset.moodScene]||moods.morning;request();});mood.observe(host,{attributes:true,attributeFilter:['data-mood-scene']});
 const io=new IntersectionObserver(([e])=>{visible=e.isIntersecting;if(visible)request();else{cancelAnimationFrame(raf);raf=0;}});io.observe(host);
 document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else request();});
 canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(raf);raf=0;host.classList.remove('scene-ready');visible=false;});canvas.addEventListener('webglcontextrestored',()=>{visible=true;request();});
 window.addEventListener('pagehide',e=>{if(e.persisted)return;cancelAnimationFrame(raf);resize.disconnect();mood.disconnect();io.disconnect();scene.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});renderer.dispose();},{once:true});request();
}
