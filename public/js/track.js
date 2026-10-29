import * as THREE from 'three';

/**
 * Builds the world: ground, lights, a wide closed race circuit with continuous
 * walls (no gaps) and red/white kerbs, lane markings, start/finish line, and
 * scenery (trees + distant hills).
 *
 * Returns data the host uses for physics & lap logic:
 *   {
 *     samples, tangents, halfWidth, gates, startPositions,
 *     nearestInfo(pos, hintIndex) -> { index, dist, offset, nx, nz }
 *   }
 */
export function buildTrack(scene) {
  scene.fog = new THREE.Fog(0xbcd3e8, 320, 760);

  // ---------- Lights ----------
  const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x586b45, 0.55);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2da, 2.6);
  sun.position.set(160, 240, 120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = -320; s.right = 320; s.top = 320; s.bottom = -320;
  s.near = 10; s.far = 720;
  sun.shadow.bias = -0.0003;
  scene.add(sun);

  const groundBase = -16; // far flat ground level (below lowest track point)

  // ---------- Ground ----------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardMaterial({ map: makeGrassTexture(), roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = groundBase;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- Circuit centerline: [x, elevation, z] ----------
  const cp = [
    [0, 0, -170], [105, 5, -135], [175, 10, -45], [128, 7, 58], [175, 13, 150],
    [58, 8, 190], [-70, 3, 172], [-160, 1, 102], [-126, 6, 0], [-172, 10, -104], [-70, 4, -184],
  ];
  const controlPoints = cp.map(([x, y, z]) => new THREE.Vector3(x * 1.12, y, z * 1.12));

  const curve = new THREE.CatmullRomCurve3(controlPoints, true, 'catmullrom', 0.5);
  const SAMPLES = 520;
  const halfWidth = 22; // very wide road (44m across)

  const samples = curve.getSpacedPoints(SAMPLES); // these now carry elevation in .y
  samples.pop(); // clean closed ring
  // tangents are kept horizontal (XZ) so the road stays flat across its width
  const tangents = samples.map((_, i) => curve.getTangentAt(i / samples.length).setY(0).normalize());

  // Terrain height at lateral distance d from the centerline (sample height sy):
  // flat across the runoff, then an embankment sloping down to the ground base.
  const embInner = halfWidth + 16, embOuter = halfWidth + 80;
  function terrainHeight(d, sy) {
    if (d <= embInner) return sy;
    if (d >= embOuter) return groundBase;
    return sy + (groundBase - sy) * ((d - embInner) / (embOuter - embInner));
  }

  // ---------- Road, kerbs, walls ----------
  buildRibbon(scene, samples, tangents, -halfWidth, halfWidth, 0.01, makeAsphaltMat(), 1 / 7);
  buildRibbon(scene, samples, tangents, halfWidth - 1.6, halfWidth, 0.06, makeKerbMat(), 0.5);
  buildRibbon(scene, samples, tangents, -halfWidth, -(halfWidth - 1.6), 0.06, makeKerbMat(), 0.5);
  buildWall(scene, samples, tangents, halfWidth + 0.3, 3.2);
  buildWall(scene, samples, tangents, -(halfWidth + 0.3), 3.2);

  // Paved apron, gravel trap, then grass embankment that follows the elevation
  // and slopes down to the ground base.
  buildRibbon(scene, samples, tangents, halfWidth + 0.3, halfWidth + 9, 0.0, makeRunoffMat(), 1 / 7);
  buildRibbon(scene, samples, tangents, -(halfWidth + 9), -(halfWidth + 0.3), 0.0, makeRunoffMat(), 1 / 7);
  const gravelMat = makeGravelMat();
  buildRibbon(scene, samples, tangents, halfWidth + 9, halfWidth + 16, 0.0, gravelMat, 1 / 4);
  buildRibbon(scene, samples, tangents, -(halfWidth + 16), -(halfWidth + 9), 0.0, gravelMat, 1 / 4);
  const grassMat = makeGrassMat();
  buildEmbankment(scene, samples, tangents, halfWidth + 16, halfWidth + 80, groundBase, grassMat);
  buildEmbankment(scene, samples, tangents, -(halfWidth + 16), -(halfWidth + 80), groundBase, grassMat);

  // F1 dressing: catch fencing, start gantry, grid boxes, pit complex.
  buildCatchFence(scene, samples, tangents, halfWidth + 0.4);
  buildCatchFence(scene, samples, tangents, -(halfWidth + 0.4));
  const startLights = buildStartGantry(scene, samples[0], tangents[0], halfWidth);

  buildLaneDashes(scene, samples, tangents);
  buildStartLine(scene, samples[0], tangents[0], halfWidth);

  // ---------- Scenery ----------
  buildScenery(scene, samples, halfWidth, terrainHeight);
  buildHills(scene, groundBase);
  buildGrandstands(scene, samples, tangents, halfWidth, terrainHeight);
  buildTireBarriers(scene, samples, tangents, halfWidth);

  // ---------- Lap gates ----------
  const GATE_COUNT = 24;
  const gates = [];
  for (let g = 0; g < GATE_COUNT; g++) {
    const idx = Math.round((g / GATE_COUNT) * samples.length) % samples.length;
    gates.push({ pos: samples[idx].clone(), tangent: tangents[idx].clone(), index: idx });
  }

  const startPositions = makeStartGrid(samples, tangents, halfWidth);
  buildGridBoxes(scene, startPositions, tangents[0]);

  function nearestInfo(pos, _hint = 0) {
    // Project onto the continuous centerline instead of snapping to a sample.
    // Sample snapping made road height (and therefore body pitch) jump forward.
    const N = samples.length;
    let best = 0, bestD = Infinity, bestT = 0;
    for (let i = 0; i < N; i++) {
      const a = samples[i], b = samples[(i + 1) % N];
      const sx = b.x - a.x, sz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((pos.x - a.x) * sx + (pos.z - a.z) * sz) / (sx * sx + sz * sz)));
      const dx = pos.x - a.x - sx * t, dz = pos.z - a.z - sz * t;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; bestT = t; }
    }
    const next = (best + 1) % N;
    const a = samples[best], b = samples[next];
    const tx = THREE.MathUtils.lerp(tangents[best].x, tangents[next].x, bestT);
    const tz = THREE.MathUtils.lerp(tangents[best].z, tangents[next].z, bestT);
    const length = Math.hypot(tx, tz);
    const nx = tz / length, nz = -tx / length;
    const dx = pos.x - THREE.MathUtils.lerp(a.x, b.x, bestT);
    const dz = pos.z - THREE.MathUtils.lerp(a.z, b.z, bestT);
    const offset = dx * nx + dz * nz;
    return { index: best, dist: Math.sqrt(bestD), offset, nx, nz, groundY: THREE.MathUtils.lerp(a.y, b.y, bestT) };
  }

  return { samples, tangents, halfWidth, gates, startPositions, nearestInfo, startLights };
}

