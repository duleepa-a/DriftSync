import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildTrack } from './track.js';
import { createSunsetSky } from './sky.js';
import { createCarMesh, disposeCarMesh, loadCarAssets } from './carmesh.js';
import { updateCarEffects } from './car-effects.js';
import * as audio from './audio.js';
import { PHYS, updateCar } from './physics.js';
import { resetMotion, savePreviousPose, renderCar } from './motion.js';
import { NITRO, createNitroPickups, resetNitroPickups, updateNitroPickups } from './nitro.js';
import { createNitroVisuals } from './nitro-visuals.js';
import { TOTAL_LAPS, advanceGates, rankings as rankPlayers } from './race.js';

/* global io */

// ---------------------------------------------------------------------------
// Constants & tuning
// ---------------------------------------------------------------------------
const MPH = 2.23694; // m/s -> mph
const COLLIDE_DIST = 3.6;
const AUDIO_ENABLED = false; // Temporary: keep the host game silent.

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const G = {
  state: 'lobby', // lobby | countdown | racing | results
  players: new Map(), // socketId -> player
  assetsReady: false, // real car model loaded?
  environmentReady: false,
  track: null,
  nitroPickups: [],
  raceStart: 0,
  countdownEnd: 0,
  winnerId: null,
};

// ---------------------------------------------------------------------------
// Three.js setup
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.setClearColor(0x0b1020, 1);
renderer.autoClear = false;

const scene = new THREE.Scene();

// ---------------------------------------------------------------------------
// Post-processing pipeline
//   Scene is rendered (all split-screen viewports) into an HDR off-screen
//   target, then bloom + colour-grade + tone-map are applied once full-screen.
//   Rendering to an off-screen target keeps it linear/HDR; OutputPass does the
//   final ACES tone-map + sRGB to the canvas.
// ---------------------------------------------------------------------------
let POST = true;
const drawingSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const sceneTarget = new THREE.WebGLRenderTarget(drawingSize.x, drawingSize.y, {
  type: THREE.HalfFloatType,
  // Each camera renders into part of this target. Multisample resolves after
  // every render can invalidate the previous camera's pixels on some GPUs.
  samples: 0,
});

