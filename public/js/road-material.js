import * as THREE from 'three';

const smooth = (a, b, value) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
function hash(x, y) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function tileNoise(u, v, cells) {
  const x = u * cells, y = v * cells;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(0, 1, x - ix), fy = smooth(0, 1, y - iy);
  const a = hash(ix % cells, iy % cells), b = hash((ix + 1) % cells, iy % cells);
  const c = hash(ix % cells, (iy + 1) % cells), d = hash((ix + 1) % cells, (iy + 1) % cells);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
function texture(data, width, height, name, colorSpace = THREE.NoColorSpace) {
  const map = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  map.name = name;
  map.colorSpace = colorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.needsUpdate = true;
  return map;
}

// Generated locally so all three PBR maps are available offline. Albedo and
// tangent-space normals share a seamless aggregate pattern at a 2 m scale.
export function createRoadMaterial(roadWidth, trackLength) {
  const size = 512;
  const height = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 4);
  const normals = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, index = y * size + x;
      const aggregate = tileNoise(u, v, 128) * 0.55 + tileNoise(u, v, 256) * 0.3 + tileNoise(u, v, 32) * 0.15;
      height[index] = aggregate;
      const variation = tileNoise(u, v, 8) - 0.5;
      const shade = 45 + aggregate * 42 + variation * 10;
      albedo[index * 4] = Math.round(shade * 1.02);
      albedo[index * 4 + 1] = Math.round(shade);
      albedo[index * 4 + 2] = Math.round(shade * 0.98);
      albedo[index * 4 + 3] = 255;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Central differences wrap at tile edges, keeping the bump field seamless.
      const dx = height[y * size + (x + 1) % size] - height[y * size + (x + size - 1) % size];
      const dy = height[((y + 1) % size) * size + x] - height[((y + size - 1) % size) * size + x];
      const nx = -dx * 2.4, ny = -dy * 2.4, length = Math.hypot(nx, ny, 1);
      const at = (y * size + x) * 4;
      normals[at] = Math.round((nx / length * 0.5 + 0.5) * 255);
      normals[at + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
      normals[at + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
      normals[at + 3] = 255;
    }
  }

  // This map spans the ENTIRE road width, unlike the repeating detail maps.
  // Keep dry asphalt rough even on the racing line. A soft wear profile avoids
  // the bright, uniform reflection stripe produced by a glossy centre plateau.
  const roughHeight = 128;
  const roughness = new Uint8Array(size * roughHeight * 4);
  for (let y = 0; y < roughHeight; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1), v = y / roughHeight;
      const polish = Math.exp(-Math.pow((u - 0.5) / 0.13, 2));
      const grain = (tileNoise(u, v, 32) - 0.5) * 0.025;
      const value = Math.round((0.94 - polish * 0.16 + grain) * 255);
      const at = (y * size + x) * 4;
      roughness[at] = roughness[at + 1] = roughness[at + 2] = value;
      roughness[at + 3] = 255;
    }
  }
  const map = texture(albedo, size, size, 'asphalt-albedo', THREE.SRGBColorSpace);
  const normalMap = texture(normals, size, size, 'asphalt-normal');
  const roughnessMap = texture(roughness, size, roughHeight, 'asphalt-racing-line-roughness');
  const lengthRepeats = Math.max(1, Math.round(trackLength / 2));
  map.repeat.set(roadWidth / 2, lengthRepeats);
  normalMap.repeat.copy(map.repeat);
  roughnessMap.wrapS = THREE.ClampToEdgeWrapping;
  roughnessMap.repeat.set(1, Math.max(1, Math.round(trackLength / 32)));

  return new THREE.MeshStandardMaterial({
    name: 'PBR asphalt',
    map,
    normalMap,
    normalMapType: THREE.TangentSpaceNormalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
    roughnessMap,
    roughness: 1, // Dry asphalt: ~0.78 centre to ~0.94 shoulders.
    metalness: 0,
    envMapIntensity: 0.8,
  });
}
