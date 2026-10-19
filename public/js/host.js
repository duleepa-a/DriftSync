import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildTrack } from './track.js';
import { createCarMesh, loadCarAssets } from './carmesh.js';
import * as audio from './audio.js';
import * as physics from './physics.js';

const MODEL_DROP = 0.7; // visual model origin (wheel-bottom) below chassis centre

/* global io */

// ---------------------------------------------------------------------------
// Constants & tuning
// ---------------------------------------------------------------------------
const TOTAL_LAPS = 3;
const GATE_RADIUS = 28;
const MPH = 2.23694; // m/s -> mph

const PHYS = {
  maxSpeed: 46,       // m/s top speed (~103 mph)
  accel: 14,          // engine acceleration (auto-throttle)
  dragK: 0.004,       // aero drag (∝ v²) — gives a natural top speed & accel curve
  brakeDecel: 55,     // braking
  reverseAccel: 16,   // reverse acceleration when stopped + braking
  reverseMax: -12,
  turnRate: 2.0,      // rad/s at full grip
  wallScrub: 0.86,    // speed retained when scraping a wall
  gears: 8,           // F1-style 8-speed (drives RPM/sound)
  idleRpm: 4000,
  redline: 15000,
};
const COLLIDE_DIST = 3.6;

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const G = {
  state: 'lobby', // lobby | countdown | racing | results
  players: new Map(), // socketId -> player
  assetsReady: false, // real car model loaded?
  physicsReady: false, // Rapier world built?
  useRapier: false,    // is this race using the physics sim?
  forceArcade: false,  // user toggled back to arcade
  track: null,
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
const sceneTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
  type: THREE.HalfFloatType,
  samples: 4, // MSAA for the scene
});

const ColorGradeShader = {
  uniforms: { tDiffuse: { value: null }, uSat: { value: 1.14 }, uCon: { value: 1.05 }, uVig: { value: 0.34 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uSat, uCon, uVig; varying vec2 vUv;
    void main(){
      vec4 t = texture2D(tDiffuse, vUv); vec3 c = t.rgb;
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
composer.addPass(new ShaderPass(ColorGradeShader));
composer.addPass(new OutputPass());

// Image-based lighting. Start with a quick procedural sky, then upgrade to a
// real HDRI environment once it loads (realistic lighting + reflections).
const pmrem = new THREE.PMREMGenerator(renderer);
const skyEquirect = makeSkyEnv();
scene.environment = pmrem.fromEquirectangular(skyEquirect).texture;
scene.background = skyEquirect;

new RGBELoader().load('/assets/sky_day.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  scene.background = scene.environment;
  scene.backgroundBlurriness = 0.0;
  hdr.dispose();
});

G.track = buildTrack(scene);

// Preload the real car model; until it's ready, the Start button waits.
loadCarAssets().then(() => { G.assetsReady = true; updateLobby(); });

// Bring up the Rapier physics world (real suspension + tyre-slip). If it fails,
// we silently fall back to the arcade physics.
physics.initPhysics()
  .then(() => { physics.buildWorld(G.track.colliders); G.physicsReady = true; })
  .catch((err) => { console.warn('Rapier init failed; using arcade physics.', err); G.physicsReady = false; });

function makeSkyEnv() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const ctx = c.getContext('2d');
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, 256);
  sky.addColorStop(0, '#2f6fd0');
  sky.addColorStop(0.6, '#7fb4ee');
  sky.addColorStop(1, '#dcefff');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, 1024, 256);
  // soft sun glow
  const glow = ctx.createRadialGradient(720, 90, 10, 720, 90, 220);
  glow.addColorStop(0, 'rgba(255,250,230,0.95)');
  glow.addColorStop(1, 'rgba(255,250,230,0)');
  ctx.fillStyle = glow; ctx.fillRect(400, 0, 624, 300);
  // a few clouds
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (let i = 0; i < 16; i++) {
    const x = Math.random() * 1024, y = 40 + Math.random() * 150, r = 18 + Math.random() * 34;
    for (let b = 0; b < 5; b++) ctx.beginPath(), ctx.arc(x + b * r * 0.7 - r, y, r * (0.6 + Math.random() * 0.5), 0, 7), ctx.fill();
  }
  // ground
  const grd = ctx.createLinearGradient(0, 256, 0, 512);
  grd.addColorStop(0, '#6f9a55');
  grd.addColorStop(1, '#3f5e34');
  ctx.fillStyle = grd; ctx.fillRect(0, 256, 1024, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Overview camera for the lobby / attract screen.
const overview = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 2000);

window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  sceneTarget.setSize(w, h);
  composer.setSize(w, h);
  layoutHud();
});

