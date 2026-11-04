import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const root = resolve(import.meta.dirname, '..');
const nitroUrl = `data:text/javascript,${encodeURIComponent(readFileSync(resolve(root, 'public/js/nitro.js'), 'utf8'))}`;
const { NITRO, resetNitroPickups, updateNitroPickups } = await import(nitroUrl);
const physicsSource = readFileSync(
  resolve(root, 'public/js/physics.js'),
  'utf8',
)
  .replace(
    "from 'three'",
    `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`,
  )
  .replace("from './nitro.js'", `from ${JSON.stringify(nitroUrl)}`);
const { PHYS, updateCar, resetHandling, DRIVE_MODE } = await import(
  `data:text/javascript,${encodeURIComponent(physicsSource)}`
);
const flatTrack = {
  halfWidth: 22,
  nearestInfo: () => ({ index: 0, offset: 0, nx: 1, nz: 0, groundY: 0 }),
};
const hooks = { dropSkid() {}, onGate() {} };
function player(slot = 0, x = 0) {
  return {
    slot,
    input: { steer: 0, brake: 0 },
    steerSmooth: 0,
    speed: 0,
    prevSpeed: 0,
    gear: 0,
    heading: 0,
    groundY: 0,
    sampleIndex: 0,
    pos: new THREE.Vector3(x, 0, 10),
    previousPose: { x, z: -10 },
    mesh: new THREE.Object3D(),
    nitroTime: 0,
  };
}
const bottle = (x = 0) => ({ pos: { x, y: 0, z: 0 }, heading: 0, cooldown: 0 });
const step = (p) => updateCar(p, 1 / 60, flatTrack, hooks);

