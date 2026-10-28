import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const root = resolve(import.meta.dirname, '..');
const trackSource = readFileSync(resolve(root, 'public/js/track.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`);
const { buildTrack } = await import(`data:text/javascript,${encodeURIComponent(trackSource)}`);
const physicsSource = readFileSync(resolve(root, 'public/js/physics.js'), 'utf8')
  .replace("from 'three'", `from '${pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js'))}'`);
const { updateCar } = await import(`data:text/javascript,${encodeURIComponent(physicsSource)}`);

test('default driving launches and stays within the real track', () => {
  const context = new Proxy({}, { get: () => () => {} });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
  const track = buildTrack(new THREE.Scene());

  for (const spawn of track.startPositions) {
    const player = {
      input: { steer: 0, brake: 0 },
      steerSmooth: 0, speed: 0, prevSpeed: 0, gear: 0,
      pos: spawn.pos.clone(), heading: spawn.heading,
      sampleIndex: 0, groundY: spawn.pos.y, offTrack: false,
      mesh: { position: { set() {} }, rotation: { set() {} }, userData: { wheels: [] } },
    };
    for (let frame = 0; frame < 600; frame++) {
      updateCar(player, 1 / 60, track, { dropSkid: () => {}, onGate: () => {} });
      const road = track.nearestInfo(player.pos);
      assert.ok(Number.isFinite(player.speed) && road.dist < track.halfWidth + 2,
        `car left road after ${frame / 60}s: ${JSON.stringify({ pos: player.pos, speed: player.speed, distance: road.dist })}`);
      if (frame === 59) assert.ok(player.speed > 8, `slow launch: ${player.speed.toFixed(1)} m/s`);
    }
  }
});
