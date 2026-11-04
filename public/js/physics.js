import * as THREE from 'three';
import { NITRO } from './nitro.js';

export const PHYS = {
  maxSpeed: 46,
  accel: 26,
  dragK: 0.004,
  coastDecel: 0.89408, // 2 mph per second, expressed in m/s².
  brakeDecel: 55,
  reverseAccel: 16,
  reverseMax: -12,
  turnRate: 1.0,
  maxYawRate: 1.7,
  frontFriction: 1,
  rearFriction: 1,
  driftRearFriction: 0.16,
  driftEnterSpeed: 10,
  driftExitSpeed: 7,
  driftEnterAngle: 0.12,
  driftExitAngle: 0.055,
  driftBrakeScale: 0.2,
  wallScrub: 0.86,
  gears: 8,
  idleRpm: 4000,
  redline: 15000,
};

const ahead = new THREE.Vector3();
const skid = new THREE.Vector3();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const DRIVE_MODE = { TRACTION: 'traction', DRIFT: 'drift' };

export function resetHandling(p) {
  p.velocity ||= new THREE.Vector3();
  p.localVelocity ||= new THREE.Vector3();
  p.velocity.set(Math.sin(p.heading) * p.speed, 0, Math.cos(p.heading) * p.speed);
  p.velocitySign = Math.sign(p.speed);
  p.travelHeading = p.heading;
  p.yawRate = 0;
  p.slipAngle = 0;
  p.frontFriction = PHYS.frontFriction;
  p.rearFriction = PHYS.rearFriction;
  p.driveMode = DRIVE_MODE.TRACTION;
  p.drift = 0;
  readLocalVelocity(p);
}

function readLocalVelocity(p) {
  const sin = Math.sin(p.heading), cos = Math.cos(p.heading);
  p.localVelocity.set(
    cos * p.velocity.x - sin * p.velocity.z,
    0,
    sin * p.velocity.x + cos * p.velocity.z,
  );
  p.slipAngle = p.velocity.lengthSq() > 0.0025
    ? Math.atan2(p.localVelocity.x, p.localVelocity.z) : 0;
}

function syncVelocity(p) {
  const magnitude = p.velocity.length();
  if (magnitude < 1e-6 || Math.sign(p.speed) !== p.velocitySign) {
    p.velocity.set(Math.sin(p.heading) * p.speed, 0, Math.cos(p.heading) * p.speed);
  } else {
    // Keep collision impulses and the existing signed speed controls in sync.
    p.velocity.multiplyScalar(Math.abs(p.speed) / magnitude);
  }
  p.velocitySign = Math.sign(p.speed);
}