const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null }, uSat: { value: 1.14 }, uCon: { value: 1.05 }, uVig: { value: 0.34 },
    uBoost: { value: new THREE.Vector4() }, uPlayers: { value: 1 },
    uTexel: { value: new THREE.Vector2(1 / drawingSize.x, 1 / drawingSize.y) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uSat, uCon, uVig; varying vec2 vUv;
    uniform vec4 uBoost; uniform float uPlayers; uniform vec2 uTexel;
    void main(){
      vec4 t = texture2D(tDiffuse, vUv); vec3 c = t.rgb;
      vec2 origin = vec2(0.0), size = vec2(1.0);
      float boost = uBoost.x;
      if (uPlayers > 1.5) {
        size.y = 0.5;
        bool top = vUv.y >= 0.5;
        origin.y = top ? 0.5 : 0.0;
        boost = top ? uBoost.x : uBoost.y;
        if (uPlayers > 2.5) {
          size.x = 0.5;
          bool right = vUv.x >= 0.5;
          origin.x = right ? 0.5 : 0.0;
          boost = top ? (right ? uBoost.y : uBoost.x) : (right ? uBoost.w : uBoost.z);
        }
      }
      // Radial blur only near this player's edges; keep the car/road centre crisp.
      vec2 local = (vUv - origin) / size;
      float amount = boost * smoothstep(0.22, 0.65, length(local - 0.5));
      if (amount > 0.001) {
        vec2 ray = (local - 0.5) * size * amount * 0.075;
        vec3 sum = c;
        for (int i = 1; i <= 4; i++) {
          vec2 sampleUv = clamp(vUv - ray * (float(i) / 4.0), origin + uTexel, origin + size - uTexel);
          sum += texture2D(tDiffuse, sampleUv).rgb;
        }
        c = sum / 5.0;
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSat);            // saturation
      c = (c - 0.5) * uCon + 0.5;           // contrast
      vec2 d = vUv - 0.5; c *= 1.0 - dot(d, d) * uVig; // vignette
      gl_FragColor = vec4(c, t.a);
    }`,
};

const composer = new EffectComposer(renderer);
composer.addPass(new TexturePass(sceneTarget.texture));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.22,  // strength (subtle)
  0.4,   // radius
  1.15   // threshold — only genuine HDR highlights glow, not white surfaces
);
composer.addPass(bloomPass);
const colorGradePass = new ShaderPass(ColorGradeShader);
composer.addPass(colorGradePass);
composer.addPass(new OutputPass());

// Image-based lighting. Keep a matching sky backdrop, then upgrade reflections
// to the sunset HDRI without introducing its photographed city into the track.
const pmrem = new THREE.PMREMGenerator(renderer);
const skyEquirect = createSunsetSky();
let environmentTarget = pmrem.fromEquirectangular(skyEquirect);
scene.environment = environmentTarget.texture;
scene.background = skyEquirect;

new RGBELoader().load('/assets/venice_sunset_1k.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const nextEnvironment = pmrem.fromEquirectangular(hdr);
  nextEnvironment.texture.name = 'sunset-environment';
  scene.environment = nextEnvironment.texture;
  environmentTarget.dispose();
  environmentTarget = nextEnvironment;
  hdr.dispose();
  pmrem.dispose();
  G.environmentReady = true;
}, undefined, (error) => {
  console.warn('Sunset HDRI failed to load; using the procedural sunset.', error);
  pmrem.dispose();
  G.environmentReady = true;
});

G.track = buildTrack(scene);
G.nitroPickups = createNitroPickups(G.track);
const nitroVisuals = createNitroVisuals(scene, G.nitroPickups);
let nitroVisualTime = 0;
nitroVisuals.update(0);

// Preload the real car model; until it's ready, the Start button waits.
loadCarAssets().then(() => { G.assetsReady = true; updateLobby(); });

// Overview camera for the lobby / attract screen.
const overview = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 2000);
overview.layers.enable(1);

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  renderer.getDrawingBufferSize(drawingSize);
  sceneTarget.setSize(drawingSize.x, drawingSize.y);
  composer.setSize(w, h);
  colorGradePass.uniforms.uTexel.value.set(1 / drawingSize.x, 1 / drawingSize.y);
  layoutHud();
});

// ---------------------------------------------------------------------------
// Player / car management
// ---------------------------------------------------------------------------
function addPlayer(p) {
  if (G.players.has(p.id)) return;
  const player = {
    id: p.id,
    slot: p.slot,
    color: p.color,
    name: p.name,
    ready: p.ready || false,
    input: { steer: 0, throttle: 0, brake: 0 },
    steerSmooth: 0,
    mesh: null,
    camera: new THREE.PerspectiveCamera(62, 1, 0.5, 2000),
    camPos: new THREE.Vector3(),
    pos: new THREE.Vector3(),
    heading: 0,
    groundY: 0,
    speed: 0,
    prevSpeed: 0,
    rpm: 0,
    gear: 0,
    shiftPulse: 0,
    squeal: false,
    skidding: false,
    lap: 0,
    nextGate: 1,
    gatesPassed: 0,
    sampleIndex: 0, // current nearest centerline sample (for off-track checks)
    offTrack: false,
    finished: false,
    finishTime: 0,
    finishRank: 0,
    lastFeedback: 0,
  };
  G.players.set(p.id, player);
  // A controller can join during countdown or a race. It needs a car before
  // the next animation frame, which updates every player in the map.
  if (G.state === 'countdown' || G.state === 'racing') {
    spawnPlayer(player);
    layoutHud();
  }
  updateLobby();
}

function removePlayer(id) {
  const p = G.players.get(id);
  if (p && p.mesh) { scene.remove(p.mesh); disposeCarMesh(p.mesh); }
  audio.stopVoice(id);
  G.players.delete(id);
  if (G.state === 'countdown' || G.state === 'racing') layoutHud();
  updateLobby();
}

function activePlayers() {
  return [...G.players.values()].sort((a, b) => a.slot - b.slot);
}

function spawnCars() {
  resetNitroPickups(G.nitroPickups);
  nitroVisualTime = 0;
  nitroVisuals.update(0);
  activePlayers().forEach(spawnPlayer);
}

function spawnPlayer(p) {
  const grid = G.track.startPositions;
  if (!p.mesh) {
    p.mesh = createCarMesh(p.color);
    p.mesh.rotation.order = 'YXZ'; // yaw, then pitch/roll for weight transfer
    scene.add(p.mesh);
  }
  const g = grid[p.slot % grid.length];
  p.pos.copy(g.pos);
  p.heading = g.heading;
  p.speed = 0;
  p.nitroTime = 0;
  p.nitroVisual = 0;
  p.prevSpeed = 0;
  p.rpm = 0;
  p.gear = 0;
  p.shiftPulse = 0;
  p.lap = 0;
  p.nextGate = 1;
  p.gatesPassed = 0;
  p.finished = false;
  p.finishTime = 0;
  p.finishRank = 0;
  p.input = { steer: 0, throttle: 0, brake: 0 };
  p.steerSmooth = 0;
  p.pitch = 0;
  p.roll = 0;
  p.wheelSpin = 0;
  const ni = G.track.nearestInfo(p.pos, 0);
  p.sampleIndex = ni.index;
  p.groundY = ni.groundY;
  p.mesh.position.set(p.pos.x, p.groundY, p.pos.z);
  p.mesh.rotation.set(0, p.heading, 0);
  resetMotion(p);
  renderCar(p, 1);
  updateCarEffects(p, 0);

  // Snap camera behind the car immediately.
  placeCamera(p, true);
}

// ---------------------------------------------------------------------------
// Race state and collision feedback
// ---------------------------------------------------------------------------
function updateGates(p, previousX, previousZ) {
  if (advanceGates(p, G.track.gates, previousX, previousZ)) finishPlayer(p);
}

function finishPlayer(p) {
  p.finished = true;
  p.finishTime = performance.now() - G.raceStart;
  const alreadyFinished = activePlayers().filter((q) => q.finished && q !== p).length;
  p.finishRank = alreadyFinished + 1;
  if (!G.winnerId) {
    G.winnerId = p.id;
    showBanner(`${p.name} wins!`, 1600);
    const epoch = raceEpoch;
    setTimeout(() => { if (epoch === raceEpoch && G.state === 'racing') endRace(); }, 1700);
  }
}

function handleCollisions() {
  const ps = activePlayers();
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.001 && d < COLLIDE_DIST) {
        const overlap = (COLLIDE_DIST - d) / 2;
        const nx = dx / d, nz = dz / d;
        a.pos.x -= nx * overlap; a.pos.z -= nz * overlap;
        b.pos.x += nx * overlap; b.pos.z += nz * overlap;
        a.speed *= 0.7; b.speed *= 0.7;
        audio.collision();
        feedback(a, { vibrate: 40 });
        feedback(b, { vibrate: 40 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
function rankings() {
  return rankPlayers(activePlayers(), G.track.gates);
}

function placeCamera(p, snap = false, dt = 1 / 60) {
  const pos = p.mesh.position, heading = p.mesh.rotation.y;
  const back = 5.6 + (p.nitroVisual || 0) * 0.6, height = pos.y + 2.5, look = 11;
  const fx = Math.sin(heading), fz = Math.cos(heading);
  const tx = pos.x - fx * back, tz = pos.z - fz * back;

  if (snap) {
    p.camPos.set(tx, height, tz);
  } else {
    // Smooth the *direction* of follow, not the distance.
    const follow = 1 - Math.pow(1 - 0.22, dt * 60);
    p.camPos.x += (tx - p.camPos.x) * follow;
    p.camPos.z += (tz - p.camPos.z) * follow;
    p.camPos.y += (height - p.camPos.y) * (1 - Math.pow(1 - 0.25, dt * 60));
  }
  // Keep distance stable for the current nitro blend, independent of speed lag.
  let dx = p.camPos.x - pos.x, dz = p.camPos.z - pos.z;
  const h = Math.hypot(dx, dz) || 1;
  p.camPos.x = pos.x + (dx / h) * back;
  p.camPos.z = pos.z + (dz / h) * back;

  const sp = Math.abs(p.speed);
  p.camera.position.copy(p.camPos);

  // Gentle dynamic FOV for a sense of speed (small, so the car stays big).
  const targetFov = 60 + Math.min(sp / PHYS.maxSpeed, 1) * 5 + (p.nitroVisual || 0) * 5;
  p.camera.fov += (targetFov - p.camera.fov) * (snap ? 1 : 1 - Math.pow(1 - 0.08, dt * 60));

  // Look slightly into the corner (at the car's elevation).
  const rx = Math.cos(heading), rz = -Math.sin(heading);
  const lead = p.renderSteer * 4;
  p.camera.lookAt(pos.x + fx * look + rx * lead, pos.y + 1.4, pos.z + fz * look + rz * lead);
}

function layoutRects(n) {
  const W = window.innerWidth, H = window.innerHeight;
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H }];
  if (n === 2) return [{ x: 0, y: 0, w: W, h: H / 2 }, { x: 0, y: H / 2, w: W, h: H / 2 }];
  return [
    { x: 0, y: 0, w: W / 2, h: H / 2 },
    { x: W / 2, y: 0, w: W / 2, h: H / 2 },
    { x: 0, y: H / 2, w: W / 2, h: H / 2 },
    { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
  ].slice(0, Math.max(3, n));
}

function renderSplit() {
  const ps = activePlayers();
  colorGradePass.uniforms.uPlayers.value = ps.length;
  colorGradePass.uniforms.uBoost.value.set(...[0, 1, 2, 3].map(i => ps[i]?.nitroVisual || 0));
  bloomPass.enabled = ps.length <= 2;
  const rects = layoutRects(ps.length);
  const H = window.innerHeight;

  if (POST) {
    sceneTarget.viewport.set(0, 0, sceneTarget.width, sceneTarget.height);
    sceneTarget.scissorTest = false;
  }
  renderer.setRenderTarget(POST ? sceneTarget : null);
  renderer.setScissorTest(false);
  renderer.clear();

  const ranks = rankings();
  const pixelRatio = renderer.getPixelRatio();
  ps.forEach((p, i) => {
    const r = rects[i];
    if (!r) return;
    const y = H - r.y - r.h; // convert top-left to bottom-left origin
    if (POST) {
      // Shadow rendering switches render targets. Three.js restores the
      // target's own viewport and scissor when it switches back.
      const x0 = Math.round(r.x * pixelRatio), x1 = Math.round((r.x + r.w) * pixelRatio);
      const y0 = Math.round(y * pixelRatio), y1 = Math.round((y + r.h) * pixelRatio);
      sceneTarget.viewport.set(x0, y0, x1 - x0, y1 - y0);
      sceneTarget.scissor.set(x0, y0, x1 - x0, y1 - y0);
      sceneTarget.scissorTest = true;
      renderer.setRenderTarget(sceneTarget);
    } else {
      renderer.setViewport(r.x, y, r.w, r.h);
      renderer.setScissor(r.x, y, r.w, r.h);
      renderer.setScissorTest(true);
    }
    p.camera.aspect = r.w / r.h;
    p.camera.updateProjectionMatrix();
    renderer.render(scene, p.camera);
  });

  renderer.setScissorTest(false);
  sceneTarget.scissorTest = false;
  presentFrame();

  updateHud(ps, rects, ranks);
}

function renderOverview(t) {
  G.track.sunHelper.update();
  colorGradePass.uniforms.uBoost.value.set(0, 0, 0, 0);
  bloomPass.enabled = true;
  const W = window.innerWidth, H = window.innerHeight;
  if (POST) {
    sceneTarget.viewport.set(0, 0, sceneTarget.width, sceneTarget.height);
    sceneTarget.scissorTest = false;
  }
  renderer.setRenderTarget(POST ? sceneTarget : null);
  renderer.setScissorTest(false);
  renderer.clear();
  if (!POST) renderer.setViewport(0, 0, W, H);
  overview.aspect = W / H;
  overview.updateProjectionMatrix();
  const r = 300, a = t * 0.00008;
  overview.position.set(Math.cos(a) * r, 190, Math.sin(a) * r);
  overview.lookAt(0, 0, 0);
  renderer.render(scene, overview);
  presentFrame();
}

function presentFrame() {
  renderer.setRenderTarget(null);
  // OutputPass uses the canvas viewport, which can still be the last player's
  // rectangle (especially after toggling post-processing). Present the entire
  // composed image, with no depth left over from direct scene rendering.
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  renderer.setScissorTest(false);
  if (POST) {
    renderer.clear();
    composer.render();
  }
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const hud = document.getElementById('hud');
let hudCells = [];

function layoutHud() {
  const ps = activePlayers();
  const rects = layoutRects(ps.length);
  hud.innerHTML = '';
  hudCells = ps.map((p, i) => {
    const r = rects[i];
    const cell = document.createElement('div');
    cell.className = 'hud-cell';
    cell.style.left = r.x + 'px';
    cell.style.top = r.y + 'px';
    cell.style.width = r.w + 'px';
    cell.style.height = r.h + 'px';
    cell.innerHTML = `
      <div class="hud-top">
        <div class="hud-stat left"><span class="lbl">POS</span><span class="num" data-pos>1</span><span class="den" data-posden>|${ps.length}</span></div>
        <div class="hud-driver">
          <div class="hud-name" style="color:${p.color}">${escapeHtml(p.name)}</div>
          <div class="hud-bar"><i data-bar style="background:${p.color}"></i></div>
        </div>
        <div class="hud-stat right"><span class="lbl">LAP</span><span class="num" data-lap>1</span><span class="den">|${TOTAL_LAPS}</span></div>
      </div>
      <div class="hud-nitro hidden" data-nitro>
        <div><strong>NITRO</strong><span data-nitro-time></span></div>
        <div class="nitro-meter"><i data-nitro-bar></i></div>
      </div>
      <div class="hud-speed"><span class="mph" data-mph>0</span><span class="mphlbl">MPH</span></div>`;
    hud.appendChild(cell);
    return {
      pos: cell.querySelector('[data-pos]'),
      posden: cell.querySelector('[data-posden]'),
      lap: cell.querySelector('[data-lap]'),
      bar: cell.querySelector('[data-bar]'),
      mph: cell.querySelector('[data-mph]'),
      nitro: cell.querySelector('[data-nitro]'),
      nitroTime: cell.querySelector('[data-nitro-time]'),
      nitroBar: cell.querySelector('[data-nitro-bar]'),
    };
  });
}

function updateHud(ps, rects, ranks) {
  if (hudCells.length !== ps.length) layoutHud();
  const rankOf = new Map(ranks.map((p, idx) => [p.id, idx + 1]));
  const gateCount = G.track.gates.length;
  ps.forEach((p, i) => {
    const c = hudCells[i];
    if (!c) return;
    c.pos.textContent = rankOf.get(p.id) || 1;
    c.posden.textContent = '|' + ps.length;
    c.lap.textContent = p.finished ? TOTAL_LAPS : Math.min(p.lap + 1, TOTAL_LAPS);
    // lap progress bar (fraction of gates passed this lap)
    const frac = ((p.nextGate - 1 + gateCount) % gateCount) / gateCount;
    c.bar.style.width = Math.round((p.finished ? 1 : frac) * 100) + '%';
    c.mph.textContent = Math.max(0, Math.round(Math.abs(p.speed) * MPH));
    const nitroTime = p.nitroTime || 0;
    c.nitro.classList.toggle('hidden', nitroTime <= 0);
    c.nitroTime.textContent = nitroTime.toFixed(1) + 's';
    c.nitroBar.style.width = (nitroTime / NITRO.duration * 100) + '%';
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------------------------------------------------------------------------
// Banner / countdown
// ---------------------------------------------------------------------------
const banner = document.getElementById('banner');
const bannerText = document.getElementById('bannerText');
let bannerTimer = null;
function showBanner(text, ms) {
  bannerText.textContent = text;
  banner.classList.remove('hidden');
  // restart pop animation
  bannerText.style.animation = 'none';
  void bannerText.offsetWidth;
  bannerText.style.animation = '';
  if (bannerTimer) clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => banner.classList.add('hidden'), ms);
}
function hideBanner() { banner.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
const socket = io();

socket.on('connect', () => {
  socket.emit('host:create', {}, ({ code, url, port, addresses }) => {
    document.getElementById('disconnected').classList.add('hidden');
    document.getElementById('joinCode').textContent = code;
    setJoinUrl(url);

    // Populate the "try another address" dropdown.
    const sel = document.getElementById('addrSelect');
    sel.innerHTML = '';
    (addresses || []).forEach((addr) => {
      const u = `http://${addr}:${port}/controller.html?room=${code}`;
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = `${addr}`;
      sel.appendChild(opt);
    });
    sel.value = url;
  });
});

