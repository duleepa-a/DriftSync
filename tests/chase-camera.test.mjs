import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

const source = readFileSync(new URL('../public/js/chase-camera.js', import.meta.url), 'utf8');
const { updateChaseCamera } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
function player() {
  return { mesh: new THREE.Group(), camera: new THREE.PerspectiveCamera(),
    camPos: new THREE.Vector3(), speed: 30, renderTravelHeading: 0 };
}

test('steering and drift body rotation do not swing the camera away from the travel direction', () => {
  const p = player();
  updateChaseCamera(p, true, 1 / 60, 46);
  const direction = p.camera.getWorldDirection(new THREE.Vector3());
  p.mesh.rotation.y = 0.5;
  p.renderSteer = 1;
  p.mesh.position.z = 3;
  updateChaseCamera(p, false, 1 / 60, 46);
  assert.equal(p.camPos.x, 0);
  assert.ok(Math.abs(p.camPos.z - (3 - 4.8)) < 1e-9);
  assert.ok(p.camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-9);
});

test('camera eases into a new route consistently across frame rates and handles angle wrapping', () => {
  const headings = [];
  for (const hz of [30, 60, 120]) {
    const p = player();
    p.mesh.rotation.y = Math.PI - 0.05;
    updateChaseCamera(p, true, 1 / hz, 46);
    p.renderTravelHeading = -Math.PI + 0.4;
    updateChaseCamera(p, false, 1 / hz, 46);
    assert.ok(p.cameraHeading > Math.PI - 0.05 && p.cameraHeading < Math.PI + 0.4);
    for (let i = 1; i < hz; i++) updateChaseCamera(p, false, 1 / hz, 46);
    headings.push(p.cameraHeading);
    assert.ok(Math.abs(Math.hypot(p.camPos.x, p.camPos.z) - 4.8) < 1e-9);
    p.mesh.rotation.y = 0;
    updateChaseCamera(p, true, 1 / hz, 46);
    assert.equal(p.cameraHeading, 0, 'restart snaps behind the new starting pose');
  }
  assert.ok(Math.max(...headings) - Math.min(...headings) < 1e-9);
});

test('camera framing stays steady as the suspended car moves over a slope', () => {
  const p = player();
  updateChaseCamera(p, true, 1 / 60, 46);
  const direction = p.camera.getWorldDirection(new THREE.Vector3());
  for (const height of [0.02, 0.06, 0.12, 0.2, 0.28, 0.3, 0.28, 0.24, 0.18]) {
    p.mesh.position.y = height;
    p.mesh.position.z += 0.7;
    updateChaseCamera(p, false, 1 / 60, 46);
    assert.ok(Math.abs(p.camPos.y - height - 1.65) < 1e-9);
    assert.ok(p.camera.getWorldDirection(new THREE.Vector3()).distanceTo(direction) < 1e-9,
      'camera height and aim must follow the same smoothed anchor');
  }
});