function updateHandling(p, dt, steer, brake) {
  const speed = Math.abs(p.speed);
  const turning = Math.abs(p.input.steer || 0) > 0.1;
  // Integrate axle forces in small steps, including on slower display frames.
  const steps = Math.max(1, Math.ceil(dt * 120));
  const step = dt / steps;
  for (let i = 0; i < steps; i++) {
    readLocalVelocity(p);
    const slip = Math.abs(p.slipAngle);
    const counterSteering = p.speed > PHYS.driftExitSpeed && slip > 0.08 &&
      steer * p.slipAngle > 0;
    const brakeTurn = p.speed > PHYS.driftEnterSpeed && turning && brake > 0.08 && !counterSteering;

    // Hysteresis prevents rapid mode changes at the edge of grip.
    if (p.driveMode === DRIVE_MODE.DRIFT) {
      if (!turning || p.speed < PHYS.driftExitSpeed ||
          (slip < PHYS.driftExitAngle && brake < 0.08)) p.driveMode = DRIVE_MODE.TRACTION;
    } else if (turning && p.speed > PHYS.driftEnterSpeed &&
        slip > PHYS.driftEnterAngle && (brake > 0.08 || slip > 0.24)) {
      p.driveMode = DRIVE_MODE.DRIFT;
    }
    const sliding = p.driveMode === DRIVE_MODE.DRIFT;
    const release = brakeTurn || sliding
      ? Math.max(brake, sliding ? clamp(slip / 0.45, 0.65, 1) : 0) : 0;
    let rearTarget = PHYS.rearFriction -
      (PHYS.rearFriction - PHYS.driftRearFriction) * release;
    if (counterSteering) rearTarget = Math.max(rearTarget, 0.5);
    rearTarget = Math.max(rearTarget, clamp((slip - 0.4) / 0.5, 0, 0.7));
    const gripRate = rearTarget < p.rearFriction ? 10 : 3;
    p.rearFriction += (rearTarget - p.rearFriction) * (1 - Math.exp(-step * gripRate));
    p.frontFriction = PHYS.frontFriction;
    p.drift = (PHYS.rearFriction - p.rearFriction) /
      (PHYS.rearFriction - PHYS.driftRearFriction);

    const rollingGrip = clamp(speed / 6, 0, 1);
    const understeer = 1 - clamp((speed - 30) / 90, 0, 0.4);
    const requestedYaw = steer * PHYS.turnRate * rollingGrip * understeer;
    if (p.speed <= 4) {
      // Avoid unstable tire-slip division near rest and preserve reverse steering.
      p.yawRate += (requestedYaw * Math.sign(p.speed) - p.yawRate) * (1 - Math.exp(-step * 12));
      p.heading += p.yawRate * step;
      p.velocity.set(Math.sin(p.heading) * p.speed, 0, Math.cos(p.heading) * p.speed);
      continue;
    }

    const axle = 1.4;
    const steerAngle = Math.atan(requestedYaw * axle * 2 / Math.max(speed, 5));
    const forward = Math.max(4, p.localVelocity.z);
    const frontSlip = Math.atan2(p.localVelocity.x + p.yawRate * axle, forward) - steerAngle;
    const rearSlip = Math.atan2(p.localVelocity.x - p.yawRate * axle, forward);
    // Axle lateral accelerations: front bite stays high while braking unloads
    // rear grip. The force imbalance creates oversteer and chassis yaw.
    const frontForce = -p.frontFriction * 48 * Math.tanh(frontSlip * 115 / 48);
    const rearForce = -p.rearFriction * 48 * Math.tanh(rearSlip * 115 / 48);
    const counterTorque = counterSteering ? steer * slip * 18 : 0;
    const spinRecovery = p.slipAngle * 40 * clamp((slip - 0.25) / 0.3, 0, 1);
    const yawTorque = (frontForce - rearForce) * axle / 2.8 +
      counterTorque + spinRecovery - p.yawRate * 0.8;
    p.yawRate = clamp(p.yawRate + yawTorque * step, -PHYS.maxYawRate, PHYS.maxYawRate);

    const lateral = frontForce * Math.cos(steerAngle) + rearForce;
    const longitudinal = -frontForce * Math.sin(steerAngle);
    const sin = Math.sin(p.heading), cos = Math.cos(p.heading);
    p.velocity.x += (cos * lateral + sin * longitudinal) * step;
    p.velocity.z += (-sin * lateral + cos * longitudinal) * step;
    // Treat tire forces as directional grip. Longitudinal braking/engine forces
    // own speed loss, so initiating a slide does not erase forward momentum.
    p.velocity.setLength(speed);
    p.heading += p.yawRate * step;
  }
  readLocalVelocity(p);
  const velocityHeading = Math.atan2(p.velocity.x, p.velocity.z) + (p.speed < 0 ? Math.PI : 0);
  if (speed > 0.05) {
    p.travelHeading += Math.atan2(Math.sin(velocityHeading - p.travelHeading), Math.cos(velocityHeading - p.travelHeading));
  }
}

