import * as THREE from 'three';

// Scenery is built once; the forest shares one local texture atlas and has no
// per-tree JavaScript update loop.
function randomSequence(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Merge differently coloured parts into one geometry/material (no draw groups).
function mergeColoured(parts) {
  const positions = [],
    normals = [],
    colours = [];
  for (const [source, hex] of parts) {
    const geometry = source.index ? source.toNonIndexed() : source;
    const colour = new THREE.Color(hex);
    positions.push(...geometry.attributes.position.array);
    normals.push(...geometry.attributes.normal.array);
    for (let i = 0; i < geometry.attributes.position.count; i++)
      colours.push(colour.r, colour.g, colour.b);
    if (geometry !== source) geometry.dispose();
    source.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function nearestRoad(x, z, samples) {
  let distanceSq = Infinity,
    height = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i],
      b = samples[(i + 1) % samples.length];
    const dx = b.x - a.x,
      dz = b.z - a.z;
    const t = THREE.MathUtils.clamp(
      ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz),
      0,
      1,
    );
    const d = (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2;
    if (d < distanceSq) {
      distanceSq = d;
      height = THREE.MathUtils.lerp(a.y, b.y, t);
    }
  }
  return { distance: Math.sqrt(distanceSq), height };
}

export function buildTrackScenery(
  scene,
  samples,
  tangents,
  halfWidth,
  terrainHeight,
  groundBase,
) {
  const root = new THREE.Group();
  root.name = 'track-scenery';
  scene.add(root);
  const stands = buildGrandstands(
    root,
    samples,
    tangents,
    halfWidth,
    groundBase,
  );
  buildForest(root, samples, tangents, halfWidth, terrainHeight, stands);
  buildMountains(root, groundBase);
  return root;
}

function buildForest(
  root,
  samples,
  tangents,
  halfWidth,
  terrainHeight,
  stands,
) {
  const capacity = samples.length * 2;
  // Four photographic cutouts share two triangles per tree. The small offset
  // below the pivot sinks the transparent bottom padding into the terrain.
  const geometry = new THREE.PlaneGeometry(10, 16).translate(0, 7.5, 0);
  const variants = new Float32Array(capacity),
    mirrors = new Float32Array(capacity);
  geometry.setAttribute(
    'treeVariant',
    new THREE.InstancedBufferAttribute(variants, 1),
  );
  geometry.setAttribute(
    'treeMirror',
    new THREE.InstancedBufferAttribute(mirrors, 1),
  );
  const nearFades = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity),
    1,
  );
  nearFades.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('treeNear', nearFades);
  const material = new THREE.MeshBasicMaterial({
    alphaTest: 0.4,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float treeVariant;\nattribute float treeMirror;\nattribute float treeNear;\nvarying float vTreeNear;\n' +
      shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `
      #include <uv_vertex>
      vMapUv.x = mix(vMapUv.x, 1.0 - vMapUv.x, treeMirror);
      // Keep sampling within this quadrant, including at the card edges.
      vMapUv = (clamp(vMapUv, vec2(0.002), vec2(0.998))
        + vec2(mod(treeVariant, 2.0), floor(treeVariant / 2.0))) * 0.5;
    `,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      vec3 treeBase = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 facing = cameraPosition - treeBase;
      vec3 treeRight = normalize(vec3(facing.z + 0.00001, 0.0, -facing.x));
      float treeWidth = length(instanceMatrix[0].xyz);
      float treeHeight = length(instanceMatrix[1].xyz);
      vec3 treePosition = treeBase + treeRight * position.x * treeWidth
        + vec3(0.0, position.y * treeHeight, 0.0);
      vec4 mvPosition = viewMatrix * vec4(treePosition, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      vTreeNear = treeNear;
      if (treeNear >= 0.999) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    `,
    );
    shader.fragmentShader =
      'varying float vTreeNear;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `
      #include <clipping_planes_fragment>
      if (vTreeNear > 0.0) {
        float coverage = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        if (coverage < vTreeNear) discard;
      }
    `,
    );
  };
  material.customProgramCacheKey = () => 'pine-cutout-billboards-v2';
  const trees = new THREE.InstancedMesh(geometry, material, capacity);
  trees.name = 'instanced-pine-forest';
  // Alpha testing writes depth without transparent sorting. Each viewport uses
  // its own camera automatically; trees remain upright when the camera pitches.
  // Hide unloaded cards so there is no flash of solid rectangles on startup.
  trees.visible = false;
  trees.userData.textureReady = false;
  trees.userData.nearCandidates = [];
  material.map = new THREE.TextureLoader().load(
    '/assets/pine-tree-atlas.webp',
    () => {
      trees.userData.textureReady = true;
      trees.visible = true;
    },
    undefined,
    (error) => {
      trees.userData.textureError = true;
      console.warn('Forest texture failed to load.', error);
    },
  );
  material.map.name = 'pine-tree-atlas-2x2';
  material.map.colorSpace = THREE.SRGBColorSpace;
  material.map.anisotropy = 4;
  // Avoid a second forest pass in the shadow map.
  const styleRandom = randomSequence(416);
  const random = randomSequence(7842),
    matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion(),
    up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3(),
    scale = new THREE.Vector3(),
    tint = new THREE.Color();
  let count = 0;
  for (let i = 0; i < samples.length; i += 4) {
    const c = samples[i],
      t = tangents[i];
    for (const side of [-1, 1]) {
      for (let row = 0; row < 4; row++) {
        const offset = side * (halfWidth + 21 + row * 17 + random() * 11);
        const along = (random() - 0.5) * 12;
        const x = c.x + t.z * offset + t.x * along;
        const z = c.z - t.x * offset + t.z * along;
        const road = nearestRoad(x, z, samples);
        if (road.distance < halfWidth + 18) continue;
        // Reserve the entire stand footprint, including canopy and tree radius.
        if (
          stands.some((stand) => {
            const dx = x - stand.position.x,
              dz = z - stand.position.z;
            const localX =
              dx * stand.userData.right.x + dz * stand.userData.right.z;
            const localZ =
              dx * stand.userData.outward.x + dz * stand.userData.outward.z;
            return Math.abs(localX) < 32 && localZ > -10 && localZ < 26;
          })
        )
          continue;
        const size = 0.85 + random() * 0.65;
        position.set(x, terrainHeight(road.distance, road.height) - 0.15, z);
        rotation.setFromAxisAngle(up, random() * Math.PI * 2);
        scale.set(size, size * (1.1 + random() * 0.35), size);
        matrix.compose(position, rotation, scale);
        trees.setMatrixAt(count, matrix);
        // Sparse choices along the closest row; distant rows always use cards.
        if (row === 0 && i % 12 === 0)
          trees.userData.nearCandidates.push(count);
        variants[count] = Math.floor(styleRandom() * 4);
        mirrors[count] = styleRandom() < 0.5 ? 0 : 1;
        tint.setHSL(0.29 + random() * 0.04, 0.08, 0.88 + random() * 0.1);
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
  const shirts = [
    '#8e3738',
    '#c29a50',
    '#53768a',
    '#c2c7c1',
    '#394956',
    '#607b64',
    '#b76b45',
    '#6d526f',
  ];
  const skin = ['#d3a078', '#a66d4c', '#e0ba95', '#80573e'];
  // Seated silhouettes: bent knees, a shorter torso and resting forearms.
  ctx.fillStyle = '#25313c';
  ctx.fillRect(x + w * 0.23, y + h * 0.62, w * 0.23, h * 0.3);
  ctx.fillRect(x + w * 0.54, y + h * 0.62, w * 0.23, h * 0.3);
  ctx.fillStyle = '#171e24';
  ctx.fillRect(x + w * 0.19, y + h * 0.89, w * 0.27, h * 0.07);
  ctx.fillRect(x + w * 0.54, y + h * 0.89, w * 0.27, h * 0.07);
  ctx.fillStyle = shirts[Math.floor(random() * shirts.length)];
  ctx.beginPath();
  ctx.moveTo(x + w * 0.27, y + h * 0.3);
  ctx.lineTo(x + w * 0.73, y + h * 0.3);
  ctx.lineTo(x + w * 0.86, y + h * 0.69);
  ctx.lineTo(x + w * 0.14, y + h * 0.69);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = skin[Math.floor(random() * skin.length)];
  ctx.fillRect(x + w * 0.19, y + h * 0.48, w * 0.12, h * 0.18);
  ctx.fillRect(x + w * 0.69, y + h * 0.48, w * 0.12, h * 0.18);
  ctx.beginPath();
  ctx.ellipse(x + w * 0.5, y + h * 0.18, w * 0.18, h * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = random() > 0.25 ? '#35302b' : '#b5a58c';
  ctx.beginPath();
  ctx.ellipse(
    x + w * 0.5,
    y + h * 0.1,
    w * 0.19,
    h * 0.065,
    0,
    Math.PI,
    Math.PI * 2,
  );
  ctx.fill();
}

function crowdTexture(atlas, image = null) {
  const canvas = document.createElement('canvas');
  canvas.width = atlas ? 256 : 1024;
  canvas.height = atlas ? 384 : 256;
  const ctx = canvas.getContext('2d'),
    random = randomSequence(140);
  const columns = atlas ? 4 : 10,
    rows = atlas ? 4 : 2;
  const w = canvas.width / columns,
    h = canvas.height / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      if (image) {
        if (random() < 0.15) continue;
        const cell = Math.floor(random() * 16);
        // Bake two overlapping seating rows into each distant crowd patch.
        ctx.drawImage(
          image,
          (cell % 4) * image.width / 4,
          Math.floor(cell / 4) * image.height / 4,
          image.width / 4, image.height / 4,
          col * w, row * canvas.height * 0.325,
          w, canvas.height * 0.675,
        );
        continue;
      }
      drawSpectator(
        ctx,
        col * w + w * 0.06,
        row * h + h * 0.03,
        w * 0.88,
        h * 0.94,
        random,
      );
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = atlas ? 'spectator-fallback-4x4' : 'distant-crowd-patch';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function billboardMaterial(map, atlas) {
  const material = new THREE.MeshBasicMaterial({
    map,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
  });
  // Alpha cutouts write depth: no sorting glitches between crowd rows. The
  // Upright cards face the CURRENT render camera, including split screen.
  material.onBeforeCompile = (shader) => {
    if (atlas) {
      shader.vertexShader =
        'attribute float atlasCell;\nattribute float crowdMirror;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `
        #include <uv_vertex>
        vMapUv.x = mix(vMapUv.x, 1.0 - vMapUv.x, crowdMirror);
        vMapUv = (clamp(vMapUv, vec2(0.003), vec2(0.997))
          + vec2(mod(atlasCell, 4.0), floor(atlasCell / 4.0))) / 4.0;
      `,
      );
    }
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
      vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 facing = cameraPosition - centre;
      vec3 right = normalize(vec3(facing.z + 0.00001, 0.0, -facing.x));
      vec3 crowdWorldPosition = centre + right * position.x * length(instanceMatrix[0].xyz)
        + vec3(0.0, position.y * length(instanceMatrix[1].xyz), 0.0);
      vec4 mvPosition = viewMatrix * vec4(crowdWorldPosition, 1.0);
      gl_Position = projectionMatrix * mvPosition;
    `,
    );
  };
  material.customProgramCacheKey = () =>
    atlas ? 'crowd-upright-atlas-v2' : 'crowd-upright-patch-v2';
  return material;
}

