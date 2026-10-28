/* global io */
/**
 * Phone controller — button steering.
 *  - LEFT / RIGHT steer, BRAKE slows down (and reverses from a stop).
 *  - The car accelerates automatically, so there is no gas button.
 *  - Keyboard fallback (arrows / A,D, Down/Space) for testing on a laptop.
 *  - Sends input ~25x/sec; receives feedback (vibrate, place, lap, speed).
 */

const socket = io();

const els = {
  join: document.getElementById('join'),
  controller: document.getElementById('controller'),
  codeInput: document.getElementById('codeInput'),
  nameInput: document.getElementById('nameInput'),
  joinBtn: document.getElementById('joinBtn'),
  joinError: document.getElementById('joinError'),
  leftBtn: document.getElementById('leftBtn'),
  rightBtn: document.getElementById('rightBtn'),
  brakeBtn: document.getElementById('brakeBtn'),
  placeBadge: document.getElementById('placeBadge'),
  lapBadge: document.getElementById('lapBadge'),
  speedBadge: document.getElementById('speedBadge'),
  lostBanner: document.getElementById('lostBanner'),
};

const input = { steer: 0, brake: 0 };
const held = { left: false, right: false, brake: false };
let joined = false;
let pendingFullscreen = false;
let joinPending = false;

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
if (params.get('room')) els.codeInput.value = params.get('room').toUpperCase();

els.joinBtn.addEventListener('click', doJoin);
els.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  if (joinPending || !socket.connected) {
    if (!socket.connected) els.joinError.textContent = 'Connecting to game server…';
    return;
  }
  const code = els.codeInput.value.trim().toUpperCase();
  const name = els.nameInput.value.trim();
  if (code.length < 4) { els.joinError.textContent = 'Enter the 4-letter code.'; return; }
  els.joinError.textContent = '';
  joinPending = true;
  els.joinBtn.disabled = true;
  socket.emit('ctrl:join', { code, name }, (res) => {
    joinPending = false;
    els.joinBtn.disabled = false;
    if (!res || !res.ok) {
      joined = false;
      els.controller.classList.add('hidden');
      els.join.classList.remove('hidden');
      els.joinError.textContent = (res && res.error) || 'Could not join.';
      return;
    }
    joined = true;
    els.lostBanner.classList.add('hidden');
    document.documentElement.style.setProperty('--mycolor', res.color);
    els.placeBadge.textContent = 'P' + (res.slot + 1);
    socket.emit('ctrl:ready', true);
    showController();
  });
}

socket.on('connect', () => {
  // Socket.IO creates a new socket ID after a network interruption. The old
  // player record and room membership cannot be used by this connection.
  if (joined) doJoin();
});

function showController() {
  els.join.classList.add('hidden');
  els.controller.classList.remove('hidden');
  lockLandscape();
}

function lockLandscape() {
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Buttons (pointer events; multi-touch friendly)
// ---------------------------------------------------------------------------
bindButton(els.leftBtn, 'left');
bindButton(els.rightBtn, 'right');
bindButton(els.brakeBtn, 'brake');

function bindButton(el, key) {
  const down = (e) => {
    e.preventDefault();
    if (pendingFullscreen) { goFullscreen(); pendingFullscreen = false; }
    held[key] = true; el.classList.add('pressed'); recompute(); buzz(8);
  };
  const up = (e) => { e.preventDefault(); held[key] = false; el.classList.remove('pressed'); recompute(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
}

function recompute() {
  // LEFT button steers left, RIGHT steers right.
  input.steer = (held.left ? 1 : 0) - (held.right ? 1 : 0);
  input.brake = held.brake ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Keyboard fallback
// ---------------------------------------------------------------------------
const keys = {};
window.addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; fromKeys(); });
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; fromKeys(); });
function fromKeys() {
  // Keyboard is laptop-only; apply directly (phones never fire key events).
  held.left = !!(keys['arrowleft'] || keys['a']);
  held.right = !!(keys['arrowright'] || keys['d']);
  held.brake = !!(keys['arrowdown'] || keys['s'] || keys[' ']);
  els.leftBtn.classList.toggle('pressed', held.left);
  els.rightBtn.classList.toggle('pressed', held.right);
  els.brakeBtn.classList.toggle('pressed', held.brake);
  recompute();
}

// ---------------------------------------------------------------------------
// Send loop
// ---------------------------------------------------------------------------
setInterval(() => { if (joined) socket.emit('ctrl:input', input); }, 40);

// ---------------------------------------------------------------------------
// Feedback from host
// ---------------------------------------------------------------------------
let lastBuzz = 0;
socket.on('ctrl:feedback', (fb) => {
  if (fb.place) els.placeBadge.textContent = ordinal(fb.place);
  if (fb.lap) els.lapBadge.textContent = `Lap ${fb.lap}/${fb.totalLaps || 3}`;
  if (typeof fb.speed === 'number') els.speedBadge.textContent = `${fb.speed} mph`;
  if (fb.vibrate && Date.now() - lastBuzz > 220) { buzz(fb.vibrate); lastBuzz = Date.now(); }
});

// Race started: go fullscreen on the player's next touch (gesture required).
socket.on('game:start', () => { pendingFullscreen = true; goFullscreen(); });

socket.on('host:gone', () => { els.lostBanner.classList.remove('hidden'); joined = false; });
socket.on('disconnect', () => {
  joinPending = false;
  els.joinBtn.disabled = false;
  els.lostBanner.classList.remove('hidden');
});

function goFullscreen() {
  const el = document.documentElement;
  try {
    const request = (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    if (request && request.catch) request.catch(() => {});
  } catch (e) {}
  lockLandscape();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ordinal(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'; }
function buzz(ms) { if (navigator.vibrate) try { navigator.vibrate(ms); } catch (e) {} }
