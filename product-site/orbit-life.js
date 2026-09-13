import * as THREE from './assets/three.module.js';

// Small objects in the same water and light as the gallery, with no hit targets
// or private animation loop. The scene clock owns every movement here.
export function createPoolLife(scene, water) {
  const group = new THREE.Group(); group.name = 'Pool companions'; scene.add(group);
  const bodyGeometry = new THREE.SphereGeometry(1, 20, 12);
  const eyeGeometry = new THREE.SphereGeometry(.0065, 10, 8);
  const eyeMaterial = new THREE.MeshPhysicalMaterial({ color: 0x39474b, roughness: .42, clearcoat: .15 });
  const profile = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-.28, .015, .011), new THREE.Vector3(-.18, .031, .023),
    new THREE.Vector3(-.035, .070, .042), new THREE.Vector3(.115, .086, .052),
    new THREE.Vector3(.235, .054, .037), new THREE.Vector3(.31, .020, .018), new THREE.Vector3(.325, .001, .002)
  ]);
  function fishBody(accent) {
    const vertices = [], shades = [], indices = [], rows = 44, sides = 24;
    const pearl = new THREE.Color(0xe1e4d9), tint = new THREE.Color(accent), belly = new THREE.Color(0xf1eee1), c = new THREE.Color();
    for (let row = 0; row <= rows; row++) {
      const u = row / rows, p = profile.getPoint(u);
      for (let side = 0; side <= sides; side++) {
        const angle = side / sides * Math.PI * 2, lateral = Math.cos(angle), top = Math.sin(angle);
        vertices.push(p.x, lateral * p.y, top * p.z);
        const patches = Math.exp(-1 * ((u - .69) / .095) ** 2 - ((lateral + .24) / .78) ** 2)
          + .82 * Math.exp(-1 * ((u - .31) / .09) ** 2 - ((lateral - .38) / .8) ** 2);
        const pigment = THREE.MathUtils.smoothstep(patches, .25, .7) * THREE.MathUtils.smoothstep(top, -.25, .4);
        c.copy(pearl).lerp(tint, pigment * .86).lerp(belly, Math.max(0, -top) * .6);
        const grain = 1 + Math.cos(u * 102 + side * 1.9) * .012 * Math.max(0, top);
        shades.push(c.r * grain, c.g * grain, c.b * grain);
        if (row < rows && side < sides) { const a = row * (sides + 1) + side, b = a + sides + 1; indices.push(a, a + 1, b, a + 1, b + 1, b); }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(shades, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    return geometry;
  }
  const tailShape = new THREE.Shape();
  tailShape.moveTo(.025, .017); tailShape.bezierCurveTo(-.07, .027, -.14, .093, -.255, .11);
  tailShape.quadraticCurveTo(-.24, .045, -.205, 0); tailShape.quadraticCurveTo(-.24, -.045, -.255, -.11);
  tailShape.bezierCurveTo(-.14, -.093, -.07, -.027, .025, -.017); tailShape.closePath();
  const tailGeometry = new THREE.ShapeGeometry(tailShape, 22);
  const rays = [];
  for (let i = -3; i <= 3; i++) {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, .002), new THREE.Vector3(-.11, i * .013, .002), new THREE.Vector3(-.225, i * .028, .002)).getPoints(8);
    for (let j = 0; j < curve.length - 1; j++) rays.push(curve[j], curve[j + 1]);
  }
  const rayGeometry = new THREE.BufferGeometry().setFromPoints(rays);
  const rayMaterial = new THREE.LineBasicMaterial({ color: 0xd3ddd0, transparent: true, opacity: .24, depthWrite: false });
  const finShape = new THREE.Shape(); finShape.moveTo(.025, 0); finShape.quadraticCurveTo(-.03, .082, -.115, .072); finShape.quadraticCurveTo(-.10, .018, -.025, -.008); finShape.closePath();
  const finGeometry = new THREE.ShapeGeometry(finShape, 18);
  const dropMaterial = new THREE.MeshPhysicalMaterial({ color: 0xc6ebed, roughness: .18, clearcoat: .8 });
  const random = (seed, index) => { const value = Math.sin(seed * 127.1 + index * 311.7) * 43758.5453; return value - Math.floor(value); };
  const fish = [0xc98169, 0x71949c, 0xc4aa70].map((color, i) => {
    const root = new THREE.Group(); root.name = 'Small fish ' + (i + 1); group.add(root);
    const paint = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: .56, metalness: .025, clearcoat: .12, clearcoatRoughness: .48 });
    const finPaint = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0xe0e5d9).lerp(new THREE.Color(color), .16), roughness: .72, side: THREE.DoubleSide, transparent: true, opacity: .47, depthWrite: false });
    const body = new THREE.Mesh(fishBody(color), paint); root.add(body);
    const rest = body.geometry.attributes.position.array.slice();
    const tail = new THREE.Group(); tail.position.set(-.276, 0, 0); tail.add(new THREE.Mesh(tailGeometry, finPaint), new THREE.LineSegments(rayGeometry, rayMaterial)); root.add(tail);
    const fins = [-1, 1].map(side => { const fin = new THREE.Mesh(finGeometry, finPaint); fin.position.set(.075, side * .062, .004); fin.scale.set(.8, side * .8, 1); root.add(fin); return fin; });
    for (const side of [-1, 1]) { const eye = new THREE.Mesh(eyeGeometry, eyeMaterial); eye.position.set(.255, side * .027, .030); root.add(eye); }
    const splash = new THREE.Group(); splash.visible = false; group.add(splash);
    for (let j = 0; j < 4; j++) splash.add(new THREE.Mesh(bodyGeometry, dropMaterial));
    const seed = Math.random() * 999 + i * 71;
    return { root, body, rest, tail, fins, splash, seed, color, phase: i * 2.35, x: 0, y: 0, travel: 1,
      heading: null, period: 8 + random(seed, 1) * 5, nextJump: 9 + i * 7 + random(seed, 2) * 5,
      jumpStart: -Infinity, jumpDuration: 1.55, jumpHeight: 0, splashAt: -Infinity, landed: true, landings: 0 };
  });

  const ring = new THREE.Group(); ring.name = 'Floating swim ring'; group.add(ring);
  const ringGeometry = new THREE.TorusGeometry(.43, .14, 16, 72);
  const ivory = new THREE.Color(0xede9db), blue = new THREE.Color(0x639caa);
  const colors = [], uv = ringGeometry.attributes.uv, color = new THREE.Color();
  for (let i = 0; i < uv.count; i++) {
    const band = THREE.MathUtils.smoothstep(Math.cos(uv.getX(i) * Math.PI * 4 + .5), .48, .6);
    color.copy(ivory).lerp(blue, band); colors.push(color.r, color.g, color.b);
  }
  ringGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const ringMaterial = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: .36, metalness: 0, clearcoat: .48, clearcoatRoughness: .25 });
  const inflatable = new THREE.Mesh(ringGeometry, ringMaterial); ring.add(inflatable);
  const seamMaterial = new THREE.MeshPhysicalMaterial({ color: 0xcbd6ce, roughness: .58 });
  const seam = new THREE.Mesh(new THREE.TorusGeometry(.57, .004, 5, 72), seamMaterial); ring.add(seam);
  const valve = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, .02, 10), seamMaterial);
  valve.rotation.x = Math.PI / 2; valve.position.set(.38, -.18, .134); ring.add(valve);
  const hullShape = new THREE.Shape();
  hullShape.moveTo(.49, 0); hullShape.quadraticCurveTo(.22, .21, -.37, .16);
  hullShape.quadraticCurveTo(-.49, 0, -.37, -.16); hullShape.quadraticCurveTo(.22, -.21, .49, 0);
  const hullGeometry = new THREE.ExtrudeGeometry(hullShape, { depth: .09, bevelEnabled: true, bevelSize: .018, bevelThickness: .022, bevelSegments: 2, curveSegments: 10 });
  const deckGeometry = new THREE.ShapeGeometry(hullShape, 10);
  const mastGeometry = new THREE.CylinderGeometry(.009, .009, .56, 7);
  const sailGeometry = new THREE.BufferGeometry();
  sailGeometry.setAttribute('position', new THREE.Float32BufferAttribute([.02, 0, .59, .35, .13, .12, -.29, -.025, .12], 3));
  sailGeometry.computeVertexNormals();
  const hullMaterial = new THREE.MeshPhysicalMaterial({ color: 0xe8dfc6, roughness: .45, clearcoat: .38 });
  const deckMaterial = new THREE.MeshPhysicalMaterial({ color: 0xfcf7e9, roughness: .62 });
  const boats = [0xd5a06d, 0x75aeb6].map((color, i) => {
    const root = new THREE.Group(); root.name = 'Passing sailboat ' + (i + 1); root.visible = false; group.add(root);
    const hull = new THREE.Mesh(hullGeometry, hullMaterial); hull.position.z = -.07; root.add(hull);
    const deck = new THREE.Mesh(deckGeometry, deckMaterial); deck.scale.setScalar(.88); deck.position.z = .051; root.add(deck);
    const mast = new THREE.Mesh(mastGeometry, seamMaterial); mast.rotation.x = Math.PI / 2; mast.position.z = .31; root.add(mast);
    const sail = new THREE.Mesh(sailGeometry, new THREE.MeshPhysicalMaterial({ color, roughness: .68, side: THREE.DoubleSide })); root.add(sail);
    const seed = Math.random() * 599 + i * 43;
    return { root, seed, i, start: -Infinity, duration: 17, next: 5 + i * 18 + random(seed, 3) * 5, passes: 0, heading: 0 };
  });
  water.immerse(group);

  let pixel = 1, spanX = 1, spanY = 1, compact = false, time = 0;
  const ringAnchor = new THREE.Vector2(), projected = new THREE.Vector3();
  const anchor = (object, x, y) => { object.x = (x - .5) * spanX; object.y = (.5 - y) * spanY; };
  function resize(width, height, camera) {
    spanY = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
    spanX = spanY * camera.aspect; pixel = spanY / height;
    compact = width < 900;
    group.visible = compact ? width >= 360 && height >= 760 && height / width > 1.28 : height >= 640;
    const locations = compact ? [[.20, .68], [.48, .71]] : [[.115, .66], [.885, .385], [.22, .775]];
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      f.root.visible = !compact || i < 2;
      anchor(f, ...(locations[i] || locations[0]));
      f.root.scale.setScalar(pixel * (compact ? [24, 21][i % 2] : [34, 30, 27][i]) / .856);
      f.travel = (compact ? 13 : 43) * pixel;
    }
    anchor(ringAnchor, compact ? .71 : .855, compact ? .68 : .568);
    ring.scale.setScalar(pixel * (compact ? 32 : 65) / 1.14);
    for (const boat of boats) boat.root.scale.setScalar(pixel * (compact ? 25 : 46));
    update(time);
  }
  // Seeded waypoints make each visit different. Catmull-Rom interpolation keeps
  // position and velocity continuous as fish choose their next swimming route.
  function route(f, clock, axis) {
    const progress = (clock + f.phase) / f.period, segment = Math.floor(progress), u = progress - segment;
    const points = [-1, 0, 1, 2].map(offset => random(f.seed + axis * 83, segment + offset) * 2 - 1);
    const [a, b, c, d] = points, p = -a + c, q = 2 * a - 5 * b + 4 * c - d, r = -a + 3 * b - 3 * c + d;
    return { value: .5 * (2 * b + p * u + q * u * u + r * u * u * u), velocity: .5 * (p + 2 * q * u + 3 * r * u * u) / f.period };
  }
  function update(clock) {
    const dt = Math.min(.08, Math.max(0, clock - time));
    time = clock;
    if (!group.visible) return;
    for (const f of fish) {
      if (!f.root.visible) { f.splash.visible = false; continue; }
      const pathX = route(f, clock, 0), pathY = route(f, clock, 1);
      const x = f.x + pathX.value * f.travel, y = f.y + pathY.value * f.travel * .58;
      const heading = Math.atan2(pathY.velocity * .58, pathX.velocity);
      if (f.heading === null) f.heading = heading;
      else f.heading += Math.atan2(Math.sin(heading - f.heading), Math.cos(heading - f.heading)) * (1 - Math.exp(-dt * 4));
      if (clock >= f.nextJump && fish.some(other => other !== f && other.root.visible && clock >= other.jumpStart && clock <= other.jumpStart + other.jumpDuration)) {
        f.nextJump = clock + 4 + random(f.seed, clock) * 4;
      }
      if (clock >= f.nextJump) {
        f.jumpStart = clock; f.jumpDuration = 1.55 + random(f.seed, clock + 10) * .3;
        f.jumpHeight = .28 + pixel * (compact ? 12 : 28); f.landed = false;
        f.nextJump = clock + 23 + random(f.seed, clock + 20) * 23;
      }
      const progress = (clock - f.jumpStart) / f.jumpDuration, airborne = progress >= 0 && progress <= 1;
      const z = -.28 + (airborne ? 4 * progress * (1 - progress) * f.jumpHeight : 0);
      const surface = water.heightAt(x, y);
      const pitch = airborne ? -Math.atan2(4 * (1 - 2 * progress) * f.jumpHeight / f.jumpDuration, Math.max(pixel * 18, Math.hypot(pathX.velocity, pathY.velocity * .58) * f.travel)) * Math.sin(Math.PI * progress) : 0;
      if (!f.landed && progress > .5 && z <= surface) {
        f.landed = true; f.landings++; f.splashAt = clock; f.splash.position.set(x, y, surface);
        water.touch(x, y);
      }
      f.root.position.set(x, y, z); f.root.rotation.set(0, pitch, f.heading, 'ZYX');
      const swim = clock * 3.6 + f.phase, points = f.body.geometry.attributes.position;
      for (let j = 0; j < points.count; j++) {
        const x = f.rest[j * 3], weight = ((.325 - x) / .605) ** 2;
        points.setY(j, f.rest[j * 3 + 1] + Math.sin(swim + x * 5) * .013 * weight);
      }
      points.needsUpdate = true;
      f.tail.position.y = Math.sin(swim - 1.4) * .013;
      f.tail.rotation.z = Math.sin(swim - 1.6) * (airborne ? .2 : .14);
      f.fins.forEach((fin, i) => { fin.rotation.z = Math.sin(clock * 2.2 + f.phase + i) * .07; });
      const splashAge = clock - f.splashAt, splashProgress = splashAge / .66;
      f.splash.visible = splashAge >= 0 && splashProgress < 1;
      if (f.splash.visible) f.splash.children.forEach((drop, i) => {
        drop.visible = !compact || i < 3;
        const angle = i * Math.PI / 2 + f.seed;
        drop.position.set(Math.cos(angle) * splashAge * pixel * 18, Math.sin(angle) * splashAge * pixel * 11,
          Math.sin(Math.PI * splashProgress) * pixel * (7 + i * 1.5) + .014);
        drop.scale.setScalar(pixel * (1.25 + i * .14) * (1 - splashProgress));
      });
    }
    const x = ringAnchor.x + Math.sin(clock * .24) * pixel * (compact ? 2 : 4);
    const y = ringAnchor.y + Math.cos(clock * .21) * pixel * (compact ? 2 : 3);
    ring.position.set(x, y, water.heightAt(x, y) + .006);
    ring.rotation.set(.065 + Math.sin(clock * .56) * .035, -.09 + Math.sin(clock * .43) * .025, -.34 + Math.sin(clock * .2) * .10);
    for (const boat of boats) {
      if (clock >= boat.next && boats.some(other => other !== boat && clock >= other.start && clock < other.start + other.duration)) boat.next = clock + 7;
      if (clock >= boat.next) {
        boat.start = clock; boat.duration = 17 + random(boat.seed, clock + 1) * 6;
        boat.next = clock + boat.duration + 19 + random(boat.seed, clock + 2) * 21;
        boat.passes++;
      }
      const u = (clock - boat.start) / boat.duration;
      boat.root.visible = u >= 0 && u < 1;
      if (!boat.root.visible) continue;
      const right = boat.i === 1, side = right ? -1 : 1;
      let px, py, dx, dy;
      if (compact) {
        px = -.09 + u * 1.18; py = .258 + Math.sin(u * Math.PI * 2 + boat.seed) * .007;
        dx = 1.18; dy = Math.cos(u * Math.PI * 2 + boat.seed) * .007 * Math.PI * 2;
        if (right) { px = 1 - px; dx = -dx; }
      } else {
        // Both routes enter through an upper corner and arc down the outer
        // water margin. Their ends stay offscreen, so boats never pop away.
        const arc = Math.sin(Math.PI * u), variation = .012 * Math.sin(boat.seed);
        px = -.065 + (.17 + variation) * arc;
        py = (right ? .19 : .22) + u * (right ? .28 : .42);
        dx = (.17 + variation) * Math.PI * Math.cos(Math.PI * u); dy = right ? .28 : .42;
        if (right) px = 1 - px;
        dx *= side;
      }
      const bx = (px - .5) * spanX, by = (.5 - py) * spanY;
      boat.heading = Math.atan2(-dy * spanY, dx * spanX);
      boat.root.position.set(bx, by, water.heightAt(bx, by) + .017);
      boat.root.rotation.set(.07 * Math.sin(clock * .75 + boat.seed), .045 * Math.sin(clock * .51 + boat.seed), boat.heading, 'ZYX');
    }
  }
  function describe(camera, width, height) {
    const position = object => { object.getWorldPosition(projected); const z = projected.z; projected.project(camera); return { x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height, z }; };
    return { visible: group.visible, compact, clock: time, fish: fish.map(f => ({ ...position(f.root), visible: group.visible && f.root.visible, color: f.color, heading: f.root.rotation.z, tail: f.tail.rotation.z, jumping: time >= f.jumpStart && time <= f.jumpStart + f.jumpDuration, nextJump: f.nextJump, landings: f.landings, splash: f.splash.visible, depth: water.depthRange(f.root) })), ring: { ...position(ring), angle: ring.rotation.z, depth: water.depthRange(ring) }, boats: boats.map(boat => ({ ...position(boat.root), visible: group.visible && boat.root.visible, heading: boat.heading, passes: boat.passes, next: boat.next })) };
  }
  return { group, resize, update, describe };
}
