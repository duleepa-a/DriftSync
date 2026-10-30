import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dirname, '../public/js/race.js'), 'utf8');
const { advanceGates, recordFinish, allPlayersFinished, rankings } = await import(`data:text/javascript,${encodeURIComponent(source)}`);

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

test('a race waits for every finisher and records each result once in crossing order', () => {
  const players = [0, 1, 2].map(id => ({ id, name: `Player ${id}`, lap: 3, finished: false, topSpeed: 46, bestLapTime: 25000 }));
  const results = [];
  assert.equal(allPlayersFinished(players), false);
  assert.equal(recordFinish(players[1], results, 79000), true);
  assert.equal(allPlayersFinished(players), false);
  assert.equal(recordFinish(players[1], results, 99999), false);
  assert.equal(players[1].finishTime, 79000);
  assert.equal(recordFinish(players[0], results, 81000), true);
  assert.equal(allPlayersFinished(players), false);
  assert.equal(recordFinish(players[2], results, 85000), true);
  assert.equal(allPlayersFinished(players.values()), true);
  assert.deepEqual(results.map(p => p.id), [1, 0, 2]);
  assert.deepEqual(rankings(players, []).map(p => p.finishRank), [1, 2, 3]);
  players[1].topSpeed = 0;
  assert.equal(results[0].topSpeed, 46, 'recorded statistics must remain frozen');
});

test('departures do not reuse finishing places, and single-player finishes normally', () => {
  const winner = { id: 'a', lap: 3 }, runner = { id: 'b', lap: 2 }, last = { id: 'c', lap: 3 };
  const results = [];
  assert.equal(recordFinish(runner, results, 50000), false, 'all three laps are required');
  recordFinish(winner, results, 80000);
  recordFinish(last, results, 85000); // Winner may already have disconnected.
  assert.equal(last.finishRank, 2);
  assert.equal(allPlayersFinished([last, runner]), false);
  assert.equal(allPlayersFinished([last]), true, 'an unfinished departure must not block remaining finishers');
  assert.equal(allPlayersFinished([]), false);
  const solo = { id: 'solo', lap: 3 };
  recordFinish(solo, [], 90000);
  assert.equal(solo.finishRank, 1);
  assert.equal(allPlayersFinished([solo]), true);
});
