import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const root = resolve(import.meta.dirname, '..');
const roadSource = readFileSync(
  resolve(root, 'public/js/road-material.js'),
  'utf8',
).replace(
  "from 'three'",
  `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`,
);
const roadUrl = `data:text/javascript,${encodeURIComponent(roadSource)}`;
const scenerySource = readFileSync(
  resolve(root, 'public/js/scenery.js'),
  'utf8',
).replace(
  "from 'three'",
  `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`,
);
const sceneryUrl = `data:text/javascript,${encodeURIComponent(scenerySource)}`;
const trackSource = readFileSync(resolve(root, 'public/js/track.js'), 'utf8')
  .replace(
    "from 'three'",
    `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`,
  )
  .replace("from './road-material.js'", `from ${JSON.stringify(roadUrl)}`)
  .replace("from './scenery.js'", `from ${JSON.stringify(sceneryUrl)}`);
const { buildTrack } = await import(
  `data:text/javascript,${encodeURIComponent(trackSource)}`
);
const nitroSource = readFileSync(resolve(root, 'public/js/nitro.js'), 'utf8');
const nitroUrl = `data:text/javascript,${encodeURIComponent(nitroSource)}`;
const { NITRO, createNitroPickups } = await import(nitroUrl);
const physicsSource = readFileSync(
  resolve(root, 'public/js/physics.js'),
  'utf8',
)
  .replace(
    "from 'three'",
    `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`,
  )
  .replace("from './nitro.js'", `from ${JSON.stringify(nitroUrl)}`);
const { updateCar, resetHandling } = await import(
  `data:text/javascript,${encodeURIComponent(physicsSource)}`
);
const motionSource = readFileSync(resolve(root, 'public/js/motion.js'), 'utf8');
const { resetMotion, savePreviousPose, renderCar } = await import(
  `data:text/javascript,${encodeURIComponent(motionSource)}`
);

function mockSceneryDocument() {
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
    // Image decoding is verified in Chrome; these tests inspect geometry.
    createElementNS: () => ({
      addEventListener() {},
      removeEventListener() {},
    }),
  };
}

test('forest and grandstands clear the road, and scenery LOD resets for each camera', () => {
  mockSceneryDocument();
  const scene = new THREE.Scene(),
    track = buildTrack(scene);
  const forest = scene.getObjectByName('instanced-pine-forest');
  assert.ok(forest.isInstancedMesh && forest.count >= 700);
  assert.equal(
    forest.geometry.groups.length,
    0,
    'all tree parts must use one draw call',
  );
  assert.ok(!Array.isArray(forest.material));
  assert.equal(
    forest.geometry.index.count / 3,
    2,
    'each tree uses just one billboard',
  );
  assert.ok(
    forest.material.alphaTest > 0 &&
      forest.material.depthWrite &&
      !forest.material.transparent,
  );
  const variants = forest.geometry.getAttribute('treeVariant');
  assert.equal(
    new Set(variants.array.slice(0, forest.count)).size,
    4,
    'use all four tree silhouettes',
  );
  const matrix = new THREE.Matrix4(),
    position = new THREE.Vector3();
  for (let i = 0; i < forest.count; i++) {
    forest.getMatrixAt(i, matrix);
    position.setFromMatrixPosition(matrix);
    const road = track.nearestInfo(position);
    assert.ok(
      road.dist >= track.halfWidth + 18,
      'trees must clear every road segment',
    );
    const blend = THREE.MathUtils.clamp(
      (road.dist - track.halfWidth - 16) / 64,
      0,
      1,
    );
    assert.ok(
      Math.abs(
        position.y - (THREE.MathUtils.lerp(road.groundY, -16, blend) - 0.15),
      ) < 0.001,
    );
  }
  scene.updateMatrixWorld(true);
  const stands = scene
    .getObjectByName('track-scenery')
    .children.filter((child) => child.isLOD);
  assert.equal(
    stands.length,
    4,
    'all four designated spectator areas must fit',
  );
  const camera = new THREE.PerspectiveCamera();
  for (const stand of stands) {
    for (const x of [-24, 0, 24])
      for (const z of [-1, 6, 14]) {
        const corner = new THREE.Vector3(x, 0, z).applyMatrix4(
          stand.matrixWorld,
        );
        assert.ok(
          track.nearestInfo(corner).dist >= track.halfWidth + 7,
          'stand footprint must clear the barrier',
        );
      }
    for (const [distance, level] of [
      [50, 0],
      [250, 1],
      [500, 2],
      [50, 0],
    ]) {
      camera.position
        .copy(stand.position)
        .add(new THREE.Vector3(0, 0, distance));
      camera.updateMatrixWorld(true);
      stand.update(camera);
      assert.equal(stand.getCurrentLevel(), level);
      assert.equal(stand.children.filter((child) => child.visible).length, 1);
    }
  }
});