// ----------------------------------------------------------------------------
// Geometry helpers
// ----------------------------------------------------------------------------
function sqDistXZ(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }
function sideNormal(t) { return new THREE.Vector3(t.z, 0, -t.x).normalize(); }

// A flat ribbon following the track, from lateral offset oA to oB.
function buildRibbon(scene, samples, tangents, oA, oB, y, material, vPerSample) {
  const N = samples.length;
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= N; i++) {
    const c = samples[i % N];
    const n = sideNormal(tangents[i % N]);
    positions.push(c.x + n.x * oA, c.y + y, c.z + n.z * oA);
    positions.push(c.x + n.x * oB, c.y + y, c.z + n.z * oB);
    const v = i * vPerSample;
    uvs.push(0, v, 1, v);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, d, b, a, c, d); // wound so the surface faces UP
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// A sloped grass embankment: inner edge follows the track elevation, outer edge
// drops to a fixed ground level. Bridges the elevated track to the flat ground.
function buildEmbankment(scene, samples, tangents, innerOff, outerOff, outerY, material) {
  const N = samples.length;
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= N; i++) {
    const c = samples[i % N];
    const n = sideNormal(tangents[i % N]);
    positions.push(c.x + n.x * innerOff, c.y, c.z + n.z * innerOff);
    positions.push(c.x + n.x * outerOff, outerY, c.z + n.z * outerOff);
    uvs.push(0, i / 6, 1, i / 6);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, d, b, a, c, d); // faces UP
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// A continuous vertical wall along the track at lateral offset `off`.
function buildWall(scene, samples, tangents, off, height) {
  const N = samples.length;
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= N; i++) {
    const c = samples[i % N];
    const n = sideNormal(tangents[i % N]);
    const ex = c.x + n.x * off, ez = c.z + n.z * off;
    positions.push(ex, c.y, ez);            // bottom
    positions.push(ex, c.y + height, ez);   // top
    const u = i / 4; // panel repeat along length
    uvs.push(u, 0, u, 1);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, d, b, a, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: makeWallTexture(), roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(geo, mat);
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);
  return wall;
}