document.getElementById('addrSelect').addEventListener('change', (e) => setJoinUrl(e.target.value));

function setJoinUrl(url) {
  document.getElementById('joinUrl').textContent = url;
  document.getElementById('qrImg').src = '/qr?text=' + encodeURIComponent(url);
}

socket.on('player:join', (p) => { addPlayer(p); });
socket.on('player:leave', ({ id }) => { removePlayer(id); });
socket.on('player:ready', ({ id, ready }) => {
  const p = G.players.get(id);
  if (p) { p.ready = ready; updateLobby(); }
});
socket.on('player:input', ({ id, input }) => {
  const p = G.players.get(id);
  if (p) p.input = input;
});

function feedback(p, fb) {
  socket.emit('host:feedback', { id: p.id, ...fb });
}

// ---------------------------------------------------------------------------
// Lobby UI
// ---------------------------------------------------------------------------
const lobbyEl = document.getElementById('lobby');
const resultsEl = document.getElementById('results');
const startBtn = document.getElementById('startBtn');
const lobbyPlayers = document.getElementById('lobbyPlayers');

function updateLobby() {
  const ps = activePlayers();
  const bySlot = new Map(ps.map((p) => [p.slot, p]));
  let html = '';
  const colors = ['#ff4757', '#1e90ff', '#2ed573', '#ffa502'];
  const names = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];
  for (let s = 0; s < 4; s++) {
    const p = bySlot.get(s);
    if (p) {
      html += `<div class="pslot filled">
        <div class="pname" style="color:${colors[s]}">${escapeHtml(p.name)}</div>
        <div class="pstat">${p.ready ? '✓ Ready' : 'Connected'}</div>
      </div>`;
    } else {
      html += `<div class="pslot empty">
        <div class="pstat" style="color:${colors[s]}">waiting…</div>
      </div>`;
    }
  }
  lobbyPlayers.innerHTML = html;

  if (!G.assetsReady) {
    startBtn.disabled = true;
    startBtn.textContent = 'Loading 3D car…';
  } else if (ps.length === 0) {
    startBtn.disabled = true;
    startBtn.textContent = 'Waiting for players…';
  } else {
    startBtn.disabled = false;
    startBtn.textContent = `Start race (${ps.length} player${ps.length > 1 ? 's' : ''})`;
  }
}
updateLobby();

