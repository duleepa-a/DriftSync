import * as THREE from 'three';

const smooth = (a, b, value) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

function hash(x, y) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(0, 1, x - ix), fy = smooth(0, 1, y - iy);
  return mix(mix(hash(ix, iy), hash(ix + 1, iy), fx), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), fx), fy);
}
function cloudNoise(x, y) {
  let value = 0, amplitude = 0.5;
  for (let octave = 0; octave < 5; octave++) {
    value += noise(x, y) * amplitude;
    x = x * 2.03 + 13.1; y = y * 2.03 - 7.7;
    amplitude *= 0.5;
  }
  return value / 0.96875;
}

export function createSunsetSky() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048; canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  const sun = new THREE.Vector3(0.80728, 0.05826, 0.58728).normalize();
  const cos = [], sin = [];
  for (let x = 0; x < canvas.width; x++) {
    const azimuth = (x / canvas.width - 0.5) * Math.PI * 2;
    cos.push(Math.cos(azimuth)); sin.push(Math.sin(azimuth));
  }
  for (let y = 0; y < canvas.height; y++) {
    const elevation = (0.5 - y / canvas.height) * Math.PI;
    const dy = Math.sin(elevation), horizontal = Math.cos(elevation);
    const height = smooth(0, 0.85, Math.max(0, dy));
    const horizon = [232, 171, 116], zenith = [56, 73, 103];
    for (let x = 0; x < canvas.width; x++) {
      const dx = cos[x] * horizontal, dz = sin[x] * horizontal;
      const at = (y * canvas.width + x) * 4;
      if (dy < 0) {
        for (let c = 0; c < 3; c++) pixels.data[at + c] = mix([117, 100, 81][c], [59, 64, 55][c], -dy);
      } else {
        // Project onto a high cloud layer: it compresses toward the horizon,
        // stays continuous around the panorama seam, and has no circular puffs.
        const u = dx / (dy + 0.12) * 2.6, v = dz / (dy + 0.12) * 3.4;
        const broad = cloudNoise(u, v);
        const detail = cloudNoise(u * 3.2 + 41, v * 3.2 - 17);
        const density = smooth(0.46, 0.68, broad * 0.85 + detail * 0.15);
        const fade = smooth(0.02, 0.12, dy) * (1 - smooth(0.8, 1, dy));
        const opacity = density * fade * 0.85;
        const dot = Math.max(-1, Math.min(1, dx * sun.x + dy * sun.y + dz * sun.z));
        const glow = Math.exp((dot - 1) * 75);
        const disk = smooth(Math.cos(0.009), Math.cos(0.005), dot);
        const light = Math.min(1, (1 - density) * 0.65 + glow * 0.35);
        for (let c = 0; c < 3; c++) {
          let color = mix(horizon[c], zenith[c], height);
          color = mix(color, [255, 216, 157][c], glow * 0.65);
          const cloud = mix([143, 132, 146][c], [246, 211, 184][c], light);
          color = mix(color, cloud, opacity);
          pixels.data[at + c] = mix(color, [255, 241, 205][c], disk * (1 - opacity));
        }
      }
      pixels.data[at + 3] = 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'sunset-cloud-sky';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