// Debris / catch fencing: vertical poles + a transparent wire-grid band on top
// of the wall (the most recognizable feature of a real circuit).
function buildCatchFence(scene, samples, tangents, off) {
  const N = samples.length;
  const y0 = 2.8, y1 = 7.4;

  // mesh band
  const positions = [], uvs = [], indices = [];
  for (let i = 0; i <= N; i++) {
    const c = samples[i % N], n = sideNormal(tangents[i % N]);
    const ex = c.x + n.x * off, ez = c.z + n.z * off;
    positions.push(ex, c.y + y0, ez); positions.push(ex, c.y + y1, ez);
    const u = i / 1.5;
    uvs.push(u, 0, u, 1);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    indices.push(a, d, b, a, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: makeFenceTexture(), transparent: true, alphaTest: 0.05, side: THREE.DoubleSide,
    depthWrite: false, roughness: 0.5, metalness: 0.4,
  });
  scene.add(new THREE.Mesh(geo, mat));

  // poles
  const poleGeo = new THREE.CylinderGeometry(0.16, 0.16, y1 + 0.4, 6);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.6, roughness: 0.5 });
  const step = 6;
  const inst = new THREE.InstancedMesh(poleGeo, poleMat, Math.ceil(N / step) + 2);
  inst.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  let count = 0;
  for (let i = 0; i < N; i += step) {
    const c = samples[i], n = sideNormal(tangents[i]);
    m.compose(new THREE.Vector3(c.x + n.x * off, c.y + (y1 + 0.4) / 2, c.z + n.z * off), q, new THREE.Vector3(1, 1, 1));
    inst.setMatrixAt(count++, m);
  }
  inst.count = count;
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// Overhead start/finish gantry. Returns the 5 light materials so the host can
// run the F1 start sequence (lights on one-by-one, then out = GO).
function buildStartGantry(scene, start, tangent, halfWidth) {
  const n = sideNormal(tangent);
  const h = 9;
  const reach = halfWidth + 1.5;
  const base = start.y;
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2e35, metalness: 0.7, roughness: 0.45 });
  const beamMat = new THREE.MeshStandardMaterial({ color: 0x14161b, metalness: 0.6, roughness: 0.5 });

  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, h, 1.2), metal);
    post.position.set(start.x + n.x * reach * side, base + h / 2, start.z + n.z * reach * side);
    post.castShadow = true;
    scene.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(reach * 2, 1.6, 2.4), beamMat);
  beam.position.set(start.x, base + h, start.z);
  beam.rotation.y = Math.atan2(-n.z, n.x);
  beam.castShadow = true;
  scene.add(beam);

  const lights = [];
  for (let i = 0; i < 5; i++) {
    const off = (i - 2) * 3;
    const mat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x330000, emissiveIntensity: 0.25 });
    const lp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 0.4), mat);
    lp.position.set(start.x + n.x * off - tangent.x * 1.3, base + h, start.z + n.z * off - tangent.z * 1.3);
    lp.rotation.y = Math.atan2(tangent.x, tangent.z);
    scene.add(lp);
    lights.push(mat);
  }
  return lights;
}

