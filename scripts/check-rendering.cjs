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
let browser, timeout, received = false;
app.post('/render-result', express.json({ limit: '8mb' }), (req, res) => {
  received = true;
  const report = req.body;
  if (report.screenshot) {
    const screenshotPath = path.join(os.tmpdir(), 'driftsync-two-player-dpr' + scale + '.png');
    fs.writeFileSync(screenshotPath, Buffer.from(report.screenshot.split(',')[1], 'base64'));
    delete report.screenshot;
    report.screenshotPath = screenshotPath;
  }
  for (const key of ['nitroScreenshot', 'boostScreenshot', 'brakeReverseScreenshot']) {
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
    + '\nexport { G, scene, renderer, sceneTarget, colorGradePass, addPlayer, spawnCars, renderSplit, renderOverview, layoutHud, updateRace, placeCamera };';
  res.type('js').send(source);
});
app.get('/render-check.mjs', (_req, res) => res.type('js').send(`
import { G, scene, renderer, colorGradePass, addPlayer, spawnCars, renderSplit, renderOverview, layoutHud, updateRace, placeCamera } from '/js/host.js';
import { resetMotion, renderCar } from '/js/motion.js';
import { updateCarEffects } from '/js/car-effects.js';
import * as THREE from 'three';
const report = document.createElement('pre');
report.id = 'render-result';
document.body.appendChild(report);
const cases = [];
const motion = [];
let screenshot, nitroScreenshot, boostScreenshot, brakeReverseScreenshot, nitro;
function inspectFrame(name, count) {
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
  renderOverview(0);
  document.getElementById('lobby').classList.add('hidden');
  for (let count = 1; count <= 4; count++) {
    const i = count - 1;
    addPlayer({ id: 'test-' + i, slot: i, name: 'Test ' + count, color: ['#ff4757', '#1e90ff', '#2ed573', '#ffa502'][i] });
    spawnCars(); layoutHud();
    await new Promise(requestAnimationFrame);
    renderSplit();
    inspectFrame(count + ' players', count);
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
      if (players[0].mesh.userData.brakeMaterials.some(m => m.emissiveIntensity !== 1.4)) throw new Error('Brake lights did not turn red');
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
  report.textContent = JSON.stringify({ devicePixelRatio, motion, nitro, cases, screenshot, nitroScreenshot, boostScreenshot, brakeReverseScreenshot });
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
    '--disable-background-networking', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--window-size=960,640', '--force-device-scale-factor=' + scale,
    '--user-data-dir=' + profile,
    'http://127.0.0.1:' + server.address().port,
  ], { windowsHide: true });
  let errors = '';
  browser.stderr.on('data', chunk => { errors += chunk; });
  timeout = setTimeout(() => browser.kill(), 60000);
  browser.on('error', error => { console.error(error.message); process.exitCode = 1; server.close(); clearTimeout(timeout); });
  browser.on('close', () => {
    clearTimeout(timeout);
    server.close();
    if (!received) { console.error('No render report. ' + errors.slice(-2000)); process.exitCode = 1; }
  });
});