test('normal launch is quicker and still respects its normal top speed', () => {
  const p = player();
  for (let i = 0; i < 60; i++) step(p);
  assert.ok(
    p.speed > 24 && p.speed < 26,
    'one-second launch should reflect stronger acceleration',
  );
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

test('manual accelerator release loses 2 mph per second at different speeds and frame rates', () => {
  for (const mph of [15, 60, 120, -20]) {
    for (const hz of [30, 60, 120]) {
      const p = player();
      p.speed = p.prevSpeed = mph * 0.44704;
      for (let frame = 0; frame < hz; frame++) {
        updateCar(p, 1 / hz, flatTrack, { ...hooks, autoAccelerate: false });
      }
      const expected = Math.sign(mph) * (Math.abs(mph) - 2);
      assert.ok(Math.abs(p.speed / 0.44704 - expected) < 1e-9);
    }
  }
});

test('brake steering turns harder, slides along a separate path, and regains grip on release', () => {
  for (const direction of [-1, 1]) {
    const normal = player(), drift = player();
    for (const p of [normal, drift]) {
      p.speed = 40;
      p.input.steer = direction;
      p.steerSmooth = direction;
    }
    drift.input.brake = 1;
    for (let frame = 0; frame < 36; frame++) { step(normal); step(drift); }
    assert.ok(Math.abs(drift.heading) > Math.abs(normal.heading) * 1.4, 'braking increases turn response');
    assert.ok(Math.abs(drift.heading - drift.travelHeading) > 0.2, 'body rotates beyond the direction of movement');
    assert.ok(Math.abs(normal.slipAngle) < 0.15, 'normal turns retain grip');
    assert.equal(normal.driveMode, DRIVE_MODE.TRACTION);
    assert.equal(drift.skidding, true);
    const before = drift.pos.clone();
    step(drift);
    const movement = Math.atan2(drift.pos.x - before.x, drift.pos.z - before.z);
    assert.ok(Math.abs(movement - drift.travelHeading) < 1e-9, 'drift changes actual movement, not just the model');
    drift.input.brake = 0;
    drift.input.steer = 0;
    for (let frame = 0; frame < 120; frame++) step(drift);
    assert.ok(Math.abs(drift.heading - drift.travelHeading) < 0.01);
    assert.equal(drift.skidding, false);
  }
});

function startDrift(direction = 1) {
  const p = player();
  p.speed = 40;
  p.input = { steer: direction, brake: 1 };
  p.steerSmooth = direction;
  for (let frame = 0; frame < 36; frame++) step(p);
  return p;
}

test('drift entry uses measured chassis slip and rear grip loss while preserving front grip and momentum', () => {
  const p = player();
  p.speed = 40; p.input = { steer: 1, brake: 1 }; p.steerSmooth = 1;
  step(p);
  assert.equal(p.driveMode, DRIVE_MODE.TRACTION, 'brake input alone does not declare a slide');
  assert.ok(p.rearFriction < PHYS.rearFriction, 'braking starts unloading the rear axle');
  for (let frame = 1; frame < 36; frame++) step(p);
  assert.equal(p.driveMode, DRIVE_MODE.DRIFT);
  assert.ok(Math.abs(p.slipAngle) > PHYS.driftEnterAngle);
  assert.equal(p.slipAngle, Math.atan2(p.localVelocity.x, p.localVelocity.z));
  assert.equal(p.frontFriction, PHYS.frontFriction);
  assert.ok(p.rearFriction < p.frontFriction * 0.5);
  assert.ok(p.speed > 32 && p.localVelocity.z > 25, 'brake drift retains forward momentum');
  assert.ok(Math.abs(p.velocity.length() - p.speed) < 1e-9);
});

test('counter-steering opposes yaw and stabilizes both left and right slides', () => {
  for (const direction of [-1, 1]) {
    const counter = startDrift(direction), held = startDrift(direction);
    counter.input.steer = -direction;
    counter.input.brake = held.input.brake = 0;
    for (let frame = 0; frame < 24; frame++) { step(counter); step(held); }
    assert.ok(counter.yawRate * direction < held.yawRate * direction, 'counter-steer produces opposing yaw');
    assert.ok(Math.abs(counter.slipAngle) < Math.abs(held.slipAngle), 'counter-steer reduces slip');
    for (let frame = 0; frame < 180; frame++) {
      step(held);
      assert.ok(Math.abs(held.slipAngle) < 0.85, 'sustained slide must not become a spinout');
    }
  }
});

test('releasing steering or losing momentum exits drift and restores rear friction progressively', () => {
  for (const stop of ['steering', 'momentum']) {
    const p = startDrift();
    const grip = p.rearFriction;
    if (stop === 'steering') p.input.steer = 0;
    else p.speed = 6;
    p.input.brake = 0;
    const manualHooks = { ...hooks, autoAccelerate: false };
    updateCar(p, 1 / 60, flatTrack, manualHooks);
    assert.equal(p.driveMode, DRIVE_MODE.TRACTION);
    assert.ok(p.rearFriction > grip && p.rearFriction < PHYS.rearFriction, 'grip returns without snapping');
    for (let frame = 0; frame < 180; frame++) updateCar(p, 1 / 60, flatTrack, manualHooks);
    assert.ok(p.rearFriction > 0.99);
    assert.equal(p.driveMode, DRIVE_MODE.TRACTION);
    resetHandling(p);
    assert.equal(p.rearFriction, PHYS.rearFriction);
    assert.ok(Math.abs(p.slipAngle) < 1e-9);
    assert.equal(p.yawRate, 0);
  }
});

test('normal steering is gentler and drift handling is consistent across step sizes', () => {
  const normal = player();
  normal.speed = 40; normal.input.steer = normal.steerSmooth = 1;
  for (let frame = 0; frame < 60; frame++) step(normal);
  assert.ok(Math.abs(normal.heading) < 1.1, 'ordinary turning is reduced from the former 2 rad/s response');
  assert.equal(normal.driveMode, DRIVE_MODE.TRACTION);
  assert.equal(normal.rearFriction, PHYS.rearFriction);
  const results = [];
  for (const hz of [30, 60, 120]) {
    const p = player();
    p.speed = 40; p.input = { steer: 1, brake: 1 }; p.steerSmooth = 1;
    for (let frame = 0; frame < hz; frame++) updateCar(p, 1 / hz, flatTrack, hooks);
    results.push(p);
    assert.equal(p.driveMode, DRIVE_MODE.DRIFT);
  }
  for (const p of results.slice(1)) {
    assert.ok(Math.abs(p.heading - results[0].heading) < 0.03);
    assert.ok(Math.abs(p.slipAngle - results[0].slipAngle) < 0.03);
    assert.ok(Math.abs(p.speed - results[0].speed) < 1e-8);
  }
});

test('swept collection catches fast crossings and awards each shared bottle only once', () => {
  const later = player(0),
    earlier = player(1);
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
  const racers = new Map([
    [-8, player(0, -8)],
    [8, player(1, 8)],
  ]);
  const pickups = [bottle(-8), bottle(8)];
  for (const p of racers.values()) {
    p.speed = 40;
    p.nitroTime = 1;
  }
  updateNitroPickups(pickups, racers.values(), 1 / 60);
  for (const p of racers.values()) assert.equal(p.nitroTime, NITRO.duration);
  updateNitroPickups(pickups, [], NITRO.respawn);
  assert.ok(pickups.every((p) => p.cooldown === 0));
  updateNitroPickups(pickups, racers.values(), 1 / 60);
  assert.ok(pickups.every((p) => p.cooldown === NITRO.respawn));
  resetNitroPickups(pickups);
  assert.ok(pickups.every((p) => p.cooldown === 0));
});

test('misses, braking, reverse, wrong-way and finished cars cannot trigger a boost', () => {
  for (const change of [
    (p) => {
      p.pos.x = p.previousPose.x = 5;
    },
    (p) => {
      p.input.brake = 1;
    },
    (p) => {
      p.speed = -10;
    },
    (p) => {
      p.heading = Math.PI;
    },
    (p) => {
      p.finished = true;
    },
  ]) {
    const p = player(),
      pickup = bottle();
    p.speed = 46;
    change(p);
    updateNitroPickups([pickup], [p], 1 / 60);
    assert.equal(p.nitroTime, 0);
    assert.equal(pickup.cooldown, 0);
  }
});