startBtn.addEventListener('click', () => {
  if (activePlayers().length === 0) return;
  // This click is the required user gesture for fullscreen.
  const el = document.documentElement;
  try { (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); } catch (e) {}
  if (AUDIO_ENABLED) audio.initAudio();
  socket.emit('host:start');
});

// Mute (M, when audio is enabled) and post-processing (B).
window.addEventListener('keydown', (e) => {
  if (AUDIO_ENABLED && (e.key === 'm' || e.key === 'M')) audio.toggleMuted();
  if (e.key === 'b' || e.key === 'B') POST = !POST;
});

document.getElementById('restartBtn').addEventListener('click', () => {
  socket.emit('host:reset');
});

socket.on('game:start', startGame);
socket.on('game:reset', backToLobby);
socket.on('disconnect', () => {
  backToLobby();
  for (const p of G.players.values()) audio.stopVoice(p.id);
  G.players.clear();
  layoutHud();
  updateLobby();
  document.getElementById('disconnected').classList.remove('hidden');
});

function setLight(mat, state) {
  if (!mat) return;
  if (state === 'red') { mat.emissive.setHex(0xff1111); mat.emissiveIntensity = 2.4; mat.color.setHex(0x440000); }
  else if (state === 'green') { mat.emissive.setHex(0x22ff44); mat.emissiveIntensity = 2.4; mat.color.setHex(0x004400); }
  else { mat.emissive.setHex(0x330000); mat.emissiveIntensity = 0.25; mat.color.setHex(0x220000); }
}