// Painted starting-grid boxes on the tarmac at each grid slot.
function buildGridBoxes(scene, startPositions, startTangent) {
  const tex = makeGridBoxTexture();
  const geo = new THREE.PlaneGeometry(4.5, 7);
  const angle = Math.atan2(startTangent.x, startTangent.z);
  for (const g of startPositions) {
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const box = new THREE.Mesh(geo, mat);
    box.rotation.x = -Math.PI / 2;
    box.rotation.z = -angle;
    box.position.set(g.pos.x, g.pos.y + 0.05, g.pos.z);
    scene.add(box);
  }
}

function buildLaneDashes(scene, samples, tangents) {
  const N = samples.length;
  const dash = new THREE.BoxGeometry(0.5, 0.05, 4);
  const mat = new THREE.MeshStandardMaterial({ color: 0xfff4d0, roughness: 0.5 });
  const step = 7;
  const inst = new THREE.InstancedMesh(dash, mat, Math.floor(N / step) + 1);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  let count = 0;
  for (let i = 0; i < N; i += step) {
    const t = tangents[i];
    q.setFromAxisAngle(up, Math.atan2(t.x, t.z));
    m.compose(new THREE.Vector3(samples[i].x, samples[i].y + 0.07, samples[i].z), q, new THREE.Vector3(1, 1, 1));
    inst.setMatrixAt(count++, m);
  }
  inst.count = count;
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

function buildStartLine(scene, center, tangent, halfWidth) {
  const n = sideNormal(tangent);
  const squares = 20;
  const sq = (halfWidth * 2) / squares;
  const geo = new THREE.PlaneGeometry(sq, sq * 2);
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });
  const group = new THREE.Group();
  for (let i = 0; i < squares; i++) {
    for (let row = 0; row < 2; row++) {
      const tile = new THREE.Mesh(geo, (i + row) % 2 === 0 ? white : black);
      tile.rotation.x = -Math.PI / 2;
      const along = (row - 0.5) * sq * 2;
      const across = -halfWidth + sq / 2 + i * sq;
      tile.position.set(
        center.x + n.x * across + tangent.x * along, center.y + 0.08,
        center.z + n.z * across + tangent.z * along
      );
      group.add(tile);
    }
  }
  scene.add(group);
}

function buildScenery(scene, samples, halfWidth, terrainHeight) {
  const trunkGeo = new THREE.CylinderGeometry(0.5, 0.8, 5, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4129, roughness: 1 });
  const leafGeo = new THREE.IcosahedronGeometry(4.2, 0); // faceted low-poly canopy
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x357a32, roughness: 0.9, flatShading: true });

  const COUNT = 160;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, COUNT);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, COUNT);
  trunks.castShadow = leaves.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  let n = 0, guard = 0;
  while (n < COUNT && guard < COUNT * 40) {
    guard++;
    const x = (Math.random() - 0.5) * 1300;
    const z = (Math.random() - 0.5) * 1300;
    const p = new THREE.Vector3(x, 0, z);
    // nearest sample (for both the keep-off-road test and the ground height)
    let nearD2 = Infinity, sy = 0;
    for (let i = 0; i < samples.length; i += 4) {
      const d2 = sqDistXZ(samples[i], p);
      if (d2 < nearD2) { nearD2 = d2; sy = samples[i].y; }
    }
    if (nearD2 < (halfWidth + 16) ** 2) continue; // keep trees off the track
    const gy = terrainHeight(Math.sqrt(nearD2), sy);
    const sc = 0.7 + Math.random() * 1.2;
    m.compose(new THREE.Vector3(x, gy + 2.5 * sc, z), q, new THREE.Vector3(sc, sc, sc));
    trunks.setMatrixAt(n, m);
    m.compose(new THREE.Vector3(x, gy + 7.5 * sc, z), q, new THREE.Vector3(sc, sc * 1.1, sc));
    leaves.setMatrixAt(n, m);
    n++;
  }
  trunks.count = leaves.count = n;
  trunks.instanceMatrix.needsUpdate = leaves.instanceMatrix.needsUpdate = true;
  scene.add(trunks, leaves);
}

