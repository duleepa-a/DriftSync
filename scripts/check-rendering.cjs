// Run the real host renderer in headless Chrome, without phones or a live room.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const scale = process.argv.includes('--dpr=2') ? 2 : 1;
const app = express();
let browser, timeout, received = false, debugOrigin;
app.post('/capture-ui/:name', async (req, res) => {
  if (!['finish-waiting', 'race-results'].includes(req.params.name)) return res.sendStatus(400);
  try {
    const tabs = await (await fetch(debugOrigin + '/json/list')).json();
    const tab = tabs.find(tab => tab.type === 'page');
    const data = await new Promise((resolve, reject) => {
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      const timer = setTimeout(() => { ws.close(); reject(new Error('UI capture timed out')); }, 5000);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })));
      ws.addEventListener('message', event => {
        const reply = JSON.parse(event.data);
        if (reply.id !== 1) return;
        clearTimeout(timer); ws.close();
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.result.data);
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('UI capture connection failed')); });
    });
    const screenshotPath = path.join(os.tmpdir(), 'driftsync-' + req.params.name + '-dpr' + scale + '.png');
    fs.writeFileSync(screenshotPath, Buffer.from(data, 'base64'));
    res.json({ screenshotPath });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
// High-DPI PNGs contain much more asphalt/forest detail than the 1x captures.
app.post('/render-result', express.json({ limit: '32mb' }), (req, res) => {
  received = true;
  const report = req.body;
  if (report.screenshot) {
    const screenshotPath = path.join(os.tmpdir(), 'driftsync-two-player-dpr' + scale + '.png');
    fs.writeFileSync(screenshotPath, Buffer.from(report.screenshot.split(',')[1], 'base64'));
    delete report.screenshot;
    report.screenshotPath = screenshotPath;
  }
  for (const key of ['nitroScreenshot', 'boostScreenshot', 'brakeReverseScreenshot', 'sceneryScreenshot']) {
    if (!report[key]) continue;
    const screenshotPath = path.join(os.tmpdir(), 'driftsync-' + key + '-dpr' + scale + '.png');
    fs.writeFileSync(screenshotPath, Buffer.from(report[key].split(',')[1], 'base64'));
    delete report[key];
    report[key + 'Path'] = screenshotPath;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.error || report.cases.some(test => test.glError || test.views.some(view => view.bright < 0.2 || view.opaque < 0.95))) process.exitCode = 1;
  res.sendStatus(200);
  browser.kill();
});
app.get('/', (_req, res) => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
    .replace('<script src="/socket.io/socket.io.js"></script>', '<script>window.io = () => ({ on() {}, emit() {} });</script>')
    .replace(/src="js\/host\.js[^"]*"/, 'src="/render-check.mjs"');
  res.type('html').send(html);
});
app.get('/js/host.js', (_req, res) => {
  // Stop only the scheduled loop, so each test can inspect a completed frame.
  const source = fs.readFileSync(path.join(root, 'public/js/host.js'), 'utf8')
    .replaceAll('requestAnimationFrame(loop);', '')
    + '\nexport { G, scene, renderer, composer, renderPass, bloomPass, colorGradePass, addPlayer, removePlayer, backToLobby, spawnCars, renderSplit, renderOverview, layoutHud, updateRace, placeCamera };';
  res.type('js').send(source);
});
app.get('/render-check.mjs', (_req, res) => res.type('js').send(`
import { G, scene, renderer, composer, renderPass, bloomPass, colorGradePass, addPlayer, removePlayer, backToLobby, spawnCars, renderSplit, renderOverview, layoutHud, updateRace, placeCamera } from '/js/host.js';
import { resetMotion, renderCar } from '/js/motion.js';
import { updateCarEffects } from '/js/car-effects.js';
import * as THREE from 'three';
const report = document.createElement('pre');
report.id = 'render-result';
document.body.appendChild(report);
const cases = [];
const motion = [];
let screenshot, nitroScreenshot, boostScreenshot, brakeReverseScreenshot, sceneryScreenshot, nitro, bloom;
let shaderError;
renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
  shaderError = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join('\\n');
};
function inspectFrame(name, count) {
  if (shaderError) throw new Error('Shader compilation failed: ' + shaderError);
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const views = [];
  const columns = count > 2 ? 2 : 1, rows = count > 1 ? 2 : 1;
  for (let view = 0; view < count; view++) {
    const col = view % columns, row = Math.floor(view / columns);
    let bright = 0, opaque = 0, total = 0;
    for (let y = Math.ceil((rows - row - 1) * h / rows); y < Math.floor((rows - row) * h / rows); y += 4) {
      for (let x = Math.ceil(col * w / columns); x < Math.floor((col + 1) * w / columns); x += 4) {
        const at = (y * w + x) * 4;
        if (Math.max(pixels[at], pixels[at + 1], pixels[at + 2]) > 40) bright++;
        if (pixels[at + 3] > 200) opaque++;
        total++;
      }
    }
    views.push({ player: view + 1, bright: bright / total, opaque: opaque / total });
  }
  cases.push({ name, width: w, height: h, views, glError: gl.getError() });
}
function checkBloom() {
  if (renderer.toneMapping !== THREE.ACESFilmicToneMapping || renderer.toneMappingExposure < 1.2 || renderer.toneMappingExposure > 1.5) throw new Error('Incorrect cinematic tone mapping');
  if (composer.passes[0] !== renderPass || composer.passes[1] !== bloomPass || composer.renderTarget1.texture.type !== THREE.HalfFloatType) throw new Error('RenderPass must feed bloom an HDR buffer');
  // Exercise the real pipeline: an HDR red lamp must cast a halo while an
  // ordinary white surface stays below the threshold. No low-threshold wash.
  const fixture = new THREE.Scene();
  fixture.background = new THREE.Color(0x000000);
  const geometry = new THREE.PlaneGeometry(0.16, 0.16);
  const red = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(6, 0, 0) });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  for (const [x, material] of [[0.55, red], [-0.55, white]]) {
    const patch = new THREE.Mesh(geometry, material); patch.position.x = x; fixture.add(patch);
  }
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  renderPass.scene = fixture; renderPass.camera = camera;
  const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const captures = [];
  for (const enabled of [false, true]) {
    bloomPass.enabled = enabled;
    renderer.setRenderTarget(null); renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.setScissorTest(false); renderer.clear(); composer.render();
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels); captures.push(pixels);
  }
  function halo(x0, x1) {
    let delta = 0, count = 0;
    for (let y = Math.floor(h * 0.47); y < h * 0.53; y++) for (let x = Math.floor(w * x0); x < w * x1; x++) {
      const i = (y * w + x) * 4; delta += captures[1][i] - captures[0][i]; count++;
    }
    return delta / count;
  }
  const redHalo = halo(0.825, 0.85), whiteHalo = halo(0.275, 0.30);
  if (redHalo < 2 || whiteHalo > redHalo * 0.2) throw new Error('Bloom is missing or washing out non-emissive surfaces: ' + JSON.stringify({ redHalo, whiteHalo }));
  renderPass.scene = scene;
  geometry.dispose(); red.dispose(); white.dispose();
  return { exposure: renderer.toneMappingExposure, strength: bloomPass.strength, radius: bloomPass.radius, threshold: bloomPass.threshold, redHalo, whiteHalo };
}
async function checkFinishing() {
  function begin() {
    backToLobby(); spawnCars(); layoutHud();
    document.getElementById('lobby').classList.add('hidden');
    G.state = 'racing'; G.raceStart = performance.now() - 90000;
  }
  function crossFinish(p) {
    const gate = G.track.gates[0];
    p.lap = 2; p.nextGate = 0; p.lapStartedAt = 60000; p.bestLapTime = 28000; p.topSpeed = 52;
    p.pos.copy(gate.pos).addScaledVector(gate.tangent, -0.1);
    p.heading = Math.atan2(gate.tangent.x, gate.tangent.z);
    p.speed = p.prevSpeed = 20;
    resetMotion(p); renderCar(p, 1); placeCamera(p, true);
    updateRace(1 / 60); renderSplit();
    if (!p.finished) throw new Error('Final gate crossing did not finish the player');
  }
  async function capture(name) {
    await new Promise(requestAnimationFrame);
    const response = await fetch('/capture-ui/' + name, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result.screenshotPath;
  }
  begin();
  const players = [...G.players.values()];
  crossFinish(players[1]);
  const frozenPosition = players[1].pos.clone(), frozenTime = players[1].finishTime;
  await new Promise(resolve => setTimeout(resolve, 1800)); // Catch the former winner timeout.
  if (G.state !== 'racing' || !document.getElementById('results').classList.contains('hidden')) throw new Error('Winner ended the race before the other players');
  // A stationary finisher must not be moved by controls or collisions.
  players[0].pos.copy(frozenPosition); players[0].speed = 0;
  players[1].input = { brake: 1, steer: 1 };
  updateRace(0.1); renderSplit();
  if (!players[1].pos.equals(frozenPosition) || players[1].finishTime !== frozenTime || players[0].speed <= 0) throw new Error('Finisher moved or remaining racers stopped');
  crossFinish(players[0]);
  window.dispatchEvent(new Event('resize')); renderSplit();
  const cells = [...document.querySelectorAll('.hud-cell')];
  for (let i = 0; i < players.length; i++) {
    const panel = cells[i].querySelector('[data-finish]');
    if (panel.classList.contains('hidden') === players[i].finished) throw new Error('Finish overlay is on the wrong player');
    if (players[i].finished) {
      const bounds = cells[i].getBoundingClientRect(), card = panel.firstElementChild.getBoundingClientRect();
      if (card.top < bounds.top || card.bottom > bounds.bottom || card.left < bounds.left || card.right > bounds.right) throw new Error('Finish card exceeds its viewport');
      if (!panel.querySelector('[data-finish-waiting]').textContent.includes('2 racers') || panel.querySelector('[data-best-lap]').textContent !== '0:28.00' || panel.querySelector('[data-top-speed]').textContent !== '116 MPH') throw new Error('Finished player statistics are incorrect');
    }
  }
  const waitingScreenshotPath = await capture('finish-waiting');
  crossFinish(players[3]);
  if (G.state !== 'racing') throw new Error('Race ended before last finisher');
  crossFinish(players[2]);
  if (G.state !== 'results' || document.getElementById('results').classList.contains('hidden')) throw new Error('Last finisher did not show results');
  const names = [...document.querySelectorAll('#standings .sname')].map(el => el.textContent);
  if (names.join(',') !== [players[1], players[0], players[3], players[2]].map(p => p.name).join(',')) throw new Error('Results lost finish order');
  const resultsScreenshotPath = await capture('race-results');
  begin();
  if (G.finishOrder.length || players.some(p => p.finished || p.bestLapTime || p.topSpeed)) throw new Error('Restart retained finishing state');
  crossFinish(players[1]); removePlayer(players[1].id);
  crossFinish(players[0]);
  removePlayer(players[2].id); removePlayer(players[3].id);
  if (G.state !== 'results' || players[0].finishRank !== 2 || document.querySelectorAll('#standings .standing').length !== 2) throw new Error('Disconnects blocked completion or changed recorded places');
  begin(); crossFinish(players[0]);
  if (G.state !== 'results' || players[0].finishRank !== 1) throw new Error('Single-player finish regressed');
  backToLobby();
  if (document.querySelector('[data-finish]')) throw new Error('Reset retained finish overlays');
  return { order: names, waitingScreenshotPath, resultsScreenshotPath, disconnects: 'passed', restart: 'passed', singlePlayer: 'passed' };
}
try {
  const deadline = performance.now() + 30000;
  while ((!G.assetsReady || !G.environmentReady) && performance.now() < deadline) await new Promise(r => setTimeout(r, 50));
  if (!G.assetsReady) throw new Error('Car assets did not load');
  if (!G.environmentReady || scene.environment?.name !== 'sunset-environment') throw new Error('Sunset HDRI did not load');
  if (!scene.background?.isTexture || scene.background === scene.environment) throw new Error('Matching sunset sky backdrop is missing');
  const { sun, sunHelper } = G.track;
  const sunDirection = sun.position.clone().sub(sun.target.position);
  const elevation = Math.atan2(sunDirection.y, Math.hypot(sunDirection.x, sunDirection.z)) * 180 / Math.PI;
  if (elevation < 2 || elevation > 6 || sun.position.length() < 900) throw new Error('Sun is not low behind the treeline');
  if (sunHelper.light !== sun || sunHelper.lightPlane.material.opacity > 0.2 || sunHelper.layers.mask !== 2) throw new Error('Sun positioning helper is missing or too prominent');
  const road = scene.getObjectByName('asphalt-road');
  const asphalt = road?.material;
  if (!asphalt?.isMeshStandardMaterial || !asphalt.map || !asphalt.normalMap || !asphalt.roughnessMap) throw new Error('Road PBR maps are missing');
  if (asphalt.map.colorSpace !== THREE.SRGBColorSpace || asphalt.normalMap.colorSpace !== THREE.NoColorSpace || asphalt.roughnessMap.colorSpace !== THREE.NoColorSpace) throw new Error('Incorrect PBR texture color spaces');
  if (asphalt.map.repeat.x <= 1 || asphalt.roughnessMap.repeat.x !== 1 || !asphalt.map.repeat.equals(asphalt.normalMap.repeat)) throw new Error('Racing-line roughness must not tile across the road');
  const rough = asphalt.roughnessMap.image;
  const centre = rough.data[(Math.floor(rough.width / 2)) * 4 + 1] / 255;
  const shoulder = rough.data[1] / 255;
  if (centre < 0.7 || centre > 0.85 || shoulder < 0.9 || shoulder - centre < 0.08 || asphalt.metalness !== 0 || asphalt.envMapIntensity > 0.85) throw new Error('Dry asphalt must retain subtle wear without a glossy reflection stripe');
  bloom = checkBloom();
  renderOverview(0);
  document.getElementById('lobby').classList.add('hidden');
  for (let count = 1; count <= 4; count++) {
    const i = count - 1;
    addPlayer({ id: 'test-' + i, slot: i, name: 'Test ' + count, color: ['#ff4757', '#1e90ff', '#2ed573', '#ffa502'][i] });
    spawnCars(); layoutHud();
    for (const player of G.players.values()) {
      if (player.mesh.userData.modelId !== 'mclaren-2021') throw new Error('McLaren asset failed to load; procedural fallback is active');
    }
    await new Promise(requestAnimationFrame);
    renderSplit();
    inspectFrame(count + ' players', count);
    if (!bloomPass.enabled || renderPass.camera !== [...G.players.values()].at(-1).camera) throw new Error('Composer did not render bloom for every player');
    if (count === 1) sceneryScreenshot = renderer.domElement.toDataURL('image/png');
    if (count <= 2) {
      // Exercise the production fixed-step loop at a display rate above 60 Hz.
      const players = [...G.players.values()];
      let previous = players.map(p => p.mesh.position.clone());
      let stalledFrames = 0, maxCameraOffset = 0;
      for (let frame = 0; frame < 240; frame++) {
        updateRace(1 / 120);
        players.forEach((p, i) => {
          if (frame > 2 && p.mesh.position.distanceTo(previous[i]) < 1e-8) stalledFrames++;
          previous[i].copy(p.mesh.position);
          maxCameraOffset = Math.max(maxCameraOffset, p.camera.position.distanceTo(p.camPos));
          if (![p.mesh.position.y, p.mesh.rotation.x, p.camera.fov].every(Number.isFinite)) throw new Error('Non-finite race pose');
        });
        if (frame === 120 || frame === 239) {
          renderSplit();
          inspectFrame(count + ' players accelerating, frame ' + frame, count);
        }
      }
      if (stalledFrames || maxCameraOffset > 1e-9 || players.some(p => p.speed < 32)) {
        throw new Error('Forward motion jitter: ' + JSON.stringify({ stalledFrames, maxCameraOffset }));
      }
      motion.push({ players: count, displayHz: 120, simulatedSeconds: 2, stalledFrames, maxCameraOffset, speeds: players.map(p => p.speed) });
      spawnCars();
      renderSplit();
    }
    if (count === 2) {
      screenshot = renderer.domElement.toDataURL('image/png');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      await new Promise(requestAnimationFrame);
      renderSplit();
      inspectFrame('2 players, effects off', 2);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      await new Promise(requestAnimationFrame);
      renderSplit();
      inspectFrame('2 players, effects restored', 2);
      window.dispatchEvent(new Event('resize'));
      await new Promise(requestAnimationFrame);
      renderSplit();
      inspectFrame('2 players, resize', 2);
      const widthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
      const heightDescriptor = Object.getOwnPropertyDescriptor(window, 'innerHeight');
      const resizedWidth = innerWidth - 78, resizedHeight = innerHeight - 46;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: resizedWidth });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: resizedHeight });
      window.dispatchEvent(new Event('resize')); renderSplit();
      inspectFrame('2 players, changed window dimensions', 2);
      if (composer.readBuffer.width !== Math.ceil(resizedWidth * renderer.getPixelRatio()) || composer.readBuffer.height !== Math.ceil(resizedHeight * renderer.getPixelRatio() / 2)) throw new Error('Composer did not resize to the player viewport');
      Object.defineProperty(window, 'innerWidth', widthDescriptor);
      Object.defineProperty(window, 'innerHeight', heightDescriptor);
      window.dispatchEvent(new Event('resize')); renderSplit();

      const players = [...G.players.values()];
      // Approach separate bottles on the back straight using real physics.
      const bottles = [G.nitroPickups[3], G.nitroPickups[5]];
      if (bottles.some(p => !p)) throw new Error('Missing straight-section nitro stations');
      players.forEach((p, i) => {
        const bottle = bottles[i];
        p.heading = bottle.heading;
        p.pos.set(bottle.pos.x - Math.sin(p.heading) * 12, 0, bottle.pos.z - Math.cos(p.heading) * 12);
        p.groundY = G.track.nearestInfo(p.pos).groundY;
        p.speed = p.prevSpeed = 46;
        resetMotion(p); renderCar(p, 1); placeCamera(p, true);
      });
      renderSplit();
      inspectFrame('2 players approaching nitro', 2);
      nitroScreenshot = renderer.domElement.toDataURL('image/png');
      for (let frame = 0; frame < 90; frame++) updateRace(1 / 120);
      renderSplit();
      inspectFrame('2 players collecting nitro', 2);
      boostScreenshot = renderer.domElement.toDataURL('image/png');
      const indicators = [...document.querySelectorAll('[data-nitro]')];
      if (players.some(p => p.nitroTime <= 0 || p.speed <= 46)) throw new Error('Nitro failed to increase speed');
      if (players.some(p => !p.mesh.userData.effects.flames.visible || p.camera.fov <= 65)) throw new Error('Missing blue flames or nitro zoom');
      if (colorGradePass.uniforms.uBoost.value.x < 0.9 || colorGradePass.uniforms.uBoost.value.y < 0.9) throw new Error('Nitro blur did not activate');
      if (bottles.some(p => p.cooldown <= 0 || scene.getObjectByName('nitro-' + p.id).visible)) throw new Error('Collected bottle did not disappear');
      if (indicators.some(el => el.classList.contains('hidden') || el.getBoundingClientRect().width <= 0)) throw new Error('Nitro HUD is missing');
      nitro = { stations: G.nitroPickups.length / 3, speeds: players.map(p => p.speed), activeIndicators: indicators.length };
      players[0].input.brake = 1;
      updateRace(1 / 60); renderSplit();
      if (players[0].nitroTime !== 0 || !indicators[0].classList.contains('hidden') || players[1].nitroTime <= 0) throw new Error('Braking must cancel nitro for that player only');
      if (players[0].mesh.userData.effects.flames.visible || !players[1].mesh.userData.effects.flames.visible) throw new Error('Flames leaked between players');
      if (players[0].mesh.userData.brakeMaterials.some(m => m.emissiveIntensity !== 6)) throw new Error('Brake lights did not turn red');
      if (colorGradePass.uniforms.uBoost.value.x >= colorGradePass.uniforms.uBoost.value.y) throw new Error('Blur is not independent per viewport');
      for (let frame = 0; frame < 500; frame++) updateRace(1 / 60);
      if (bottles.some(p => p.cooldown !== 0 || !scene.getObjectByName('nitro-' + p.id).visible)) throw new Error('Nitro did not respawn');
      spawnCars(); renderSplit();
      if (players.some(p => p.nitroTime !== 0) || G.nitroPickups.some(p => p.cooldown !== 0)) throw new Error('Restart retained nitro state');
      if (players.some(p => p.nitroVisual !== 0 || p.mesh.userData.effects.flames.visible)) throw new Error('Restart retained speed effects');
      players[0].input.brake = 1;
      players[1].input.brake = 1; players[1].speed = -3;
      players.forEach(p => updateCarEffects(p, 1 / 60));
      renderSplit(); inspectFrame('red brake lights and white reverse lights', 2);
      brakeReverseScreenshot = renderer.domElement.toDataURL('image/png');
      if (players[1].mesh.userData.effects.reverseMaterial.emissiveIntensity !== 3) throw new Error('Reverse lamps did not turn white');
      if (players[0].mesh.userData.effects.reverseMaterial.emissiveIntensity !== 0) throw new Error('Reverse lamps lit while stationary');
      spawnCars();
    }
    if (count >= 3) {
      const players = [...G.players.values()];
      const boosted = players[count - 1];
      boosted.nitroTime = 1; boosted.speed = 46;
      updateCarEffects(boosted, 0.1); placeCamera(boosted, false, 0.1);
      renderSplit(); inspectFrame(count + ' players, last player boosted', count);
      const amounts = colorGradePass.uniforms.uBoost.value.toArray();
      if (amounts.some((value, i) => i === count - 1 ? value <= 0 : value !== 0)) throw new Error('Boost blur mapped to the wrong quadrant');
      if (count === 4) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
        renderSplit(); inspectFrame('4 players, flames with postprocessing off', count);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
      }
    }
  }
  const forest = scene.getObjectByName('instanced-pine-forest');
  const stands = scene.getObjectByName('track-scenery').children.filter(child => child.isLOD);
  const scenery = { trees: forest.count, forestTriangles: forest.count * forest.geometry.attributes.position.count / 3, grandstands: stands.length };
  const finishing = await checkFinishing();
  report.textContent = JSON.stringify({ devicePixelRatio, motion, nitro, bloom, scenery, finishing, cases, screenshot, nitroScreenshot, boostScreenshot, brakeReverseScreenshot, sceneryScreenshot });
} catch (error) { report.textContent = JSON.stringify({ error: error.stack }); }
await fetch('/render-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: report.textContent });
`));
app.use(express.static(path.join(root, 'public')));
app.use('/lib', express.static(path.join(root, 'node_modules/three/build')));
app.use('/jsm', express.static(path.join(root, 'node_modules/three/examples/jsm')));

const server = app.listen(0, '127.0.0.1', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'driftsync-render-'));
  browser = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--disable-background-networking', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=960,640', '--force-device-scale-factor=' + scale,
    '--user-data-dir=' + profile,
    'http://127.0.0.1:' + server.address().port,
  ], { windowsHide: true });
  let errors = '';
  browser.stderr.on('data', chunk => {
    errors += chunk;
    const match = errors.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) debugOrigin = 'http://127.0.0.1:' + new URL(match[1]).port;
  });
  timeout = setTimeout(() => browser.kill(), 60000);
  browser.on('error', error => { console.error(error.message); process.exitCode = 1; server.close(); clearTimeout(timeout); });
  browser.on('close', () => {
    clearTimeout(timeout);
    server.close();
    if (!received) { console.error('No render report. ' + errors.slice(-2000)); process.exitCode = 1; }
  });
});
