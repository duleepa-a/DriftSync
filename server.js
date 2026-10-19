/**
 * Tilt Racer - local multiplayer car game server.
 *
 * Responsibilities:
 *  - Serve the host (game) page and the controller (phone) page.
 *  - Serve the three.js module so the game works offline (no CDN needed).
 *  - Manage "rooms": one host (laptop) + up to 4 controllers (phones).
 *  - Relay controller input to the host with minimal overhead.
 *
 * The host is authoritative: it runs all physics/rendering. Phones only
 * send input and receive small feedback events (vibration, etc.).
 */

const path = require('path');
const http = require('http');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;

// Per-slot identity. Index 0..3 map to player 1..4.
const PLAYER_COLORS = ['#ff4757', '#1e90ff', '#2ed573', '#ffa502']; // red, blue, green, orange
const PLAYER_NAMES = ['Red', 'Blue', 'Green', 'Orange'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Allow controllers from any device on the LAN. Same-origin in practice,
  // but be permissive so phones never get blocked.
  cors: { origin: '*' },
});

// --- Static assets -------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
// Serve three.js straight from node_modules so there is no build step and
// no dependency on an internet connection at play time.
app.use('/lib', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
// Addon loaders (GLTFLoader, DRACOLoader, RGBELoader) + the Draco decoder.
app.use('/jsm', express.static(path.join(__dirname, 'node_modules', 'three', 'examples', 'jsm')));
// Rapier physics (compat build with inlined WASM).
app.use('/rapier', express.static(path.join(__dirname, 'node_modules', '@dimforge', 'rapier3d-compat')));

// QR code as a PNG. The host page points this at the controller join URL.
app.get('/qr', async (req, res) => {
  const text = String(req.query.text || '');
  if (!text) return res.status(400).send('missing text');
  try {
    const png = await QRCode.toBuffer(text, {
      type: 'png',
      width: 320,
      margin: 1,
      color: { dark: '#0b1020', light: '#ffffff' },
    });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).send('qr error');
  }
});

// --- Rooms ---------------------------------------------------------------
/** code -> { hostId, started, players: Map<socketId, player> } */
const rooms = new Map();

// Score a network interface so we prefer the real Wi-Fi/Ethernet adapter and
// avoid virtual ones (VirtualBox, VMware, WSL, Hyper-V, Docker), which phones
// on the Wi-Fi network cannot reach.
function scoreIface(name, addr) {
  let s = 0;
  const n = name.toLowerCase();
  if (/wi-?fi|wlan|wireless/.test(n)) s += 100;
  else if (/ethernet|^eth|^en\d|lan/.test(n)) s += 60;
  if (/virtual|vbox|vmware|hyper-v|vethernet|wsl|docker|default switch|loopback/.test(n)) s -= 300;
  if (addr.startsWith('192.168.56.')) s -= 200; // VirtualBox host-only default
  if (addr.startsWith('169.254.')) s -= 100;    // link-local / APIPA
  if (addr.startsWith('192.168.')) s += 20;
  else if (addr.startsWith('10.')) s += 12;
  else if (addr.startsWith('172.')) s += 6;
  return s;
}

function lanCandidates() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      out.push({ name, address: net.address, score: scoreIface(name, net.address) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function lanIp() {
  if (process.env.HOST_IP) return process.env.HOST_IP; // manual override
  const c = lanCandidates();
  return (c[0] && c[0].address) || 'localhost';
}

function makeCode() {
  // Unambiguous characters only (no O/0/I/1).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(code));
  return code;
}

function roomPlayers(room) {
  return [...room.players.values()].sort((a, b) => a.slot - b.slot);
}

io.on('connection', (socket) => {
  // ---- Host (laptop) creates a room ----
  socket.on('host:create', (_payload, cb) => {
    const code = makeCode();
    rooms.set(code, { hostId: socket.id, started: false, players: new Map() });
    socket.join(code);
    socket.data.role = 'host';
    socket.data.code = code;

    const ip = lanIp();
    const url = `http://${ip}:${PORT}/controller.html?room=${code}`;
    // Offer every usable address so the user can switch if the default is wrong.
    const addresses = [ip, ...lanCandidates().map((c) => c.address)]
      .filter((a, i, arr) => arr.indexOf(a) === i);
    if (typeof cb === 'function') cb({ code, url, ip, port: PORT, addresses });
  });

  // Host can (re)broadcast a request for current players (e.g. after reload).
  socket.on('host:roster', (_p, cb) => {
    const room = rooms.get(socket.data.code);
    if (typeof cb === 'function') cb(room ? roomPlayers(room) : []);
  });

  // ---- Controller (phone) joins a room ----
  socket.on('ctrl:join', (payload, cb) => {
    const code = String((payload && payload.code) || '').toUpperCase().trim();
    const name = (payload && payload.name) || '';
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: 'Game not found. Check the code.' });
    if (room.players.size >= MAX_PLAYERS) return cb && cb({ ok: false, error: 'Game is full (4 players).' });

    const used = new Set(roomPlayers(room).map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;

    const player = {
      id: socket.id,
      slot,
      color: PLAYER_COLORS[slot],
      name: name || PLAYER_NAMES[slot],
      ready: false,
    };
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.role = 'ctrl';
    socket.data.code = code;
    socket.data.slot = slot;

    io.to(room.hostId).emit('player:join', player);
    if (cb) cb({ ok: true, slot, color: player.color, name: player.name, started: room.started });
  });

  // ---- Controller -> Host: input (high frequency) ----
  socket.on('ctrl:input', (input) => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    io.to(room.hostId).emit('player:input', { id: socket.id, slot: socket.data.slot, input });
  });

  // ---- Controller -> Host: ready toggle / name change ----
  socket.on('ctrl:ready', (ready) => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) p.ready = !!ready;
    io.to(room.hostId).emit('player:ready', { id: socket.id, slot: socket.data.slot, ready: !!ready });
  });

  // ---- Host -> Controller: feedback (vibration, status) ----
  socket.on('host:feedback', ({ id, ...fb }) => {
    if (id) io.to(id).emit('ctrl:feedback', fb);
  });

  // ---- Host starts / resets the game ----
  socket.on('host:start', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    room.started = true;
    io.to(socket.data.code).emit('game:start');
  });
  socket.on('host:reset', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    room.started = false;
    io.to(socket.data.code).emit('game:reset');
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room) return;
    if (socket.data.role === 'host') {
      io.to(code).emit('host:gone');
      rooms.delete(code);
    } else {
      room.players.delete(socket.id);
      io.to(room.hostId).emit('player:leave', { id: socket.id, slot: socket.data.slot });
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = lanIp();
  console.log('\n  🏎  Tilt Racer is running!\n');
  console.log(`  On this laptop, open:   http://localhost:${PORT}`);
  console.log(`  Phones join via QR, or: http://${ip}:${PORT}/controller.html`);
  console.log('\n  (Phones must be on the same Wi-Fi. Allow Node through the firewall if prompted.)\n');
});