let raceEpoch = 0;
function startGame() {
  if (G.state === 'racing' || G.state === 'countdown') return;
  const epoch = ++raceEpoch;
  spawnCars();
  layoutHud();
  lobbyEl.classList.add('hidden');
  resultsEl.classList.add('hidden');
  G.winnerId = null;
  G.state = 'countdown';

  // F1 start lights: 5 reds illuminate one-by-one, then all go out = GO.
  const lights = G.track.startLights || [];
  lights.forEach((m) => setLight(m, 'off'));
  for (let i = 0; i < lights.length; i++) {
    setTimeout(() => { if (epoch === raceEpoch && G.state === 'countdown') setLight(lights[i], 'red'); }, 500 + i * 500);
  }

  // Discrete 3-2-1-GO countdown banner.
  showBanner('3', 0);
  setTimeout(() => { if (epoch === raceEpoch && G.state === 'countdown') showBanner('2', 0); }, 1000);
  setTimeout(() => { if (epoch === raceEpoch && G.state === 'countdown') showBanner('1', 0); }, 2000);
  setTimeout(() => {
    if (epoch !== raceEpoch || G.state !== 'countdown') return;
    showBanner('GO!', 900);
    lights.forEach((m) => setLight(m, 'green'));
    setTimeout(() => { if (epoch === raceEpoch) lights.forEach((m) => setLight(m, 'off')); }, 1200);
    G.state = 'racing';
    G.raceStart = performance.now();
  }, 3000);
}

