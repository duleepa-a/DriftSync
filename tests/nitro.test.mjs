import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const root = resolve(import.meta.dirname, '..');
const nitroUrl = `data:text/javascript,${encodeURIComponent(readFileSync(resolve(root, 'public/js/nitro.js'), 'utf8'))}`;
const { NITRO, resetNitroPickups, updateNitroPickups } = await import(nitroUrl);
const physicsSource = readFileSync(resolve(root, 'public/js/physics.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`)
  .replace("from './nitro.js'", `from ${JSON.stringify(nitroUrl)}`);
const { PHYS, updateCar } = await import(`data:text/javascript,${encodeURIComponent(physicsSource)}`);
const flatTrack = {
  halfWidth: 22,
  nearestInfo: () => ({ index: 0, offset: 0, nx: 1, nz: 0, groundY: 0 }),
};
const hooks = { dropSkid() {}, onGate() {} };
function player(slot = 0, x = 0) {
  return {
    slot, input: { steer: 0, brake: 0 }, steerSmooth: 0,
    speed: 0, prevSpeed: 0, gear: 0, heading: 0, groundY: 0,
    sampleIndex: 0, pos: new THREE.Vector3(x, 0, 10),
    previousPose: { x, z: -10 }, mesh: new THREE.Object3D(), nitroTime: 0,
  };
}
const bottle = (x = 0) => ({ pos: { x, y: 0, z: 0 }, heading: 0, cooldown: 0 });
const step = p => updateCar(p, 1 / 60, flatTrack, hooks);

test('normal launch is quicker and still respects its normal top speed', () => {
  const p = player();
  for (let i = 0; i < 60; i++) step(p);
  assert.ok(p.speed > 24 && p.speed < 26, 'one-second launch should reflect stronger acceleration');
  for (let i = 0; i < 600; i++) step(p);
  assert.equal(p.speed, PHYS.maxSpeed);
});

test('nitro accelerates above normal speed, expires, and coasts smoothly back to the cap', () => {
  const p = player();
  p.speed = p.prevSpeed = PHYS.maxSpeed;
  p.nitroTime = NITRO.duration;
  for (let i = 0; i < 60; i++) step(p);
  assert.equal(p.speed, NITRO.maxSpeed);
  for (let i = 0; i < 61; i++) step(p);
  assert.equal(p.nitroTime, 0);
  const speed = p.speed;
  step(p);
  assert.ok(p.speed > PHYS.maxSpeed);
  assert.ok(speed - p.speed <= NITRO.coastDecel / 60 + 1e-9);
  for (let i = 0; i < 120; i++) step(p);
  assert.equal(p.speed, PHYS.maxSpeed);
});

test('braking cancels nitro immediately and preserves reverse control', () => {
  const p = player();
  p.speed = p.prevSpeed = NITRO.maxSpeed;
  p.nitroTime = NITRO.duration;
  p.input.brake = 1;
  step(p);
  assert.equal(p.nitroTime, 0);
  assert.ok(p.speed < NITRO.maxSpeed);
  for (let i = 0; i < 180; i++) step(p);
  assert.equal(p.speed, PHYS.reverseMax);
});

test('swept collection catches fast crossings and awards each shared bottle only once', () => {
  const later = player(0), earlier = player(1);
  later.speed = earlier.speed = 64;
  earlier.previousPose.z = -5;
  const pickup = bottle();
  let awarded = 0;
  updateNitroPickups([pickup], [later, earlier], 1 / 60, () => awarded++);
  assert.equal(earlier.nitroTime, NITRO.duration);
  assert.equal(later.nitroTime, 0);
  assert.equal(pickup.cooldown, NITRO.respawn);
  updateNitroPickups([pickup], [later], 1 / 60, () => awarded++);
  assert.equal(awarded, 1);
  assert.equal(later.nitroTime, 0);
});

test('all lanes collect with a player iterator, respawn, and refresh rather than stack', () => {
  const racers = new Map([[-8, player(0, -8)], [8, player(1, 8)]]);
  const pickups = [bottle(-8), bottle(8)];
  for (const p of racers.values()) { p.speed = 40; p.nitroTime = 1; }
  updateNitroPickups(pickups, racers.values(), 1 / 60);
  for (const p of racers.values()) assert.equal(p.nitroTime, NITRO.duration);
  updateNitroPickups(pickups, [], NITRO.respawn);
  assert.ok(pickups.every(p => p.cooldown === 0));
  updateNitroPickups(pickups, racers.values(), 1 / 60);
  assert.ok(pickups.every(p => p.cooldown === NITRO.respawn));
  resetNitroPickups(pickups);
  assert.ok(pickups.every(p => p.cooldown === 0));
});

test('misses, braking, reverse, wrong-way and finished cars cannot trigger a boost', () => {
  for (const change of [
    p => { p.pos.x = p.previousPose.x = 5; },
    p => { p.input.brake = 1; },
    p => { p.speed = -10; },
    p => { p.heading = Math.PI; },
    p => { p.finished = true; },
  ]) {
    const p = player(), pickup = bottle();
    p.speed = 46;
    change(p);
    updateNitroPickups([pickup], [p], 1 / 60);
    assert.equal(p.nitroTime, 0);
    assert.equal(pickup.cooldown, 0);
  }
});
