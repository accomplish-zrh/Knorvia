import * as THREE from './assets/three.module.js';

// A shared world-space water height drives the surface, immersion and waterline.
// The refraction buffer has its own depth texture: foreground objects never leak
// into the submerged side of a crossing photograph.
const waterGLSL = `
uniform float uWaterTime;
uniform float uWaterLevel;
uniform vec3 uWaterTouches[3];
float waterHeight(vec2 p) {
  float t = uWaterTime;
  float waves = sin(p.x * .84 + p.y * .53 + t * .31) * .012
    + sin(p.y * 1.17 - p.x * .43 - t * .24) * .007
    + sin(p.x * .38 - p.y * .66 + t * .16) * .006;
  for (int i = 0; i < 3; i++) {
    float age = t - uWaterTouches[i].z;
    if (age < 0. || age > 7.) continue;
    float d = length(p - uWaterTouches[i].xy);
    float envelope = smoothstep(0., .24, age) * exp(-age * .72)
      * exp(-pow((d - age * .8) * 1.4, 2.));
    waves += sin(d * 4.8 - age * 2.) * .011 * envelope;
  }
  return uWaterLevel + waves;
}
vec2 waterSlope(vec2 p) {
  float h = waterHeight(p);
  return vec2(waterHeight(p + vec2(.025, 0.)) - h,
    waterHeight(p + vec2(0., .025)) - h) / .025;
}
float waterLight(vec2 p) {
  float t = uWaterTime * .18;
  p *= .72;
  p += vec2(sin(p.y * 1.1 + t * .37), cos(p.x * .92 - t * .32)) * .66;
  float a = abs(sin(p.x * 1.9 + p.y * .85 + t * .28));
  float b = abs(sin(p.y * 1.7 - p.x * .73 - t * .23));
  return pow(1. - min(a, b), 7.);
}
`;

const shoreGLSL = `
uniform vec2 uShoreCenter;
uniform vec2 uShoreRadius;
float sandGrain(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float shoreNoise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(sandGrain(cell), sandGrain(cell + vec2(1., 0.)), f.x),
    mix(sandGrain(cell + vec2(0., 1.)), sandGrain(cell + vec2(1.)), f.x), f.y);
}
float shoreDistance(vec2 p) {
  vec2 q = (p - uShoreCenter) / uShoreRadius;
  float coves = (shoreNoise(p * .48) - .5) * .13;
  float edge = (shoreNoise(p * 1.55) - .5) * .028;
  return length(q) - 1. + coves + edge;
}
`;