test('nitro stations have a full boost of gentle road ahead and stay clear of the grid and walls', () => {
  mockSceneryDocument();
  const track = buildTrack(new THREE.Scene());
  const pickups = createNitroPickups(track);
  const stations = [...new Set(pickups.map((p) => p.index))];
  assert.equal(
    stations.length,
    2,
    'the main and back straights should each get a station',
  );
  assert.equal(pickups.length, stations.length * 3);
  for (const pickup of pickups) {
    const road = track.nearestInfo(pickup.pos);
    assert.ok(Math.abs(road.offset) + NITRO.radius < track.halfWidth - 1.4);
    for (const spawn of track.startPositions) {
      assert.ok(
        Math.hypot(pickup.pos.x - spawn.pos.x, pickup.pos.z - spawn.pos.z) > 30,
      );
    }
    let distance = 0,
      turn = 0,
      i = pickup.index;
    while (distance < NITRO.lookAhead) {
      const j = (i + 1) % track.samples.length;
      const a = track.samples[i],
        b = track.samples[j];
      distance += Math.hypot(b.x - a.x, b.z - a.z);
      turn += track.tangents[i].angleTo(track.tangents[j]);
      i = j;
    }
    assert.ok(turn <= NITRO.maxTurn, 'pickup must not feed a tight corner');
    assert.ok(distance > NITRO.maxSpeed * NITRO.duration);
  }
  const a = track.samples[stations[0]],
    b = track.samples[stations[1]];
  assert.ok(
    a.distanceTo(b) > 200,
    'stations should be spread around the circuit',
  );
});

test('road height changes continuously between samples, including the lap seam', () => {
  mockSceneryDocument();
  const track = buildTrack(new THREE.Scene());
  for (let i = 0; i < track.samples.length; i++) {
    const a = track.samples[i],
      b = track.samples[(i + 1) % track.samples.length];
    for (const fraction of [0.25, 0.49, 0.51, 0.75]) {
      const point = a.clone().lerp(b, fraction);
      const info = track.nearestInfo(point);
      assert.ok(
        Math.abs(info.groundY - point.y) < 1e-8,
        `height jump on segment ${i}`,
      );
      assert.ok(info.dist < 1e-8);
    }
  }
});

test('wheel contact height matches the rendered road triangles around bends', () => {
  mockSceneryDocument();
  const scene = new THREE.Scene(), track = buildTrack(scene);
  const road = scene.getObjectByName('asphalt-road').geometry;
  const vertices = road.attributes.position;
  scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  for (let segment = 2; segment < track.samples.length - 1; segment++) {
    for (let triangle = 0; triangle < 2; triangle++) {
      const point = new THREE.Vector3();
      for (let corner = 0; corner < 3; corner++) {
        const index = road.index.getX(segment * 6 + triangle * 3 + corner);
        point.addScaledVector(new THREE.Vector3().fromBufferAttribute(vertices, index), [0.2, 0.4, 0.4][corner]);
      }
      const surface = track.surfaceInfo(point, segment);
      for (const hint of [segment - 3, segment + 3, 0]) {
        assert.equal(track.surfaceInfo(point, hint).groundY, surface.groundY,
          'changing the nearest segment must not change the road height');
      }
      ray.ray.origin.set(point.x, 100, point.z);
      const visibleHeight = ray.intersectObject(scene.getObjectByName('asphalt-road'))[0].point.y;
      // Tight inside bends can overlap; use the top visible triangle. Kerbs
      // are an additional 5 cm above this asphalt mesh.
      assert.ok(surface.groundY >= visibleHeight - 1e-6 && surface.groundY <= visibleHeight + 0.050001,
        JSON.stringify({ segment, triangle, expected: visibleHeight, actual: surface.groundY }));
      assert.ok(surface.normalY > 0.9);
    }
  }
});

