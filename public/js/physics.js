import * as THREE from 'three';
import { NITRO } from './nitro.js';

export const PHYS = {
  maxSpeed: 46,
  accel: 26,
  dragK: 0.004,
  brakeDecel: 55,
  reverseAccel: 16,
  reverseMax: -12,
  turnRate: 2.0,
  wallScrub: 0.86,
  gears: 8,
  idleRpm: 4000,
  redline: 15000,
};

const ahead = new THREE.Vector3();
const skid = new THREE.Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function updateCar(p, dt, track, { dropSkid, onGate }) {
  if (p.finished) return;
  const inp = p.input;
  p.steerSmooth += (clamp(inp.steer, -1, 1) - p.steerSmooth) * Math.min(1, dt * 12);
  const steer = p.steerSmooth;
  const brake = clamp(inp.brake || 0, 0, 1);
  if (brake > 0.02 || p.finished) p.nitroTime = 0;
  const boosting = (p.nitroTime || 0) > 0 && p.speed >= 0;
  p.nitroTime = Math.max(0, (p.nitroTime || 0) - dt);
  const speedLimit = boosting ? NITRO.maxSpeed : PHYS.maxSpeed;

  if (brake > 0.02) {
    if (p.speed > 0.2) p.speed -= PHYS.brakeDecel * brake * dt;
    else p.speed -= PHYS.reverseAccel * brake * dt;
  } else if (p.speed <= speedLimit) {
    const drag = PHYS.dragK * p.speed * Math.abs(p.speed);
    p.speed = Math.min(speedLimit, p.speed + (PHYS.accel + (boosting ? NITRO.extraAccel : 0) - drag) * dt);
  } else {
    // Let boost speed bleed off smoothly instead of snapping to the normal cap.
    p.speed = Math.max(speedLimit, p.speed - NITRO.coastDecel * dt);
  }
  p.speed = clamp(p.speed, PHYS.reverseMax, NITRO.maxSpeed);
  const sp = Math.abs(p.speed);

  const gearSpan = PHYS.maxSpeed / PHYS.gears;
  const gear = Math.min(PHYS.gears - 1, Math.max(0, Math.floor(sp / gearSpan)));
  const within = clamp((sp - gear * gearSpan) / gearSpan, 0, 1);
  p.rpm = PHYS.idleRpm + within * (PHYS.redline - PHYS.idleRpm);
  if (gear > p.gear) p.shiftPulse = 1;
  p.gear = gear;

  const rollingGrip = clamp(sp / 6, 0, 1);
  const understeer = 1 - clamp((sp - 30) / 90, 0, 0.4);
  const lockAuthority = brake > 0.7 ? 0.6 : 1;
  const dir = p.speed >= 0 ? 1 : -1;
  p.heading += steer * PHYS.turnRate * rollingGrip * understeer * lockAuthority * dir * dt;

  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  const previousX = p.pos.x, previousZ = p.pos.z;
  p.pos.x += fx * p.speed * dt;
  p.pos.z += fz * p.speed * dt;

  const info = track.nearestInfo(p.pos, p.sampleIndex);
  p.sampleIndex = info.index;
  const maxOff = track.halfWidth - 1.4;
  let hitWall = false;
  if (info.offset > maxOff) { const c = info.offset - maxOff; p.pos.x -= info.nx * c; p.pos.z -= info.nz * c; hitWall = true; }
  else if (info.offset < -maxOff) { const c = info.offset + maxOff; p.pos.x -= info.nx * c; p.pos.z -= info.nz * c; hitWall = true; }
  if (hitWall && !p.offTrack) p.speed *= PHYS.wallScrub;
  p.offTrack = hitWall;

  const corneringLoad = Math.abs(steer) * sp;
  const lockup = brake > 0.5 && sp > 12;
  const wallImpact = hitWall && sp > 14;
  p.squeal = corneringLoad > 24 || lockup;
  p.skidding = lockup || wallImpact;

  const groundY = info.groundY;
  p.surfaceY = groundY;
  p.groundY += (groundY - p.groundY) * Math.min(1, dt * 9);
  const aheadInfo = track.nearestInfo(ahead.set(p.pos.x + fx * 5, 0, p.pos.z + fz * 5), p.sampleIndex);
  const slopePitch = -Math.atan2(aheadInfo.groundY - groundY, 5);
  p.shadowSlopePitch = slopePitch;
  const accelEst = (p.speed - p.prevSpeed) / Math.max(dt, 1e-3);
  p.prevSpeed = p.speed;
  const pitch = clamp(slopePitch + clamp(-accelEst * 0.004, -0.05, 0.05), -0.3, 0.3);
  const bodyRoll = clamp(steer * sp * 0.0016, -0.06, 0.06);
  p.pitch = pitch;
  p.roll = -bodyRoll;
  p.mesh.position.set(p.pos.x, p.groundY, p.pos.z);
  p.mesh.rotation.set(pitch, p.heading, -bodyRoll);

  const wheels = p.mesh.userData.wheels || [];
  const wroll = p.speed * dt * 1.8;
  p.wheelSpin = (p.wheelSpin || 0) + wroll;
  for (let i = 0; i < wheels.length; i++) {
    (wheels[i].userData.spin || wheels[i]).rotation.x = p.wheelSpin;
    if (i < 2) wheels[i].rotation.y = steer * 0.4;
  }
  if (p.skidding && wheels.length >= 4) {
    for (const wi of [2, 3]) { wheels[wi].getWorldPosition(skid); dropSkid(skid.x, skid.z, p.heading, p.groundY); }
  }
  onGate(p, previousX, previousZ);
}
