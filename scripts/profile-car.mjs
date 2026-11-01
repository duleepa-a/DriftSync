// Served only by check-rendering.cjs --profile-car, never by the game.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { G, scene, renderer, addPlayer, spawnCars, layoutHud, renderSplit } from '/js/host.js';
import { MCLAREN_ASSET } from '/js/mclaren-model.js';

const report = { backend: 'Chrome SwiftShader (software rendering; timings are not hardware FPS)', profiles: [] };
try {
  const deadline = performance.now() + 30000;
  const forest = scene.getObjectByName('instanced-pine-forest');
  const scenery = scene.getObjectByName('track-scenery');
  while ((!G.assetsReady || !G.environmentReady || !forest.userData.textureReady || !scenery.userData.forestDetailsReady) && performance.now() < deadline) await new Promise(r => setTimeout(r, 50));
  if (!G.assetsReady || !G.environmentReady || !forest.userData.textureReady || !scenery.userData.forestDetailsReady) throw new Error('Assets did not load');
  addPlayer({ id: 'profile', slot: 0, name: 'Profile', color: '#ff4757' });
  spawnCars(); layoutHud();
  document.getElementById('lobby').classList.add('hidden');
  const player = G.players.get('profile');
  if (player.mesh.userData.modelId !== 'mclaren-2021') throw new Error('McLaren fallback is active');
  const optimized = player.mesh.children[0];
  const loader = new GLTFLoader();
  const draco = new DRACOLoader().setDecoderPath('/jsm/libs/draco/gltf/');
  loader.setDRACOLoader(draco);
  const authored = (await loader.loadAsync(MCLAREN_ASSET)).scene;
  const authoredMaterials = new Map();
  let authoredMeshes = 0;
  authored.traverse(o => { if (o.isMesh) { authoredMeshes++; authoredMaterials.set(o.material.name, o.material); } });
  const before = optimized.clone(true);
  before.traverse(o => {
    if (!o.isMesh) return;
    const original = authoredMaterials.get(o.material.name);
    if (!original) throw new Error('Missing authored material: ' + o.material.name);
    const material = original.clone();
    // Match the running game's paint and lamp settings, changing only glass.
    material.color.copy(o.material.color);
    material.emissive.copy(o.material.emissive);
    material.emissiveIntensity = o.material.emissiveIntensity;
    o.material = material;
  });
  const ferrari = (await loader.loadAsync('/assets/ferrari.glb')).scene;
  ferrari.rotation.y = Math.PI;
  ferrari.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    if (o.material.name === 'Body_Color') {
      o.material.color.set('#ff4757'); o.material.metalness = 0.6;
      o.material.roughness = 0.4; o.material.envMapIntensity = 0.9;
    } else if (o.material.name === 'Taillight_Glass') {
      o.material.emissive.set(0xff0000); o.material.emissiveIntensity = 0.12;
    }
  });
  draco.dispose();
  report.authoredMclarenMeshes = authoredMeshes;
  report.resolution = renderer.getDrawingBufferSize(new THREE.Vector2()).toArray();
  renderer.info.autoReset = false; // Include every composer and shadow pass.
  const gl = renderer.getContext();
  const pixel = new Uint8Array(4);
  function draw() {
    renderer.info.reset();
    renderSplit();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); // Wait for GPU completion.
  }
  for (const [name, model] of [['Ferrari (main settings)', ferrari], ['McLaren batched, original glass', before], ['McLaren optimized', optimized]]) {
    for (const candidate of [optimized, before, ferrari]) candidate.removeFromParent();
    player.mesh.add(model);
    let meshes = 0, triangles = 0, transmissiveMaterials = 0;
    model.traverse(o => {
      if (!o.isMesh) return;
      meshes++; triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      if (o.material.transmission > 0) transmissiveMaterials++;
    });
    for (let warmup = 0; warmup < 3; warmup++) { draw(); await new Promise(requestAnimationFrame); }
    const samples = [];
    for (let frame = 0; frame < 8; frame++) {
      const start = performance.now(); draw(); samples.push(performance.now() - start);
      await new Promise(requestAnimationFrame);
    }
    samples.sort((a, b) => a - b);
    report.profiles.push({ name, meshes, triangles, transmissiveMaterials,
      frameDrawCalls: renderer.info.render.calls, frameTriangles: renderer.info.render.triangles,
      medianRenderMs: Number(((samples[3] + samples[4]) / 2).toFixed(2)), samplesMs: samples.map(n => Number(n.toFixed(2))) });
    if (gl.getError()) throw new Error('WebGL error during ' + name);
  }
  const [, baseline, fixed] = report.profiles;
  if (fixed.transmissiveMaterials || fixed.frameDrawCalls >= baseline.frameDrawCalls) throw new Error('Optimization did not remove the extra rendering work');
  draw(); // Capture before the browser clears the default drawing buffer.
  report.sceneryScreenshot = renderer.domElement.toDataURL('image/png');
} catch (error) { report.error = error.stack; }
await fetch('/render-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
