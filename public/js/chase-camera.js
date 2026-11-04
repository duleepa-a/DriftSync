export function updateChaseCamera(p, snap, dt, maxSpeed) {
  const pos = p.mesh.position;
  const targetHeading = p.renderTravelHeading ?? p.mesh.rotation.y;
  if (snap || !Number.isFinite(p.cameraHeading)) {
    p.cameraHeading = p.mesh.rotation.y;
  } else {
    // Follow the route gradually, independently of steering input and body yaw.
    const difference = Math.atan2(
      Math.sin(targetHeading - p.cameraHeading),
      Math.cos(targetHeading - p.cameraHeading),
    );
    p.cameraHeading += difference * (1 - Math.exp(-dt * 3));
  }
  const fx = Math.sin(p.cameraHeading), fz = Math.cos(p.cameraHeading);
  const back = 4.8 + (p.nitroVisual || 0) * 0.6;
  const height = pos.y + 1.65;
  p.camPos.x = pos.x - fx * back;
  p.camPos.z = pos.z - fz * back;
  // The chassis already smooths terrain motion. Keep the camera and its aim
  // on that same vertical anchor so crests do not change the framing.
  p.camPos.y = height;
  p.camera.position.copy(p.camPos);

  const targetFov = 58 + Math.min(Math.abs(p.speed) / maxSpeed, 1) * 5 +
    (p.nitroVisual || 0) * 5;
  p.camera.fov += (targetFov - p.camera.fov) *
    (snap ? 1 : 1 - Math.pow(0.92, dt * 60));
  p.camera.lookAt(pos.x + fx * 3.5, pos.y + 0.45, pos.z + fz * 3.5);
}
