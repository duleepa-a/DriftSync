import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(
  resolve(root, 'public/js/mclaren-model.js'),
  'utf8',
).replace(
  "from 'three'",
  `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`,
);
const { MCLAREN_ASSET, prepareMclaren } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);
const motionSource = readFileSync(resolve(root, 'public/js/motion.js'), 'utf8');
const { resetMotion, savePreviousPose, renderCar } = await import(
  `data:text/javascript,${encodeURIComponent(motionSource)}`
);

test('McLaren batches preserve geometry and materials without triggering scene transmission passes', async () => {
  const loader = new GLTFLoader();
  loader.register(() => ({
    name: 'test-textures',
    loadTexture: () => Promise.resolve(new THREE.Texture()),
  }));
  const bytes = readFileSync(resolve(root, 'public' + MCLAREN_ASSET));
  const { scene } = await loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
  const trianglesByMaterial = (object) => {
    const counts = new Map();
    object.traverse((mesh) => {
      if (!mesh.isMesh) return;
      const triangles =
        (mesh.geometry.index?.count ??
          mesh.geometry.attributes.position.count) / 3;
      counts.set(
        mesh.material.name,
        (counts.get(mesh.material.name) || 0) + triangles,
      );
    });
    return counts;
  };
  const originalCounts = trianglesByMaterial(scene);
  const originalBounds = new THREE.Box3().setFromObject(scene);
  const originalSize = originalBounds.getSize(new THREE.Vector3());
  const center = originalBounds.getCenter(new THREE.Vector3());
  const scale = 4.8 / Math.max(originalSize.x, originalSize.z);
  const expectedBounds = new THREE.Box3()
    .setFromObject(scene, true)
    .applyMatrix4(
      new THREE.Matrix4()
        .makeScale(scale, scale, scale)
        .multiply(
          new THREE.Matrix4().makeTranslation(
            -center.x,
            -originalBounds.min.y,
            -center.z,
          ),
        ),
    );
  const car = prepareMclaren(scene);
  assert.deepEqual(
    trianglesByMaterial(car),
    originalCounts,
    'batching must retain every triangle under its material',
  );
  let meshes = 0;
  car.traverse(object => { if (object.isMesh) meshes++; });
  assert.ok(meshes <= 30, 'body and movable wheels must stay batched');
  for (const [name, front, left] of [
    ['wheel_fl', true, true],
    ['wheel_fr', true, false],
    ['wheel_rl', false, true],
    ['wheel_rr', false, false],
  ]) {
    const wheel = car.getObjectByName(name);
    assert.ok(wheel?.isGroup, name + ' contact point must exist');
    assert.equal(wheel.position.z > 0, front);
    assert.equal(wheel.position.x < 0, left);
    assert.ok(wheel.position.y > 0.2 && wheel.position.y < 0.5);
    assert.ok(wheel.userData.radius > 0.25 && wheel.userData.radius < 0.5);
    assert.ok(wheel.getObjectByName('wheel-spin').getObjectByName('tire-and-rim')?.isMesh);
    assert.ok(wheel.getObjectByName('brake-caliper')?.isMesh);
  }
  const bounds = new THREE.Box3().setFromObject(car);
  assert.ok(
    bounds.min.distanceTo(expectedBounds.min) < 0.00001,
    'preserve the original placement',
  );
  assert.ok(
    bounds.max.distanceTo(expectedBounds.max) < 0.00001,
    'preserve the original size',
  );
  const glass = car.children.filter(
    (mesh) => mesh.isMesh && /Window|LightEmissive/.test(mesh.material.name),
  );
  assert.equal(glass.length, 3);
  for (const mesh of car.children.filter((child) => child.isMesh))
    assert.equal(mesh.material.transmission, 0);
  for (const mesh of glass) {
    assert.equal(mesh.material.transparent, true);
    assert.ok(
      mesh.material.opacity > 0 && mesh.material.opacity < 1,
      'keep the authored tint/transparency',
    );
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.material.forceSinglePass, true);
    assert.ok(
      mesh.material.isMeshPhysicalMaterial,
      'retain environment reflections',
    );
  }
  let originalTransmission = 0;
  scene.traverse((mesh) => {
    if (mesh.isMesh && mesh.material.transmission > 0) originalTransmission++;
  });
  assert.equal(
    originalTransmission,
    3,
    'preparation must not mutate the loaded source materials',
  );

  const clone = car.clone(true);
  const wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map(name => {
    const wheel = clone.getObjectByName(name);
    wheel.userData.spin = wheel.getObjectByName('wheel-spin');
    return wheel;
  });
  clone.userData.wheels = wheels;
  const p = { mesh: clone, pos: new THREE.Vector3(), groundY: 0,
    heading: 0, pitch: 0, roll: 0, steerSmooth: 0, wheelSpin: 0 };
  resetMotion(p);
  renderCar(p, 1);
  const points = wheels.map(wheel => {
    const tire = wheel.getObjectByName('tire-and-rim');
    const positions = tire.geometry.attributes.position;
    let index = 0, radius = 0;
    for (let i = 0; i < positions.count; i++) {
      const distance = Math.hypot(positions.getY(i), positions.getZ(i));
      if (distance > radius) { radius = distance; index = i; }
    }
    const local = new THREE.Vector3().fromBufferAttribute(positions, index);
    return { tire, local, before: tire.localToWorld(local.clone()),
      center: wheel.getWorldPosition(new THREE.Vector3()),
      caliper: wheel.getObjectByName('brake-caliper').getWorldQuaternion(new THREE.Quaternion()) };
  });
  p.wheelSpin = 1.1;
  renderCar(p, 1);
  wheels.forEach((wheel, i) => {
    const point = points[i];
    assert.ok(point.tire.localToWorld(point.local.clone()).distanceTo(point.before) > 0.2, 'visible tire/rim vertices must roll');
    assert.ok(wheel.getWorldPosition(new THREE.Vector3()).distanceTo(point.center) < 1e-9, 'wheel rolls around its hub');
    assert.ok(wheel.getObjectByName('brake-caliper').getWorldQuaternion(new THREE.Quaternion()).angleTo(point.caliper) < 1e-9, 'brake caliper must not spin');
    assert.equal(car.getObjectByName(wheel.name).getObjectByName('wheel-spin').rotation.x, 0, 'another player/template must remain unchanged');
  });
  for (const steer of [-1, 1, 0]) {
    p.steerSmooth = steer;
    renderCar(p, 1);
    wheels.forEach((wheel, i) => {
      const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(
        wheel.getWorldQuaternion(new THREE.Quaternion()),
      );
      assert.ok(Math.abs(axle.z - (i < 2 ? -Math.sin(steer * 0.4) : 0)) < 1e-9,
        'only the front wheel axles must steer, including counter-steer');
      assert.ok(wheel.getWorldPosition(new THREE.Vector3()).distanceTo(points[i].center) < 1e-9);
    });
  }

  // Exercise the actual tire geometry, including rim details, over slopes
  // and a crest while steering, rolling and leaning into a corner.
  clone.rotation.order = 'YXZ';
  const profiles = [
    { height: (x, z) => 0, dx: () => 0, dz: () => 0 },
    { height: (x, z) => 3 + x * 0.08 + z * 0.15, dx: () => 0.08, dz: () => 0.15 },
    { height: (x, z) => 3 + x * 0.03 + z * 0.12 - z * z * 0.005,
      dx: () => 0.03, dz: (x, z) => 0.12 - z * 0.01 },
  ];
  for (const profile of profiles) {
    const track = { surfaceInfo({ x, z }) {
      const nx = -profile.dx(x, z), nz = -profile.dz(x, z);
      const length = Math.hypot(nx, 1, nz);
      return { groundY: profile.height(x, z), normalX: nx / length,
        normalY: 1 / length, normalZ: nz / length };
    } };
    for (const heading of [0, 1.1, 2.8]) {
      for (const spin of [0.6, 2.4]) {
        p.heading = heading; p.wheelSpin = spin; p.steerSmooth = 0.8;
        p.roll = -0.06; p.groundY = -2;
        resetMotion(p);
        renderCar(p, 0.5, track);
        clone.updateMatrixWorld(true);
        for (const wheel of wheels) {
          const tire = wheel.getObjectByName('tire-and-rim');
          const vertices = tire.geometry.attributes.position;
          let clearance = Infinity;
          const vertex = new THREE.Vector3();
          for (let i = 0; i < vertices.count; i++) {
            vertex.fromBufferAttribute(vertices, i).applyMatrix4(tire.matrixWorld);
            clearance = Math.min(clearance, vertex.y - profile.height(vertex.x, vertex.z));
          }
          assert.ok(clearance >= 0, 'rolling/steering tire must not penetrate the road: ' + clearance);
          assert.ok(clearance < 0.07, 'tire must stay planted rather than floating: ' + clearance);
        }
        assert.equal(p.pos.y, 0, 'render grounding must not change simulation coordinates');
      }
    }
  }

  const rollingHeight = z => z * 0.06 + Math.sin(z * 0.3) * 0.4;
  const rollingTrack = { surfaceInfo({ z }) {
    const slope = 0.06 + Math.cos(z * 0.3) * 0.12, length = Math.hypot(1, slope);
    return { groundY: rollingHeight(z), normalX: 0, normalY: 1 / length, normalZ: -slope / length };
  } };
  p.pos.set(0, 0, -4); p.heading = 0; p.groundY = rollingHeight(-4);
  resetMotion(p);
  for (let frame = 0; frame < 60; frame++) {
    savePreviousPose(p);
    p.pos.z += 46 / 60;
    p.groundY = rollingHeight(p.pos.z);
    p.wheelSpin += 1.7;
    renderCar(p, 0.5, rollingTrack, 1 / 60);
    clone.updateMatrixWorld(true);
    for (const wheel of wheels) {
      const tire = wheel.getObjectByName('tire-and-rim');
      const vertices = tire.geometry.attributes.position;
      const vertex = new THREE.Vector3();
      for (let i = 0; i < vertices.count; i += 40) {
        vertex.fromBufferAttribute(vertices, i).applyMatrix4(tire.matrixWorld);
        assert.ok(vertex.y >= rollingHeight(vertex.z),
          'smoothing the chassis must not let the moving tires sink');
      }
    }
  }
});