// ---------------------------------------------------------------------------
// Player / car management
// ---------------------------------------------------------------------------
function addPlayer(p) {
  if (G.players.has(p.id)) return;
  G.players.set(p.id, {
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
  });
  updateLobby();
}

function removePlayer(id) {
  const p = G.players.get(id);
  if (p && p.mesh) scene.remove(p.mesh);
  audio.stopVoice(id);
  if (G.physicsReady) physics.removeCar(id);
  G.players.delete(id);
  updateLobby();
}

function activePlayers() {
  return [...G.players.values()].sort((a, b) => a.slot - b.slot);
}

function spawnCars() {
  // Decide the physics model for this race.
  G.useRapier = G.physicsReady && !G.forceArcade;
  if (G.useRapier) physics.resetCars();

  const grid = G.track.startPositions;
  activePlayers().forEach((p, i) => {
    if (!p.mesh) {
      p.mesh = createCarMesh(p.color);
      p.mesh.rotation.order = 'YXZ'; // yaw, then pitch/roll for weight transfer
      scene.add(p.mesh);
    }
    const g = grid[i % grid.length];
    p.pos.copy(g.pos);
    p.heading = g.heading;
    p.speed = 0;
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
    const ni = G.track.nearestInfo(p.pos, 0);
    p.sampleIndex = ni.index;
    p.groundY = ni.groundY;
    p.mesh.position.set(p.pos.x, p.groundY, p.pos.z);
    p.mesh.rotation.set(0, p.heading, 0);

    if (G.useRapier) physics.addCar(p.id, { pos: g.pos, heading: g.heading });

    // Snap camera behind the car immediately.
    placeCamera(p, true);
  });
}

