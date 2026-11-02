const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function controller() {
  function target() {
    const handlers = {}, classes = new Set();
    return {
      value: '', style: { setProperty() {} },
      classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
      },
      addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
      fire(name, data = {}) { for (const fn of handlers[name] || []) fn({ preventDefault() {}, ...data }); },
      setPointerCapture() {},
    };
  }
  const elements = new Map(), events = {}, sent = [];
  const window = target(), document = target();
  document.documentElement = target();
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, target());
    return elements.get(id);
  };
  let joinSettings = { autoAccelerate: false };
  const socket = {
    connected: true,
    on(name, fn) { events[name] = fn; },
    emit(name, data, cb) {
      sent.push({ name, data: JSON.parse(JSON.stringify(data)) });
      if (name === 'ctrl:join') cb({ ok: true, slot: 0, color: '#000', settings: joinSettings });
    },
  };
  let send;
  const context = vm.createContext({
    document, window, io: () => socket, URLSearchParams,
    location: { search: '?room=ABCD' }, screen: {}, navigator: {},
    setInterval: fn => { send = fn; },
  });
  vm.runInContext(readFileSync(path.join(__dirname, '../public/js/controller.js'), 'utf8'), context);
  elements.get('joinBtn').fire('click');
  return {
    elements, window, document, socket, events,
    input() { send(); return sent.at(-1).data; },
    reconnect(settings) { joinSettings = settings; events.disconnect(); events.connect(); },
  };
}

test('manual controller combines steering and pedals, releases touches, and clears lost focus', () => {
  const c = controller();
  const press = (id, event, pointerId) => c.elements.get(id).fire(event, { pointerId });
  assert.equal(c.elements.get('controller').classList.contains('manual'), true);
  press('leftBtn', 'pointerdown', 1);
  press('acceleratorBtn', 'pointerdown', 2);
  assert.deepEqual(c.input(), { steer: 1, brake: 0, throttle: 1 });
  press('brakeBtn', 'pointerdown', 3);
  assert.deepEqual(c.input(), { steer: 1, brake: 1, throttle: 1 });
  press('leftBtn', 'pointercancel', 1);
  press('acceleratorBtn', 'lostpointercapture', 2);
  assert.deepEqual(c.input(), { steer: 0, brake: 1, throttle: 0 });
  c.window.fire('blur');
  assert.deepEqual(c.input(), { steer: 0, brake: 0, throttle: 0 });
  press('acceleratorBtn', 'pointerdown', 4);
  press('acceleratorBtn', 'pointerdown', 5);
  press('acceleratorBtn', 'pointerup', 4);
  assert.equal(c.input().throttle, 1, 'second finger still holds pedal');
  c.document.hidden = true;
  c.document.fire('visibilitychange');
  assert.equal(c.input().throttle, 0);
});

test('controller updates mode on settings, start, reset, and reconnect without retaining throttle', () => {
  const c = controller();
  c.window.fire('keydown', { key: 'w' });
  assert.equal(c.input().throttle, 1);
  c.events['game:settings']({ autoAccelerate: true });
  assert.equal(c.input().throttle, 0);
  assert.equal(c.elements.get('acceleratorBtn').classList.contains('hidden'), true);
  c.window.fire('keydown', { key: 'ArrowUp' });
  assert.equal(c.input().throttle, 0);
  c.events['game:start']({ autoAccelerate: false });
  assert.equal(c.elements.get('controller').classList.contains('manual'), true);
  assert.equal(c.input().throttle, 0);
  c.window.fire('keydown', { key: 'ArrowUp' });
  c.window.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual(c.input(), { steer: -1, brake: 0, throttle: 1 });
  c.events['game:reset']({ autoAccelerate: false });
  assert.deepEqual(c.input(), { steer: 0, brake: 0, throttle: 0 });
  c.reconnect({ autoAccelerate: true });
  assert.equal(c.elements.get('controller').classList.contains('manual'), false);
  assert.equal(c.elements.get('acceleratorBtn').classList.contains('hidden'), true);
});
