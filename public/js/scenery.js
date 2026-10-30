import * as THREE from 'three';

// All assets are generated once. No image requests or per-tree update loop.
function randomSequence(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Merge differently coloured parts into one geometry/material (no draw groups).
function mergeColoured(parts) {
  const positions = [], normals = [], colours = [];
  for (const [source, hex] of parts) {
    const geometry = source.index ? source.toNonIndexed() : source;
    const colour = new THREE.Color(hex);
    positions.push(...geometry.attributes.position.array);
    normals.push(...geometry.attributes.normal.array);
    for (let i = 0; i < geometry.attributes.position.count; i++) colours.push(colour.r, colour.g, colour.b);
    if (geometry !== source) geometry.dispose();
    source.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function nearestRoad(x, z, samples) {
  let distanceSq = Infinity, height = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i], b = samples[(i + 1) % samples.length];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
    const d = (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2;
    if (d < distanceSq) { distanceSq = d; height = THREE.MathUtils.lerp(a.y, b.y, t); }
  }
  return { distance: Math.sqrt(distanceSq), height };
}

export function buildTrackScenery(scene, samples, tangents, halfWidth, terrainHeight, groundBase) {
  const root = new THREE.Group();
  root.name = 'track-scenery';
  scene.add(root);
  const stands = buildGrandstands(root, samples, tangents, halfWidth, groundBase);
  buildForest(root, samples, tangents, halfWidth, terrainHeight, stands);
  buildMountains(root, groundBase);
  return root;
}

function buildForest(root, samples, tangents, halfWidth, terrainHeight, stands) {
  const geometry = mergeColoured([
    [new THREE.CylinderGeometry(0.28, 0.55, 7, 6).translate(0, 3.5, 0), 0x675341],
    [new THREE.ConeGeometry(3.8, 7, 8).translate(0, 6.5, 0), 0x294e3b],
    [new THREE.ConeGeometry(3.1, 6, 8).translate(0, 10, 0), 0x345e46],
    [new THREE.ConeGeometry(2.1, 5.5, 8).translate(0, 13, 0), 0x426c50],
  ]);
  const trees = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.65,
  }), samples.length * 2);
  trees.name = 'instanced-pine-forest';
  // Trunks and three foliage tiers share one draw call per viewport. Avoid a
  // second forest pass in the shadow map; the barriers already shade the road.
  const random = randomSequence(7842), matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3(), scale = new THREE.Vector3(), tint = new THREE.Color();
  let count = 0;
  for (let i = 0; i < samples.length; i += 4) {
    const c = samples[i], t = tangents[i];
    for (const side of [-1, 1]) {
      for (let row = 0; row < 4; row++) {
        const offset = side * (halfWidth + 21 + row * 17 + random() * 11);
        const along = (random() - 0.5) * 12;
        const x = c.x + t.z * offset + t.x * along;
        const z = c.z - t.x * offset + t.z * along;
        const road = nearestRoad(x, z, samples);
        if (road.distance < halfWidth + 18) continue;
        // Reserve the entire stand footprint, including canopy and tree radius.
        if (stands.some(stand => {
          const dx = x - stand.position.x, dz = z - stand.position.z;
          const localX = dx * stand.userData.right.x + dz * stand.userData.right.z;
          const localZ = dx * stand.userData.outward.x + dz * stand.userData.outward.z;
          return Math.abs(localX) < 29 && localZ > -7 && localZ < 23;
        })) continue;
        const size = 0.85 + random() * 0.65;
        position.set(x, terrainHeight(road.distance, road.height) - 0.15, z);
        rotation.setFromAxisAngle(up, random() * Math.PI * 2);
        scale.set(size, size * (1.1 + random() * 0.35), size);
        matrix.compose(position, rotation, scale);
        trees.setMatrixAt(count, matrix);
        tint.setHSL(0.29 + random() * 0.04, 0.10, 0.68 + random() * 0.18);
        trees.setColorAt(count++, tint);
      }
    }
  }
  trees.count = count;
  trees.instanceMatrix.needsUpdate = trees.instanceColor.needsUpdate = true;
  trees.computeBoundingBox();
  trees.computeBoundingSphere();
  root.add(trees);
}