export function createWater(renderer, scene, camera, field, keyPosition) {
  const uniforms = {
    uSatinLight: { value: keyPosition.clone().normalize() },
    uWaterTime: { value: 0 }, uWaterLevel: { value: .025 },
    uWaterTouches: { value: Array.from({ length: 3 }, () => new THREE.Vector3(100, 100, -100)) },
    uColor: { value: null }, uDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCameraRange: { value: new THREE.Vector2(camera.near, camera.far) },
    uShoreCenter: { value: new THREE.Vector2(12, -9) },
    uShoreRadius: { value: new THREE.Vector2(8, 7) },
    uPlaneExtent: { value: new THREE.Vector2(32, 32) },
  };
  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: true, stencilBuffer: false,
  });
  target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  uniforms.uColor.value = target.texture; uniforms.uDepth.value = target.depthTexture;
  const material = new THREE.ShaderMaterial({
    uniforms, toneMapped: false, depthTest: true, depthWrite: true,
    vertexShader: `${waterGLSL}
      uniform vec2 uPlaneExtent;
      varying vec3 vWaterPosition;
      void main() {
        vec3 p = position;
        p.xy *= uPlaneExtent;
        p.z = waterHeight(p.xy);
        vWaterPosition = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `${waterGLSL}${shoreGLSL}
      uniform sampler2D uColor;
      uniform sampler2D uDepth;
      uniform vec2 uResolution;
      uniform vec2 uCameraRange;
      varying vec3 vWaterPosition;
      float viewDistance(float depth) {
        float n = uCameraRange.x, f = uCameraRange.y;
        return (n * f) / ((n - f) * depth + f);
      }
      void main() {
        vec2 uv = gl_FragCoord.xy / uResolution;
        float surfaceDistance = viewDistance(gl_FragCoord.z);
        float behind = viewDistance(texture2D(uDepth, uv).x);
        float thickness = clamp(behind - surfaceDistance, 0., 6.);
        vec2 slope = waterSlope(vWaterPosition.xy);
        vec2 offset = slope * (.013 + thickness * .008);
        offset.x *= uResolution.y / uResolution.x;
        vec2 refractedUv = clamp(uv + offset, vec2(.001), vec2(.999));
        float refractedDepth = viewDistance(texture2D(uDepth, refractedUv).x);
        // Feather valid background samples into the undistorted edge. Nearer
        // geometry remains excluded, without a binary refraction pop.
        float validRefraction = smoothstep(surfaceDistance + .015, surfaceDistance + .075, refractedDepth);
        vec3 color = mix(texture2D(uColor, uv).rgb, texture2D(uColor, refractedUv).rgb, validRefraction);
        float sky = smoothstep(18., 35., behind);
        color = mix(color, vec3(.70, .87, .89), .028 + sky * .025);
        float light = waterLight(vWaterPosition.xy);
        float glint = pow(clamp(.54 + slope.x * 3.5 - slope.y * 2.5, 0., 1.), 6.);
        // Sunlight has a direction and a falloff: bright near the upper right,
        // quieter under the headline and around the edges of the photograph ring.
        vec2 sunDelta = (uv - vec2(.77, .78)) * vec2(uResolution.x / uResolution.y, 1.);
        float sunPool = exp(-dot(sunDelta, sunDelta) * 4.8);
        float sunlight = pow(clamp(.52 + slope.x * 3.2 - slope.y * 2.4, 0., 1.), 8.);
        color += vec3(.72, .86, .88) * (light * .009 + glint * .018);
        color += vec3(1., .95, .82) * (sunPool * .015 + sunlight * sunPool * .065);
        color = mix(color, color * vec3(.97, .985, 1.), smoothstep(.35, .95, length(sunDelta)) * .28);
        float shore = shoreDistance(vWaterPosition.xy);
        float shallows = (1. - smoothstep(.02, .32, shore)) * smoothstep(-.045, .025, shore);
        color = mix(color, vec3(.76, .88, .85), shallows * .08);
        float tide = .024 + sin(uWaterTime * .19) * .017;
        float foamEdge = shore - tide + (shoreNoise(vWaterPosition.xy * 3. + uWaterTime * .023) - .5) * .018;
        float foam = exp(-pow(foamEdge * 58., 2.));
        float lace = smoothstep(.20, .76, shoreNoise(vWaterPosition.xy * 13.));
        float breakage = .18 + .82 * smoothstep(.18, .8, shoreNoise(vWaterPosition.xy * 2.2));
        float retreat = exp(-pow((foamEdge - .046) * 65., 2.)) * .14;
        color = mix(color, vec3(.97, .98, .95), clamp((foam * lace * breakage + retreat) * .43, 0., .52));
        gl_FragColor = vec4(color, 1.);
        #include <colorspace_fragment>
      }`,
  });
  const geometry = new THREE.PlaneGeometry(2, 2, 96, 96);
  const surface = new THREE.Mesh(geometry, material);
  surface.name = 'Water surface'; surface.renderOrder = 10; surface.frustumCulled = false;
  scene.add(surface);

  // The shore is raised geometry. Dry sand writes depth above the water, while
  // its lower edge remains in the refraction pass as a shallow, wet strand.
  const shoreGeometry = new THREE.PlaneGeometry(2, 2, 96, 96);
  const shoreMaterial = new THREE.ShaderMaterial({
    uniforms, toneMapped: false,
    vertexShader: `${shoreGLSL}
      uniform float uWaterLevel;
      uniform vec2 uPlaneExtent;
      varying vec3 vShorePosition;
      void main() {
        vec3 p = position;
        p.xy *= uPlaneExtent;
        float d = shoreDistance(p.xy);
        p.z = uWaterLevel - sign(d) * .5 * (1. - exp(-abs(d) * 2.2));
        vShorePosition = p;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `${shoreGLSL}
      varying vec3 vShorePosition;
      void main() {
        float shore = shoreDistance(vShorePosition.xy);
        if (shore > .34) discard;
        float damp = shore + (shoreNoise(vShorePosition.xy * 1.2) - .5) * .045;
        float dry = 1. - smoothstep(-.19, .075, damp);
        vec3 sand = mix(vec3(.67, .73, .66), vec3(.86, .82, .72), dry);
        float grain = sandGrain(vShorePosition.xy * 520.);
        float cloud = (shoreNoise(vShorePosition.xy * .95) - .5) * .027;
        float ripples = sin(vShorePosition.y * 26. + shoreNoise(vShorePosition.xy * .65) * 12.);
        sand += (grain - .5) * .024 + cloud + ripples * .006 * (1. - dry);
        float wetSheen = exp(-pow((shore + .025) * 10., 2.));
        sand += vec3(.032, .041, .036) * wetSheen;
        sand -= pow(grain, 36.) * .023;
        float fade = 1. - smoothstep(.07, .34, shore);
        gl_FragColor = vec4(sand, fade);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: true,
  });
  const shore = new THREE.Mesh(shoreGeometry, shoreMaterial);
  shore.name = 'Sand shore'; shore.renderOrder = -1; shore.frustumCulled = false;
  scene.add(shore);

  const treated = new Set();
  function immerse(object) {
    object.traverse(mesh => {
      if (!mesh.isMesh || mesh === surface) return;
      for (const m of [].concat(mesh.material)) {
        if (treated.has(m)) continue;
        treated.add(m);
        m.onBeforeCompile = shader => {
          Object.assign(shader.uniforms, {
            uWaterTime: uniforms.uWaterTime,
            uWaterLevel: uniforms.uWaterLevel,
            uWaterTouches: uniforms.uWaterTouches,
          });
          shader.vertexShader = 'varying vec3 vImmersionPosition;\n' + shader.vertexShader;
          shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
            'vImmersionPosition = (modelMatrix * vec4(transformed, 1.)).xyz;\n#include <project_vertex>');
          shader.fragmentShader = waterGLSL + '\nvarying vec3 vImmersionPosition;\n' + shader.fragmentShader;
          if (m.userData.satinFinish) {
            // Preserve the artwork's original colors, with a thin optical coating
            // that follows the real curved surface rather than a screen overlay.
            shader.uniforms.uSatinFinish = { value: m.userData.satinFinish };
            shader.uniforms.uSatinLight = uniforms.uSatinLight;
            shader.uniforms.uFinishFocus = m.userData.finishFocus || { value: 0 };
            shader.vertexShader = 'varying vec3 vSatinNormal;\n' + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
              '#include <begin_vertex>\nvSatinNormal = normalize(mat3(modelMatrix) * normal);');
            if (m.userData.finishFocus) {
              shader.vertexShader = 'varying vec2 vFinishUv;\n' + shader.vertexShader;
              shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvFinishUv = uv;');
              shader.fragmentShader = 'varying vec2 vFinishUv;\n' + shader.fragmentShader;
            }
            shader.fragmentShader = 'varying vec3 vSatinNormal;\nuniform float uSatinFinish;\nuniform float uFinishFocus;\nuniform vec3 uSatinLight;\n' + shader.fragmentShader;
            shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
              vec3 satinNormal = normalize(vSatinNormal) * (gl_FrontFacing ? 1. : -1.);
              vec3 satinEye = normalize(cameraPosition - vImmersionPosition);
              vec3 satinHalf = normalize(satinEye + uSatinLight);
              float satinSpecular = pow(max(dot(satinNormal, satinHalf), 0.), 76.);
              float satinEdge = pow(1. - abs(dot(satinNormal, satinEye)), 3.);
              gl_FragColor.rgb += (vec3(1., .97, .89) * satinSpecular * .038
                + vec3(.62, .83, .90) * satinEdge * .022) * uSatinFinish * (1. + uFinishFocus * .18);
              ${m.userData.finishFocus ? `
              // Only the photograph's perimeter catches this narrow laminated edge.
              // Its reflection follows surface orientation, never a timed screen sweep.
              float borderDistance = min(min(vFinishUv.x, 1. - vFinishUv.x), min(vFinishUv.y, 1. - vFinishUv.y));
              float fineEdge = 1. - smoothstep(.0008, .005, borderDistance);
              float facingLight = smoothstep(-.2, .8, dot(satinNormal, uSatinLight));
              vec3 edgeTint = mix(vec3(.50, .76, .87), vec3(.96, .91, .77), facingLight);
              gl_FragColor.rgb += edgeTint * fineEdge * (.018 + .055 * satinEdge + .014 * uFinishFocus) * uSatinFinish;
              ` : ''}
              #include <tonemapping_fragment>`);
          }
          shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
            float depthUnderWater = waterHeight(vImmersionPosition.xy) - vImmersionPosition.z;
            float wet = smoothstep(-.012, .035, depthUnderWater);
            float absorption = 1. - exp(-max(0., depthUnderWater) * .055);
            vec3 submerged = mix(gl_FragColor.rgb, vec3(.50, .74, .76), absorption);
            submerged += waterLight(vImmersionPosition.xy) * .027;
            gl_FragColor.rgb = mix(gl_FragColor.rgb, submerged, wet);
            float waterline = exp(-abs(depthUnderWater) * 65.);
            gl_FragColor.rgb += vec3(.54, .80, .83) * waterline * .14;
            #include <tonemapping_fragment>`);
        };
        m.customProgramCacheKey = () => `knorvia-water-4-${m.userData.finishFocus ? 'photograph' : m.userData.satinFinish ? 'satin' : 'matte'}`;
        m.needsUpdate = true;
      }
    });
  }
  const sample = new THREE.Vector3();
  function depthRange(object) {
    let min = Infinity, max = -Infinity;
    object.traverse(mesh => {
      const positions = mesh.geometry?.attributes.position;
      if (!positions) return;
      for (let i = 0; i < positions.count; i++) {
        sample.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        min = Math.min(min, sample.z); max = Math.max(max, sample.z);
      }
    });
    return { min, max, state: max < uniforms.uWaterLevel.value - .025 ? 'submerged' : min > uniforms.uWaterLevel.value + .025 ? 'above' : 'crossing' };
  }
  let touchIndex = 0;
  return {
    immerse,
    depthRange,
    heightAt(x, y) {
      const t = uniforms.uWaterTime.value;
      let height = uniforms.uWaterLevel.value + Math.sin(x * .84 + y * .53 + t * .31) * .012
        + Math.sin(y * 1.17 - x * .43 - t * .24) * .007 + Math.sin(x * .38 - y * .66 + t * .16) * .006;
      for (const touch of uniforms.uWaterTouches.value) {
        const age = t - touch.z;
        if (age < 0 || age > 7) continue;
        const d = Math.hypot(x - touch.x, y - touch.y);
        const rise = THREE.MathUtils.smoothstep(age, 0, .24);
        height += Math.sin(d * 4.8 - age * 2) * .011 * rise * Math.exp(-age * .72 - ((d - age * .8) * 1.4) ** 2);
      }
      return height;
    },
    resize(width, height) {
      const scale = Math.min(renderer.getPixelRatio(), 1.15, 1440 / width, 1080 / height);
      target.setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      renderer.getDrawingBufferSize(uniforms.uResolution.value);
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
      const halfWidth = halfHeight * camera.aspect;
      uniforms.uPlaneExtent.value.set(halfWidth * 1.12, halfHeight * 1.12);
      uniforms.uShoreCenter.value.set(halfWidth * .95, -halfHeight * 1.1);
      uniforms.uShoreRadius.value.set(halfWidth * .65, halfHeight * .93);
    },
    setTime(time) { uniforms.uWaterTime.value = time; },
    touch(x, y) { uniforms.uWaterTouches.value[touchIndex].set(x, y, uniforms.uWaterTime.value); touchIndex = (touchIndex + 1) % 3; },
    render() {
      surface.visible = false;
      renderer.setRenderTarget(target);
      renderer.clear(); renderer.render(field.scene, field.camera); renderer.clearDepth(); renderer.render(scene, camera);
      surface.visible = true;
      renderer.setRenderTarget(null);
      const updateShadows = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      // The opaque water surface covers the viewport and reads its background
      // from the first pass. Repainting that expensive fluid field here was
      // completely hidden by the surface on every frame.
      renderer.clear(); renderer.render(scene, camera);
      renderer.shadowMap.autoUpdate = updateShadows;
    },
    describe(brand, cards) {
      return { level: uniforms.uWaterLevel.value, surface: 'depth-tested displaced mesh',
        shore: 'organic coves, gradual wet sand and broken tidal foam at lower right',
        base: depthRange(brand.children[0]), letter: brand.children.slice(1).map(depthRange),
        panels: cards.map(card => ({ index: card.group.userData.i, ...depthRange(card.group) })) };
    },
    dispose() { target.dispose(); target.depthTexture?.dispose(); geometry.dispose(); material.dispose(); shoreGeometry.dispose(); shoreMaterial.dispose(); },
  };
}
