// Keep rendered poses separate from the fixed-step simulation. Both the car
// and its follow camera use this same interpolated pose.
function pose(p) {
  return {
    x: p.pos.x,
    y: p.groundY,
    z: p.pos.z,
    heading: p.heading,
    travelHeading: p.travelHeading ?? p.heading,
    surfaceY: p.surfaceY ?? p.groundY,
    shadowSlopePitch: p.shadowSlopePitch || 0,
    pitch: p.pitch || 0,
    roll: p.roll || 0,
    wheelSpin: p.wheelSpin || 0,
    steer: p.steerSmooth,
  };
}

export function resetMotion(p) {
  p.previousPose = pose(p);
  p.roadPose = null;
}

export function savePreviousPose(p) {
  Object.assign(p.previousPose, pose(p));
}

export function renderCar(p, alpha, track, dt = 1 / 60) {
  const previous = p.previousPose;
  const mix = (a, b) => a + (b - a) * alpha;
  p.mesh.position.set(
    mix(previous.x, p.pos.x),
    mix(previous.y, p.groundY),
    mix(previous.z, p.pos.z),
  );
  // Simulation headings are continuous, including across full turns.
  let pitch = mix(previous.pitch, p.pitch),
    roll = mix(previous.roll, p.roll);
  p.mesh.rotation.set(pitch, mix(previous.heading, p.heading), roll);
  p.renderTravelHeading = mix(previous.travelHeading, p.travelHeading ?? p.heading);
  const contact = track?.surfaceInfo ? groundCar(p, track, dt) : null;
  if (contact) {
    pitch = p.mesh.rotation.x;
    roll = p.mesh.rotation.z;
  }
  const shadow = p.mesh.userData.groundShadow;
  if (shadow) {
    // Cancel body pitch and roll while keeping the shadow on the road slope.
    // This prevents the plane from cutting through the road as the car leans.
    const roadPitch = contact?.pitch ?? mix(previous.shadowSlopePitch, p.shadowSlopePitch || 0);
    shadow.rotation.set(roadPitch - pitch - Math.PI / 2, 0, (contact?.roll || 0) - roll);
    shadow.position.y =
      (contact?.groundY ?? mix(previous.surfaceY, p.surfaceY ?? p.groundY)) -
      p.mesh.position.y +
      0.06 -
      0.2 * Math.sin(pitch);
  }
  p.renderSteer = mix(previous.steer, p.steerSmooth);
  const wheels = p.mesh.userData.wheels || [];
  const wheelRadius = wheels[0]?.userData.radius || 0.55;
  for (let i = 0; i < wheels.length; i++) {
    (wheels[i].userData.spin || wheels[i]).rotation.x = mix(
      previous.wheelSpin,
      p.wheelSpin,
    ) * wheelRadius / (wheels[i].userData.radius || wheelRadius);
    if (i < 2) wheels[i].rotation.y = p.renderSteer * 0.4;
  }
  if (contact) groundWheels(p, track);
}

function groundCar(p, track, dt) {
  const pos = p.mesh.position, heading = p.mesh.rotation.y;
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const sample = (x, z) => track.surfaceInfo({ x, z }, p.sampleIndex);
  const groundY = sample(pos.x, pos.z).groundY;
  // Fit the chassis to its footprint, rather than snapping its centre to each
  // triangle. Tire contact remains exact and independent of body suspension.
  const corner = (forward, side) => sample(
    pos.x + fx * forward + fz * side,
    pos.z + fz * forward - fx * side,
  ).groundY;
  const fl = corner(1.4, -1), fr = corner(1.4, 1);
  const rl = corner(-1.4, -1), rr = corner(-1.4, 1);
  const front = (fl + fr) / 2, rear = (rl + rr) / 2;
  const right = (fr + rr) / 2, left = (fl + rl) / 2;
  const pitch = -Math.atan2(front - rear, 2.8);
  const roll = Math.atan2(right - left, 2);
  const height = (front + rear) / 2 + 0.015;
  if (!p.roadPose) {
    p.roadPose = { height, pitch, roll, heightVelocity: 0, pitchVelocity: 0,
      rollVelocity: 0, previousHeight: height };
  } else if (dt > 0) {
    const state = p.roadPose;
    // Track a moving height target without accumulating uphill lag. A
    // critically damped response absorbs joins and crests without oscillation.
    const targetVelocity = (height - state.previousHeight) / dt;
    const error = state.height - state.previousHeight;
    const relativeVelocity = state.heightVelocity - targetVelocity;
    const decay = Math.exp(-14 * dt);
    const change = relativeVelocity + 14 * error;
    state.height = height + (error + change * dt) * decay;
    state.heightVelocity = targetVelocity + (relativeVelocity - 14 * change * dt) * decay;
    state.previousHeight = height;
    for (const [key, target] of [['pitch', pitch], ['roll', roll]]) {
      const velocity = key + 'Velocity';
      const error = state[key] - target;
      const change = state[velocity] + 12 * error;
      const decay = Math.exp(-12 * dt);
      state[key] = target + (error + change * dt) * decay;
      state[velocity] = (state[velocity] - 12 * change * dt) * decay;
    }
  }
  pos.y = p.roadPose.height;
  p.mesh.rotation.x = p.roadPose.pitch;
  p.mesh.rotation.z += p.roadPose.roll;
  return { groundY, pitch, roll };
}

function groundWheels(p, track) {
  const point = p.wheelContactPoint ||= p.pos.clone();
  for (const wheel of p.mesh.userData.wheels || []) {
    wheel.userData.restY ??= wheel.position.y;
    wheel.position.y = wheel.userData.restY;
    // Two passes account for the tiny lateral displacement caused by moving
    // suspension along a tilted chassis. Spin and steering keep their pivots.
    for (let pass = 0; pass < 2; pass++) {
      wheel.getWorldPosition(point);
      const surface = track.surfaceInfo(point, p.sampleIndex);
      const m = wheel.matrixWorld.elements;
      const length = Math.hypot(m[0], m[1], m[2]);
      const dot = (m[0] * surface.normalX + m[1] * surface.normalY + m[2] * surface.normalZ) / length;
      const radius = wheel.userData.radius || 0.55;
      const halfWidth = wheel.userData.halfWidth || 0.25;
      const support = radius * Math.sqrt(Math.max(0, 1 - dot * dot)) + halfWidth * Math.abs(dot);
      const target = surface.groundY + (support + 0.012) / surface.normalY;
      wheel.position.y += (target - point.y) / wheel.parent.matrixWorld.elements[5];
    }
  }
}
