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
    + '\nexport { G, renderer, sceneTarget, addPlayer, spawnCars, renderSplit, renderOverview, layoutHud, updateRace, placeCamera };';
  res.type('js').send(source);
});
app.get('/render-check.mjs', (_req, res) => res.type('js').send(`
import { G, renderer, addPlayer, spawnCars, renderSplit, renderOverview, layoutHud, updateRace, placeCamera } from '/js/host.js';
const report = document.createElement('pre');
report.id = 'render-result';
document.body.appendChild(report);
const cases = [];
const motion = [];
let screenshot;
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
  while (!G.assetsReady && performance.now() < deadline) await new Promise(r => setTimeout(r, 50));
  if (!G.assetsReady) throw new Error('Car assets did not load');
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
    }
  }
  report.textContent = JSON.stringify({ devicePixelRatio, motion, cases, screenshot });
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
