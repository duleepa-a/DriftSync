/**
 * Synthesized racing audio via the Web Audio API (host-side, no asset files).
 * Per-car engine voice whose pitch tracks RPM, plus tyre squeal, gear-shift
 * blips, collision thuds and a low crowd ambience.
 *
 * Must be initialised from a user gesture (the Start button) or browsers block it.
 */

let ctx = null;
let master = null;
let noiseBuffer = null;
let muted = false;
const voices = new Map(); // id -> voice

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.6;
  master.connect(ctx.destination);
  noiseBuffer = makeNoise(2);
  startCrowd();
}

function makeNoise(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function startCrowd() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer; src.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
  const g = ctx.createGain(); g.gain.value = 0.05;
  src.connect(lp).connect(g).connect(master);
  src.start();
}

function ensureVoice(id) {
  if (voices.has(id)) return voices.get(id);
  if (!ctx) return null;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 900; filter.Q.value = 3;
  const gain = ctx.createGain(); gain.gain.value = 0;
  filter.connect(gain).connect(master);

  const osc1 = ctx.createOscillator(); osc1.type = 'sawtooth';
  const osc2 = ctx.createOscillator(); osc2.type = 'sawtooth'; osc2.detune.value = -9;
  const sub = ctx.createOscillator(); sub.type = 'square';
  const subGain = ctx.createGain(); subGain.gain.value = 0.5;
  osc1.connect(filter); osc2.connect(filter); sub.connect(subGain).connect(filter);
  osc1.start(); osc2.start(); sub.start();

  // tyre squeal (filtered noise, normally silent)
  const sq = ctx.createBufferSource(); sq.buffer = noiseBuffer; sq.loop = true;
  const sbp = ctx.createBiquadFilter(); sbp.type = 'bandpass'; sbp.frequency.value = 1900; sbp.Q.value = 7;
  const sg = ctx.createGain(); sg.gain.value = 0;
  sq.connect(sbp).connect(sg).connect(master); sq.start();

  const v = { osc1, osc2, sub, filter, gain, squealGain: sg };
  voices.set(id, v);
  return v;
}

export function setEngine(id, rpm, redline) {
  const v = ensureVoice(id); if (!v || !ctx) return;
  const t = ctx.currentTime;
  const frac = Math.min(Math.max(rpm / redline, 0), 1);
  const f = 45 + frac * 340;
  v.osc1.frequency.setTargetAtTime(f, t, 0.04);
  v.osc2.frequency.setTargetAtTime(f, t, 0.04);
  v.sub.frequency.setTargetAtTime(f * 0.5, t, 0.05);
  v.filter.frequency.setTargetAtTime(500 + frac * 3500, t, 0.05);
  v.gain.gain.setTargetAtTime(0.045 + frac * 0.06, t, 0.05);
}

export function setSqueal(id, on) {
  const v = voices.get(id); if (!v || !ctx) return;
  v.squealGain.gain.setTargetAtTime(on ? 0.06 : 0, ctx.currentTime, on ? 0.02 : 0.12);
}

export function shift(id) {
  const v = voices.get(id); if (!v || !ctx) return;
  const t = ctx.currentTime;
  // quick clutch dip; setEngine restores the level next frame
  v.gain.gain.cancelScheduledValues(t);
  v.gain.gain.setValueAtTime(Math.max(0.01, v.gain.gain.value * 0.35), t);
}

export function collision() {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource(); src.buffer = noiseBuffer;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  src.connect(lp).connect(g).connect(master);
  src.start(); src.stop(t + 0.3);
}

export function silenceAll() {
  if (!ctx) return;
  for (const v of voices.values()) {
    v.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    v.squealGain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
  }
}

export function stopVoice(id) {
  const v = voices.get(id); if (!v) return;
  try { v.osc1.stop(); v.osc2.stop(); v.sub.stop(); } catch (e) {}
  voices.delete(id);
}

export function setMuted(m) {
  muted = m;
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.6, ctx.currentTime, 0.05);
}
export function toggleMuted() { setMuted(!muted); return muted; }
