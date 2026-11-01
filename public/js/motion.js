// Keep rendered poses separate from the fixed-step simulation. Both the car
// and its follow camera use this same interpolated pose.
function pose(p) {
  return {
    x: p.pos.x, y: p.groundY, z: p.pos.z, heading: p.heading,
    surfaceY: p.surfaceY ?? p.groundY, shadowSlopePitch: p.shadowSlopePitch || 0,
    pitch: p.pitch || 0, roll: p.roll || 0,
    wheelSpin: p.wheelSpin || 0, steer: p.steerSmooth,
  };
}

export function resetMotion(p) {
  p.previousPose = pose(p);
}

export function savePreviousPose(p) {
  Object.assign(p.previousPose, pose(p));
}

export function renderCar(p, alpha) {
  const previous = p.previousPose;
  const mix = (a, b) => a + (b - a) * alpha;
  p.mesh.position.set(mix(previous.x, p.pos.x), mix(previous.y, p.groundY), mix(previous.z, p.pos.z));
  // Simulation headings are continuous, including across full turns.
  const pitch = mix(previous.pitch, p.pitch), roll = mix(previous.roll, p.roll);
  p.mesh.rotation.set(pitch, mix(previous.heading, p.heading), roll);
  const shadow = p.mesh.userData.groundShadow;
  if (shadow) {
    // Cancel body pitch and roll while keeping the shadow on the road slope.
    // This prevents the plane from cutting through the road as the car leans.
    const roadPitch = mix(previous.shadowSlopePitch, p.shadowSlopePitch || 0);
    shadow.rotation.set(roadPitch - pitch - Math.PI / 2, 0, -roll);
    shadow.position.y = mix(previous.surfaceY, p.surfaceY ?? p.groundY)
      - p.mesh.position.y + 0.06 - 0.2 * Math.sin(pitch);
  }
  p.renderSteer = mix(previous.steer, p.steerSmooth);
  const wheels = p.mesh.userData.wheels || [];
  for (let i = 0; i < wheels.length; i++) {
    (wheels[i].userData.spin || wheels[i]).rotation.x = mix(previous.wheelSpin, p.wheelSpin);
    if (i < 2) wheels[i].rotation.y = p.renderSteer * 0.4;
  }
}
