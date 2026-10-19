import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';

/**
 * Rapier raycast-vehicle physics (real suspension + tyre friction/slip).
 *
 * Flow per frame:
 *   for each car: applyControls(id, input, dt)   // sets steer/engine/brake + updateVehicle
 *   step(dt)                                      // advances the world once
 *   for each car: getState(id)                    // read transform + velocity
 *
 * All tunables live in TUNE so we can iterate on feel quickly.
 */

export const TUNE = {
  gravity: -11,
  // chassis (half-extents, metres) + mass
  chassis: { hx: 0.9, hy: 0.4, hz: 2.0, mass: 780, comY: -0.4 },
  linearDamping: 0.25,
  angularDamping: 1.4,      // resist rolling/spinning out
  // wheels
  wheel: { radius: 0.34, restLength: 0.30, x: 0.85, y: -0.20, zFront: 1.45, zRear: -1.45 },
  suspension: { stiffness: 28, compression: 0.85, relaxation: 0.9, maxTravel: 0.32, maxForce: 70000 },
  frictionSlip: 2.3,        // tyre grip (higher = more grip)
  sideFrictionStiffness: 1.0,
  // drivetrain
  engineForce: 9500,        // auto-throttle force on rear wheels (strong accel)
  topSpeed: 86,             // m/s cap for engine force (high, sporty)
  brakeForce: 2600,
  reverseForce: 1500,
  maxSteer: 0.6,           // rad (~34°) — effective lock; higher actually steers LESS
  steerSpeedFalloff: 0.2,  // keep turning sharp at speed (more playable)
};

let world = null;
let ready = false;
const cars = new Map();          // id -> { body, vehicle, colliderHandle }
const carColliderHandles = new Set();

export async function initPhysics() {
  await RAPIER.init();
  return true;
}

export function isReady() { return ready; }

export function buildWorld(colliders) {
  world = new RAPIER.World({ x: 0, y: TUNE.gravity, z: 0 });

  // Static drivable surface (road + apron + gravel + grass embankment).
  const g = colliders.ground;
  const gBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.trimesh(g.vertices, g.indices).setFriction(1.0), gBody);

  // Static barriers.
  const w = colliders.walls;
  const wBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(w.vertices, w.indices).setFriction(0.35).setRestitution(0.15),
    wBody
  );

  // Safety floor far below, so a car can never fall into the void.
  const fBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, colliders.floorY ?? -60, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 1, 3000), fBody);

  ready = true;
}

export function addCar(id, spawn) {
  if (!world) return;
  const yaw = spawn.heading || 0;
  const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(spawn.pos.x, spawn.pos.y + 1.0, spawn.pos.z)
    .setRotation(q)
    .setLinearDamping(TUNE.linearDamping)
    .setAngularDamping(TUNE.angularDamping)
    .setCcdEnabled(true)
    .setCanSleep(false);
  const body = world.createRigidBody(bodyDesc);

  const c = TUNE.chassis;
  const colDesc = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz)
    .setMass(c.mass)
    .setTranslation(0, c.comY, 0) // lower the box (and thus CoM) to resist flipping
    .setFriction(0.4);
  const collider = world.createCollider(colDesc, body);
  carColliderHandles.add(collider.handle);

  const v = world.createVehicleController(body);
  const W = TUNE.wheel;
  const conns = [
    { x: -W.x, z: W.zFront }, { x: W.x, z: W.zFront },   // front (steered)
    { x: -W.x, z: W.zRear }, { x: W.x, z: W.zRear },     // rear (driven)
  ];
  for (const cn of conns) {
    v.addWheel({ x: cn.x, y: W.y, z: cn.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, W.restLength, W.radius);
  }
  const S = TUNE.suspension;
  for (let i = 0; i < 4; i++) {
    v.setWheelSuspensionStiffness(i, S.stiffness);
    v.setWheelSuspensionCompression(i, S.compression);
    v.setWheelSuspensionRelaxation(i, S.relaxation);
    v.setWheelMaxSuspensionTravel(i, S.maxTravel);
    v.setWheelMaxSuspensionForce(i, S.maxForce);
    v.setWheelFrictionSlip(i, TUNE.frictionSlip);
    v.setWheelSideFrictionStiffness(i, TUNE.sideFrictionStiffness);
  }

  cars.set(id, { body, vehicle: v, colliderHandle: collider.handle });
}

export function removeCar(id) {
  const c = cars.get(id);
  if (!c || !world) return;
  carColliderHandles.delete(c.colliderHandle);
  try { world.removeVehicleController(c.vehicle); } catch (e) {}
  try { world.removeRigidBody(c.body); } catch (e) {}
  cars.delete(id);
}

export function resetCars() {
  for (const id of [...cars.keys()]) removeCar(id);
}

// Wheels only raycast against static geometry, never other cars' chassis.
const wheelRayFilter = (collider) => !carColliderHandles.has(collider.handle);

const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _vel = new THREE.Vector3();

export function applyControls(id, input, dt, parked = false) {
  const c = cars.get(id);
  if (!c) return;
  const { body, vehicle } = c;

  const rot = body.rotation();
  _q.set(rot.x, rot.y, rot.z, rot.w);
  _fwd.set(0, 0, 1).applyQuaternion(_q);
  const lv = body.linvel();
  _vel.set(lv.x, lv.y, lv.z);
  const fwdSpeed = _vel.dot(_fwd);
  const absSpd = Math.abs(fwdSpeed);

  const steer = Math.max(-1, Math.min(1, input.steer || 0));
  const brake = Math.max(0, Math.min(1, input.brake || 0));

  // speed-sensitive steering
  const steerAngle = steer * TUNE.maxSteer * (1 - Math.min(absSpd / 60, TUNE.steerSpeedFalloff));
  vehicle.setWheelSteering(0, steerAngle);
  vehicle.setWheelSteering(1, steerAngle);

  let engine = 0, brk = 0;
  if (parked) {
    brk = TUNE.brakeForce; // hold still on the grid — no reverse
  } else if (brake > 0.05) {
    if (fwdSpeed > 0.5) { brk = TUNE.brakeForce * brake; }
    else { engine = -TUNE.reverseForce * brake; } // reverse from a stop
  } else {
    engine = fwdSpeed < TUNE.topSpeed ? TUNE.engineForce : 0; // auto-accelerate
  }
  vehicle.setWheelEngineForce(2, engine);
  vehicle.setWheelEngineForce(3, engine);
  // Front brake bias: rears braked less so braking + turning doesn't snap the
  // back end around (anti-spin).
  vehicle.setWheelBrake(0, brk);
  vehicle.setWheelBrake(1, brk);
  vehicle.setWheelBrake(2, brk * 0.5);
  vehicle.setWheelBrake(3, brk * 0.5);

  vehicle.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, wheelRayFilter);
}

export function step(dt) {
  if (!world) return;
  world.timestep = Math.min(Math.max(dt, 1 / 120), 1 / 30);
  world.step();
}

export function getState(id) {
  const c = cars.get(id);
  if (!c) return null;
  const t = c.body.translation();
  const r = c.body.rotation();
  const lv = c.body.linvel();
  _q.set(r.x, r.y, r.z, r.w);
  _fwd.set(0, 0, 1).applyQuaternion(_q);
  _side.set(1, 0, 0).applyQuaternion(_q);
  _vel.set(lv.x, lv.y, lv.z);
  return {
    x: t.x, y: t.y, z: t.z,
    qx: r.x, qy: r.y, qz: r.z, qw: r.w,
    forwardSpeed: _vel.dot(_fwd),
    lateralSpeed: _vel.dot(_side),
  };
}
