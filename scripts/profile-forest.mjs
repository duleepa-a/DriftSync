// Full-scene comparison using identical cars, cameras, lighting and post effects.
import * as THREE from 'three';
import { G, scene, renderer, addPlayer, spawnCars, layoutHud, renderSplit } from '/js/host.js';

const report = { backend: 'Chrome SwiftShader; software render timings are not hardware FPS', profiles: [] };
try {
  const forest = scene.getObjectByName('instanced-pine-forest');
  const scenery = scene.getObjectByName('track-scenery');
  const deadline = performance.now() + 30000;
  while ((!G.assetsReady || !G.environmentReady || !forest.userData.textureReady || !scenery.userData.forestDetailsReady) && performance.now() < deadline) await new Promise(r => setTimeout(r, 50));
  if (!scenery.userData.forestDetailsReady || !G.assetsReady || !G.environmentReady || !forest.userData.textureReady) throw new Error('Assets did not load');
  const originalAtlas = await new THREE.TextureLoader().loadAsync('/assets/pine-tree-atlas.png');
  originalAtlas.colorSpace = THREE.SRGBColorSpace;
  originalAtlas.anisotropy = 4;
  const compressedAtlas = forest.material.map;
  const details = scenery.userData.forestDetails;
  document.getElementById('lobby').classList.add('hidden');
  renderer.info.autoReset = false;
  const gl = renderer.getContext(), pixel = new Uint8Array(4);
  function draw() {
    renderer.info.reset(); renderSplit();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (gl.getError()) throw new Error('WebGL error');
  }
  for (const count of [1, 4]) {
    for (let slot = G.players.size; slot < count; slot++) addPlayer({ id: 'profile-' + slot, slot, name: 'Profile ' + (slot + 1), color: ['#000000', '#8F0707', '#003366', '#DE6B13'][slot] });
    spawnCars(); layoutHud();
    // Exercise the densest nearby forest view, rather than only the grid.
    const players = [...G.players.values()];
    const camera = players[0].camera, target = new THREE.Vector3();
    // One and four-player layouts both retain the canvas aspect ratio.
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    let sampleIndex = 0, largest = -1;
    details.enabled = true;
    for (let i = 0; i < G.track.samples.length; i += 8) {
      const point = G.track.samples[i], tangent = G.track.tangents[i];
      camera.position.copy(point).addScaledVector(tangent, -5.6); camera.position.y += 2.5;
      target.copy(point).addScaledVector(tangent, 11); target.y += 1;
      camera.lookAt(target); details.update(camera);
      if (details.selected.length > largest) { largest = details.selected.length; sampleIndex = i; }
    }
    const point = G.track.samples[sampleIndex], tangent = G.track.tangents[sampleIndex];
    players.forEach((player, index) => {
      player.mesh.position.copy(point).addScaledVector(tangent, -index * 8);
      player.mesh.rotation.set(0, Math.atan2(tangent.x, tangent.z), 0);
      player.camera.position.copy(player.mesh.position).addScaledVector(tangent, -5.6); player.camera.position.y += 2.5;
      target.copy(player.mesh.position).addScaledVector(tangent, 11); target.y += 1;
      player.camera.lookAt(target);
    });
    const results = [false, true].map(hybrid => ({ hybrid, samples: [] }));
    // Interleave both modes after warming their textures and shaders.
    for (let round = 0; round < 9; round++) {
      for (const entry of round % 2 ? [...results].reverse() : results) {
        details.enabled = entry.hybrid;
        forest.material.map = entry.hybrid ? compressedAtlas : originalAtlas;
        const start = performance.now(); draw();
        if (round >= 2) entry.samples.push(performance.now() - start);
        entry.drawCalls = renderer.info.render.calls;
        entry.triangles = renderer.info.render.triangles;
        entry.nearTreesInLastView = details.selected.length;
        await new Promise(requestAnimationFrame);
      }
    }
    for (const entry of results) {
      entry.samples.sort((a, b) => a - b);
      report.profiles.push({ players: count, trackSample: sampleIndex, maximumNearbyTrees: largest, mode: entry.hybrid ? 'compressed atlas + near 3D pines' : 'original cutout forest',
        medianRenderMs: Number(entry.samples[3].toFixed(2)), drawCalls: entry.drawCalls, triangles: entry.triangles,
        nearTreesInLastView: entry.nearTreesInLastView });
    }
    details.enabled = true; forest.material.map = compressedAtlas; draw();
    if (count === 1) report.sceneryScreenshot = renderer.domElement.toDataURL('image/png');
  }
  originalAtlas.dispose();
} catch (error) { report.error = error.stack; }
await fetch('/render-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
