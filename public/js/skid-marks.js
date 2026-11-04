import * as THREE from 'three';

// Connected tire-contact strips, batched into one bounded draw call.
export function createSkidMarks(track) {
  const capacity = 4096;
  const positions = new Float32Array(capacity * 12);
  const uvs = new Float32Array(capacity * 8);
  const colors = new Float32Array(capacity * 16).fill(1);
  const born = new Float64Array(capacity).fill(-Infinity);
  const density = new Float32Array(capacity * 4);
  const indices = [];
  for (let i = 0; i < capacity; i++) {
    const v = i * 4;
    indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    for (let j = 0; j < 4; j++) colors[i * 16 + j * 4 + 3] = 0;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(indices);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    map: makeRubberTexture(),
    color: 0x171513,
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  }));
  mesh.name = 'tire-marks';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  let cursor = 0, count = 0, time = 0;
  geometry.setDrawRange(0, 0);

  function edge(x, z, nx, nz) {
    return [-1, 1].map(side => {
      const point = new THREE.Vector3(x + nx * side * 0.16, 0, z + nz * side * 0.16);
      point.y = track.nearestInfo(point).groundY + 0.055;
      return point;
    });
  }

  function emit(player, wheel, x, z, dx, dz, strength) {
    player.skidContacts ||= [];
    let previous = player.skidContacts[wheel];
    if (previous && Math.hypot(x - previous.x, z - previous.z) > 3) previous = null;
    const startX = previous ? previous.x : x - dx;
    const startZ = previous ? previous.z : z - dz;
    const length = Math.hypot(x - startX, z - startZ);
    if (length < 0.25 || length > 3) return;
    const nx = (z - startZ) / length, nz = -(x - startX) / length;
    const start = previous?.edge || edge(startX, startZ, nx, nz);
    const end = edge(x, z, nx, nz);
    const distance = previous?.distance || 0;
    const endDensity = strength * Math.min(1, (distance + length) / 1.2);
    const startDensity = previous?.density ?? strength * 0.12;
    const vertices = [...start, ...end];
    for (let v = 0; v < 4; v++) {
      vertices[v].toArray(positions, cursor * 12 + v * 3);
      uvs[cursor * 8 + v * 2] = v % 2;
      uvs[cursor * 8 + v * 2 + 1] = (distance + (v < 2 ? 0 : length)) / 2;
      density[cursor * 4 + v] = v < 2 ? startDensity : endDensity;
      colors[cursor * 16 + v * 4 + 3] = density[cursor * 4 + v];
    }
    born[cursor] = time;
    player.skidContacts[wheel] = { x, z, edge: end, distance: distance + length, density: endDensity };
    cursor = (cursor + 1) % capacity;
    count = Math.min(capacity, count + 1);
    geometry.setDrawRange(0, count * 6);
    for (const name of ['position', 'uv', 'color']) geometry.attributes[name].needsUpdate = true;
  }

  function update(dt) {
    time += dt;
    let changed = false;
    for (let i = 0; i < count; i++) {
      const age = time - born[i];
      if (age < 25) continue;
      const fade = 1 - THREE.MathUtils.smoothstep(age, 25, 40);
      for (let v = 0; v < 4; v++) {
        const at = i * 16 + v * 4 + 3;
        const alpha = density[i * 4 + v] * fade;
        if (colors[at] !== alpha) { colors[at] = alpha; changed = true; }
      }
    }
    if (changed) geometry.attributes.color.needsUpdate = true;
  }

  function clear() {
    cursor = count = time = 0;
    geometry.setDrawRange(0, 0);
  }
  return { mesh, emit, update, clear };
}

function makeRubberTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(64, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 64; x++) {
      const u = x / 63, phase = y / 128 * Math.PI * 2;
      const ragged = Math.sin(phase * 3 + x * 1.7) * 0.018 + Math.sin(phase * 7 + x * 0.8) * 0.012;
      const edge = THREE.MathUtils.smoothstep(Math.min(u, 1 - u) + ragged, 0, 0.15);
      const grooves = 0.68 + 0.2 * Math.sin(u * 85 + Math.sin(phase) * 0.3);
      const grain = 0.65 + Math.random() * 0.35;
      const at = (y * 64 + x) * 4;
      pixels.data[at] = pixels.data[at + 1] = pixels.data[at + 2] = 255;
      pixels.data[at + 3] = Math.round(255 * edge * grooves * grain);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}
