const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const port = 31000 + Math.floor(Math.random() * 10000);

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  const messages = [];
  const waiting = [];
  ws.addEventListener('message', ({ data }) => {
    const packet = String(data);
    if (packet === '2') { ws.send('3'); return; }
    const index = waiting.findIndex(({ matches }) => matches(packet));
    if (index === -1) messages.push(packet);
    else waiting.splice(index, 1)[0].resolve(packet);
  });
  const next = (matches) => {
    const index = messages.findIndex(matches);
    if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const entry = { matches, resolve };
      waiting.push(entry);
      setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at !== -1) { waiting.splice(at, 1); reject(new Error('Socket.IO packet timed out')); }
      }, 3000).unref();
    });
  };
  return { ws, next, emit: (name, value, ack) => ws.send(`42${ack || ''}${JSON.stringify([name, value])}`) };
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
      server.stdout.on('data', (chunk) => { if (String(chunk).includes('Tilt Racer is running')) resolve(); });
      server.once('exit', (code) => reject(new Error(`server exited: ${code}`)));
    });
    async function open() {
      const c = client(); clients.push(c);
      await c.next((p) => p.startsWith('0'));
      c.ws.send('40');
      await c.next((p) => p.startsWith('40'));
      return c;
    }
    const host = await open();
    host.emit('host:create', {}, 1);
    const room = JSON.parse((await host.next((p) => p.startsWith('431'))).slice(3))[0];
    const first = await open();
    first.emit('ctrl:join', { code: room.code }, 1);
    const firstJoin = JSON.parse((await first.next((p) => p.startsWith('431'))).slice(3))[0];
    const second = await open();
    second.emit('ctrl:join', { code: room.code }, 1);
    const secondJoin = JSON.parse((await second.next((p) => p.startsWith('431'))).slice(3))[0];
    assert.equal(firstJoin.slot, 0);
    assert.equal(secondJoin.slot, 1);
    first.emit('ctrl:input', { steer: 1, brake: 0 });
    second.emit('ctrl:input', { steer: -1, brake: 1 });
    const inputs = [];
    for (let i = 0; i < 2; i++) {
      inputs.push(JSON.parse((await host.next((p) => p.startsWith('42["player:input"'))).slice(2))[1]);
    }
    assert.deepEqual(inputs.map((p) => [p.slot, p.input.steer, p.input.brake]).sort(),
      [[0, 1, 0], [1, -1, 1]]);
    host.emit('host:start', {});
    const late = await open();
    late.emit('ctrl:join', { code: room.code }, 1);
    const lateJoin = JSON.parse((await late.next((p) => p.startsWith('431'))).slice(3))[0];
    assert.equal(lateJoin.slot, 2);
    assert.equal(lateJoin.started, true);
  } finally {
    clients.forEach(({ ws }) => ws.close());
    server.kill();
  }
});
