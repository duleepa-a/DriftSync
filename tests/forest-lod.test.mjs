import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'public/js/forest-lod.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`)
  .replace("from 'three/addons/loaders/GLTFLoader.js'", `from '${pathToFileURL(resolve(root, 'node_modules/three/examples/jsm/loaders/GLTFLoader.js'))}'`);
const { prepareForestDetails, FOREST_DETAIL } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('near trees stay within budget and reset correctly for different player cameras', async () => {
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'test-textures', loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  const bytes = readFileSync(resolve(root, 'public/assets/pine-tree-optimized.glb'));
  const { scene } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const geometry = new THREE.PlaneGeometry(10, 16);
  geometry.setAttribute('treeNear', new THREE.InstancedBufferAttribute(new Float32Array(20), 1));
  const forest = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), 20);
  forest.userData.nearCandidates = Array.from({ length: 20 }, (_, i) => i);
  for (let i = 0; i < 20; i++) {
    forest.setMatrixAt(i, new THREE.Matrix4().makeTranslation((i % 10 - 4.5) * 3, 0, -35 - Math.floor(i / 10) * 10));
    forest.setColorAt(i, new THREE.Color(0xffffff));
  }
  const controller = prepareForestDetails(scene, forest, new THREE.Group());
  assert.equal(controller.meshes.length, 2);
  assert.ok(controller.meshes.reduce((sum, mesh) => sum + mesh.geometry.index.count / 3, 0) < 6000);
  assert.ok(controller.meshes.every(mesh => !mesh.castShadow && !mesh.material.transparent && mesh.material.depthWrite));
  const a = new THREE.PerspectiveCamera(65, 1.5, 0.1, 500);
  a.position.set(0, 3, 0); a.lookAt(0, 3, -40);
  controller.update(a);
  assert.equal(controller.selected.length, FOREST_DETAIL.maxTrees);
  assert.ok(controller.meshes.every(mesh => mesh.count === FOREST_DETAIL.maxTrees));
  const cardFades = geometry.getAttribute('treeNear').array;
  assert.equal([...cardFades].filter(value => value === 1).length, FOREST_DETAIL.maxTrees);
  const selected = controller.selected.map(tree => tree.index);

  const b = a.clone(); b.position.set(500, 3, 0); b.lookAt(600, 3, 0);
  controller.update(b);
  assert.equal(controller.selected.length, 0);
  assert.ok(controller.meshes.every(mesh => mesh.count === 0 && !mesh.visible));
  assert.ok([...cardFades].every(value => value === 0), 'far viewport must restore every billboard');
  controller.update(a);
  assert.deepEqual(controller.selected.map(tree => tree.index), selected);

  a.position.z = 40; a.lookAt(0, 3, -40);
  controller.update(a);
  assert.ok(controller.selected.length > 0);
  assert.ok(controller.selected.every(tree => cardFades[tree.index] > 0 && cardFades[tree.index] < 1), 'fade between model and billboard');
  controller.enabled = false;
  controller.update(a);
  assert.ok([...cardFades].every(value => value === 0));
});