test('uphill vehicle height follows the surface immediately at racing speed', () => {
  const track = { halfWidth: 100, nearestInfo: p => ({ index: 0, offset: 0, groundY: p.z * 0.15 }) };
  const p = { input: { steer: 0 }, steerSmooth: 0, speed: 46, heading: 0,
    groundY: 0, pos: new THREE.Vector3(), mesh: new THREE.Group() };
  for (let frame = 0; frame < 60; frame++) {
    updateCar(p, 1 / 60, track, { dropSkid() {}, onGate() {} });
    assert.ok(Math.abs(p.groundY - track.nearestInfo(p.pos).groundY) < 1e-9);
  }
});

test('chassis suspension smooths a crest without accumulating uphill lag', () => {
  const height = z => z < 20 ? z * 0.15 : 3 - (z - 20) * 0.1;
  const track = { surfaceInfo({ z }) {
    const slope = z < 20 ? 0.15 : -0.1, length = Math.hypot(1, slope);
    return { groundY: height(z), normalX: 0, normalY: 1 / length, normalZ: -slope / length };
  } };
  const results = [];
  for (const hz of [30, 60, 120]) {
    const p = { pos: new THREE.Vector3(0, 0, -20), mesh: new THREE.Group(), groundY: -3,
      heading: 0, pitch: 0, roll: 0, steerSmooth: 0, wheelSpin: 0 };
    p.mesh.rotation.order = 'YXZ';
    resetMotion(p);
    renderCar(p, 1, track, 1 / hz);
    let lastHeight = p.mesh.position.y, lastPitch = p.mesh.rotation.x;
    let lastVelocity = 0, maxAcceleration = 0, maxPitchRate = 0;
    for (let frame = 0; frame < hz * 2; frame++) {
      savePreviousPose(p);
      p.pos.z += 46 / hz;
      p.groundY = height(p.pos.z);
      renderCar(p, 1, track, 1 / hz);
      const velocity = (p.mesh.position.y - lastHeight) * hz;
      if (p.pos.z > 12 && p.pos.z < 30) {
        maxAcceleration = Math.max(maxAcceleration, Math.abs(velocity - lastVelocity) * hz);
        maxPitchRate = Math.max(maxPitchRate, Math.abs(p.mesh.rotation.x - lastPitch) * hz);
      }
      if (p.pos.z > 8 && p.pos.z < 16) {
        assert.ok(Math.abs(p.mesh.position.y - height(p.pos.z) - 0.015) < 0.06,
          'body must catch up on a steady grade');
      }
      lastHeight = p.mesh.position.y; lastPitch = p.mesh.rotation.x; lastVelocity = velocity;
    }
    assert.ok(maxAcceleration < 180, 'crest must not snap vertical velocity: ' + maxAcceleration);
    assert.ok(maxPitchRate < 1.5, 'crest pitch must ease over time: ' + maxPitchRate);
    results.push({ y: p.mesh.position.y, pitch: p.mesh.rotation.x });
  }
  for (const result of results.slice(1)) {
    assert.ok(Math.abs(result.y - results[0].y) < 0.015);
    assert.ok(Math.abs(result.pitch - results[0].pitch) < 0.005);
  }
});

