import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const root = resolve(import.meta.dirname, '..');
const roadSource = readFileSync(resolve(root, 'public/js/road-material.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`);
const roadUrl = `data:text/javascript,${encodeURIComponent(roadSource)}`;
const scenerySource = readFileSync(resolve(root, 'public/js/scenery.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`);
const sceneryUrl = `data:text/javascript,${encodeURIComponent(scenerySource)}`;
const trackSource = readFileSync(resolve(root, 'public/js/track.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`)
  .replace("from './road-material.js'", `from ${JSON.stringify(roadUrl)}`)
  .replace("from './scenery.js'", `from ${JSON.stringify(sceneryUrl)}`);
const { buildTrack } = await import(`data:text/javascript,${encodeURIComponent(trackSource)}`);
const nitroSource = readFileSync(resolve(root, 'public/js/nitro.js'), 'utf8');
const nitroUrl = `data:text/javascript,${encodeURIComponent(nitroSource)}`;
const { NITRO, createNitroPickups } = await import(nitroUrl);
const physicsSource = readFileSync(resolve(root, 'public/js/physics.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`)
  .replace("from './nitro.js'", `from ${JSON.stringify(nitroUrl)}`);
const { updateCar } = await import(`data:text/javascript,${encodeURIComponent(physicsSource)}`);
const motionSource = readFileSync(resolve(root, 'public/js/motion.js'), 'utf8');
const { resetMotion, savePreviousPose, renderCar } = await import(`data:text/javascript,${encodeURIComponent(motionSource)}`);

test('forest and grandstands clear the road, and scenery LOD resets for each camera', () => {
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  const scene = new THREE.Scene(), track = buildTrack(scene);
  const forest = scene.getObjectByName('instanced-pine-forest');
  assert.ok(forest.isInstancedMesh && forest.count >= 700);
  assert.equal(forest.geometry.groups.length, 0, 'all tree parts must use one draw call');
  assert.ok(!Array.isArray(forest.material));
  assert.ok(forest.count * forest.geometry.attributes.position.count / 3 < 150000);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
  for (let i = 0; i < forest.count; i++) {
    forest.getMatrixAt(i, matrix);
    position.setFromMatrixPosition(matrix);
    const road = track.nearestInfo(position);
    assert.ok(road.dist >= track.halfWidth + 18, 'trees must clear every road segment');
    const blend = THREE.MathUtils.clamp((road.dist - track.halfWidth - 16) / 64, 0, 1);
    assert.ok(Math.abs(position.y - (THREE.MathUtils.lerp(road.groundY, -16, blend) - 0.15)) < 0.001);
  }
  scene.updateMatrixWorld(true);
  const stands = scene.getObjectByName('track-scenery').children.filter(child => child.isLOD);
  assert.equal(stands.length, 4, 'all four designated spectator areas must fit');
  const camera = new THREE.PerspectiveCamera();
  for (const stand of stands) {
    for (const x of [-24, 0, 24]) for (const z of [-1, 6, 14]) {
      const corner = new THREE.Vector3(x, 0, z).applyMatrix4(stand.matrixWorld);
      assert.ok(track.nearestInfo(corner).dist >= track.halfWidth + 7, 'stand footprint must clear the barrier');
    }
    for (const [distance, level] of [[50, 0], [250, 1], [500, 2], [50, 0]]) {
      camera.position.copy(stand.position).add(new THREE.Vector3(0, 0, distance));
      camera.updateMatrixWorld(true);
      stand.update(camera);
      assert.equal(stand.getCurrentLevel(), level);
      assert.equal(stand.children.filter(child => child.visible).length, 1);
    }
  }
});

test('nitro stations have a full boost of gentle road ahead and stay clear of the grid and walls', () => {
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  const track = buildTrack(new THREE.Scene());
  const pickups = createNitroPickups(track);
  const stations = [...new Set(pickups.map(p => p.index))];
  assert.equal(stations.length, 2, 'the main and back straights should each get a station');
  assert.equal(pickups.length, stations.length * 3);
  for (const pickup of pickups) {
    const road = track.nearestInfo(pickup.pos);
    assert.ok(Math.abs(road.offset) + NITRO.radius < track.halfWidth - 1.4);
    for (const spawn of track.startPositions) {
      assert.ok(Math.hypot(pickup.pos.x - spawn.pos.x, pickup.pos.z - spawn.pos.z) > 30);
    }
    let distance = 0, turn = 0, i = pickup.index;
    while (distance < NITRO.lookAhead) {
      const j = (i + 1) % track.samples.length;
      const a = track.samples[i], b = track.samples[j];
      distance += Math.hypot(b.x - a.x, b.z - a.z);
      turn += track.tangents[i].angleTo(track.tangents[j]);
      i = j;
    }
    assert.ok(turn <= NITRO.maxTurn, 'pickup must not feed a tight corner');
    assert.ok(distance > NITRO.maxSpeed * NITRO.duration);
  }
  const a = track.samples[stations[0]], b = track.samples[stations[1]];
  assert.ok(a.distanceTo(b) > 200, 'stations should be spread around the circuit');
});

test('road height changes continuously between samples, including the lap seam', () => {
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  const track = buildTrack(new THREE.Scene());
  for (let i = 0; i < track.samples.length; i++) {
    const a = track.samples[i], b = track.samples[(i + 1) % track.samples.length];
    for (const fraction of [0.25, 0.49, 0.51, 0.75]) {
      const point = a.clone().lerp(b, fraction);
      const info = track.nearestInfo(point);
      assert.ok(Math.abs(info.groundY - point.y) < 1e-8, `height jump on segment ${i}`);
      assert.ok(info.dist < 1e-8);
    }
  }
});

test('rendered motion stays continuous at different refresh rates without moving physics state', () => {
  for (const hz of [60, 120, 144]) {
    const p = {
      pos: new THREE.Vector3(), groundY: 0, heading: 0, pitch: 0, roll: 0,
      wheelSpin: 0, steerSmooth: 0, mesh: new THREE.Object3D(),
    };
    resetMotion(p);
    let accumulated = 0, lastZ = 0;
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
      if (frame > 3) assert.ok(Math.abs(p.mesh.position.z - lastZ - 30 / hz) < 1e-9, `uneven movement at ${hz} Hz`);
      lastZ = p.mesh.position.z;
    }
    // Respawning must discard the old race's interpolation history.
    p.pos.set(100, 0, 100);
    resetMotion(p);
    renderCar(p, 0);
    assert.equal(p.mesh.position.z, 100);
  }
});

test('default driving launches and stays within the real track', () => {
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  const track = buildTrack(new THREE.Scene());

  for (const spawn of track.startPositions) {
    const player = {
      input: { steer: 0, brake: 0 },
      steerSmooth: 0, speed: 0, prevSpeed: 0, gear: 0,
      pos: spawn.pos.clone(), heading: spawn.heading,
      sampleIndex: 0, groundY: spawn.pos.y, offTrack: false,
      mesh: { position: { set() {} }, rotation: { set() {} }, userData: { wheels: [] } },
    };
    for (let frame = 0; frame < 600; frame++) {
      updateCar(player, 1 / 60, track, { dropSkid: () => {}, onGate: () => {} });
      const road = track.nearestInfo(player.pos);
      assert.ok(Number.isFinite(player.speed) && road.dist < track.halfWidth + 2,
        `car left road after ${frame / 60}s: ${JSON.stringify({ pos: player.pos, speed: player.speed, distance: road.dist })}`);
      if (frame === 59) assert.ok(player.speed > 8, `slow launch: ${player.speed.toFixed(1)} m/s`);
    }
  }
});
