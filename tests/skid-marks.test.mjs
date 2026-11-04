import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'public/js/skid-marks.js'), 'utf8').replace(
  "from 'three'",
  `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`,
);
const { createSkidMarks } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
function system() {
  globalThis.document = { createElement: () => ({ getContext: () => ({
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
  }) }) };
  return createSkidMarks({ nearestInfo: p => ({ groundY: p.x * 0.03 + p.z * 0.1 }) });
}

test('tire trails join through a turn and stay on the road at both edges', () => {
  const marks = system(), player = {};
  marks.emit(player, 2, 0, 1, 0, 1, 1);
  marks.emit(player, 2, 0.4, 2, 0.4, 1, 1);
  const positions = marks.mesh.geometry.attributes.position.array;
  assert.deepEqual(positions.slice(6, 12), positions.slice(12, 18), 'adjacent strips share their complete edge');
  for (let i = 0; i < 24; i += 3) {
    assert.ok(Math.abs(positions[i + 1] - (positions[i] * 0.03 + positions[i + 2] * 0.1 + 0.055)) < 1e-6);
  }
  const width = Math.hypot(positions[0] - positions[3], positions[2] - positions[5]);
  assert.ok(Math.abs(width - 0.32) < 1e-6, 'mark stays tire-width');
  player.skidContacts = null;
  marks.emit(player, 2, 20, 30, 0, 0.5, 0.6);
  assert.ok(positions[26] > 29, 'new braking event does not connect across the coasting gap');
});

test('separate tires and players do not join trails, and old rubber fades before clearing', () => {
  const marks = system(), a = {}, b = {};
  marks.emit(a, 2, -1, 1, 0, 1, 1);
  marks.emit(a, 3, 1, 1, 0, 1, 1);
  marks.emit(b, 2, 8, 10, 0, 1, 0.5);
  const geometry = marks.mesh.geometry;
  const positions = geometry.attributes.position.array;
  assert.ok(positions[12] > 0 && positions[24] > 7);
  const colors = geometry.attributes.color.array;
  const original = colors[11];
  marks.update(30);
  assert.ok(colors[11] > 0 && colors[11] < original);
  marks.update(10);
  for (let i = 3; i < 48; i += 4) assert.equal(colors[i], 0);
  marks.clear();
  assert.equal(geometry.drawRange.count, 0);
});