function crowdMesh(material, distant, seed) {
  const rows = distant ? 4 : 8,
    columns = distant ? 4 : 40;
  const geometry = new THREE.PlaneGeometry(
    distant ? 9 : 0.9,
    distant ? 2 : 1.35,
  );
  const cells = new Float32Array(rows * columns);
  const mirrors = new Float32Array(cells.length);
  const crowd = new THREE.InstancedMesh(geometry, material, cells.length);
  crowd.name = distant ? 'crowd-distant' : 'crowd-near';
  const random = randomSequence(seed),
    matrix = new THREE.Matrix4(),
    tint = new THREE.Color();
  let count = 0;
  for (let row = 0; row < rows; row++) {
    let emptyGroup = false;
    for (let col = 0; col < columns; col++) {
      // Neighbouring seats tend to fill together, with occasional pairs empty.
      if (col % 2 === 0) emptyGroup = random() < 0.12;
      if (!distant && (emptyGroup || random() < 0.05)) continue;
      const seatingRow = distant ? row * 2 + 0.5 : row;
      const block = distant ? col : Math.floor(col / 10);
      const x = -16.5 + block * 11 + (distant ? 0 : ((col % 10) - 4.5) * 0.9);
      const size = distant ? 1 : 0.94 + random() * 0.12;
      const y = 1.4 + seatingRow * 0.65 + 0.675 * size;
      matrix.makeScale(size, size, size);
      matrix.setPosition(x, y, 0.78 + seatingRow * 1.4);
      crowd.setMatrixAt(count, matrix);
      // Mild tint variation preserves natural skin tones and breaks repetition.
      tint.setRGB(0.86 + random() * 0.14, 0.86 + random() * 0.12, 0.84 + random() * 0.12);
      crowd.setColorAt(count, tint);
      mirrors[count] = random() < 0.5 ? 0 : 1;
      cells[count++] = Math.floor(random() * 16);
    }
  }
  if (!distant) {
    geometry.setAttribute(
      'atlasCell',
      new THREE.InstancedBufferAttribute(cells, 1),
    );
    geometry.setAttribute('crowdMirror', new THREE.InstancedBufferAttribute(mirrors, 1));
  }
  crowd.count = count;
  crowd.instanceMatrix.needsUpdate = true;
  crowd.instanceColor.needsUpdate = true;
  crowd.computeBoundingSphere();
  return crowd;
}