function buildHills(scene, groundBase) {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x6f8f5f, roughness: 1, flatShading: true });
  const inst = new THREE.InstancedMesh(geo, mat, 18);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + Math.random() * 0.2;
    const r = 560 + Math.random() * 120;
    const sx = 80 + Math.random() * 90, sy = 35 + Math.random() * 40;
    m.compose(new THREE.Vector3(Math.cos(a) * r, groundBase + sy * 0.2, Math.sin(a) * r), q, new THREE.Vector3(sx, sy, sx));
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// Stadium grandstands around the outer edge of the circuit.
function buildGrandstands(scene, samples, tangents, halfWidth, terrainHeight) {
  const seatMat = new THREE.MeshStandardMaterial({ map: makeSeatTexture(), roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xced3da, roughness: 0.7, metalness: 0.1 });
  const centroid = new THREE.Vector3(0, 0, 0);

  const indices = [40, 130, 220, 310, 400, 480];
  for (const i of indices) {
    const c = samples[i % samples.length];
    let n = sideNormal(tangents[i % samples.length]);
    // ensure normal points OUTWARD (away from track centre)
    if (n.dot(new THREE.Vector3().subVectors(c, centroid)) < 0) n = n.clone().multiplyScalar(-1);
    const len = 80;
    const dist = halfWidth + 30;
    const px = c.x + n.x * dist, pz = c.z + n.z * dist;
    const faceAngle = Math.atan2(-n.x, -n.z); // face inward toward the track

    const g = new THREE.Group();
    g.position.set(px, terrainHeight(dist, c.y), pz);
    g.rotation.y = faceAngle;

    const seats = new THREE.Mesh(new THREE.BoxGeometry(len, 13, 20), seatMat);
    seats.rotation.x = -0.42; // slope the seating up and back
    seats.position.set(0, 7, -3);
    seats.receiveShadow = true; seats.castShadow = true;
    g.add(seats);

    const base = new THREE.Mesh(new THREE.BoxGeometry(len, 4, 6), wallMat);
    base.position.set(0, 2, 7);
    g.add(base);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 4, 1, 14), roofMat);
    roof.position.set(0, 15.5, -7);
    roof.castShadow = true;
    g.add(roof);
    for (const sx of [-len / 2 + 3, 0, len / 2 - 3]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 16, 1.2), roofMat);
      post.position.set(sx, 8, -13);
      g.add(post);
    }
    scene.add(g);
  }
}

// Stacks of tires lining the inside of the walls (decorative).
function buildTireBarriers(scene, samples, tangents, halfWidth) {
  const N = samples.length;
  const geo = new THREE.TorusGeometry(1.0, 0.42, 8, 12);
  const mat = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.95 });
  const step = 6;
  const inst = new THREE.InstancedMesh(geo, mat, Math.ceil(N / step) * 2 + 4);
  inst.castShadow = true;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // lay tire flat
  let count = 0;
  const off = halfWidth - 0.7;
  for (let i = 0; i < N; i += step) {
    const c = samples[i], n = sideNormal(tangents[i]);
    for (const side of [-1, 1]) {
      m.compose(new THREE.Vector3(c.x + n.x * off * side, c.y + 0.7, c.z + n.z * off * side), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(count++, m);
    }
  }
  inst.count = count;
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
}

// A packed crowd: dark seating with thousands of small multi-coloured dots
// (spectators), so the stand reads as a filled grandstand, not a rainbow smear.
function makeSeatTexture() {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#2b2f36'; ctx.fillRect(0, 0, 256, 256);
    // faint seat rows
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < 256; y += 8) ctx.fillRect(0, y, 256, 2);
    const cols = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#ecf0f1', '#e67e22', '#9b59b6', '#16a085', '#ffffff', '#34495e'];
    for (let y = 3; y < 256; y += 6) {
      for (let x = 2; x < 256; x += 5) {
        if (Math.random() < 0.7) {
          ctx.fillStyle = cols[(Math.random() * cols.length) | 0];
          ctx.fillRect(x + (Math.random() * 2 | 0), y, 3, 3);
        }
      }
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(12, 5);
  return tex;
}

