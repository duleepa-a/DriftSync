import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'public/js/nissan-model.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`);
const { NISSAN_ASSET, prepareNissan } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('supplied Nissan is grounded, faces forward, and has stable independent wheel axles', async () => {
  const loader = new GLTFLoader();
  // Geometry tests use placeholder textures; Chrome checks the embedded images.
  loader.register(() => ({ name: 'test-textures', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  const bytes = readFileSync(resolve(root, 'public' + NISSAN_ASSET));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const car = prepareNissan(gltf.scene);
  const bounds = new THREE.Box3().setFromObject(car);
  assert.ok(Math.abs(bounds.min.y) < 0.001);
  assert.ok(Math.abs(bounds.max.z - bounds.min.z - 4.8) < 0.001);
  for (const name of ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr']) {
    const wheel = car.getObjectByName(name), spin = wheel.getObjectByName('wheel-spin');
    assert.ok(name.startsWith('wheel_f') ? wheel.position.z > 1 : wheel.position.z < -1);
    assert.ok(name.endsWith('l') ? wheel.position.x < 0 : wheel.position.x > 0);
    assert.equal(spin.children.length, 2, 'tire and rim must rotate together');
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion()));
    const center = spin.getWorldPosition(new THREE.Vector3());
    for (const angle of [0.5, 2, Math.PI]) {
      spin.rotation.x = angle;
      car.updateMatrixWorld(true);
      assert.ok(spin.getWorldPosition(new THREE.Vector3()).distanceTo(center) < 1e-9);
      const nextAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion()));
      assert.ok(nextAxis.distanceTo(axis) < 1e-9, 'cambered axle must not wobble as the tire spins');
    }
  }
});