// Read a car's state back from the Rapier sim into the player object + mesh.
const _rbQ = new THREE.Quaternion();
const _rbF = new THREE.Vector3();
function updateCarRapier(p, dt) {
  const s = physics.getState(p.id);
  if (!s) return;
  p.pos.set(s.x, s.y, s.z);
  _rbQ.set(s.qx, s.qy, s.qz, s.qw);
  _rbF.set(0, 0, 1).applyQuaternion(_rbQ);
  p.heading = Math.atan2(_rbF.x, _rbF.z);
  p.speed = s.forwardSpeed;
  p.groundY = s.y - MODEL_DROP;
  const sp = Math.abs(s.forwardSpeed);

  // gears / RPM for engine sound
  const gearSpan = PHYS.maxSpeed / PHYS.gears;
  const gear = Math.min(PHYS.gears - 1, Math.max(0, Math.floor(sp / gearSpan)));
  const within = clamp((sp - gear * gearSpan) / gearSpan, 0, 1);
  p.rpm = PHYS.idleRpm + within * (PHYS.redline - PHYS.idleRpm);
  if (gear > p.gear) p.shiftPulse = 1;
  p.gear = gear;

  // real lateral slip from the sim drives squeal / smoke / skids
  const brake = p.input.brake || 0;
  const slip = Math.abs(s.lateralSpeed);
  p.squeal = slip > 4.5 || (brake > 0.6 && sp > 12);
  p.skidding = slip > 6 || p.squeal;
  p.offTrack = false;

  // place the visual model (wheels at ground)
  p.mesh.position.set(s.x, s.y - MODEL_DROP, s.z);
  p.mesh.quaternion.copy(_rbQ);

  // wheels visual
  p.steerSmooth += ((p.input.steer || 0) - p.steerSmooth) * Math.min(1, dt * 12);
  const wheels = p.mesh.userData.wheels || [];
  const wroll = s.forwardSpeed * dt * 1.8;
  for (let i = 0; i < wheels.length; i++) {
    wheels[i].rotation.x += wroll;
    if (i < 2) wheels[i].rotation.y = clamp(p.steerSmooth, -1, 1) * 0.4;
  }
  if (p.mesh.userData.brakeMat) p.mesh.userData.brakeMat.emissiveIntensity = brake > 0.05 ? 2.6 : 0.4;

  updateGates(p);
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
const _aheadV = new THREE.Vector3();

function updateCar(p, dt) {
  const inp = p.input;
  p.steerSmooth += (clamp(inp.steer, -1, 1) - p.steerSmooth) * Math.min(1, dt * 12);
  const steer = p.steerSmooth;
  const brake = clamp(inp.brake || 0, 0, 1);

  // --- Longitudinal: auto-throttle vs aero drag (∝ v²), or braking ---
  if (brake > 0.02) {
    if (p.speed > 0.2) p.speed -= PHYS.brakeDecel * brake * dt;
    else p.speed -= PHYS.reverseAccel * brake * dt; // reverse from a stop
  } else {
    const drag = PHYS.dragK * p.speed * Math.abs(p.speed);
    p.speed += (PHYS.accel - drag) * dt;
  }
  if (p.speed > PHYS.maxSpeed) p.speed -= (p.speed - PHYS.maxSpeed) * 4 * dt;
  p.speed = clamp(p.speed, PHYS.reverseMax, PHYS.maxSpeed);
  const sp = Math.abs(p.speed);

  // --- Gearbox / RPM (drives engine sound + feel) ---
  const gearSpan = PHYS.maxSpeed / PHYS.gears;
  const gear = Math.min(PHYS.gears - 1, Math.max(0, Math.floor(sp / gearSpan)));
  const within = clamp((sp - gear * gearSpan) / gearSpan, 0, 1);
  p.rpm = PHYS.idleRpm + within * (PHYS.redline - PHYS.idleRpm);
  if (gear > p.gear) p.shiftPulse = 1; // upshift happened this frame
  p.gear = gear;

  // --- Steering: speed-sensitive, downforce grip, high-speed understeer,
  //     reduced turn-in when braking hard (lockup) ---
  const rollingGrip = clamp(sp / 6, 0, 1);                 // need to be moving
  const understeer = 1 - clamp((sp - 30) / 90, 0, 0.4);    // washes out at top speed
  const lockAuthority = brake > 0.7 ? 0.6 : 1;             // locked fronts won't turn
  const dir = p.speed >= 0 ? 1 : -1;
  p.heading += steer * PHYS.turnRate * rollingGrip * understeer * lockAuthority * dir * dt;

  // --- Integrate position ---
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  p.pos.x += fx * p.speed * dt;
  p.pos.z += fz * p.speed * dt;

  // --- Solid walls ---
  const info = G.track.nearestInfo(p.pos, p.sampleIndex);
  p.sampleIndex = info.index;
  const maxOff = G.track.halfWidth - 1.4;
  let hitWall = false;
  if (info.offset > maxOff) { const c = info.offset - maxOff; p.pos.x -= info.nx * c; p.pos.z -= info.nz * c; hitWall = true; }
  else if (info.offset < -maxOff) { const c = info.offset + maxOff; p.pos.x -= info.nx * c; p.pos.z -= info.nz * c; hitWall = true; }
  if (hitWall) p.speed *= PHYS.wallScrub;
  p.offTrack = hitWall;

  // --- Slip / lockup state (for tire squeal, smoke, skid marks) ---
  const corneringLoad = Math.abs(steer) * sp;
  const lockup = brake > 0.6 && sp > 12;
  p.squeal = corneringLoad > 24 || lockup;
  p.skidding = corneringLoad > 30 || lockup || hitWall;

  // --- Terrain: ride the ground height, pitch with the slope ---
  const groundY = info.groundY;
  p.groundY += (groundY - p.groundY) * Math.min(1, dt * 9);
  const aheadInfo = G.track.nearestInfo(_aheadV.set(p.pos.x + fx * 5, 0, p.pos.z + fz * 5), p.sampleIndex);
  const slopePitch = -Math.atan2(aheadInfo.groundY - groundY, 5);

  // --- Weight transfer: pitch under accel/brake, roll into corners ---
  const accelEst = (p.speed - p.prevSpeed) / Math.max(dt, 1e-3);
  p.prevSpeed = p.speed;
  const pitch = clamp(slopePitch + clamp(-accelEst * 0.004, -0.05, 0.05), -0.3, 0.3);
  const bodyRoll = clamp(steer * sp * 0.0016, -0.06, 0.06);
  p.mesh.position.set(p.pos.x, p.groundY, p.pos.z);
  p.mesh.rotation.set(pitch, p.heading, -bodyRoll);

  // --- Wheels ---
  const wheels = p.mesh.userData.wheels || [];
  const wroll = p.speed * dt * 1.8;
  for (let i = 0; i < wheels.length; i++) {
    wheels[i].rotation.x += wroll;
    if (i < 2) wheels[i].rotation.y = steer * 0.4; // front wheels steer
  }
  if (p.mesh.userData.brakeMat) {
    p.mesh.userData.brakeMat.emissiveIntensity = brake > 0.05 ? 2.6 : 0.4;
  }

  // --- Skid marks at the rear tyres ---
  if (p.skidding && wheels.length >= 4) {
    for (const wi of [2, 3]) { wheels[wi].getWorldPosition(_skidV); dropSkid(_skidV.x, _skidV.z, p.heading, p.groundY); }
  }

  updateGates(p);
}

function updateGates(p) {
  if (p.finished) return;
  const gates = G.track.gates;
  const g = p.nextGate % gates.length;
  const gp = gates[g].pos;
  const dx = p.pos.x - gp.x;
  const dz = p.pos.z - gp.z;
  if (dx * dx + dz * dz < GATE_RADIUS * GATE_RADIUS) {
    p.gatesPassed++;
    if (g === 0) {
      p.lap++;
      if (p.lap >= TOTAL_LAPS) finishPlayer(p);
    }
    p.nextGate = (g + 1) % gates.length;
  }
}

function finishPlayer(p) {
  p.finished = true;
  p.finishTime = performance.now() - G.raceStart;
  const alreadyFinished = activePlayers().filter((q) => q.finished && q !== p).length;
  p.finishRank = alreadyFinished + 1;
  if (!G.winnerId) {
    G.winnerId = p.id;
    showBanner(`${p.name} wins!`, 1600);
    setTimeout(endRace, 1700);
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
  const ps = activePlayers();
  return ps.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishRank - b.finishRank;
    if (a.finished) return -1;
    if (b.finished) return 1;
    if (b.gatesPassed !== a.gatesPassed) return b.gatesPassed - a.gatesPassed;
    // tie-break: closer to next gate = ahead
    return distToGate(a) - distToGate(b);
  });
}
function distToGate(p) {
  const g = G.track.gates[p.nextGate % G.track.gates.length].pos;
  return Math.hypot(p.pos.x - g.x, p.pos.z - g.z);
}

