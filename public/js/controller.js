/* global io */
/**
 * Phone controller — button steering.
 *  - LEFT / RIGHT steer, BRAKE slows down (and reverses from a stop).
 *  - The host selects automatic acceleration or manual pedals for the room.
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
  acceleratorBtn: document.getElementById('acceleratorBtn'),
  autoHint: document.getElementById('autoHint'),
  placeBadge: document.getElementById('placeBadge'),
  lapBadge: document.getElementById('lapBadge'),
  speedBadge: document.getElementById('speedBadge'),
  fullscreenPrompt: document.getElementById('fullscreenPrompt'),
  fullscreenMessage: document.getElementById('fullscreenMessage'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  lostBanner: document.getElementById('lostBanner'),
};

const input = { steer: 0, brake: 0, throttle: 0 };
const held = { left: false, right: false, brake: false, throttle: false };
const pointers = {
  left: new Set(),
  right: new Set(),
  brake: new Set(),
  throttle: new Set(),
};
let autoAccelerate = true;
let joined = false;
let joinPending = false;
let fullscreenAttempted = false;

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
if (params.get('room')) els.codeInput.value = params.get('room').toUpperCase();

els.joinBtn.addEventListener('click', doJoin);
els.codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoin();
});

function doJoin() {
  if (joinPending || !socket.connected) {
    if (!socket.connected)
      els.joinError.textContent = 'Connecting to game server…';
    return;
  }
  const code = els.codeInput.value.trim().toUpperCase();
  const name = els.nameInput.value.trim();
  if (code.length < 4) {
    els.joinError.textContent = 'Enter the four-character code.';
    return;
  }
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
    applySettings(res.settings);
    els.lostBanner.classList.add('hidden');
    document.documentElement.style.setProperty('--mycolor', res.color);
    els.placeBadge.textContent = 'P' + (res.slot + 1);
    socket.emit('ctrl:ready', true);
    showController();
    if (res.started) showFullscreenPrompt();
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
  try {
    if (screen.orientation && screen.orientation.lock) {
      const result = screen.orientation.lock('landscape');
      if (result && result.catch) result.catch(() => {});
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Buttons (pointer events; multi-touch friendly)
// ---------------------------------------------------------------------------
bindButton(els.leftBtn, 'left');
bindButton(els.rightBtn, 'right');
bindButton(els.brakeBtn, 'brake');
bindButton(els.acceleratorBtn, 'throttle');

function bindButton(el, key) {
  const down = (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    pointers[key].add(e.pointerId);
    fromKeys();
    buzz(8);
  };
  const up = (e) => {
    e.preventDefault();
    pointers[key].delete(e.pointerId);
    fromKeys();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}

function recompute() {
  // LEFT button steers left, RIGHT steers right.
  input.steer = (held.left ? 1 : 0) - (held.right ? 1 : 0);
  input.brake = held.brake ? 1 : 0;
  input.throttle = !autoAccelerate && held.throttle ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Keyboard fallback
// ---------------------------------------------------------------------------
const keys = {};
window.addEventListener('keydown', (e) => {
  if (!joined) return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key))
    e.preventDefault();
  keys[e.key.toLowerCase()] = true;
  fromKeys();
});
window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
  fromKeys();
});
function fromKeys() {
  held.left = !!(pointers.left.size || keys['arrowleft'] || keys['a']);
  held.right = !!(pointers.right.size || keys['arrowright'] || keys['d']);
  held.brake = !!(
    pointers.brake.size ||
    keys['arrowdown'] ||
    keys['s'] ||
    keys[' ']
  );
  held.throttle =
    !autoAccelerate &&
    !!(pointers.throttle.size || keys['arrowup'] || keys['w']);
  els.leftBtn.classList.toggle('pressed', held.left);
  els.rightBtn.classList.toggle('pressed', held.right);
  els.brakeBtn.classList.toggle('pressed', held.brake);
  els.acceleratorBtn.classList.toggle('pressed', held.throttle);
  recompute();
}

function clearInput() {
  for (const key of Object.keys(keys)) delete keys[key];
  for (const touches of Object.values(pointers)) touches.clear();
  fromKeys();
  if (joined && socket.connected) socket.emit('ctrl:input', input);
}

function applySettings(settings) {
  autoAccelerate = settings?.autoAccelerate !== false;
  els.controller.classList.toggle('manual', !autoAccelerate);
  els.acceleratorBtn.classList.toggle('hidden', autoAccelerate);
  els.autoHint.textContent = autoAccelerate
    ? 'Auto-accelerating · steer left / right · hold BRAKE to slow / reverse'
    : 'Manual · hold ACCEL to drive · release to coast · hold BRAKE to slow / reverse';
  clearInput();
}
socket.on('game:settings', applySettings);
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInput();
});

// ---------------------------------------------------------------------------
// Send loop
// ---------------------------------------------------------------------------
setInterval(() => {
  if (joined) socket.emit('ctrl:input', input);
}, 40);

// ---------------------------------------------------------------------------
// Feedback from host
// ---------------------------------------------------------------------------
let lastBuzz = 0;
socket.on('ctrl:feedback', (fb) => {
  if (fb.place) els.placeBadge.textContent = ordinal(fb.place);
  if (fb.lap) els.lapBadge.textContent = `Lap ${fb.lap}/${fb.totalLaps || 3}`;
  if (typeof fb.speed === 'number')
    els.speedBadge.textContent = `${fb.speed} mph`;
  if (fb.vibrate && Date.now() - lastBuzz > 220) {
    buzz(fb.vibrate);
    lastBuzz = Date.now();
  }
});

// A socket event has no user activation, so browsers reject fullscreen there.
// Present a button; its tap supplies the required gesture.
socket.on('game:start', (settings) => {
  applySettings(settings);
  showFullscreenPrompt();
});
socket.on('game:reset', (settings) => {
  applySettings(settings);
  els.fullscreenPrompt.classList.add('hidden');
});

socket.on('host:gone', () => {
  els.lostBanner.classList.remove('hidden');
  joined = false;
  clearInput();
});
socket.on('disconnect', () => {
  clearInput();
  joinPending = false;
  els.joinBtn.disabled = false;
  els.lostBanner.classList.remove('hidden');
});

function showFullscreenPrompt() {
  fullscreenAttempted = false;
  const supported = !!(
    document.documentElement.requestFullscreen ||
    document.documentElement.webkitRequestFullscreen
  );
  els.fullscreenMessage.textContent = supported
    ? 'The race is starting. Tap to use the full screen.'
    : 'This browser cannot make the page fullscreen. Add it to your Home Screen for a larger view, or continue playing.';
  els.fullscreenBtn.textContent = supported
    ? 'Play fullscreen'
    : 'Continue playing';
  els.fullscreenPrompt.classList.remove('hidden');
}

els.fullscreenBtn.addEventListener('click', async () => {
  if (fullscreenAttempted) {
    els.fullscreenPrompt.classList.add('hidden');
    return;
  }
  const supported = !!(
    document.documentElement.requestFullscreen ||
    document.documentElement.webkitRequestFullscreen
  );
  if (!supported) {
    els.fullscreenPrompt.classList.add('hidden');
    return;
  }
  fullscreenAttempted = true;
  if (await goFullscreen()) {
    els.fullscreenPrompt.classList.add('hidden');
  } else {
    els.fullscreenMessage.textContent =
      'Fullscreen was blocked by this browser. You can still play.';
    els.fullscreenBtn.textContent = 'Continue playing';
  }
});

async function goFullscreen() {
  const el = document.documentElement;
  try {
    const request = (el.requestFullscreen || el.webkitRequestFullscreen).call(
      el,
    );
    if (request && request.then) await request;
    lockLandscape();
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ordinal(n) {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th';
}
function buzz(ms) {
  if (navigator.vibrate)
    try {
      navigator.vibrate(ms);
    } catch (e) {}
}