function standGeometry(detailed, groundBase, baseY) {
  const parts = [];
  const box = (w, h, d, x, y, z, colour) =>
    parts.push([new THREE.BoxGeometry(w, h, d).translate(x, y, z), colour]);
  const beam = (a, b, width, depth, colour) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const direction = end.clone().sub(start);
    const geometry = new THREE.BoxGeometry(width, direction.length(), depth);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), direction.clone().normalize(),
    ));
    geometry.translate(...start.add(end).multiplyScalar(0.5).toArray());
    parts.push([geometry, colour]);
  };
  const concrete = 0x858984, steel = 0x4b5559, rail = 0xb3b9b8;
  const blocks = [-16.5, -5.5, 5.5, 16.5];
  // A retaining plinth embeds the structure into the sloping embankment.
  const bottom = groundBase - baseY - 1;
  box(44, 1.4 - bottom, 12.6, 0, (1.4 + bottom) / 2, 6.1, 0x696e6b);
  for (let row = 0; row < 8; row++) {
    const y = 1.4 + row * 0.65, z = row * 1.4;
    if (row > 0) box(44, 0.65, 12.4 - z, 0, y - 0.325, (12.4 + z) / 2, concrete);
    box(44, 0.08, 0.12, 0, y + 0.015, z + 0.06, 0xbabbb2);
    for (let block = 0; block < blocks.length; block++) {
      const colour = block % 2 ? 0x496c78 : 0x647f87;
      if (detailed) {
        for (let seat = 0; seat < 10; seat++) {
          const x = blocks[block] + (seat - 4.5) * 0.9;
          box(0.12, 0.38, 0.14, x, y + 0.19, z + 0.95, steel);
          box(0.72, 0.1, 0.52, x, y + 0.43, z + 0.85, colour);
          const back = new THREE.BoxGeometry(0.7, 0.52, 0.09);
          back.rotateX(0.12).translate(x, y + 0.71, z + 1.12);
          parts.push([back, colour]);
        }
      } else {
        box(8.8, 0.48, 0.12, blocks[block], y + 0.7, z + 1.12, colour);
      }
    }
    if (detailed && row < 7) {
      for (const x of [-11, 0, 11]) {
        // Four normal-height treads connect each pair of seating terraces.
        for (let step = 1; step <= 4; step++) {
          const top = y + step * 0.1625;
          const depth = 1.4 - (step - 1) * 0.35;
          box(1.6, step * 0.1625, depth, x, (y + top) / 2,
            z + (step - 1) * 0.35 + depth / 2, 0x999b93);
          box(1.6, 0.025, 0.055, x, top + 0.015, z + (step - 1) * 0.35 + 0.03, 0xc9b77e);
        }
      }
    }
  }
  // Sloped metal canopy, with visible rafters, columns and knee braces.
  const roof = new THREE.BoxGeometry(47, 0.18, 14);
  roof.rotateX(-0.065).translate(0, 8.85, 6.1);
  parts.push([roof, 0x697b80]);
  for (const x of [-21.7, -11, 0, 11, 21.7]) {
    box(0.25, 7.7, 0.25, x, 5.25, 12, steel);
    box(0.55, 0.12, 0.55, x, 6.02, 12, 0xa4a6a1);
    beam([x, 8.15, -0.8], [x, 9.05, 12.9], 0.18, 0.3, steel);
    beam([x, 6.8, 12], [x, 8.75, 7.5], 0.14, 0.14, steel);
  }
  box(47, 0.4, 0.18, 0, 8.25, -0.85, 0x35464e);
  box(47, 0.25, 0.18, 0, 9.2, 13, steel);
  if (detailed) {
    for (let x = -22.5; x <= 22.5; x += 1.5)
      beam([x, 8.5, -0.85], [x, 9.4, 13], 0.035, 0.04, 0x8d9a9c);
    for (const z of [2.5, 6, 9.5])
      box(46, 0.13, 0.12, 0, 8.35 + (z + 0.8) * 0.065, z, steel);
    // Rear cross-bracing and continuous safety rails enclose the concourse.
    for (const x of [-16.5, 16.5]) {
      beam([x - 5, 2, 12.1], [x + 5, 8.9, 12.1], 0.09, 0.09, steel);
      beam([x + 5, 2, 12.1], [x - 5, 8.9, 12.1], 0.09, 0.09, steel);
    }
    for (let x = -22; x <= 22; x += 2.75)
      box(0.06, 1.1, 0.06, x, 6.5, 12.3, rail);
    for (const y of [6.5, 7.05]) box(44, 0.06, 0.06, 0, y, 12.3, rail);
    for (const x of [-22, 22]) {
      for (let row = 0; row < 8; row++) {
        box(0.06, 1.1, 0.06, x, 1.95 + row * 0.65, row * 1.4 + 0.2, rail);
      }
      for (const height of [2, 2.5])
        beam([x, height, 0.2], [x, height + 4.55, 10], 0.06, 0.06, rail);
    }
    for (const x of blocks) {
      for (const offset of [-4.5, -1.5, 1.5, 4.5])
        box(0.06, 1.1, 0.06, x + offset, 1.95, -0.12, rail);
      for (const y of [1.95, 2.5]) box(9.4, 0.06, 0.06, x, y, -0.12, rail);
    }
    for (const x of [-11, 0, 11]) {
      for (let row = 0; row < 7; row++)
        box(0.05, 1, 0.05, x, 2.06 + row * 0.65, row * 1.4 + 0.35, rail);
      beam([x, 2.56, 0.35], [x, 6.46, 8.75], 0.055, 0.055, rail);
    }
  }
  return mergeColoured(parts);
}

