import * as THREE from './assets/three.module.js';
import { createBrand, createFluidField, curvedGeometry, curvedRimGeometry } from './orbit-objects.js';
import { createWater } from './orbit-water.js';
import { loadDisplayTexture } from './orbit-textures.js';
import { createPoolLife } from './orbit-life.js';

export function createOrbitScene(canvas, features, callbacks) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(34, 1, .1, 100);
  const field = createFluidField(), world = new THREE.Group(); scene.add(world);
  const key = new THREE.DirectionalLight(0xfff7e7, 2.5); key.position.set(-4, 6, 7); scene.add(key);
  key.castShadow = true; key.shadow.mapSize.set(512, 512);
  Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 18 });
  key.shadow.bias = -.0001; key.shadow.normalBias = .014; key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight(0xc9e9ff, 2.1); fill.position.set(5, 1, 4); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 2.4); rim.position.set(1, 4, -4); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xf4fcff, 0x9caab5, 1.2));
  const brand = createBrand(() => ready(), () => { failed = true; ready(); }); world.add(brand);
  const ring = new THREE.Group(); world.add(ring);
  const bodyMaterial = new THREE.MeshPhysicalMaterial({ color: 0xf0f3f4, metalness: .18, roughness: .36, clearcoat: .45, envMapIntensity: .8, side: THREE.DoubleSide });
  const cardGeometry = curvedGeometry(4.05, 2.7);
  const frameGeometry = curvedGeometry(4.094, 2.744);
  const rimGeometry = curvedRimGeometry(4.094, 2.744);
  const cards = [], pickObjects = [], textures = [];
  const coverWidth = canvas.clientWidth < 640 ? 640 : 1024;
  const projected = new THREE.Vector3(), labelPosition = new THREE.Vector3();
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(-10, -10);
  const state = { phase: -.42, targetPhase: null, focused: -1, radius: 5.2, targetRadius: 5.2, clock: 0, paused: reduced.matches, visible: !document.hidden, frames: 0, selected: -1, hovered: -1, width: 1, height: 1, dragging: false, velocity: 0, ready: false, mobile: false };
  let raf = 0, last = 0, lastFrame = 0, extraFrames = 1, disposed = false, lost = false, warming = true, width = 1, height = 1;
  let pointerX = 0, pointerY = 0, targetX = 0, targetY = 0, speed = .135, arrival = 0;
  let dragStart = null, lastDragX = 0, lastDragY = 0, lastDragTime = 0, loaded = 0, failed = false, inView = true, announced = false;

  function request(frames = 1) {
    // A newly enabled reduced-motion preference also cancels already queued settling frames.
    extraFrames = reduced.matches ? 1 : Math.max(extraFrames, frames);
    if (!raf && !disposed && !lost && state.visible && state.ready) raf = requestAnimationFrame(draw);
  }
  const ready = () => {
    loaded++;
    if (loaded === features.length + 1) {
      if (failed) { state.paused = true; callbacks.onFailure(); }
      else prepare().then(() => {
        if (disposed) return;
        state.ready = true; request();
      }).catch(() => callbacks.onFailure());
    }
    request();
  };
  async function prepare() {
    // Spread texture uploads across tasks so links and dialogs stay responsive
    // while the first scene is prepared, instead of one large synchronous batch.
    for (const texture of [...textures, brand.userData.artwork, brand.userData.grain]) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (disposed) return;
      renderer.initTexture(texture);
    }
    await Promise.all([renderer.compileAsync(field.scene, field.camera), renderer.compileAsync(scene, camera)]);
  }
  for (let i = 0; i < features.length; i++) {
    const group = new THREE.Group(); ring.add(group);
    const frame = new THREE.Mesh(frameGeometry, bodyMaterial); frame.position.z = -.022; group.add(frame);
    const edge = new THREE.Mesh(rimGeometry, bodyMaterial); edge.position.z = -.006; group.add(edge);
    const texture = loadDisplayTexture(new URL(`./assets/orbit/${features[i].id}.webp`, import.meta.url).href, coverWidth, ready, () => { failed = true; ready(); });
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); textures.push(texture);
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.FrontSide });
    material.userData.satinFinish = 1;
    const finishFocus = { value: 0 };
    material.userData.finishFocus = finishFocus;
    const front = new THREE.Mesh(cardGeometry, material); front.userData.featureIndex = i; group.add(front); pickObjects.push(front);
    const reverse = new THREE.Mesh(cardGeometry, new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.BackSide }));
    reverse.material.userData.satinFinish = .42;
    reverse.material.userData.finishFocus = finishFocus;
    reverse.position.z = -.044; reverse.userData.featureIndex = i; group.add(reverse); pickObjects.push(reverse);
    group.userData = { i, lift: 0, hover: 0, freedom: reduced.matches ? 0 : 1, turnLag: 0, previousAngle: null };
    cards.push({ group, front, material, finishFocus, label: callbacks.labels[i], angle: 0 });
  }
  brand.traverse(o => { if (o.isMesh) pickObjects.push(o); });
  const water = createWater(renderer, scene, camera, field, key.position);
  water.immerse(world);
  const life = createPoolLife(scene, water);

  // The thin orbit is a spatial cue; it follows the same tilted path as the cards.
  const orbitVertices = new Float32Array(160 * 3);
  const orbitGeometry = new THREE.BufferGeometry(); orbitGeometry.setAttribute('position', new THREE.BufferAttribute(orbitVertices, 3));
  const orbitLine = new THREE.LineLoop(orbitGeometry, new THREE.LineBasicMaterial({ color: 0xa1bbc7, transparent: true, opacity: .11 })); ring.add(orbitLine);
  const orbitPoint = new THREE.Vector3();
  function pathAt(angle, out) {
    const radius = state.radius;
    out.set(Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
    return out;
  }
  function size() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, rect.width), nextHeight = Math.max(1, rect.height);
    if (state.width === nextWidth && state.height === nextHeight) return;
    width = nextWidth; height = nextHeight;
    state.width = width; state.height = height; state.mobile = width < 640;
    const aspect = width / height;
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, state.mobile ? 1.2 : 1.4));
    renderer.setSize(width, height, false); camera.aspect = aspect;
    const targetWidth = state.mobile ? height < 500 ? 15 : 12.15 : 16.8;
    const base = state.mobile ? 20 : height < 500 ? 38 : height < 760 ? 24.8
      : THREE.MathUtils.lerp(24.8, 22, THREE.MathUtils.clamp((height - 760) / 240, 0, 1));
    const fit = targetWidth / (2 * Math.tan(THREE.MathUtils.degToRad(17)) * aspect);
    camera.position.set(0, 0, Math.max(base, fit)); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    world.position.y = state.mobile ? 1 : .24;
    ring.rotation.set(.35, 0, -.43, 'ZXY');
    brand.scale.setScalar(1);
    field.uniforms.uAspect.value = aspect;
    water.resize(width, height);
    life.resize(width, height, camera);
    for (let i = 0; i < 160; i++) { pathAt(i / 160 * Math.PI * 2, orbitPoint); orbitVertices.set(orbitPoint.toArray(), i * 3); }
    orbitGeometry.attributes.position.needsUpdate = true; orbitGeometry.computeBoundingSphere();
    request();
  }

  function draw(now) {
    raf = 0;
    if (disposed || lost || !state.visible) return;
    // Context loss is reported asynchronously; do not advance a frame after
    // the GPU has already stopped but before its DOM event has arrived.
    if (renderer.getContext().isContextLost()) return;
    // A 45 fps threshold skips every other frame on a 60 Hz phone.
    // Keep a 60 Hz budget and carry its fractional remainder on faster displays.
    const frameInterval = 1000 / 60;
    const sinceFrame = now - lastFrame;
    if (lastFrame && sinceFrame < frameInterval - .5) { raf = requestAnimationFrame(draw); return; }
    lastFrame = lastFrame ? now - Math.max(0, (sinceFrame + .5) % frameInterval - .5) : now;
    const elapsed = warming ? 0 : last ? (now - last) / 1000 : 1 / 60; last = now;
    const dt = Math.min(elapsed, .08);
    const ease = reduced.matches ? 1 : 1 - Math.exp(-dt * 7);
    const previousRadius = state.radius;
    state.radius += (state.targetRadius - state.radius) * ease;
    if (Math.abs(previousRadius - state.radius) > .00001) {
      for (let i = 0; i < 160; i++) { pathAt(i / 160 * Math.PI * 2, orbitPoint); orbitVertices.set(orbitPoint.toArray(), i * 3); }
      orbitGeometry.attributes.position.needsUpdate = true; orbitGeometry.computeBoundingSphere();
    }
    const moving = !state.paused && !reduced.matches;
    if (reduced.matches) arrival = 1;
    else if (moving) arrival = Math.min(1, arrival + dt / 1.6);
    const unfurl = 1 - Math.pow(1 - arrival, 3);
    ring.rotation.z = -.43 - (1 - unfurl) * .075;
    if (state.targetPhase !== null) {
      state.phase += (state.targetPhase - state.phase) * (reduced.matches ? 1 : 1 - Math.exp(-dt * 6));
      if (Math.abs(state.targetPhase - state.phase) < .0008) { state.phase = state.targetPhase; state.targetPhase = null; }
    }
    if (moving) {
      // The shader follows elapsed visible time; bounded physical integration
      // stays stable during a busy frame. Pausing/visibility reset the origin.
      state.clock += elapsed;
      const current = .135 * (1 + Math.sin(state.clock * .37) * .11);
      speed += ((state.hovered >= 0 || state.dragging || dragStart || state.focused >= 0 ? 0 : current) - speed) * ease;
      if (!dragStart && state.focused < 0 && state.targetPhase === null) { state.phase += (speed + state.velocity) * dt; state.velocity *= Math.exp(-dt * 4.3); }
    }
    pointerX += (targetX - pointerX) * ease; pointerY += (targetY - pointerY) * ease;
    world.rotation.y = reduced.matches ? 0 : pointerX * .035;
    world.rotation.x = reduced.matches ? 0 : pointerY * .018;
    brand.rotation.set(.025 + (reduced.matches ? 0 : pointerY * .012), -.045 + (reduced.matches ? 0 : pointerX * .025), -.055);
    brand.position.y = (reduced.matches ? 0 : Math.sin(state.clock * .7) * .07) + (state.mobile ? 0 : .1);
    for (const card of cards) {
      const { group } = card, i = group.userData.i;
      const hovered = i === state.hovered, selected = i === state.selected;
      group.userData.hover += ((hovered ? 1 : 0) - group.userData.hover) * ease;
      group.userData.lift += ((selected ? .52 : 0) - group.userData.lift) * ease;
      card.finishFocus.value = Math.max(group.userData.hover, group.userData.lift);
      const a = state.phase + i / cards.length * Math.PI * 2; card.angle = a;
      const engaged = hovered || selected || i === state.focused || dragStart?.feature === i;
      if (moving || reduced.matches || engaged || state.targetPhase !== null) {
        group.userData.freedom += ((engaged || reduced.matches ? 0 : 1) - group.userData.freedom) * ease;
      }
      const angleStep = group.userData.previousAngle === null ? 0 : signedAngle(a - group.userData.previousAngle);
      const lagTarget = reduced.matches ? 0 : THREE.MathUtils.clamp(-angleStep / Math.max(dt, .008) * .065, -.14, .14);
      group.userData.turnLag += (lagTarget - group.userData.turnLag) * ease;
      group.userData.previousAngle = a;
      const freedom = group.userData.freedom * (state.mobile ? .72 : 1), t = state.clock, offset = i * 1.93;
      const bob = (Math.sin(t * .67 + offset) * .105 + Math.sin(t * 1.17 + offset * .7) * .022) * freedom;
      const pitch = Math.sin(t * .53 + offset + .7) * .048 * freedom;
      const roll = Math.sin(t * .43 + offset * .8) * .029 * freedom;
      const yaw = Math.sin(t * .47 + offset) * .025 * freedom + group.userData.turnLag;
      pathAt(a, group.position);
      group.position.multiplyScalar((.94 + .06 * unfurl) * (1 + group.userData.hover * .018));
      group.position.y += bob;
      group.rotation.set(pitch, a + yaw, roll, 'YXZ');
      group.scale.setScalar(1 + group.userData.hover * .035 + group.userData.lift * .025);
    }
    field.uniforms.uTime.value = state.clock;
    field.uniforms.uPointer.value.set(pointerX, -pointerY);
    water.setTime(state.clock); life.update(state.clock); water.render();
    // Restoring textures, geometry and water targets can make the first draw
    // expensive. Reveal that completed frame, then start visible animation time.
    if (warming) { warming = false; last = lastFrame = 0; }
    state.frames++;
    if (!announced) { announced = true; callbacks.onReady(); }
    const frontCard = state.focused < 0 && state.hovered < 0 && state.selected < 0
      ? cards.reduce((front, card) => card.group.position.z > front.group.position.z ? card : front) : null;
    for (const card of cards) {
      labelPosition.set(0, -1.65, .1); card.group.localToWorld(labelPosition); labelPosition.project(camera);
      const x = (labelPosition.x * .5 + .5) * width;
      const y = Math.min((-labelPosition.y * .5 + .5) * height, height - (state.mobile ? 230 : 216));
      const labelScale = Math.min(1.07, Math.max(.77, 1 + card.group.position.z * .04));
      const i = card.group.userData.i;
      const focused = i === state.focused && state.targetPhase === null;
      const show = !state.dragging && (i === state.hovered || (focused && state.hovered < 0) || card === frontCard);
      if (show) {
        card.label.style.transform = `translate3d(${x}px,${y}px,0) translate(-50%,0) scale(${labelScale})`;
        card.label.style.zIndex = String(Math.round((card.group.position.z + 4) * 10));
      }
      if (card.shown !== show || card.focused !== focused) {
        card.label.style.opacity = show ? '1' : '0';
        card.label.style.pointerEvents = show ? 'auto' : 'none';
        card.label.tabIndex = focused ? 0 : -1;
        card.label.setAttribute('aria-hidden', String(!focused));
        card.shown = show; card.focused = focused;
      }
    }
    extraFrames--;
    if (moving || extraFrames > 0 || state.targetPhase !== null) request();
    else last = lastFrame = 0;
  }

  function hitAt(event) {
    const r = canvas.getBoundingClientRect(); pointer.set((event.clientX - r.left) / width * 2 - 1, -(event.clientY - r.top) / height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(pickObjects, false)[0]?.object.userData.featureIndex ?? -1;
  }
  function setHover(index) {
    if (state.hovered === index) return;
    state.hovered = index; canvas.classList.toggle('is-hovered', index >= 0);
    callbacks.onHover?.(index);
    callbacks.labels.forEach((label, i) => label.classList.toggle('is-active', i === index)); request(35);
  }
  const signedAngle = value => Math.atan2(Math.sin(value), Math.cos(value));
  function clearFocus() {
    state.targetPhase = null; state.focused = -1; callbacks.onFocus?.(-1);
  }
  function dragAngle(x, y, drag) {
    const dx = x - drag.centerX, dy = y - drag.centerY;
    const { bx, bz, determinant } = drag;
    // Undo the projected ellipse, so the same gesture follows the tilted orbit.
    const localX = (dx * bz.y - dy * bz.x) / determinant;
    const localZ = (bx.x * dy - bx.y * dx) / determinant;
    return Math.atan2(localX, localZ);
  }
  function onMove(e) {
    if (disposed) return;
    if (dragStart && e.pointerId !== dragStart.id) return;
    if (reduced.matches && !dragStart) {
      targetX = targetY = 0;
      if (e.pointerType !== 'touch') setHover(hitAt(e));
      return;
    }
    const r = canvas.getBoundingClientRect(); targetX = THREE.MathUtils.clamp((e.clientX - r.left) / width * 2 - 1, -1, 1); targetY = THREE.MathUtils.clamp((e.clientY - r.top) / height * 2 - 1, -1, 1);
    if (dragStart) {
      const dx = e.clientX - lastDragX, dt = Math.max(.008, (e.timeStamp - lastDragTime) / 1000);
      // Vertical touch intent belongs to native page scrolling, even over a photo.
      if (e.pointerType === 'touch' && !state.dragging && Math.abs(e.clientY - dragStart.y) > Math.max(6, Math.abs(e.clientX - dragStart.x) * 1.3)) {
        return;
      }
      if (!state.dragging && Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 6) { state.dragging = true; clearFocus(); }
      if (state.dragging) {
        if (dragStart.feature >= 0) {
          const distance = Math.hypot(e.clientX - dragStart.centerX, e.clientY - dragStart.centerY);
          const delta = (distance - dragStart.distance) / Math.max(140, dragStart.distance);
          state.targetRadius = THREE.MathUtils.clamp(dragStart.radius * (1 + delta), 4.45, 6.15);
          const angle = dragAngle(e.clientX, e.clientY, dragStart);
          const angularDelta = signedAngle(angle - dragStart.angle);
          state.phase += angularDelta;
          state.velocity = THREE.MathUtils.clamp(angularDelta / dt, -2, 2);
          dragStart.angle = angle;
        } else {
          state.phase += dx * .0055;
          state.velocity = THREE.MathUtils.clamp(dx * .0055 / dt, -2, 2);
        }
        canvas.classList.add('dragging'); setHover(-1);
      }
      lastDragX = e.clientX; lastDragY = e.clientY; lastDragTime = e.timeStamp;
    } else if (e.pointerType !== 'touch') setHover(hitAt(e));
    request(30);
  }
  function onDown(e) {
    if (e.button !== 0 || dragStart) return;
    const bounds = canvas.getBoundingClientRect();
    world.getWorldPosition(projected); projected.project(camera);
    const centerX = bounds.left + (projected.x * .5 + .5) * width, centerY = bounds.top + (-projected.y * .5 + .5) * height;
    const bx = new THREE.Vector3(1, 0, 0).transformDirection(ring.matrixWorld), bz = new THREE.Vector3(0, 0, 1).transformDirection(ring.matrixWorld);
    bx.y *= -1; bz.y *= -1;
    dragStart = { x: e.clientX, y: e.clientY, id: e.pointerId, feature: hitAt(e), centerX, centerY, bx, bz, determinant: bx.x * bz.y - bx.y * bz.x, distance: Math.hypot(e.clientX - centerX, e.clientY - centerY), radius: state.radius };
    dragStart.angle = dragAngle(e.clientX, e.clientY, dragStart);
    raycaster.setFromCamera(pointer, camera);
    const contact = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -.025), new THREE.Vector3());
    if (contact) water.touch(contact.x, contact.y);
    if (state.targetPhase !== null) clearFocus();
    lastDragX = e.clientX; lastDragY = e.clientY; lastDragTime = e.timeStamp; state.velocity = 0; canvas.setPointerCapture(e.pointerId); request(1);
  }
  function onUp(e) {
    if (!dragStart || e.pointerId !== dragStart.id) return;
    if (!state.dragging && e.type === 'pointerup') { const index = hitAt(e); if (index >= 0 && index === dragStart.feature) callbacks.onSelect(index); }
    if (e.type !== 'pointerup') state.velocity = 0;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    dragStart = null; state.dragging = false; canvas.classList.remove('dragging'); request(50);
  }
  function onLeave() {
    if (!dragStart) {
      const shifted = targetX !== 0 || targetY !== 0;
      targetX = targetY = 0; setHover(-1);
      if (shifted && !reduced.matches) request(30);
    }
  }
  function onVisibility() {
    const visible = !document.hidden && inView;
    if (state.visible === visible) return;
    state.visible = visible; last = lastFrame = 0;
    if (!state.visible && raf) { cancelAnimationFrame(raf); raf = 0; }
    else request();
  }
  function onLost(e) { e.preventDefault(); lost = true; warming = true; announced = false; cancelAnimationFrame(raf); raf = 0; last = lastFrame = 0; callbacks.onFailure(); }
  function onRestored() { lost = false; last = lastFrame = 0; request(); }
  function onMotionPreference() {
    if (reduced.matches) { targetX = targetY = 0; state.velocity = 0; }
    request(35);
  }
  reduced.addEventListener('change', onMotionPreference);
  const resizeObserver = new ResizeObserver(size); resizeObserver.observe(canvas);
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp); canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('lostpointercapture', onUp);
  canvas.addEventListener('webglcontextlost', onLost); canvas.addEventListener('webglcontextrestored', onRestored);
  document.addEventListener('visibilitychange', onVisibility);
  function dispose() {
    if (disposed) return; disposed = true; cancelAnimationFrame(raf); resizeObserver.disconnect();
    canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('lostpointercapture', onUp);
    canvas.removeEventListener('webglcontextlost', onLost); canvas.removeEventListener('webglcontextrestored', onRestored); document.removeEventListener('visibilitychange', onVisibility);
    reduced.removeEventListener('change', onMotionPreference);
    const geometries = new Set(), materials = new Set();
    scene.traverse(o => { if (o.geometry) geometries.add(o.geometry); if (o.material) [].concat(o.material).forEach(m => materials.add(m)); });
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose()); brand.userData.grain.dispose(); brand.userData.artwork.dispose(); water.dispose(); field.dispose(); renderer.dispose();
  }
  window.addEventListener('pagehide', e => { if (!e.persisted) dispose(); });
  size(); request();
  return {
    setPaused(value) {
      const paused = Boolean(value);
      if (state.paused === paused) return;
      state.paused = paused; state.velocity = 0; last = lastFrame = 0; request(35);
    },
    setInView(value) { inView = Boolean(value); onVisibility(); },
    highlight: setHover,
    focus(index) {
      if (!Number.isInteger(index) || index < 0 || index >= cards.length) return;
      state.focused = index; state.targetPhase = state.phase + signedAngle(-index / cards.length * Math.PI * 2 - state.phase);
      state.velocity = 0; speed = 0; setHover(-1); callbacks.onFocus?.(index); request(60);
    },
    select(index) { state.selected = index; setHover(-1); request(35); },
    reset() {
      clearFocus();
      if (reduced.matches) state.phase = -.42;
      else state.targetPhase = state.phase + signedAngle(-.42 - state.phase);
      state.targetRadius = 5.2; state.velocity = 0; speed = 0;
      targetX = targetY = 0; setHover(-1); request(60);
    },
    dispose,
    getWaterState() { return water.describe(brand, cards); },
    getLifeState() { return life.describe(camera, width, height); },
    getPanelPoses() { return cards.map(card => ({ id: features[card.group.userData.i].id, y: card.group.position.y, pitch: card.group.rotation.x, roll: card.group.rotation.z, turnLag: card.group.userData.turnLag })); },
    getState() { world.getWorldPosition(projected); projected.project(camera); const center = { x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height }; return { ...state, center, draws: renderer.info.render.calls, triangles: renderer.info.render.triangles, panels: cards.map(card => { card.group.getWorldPosition(projected); projected.project(camera); return { id: features[card.group.userData.i].id, x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height, z: card.group.position.z }; }) }; },
  };
}