// ---------------------------------------------------------------------------
// Cameras & rendering
// ---------------------------------------------------------------------------
function placeCamera(p, snap = false) {
  const back = 5.6, height = (p.groundY || 0) + 2.5, look = 11;
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  const tx = p.pos.x - fx * back, tz = p.pos.z - fz * back;

  if (snap) {
    p.camPos.set(tx, height, tz);
  } else {
    // Smooth the *direction* of follow, not the distance.
    p.camPos.x += (tx - p.camPos.x) * 0.22;
    p.camPos.z += (tz - p.camPos.z) * 0.22;
    p.camPos.y += (height - p.camPos.y) * 0.25;
  }
  // Lock a constant horizontal follow distance so the car never shrinks /
  // "zooms out" as you accelerate (this was the lag growing with speed).
  let dx = p.camPos.x - p.pos.x, dz = p.camPos.z - p.pos.z;
  const h = Math.hypot(dx, dz) || 1;
  p.camPos.x = p.pos.x + (dx / h) * back;
  p.camPos.z = p.pos.z + (dz / h) * back;

  // Subtle shake at high speed.
  const sp = Math.abs(p.speed);
  let shx = 0, shy = 0;
  if (sp > 32) { const a = Math.min((sp - 32) / 40, 1) * 0.10; shx = (Math.random() - 0.5) * a; shy = (Math.random() - 0.5) * a; }
  p.camera.position.set(p.camPos.x + shx, p.camPos.y + shy, p.camPos.z);

  // Gentle dynamic FOV for a sense of speed (small, so the car stays big).
  const targetFov = 60 + Math.min(sp / PHYS.maxSpeed, 1) * 5;
  p.camera.fov += (targetFov - p.camera.fov) * 0.08;

  // Look slightly into the corner (at the car's elevation).
  const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
  const lead = p.steerSmooth * 4;
  p.camera.lookAt(p.pos.x + fx * look + rx * lead, (p.groundY || 0) + 1.4, p.pos.z + fz * look + rz * lead);
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
  const rects = layoutRects(ps.length);
  const H = window.innerHeight;

  renderer.setRenderTarget(POST ? sceneTarget : null);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);

  const ranks = rankings();
  ps.forEach((p, i) => {
    const r = rects[i];
    if (!r) return;
    const y = H - r.y - r.h; // convert top-left to bottom-left origin
    renderer.setViewport(r.x, y, r.w, r.h);
    renderer.setScissor(r.x, y, r.w, r.h);
    p.camera.aspect = r.w / r.h;
    p.camera.updateProjectionMatrix();
    renderer.render(scene, p.camera);
  });

  renderer.setScissorTest(false);
  renderer.setRenderTarget(null);
  if (POST) composer.render();

  updateHud(ps, rects, ranks);
}