test('rendered motion stays continuous at different refresh rates without moving physics state', () => {
  for (const hz of [60, 120, 144]) {
    const p = {
      pos: new THREE.Vector3(),
      groundY: 0,
      heading: 0,
      pitch: 0,
      roll: 0,
      wheelSpin: 0,
      steerSmooth: 0,
      mesh: new THREE.Object3D(),
    };
    resetMotion(p);
    let accumulated = 0,
      lastZ = 0;
    for (let frame = 0; frame < hz * 2; frame++) {
      accumulated += 1 / hz;
      while (accumulated >= 1 / 60) {
        savePreviousPose(p);
        p.pos.z += 30 / 60;
        accumulated -= 1 / 60;
      }
      const physicsZ = p.pos.z;
      renderCar(p, accumulated / (1 / 60));
      assert.equal(p.pos.z, physicsZ);
      if (frame > 3)
        assert.ok(
          Math.abs(p.mesh.position.z - lastZ - 30 / hz) < 1e-9,
          `uneven movement at ${hz} Hz`,
        );
      lastZ = p.mesh.position.z;
    }
    // Respawning must discard the old race's interpolation history.
    p.pos.set(100, 0, 100);
    resetMotion(p);
    renderCar(p, 0);
    assert.equal(p.mesh.position.z, 100);
  }
});

test('ground shadow follows road height and slope without inheriting car lean', () => {
  const mesh = new THREE.Group();
  mesh.rotation.order = 'YXZ';
  const shadow = new THREE.Object3D();
  shadow.rotation.order = 'ZXY';
  shadow.position.z = -0.2;
  mesh.add(shadow);
  mesh.userData.groundShadow = shadow;
  const p = {
    pos: new THREE.Vector3(),
    groundY: 0,
    surfaceY: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    shadowSlopePitch: 0,
    wheelSpin: 0,
    steerSmooth: 0,
    mesh,
  };
  resetMotion(p);
  p.groundY = 1.8;
  p.surfaceY = 2;
  p.heading = 0.7;
  p.pitch = 0.18;
  p.roll = 0.06;
  p.shadowSlopePitch = 0.04;
  renderCar(p, 1);
  mesh.updateMatrixWorld(true);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(
    shadow.getWorldQuaternion(new THREE.Quaternion()),
  );
  const roadNormal = new THREE.Vector3(0, 1, 0).applyEuler(
    new THREE.Euler(0.04, 0.7, 0, 'YXZ'),
  );
  assert.ok(
    normal.angleTo(roadNormal) < 1e-6,
    'body pitch and roll must not tilt the shadow',
  );
  assert.ok(
    Math.abs(shadow.getWorldPosition(new THREE.Vector3()).y - 2.06) < 0.02,
    'shadow must stay at the road surface when the car body lags behind it',
  );
});

test('default driving launches and stays within the real track', () => {
  mockSceneryDocument();
  const track = buildTrack(new THREE.Scene());

  for (const spawn of track.startPositions) {
    const player = {
      input: { steer: 0, brake: 0 },
      steerSmooth: 0,
      speed: 0,
      prevSpeed: 0,
      gear: 0,
      pos: spawn.pos.clone(),
      heading: spawn.heading,
      sampleIndex: 0,
      groundY: spawn.pos.y,
      offTrack: false,
      mesh: {
        position: { set() {} },
        rotation: { set() {} },
        userData: { wheels: [] },
      },
    };
    for (let frame = 0; frame < 600; frame++) {
      updateCar(player, 1 / 60, track, {
        dropSkid: () => {},
        onGate: () => {},
      });
      const road = track.nearestInfo(player.pos);
      assert.ok(
        Number.isFinite(player.speed) && road.dist < track.halfWidth + 2,
        `car left road after ${frame / 60}s: ${JSON.stringify({ pos: player.pos, speed: player.speed, distance: road.dist })}`,
      );
      if (frame === 59)
        assert.ok(
          player.speed > 8,
          `slow launch: ${player.speed.toFixed(1)} m/s`,
        );
    }
  }
});

