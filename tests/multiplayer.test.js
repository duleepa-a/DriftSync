const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 31000 + Math.floor(Math.random() * 10000);

function client() {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
  );
  const messages = [];
  const waiting = [];
  ws.addEventListener('message', ({ data }) => {
    const packet = String(data);
    if (packet === '2') {
      ws.send('3');
      return;
    }
    const index = waiting.findIndex(({ matches }) => matches(packet));
    if (index === -1) messages.push(packet);
    else waiting.splice(index, 1)[0].resolve(packet);
  });
  const next = (matches, timeoutMs = 3000) => {
    const index = messages.findIndex(matches);
    if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { matches, resolve };
      waiting.push(entry);
      setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at !== -1) {
          waiting.splice(at, 1);
          reject(new Error('Socket.IO packet timed out'));
        }
      }, timeoutMs).unref();
    });
  };
  return {
    ws,
    next,
    emit: (name, value, ack) =>
      ws.send(`42${ack || ''}${JSON.stringify([name, value])}`),
  };
}

test('two controllers and a late join get separate slots and input routes', async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const clients = [];
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Burnout is running')) resolve();
      });
      server.once('exit', (code) =>
        reject(new Error(`server exited: ${code}`)),
      );
    });
    async function open() {
      const c = client();
      clients.push(c);
      await c.next((p) => p.startsWith('0'));
      c.ws.send('40');
      await c.next((p) => p.startsWith('40'));
      return c;
    }
    const host = await open();
    host.emit('host:create', {}, 1);
    const room = JSON.parse(
      (await host.next((p) => p.startsWith('431'))).slice(3),
    )[0];
    assert.deepEqual(room.settings, { autoAccelerate: true });
    const first = await open();
    first.emit('ctrl:join', { code: room.code }, 1);
    const firstJoin = JSON.parse(
      (await first.next((p) => p.startsWith('431'))).slice(3),
    )[0];
    const second = await open();
    second.emit('ctrl:join', { code: room.code }, 1);
    const secondJoin = JSON.parse(
      (await second.next((p) => p.startsWith('431'))).slice(3),
    )[0];
    await host.next((p) => p.startsWith('42["player:join"'));
    const secondPlayer = JSON.parse(
      (await host.next((p) => p.startsWith('42["player:join"'))).slice(2),
    )[1];
    assert.equal(firstJoin.slot, 0);
    assert.equal(secondJoin.slot, 1);
    assert.equal(firstJoin.name, 'Player 1');
    assert.equal(secondJoin.name, 'Player 2');
    assert.deepEqual(firstJoin.settings, room.settings);
    assert.deepEqual(secondJoin.settings, room.settings);
    first.emit('ctrl:input', { steer: 1, brake: 0 });
    second.emit('ctrl:input', { steer: -1, brake: 1 });
    const inputs = [];
    for (let i = 0; i < 2; i++) {
      inputs.push(
        JSON.parse(
          (await host.next((p) => p.startsWith('42["player:input"'))).slice(2),
        )[1],
      );
    }
    assert.deepEqual(
      inputs.map((p) => [p.slot, p.input.steer, p.input.brake]).sort(),
      [
        [0, 1, 0],
        [1, -1, 1],
      ],
    );
    first.emit('host:start', {});
    first.emit('host:reset', {});
    first.emit('host:feedback', { id: secondPlayer.id, vibrate: 100 });
    await assert.rejects(host.next((p) => p.startsWith('42["game:'), 150));
    await assert.rejects(
      second.next((p) => p.startsWith('42["ctrl:feedback"'), 150),
    );
    first.emit('ctrl:input', { steer: 99, brake: -2 });
    const clamped = JSON.parse(
      (await host.next((p) => p.startsWith('42["player:input"'))).slice(2),
    )[1];
    assert.deepEqual(clamped.input, { steer: 1, brake: 0, throttle: 0 });
    first.emit('ctrl:input', { steer: 'left', brake: 0 });
    await assert.rejects(
      host.next((p) => p.startsWith('42["player:input"'), 150),
    );
    const ack = async (c, event, value) => {
      c.emit(event, value, 2);
      return JSON.parse((await c.next((p) => p.startsWith('432'))).slice(3))[0];
    };
    const event = async (c, name) =>
      JSON.parse(
        (await c.next((p) => p.startsWith(`42["${name}"`))).slice(2),
      )[1];
    assert.equal(
      (await ack(first, 'host:settings', { autoAccelerate: false })).ok,
      false,
    );
    assert.equal(
      (await ack(host, 'host:settings', { autoAccelerate: 'false' })).ok,
      false,
    );
    await assert.rejects(
      second.next((p) => p.startsWith('42["game:settings"'), 150),
    );
    assert.equal(
      (await ack(host, 'host:settings', { autoAccelerate: false })).ok,
      true,
    );
    for (const c of [host, first, second])
      assert.deepEqual(await event(c, 'game:settings'), {
        autoAccelerate: false,
      });
    first.emit('ctrl:input', { steer: 0, brake: 0, throttle: 5 });
    assert.deepEqual((await event(host, 'player:input')).input, {
      steer: 0,
      brake: 0,
      throttle: 1,
    });
    second.emit('ctrl:input', { steer: -1, brake: 0, throttle: -2 });
    assert.deepEqual((await event(host, 'player:input')).input, {
      steer: -1,
      brake: 0,
      throttle: 0,
    });
    first.emit('ctrl:input', { steer: 0, brake: 0, throttle: 'fast' });
    await assert.rejects(
      host.next((p) => p.startsWith('42["player:input"'), 150),
    );
    host.emit('host:start', {});
    for (const c of [host, first, second])
      assert.deepEqual(await event(c, 'game:start'), { autoAccelerate: false });
    const locked = await ack(host, 'host:settings', { autoAccelerate: true });
    assert.equal(locked.ok, false);
    assert.deepEqual(locked.settings, { autoAccelerate: false });
    const late = await open();
    late.emit('ctrl:join', { code: room.code }, 1);
    const lateJoin = JSON.parse(
      (await late.next((p) => p.startsWith('431'))).slice(3),
    )[0];
    assert.equal(lateJoin.slot, 2);
    assert.equal(lateJoin.name, 'Player 3');
    assert.equal(lateJoin.started, true);
    assert.deepEqual(lateJoin.settings, { autoAccelerate: false });
    const repeatJoin = await ack(first, 'ctrl:join', { code: room.code });
    assert.deepEqual(repeatJoin.settings, { autoAccelerate: false });
    host.emit('host:reset', {});
    for (const c of [host, first, second, late])
      assert.deepEqual(await event(c, 'game:reset'), { autoAccelerate: false });
    assert.equal(
      (await ack(host, 'host:settings', { autoAccelerate: true })).ok,
      true,
    );
    for (const c of [host, first, second, late])
      assert.deepEqual(await event(c, 'game:settings'), {
        autoAccelerate: true,
      });
    const otherHost = await open();
    const otherRoom = await ack(otherHost, 'host:create', {});
    assert.deepEqual(otherRoom.settings, { autoAccelerate: true });
    assert.equal(
      (await ack(host, 'host:settings', { autoAccelerate: false })).ok,
      true,
    );
    await assert.rejects(
      otherHost.next((p) => p.startsWith('42["game:settings"'), 150),
    );
  } finally {
    clients.forEach(({ ws }) => ws.close());
    server.kill();
  }
});
