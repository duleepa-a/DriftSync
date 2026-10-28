import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../public/js/race.js'), 'utf8');
const { advanceGates } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

test('a lap gate counts only a forward crossing in sequence', () => {
  const gates = [
    { pos: { x: 0, z: 0 }, tangent: { x: 1, z: 0 } },
    { pos: { x: 50, z: 0 }, tangent: { x: 1, z: 0 } },
  ];
  const player = {
    pos: { x: 1, z: 0 }, nextGate: 1, gatesPassed: 0, lap: 0, finished: false,
  };

  assert.equal(advanceGates(player, gates, 2, 0), false);
  assert.equal(player.gatesPassed, 0);
  player.pos.x = 49;
  assert.equal(advanceGates(player, gates, 51, 0), false);
  player.pos.x = 51;
  assert.equal(advanceGates(player, gates, 49, 0), false);
  assert.equal(player.gatesPassed, 1);
  assert.equal(player.nextGate, 0);
  player.pos.x = 1;
  assert.equal(advanceGates(player, gates, -1, 0), false);
  assert.equal(player.lap, 1);
});