function endRace() {
  G.state = 'results';
  audio.silenceAll();
  const ranks = rankings();
  document.getElementById('resultsTitle').textContent = 'Results';
  document.getElementById('standings').innerHTML = ranks.map((p, i) => {
    const place = i + 1;
    const time = p.finished ? formatTime(p.finishTime) : `${p.lap} lap${p.lap === 1 ? '' : 's'}`;
    return `<div class="standing">
      <span class="rank">${['🥇', '🥈', '🥉'][i] || (place + '.')}</span>
      <span class="sname">${escapeHtml(p.name)}</span>
      <span class="stime">${time}</span>
    </div>`;
  }).join('');
  resultsEl.classList.remove('hidden');
  hideBanner();
}

function backToLobby() {
  raceEpoch++;
  G.state = 'lobby';
  G.winnerId = null;
  resetNitroPickups(G.nitroPickups);
  nitroVisuals.update(0);
  audio.silenceAll();
  (G.track.startLights || []).forEach((m) => setLight(m, 'off'));
  for (const p of G.players.values()) {
    p.nitroTime = 0;
    if (p.mesh) { scene.remove(p.mesh); disposeCarMesh(p.mesh); p.mesh = null; }
  }
  resultsEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  hideBanner();
  updateLobby();
}

function formatTime(ms) {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(2);
  return `${m}:${rem.padStart(5, '0')}`;
}