function drawSpectator(ctx, x, y, w, h, random) {
  const shirts = ['#8e3738', '#c29a50', '#53768a', '#c2c7c1', '#394956', '#607b64', '#b76b45', '#6d526f'];
  const skin = ['#d3a078', '#a66d4c', '#e0ba95', '#80573e'];
  ctx.fillStyle = '#25313c';
  ctx.fillRect(x + w * 0.27, y + h * 0.65, w * 0.18, h * 0.33);
  ctx.fillRect(x + w * 0.55, y + h * 0.65, w * 0.18, h * 0.33);
  ctx.fillStyle = shirts[Math.floor(random() * shirts.length)];
  ctx.beginPath();
  ctx.moveTo(x + w * 0.27, y + h * 0.30);
  ctx.lineTo(x + w * 0.73, y + h * 0.30);
  ctx.lineTo(x + w * 0.86, y + h * 0.69);
  ctx.lineTo(x + w * 0.14, y + h * 0.69);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = skin[Math.floor(random() * skin.length)];
  ctx.beginPath(); ctx.ellipse(x + w * 0.5, y + h * 0.18, w * 0.18, h * 0.13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = random() > 0.25 ? '#35302b' : '#b5a58c';
  ctx.beginPath(); ctx.ellipse(x + w * 0.5, y + h * 0.10, w * 0.19, h * 0.065, 0, Math.PI, Math.PI * 2); ctx.fill();
}

function crowdTexture(atlas) {
  const canvas = document.createElement('canvas');
  canvas.width = atlas ? 256 : 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d'), random = randomSequence(140);
  const columns = atlas ? 4 : 8, rows = atlas ? 2 : 3;
  const w = canvas.width / columns, h = canvas.height / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      drawSpectator(ctx, col * w + w * 0.06, row * h + h * 0.03, w * 0.88, h * 0.94, random);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = atlas ? 'spectator-atlas-4x2' : 'distant-crowd-patch';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function billboardMaterial(map, atlas) {
  const material = new THREE.MeshBasicMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide });
  // Alpha cutouts write depth: no sorting glitches between crowd rows. The
  // view-space offset uses the CURRENT render camera, including split screen.
  material.onBeforeCompile = shader => {
    if (atlas) {
      shader.vertexShader = 'attribute float atlasCell;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `
        #include <uv_vertex>
        vMapUv = (vMapUv + vec2(mod(atlasCell, 4.0), floor(atlasCell / 4.0))) / vec2(4.0, 2.0);
      `);
    }
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      mvPosition.xy += position.xy;
      gl_Position = projectionMatrix * mvPosition;
    `);
  };
  material.customProgramCacheKey = () => atlas ? 'crowd-billboard-atlas-v1' : 'crowd-billboard-patch-v1';
  return material;
}

function crowdMesh(material, distant) {
  const rows = distant ? 2 : 6, columns = distant ? 6 : 48;
  const geometry = new THREE.PlaneGeometry(distant ? 7 : 0.84, distant ? 4.6 : 1.8);
  const cells = new Float32Array(rows * columns);
  const crowd = new THREE.InstancedMesh(geometry, material, cells.length);
  crowd.name = distant ? 'crowd-distant' : 'crowd-near';
  const random = randomSequence(90), matrix = new THREE.Matrix4();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col;
      const seatingRow = distant ? row * 3 + 1 : row;
      const x = (col + 0.5) * 42 / columns - 21;
      const y = 2.1 + seatingRow * 1.25 + (distant ? 1.8 : 0.9);
      matrix.makeTranslation(x, y, 1 + seatingRow * 2 + (random() - 0.5) * 0.3);
      crowd.setMatrixAt(index, matrix);
      cells[index] = Math.floor(random() * 8);
    }
  }
  if (!distant) geometry.setAttribute('atlasCell', new THREE.InstancedBufferAttribute(cells, 1));
  crowd.instanceMatrix.needsUpdate = true;
  crowd.computeBoundingSphere();
  return crowd;
}

function standGeometry(detailed, groundBase, baseY) {
  const parts = [];
  const box = (w, h, d, x, y, z, colour) => parts.push([new THREE.BoxGeometry(w, h, d).translate(x, y, z), colour]);
  // Foundation extends below the terrain, so raised stands never float on slopes.
  const bottom = groundBase - baseY - 1;
  box(44, 2 - bottom, 12, 0, (2 + bottom) / 2, 6, 0x686d70);
  for (let row = 1; row < 6; row++) {
    box(44, 1.25, 12 - row * 2, 0, 2 + (row - 0.5) * 1.25, 6 + row, 0x7c8286);
  }
  // Rear canopy and pillars are combined into the same draw call as the tiers.
  box(47, 0.45, 9, 0, 12, 8.5, 0x3d505c);
  for (const x of [-21, 0, 21]) box(0.35, 10, 0.35, x, 7, 11.8, 0x424b50);
  if (detailed) {
    for (const x of [-22, 22]) {
      for (let row = 0; row < 6; row++) {
        box(0.12, 1.1, 0.12, x, 2.55 + row * 1.25, row * 2 + 0.5, 0xabb3b8);
        box(0.12, 0.12, 2, x, 3.1 + row * 1.25, row * 2 + 1, 0xabb3b8);
      }
    }
    box(44, 0.12, 0.12, 0, 3.1, 0.15, 0xabb3b8);
  }
  return mergeColoured(parts);
}