function buildGrandstands(root, samples, tangents, halfWidth, groundBase) {
  const stands = [],
    up = new THREE.Vector3(0, 1, 0);
  const structureMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    envMapIntensity: 0.7,
  });
  const nearMaterial = billboardMaterial(crowdTexture(true), true);
  const farMaterial = billboardMaterial(crowdTexture(false), false);
  // Keep the procedural crowd while loading, and if the local image fails.
  root.userData.spectatorTextureReady = false;
  const spectatorTexture = new THREE.TextureLoader().load(
    '/assets/spectator-atlas.png',
    (texture) => {
      const nearFallback = nearMaterial.map, farFallback = farMaterial.map;
      nearMaterial.map = texture;
      farMaterial.map = crowdTexture(false, texture.image);
      nearMaterial.needsUpdate = farMaterial.needsUpdate = true;
      nearFallback.dispose();
      farFallback.dispose();
      root.userData.spectatorTextureReady = true;
    },
    undefined,
    (error) => {
      root.userData.spectatorTextureError = true;
      console.warn('Spectator texture failed to load; using procedural crowd.', error);
    },
  );
  spectatorTexture.name = 'photographic-spectators-4x4';
  spectatorTexture.colorSpace = THREE.SRGBColorSpace;
  spectatorTexture.anisotropy = 4;
  // An emissive fascia: only the lettering/stripe exceed the HDR bloom
  // threshold, leaving the dark board and concrete structure unlit.
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 1024;
  signCanvas.height = 64;
  const signContext = signCanvas.getContext('2d');
  signContext.fillStyle = '#0b1219';
  signContext.fillRect(0, 0, 1024, 64);
  signContext.fillStyle = '#e1eff5';
  signContext.font = 'bold 40px sans-serif';
  signContext.textAlign = 'center';
  signContext.fillText('Mahinda mahattayata jayawewa!', 512, 46);
  signContext.fillStyle = '#64c9e8';
  signContext.fillRect(20, 57, 984, 3);
  const signTexture = new THREE.CanvasTexture(signCanvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  const signMaterial = new THREE.MeshStandardMaterial({
    map: signTexture,
    emissiveMap: signTexture,
    emissive: 0xffffff,
    emissiveIntensity: 1.6,
    roughness: 0.8,
  });
  const signGeometry = new THREE.PlaneGeometry(32, 0.75);
  for (const fraction of [0.025, 0.29, 0.54, 0.81]) {
    const index = Math.floor(samples.length * fraction),
      c = samples[index],
      t = tangents[index];
    const outward = new THREE.Vector3(t.z, 0, -t.x);
    if (outward.x * c.x + outward.z * c.z < 0) outward.negate();
    const right = new THREE.Vector3(outward.z, 0, -outward.x);
    const position = c.clone().addScaledVector(outward, halfWidth + 14);
    // Check the whole footprint against ALL road segments, not just this bend.
    let clear = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      clear = true;
      for (const x of [-24, 0, 24])
        for (const z of [-1, 6, 14]) {
          const p = position
            .clone()
            .addScaledVector(right, x)
            .addScaledVector(outward, z);
          if (nearestRoad(p.x, p.z, samples).distance < halfWidth + 7)
            clear = false;
        }
      if (clear) break;
      position.addScaledVector(outward, 4);
    }
    if (!clear) continue;
    const lod = new THREE.LOD();
    lod.name = 'grandstand-' + stands.length;
    lod.position.copy(position);
    lod.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, up, outward),
    );
    lod.userData.right = right;
    lod.userData.outward = outward;
    for (let level = 0; level < 3; level++) {
      const group = new THREE.Group();
      const structure = new THREE.Mesh(
        standGeometry(level === 0, groundBase, c.y),
        structureMaterial,
      );
      structure.receiveShadow = true;
      group.add(structure);
      const sign = new THREE.Mesh(signGeometry, signMaterial);
      sign.name = 'grandstand-sponsor-board';
      sign.rotation.y = Math.PI;
      sign.position.set(0, 8.12, -0.96);
      group.add(sign);
      if (level < 2)
        group.add(
          crowdMesh(level === 0 ? nearMaterial : farMaterial, level === 1, 90 + stands.length * 137),
        );
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
    const positions = [],
      colours = [],
      indices = [];
    const segments = 256,
      radius = layer === 0 ? 1080 : 730;
    const foot = new THREE.Color(layer === 0 ? 0xbda99c : 0xa19a93);
    const peak = new THREE.Color(layer === 0 ? 0x9e969a : 0x7c8588);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const profile =
        0.5 +
        0.22 * Math.sin(a * 5 + layer * 2) +
        0.14 * Math.cos(a * 11 + layer) +
        0.08 * Math.sin(a * 23) +
        0.04 * Math.cos(a * 47);
      const height =
        (layer === 0 ? 145 : 65) + profile * (layer === 0 ? 210 : 145);
      for (let row = 0; row < 3; row++) {
        const f = row / 2;
        positions.push(
          Math.cos(a) * radius,
          THREE.MathUtils.lerp(groundBase - 30, height, f),
          Math.sin(a) * radius,
        );
        const shade = foot.clone().lerp(peak, f);
        colours.push(shade.r, shade.g, shade.b);
      }
      if (i < segments)
        for (let row = 0; row < 2; row++) {
          const n = i * 3 + row;
          indices.push(n, n + 3, n + 1, n + 1, n + 3, n + 4);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(colours, 3),
    );
    geometry.setIndex(indices);
    const mountains = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    mountains.name = 'mountain-ridge-' + layer;
    root.add(mountains);
  }
}