socket.on('host:gone', () => {
  document.getElementById('disconnected').classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Tire smoke (pooled billboards)
// ---------------------------------------------------------------------------
const _smokeV = new THREE.Vector3();
const smokeTex = makeSmokeTexture();
const SMOKE_MAX = 140;
const smokePool = [];
for (let i = 0; i < SMOKE_MAX; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: smokeTex, transparent: true, opacity: 0, depthWrite: false, color: 0xcccccc,
  }));
  sp.visible = false;
  scene.add(sp);
  smokePool.push({ sp, age: 0, life: 0, vy: 0, base: 1 });
}
let smokeIdx = 0;
function spawnSmoke(x, y, z, scale) {
  const p = smokePool[smokeIdx];
  smokeIdx = (smokeIdx + 1) % SMOKE_MAX;
  p.age = 0; p.life = 0.7 + Math.random() * 0.5; p.vy = 1.2 + Math.random() * 1.4; p.base = scale;
  p.sp.visible = true;
  p.sp.position.set(x, y, z);
  p.sp.scale.setScalar(scale);
}
function updateSmoke(dt) {
  for (const p of smokePool) {
    if (!p.sp.visible) continue;
    p.age += dt;
    const t = p.age / p.life;
    if (t >= 1) { p.sp.visible = false; continue; }
    p.sp.position.y += p.vy * dt;
    p.sp.scale.setScalar(p.base * (1 + t * 2.4));
    p.sp.material.opacity = (1 - t) * 0.4;
  }
}
function emitCarSmoke(p) {
  const drift = Math.abs(p.steerSmooth) > 0.5 && p.speed > 18;
  const brakeHard = (p.input.brake || 0) > 0.5 && p.speed > 12;
  const wallHit = p.offTrack && p.speed > 14;
  if (!drift && !brakeHard && !wallHit) return;
  const wheels = p.mesh.userData.wheels || [];
  if (wheels.length < 4) return;
  for (const wi of [2, 3]) {
    wheels[wi].getWorldPosition(_smokeV);
    spawnSmoke(_smokeV.x, _smokeV.y + 0.3, _smokeV.z, 1.9);
  }
}
function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// Skid marks (one InstancedMesh, recycled ring buffer)
// ---------------------------------------------------------------------------
const SKID_MAX = 800;
const skidMesh = new THREE.InstancedMesh(
  new THREE.PlaneGeometry(0.55, 1.5),
  new THREE.MeshBasicMaterial({
    color: 0x0a0a0a, transparent: true, opacity: 0.5, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }),
  SKID_MAX
);
skidMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
skidMesh.frustumCulled = false;
skidMesh.renderOrder = 1;
const _hideM = new THREE.Matrix4().makeScale(0, 0, 0);
for (let i = 0; i < SKID_MAX; i++) skidMesh.setMatrixAt(i, _hideM);
skidMesh.instanceMatrix.needsUpdate = true;
scene.add(skidMesh);