function buildGrandstands(root, samples, tangents, halfWidth, groundBase) {
  const stands = [], up = new THREE.Vector3(0, 1, 0);
  const structureMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.7 });
  const nearMaterial = billboardMaterial(crowdTexture(true), true);
  const farMaterial = billboardMaterial(crowdTexture(false), false);
  for (const fraction of [0.025, 0.29, 0.54, 0.81]) {
    const index = Math.floor(samples.length * fraction), c = samples[index], t = tangents[index];
    const outward = new THREE.Vector3(t.z, 0, -t.x);
    if (outward.x * c.x + outward.z * c.z < 0) outward.negate();
    const right = new THREE.Vector3(outward.z, 0, -outward.x);
    const position = c.clone().addScaledVector(outward, halfWidth + 14);
    // Check the whole footprint against ALL road segments, not just this bend.
    let clear = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      clear = true;
      for (const x of [-24, 0, 24]) for (const z of [-1, 6, 14]) {
        const p = position.clone().addScaledVector(right, x).addScaledVector(outward, z);
        if (nearestRoad(p.x, p.z, samples).distance < halfWidth + 7) clear = false;
      }
      if (clear) break;
      position.addScaledVector(outward, 4);
    }
    if (!clear) continue;
    const lod = new THREE.LOD();
    lod.name = 'grandstand-' + stands.length;
    lod.position.copy(position);
    lod.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, outward));
    lod.userData.right = right;
    lod.userData.outward = outward;
    for (let level = 0; level < 3; level++) {
      const group = new THREE.Group();
      const structure = new THREE.Mesh(standGeometry(level === 0, groundBase, c.y), structureMaterial);
      structure.receiveShadow = true;
      group.add(structure);
      if (level < 2) group.add(crowdMesh(level === 0 ? nearMaterial : farMaterial, level === 1));
      // Three.js updates LOD for each render camera. No hysteresis state shared
      // between a nearby player's viewport and another player's distant view.
      lod.addLevel(group, [0, 180, 420][level]);
    }
    stands.push(lod);
    root.add(lod);
  }
  return stands;
}

function buildMountains(root, groundBase) {
  // Two continuous, irregular ridge ribbons, not isolated polygonal hills.
  // Colour provides atmospheric haze without fog erasing the distant silhouette.
  for (let layer = 0; layer < 2; layer++) {
    const positions = [], colours = [], indices = [];
    const segments = 256, radius = layer === 0 ? 1080 : 730;
    const foot = new THREE.Color(layer === 0 ? 0xbda99c : 0xa19a93);
    const peak = new THREE.Color(layer === 0 ? 0x9e969a : 0x7c8588);
    for (let i = 0; i <= segments; i++) {
      const a = i / segments * Math.PI * 2;
      const profile = 0.5 + 0.22 * Math.sin(a * 5 + layer * 2) + 0.14 * Math.cos(a * 11 + layer) + 0.08 * Math.sin(a * 23) + 0.04 * Math.cos(a * 47);
      const height = (layer === 0 ? 145 : 65) + profile * (layer === 0 ? 210 : 145);
      for (let row = 0; row < 3; row++) {
        const f = row / 2;
        positions.push(Math.cos(a) * radius, THREE.MathUtils.lerp(groundBase - 30, height, f), Math.sin(a) * radius);
        const shade = foot.clone().lerp(peak, f);
        colours.push(shade.r, shade.g, shade.b);
      }
      if (i < segments) for (let row = 0; row < 2; row++) {
        const n = i * 3 + row;
        indices.push(n, n + 3, n + 1, n + 1, n + 3, n + 4);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    geometry.setIndex(indices);
    const mountains = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false }));
    mountains.name = 'mountain-ridge-' + layer;
    root.add(mountains);
  }
}