export function updateCar(
  p,
  dt,
  track,
  { dropSkid, onGate, autoAccelerate = true },
) {
  if (p.finished) return;
  if (!p.velocity) resetHandling(p);
  syncVelocity(p);
  readLocalVelocity(p);
  const inp = p.input;
  p.steerSmooth +=
    (clamp(inp.steer, -1, 1) - p.steerSmooth) * Math.min(1, dt * 12);
  const steer = p.steerSmooth;
  const brake = clamp(inp.brake || 0, 0, 1);
  const throttle = autoAccelerate ? 1 : clamp(inp.throttle || 0, 0, 1);
  if (brake > 0.02 || p.finished) p.nitroTime = 0;
  const boosting = (p.nitroTime || 0) > 0 && p.speed >= 0;
  p.nitroTime = Math.max(0, (p.nitroTime || 0) - dt);
  const speedLimit = boosting ? NITRO.maxSpeed : PHYS.maxSpeed;

  if (brake > 0.02) {
    const brakeTurn = Math.abs(inp.steer || 0) > 0.1 && p.speed > PHYS.driftEnterSpeed;
    const slideBraking = p.speed > PHYS.driftExitSpeed &&
      (brakeTurn || p.driveMode === DRIVE_MODE.DRIFT);
    if (p.speed > 0.2) p.speed -= PHYS.brakeDecel * brake * dt *
      (slideBraking ? PHYS.driftBrakeScale : 1);
    else p.speed -= PHYS.reverseAccel * brake * dt;
  } else if (throttle <= 0.02) {
    // Released accelerator: a steady 2 mph/s loss, without crossing zero.
    const decel = PHYS.coastDecel * dt;
    p.speed = Math.sign(p.speed) * Math.max(0, Math.abs(p.speed) - decel);
  } else if (p.speed <= speedLimit) {
    const drag = PHYS.dragK * p.speed * Math.abs(p.speed);
    p.speed = Math.min(
      speedLimit,
      p.speed +
        ((PHYS.accel + (boosting ? NITRO.extraAccel : 0)) * throttle - drag) *
          dt,
    );
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

  syncVelocity(p);
  updateHandling(p, dt, steer, brake);

  const fx = Math.sin(p.heading),
    fz = Math.cos(p.heading);
  const previousX = p.pos.x,
    previousZ = p.pos.z;
  p.pos.x += p.velocity.x * dt;
  p.pos.z += p.velocity.z * dt;

  const info = track.nearestInfo(p.pos, p.sampleIndex);
  p.sampleIndex = info.index;
  const maxOff = track.halfWidth - 1.4;
  let hitWall = false;
  if (info.offset > maxOff) {
    const c = info.offset - maxOff;
    p.pos.x -= info.nx * c;
    p.pos.z -= info.nz * c;
    hitWall = true;
  } else if (info.offset < -maxOff) {
    const c = info.offset + maxOff;
    p.pos.x -= info.nx * c;
    p.pos.z -= info.nz * c;
    hitWall = true;
  }
  if (hitWall && !p.offTrack) {
    p.speed *= PHYS.wallScrub;
    syncVelocity(p);
  }
  p.offTrack = hitWall;

  const corneringLoad = Math.abs(steer) * sp;
  const lockup = brake > 0.5 && sp > 12;
  const wallImpact = hitWall && sp > 14;
  const drifting = Math.abs(p.slipAngle) > 0.1 && p.speed > PHYS.driftExitSpeed &&
    (p.driveMode === DRIVE_MODE.DRIFT || p.rearFriction < 0.9);
  p.squeal = corneringLoad > 24 || lockup || drifting;
  p.skidding = lockup || wallImpact || drifting;

  const groundY = info.groundY;
  p.surfaceY = groundY;
  // Interpolation handles visual smoothing; lagging behind rising terrain
  // lets the road overtake the wheels at speed.
  p.groundY = groundY;
  const aheadInfo = track.nearestInfo(
    ahead.set(p.pos.x + fx * 5, 0, p.pos.z + fz * 5),
    p.sampleIndex,
  );
  const slopePitch = -Math.atan2(aheadInfo.groundY - groundY, 5);
  p.shadowSlopePitch = slopePitch;
  p.prevSpeed = p.speed;
  // Follow the road slope without rocking under acceleration or braking.
  const pitch = clamp(slopePitch, -0.3, 0.3);
  p.pitch = pitch;
  p.roll = 0;
  p.mesh.position.set(p.pos.x, p.groundY, p.pos.z);
  p.mesh.rotation.set(pitch, p.heading, 0);

  const wheels = p.mesh.userData.wheels || [];
  const wheelRadius = wheels[0]?.userData.radius || 0.55;
  const wroll = p.speed * dt / wheelRadius;
  p.wheelSpin = (p.wheelSpin || 0) + wroll;
  for (let i = 0; i < wheels.length; i++) {
    (wheels[i].userData.spin || wheels[i]).rotation.x =
      p.wheelSpin * wheelRadius / (wheels[i].userData.radius || wheelRadius);
    if (i < 2) wheels[i].rotation.y = steer * 0.4;
  }
  if (p.skidding && wheels.length >= 4) {
    for (const wi of [2, 3]) {
      wheels[wi].getWorldPosition(skid);
      dropSkid(
        p, wi, skid.x, skid.z,
        p.pos.x - previousX, p.pos.z - previousZ,
        clamp((lockup ? brake : 0.55) * sp / 32, 0.2, 1),
      );
    }
  } else {
    p.skidContacts = null;
  }
  onGate(p, previousX, previousZ);
}