let skidIdx = 0;
const _skidFlat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const _skidYaw = new THREE.Quaternion();
const _skidQ = new THREE.Quaternion();
const _skidUp = new THREE.Vector3(0, 1, 0);
const _skidM = new THREE.Matrix4();
const _skidS = new THREE.Vector3(1, 1, 1);
const _skidP = new THREE.Vector3();
function dropSkid(x, z, heading, y) {
  _skidYaw.setFromAxisAngle(_skidUp, heading);
  _skidQ.copy(_skidYaw).multiply(_skidFlat);
  _skidP.set(x, y + 0.04, z);
  _skidM.compose(_skidP, _skidQ, _skidS);
  skidMesh.setMatrixAt(skidIdx, _skidM);
  skidIdx = (skidIdx + 1) % SKID_MAX;
  skidMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const SIM_STEP = 1 / 60;
const MAX_FRAME = 0.1;
let last = performance.now();
let accumulated = 0;
function updateRace(dt) {
  accumulated += dt;
  while (accumulated >= SIM_STEP) {
    for (const p of G.players.values()) {
      savePreviousPose(p);
      updateCar(p, SIM_STEP, G.track, { dropSkid, onGate: updateGates });
    }
    handleCollisions();
    updateNitroPickups(G.nitroPickups, G.players.values(), SIM_STEP, (p) => feedback(p, { vibrate: 70 }));
    accumulated -= SIM_STEP;
  }
  for (const p of G.players.values()) {
    renderCar(p, accumulated / SIM_STEP);
    updateCarEffects(p, dt);
    placeCamera(p, false, dt);
  }
  nitroVisualTime += dt;
  nitroVisuals.update(nitroVisualTime);
}
function loop(now) {
  const dt = Math.min(MAX_FRAME, Math.max(0, (now - last) / 1000));
  last = now;

  if (G.state === 'racing') {
    updateRace(dt);
    for (const p of G.players.values()) {
      emitCarSmoke(p);
      audio.setEngine(p.id, p.rpm, PHYS.redline);
      audio.setSqueal(p.id, p.squeal);
      if (p.shiftPulse > 0) { audio.shift(p.id); p.shiftPulse = 0; }
    }
    updateSmoke(dt);
    sendFeedback(now);
    renderSplit();
  } else if (G.state === 'countdown') {
    accumulated = 0;
    for (const p of G.players.values()) {
      updateCarEffects(p, dt);
      placeCamera(p, false, dt);
      audio.setEngine(p.id, PHYS.idleRpm, PHYS.redline);
    }
    renderSplit();
  } else {
    accumulated = 0;
    renderOverview(now);
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

let lastFeedbackTick = 0;
function sendFeedback(now) {
  if (now - lastFeedbackTick < 150) return;
  lastFeedbackTick = now;
  const ranks = rankings();
  const rankOf = new Map(ranks.map((p, idx) => [p.id, idx + 1]));
  for (const p of G.players.values()) {
    feedback(p, {
      offtrack: p.offTrack,
      speed: Math.round(Math.abs(p.speed) * MPH),
      place: rankOf.get(p.id) || 1,
      lap: Math.min(p.lap + 1, TOTAL_LAPS),
      totalLaps: TOTAL_LAPS,
      vibrate: p.offTrack ? 25 : 0,
    });
  }
}
