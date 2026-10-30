import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'public/js/car-effects.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`);
const { attachCarEffects, updateCarEffects, disposeCarEffects } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
function player(fallback = false) {
  const mesh = new THREE.Group();
  mesh.userData.isFallback = fallback;
  mesh.userData.brakeMaterials = [new THREE.MeshStandardMaterial({ emissive: 0xff0000 })];
  attachCarEffects(mesh);
  return { mesh, speed: 46, input: { brake: 0 }, nitroTime: 0, nitroVisual: 0 };
}

test('nitro flames and camera envelope start, animate, and stop independently per car', () => {
  const a = player(), b = player(true);
  a.nitroTime = 2;
  updateCarEffects(a, 1 / 60); updateCarEffects(b, 1 / 60);
  assert.equal(a.mesh.userData.effects.flames.visible, true);
  assert.equal(b.mesh.userData.effects.flames.visible, false);
  assert.ok(a.nitroVisual > 0 && a.nitroVisual < 0.2);
  assert.equal(b.nitroVisual, 0);
  const length = a.mesh.userData.effects.flames.children[0].scale.z;
  updateCarEffects(a, 1 / 60);
  assert.notEqual(a.mesh.userData.effects.flames.children[0].scale.z, length);
  a.nitroTime = 0;
  const before = a.nitroVisual;
  updateCarEffects(a, 1 / 60);
  assert.equal(a.mesh.userData.effects.flames.visible, false);
  assert.ok(a.nitroVisual > 0 && a.nitroVisual < before, 'camera should ease back');
  for (let i = 0; i < 120; i++) updateCarEffects(a, 1 / 60);
  assert.ok(a.nitroVisual < 1e-6);
  disposeCarEffects(a.mesh); disposeCarEffects(b.mesh);
});

test('red brake lights and white reverse lights follow driving state on both car models', () => {
  for (const fallback of [false, true]) {
    const p = player(fallback), effects = p.mesh.userData.effects;
    const red = p.mesh.userData.brakeMaterials[0];
    p.input.brake = 1; p.nitroTime = 2;
    updateCarEffects(p, 1 / 60);
    assert.equal(red.emissiveIntensity, 1.4);
    assert.equal(effects.reverseMaterial.emissiveIntensity, 0);
    assert.equal(effects.flames.visible, false);
    p.speed = -2;
    updateCarEffects(p, 1 / 60);
    assert.equal(effects.reverseMaterial.emissiveIntensity, 3);
    assert.equal(effects.reverseMaterial.emissive.getHex(), 0xffffff);
    assert.equal(red.emissiveIntensity, 0.12);
    p.speed = 0; p.input.brake = 0;
    updateCarEffects(p, 1 / 60);
    assert.equal(effects.reverseMaterial.emissiveIntensity, 0);
    assert.equal(red.emissiveIntensity, 0.12);
    disposeCarEffects(p.mesh);
  }
});

test('removing effects disposes each owned resource once without touching the car body', () => {
  const p = player(), effects = p.mesh.userData.effects;
  const resources = new Set();
  effects.root.traverse(o => { if (o.geometry) resources.add(o.geometry); if (o.material) resources.add(o.material); });
  let disposed = 0;
  for (const resource of resources) resource.addEventListener('dispose', () => disposed++);
  let bodyDisposed = false;
  p.mesh.userData.brakeMaterials[0].addEventListener('dispose', () => { bodyDisposed = true; });
  disposeCarEffects(p.mesh); disposeCarEffects(p.mesh);
  assert.equal(disposed, resources.size);
  assert.equal(bodyDisposed, false);
  assert.equal(p.mesh.getObjectByName('car-effects'), undefined);
});