test('manual driving waits for throttle, coasts to rest, and gives brake priority', () => {
  const track = {
    halfWidth: 100,
    nearestInfo: () => ({ index: 0, offset: 0, groundY: 0 }),
  };
  const p = {
    input: { steer: 0, brake: 0, throttle: 0 },
    steerSmooth: 0,
    speed: 0,
    prevSpeed: 0,
    gear: 0,
    pos: new THREE.Vector3(),
    heading: 0,
    sampleIndex: 0,
    groundY: 0,
    mesh: new THREE.Group(),
  };
  const hooks = { dropSkid() {}, onGate() {}, autoAccelerate: false };
  const step = (frames = 60) => {
    for (let i = 0; i < frames; i++) updateCar(p, 1 / 60, track, hooks);
  };
  step();
  assert.equal(p.speed, 0);
  assert.equal(p.pos.z, 0);
  p.input.throttle = 1;
  step();
  assert.ok(p.speed > 20);
  const movingSpeed = p.speed;
  p.input.throttle = 0;
  step();
  assert.ok(Math.abs((movingSpeed - p.speed) / 0.44704 - 2) < 1e-9);
  step(1800);
  assert.equal(p.speed, 0);
  p.input.throttle = 1;
  step();
  p.input.brake = 1;
  const brakingSpeed = p.speed;
  step(1);
  assert.ok(p.speed < brakingSpeed, 'brake overrides a held accelerator');
  step();
  assert.ok(p.speed < 0, 'holding brake from rest reverses');
  p.input = { steer: 0, brake: 0, throttle: 0 };
  step(900);
  assert.equal(
    Math.abs(p.speed),
    0,
    'reverse coasting stops without accelerating forward',
  );
  p.nitroTime = 2;
  step(1);
  assert.equal(
    Math.abs(p.speed),
    0,
    'nitro must not launch a manual car without throttle',
  );
  p.input.throttle = 1;
  step();
  assert.ok(p.speed > movingSpeed, 'nitro still boosts when the pedal is held');
});

test('turning alone leaves no tire marks; hard braking and wall impact leave two', () => {
  const track = {
    halfWidth: 10,
    nearestInfo(pos) {
      return { index: 0, offset: pos.x, nx: 1, nz: 0, groundY: 0 };
    },
  };
  const mesh = new THREE.Group();
  mesh.userData.wheels = [-0.85, 0.85, -0.85, 0.85].map((x, i) => {
    const wheel = new THREE.Group();
    wheel.position.set(x, 0.36, i < 2 ? 1.2 : -1.4);
    mesh.add(wheel);
    return wheel;
  });
  const p = {
    input: { steer: 1, brake: 0 },
    steerSmooth: 1,
    speed: 40,
    prevSpeed: 40,
    gear: 0,
    pos: new THREE.Vector3(),
    heading: 0,
    sampleIndex: 0,
    groundY: 0,
    offTrack: false,
    mesh,
  };
  const marks = [];
  const hooks = { dropSkid: (...args) => marks.push(args), onGate() {} };
  updateCar(p, 1 / 60, track, hooks);
  assert.ok(
    Math.abs(p.steerSmooth) * Math.abs(p.speed) > 30,
    'exercise the former drift threshold',
  );
  assert.equal(p.skidding, false);
  assert.equal(marks.length, 0);

  p.input = { steer: 0, brake: 1 };
  p.steerSmooth = 0;
  updateCar(p, 1 / 60, track, hooks);
  assert.equal(p.skidding, true);
  assert.equal(marks.length, 2);

  p.input.brake = 0;
  p.speed = p.prevSpeed = 35;
  p.pos.set(8.4, 0, 0);
  p.heading = Math.PI / 2;
  resetHandling(p);
  updateCar(p, 1 / 60, track, hooks);
  assert.equal(p.offTrack, true);
  assert.equal(p.skidding, true);
  assert.equal(marks.length, 4);
});
