// Appended to the production controller by check-rendering.cjs --controller.
(async () => {
  const report = { controlLayouts: [], screenshots: [] };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  async function viewport(orientation) {
    const response = await fetch('/controller-viewport/' + orientation, { method: 'POST' });
    check(response.ok, 'Could not resize browser');
    await settle();
  }
  async function capture(name) {
    const response = await fetch('/capture-ui/' + name, { method: 'POST' });
    check(response.ok, 'Could not capture ' + name);
    report.screenshots.push(await response.json());
  }
  function manualLayout() {
    const boxes = [els.leftBtn, els.rightBtn, els.brakeBtn, els.acceleratorBtn].map(el => el.getBoundingClientRect());
    for (const b of boxes) {
      check(b.width >= 44 && b.height >= 44, 'Touch target too small');
      check(b.left >= 0 && b.right <= innerWidth && b.top >= 52 && b.bottom <= innerHeight - 30, 'Control outside usable screen');
    }
    check(boxes[0].right < boxes[1].left && boxes[1].right < boxes[2].left && boxes[2].right < boxes[3].left, 'Controls overlap or are out of order');
    check(boxes[1].right < innerWidth / 2 && boxes[2].left > innerWidth / 2, 'Steering and pedals must occupy opposite corners');
    check(boxes[0].height < boxes[3].height, 'Steering should be smaller than accelerator');
    report.controlLayouts.push({ width: innerWidth, height: innerHeight, controls: boxes.map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height })) });
  }
  try {
    els.codeInput.value = 'TEST';
    doJoin();
    await viewport('landscape');
    check(els.acceleratorBtn.getBoundingClientRect().width === 0, 'Default mode exposes accelerator');
    check(!els.controller.classList.contains('manual'), 'Default mode changed');
    await capture('controller-auto');
    applySettings({ autoAccelerate: false });
    await settle();
    manualLayout();
    await capture('controller-manual');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    check(input.throttle === 1 && input.steer === 1, 'Simultaneous accelerator and steering failed');
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }));
    check(input.throttle === 0 && input.steer === 1, 'Accelerator release changed steering');
    window.dispatchEvent(new Event('blur'));
    check(input.throttle === 0 && input.steer === 0, 'Blur retained input');
    await viewport('portrait');
    manualLayout();
    await capture('controller-portrait');
    applySettings({ autoAccelerate: true });
    await settle();
    check(els.acceleratorBtn.getBoundingClientRect().width === 0, 'Returning to auto left pedal visible');
    report.input = 'keyboard combination, release, blur, and mode switching passed';
  } catch (error) { report.error = error.stack; }
  await fetch('/render-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
})();