function renderOverview(t) {
  const W = window.innerWidth, H = window.innerHeight;
  renderer.setRenderTarget(POST ? sceneTarget : null);
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setViewport(0, 0, W, H);
  overview.aspect = W / H;
  overview.updateProjectionMatrix();
  const r = 300, a = t * 0.00008;
  overview.position.set(Math.cos(a) * r, 190, Math.sin(a) * r);
  overview.lookAt(0, 0, 0);
  renderer.render(scene, overview);
  renderer.setRenderTarget(null);
  if (POST) composer.render();
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
      <div class="hud-speed"><span class="mph" data-mph>0</span><span class="mphlbl">MPH</span></div>`;
    hud.appendChild(cell);
    return {
      pos: cell.querySelector('[data-pos]'),
      posden: cell.querySelector('[data-posden]'),
      lap: cell.querySelector('[data-lap]'),
      bar: cell.querySelector('[data-bar]'),
      mph: cell.querySelector('[data-mph]'),
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
    sel.addEventListener('change', () => setJoinUrl(sel.value));
  });
});

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
  const names = ['Red', 'Blue', 'Green', 'Orange'];
  for (let s = 0; s < 4; s++) {
    const p = bySlot.get(s);
    if (p) {
      html += `<div class="pslot filled">
        <div class="dot" style="background:${p.color}"></div>
        <div class="pname">${escapeHtml(p.name)}</div>
        <div class="pstat">${p.ready ? '✓ Ready' : 'Connected'}</div>
      </div>`;
    } else {
      html += `<div class="pslot empty">
        <div class="dot" style="background:${colors[s]};opacity:.25"></div>
        <div class="pname">${names[s]}</div>
        <div class="pstat">waiting…</div>
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
  // This click is the required user gesture for fullscreen + audio.
  const el = document.documentElement;
  try { (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el); } catch (e) {}
  audio.initAudio();
  socket.emit('host:start');
});

// Mute (M), post-processing (B), physics model (N — applies next race).
window.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') audio.toggleMuted();
  if (e.key === 'b' || e.key === 'B') POST = !POST;
  if (e.key === 'n' || e.key === 'N') {
    G.forceArcade = !G.forceArcade;
    showBanner(G.forceArcade ? 'Arcade physics' : 'Sim physics', 1400);
    // If a race is in progress, bail to the lobby so the new mode takes effect.
    if (G.state === 'racing' || G.state === 'countdown') socket.emit('host:reset');
  }
});

