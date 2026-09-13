import * as THREE from './assets/three.module.js';
import { loadDisplayTexture } from './orbit-textures.js';

export function roundedShape(width, height, radius) {
  const x = -width / 2, y = -height / 2, r = radius;
  const s = new THREE.Shape();
  s.moveTo(x + r, y); s.lineTo(x + width - r, y);
  s.quadraticCurveTo(x + width, y, x + width, y + r);
  s.lineTo(x + width, y + height - r); s.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  s.lineTo(x + r, y + height); s.quadraticCurveTo(x, y + height, x, y + height - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

export function curvedGeometry(width, height, depth = 0) {
  const shape = roundedShape(width, height, .045);
  const radius = 3.9;
  const bend = (x, z = 0) => [Math.sin(x / radius) * (radius + z), Math.cos(x / radius) * (radius + z) - radius];
  // A tessellated parametric face keeps the cover smoothly cylindrical.
  if (!depth) {
    const N = 48, M = 20, p = [], uv = [], idx = [];
    for (let row = 0; row <= M; row++) {
      const v = row / M, y = (v - .5) * height;
      const dy = Math.max(0, Math.abs(y) - (height / 2 - .045));
      const inset = .045 - Math.sqrt(Math.max(0, .045 * .045 - dy * dy));
      for (let col = 0; col <= N; col++) {
        const u = col / N, x = (u - .5) * (width - inset * 2);
        const [bx, bz] = bend(x); p.push(bx, y, bz);
        uv.push(x / width + .5, v);
        if (row < M && col < N) { const k = row * (N + 1) + col; idx.push(k, k + 1, k + N + 1, k + 1, k + N + 2, k + N + 1); }
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: .014, bevelSize: .012, bevelSegments: 2, steps: 1, curveSegments: 12 });
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const [x, z] = bend(p.getX(i), p.getZ(i)); p.setX(i, x); p.setZ(i, z); }
  g.computeVertexNormals(); return g;
}

// A real, open side wall lets grazing light describe the thickness without
// putting a coarse extruded face over the finely tessellated photograph.
export function curvedRimGeometry(width, height, thickness = .038) {
  const outline = roundedShape(width, height, .045).getSpacedPoints(192);
  const positions = [], indices = [], radius = 3.9;
  for (const point of outline) {
    const angle = point.x / radius;
    for (const depth of [0, -thickness]) {
      positions.push(Math.sin(angle) * (radius + depth), point.y,
        Math.cos(angle) * (radius + depth) - radius);
    }
  }
  for (let i = 0; i < outline.length - 1; i++) {
    const a = i * 2; indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

export function createBrand(onReady, onError) {
  const group = new THREE.Group();
  const artwork = loadDisplayTexture(new URL('./assets/brand-relief.webp', import.meta.url).href, 768, onReady, onError);
  artwork.colorSpace = THREE.SRGBColorSpace; artwork.anisotropy = 8;
  const grainData = new Uint8Array(256 * 256 * 4);
  let seed = 74;
  for (let i = 0; i < 256 * 256; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; const n = 150 + seed % 95; grainData.set([n, n, n, 255], i * 4); }
  const grain = new THREE.DataTexture(grainData, 256, 256); grain.wrapS = grain.wrapT = THREE.RepeatWrapping; grain.repeat.set(3, 3); grain.needsUpdate = true;
  const paper = new THREE.MeshPhysicalMaterial({ color: 0xe2e3e1, metalness: 0, roughness: .67, bumpMap: grain, bumpScale: .007, clearcoat: .08, envMapIntensity: .36 });
  const base = new THREE.ExtrudeGeometry(roundedShape(3.04, 3.12, .6), { depth: .16, bevelEnabled: true, bevelThickness: .14, bevelSize: .1, bevelSegments: 7, curveSegments: 28 });
  const plinth = new THREE.Mesh(base, paper); plinth.position.z = -.48; plinth.receiveShadow = true; group.add(plinth);

  // Trace the current application's folded K, then lift its paper surfaces in 3D.
  // Reference coordinates preserve the original intersections and asymmetric curled ends.
  const px = x => (x - 512) * .00355, py = y => (512 - y) * .00355;
  function outline(commands) {
    const s = new THREE.Shape();
    for (const [op, ...v] of commands) {
      if (op === 'M') s.moveTo(px(v[0]), py(v[1]));
      if (op === 'L') s.lineTo(px(v[0]), py(v[1]));
      if (op === 'C') s.bezierCurveTo(px(v[0]), py(v[1]), px(v[2]), py(v[3]), px(v[4]), py(v[5]));
    }
    s.closePath(); return s;
  }
  function sheet(commands, lift) {
    const source = new THREE.ExtrudeGeometry(outline(commands), { depth: .025, bevelEnabled: true, bevelThickness: .008, bevelSize: .009, bevelSegments: 3, curveSegments: 28 });
    const vertices = [], indices = [], uvs = [], lookup = new Map();
    const position = source.attributes.position;
    function vertex(v) {
      const key = v.map(n => n.toFixed(6)).join(',');
      if (lookup.has(key)) return lookup.get(key);
      const i = vertices.length / 3, [x, y, z] = v;
      vertices.push(x, y, z + lift(x, y)); uvs.push(x / (1024 * .00355) + .5, y / (1024 * .00355) + .5);
      lookup.set(key, i); return i;
    }
    function triangle(a, b, c, depth = 0) {
      const dist = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
      if (depth < 2 && Math.max(dist(a, b), dist(b, c), dist(c, a)) > .22) {
        const mid = (u, v) => u.map((n, i) => (n + v[i]) / 2);
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        triangle(a, ab, ca, depth + 1); triangle(ab, b, bc, depth + 1); triangle(ca, bc, c, depth + 1); triangle(ab, bc, ca, depth + 1);
      } else indices.push(vertex(a), vertex(b), vertex(c));
    }
    for (let i = 0; i < position.count; i += 3) triangle(...[0, 1, 2].map(j => [position.getX(i + j), position.getY(i + j), position.getZ(i + j)]));
    source.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
    const material = new THREE.MeshBasicMaterial({ map: artwork, side: THREE.DoubleSide, toneMapped: false });
    material.userData.satinFinish = .65;
    const mesh = new THREE.Mesh(geometry, material); mesh.position.z = .09; mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  }
  // Inward-facing curl on the upright, pale at its lip and teal toward the fold.
  sheet([['M',368,187],['C',278,196,218,260,219,345],['C',215,410,270,465,328,504],['L',368,466]],
    (x, y) => .12 + .23 * Math.sin(THREE.MathUtils.clamp((x + 1.04) / .54, 0, 1) * Math.PI * .82));
  // Lower return turns into the lavender interior of the broad foreground ribbon.
  sheet([['M',443,479],['L',741,715],['C',792,758,818,790,803,822],['C',793,850,771,867,739,861],['C',656,830,565,735,486,665],['L',392,565]],
    (x, y) => .1 + .17 * Math.exp(-1 * ((x - .92) / .44) ** 2));
  // Upward arm: flat tapered paper with the original rounded, oblique tip.
  sheet([['M',333,510],['L',638,229],['C',680,190,738,179,774,200],['C',812,223,798,257,770,286],['L',446,607]],
    (x, y) => .27 + .08 * (y + .4));
  // The continuous foreground fold crosses the upward arm and curls under at the foot.
  sheet([['M',219,344],['C',214,400,251,445,328,505],['L',624,790],['C',665,833,704,858,743,863],['C',684,883,588,878,545,860],['C',527,852,510,838,494,823],['L',269,618],['C',231,580,215,540,216,498],['C',216,440,214,385,219,344]],
    (x, y) => .36 + .13 * Math.exp(-1 * ((y + .67) / .58) ** 2) - .15 * Math.exp(-1 * ((x - .82) / .25) ** 2));
  group.userData.grain = grain;
  group.userData.artwork = artwork;
  return group;
}

export function createFluidField() {
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const uniforms = { uTime: { value: 0 }, uAspect: { value: 1 }, uPointer: { value: new THREE.Vector2() } };
  const material = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, uniforms,
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: `
      precision highp float;
      varying vec2 vUv; uniform float uTime; uniform float uAspect; uniform vec2 uPointer;
      float hash(vec2 p){p=fract(p*vec2(123.34,345.45));p+=dot(p,p+34.345);return fract(p.x*p.y);}
      // Quintic interpolation keeps both the gradient and its change continuous.
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*f*(f*(f*6.-15.)+10.);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      float cloud(vec2 p){return noise(p)*.72+noise(mat2(.8,-.6,.6,.8)*p*1.87+vec2(3.1,8.7))*.28;}
      void main(){
        vec2 uv=vUv, p=(uv-.5)*vec2(uAspect,1.);float t=uTime*.11;
        p+=uPointer*.018*exp(-dot(p,p)*.6);
        vec2 current=vec2(noise(p*1.14+vec2(t*.24,-t*.19)),noise(p*1.06+vec2(4.2-t*.17,6.3+t*.21)))-.5;
        vec2 flow=p+current*.72;
        flow+=vec2(sin(p.y*1.3+t*.37),sin(p.x*.85-t*.29))*.09;
        float body=cloud(flow*1.34+vec2(t*.13,-t*.11));
        float fold=flow.y*.72+sin(flow.x*.88+t*.28)*.23+(body-.5)*.36;
        float blue=smoothstep(.22,.83,body+sin(fold*3.8)*.12);
        float silk=exp(-pow((fold-.04*sin(t*.31))*3.4,2.));
        vec3 color=vec3(.965,.977,.984);
        color=mix(color,vec3(.574,.727,.877),blue*.62);
        color=mix(color,vec3(.758,.866,.892),silk*.13);
        float pearl=exp(-pow((fold+.28)*3.8,2.));
        color=mix(color,vec3(.994,.992,.977),pearl*.32);
        vec2 blueDelta=flow-vec2(-.61+.12*sin(t*.33),-.12+.13*cos(t*.27));
        float wash=exp(-dot(blueDelta*vec2(.95,1.65),blueDelta*vec2(.95,1.65))*2.5);
        color=mix(color,vec3(.746,.857,.929),wash*.23);
        vec2 warmDelta=p-vec2(.66,-.39);
        float warmth=exp(-dot(warmDelta*vec2(.95,1.6),warmDelta*vec2(.95,1.6))*2.5);
        color=mix(color,vec3(.974,.937,.854),warmth*.25);
        float calm=exp(-dot(p*vec2(.8,1.6),p*vec2(.8,1.6))*2.);
        color=mix(color,vec3(.962,.978,.985),calm*.23);
        // Fixed, sub-pixel dither avoids visible bands without animated grain.
        float grain=(hash(gl_FragCoord.xy)-.5)/620.;
        gl_FragColor=vec4(pow(clamp(color+grain,0.,1.),vec3(2.2)),1.);
        #include <colorspace_fragment>
      }`,
  });
  const geometry = new THREE.PlaneGeometry(2, 2); scene.add(new THREE.Mesh(geometry, material));
  return { scene, camera, uniforms, dispose() { geometry.dispose(); material.dispose(); } };
}
