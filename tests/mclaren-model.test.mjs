import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'public/js/mclaren-model.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`);
const { MCLAREN_ASSET, prepareMclaren } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('McLaren batches preserve geometry and materials without triggering scene transmission passes', async () => {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'test-textures', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  const bytes = readFileSync(resolve(root, 'public' + MCLAREN_ASSET));
  const { scene } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const trianglesByMaterial = object => {
    const counts = new Map();
    object.traverse(mesh => {
      if (!mesh.isMesh) return;
      const triangles = (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      counts.set(mesh.material.name, (counts.get(mesh.material.name) || 0) + triangles);
    });
    return counts;
  };
  const originalCounts = trianglesByMaterial(scene);
  const originalBounds = new THREE.Box3().setFromObject(scene);
  const originalSize = originalBounds.getSize(new THREE.Vector3());
  const center = originalBounds.getCenter(new THREE.Vector3());
  const scale = 4.8 / Math.max(originalSize.x, originalSize.z);
  const expectedBounds = new THREE.Box3().setFromObject(scene, true).applyMatrix4(
    new THREE.Matrix4().makeScale(scale, scale, scale)
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -originalBounds.min.y, -center.z)));
  const car = prepareMclaren(scene);
  assert.deepEqual(trianglesByMaterial(car), originalCounts, 'batching must retain every triangle under its material');
  assert.ok(car.children.filter(child => child.isMesh).length <= 24, 'thousands of source parts must stay batched');
  for (const [name, front, left] of [
    ['wheel_fl', true, true], ['wheel_fr', true, false],
    ['wheel_rl', false, true], ['wheel_rr', false, false],
  ]) {
    const wheel = car.getObjectByName(name);
    assert.ok(wheel?.isGroup, name + ' contact point must exist');
    assert.equal(wheel.position.z > 0, front);
    assert.equal(wheel.position.x < 0, left);
    assert.ok(wheel.position.y > 0.2 && wheel.position.y < 0.5);
  }
  const bounds = new THREE.Box3().setFromObject(car);
  assert.ok(bounds.min.distanceTo(expectedBounds.min) < 0.00001, 'preserve the original placement');
  assert.ok(bounds.max.distanceTo(expectedBounds.max) < 0.00001, 'preserve the original size');
  const glass = car.children.filter(mesh => mesh.isMesh && /Window|LightEmissive/.test(mesh.material.name));
  assert.equal(glass.length, 3);
  for (const mesh of car.children.filter(child => child.isMesh)) assert.equal(mesh.material.transmission, 0);
  for (const mesh of glass) {
    assert.equal(mesh.material.transparent, true);
    assert.ok(mesh.material.opacity > 0 && mesh.material.opacity < 1, 'keep the authored tint/transparency');
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.material.forceSinglePass, true);
    assert.ok(mesh.material.isMeshPhysicalMaterial, 'retain environment reflections');
  }
  let originalTransmission = 0;
  scene.traverse(mesh => { if (mesh.isMesh && mesh.material.transmission > 0) originalTransmission++; });
  assert.equal(originalTransmission, 3, 'preparation must not mutate the loaded source materials');
});