document.getElementById('restartBtn').addEventListener('click', () => {
  socket.emit('host:reset');
});

socket.on('game:start', startGame);
socket.on('game:reset', backToLobby);

function setLight(mat, state) {
  if (!mat) return;
  if (state === 'red') { mat.emissive.setHex(0xff1111); mat.emissiveIntensity = 2.4; mat.color.setHex(0x440000); }
  else if (state === 'green') { mat.emissive.setHex(0x22ff44); mat.emissiveIntensity = 2.4; mat.color.setHex(0x004400); }
  else { mat.emissive.setHex(0x330000); mat.emissiveIntensity = 0.25; mat.color.setHex(0x220000); }
}

function startGame() {
  if (G.state === 'racing' || G.state === 'countdown') return;
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
    setTimeout(() => { if (G.state === 'countdown') setLight(lights[i], 'red'); }, 500 + i * 500);
  }

  // Discrete 3-2-1-GO countdown banner.
  showBanner('3', 0);
  setTimeout(() => { if (G.state === 'countdown') showBanner('2', 0); }, 1000);
  setTimeout(() => { if (G.state === 'countdown') showBanner('1', 0); }, 2000);
  setTimeout(() => {
    if (G.state !== 'countdown') return;
    showBanner('GO!', 900);
    lights.forEach((m) => setLight(m, 'green'));
    setTimeout(() => lights.forEach((m) => setLight(m, 'off')), 1200);
    G.state = 'racing';
    G.raceStart = performance.now();
  }, 3000);
}

function endRace() {
  G.state = 'results';
  audio.silenceAll();
  const ranks = rankings();
  document.getElementById('resultsTitle').textContent = '🏁 Results';
  document.getElementById('standings').innerHTML = ranks.map((p, i) => {
    const place = i + 1;
    const time = p.finished ? formatTime(p.finishTime) : `${p.lap} lap${p.lap === 1 ? '' : 's'}`;
    return `<div class="standing">
      <span class="rank">${['🥇', '🥈', '🥉'][i] || (place + '.')}</span>
      <span class="dot" style="background:${p.color}"></span>
      <span class="sname">${escapeHtml(p.name)}</span>
      <span class="stime">${time}</span>
    </div>`;
  }).join('');
  resultsEl.classList.remove('hidden');
  hideBanner();
}

function backToLobby() {
  G.state = 'lobby';
  audio.silenceAll();
  if (G.physicsReady) physics.resetCars();
  (G.track.startLights || []).forEach((m) => setLight(m, 'off'));
  for (const p of G.players.values()) {
    if (p.mesh) { scene.remove(p.mesh); p.mesh = null; }
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
const _skidV = new THREE.Vector3();
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
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (G.state === 'racing') {
    if (G.useRapier) {
      for (const p of G.players.values()) physics.applyControls(p.id, p.input, dt);
      physics.step(dt);
      for (const p of G.players.values()) updateCarRapier(p, dt);
    } else {
      for (const p of G.players.values()) updateCar(p, dt);
      handleCollisions();
    }
    for (const p of G.players.values()) {
      placeCamera(p);
      emitCarSmoke(p);
      audio.setEngine(p.id, p.rpm, PHYS.redline);
      audio.setSqueal(p.id, p.squeal);
      if (p.shiftPulse > 0) { audio.shift(p.id); p.shiftPulse = 0; }
    }
    updateSmoke(dt);
    sendFeedback(now);
    renderSplit();
  } else if (G.state === 'countdown') {
    if (G.useRapier) {
      for (const p of G.players.values()) physics.applyControls(p.id, { steer: 0, brake: 0 }, dt, true);
      physics.step(dt);
      for (const p of G.players.values()) updateCarRapier(p, dt);
    }
    for (const p of G.players.values()) { placeCamera(p); audio.setEngine(p.id, PHYS.idleRpm, PHYS.redline); }
    renderSplit();
  } else {
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