function makeStartGrid(samples, tangents, halfWidth) {
  const start = samples[0], t = tangents[0], n = sideNormal(t);
  const heading = Math.atan2(t.x, t.z);
  const lanes = [-halfWidth * 0.4, halfWidth * 0.4];
  const rows = [-8, -20];
  const out = [];
  for (let r = 0; r < 2; r++) {
    for (let l = 0; l < 2; l++) {
      out.push({
        pos: new THREE.Vector3(
          start.x + t.x * rows[r] + n.x * lanes[l], start.y,
          start.z + t.z * rows[r] + n.z * lanes[l]
        ),
        heading,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Procedural textures / materials
// ----------------------------------------------------------------------------
function makeAsphaltMat() {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#34373d'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4000; i++) {
      const v = 36 + Math.random() * 42;
      ctx.fillStyle = `rgba(${v},${v},${v + 5},0.5)`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.02 });
}

function makeKerbMat() {
  const tex = canvasTexture(32, 32, (ctx) => {
    ctx.fillStyle = '#d83a2f'; ctx.fillRect(0, 0, 32, 16);
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(0, 16, 32, 16);
  });
  tex.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
}

// Trackside advertising hoardings (sponsor boards) baked into the wall.
function makeWallTexture() {
  const tex = canvasTexture(256, 64, (ctx) => {
    const panels = ['#0a4ea2', '#d62828', '#f7f7f7', '#1f9d55', '#f59f00', '#222831'];
    const pw = 256 / 6;
    for (let i = 0; i < 6; i++) {
      const x = i * pw;
      ctx.fillStyle = panels[i];
      ctx.fillRect(x, 0, pw, 64);
      // a "logo": contrasting block + bar
      ctx.fillStyle = i === 2 ? '#0a4ea2' : 'rgba(255,255,255,0.92)';
      ctx.fillRect(x + 8, 20, pw - 16, 14);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x + 8, 40, pw - 16, 6);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + pw - 2, 0, 2, 64); // seam
    }
  });
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  return tex;
}

// Light grey paved runoff / apron outside the barriers.
function makeRunoffMat() {
  const tex = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#6b6f75'; ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 1400; i++) {
      const v = 90 + Math.random() * 40;
      ctx.fillStyle = `rgba(${v},${v},${v + 3},0.4)`;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.97, metalness: 0.0 });
}

// Beige speckled gravel trap.
function makeGravelMat() {
  const tex = canvasTexture(128, 128, (ctx) => {
    ctx.fillStyle = '#b8a578'; ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 2600; i++) {
      const v = 150 + Math.random() * 70;
      ctx.fillStyle = `rgba(${v},${v - 20},${v - 60},0.55)`;
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
}

// Grass material for the embankment (tiled).
function makeGrassMat() {
  const tex = makeGrassTexture();
  tex.repeat.set(8, 60);
  return new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 });
}

// Starting-grid box: white border + a forward arrow, transparent centre.
function makeGridBoxTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = '#f4f4f4'; ctx.lineWidth = 8;
  ctx.strokeRect(8, 8, 112, 112);
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(58, 70, 12, 36);          // arrow stem
  ctx.beginPath(); ctx.moveTo(64, 40); ctx.lineTo(46, 72); ctx.lineTo(82, 72); ctx.closePath(); ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Transparent wire-grid texture for the catch fence.
function makeFenceTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(180,188,200,0.55)';
  ctx.lineWidth = 1.5;
  for (let p = 0; p <= 64; p += 8) {
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, 64); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(64, p); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 4);
  return tex;
}

function makeGrassTexture() {
  const tex = canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#54a036'; ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 3200; i++) {
      const g = 110 + Math.random() * 70;
      ctx.fillStyle = `rgba(${28 + Math.random() * 40},${g},${30 + Math.random() * 30},0.5)`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 3);
    }
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(80, 80);
  tex.anisotropy = 8;
  return tex;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
