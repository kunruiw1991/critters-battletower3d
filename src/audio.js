/*
 * Critter Battle Tower 3D — procedural audio engine (WebAudio only).
 *
 * Everything is synthesized at runtime: no audio files, no network assets,
 * no voices / TTS. Every public call is safe before unlock() and when WebAudio
 * is unavailable (it silently does nothing and never throws).
 *
 * Signal graph
 *   SFX voice: synth nodes -> voice gain -> StereoPanner -> SFX bus (0.8) -> warm EQ -> master
 *                                                    \-> per-voice reverb send ------\
 *   Music:     track gain (crossfade) -> duck gain -> music bus (0.35) -> LP -> master |
 *                                                                     \-> reverb send |
 *   Reverb:    sends -> Convolver (generated stone-room impulse) -> return -> master
 *   master (mute ramps here) -> HPF 38 Hz -> DynamicsCompressor -> safety soft-clip -> out
 *
 * Public API (GDD section 9)
 *   GameAudio.unlock()                      create / resume the AudioContext (call in a gesture)
 *   GameAudio.play(name, {pitch, volume, pan})   one-shot SFX; returns { stop(fadeSec) } or null
 *   GameAudio.startMusic('calm'|'boss'|'victory')  crossfades; same track again = no-op
 *   GameAudio.stopMusic()                   fades the music out
 *   GameAudio.setMuted(bool) / isMuted()    smooth master ramp
 * Extras: GameAudio.info() (plain JSON status), GameAudio.beatInfo() ({track,bpm,beat}|null).
 * Dev exports (dev/audio.html): SFX_NAMES, MUSIC_TRACKS, _synth, renderOffline,
 *   renderMusicOffline, renderSceneOffline.
 */

const ROOT = typeof window !== 'undefined' ? window : globalThis;
const AC = ROOT.AudioContext || ROOT.webkitAudioContext || null;
const OAC = ROOT.OfflineAudioContext || ROOT.webkitOfflineAudioContext || null;
const noop = () => {};

// ---------------------------------------------------------------------------
// Mix constants
// ---------------------------------------------------------------------------
const LEVEL = {
  master: 0.8, // master gain when unmuted (pre-compressor)
  music: 0.21, // music bus (calibrated so all spec SFX sit >= +3.5 dB above music p90)
  sfx: 0.8, // SFX bus
  reverbReturn: 0.3, // convolver return into master
  musicReverbSend: 0.42, // music (post bus) -> reverb
};
const LOOKAHEAD = 0.3; // seconds of music scheduled ahead on the audio clock
const TICK_MS = 40; // scheduler + housekeeping interval
const MAX_VOICES = 24; // concurrent SFX voices
const MAX_DYING = 16; // voices being faded out after a steal
const RATE_WINDOW_MS = 100; // global burst limiter window
const RATE_MAX = 12; // max new voices per window
const MIN_THROTTLE_MS = 40; // per-name repeat throttle floor

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const perfNow = () =>
  ROOT.performance && ROOT.performance.now ? ROOT.performance.now() : Date.now();

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lcg(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Random source used inside synth functions (seedable for offline renders).
let RND = Math.random;

// Freeze an AudioParam at its current value so new automation starts smoothly.
function holdParam(param, t) {
  if (param.cancelAndHoldAtTime) {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

// ---------------------------------------------------------------------------
// Shared buffers (noise, crackle, impulse response) cached per sample rate.
// AudioBuffers are not bound to a context, so live + offline can share them.
// ---------------------------------------------------------------------------
const bufferCache = new Map();

function buffers(c) {
  const sr = c.sampleRate;
  let B = bufferCache.get(sr);
  if (B) return B;
  const rnd = lcg(20261022);
  const n = Math.floor(sr * 2);
  const white = c.createBuffer(1, n, sr);
  const pink = c.createBuffer(1, n, sr);
  const w = white.getChannelData(0);
  const pk = pink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, pmax = 0;
  for (let i = 0; i < n; i++) {
    const x = rnd() * 2 - 1;
    w[i] = x;
    // Paul Kellet's pink filter: warmer than white noise for whooshes / hiss.
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
    b6 = x * 0.115926;
    pk[i] = y;
    if (Math.abs(y) > pmax) pmax = Math.abs(y);
  }
  const ps = 0.9 / (pmax || 1);
  for (let i = 0; i < n; i++) pk[i] *= ps;

  // Crackle: sparse tiny decaying noise pops (flames, fireworks, fuse sparks).
  const cl = Math.floor(sr * 1.5);
  const crackle = c.createBuffer(1, cl, sr);
  const cd = crackle.getChannelData(0);
  for (let i = Math.floor(sr * 0.003); i < cl; ) {
    const amp = 0.3 + rnd() * 0.7;
    const len = Math.max(8, Math.floor(sr * (0.0006 + rnd() * 0.0025)));
    for (let j = 0; j < len && i + j < cl; j++) {
      cd[i + j] += amp * Math.exp((-4 * j) / len) * (rnd() * 2 - 1);
    }
    i += Math.floor(sr * (0.006 + rnd() * 0.03));
  }

  B = { white, pink, crackle, ir: makeImpulse(c, rnd) };
  bufferCache.set(sr, B);
  return B;
}

// Short stereo "stone room" impulse: early reflections + HF-damped noise tail.
function makeImpulse(c, rnd) {
  const sr = c.sampleRate;
  const len = Math.floor(sr * 1.3);
  const ir = c.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    const pre = Math.floor(sr * (0.009 + 0.0031 * ch));
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      const k = 0.18 + 0.72 * x; // high frequencies die faster
      lp += (rnd() * 2 - 1 - lp) * (1 - k);
      d[i] = lp * Math.exp(-6.2 * x) * (1 - x);
    }
    const er = [
      [0.013, 0.8], [0.019, -0.6], [0.029, 0.5], [0.041, -0.42], [0.056, 0.3], [0.071, -0.22],
    ];
    for (const [tt, a] of er) {
      const i = Math.floor((tt + 0.0023 * ch) * sr);
      if (i < len) d[i] += a * 0.5;
    }
    let e = 0;
    for (let i = 0; i < len; i++) e += d[i] * d[i];
    const s = 1 / Math.sqrt(e || 1); // unit energy => wet level ~ dry level
    for (let i = 0; i < len; i++) d[i] *= s;
  }
  return ir;
}

// PeriodicWaves are bound to a context.
const waveCache = new WeakMap();

function waves(c) {
  let w = waveCache.get(c);
  if (w) return w;
  const make = (amps, cosine) => {
    const re = new Float32Array(amps.length + 1);
    const im = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => {
      if (cosine) re[i + 1] = a;
      else im[i + 1] = a;
    });
    return c.createPeriodicWave(re, im);
  };
  const creak = [];
  for (let k = 1; k <= 48; k++) creak.push(Math.exp(-k * 0.035)); // stick-slip impulse train
  w = {
    piano: make([1, 0.38, 0.17, 0.08, 0.045, 0.02]),
    organ: make([1, 0.45, 0.22, 0.1, 0.05]),
    creak: make(creak, true),
  };
  waveCache.set(c, w);
  return w;
}

// Safety soft clip: exactly linear below 0.6, smooth knee to <= 0.84.
let CLIP = null;

function clipCurve() {
  if (CLIP) return CLIP;
  const n = 2049, knee = 0.6, ceil = 0.86, room = ceil - knee;
  CLIP = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    CLIP[i] = x < 0 ? -y : y;
  }
  return CLIP;
}

// ---------------------------------------------------------------------------
// Synthesis primitives
// ---------------------------------------------------------------------------

// Attack / hold / exponential decay envelope on a gain AudioParam.
function ahd(param, t, peak, a, h, d) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  if (h > 0) param.setValueAtTime(peak, t + a + h);
  param.exponentialRampToValueAtTime(0.0001, t + a + h + d);
  param.setValueAtTime(0, t + a + h + d + 0.002);
}

function lfo(c, param, t, end, rate, depth, depthEnd) {
  const l = c.createOscillator();
  const lg = c.createGain();
  l.frequency.value = rate;
  lg.gain.setValueAtTime(depth, t);
  if (depthEnd != null) lg.gain.linearRampToValueAtTime(depthEnd, end);
  l.connect(lg);
  lg.connect(param);
  l.start(t);
  l.stop(end + 0.02);
}

/**
 * Enveloped oscillator.
 * o: { type|wave, f2 (glide target), glide, a, h, d, peak, detune, vib:[rate, cents, centsEnd], lp }
 */
function tone(c, out, t, f, o) {
  o = o || {};
  const a = num(o.a, 0.005), h = num(o.h, 0), d = num(o.d, 0.25), pk = num(o.peak, 0.3);
  const end = t + a + h + d;
  const s = c.createOscillator();
  if (o.wave) s.setPeriodicWave(o.wave);
  else s.type = o.type || 'sine';
  s.frequency.setValueAtTime(f, t);
  if (o.f2) s.frequency.exponentialRampToValueAtTime(o.f2, t + num(o.glide, a + h + d));
  if (o.detune) s.detune.setValueAtTime(o.detune, t);
  if (o.vib) lfo(c, s.detune, t, end, o.vib[0], o.vib[1], o.vib[2]);
  const g = c.createGain();
  ahd(g.gain, t, pk, a, h, d);
  let src = s;
  if (o.lp) {
    const fl = c.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.value = o.lp;
    fl.Q.value = 0;
    s.connect(fl);
    src = fl;
  }
  src.connect(g);
  g.connect(out);
  s.start(t);
  s.stop(end + 0.02);
  return end + 0.02;
}

/**
 * Enveloped looping noise through a filter chain.
 * o: { color: 'pink'|'white'|'crackle', a, h, d, peak, hp (sub-bass cut Hz),
 *      f: [{type, f, q, to:[[freq, dt], ...]}] }
 * (q is the classic Q for bandpass, resonance in dB for lowpass/highpass.)
 */
function noise(c, out, t, o) {
  o = o || {};
  const a = num(o.a, 0.01), h = num(o.h, 0), d = num(o.d, 0.2), pk = num(o.peak, 0.3);
  const total = a + h + d;
  const B = buffers(c);
  const src = c.createBufferSource();
  src.buffer = B[o.color || 'pink'] || B.pink;
  src.loop = true;
  let node = src;
  if (o.hp) {
    const hpf = c.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = o.hp;
    hpf.Q.value = 0;
    node.connect(hpf);
    node = hpf;
  }
  if (o.f) {
    for (const fs of o.f) {
      const bq = c.createBiquadFilter();
      bq.type = fs.type;
      bq.Q.value = num(fs.q, fs.type === 'bandpass' ? 1 : 0);
      bq.frequency.setValueAtTime(fs.f, t);
      if (fs.to) for (const [fv, ft] of fs.to) bq.frequency.exponentialRampToValueAtTime(fv, t + ft);
      node.connect(bq);
      node = bq;
    }
  }
  const g = c.createGain();
  ahd(g.gain, t, pk, a, h, d);
  node.connect(g);
  g.connect(out);
  src.start(t, RND() * src.buffer.duration * 0.9);
  src.stop(t + total + 0.02);
  return t + total + 0.02;
}

function pannerAt(c, out, pan) {
  if (!c.createStereoPanner) return out;
  const p = c.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  p.connect(out);
  return p;
}

// Small inharmonic bell (sparkles, dings).
function bell(c, out, t, f, pk, d) {
  tone(c, out, t, f, { a: 0.002, d, peak: pk });
  if (f * 2.76 < 9500) tone(c, out, t, f * 2.76, { a: 0.0015, d: d * 0.4, peak: pk * 0.3 });
  if (f * 5.4 < 9500) tone(c, out, t, f * 5.4, { a: 0.001, d: d * 0.16, peak: pk * 0.1 });
}

// Kalimba tine: warm fundamental + short bright tine overtone.
function kalimba(c, out, t, f, vel, d) {
  vel = num(vel, 0.6);
  d = num(d, 0.9);
  tone(c, out, t, f, { a: 0.003, d, peak: 0.26 * vel });
  tone(c, out, t, f * 2.01, { a: 0.002, d: d * 0.25, peak: 0.035 * vel });
  if (f * 5.95 < 9500) tone(c, out, t, f * 5.95, { a: 0.0015, d: 0.07, peak: 0.07 * vel });
}

// Marimba bar: fundamental + quick 4th partial.
function marimba(c, out, t, f, vel, d) {
  tone(c, out, t, f, { a: 0.002, d: num(d, 0.45), peak: 0.28 * vel });
  tone(c, out, t, f * 3.93, { a: 0.001, d: Math.min(0.09, num(d, 0.45) * 0.3), peak: 0.07 * vel });
}

// Soft felt piano: harmonic wave + slightly detuned sine, closing lowpass, felt thump.
function piano(c, out, t, m, vel) {
  const f = hz(m);
  const W = waves(c);
  const d = clamp(2.6 * Math.pow(0.62, (m - 60) / 12), 0.6, 3.2);
  const g = c.createGain();
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0;
  lp.frequency.setValueAtTime(Math.min(7000, f * 4 + 1200 * vel), t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(320, f * 1.4), t + d * 0.8);
  const o1 = c.createOscillator();
  o1.setPeriodicWave(W.piano);
  o1.frequency.value = f;
  const o2 = c.createOscillator();
  o2.frequency.value = f;
  o2.detune.value = 4;
  const g2 = c.createGain();
  g2.gain.value = 0.45;
  o1.connect(lp);
  o2.connect(g2);
  g2.connect(lp);
  lp.connect(g);
  g.connect(out);
  const pk = 0.2 * vel;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(pk, t + 0.007);
  g.gain.exponentialRampToValueAtTime(pk * 0.5, t + 0.16);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o1.start(t);
  o2.start(t);
  o1.stop(t + d + 0.03);
  o2.stop(t + d + 0.03);
  noise(c, out, t, { a: 0.002, d: 0.035, peak: 0.035 * vel, f: [{ type: 'lowpass', f: 1100 }] });
}

// Slow soft pad chord (two detuned oscillators per note through one lowpass).
function pad(c, out, t, notes, dur, vel, bright) {
  const g = c.createGain();
  const lp = c.createBiquadFilter();
  const br = num(bright, 900);
  lp.type = 'lowpass';
  lp.Q.value = 0;
  lp.frequency.setValueAtTime(br * 0.6, t);
  lp.frequency.linearRampToValueAtTime(br, t + dur * 0.5);
  lp.frequency.linearRampToValueAtTime(br * 0.6, t + dur + 2.2);
  const a = Math.min(1.6, dur * 0.3), rel = 2.2;
  const pk = (0.085 * num(vel, 1)) / Math.max(1, notes.length);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(pk, t + a);
  g.gain.setValueAtTime(pk, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + rel);
  lp.connect(g);
  g.connect(out);
  for (const m of notes) {
    const f = hz(m);
    const o1 = c.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = f;
    o1.detune.value = -5;
    const o2 = c.createOscillator();
    o2.frequency.value = f;
    o2.detune.value = 6;
    o1.connect(lp);
    o2.connect(lp);
    o1.start(t);
    o2.start(t);
    o1.stop(t + dur + rel + 0.05);
    o2.stop(t + dur + rel + 0.05);
  }
}

function softBass(c, out, t, m, dur, vel) {
  tone(c, out, t, hz(m), { type: 'triangle', a: 0.06, h: dur * 0.25, d: dur, peak: 0.17 * vel, lp: 380 });
}

function kick(c, out, t, vel) {
  tone(c, out, t, 125, { f2: 50, glide: 0.1, a: 0.002, d: 0.26, peak: 0.5 * vel });
  tone(c, out, t, 250, { type: 'triangle', f2: 90, glide: 0.04, a: 0.001, d: 0.05, peak: 0.12 * vel });
}

function snare(c, out, t, vel) {
  noise(c, out, t, { color: 'white', a: 0.002, d: 0.12, peak: 0.24 * vel, f: [{ type: 'bandpass', f: 1800, q: 0.9 }] });
  tone(c, out, t, 220, { type: 'triangle', f2: 165, glide: 0.05, a: 0.001, d: 0.07, peak: 0.12 * vel });
}

function hat(c, out, t, vel, open) {
  noise(c, out, t, {
    color: 'white', a: 0.001, d: open ? 0.11 : 0.03, peak: 0.06 * vel,
    f: [{ type: 'highpass', f: 6500 }, { type: 'lowpass', f: 10500 }],
  });
}

function pluckBass(c, out, t, m, vel) {
  const f = hz(m);
  const o = c.createOscillator();
  o.type = 'square';
  o.frequency.value = f;
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 4;
  lp.frequency.setValueAtTime(f * 7, t);
  lp.frequency.exponentialRampToValueAtTime(f * 1.6, t + 0.18);
  const g = c.createGain();
  ahd(g.gain, t, 0.11 * vel, 0.004, 0.06, 0.18);
  o.connect(lp);
  lp.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + 0.27);
}

function stab(c, out, t, notes, vel) {
  const W = waves(c);
  const g = c.createGain();
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1500;
  lp.Q.value = 0;
  ahd(g.gain, t, (0.12 * vel) / notes.length, 0.006, 0.05, 0.13);
  lp.connect(g);
  g.connect(out);
  for (const m of notes) {
    const o = c.createOscillator();
    o.setPeriodicWave(W.organ);
    o.frequency.value = hz(m);
    o.connect(lp);
    o.start(t);
    o.stop(t + 0.21);
  }
}

// Rounded brass: two detuned saws, opening/closing lowpass (fanfares).
function brass(c, out, t, f, dur, pk) {
  const g = c.createGain();
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1;
  lp.frequency.setValueAtTime(f * 1.3, t);
  lp.frequency.linearRampToValueAtTime(Math.min(6500, f * 5), t + 0.04);
  lp.frequency.linearRampToValueAtTime(Math.min(4200, f * 3), t + 0.04 + Math.min(0.25, dur));
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(pk, t + 0.02);
  g.gain.linearRampToValueAtTime(pk * 0.72, t + 0.02 + Math.min(0.12, dur * 0.5));
  g.gain.setValueAtTime(pk * 0.72, t + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.18);
  lp.connect(g);
  g.connect(out);
  for (const det of [-6, 6]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.detune.value = det;
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.2);
  }
  return t + dur + 0.2;
}

function timpani(c, out, t, f, vel) {
  tone(c, out, t, f, { f2: f * 0.93, glide: 0.5, a: 0.003, d: 0.9, peak: 0.3 * vel });
  tone(c, out, t, f * 1.5, { a: 0.003, d: 0.35, peak: 0.08 * vel });
  noise(c, out, t, { a: 0.002, d: 0.08, peak: 0.2 * vel, f: [{ type: 'lowpass', f: 600 }] });
}

// Hollow wooden "tok" (ladder taps, bone clacks).
function woodTap(c, out, t, f, vel) {
  tone(c, out, t, f, { type: 'triangle', f2: f * 0.8, glide: 0.04, a: 0.001, d: 0.07, peak: 0.3 * vel });
  tone(c, out, t, f * 2.7, { a: 0.001, d: 0.025, peak: 0.06 * vel });
  noise(c, out, t, { color: 'white', a: 0.001, d: 0.015, peak: 0.16 * vel, f: [{ type: 'bandpass', f: 2100, q: 2.5 }] });
}

// ---------------------------------------------------------------------------
// Sound effects. fn(ctx, out, t, p) schedules nodes into `out` starting at t
// and returns the duration in seconds. p = { pitch, volume, pan, r() }.
// dur = upper bound used for offline render windows.
// gain = per-sound loudness calibration (applied on the voice input).
// rev = reverb send, prio = voice-steal priority, duck = [musicLevel, holdSec].
// All tonal SFX are locked to C major pentatonic (the calm / victory key).
// ---------------------------------------------------------------------------
const C_PENTA_HI = [84, 86, 88, 91, 93, 96]; // C6 D6 E6 G6 A6 C7

const SFX = {
  // Hero throws a heart: airy "fwip" + cute rising blip.
  throw: {
    dur: 0.32, gain: 1.7, rev: 0.12, prio: 1, throttle: 45,
    fn(c, o, t, p) {
      const k = p.pitch;
      noise(c, o, t, { a: 0.02, d: 0.2, peak: 0.9, f: [{ type: 'bandpass', f: 650 * k, q: 1.3, to: [[2600 * k, 0.17]] }] });
      tone(c, o, t + 0.01, 520 * k, { type: 'triangle', f2: 940 * k, glide: 0.08, a: 0.005, d: 0.13, peak: 0.16 });
      return 0.3;
    },
  },

  // Heart lands on a mob: squishy "boop-pop" (opts.pitch rises toward befriend).
  heartHit: {
    dur: 0.32, gain: 1, rev: 0.15, prio: 2, throttle: 40,
    fn(c, o, t, p) {
      const k = p.pitch, f = 587.33 * k;
      tone(c, o, t, f * 0.8, { f2: f * 1.1, glide: 0.06, a: 0.003, d: 0.2, peak: 0.42 });
      tone(c, o, t, f * 1.6, { type: 'triangle', f2: f * 2.2, glide: 0.06, a: 0.003, d: 0.08, peak: 0.08 });
      noise(c, o, t, { color: 'white', a: 0.001, d: 0.03, peak: 0.3, f: [{ type: 'bandpass', f: 2200, q: 1.2 }] });
      bell(c, o, t + 0.05, f * 2, 0.05, 0.18);
      return 0.27;
    },
  },

  // Mob becomes a friend: pop + happy kalimba arpeggio C-E-G-C + sparkle.
  befriend: {
    dur: 1.15, gain: 1, rev: 0.3, prio: 3, throttle: 90, duck: [0.7, 0.7],
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 330 * k, { f2: 660 * k, glide: 0.05, a: 0.003, d: 0.09, peak: 0.22 });
      [72, 76, 79, 84].forEach((m, i) => kalimba(c, o, t + 0.04 + i * 0.075, hz(m) * k, 0.6 + i * 0.1, 0.45 + i * 0.18));
      [60, 64, 67].forEach((m) => tone(c, o, t + 0.27, hz(m) * k, { type: 'triangle', a: 0.04, h: 0.12, d: 0.55, peak: 0.05 }));
      bell(c, o, t + 0.36, hz(91) * k, 0.05, 0.5);
      bell(c, o, t + 0.44, hz(96) * k, 0.04, 0.5);
      return 1.05;
    },
  },

  // Zombie: low "uuh-oh" groan = formant-filtered saw with a little vocal fry.
  zombie: {
    dur: 0.85, gain: 1.25, rev: 0.12, prio: 0, throttle: 250,
    fn(c, o, t, p) {
      const k = p.pitch * (0.93 + p.r() * 0.14);
      const dur = 0.66 + p.r() * 0.1;
      const src = c.createOscillator();
      src.type = 'sawtooth';
      src.frequency.setValueAtTime(100 * k, t);
      src.frequency.linearRampToValueAtTime(120 * k, t + dur * 0.35);
      src.frequency.linearRampToValueAtTime(88 * k, t + dur);
      lfo(c, src.detune, t, t + dur, 5.2, 22);
      const env = c.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(1, t + 0.09);
      env.gain.setValueAtTime(1, t + dur - 0.22);
      env.gain.linearRampToValueAtTime(0, t + dur);
      const fry = c.createGain();
      fry.gain.value = 0.8;
      lfo(c, fry.gain, t, t + dur, 27, 0.2);
      const forms = [[620, 430, 1.0, 7], [1050, 800, 0.5, 8], [2500, 2300, 0.1, 9]];
      for (const [f0, f1, gg, q] of forms) {
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = q;
        bp.frequency.setValueAtTime(f0, t);
        bp.frequency.linearRampToValueAtTime(f1, t + dur);
        const fg = c.createGain();
        fg.gain.value = gg;
        src.connect(bp);
        bp.connect(fg);
        fg.connect(fry);
      }
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      lp.Q.value = 0;
      fry.connect(env);
      env.connect(lp);
      lp.connect(o);
      src.start(t);
      src.stop(t + dur + 0.03);
      noise(c, o, t, { a: 0.1, h: dur - 0.32, d: 0.2, peak: 0.06, f: [{ type: 'bandpass', f: 700, q: 1.2 }] });
      return dur + 0.05;
    },
  },

  // Skeleton: hollow wooden bone-rattle clicks.
  skeleton: {
    dur: 0.56, gain: 1.7, rev: 0.15, prio: 0, throttle: 180,
    fn(c, o, t, p) {
      const k = p.pitch;
      const n = 6 + Math.floor(p.r() * 3);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const f = (1050 + p.r() * 800) * k, v = 1 - (i / n) * 0.55;
        tone(c, o, tt, f, { type: 'triangle', f2: f * 0.82, glide: 0.035, a: 0.001, d: 0.05, peak: 0.25 * v });
        tone(c, o, tt, f * 2.3, { a: 0.0005, d: 0.018, peak: 0.06 * v });
        noise(c, o, tt, { color: 'white', a: 0.0005, d: 0.01, peak: 0.25 * v, f: [{ type: 'bandpass', f: 2800 * k, q: 3 }] });
        tt += 0.028 + p.r() * 0.03;
      }
      return tt - t + 0.06;
    },
  },

  // Spider: mandible clicks + chittering band-passed hiss.
  spider: {
    dur: 0.55, gain: 3.4, rev: 0.1, prio: 0, throttle: 200,
    fn(c, o, t, p) {
      const k = p.pitch;
      for (let i = 0; i < 3; i++) {
        tone(c, o, t + i * 0.045, 1700 * k, { type: 'triangle', f2: 1300 * k, glide: 0.02, a: 0.001, d: 0.025, peak: 0.12 });
      }
      const am = c.createGain();
      am.gain.value = 0.6;
      const l = c.createOscillator();
      l.type = 'triangle';
      l.frequency.setValueAtTime(24, t);
      l.frequency.linearRampToValueAtTime(34, t + 0.45);
      const lg = c.createGain();
      lg.gain.value = 0.4;
      l.connect(lg);
      lg.connect(am.gain);
      l.start(t);
      l.stop(t + 0.53);
      am.connect(o);
      noise(c, am, t + 0.1, {
        a: 0.04, h: 0.12, d: 0.25, peak: 0.5,
        f: [{ type: 'bandpass', f: 2600 * k, q: 2.2, to: [[3400 * k, 0.4]] }, { type: 'lowpass', f: 6000 }],
      });
      return 0.53;
    },
  },

  // Creeper fuse: rising sizzle (~1.6 s) with sparks and a playful wobble.
  // play() returns a handle: call handle.stop() when the creeper is befriended.
  creeperFuse: {
    dur: 1.68, gain: 1.8, rev: 0.1, prio: 2, throttle: 250, duck: [0.75, 1.6],
    fn(c, o, t, p) {
      const k = p.pitch, dur = 1.6;
      noise(c, o, t, { a: dur - 0.12, d: 0.1, peak: 0.42, f: [{ type: 'bandpass', f: 1400 * k, q: 1.3, to: [[4800 * k, dur]] }] });
      noise(c, o, t, { color: 'crackle', a: dur - 0.1, d: 0.08, peak: 0.35, f: [{ type: 'highpass', f: 1800 }] });
      tone(c, o, t, 260 * k, { type: 'triangle', f2: 780 * k, glide: dur, a: dur - 0.1, d: 0.08, peak: 0.06, vib: [7, 40, 90] });
      return dur + 0.02;
    },
  },

  // Creeper pops into confetti + flowers: cork pop, soft fwump, rustle, sparkles.
  creeperPop: {
    dur: 1.25, gain: 1, rev: 0.28, prio: 2, throttle: 120, duck: [0.75, 0.5],
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 560 * k, { f2: 150 * k, glide: 0.07, a: 0.002, d: 0.13, peak: 0.5 });
      noise(c, o, t, { a: 0.003, d: 0.2, peak: 0.9, f: [{ type: 'lowpass', f: 2200, q: 0.8, to: [[450, 0.2]] }] });
      noise(c, o, t + 0.05, {
        color: 'white', a: 0.02, d: 0.5, peak: 0.12,
        f: [{ type: 'highpass', f: 3500 }, { type: 'lowpass', f: 8000 }],
      });
      for (let i = 0; i < 7; i++) {
        const m = C_PENTA_HI[Math.floor(p.r() * C_PENTA_HI.length)];
        bell(c, pannerAt(c, o, p.r() * 1.6 - 0.8), t + 0.08 + i * 0.085 + p.r() * 0.04, hz(m) * k, 0.06, 0.35);
      }
      return 1.05;
    },
  },

  // Breeze fires a wind charge: puff thump + airy swirl + whistle.
  breezeShoot: {
    dur: 0.5, gain: 1.25, rev: 0.18, prio: 1, throttle: 100,
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 190 * k, { f2: 95 * k, glide: 0.08, a: 0.004, d: 0.12, peak: 0.3 });
      noise(c, o, t, { a: 0.03, d: 0.32, peak: 1.0, f: [{ type: 'bandpass', f: 450 * k, q: 2.4, to: [[1700 * k, 0.12], [900 * k, 0.35]] }] });
      tone(c, o, t + 0.02, 880 * k, { f2: 1480 * k, glide: 0.18, a: 0.03, d: 0.26, peak: 0.07, vib: [9, 45] });
      return 0.45;
    },
  },

  // Hero launched by wind: spring "boing" rising + upward whoosh ("wheee").
  windLaunch: {
    dur: 0.95, gain: 1, rev: 0.2, prio: 2, throttle: 200, duck: [0.8, 0.5],
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 150 * k, { type: 'triangle', f2: 620 * k, glide: 0.45, a: 0.006, h: 0.1, d: 0.5, peak: 0.28, vib: [15, 140, 15] });
      tone(c, o, t, 300 * k, { f2: 1240 * k, glide: 0.45, a: 0.006, d: 0.35, peak: 0.07, vib: [15, 140, 15] });
      noise(c, o, t, { a: 0.1, d: 0.65, peak: 0.85, f: [{ type: 'bandpass', f: 320 * k, q: 1.2, to: [[2600 * k, 0.6]] }] });
      return 0.9;
    },
  },

  // Iron golem footstep: heavy but soft thump (limited sub-bass) + stone clack.
  // Most energy sits at 120-700 Hz so it still reads on tablet speakers.
  golemStep: {
    dur: 0.35, gain: 1, rev: 0.15, prio: 1, throttle: 150,
    fn(c, o, t, p) {
      const k = p.pitch * (0.95 + p.r() * 0.1);
      tone(c, o, t, 84 * k, { f2: 60 * k, glide: 0.05, a: 0.004, d: 0.2, peak: 0.3 });
      tone(c, o, t, 170 * k, { type: 'triangle', f2: 130 * k, glide: 0.04, a: 0.003, d: 0.12, peak: 0.3 });
      noise(c, o, t, { a: 0.002, d: 0.14, peak: 0.65, hp: 90, f: [{ type: 'lowpass', f: 950, to: [[260, 0.13]] }] });
      noise(c, o, t, { a: 0.001, d: 0.06, peak: 0.22, f: [{ type: 'bandpass', f: 650, q: 1.8 }] });
      noise(c, o, t, { color: 'white', a: 0.001, d: 0.03, peak: 0.1, f: [{ type: 'bandpass', f: 1150, q: 3 }] });
      return 0.3;
    },
  },

  // Golem ground slam: deep friendly thud + wooden "tonk" + dust + pebbles.
  golemSlam: {
    dur: 1.15, gain: 1, rev: 0.25, prio: 2, throttle: 300, duck: [0.7, 0.6],
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 118 * k, { f2: 48 * k, glide: 0.3, a: 0.004, d: 0.55, peak: 0.4 });
      tone(c, o, t, 240 * k, { type: 'triangle', f2: 96 * k, glide: 0.22, a: 0.003, d: 0.3, peak: 0.34 });
      noise(c, o, t, { a: 0.003, d: 0.5, peak: 0.95, hp: 80, f: [{ type: 'lowpass', f: 1150, to: [[200, 0.45]] }] });
      noise(c, o, t + 0.01, { a: 0.004, d: 0.32, peak: 0.32, f: [{ type: 'bandpass', f: 520, q: 1.1, to: [[300, 0.3]] }] });
      noise(c, o, t + 0.04, { a: 0.06, d: 0.75, peak: 0.22, hp: 110, f: [{ type: 'bandpass', f: 340, q: 0.8 }] });
      marimba(c, o, t + 0.01, hz(55) * k, 0.6, 0.5);
      for (let i = 0; i < 4; i++) {
        const f = (1300 + p.r() * 1200) * k;
        tone(c, o, t + 0.12 + p.r() * 0.4, f, { type: 'triangle', f2: f * 0.8, glide: 0.02, a: 0.001, d: 0.03, peak: 0.06 });
      }
      return 0.9;
    },
  },

  // Hero gets bonked: cartoon "bonk" + spring wobble + dizzy twinkles (no voice).
  hurt: {
    dur: 0.72, gain: 1, rev: 0.12, prio: 3, throttle: 250, duck: [0.75, 0.35],
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 720 * k, { type: 'triangle', f2: 290 * k, glide: 0.1, a: 0.002, d: 0.17, peak: 0.45 });
      tone(c, o, t, 1450 * k, { f2: 900 * k, glide: 0.05, a: 0.001, d: 0.05, peak: 0.12 });
      noise(c, o, t, { color: 'white', a: 0.001, d: 0.035, peak: 0.35, f: [{ type: 'bandpass', f: 1700, q: 1.8 }] });
      tone(c, o, t + 0.08, 330 * k, { type: 'triangle', f2: 250 * k, glide: 0.35, a: 0.01, d: 0.36, peak: 0.14, vib: [17, 120, 20], lp: 1800 });
      bell(c, o, t + 0.26, hz(88) * k, 0.045, 0.25);
      bell(c, o, t + 0.38, hz(84) * k, 0.04, 0.25);
      return 0.66;
    },
  },

  // Soft cloud puff (hero poof / respawn, mob vanish).
  poof: {
    dur: 0.62, gain: 1, rev: 0.25, prio: 2, throttle: 200, duck: [0.8, 0.4],
    fn(c, o, t, p) {
      const k = p.pitch;
      noise(c, o, t, { a: 0.008, d: 0.45, peak: 1.0, f: [{ type: 'lowpass', f: 2400 * k, q: 0.6, to: [[330, 0.45]] }] });
      noise(c, o, t, { a: 0.004, d: 0.12, peak: 0.35, f: [{ type: 'bandpass', f: 900 * k, q: 1 }] });
      tone(c, o, t, 260 * k, { f2: 110 * k, glide: 0.16, a: 0.004, d: 0.2, peak: 0.24 });
      bell(c, o, t + 0.14, hz(93) * k, 0.035, 0.3);
      return 0.48;
    },
  },

  // Chest: wooden hinge creak (stick-slip) + lid thunk + treasure "bling".
  chestOpen: {
    dur: 1.35, gain: 1.25, rev: 0.25, prio: 2, throttle: 300, duck: [0.75, 0.9],
    fn(c, o, t, p) {
      const k = p.pitch;
      const W = waves(c);
      const cd = 0.42;
      const s = c.createOscillator();
      s.setPeriodicWave(W.creak);
      const N = 24;
      const curve = new Float32Array(N);
      let f = 62;
      for (let i = 0; i < N; i++) {
        f = clamp(f + (p.r() - 0.45) * 14, 45, 95);
        curve[i] = f * k;
      }
      s.frequency.setValueCurveAtTime(curve, t, cd);
      const b1 = c.createBiquadFilter();
      b1.type = 'bandpass';
      b1.frequency.value = 950;
      b1.Q.value = 4;
      const b2 = c.createBiquadFilter();
      b2.type = 'bandpass';
      b2.frequency.value = 1700;
      b2.Q.value = 5;
      const g = c.createGain();
      ahd(g.gain, t, 0.5, 0.05, cd - 0.15, 0.1);
      s.connect(b1);
      s.connect(b2);
      b1.connect(g);
      b2.connect(g);
      g.connect(o);
      s.start(t);
      s.stop(t + cd + 0.05);
      tone(c, o, t + cd, 210 * k, { type: 'triangle', f2: 150 * k, glide: 0.06, a: 0.002, d: 0.1, peak: 0.3 });
      noise(c, o, t + cd, { a: 0.002, d: 0.06, peak: 0.3, f: [{ type: 'lowpass', f: 900 }] });
      [79, 84, 88, 91].forEach((m, i) => bell(c, o, t + cd + 0.05 + i * 0.05, hz(m) * k, 0.09, 0.6));
      [72, 76, 79].forEach((m) => tone(c, o, t + cd + 0.1, hz(m) * k, { a: 0.05, h: 0.1, d: 0.6, peak: 0.04 }));
      return cd + 0.87;
    },
  },

  // Loot pickup: bloop + two-note kalimba "ding-ding".
  pickup: {
    dur: 0.52, gain: 1.25, rev: 0.2, prio: 2, throttle: 50,
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 420 * k, { f2: 840 * k, glide: 0.05, a: 0.003, d: 0.07, peak: 0.18 });
      kalimba(c, o, t + 0.02, hz(84) * k, 0.65, 0.3);
      kalimba(c, o, t + 0.085, hz(91) * k, 0.65, 0.4);
      return 0.5;
    },
  },

  // XP orb: short glassy Minecraft-like "ding" (opts.pitch rises per orb).
  xp: {
    dur: 0.4, gain: 1.25, rev: 0.18, prio: 1, throttle: 40,
    fn(c, o, t, p) {
      const k = Math.min(2.4, p.pitch) * (0.98 + p.r() * 0.04);
      const f = 1046.5 * k;
      tone(c, o, t, f, { a: 0.002, d: 0.32, peak: 0.26 });
      tone(c, o, t, f * 2, { a: 0.002, d: 0.12, peak: 0.06 });
      tone(c, o, t, f * 3.01, { a: 0.001, d: 0.05, peak: 0.025 });
      return 0.35;
    },
  },

  // Heart bomb: big swelling whoosh + soft boom + shimmering chord + sparkle cascade.
  heartBomb: {
    dur: 1.5, gain: 1, rev: 0.35, prio: 3, throttle: 500, duck: [0.55, 1.1],
    fn(c, o, t, p) {
      const k = p.pitch;
      noise(c, o, t, { a: 0.3, d: 0.9, peak: 0.9, f: [{ type: 'bandpass', f: 260, q: 1.1, to: [[3200, 0.32], [900, 1.1]] }] });
      tone(c, o, t + 0.27, 150 * k, { f2: 56 * k, glide: 0.25, a: 0.004, d: 0.5, peak: 0.42 });
      [84, 88, 91, 98].forEach((m) => {
        tone(c, o, t + 0.28, hz(m) * k, { a: 0.04, d: 1.1, peak: 0.045, vib: [6.5, 12] });
        tone(c, o, t + 0.28, hz(m) * k * 1.004, { a: 0.04, d: 1.0, peak: 0.035 });
      });
      [96, 93, 91, 88, 86, 84, 81, 79].forEach((m, i) => {
        bell(c, pannerAt(c, o, i % 2 ? 0.5 : -0.5), t + 0.32 + i * 0.055, hz(m) * k, 0.06, 0.4);
      });
      return 1.45;
    },
  },

  // Floor cleared: short brass fanfare G-C-E-G(long) over a C chord + shimmer.
  floorClear: {
    dur: 1.35, gain: 1, rev: 0.3, prio: 3, throttle: 800, duck: [0.45, 1.3],
    fn(c, o, t, p) {
      const k = p.pitch;
      const mel = [[67, 0.0, 0.1], [72, 0.11, 0.1], [76, 0.22, 0.1], [79, 0.33, 0.7]];
      for (const [m, dt, du] of mel) {
        brass(c, o, t + dt, hz(m) * k, du, 0.16);
        kalimba(c, o, t + dt, hz(m + 12) * k, 0.4, 0.4);
      }
      for (const m of [60, 64, 67]) brass(c, o, t + 0.33, hz(m) * k, 0.7, 0.07);
      tone(c, o, t + 0.33, hz(48) * k, { type: 'triangle', a: 0.01, h: 0.4, d: 0.5, peak: 0.16, lp: 500 });
      noise(c, o, t + 0.33, {
        color: 'white', a: 0.05, d: 0.9, peak: 0.06,
        f: [{ type: 'highpass', f: 5000 }, { type: 'lowpass', f: 10000 }],
      });
      [91, 96].forEach((m, i) => bell(c, o, t + 0.45 + i * 0.08, hz(m) * k, 0.05, 0.5));
      return 1.3;
    },
  },

  // Ladder climbing: four hollow wooden taps (call again to keep climbing).
  climb: {
    dur: 0.5, gain: 1.95, rev: 0.12, prio: 1, throttle: 90,
    fn(c, o, t, p) {
      const k = p.pitch;
      for (let i = 0; i < 4; i++) {
        const f = (600 + (i % 2) * 90 + p.r() * 60) * k;
        woodTap(c, pannerAt(c, o, i % 2 ? 0.25 : -0.25), t + i * 0.11, f, 1 - i * 0.12);
      }
      return 0.45;
    },
  },

  // Spawner telegraph: flame fwoosh + crackle + magic rise + final puff.
  spawnPuff: {
    dur: 0.85, gain: 1.35, rev: 0.22, prio: 1, throttle: 120,
    fn(c, o, t, p) {
      const k = p.pitch;
      noise(c, o, t, { a: 0.1, d: 0.6, peak: 0.75, f: [{ type: 'bandpass', f: 520 * k, q: 1.4, to: [[1250 * k, 0.22], [480 * k, 0.65]] }] });
      noise(c, o, t + 0.03, { color: 'crackle', a: 0.05, h: 0.25, d: 0.3, peak: 0.28, f: [{ type: 'bandpass', f: 2600, q: 0.9 }] });
      tone(c, o, t, hz(67) * k, { f2: hz(74) * k, glide: 0.45, a: 0.12, d: 0.45, peak: 0.05, vib: [8, 25] });
      tone(c, o, t + 0.55, 210 * k, { f2: 100 * k, glide: 0.12, a: 0.004, d: 0.18, peak: 0.2 });
      noise(c, o, t + 0.55, { a: 0.005, d: 0.2, peak: 0.4, f: [{ type: 'lowpass', f: 1400, to: [[400, 0.2]] }] });
      return 0.8;
    },
  },

  // Bow shot: soft string twang + airy arrow "fwip".
  arrowShoot: {
    dur: 0.36, gain: 1.25, rev: 0.12, prio: 1, throttle: 70,
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 205 * k, { type: 'triangle', f2: 188 * k, glide: 0.18, a: 0.002, d: 0.24, peak: 0.3, vib: [24, 30, 0], lp: 1600 });
      tone(c, o, t, 410 * k, { a: 0.002, d: 0.1, peak: 0.08 });
      noise(c, o, t + 0.012, {
        a: 0.006, d: 0.09, peak: 0.45,
        f: [{ type: 'bandpass', f: 1600 * k, q: 2, to: [[3800 * k, 0.09]] }, { type: 'lowpass', f: 6000 }],
      });
      return 0.3;
    },
  },

  // Firework: rising whistle, soft pop, crackle, sparkles (random stereo spot).
  fireworks: {
    dur: 1.5, gain: 1, rev: 0.35, prio: 1, throttle: 80, panJitter: 0.6,
    fn(c, o, t, p) {
      const k = p.pitch * (0.9 + p.r() * 0.2);
      tone(c, o, t, 520 * k, { f2: 1500 * k, glide: 0.42, a: 0.06, h: 0.26, d: 0.12, peak: 0.07, vib: [11, 18] });
      noise(c, o, t, { a: 0.08, h: 0.25, d: 0.12, peak: 0.12, f: [{ type: 'bandpass', f: 2800, q: 1.2 }] });
      const tb = t + 0.46;
      tone(c, o, tb, 320 * k, { f2: 95 * k, glide: 0.1, a: 0.002, d: 0.16, peak: 0.36 });
      noise(c, o, tb, { a: 0.002, d: 0.3, peak: 0.6, f: [{ type: 'lowpass', f: 2200, q: 0.7, to: [[380, 0.3]] }] });
      noise(c, o, tb + 0.04, { color: 'crackle', a: 0.05, h: 0.2, d: 0.6, peak: 0.4, f: [{ type: 'bandpass', f: 3000, q: 0.8 }] });
      const notes = [84, 88, 91, 93, 96];
      for (let i = 0; i < 5; i++) {
        bell(c, pannerAt(c, o, p.r() * 1.4 - 0.7), tb + 0.05 + p.r() * 0.55, hz(notes[i]) * k, 0.045, 0.4);
      }
      return 1.42;
    },
  },

  // UI button: soft "plip".
  uiTap: {
    dur: 0.14, gain: 1.45, rev: 0.05, prio: 3, throttle: 60,
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 880 * k, { f2: 1320 * k, glide: 0.035, a: 0.002, d: 0.09, peak: 0.3 });
      tone(c, o, t, 1760 * k, { a: 0.001, d: 0.03, peak: 0.05 });
      return 0.11;
    },
  },

  // ---- Optional extras (not required by the spec; free to use) ----
  // Soft landing after a wind launch.
  land: {
    dur: 0.26, gain: 1, rev: 0.1, prio: 1, throttle: 120,
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 150 * k, { f2: 95 * k, glide: 0.045, a: 0.003, d: 0.14, peak: 0.35 });
      noise(c, o, t, { a: 0.002, d: 0.12, peak: 0.45, f: [{ type: 'lowpass', f: 900, to: [[250, 0.1]] }] });
      return 0.2;
    },
  },

  // Golden apple / hearts restored: rising shimmering run.
  heal: {
    dur: 0.95, gain: 1, rev: 0.3, prio: 2, throttle: 200, duck: [0.8, 0.5],
    fn(c, o, t, p) {
      const k = p.pitch;
      [72, 76, 79, 83, 84].forEach((m, i) => kalimba(c, o, t + i * 0.06, hz(m) * k, 0.5 + i * 0.06, 0.5));
      [84, 88, 91].forEach((m) => tone(c, o, t + 0.3, hz(m) * k, { a: 0.05, d: 0.55, peak: 0.035, vib: [6, 10] }));
      return 0.92;
    },
  },

  // Creeper defused before popping: fizzle-out + happy two notes.
  defuse: {
    dur: 0.85, gain: 1.25, rev: 0.2, prio: 2, throttle: 200,
    fn(c, o, t, p) {
      const k = p.pitch;
      noise(c, o, t, { a: 0.005, d: 0.3, peak: 0.4, f: [{ type: 'bandpass', f: 3500, q: 1.2, to: [[700, 0.3]] }] });
      kalimba(c, o, t + 0.2, hz(79) * k, 0.6, 0.4);
      kalimba(c, o, t + 0.32, hz(84) * k, 0.7, 0.5);
      return 0.84;
    },
  },

  // A big pixel star pops in (opts.pitch 1 / 1.12 / 1.26 for stars 1-3).
  star: {
    dur: 0.65, gain: 1.3, rev: 0.3, prio: 2, throttle: 60,
    fn(c, o, t, p) {
      const k = p.pitch;
      tone(c, o, t, 300 * k, { f2: 900 * k, glide: 0.06, a: 0.003, d: 0.1, peak: 0.2 });
      bell(c, o, t + 0.03, hz(84) * k, 0.1, 0.55);
      bell(c, o, t + 0.03, hz(91) * k, 0.05, 0.5);
      return 0.6;
    },
  },

  // Friend hop to the beat.
  hop: {
    dur: 0.2, gain: 1.5, rev: 0.08, prio: 0, throttle: 60,
    fn(c, o, t, p) {
      const k = p.pitch * (0.9 + p.r() * 0.2);
      tone(c, o, t, 300 * k, { type: 'triangle', f2: 620 * k, glide: 0.09, a: 0.003, d: 0.12, peak: 0.18 });
      return 0.15;
    },
  },

  // Generic sparkle (poppy, trophy, beam).
  sparkle: {
    dur: 0.8, gain: 1.8, rev: 0.35, prio: 1, throttle: 120,
    fn(c, o, t, p) {
      const k = p.pitch;
      const notes = [88, 91, 93, 96, 98];
      for (let i = 0; i < 5; i++) {
        bell(c, pannerAt(c, o, p.r() * 1.2 - 0.6), t + i * 0.07 + p.r() * 0.03, hz(notes[i]) * k, 0.04, 0.35);
      }
      return 0.76;
    },
  },

  // Friend hugs a grumpy mob: soft squish + warm two-note.
  hug: {
    dur: 0.45, gain: 1.3, rev: 0.15, prio: 1, throttle: 120,
    fn(c, o, t, p) {
      const k = p.pitch;
      noise(c, o, t, { a: 0.03, d: 0.18, peak: 0.25, f: [{ type: 'lowpass', f: 900 }] });
      tone(c, o, t + 0.02, 440 * k, { type: 'triangle', f2: 520 * k, glide: 0.1, a: 0.01, d: 0.18, peak: 0.16 });
      tone(c, o, t + 0.14, 660 * k, { a: 0.005, d: 0.25, peak: 0.13 });
      return 0.42;
    },
  },
};

// ---------------------------------------------------------------------------
// Music tracks (scheduled on the audio clock with lookahead)
// ---------------------------------------------------------------------------

// Calm: C418-style ambient felt piano / kalimba random walk over soft pads.
const PENTA = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]; // C4..C6 major pentatonic
const SPARK = [84, 86, 88, 91, 93];
const CALM_PROGS = [
  // [bass midi, pad notes]: Cmaj9, Am7, Fmaj7, G6sus2
  [[48, [55, 59, 62, 64]], [45, [52, 55, 60, 64]], [41, [53, 57, 60, 64]], [43, [55, 57, 62, 64]]],
  // Fmaj7, Em7, Dm7, G
  [[41, [53, 57, 60, 64]], [40, [52, 55, 59, 62]], [38, [53, 57, 60, 62]], [43, [55, 59, 62, 67]]],
];
const CALM_TPL = [
  [1, 0, 0, 0, 1, 0, 0, 0],
  [1, 0, 0, 1, 0, 0, 1, 0],
  [1, 0, 1, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 1, 0, 0, 0],
  [1, 0, 0, 0, 0, 0, 1, 1],
  [1, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 1, 0],
];
const CALM_END = [
  [1, 0, 0, 0, 0, 0, 0, 0],
  [1, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, 0, 0],
];
const REST = [0, 0, 0, 0, 0, 0, 0, 0];

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

function walk(r, i) {
  const n = PENTA.length;
  const x = r();
  let st = x < 0.12 ? -2 : x < 0.44 ? -1 : x < 0.5 ? 0 : x < 0.82 ? 1 : x < 0.94 ? 2 : r() < 0.5 ? -3 : 3;
  const center = 5;
  if ((i - center) * st > 0 && Math.abs(i - center) >= 3 && r() < 0.55) st = -st; // drift home
  let j = i + st;
  if (j < 0) j = -j;
  if (j > n - 1) j = 2 * (n - 1) - j;
  return clamp(j, 0, n - 1);
}

function snapIdx(i, pcs) {
  for (const dl of [0, -1, 1, -2, 2]) {
    const j = i + dl;
    if (j >= 0 && j < PENTA.length && pcs.has(PENTA[j] % 12)) return j;
  }
  return i;
}

function calmStep(P, s, t) {
  const c = P.c, out = P.gain, r = P.rng, S = P.st, sd = P.sd;
  const inChord = s % 16, chordNo = Math.floor(s / 16), section = Math.floor(s / 64);
  const ch = CALM_PROGS[section % 3 === 2 ? 1 : 0][chordNo % 4];
  if (inChord === 0) {
    pad(c, out, t, ch[1], sd * 16 + 0.15, 1, 950);
    softBass(c, out, t, ch[0], sd * 10, 1);
    S.pcs = new Set([ch[0] % 12].concat(ch[1].map((m) => m % 12)));
  } else if (inChord === 8 && r() < 0.45) {
    softBass(c, out, t, ch[0] + 12, sd * 6, 0.5);
  }
  const bar = Math.floor(s / 8), inBar = s % 8;
  if (inBar === 0) {
    S.tpl = bar % 16 === 15 ? REST : bar % 4 === 3 ? pick(r, CALM_END) : pick(r, CALM_TPL);
  }
  const kal = section % 2 === 1; // alternate piano / kalimba sections
  if (S.tpl[inBar]) {
    S.idx = walk(r, S.idx);
    if (inChord === 0 || (inBar === 0 && r() < 0.6)) S.idx = snapIdx(S.idx, S.pcs);
    const m = PENTA[S.idx];
    const vel = (inBar === 0 ? 0.75 : 0.55) + r() * 0.15;
    const tt = t + r() * 0.012; // tiny human timing
    if (kal) kalimba(c, out, tt, hz(m), vel * 0.85, 1.3);
    else piano(c, out, tt, m, vel);
    if (S.idx >= 2 && r() < 0.16) {
      const m2 = PENTA[S.idx - 2];
      if (kal) kalimba(c, out, tt + 0.015, hz(m2), vel * 0.5, 1.1);
      else piano(c, out, tt + 0.015, m2, vel * 0.55);
    }
  } else if (r() < 0.045) {
    kalimba(c, out, t, hz(pick(r, SPARK)), 0.22, 1.1);
  }
}

// Boss: bouncy G-major groove (soft kick / clap / shaker hats, plucky octave
// bass, organ stabs, marimba hook), still friendly.
const BOSS_CHORDS = [
  [43, [59, 62, 67]], // G
  [40, [59, 64, 67]], // Em
  [48, [60, 64, 67]], // C
  [50, [62, 66, 69]], // D
];
const BOSS_BASS = [0, null, 12, 0, 7, null, 12, null];
const BOSS_ARP = [0, 1, 2, 1, 2, 1, 0, 2];
const BOSS_ORDER = ['A', 'A2', 'B', 'A', 'brk', 'B', 'A2'];
const BOSS_MEL = {
  A: [
    [74, 0, 71, 74, 76, 0, 74, 0],
    [71, 0, 69, 71, 67, 0, 0, 0],
    [76, 0, 74, 76, 79, 0, 76, 74],
    [74, 0, 0, 69, 71, 0, 69, 0],
  ],
  A2: [
    [74, 0, 71, 74, 76, 0, 79, 0],
    [76, 0, 74, 71, 74, 0, 0, 0],
    [76, 74, 72, 74, 76, 0, 79, 0],
    [81, 0, 79, 76, 74, 0, 0, 0],
  ],
  B: [
    [79, 0, 79, 81, 79, 0, 76, 0],
    [74, 0, 76, 0, 71, 0, 0, 0],
    [72, 0, 76, 0, 79, 0, 81, 0],
    [78, 0, 76, 0, 74, 0, 0, 0],
  ],
};

function bossStep(P, s, t) {
  const c = P.c, out = P.gain, r = P.rng;
  const bar = Math.floor(s / 8), inBar = s % 8, phrase = Math.floor(bar / 4), bip = bar % 4;
  const sec = phrase === 0 ? 'intro' : BOSS_ORDER[(phrase - 1) % BOSS_ORDER.length];
  const ch = BOSS_CHORDS[bip];
  const tt = inBar % 2 ? t + P.sd * 0.14 : t; // light swing
  const full = sec === 'A' || sec === 'A2' || sec === 'B';
  const fill = full && bip === 3 && sec !== 'A';
  if (inBar === 0) kick(c, out, tt, 1);
  else if (inBar === 4 && sec !== 'intro') kick(c, out, tt, 0.85);
  else if (full && inBar === 3 && r() < 0.45) kick(c, out, tt, 0.6);
  if (full && inBar === 2) snare(c, out, tt, 0.8);
  if (full && inBar === 6 && !fill) snare(c, out, tt, 0.8);
  if (fill && inBar >= 5) snare(c, out, tt, 0.5 + (inBar - 5) * 0.2);
  if (inBar % 2 === 1) hat(c, out, tt, 0.8, inBar === 7 && r() < 0.25);
  else if (sec !== 'intro') hat(c, out, tt, 0.4, false);
  const bo = BOSS_BASS[inBar];
  if (bo !== null) pluckBass(c, out, tt, ch[0] + bo, inBar === 0 ? 1 : 0.8);
  if (full && (inBar === 2 || inBar === 6)) stab(c, out, tt, ch[1], 0.8);
  if (inBar === 0 && (sec === 'brk' || sec === 'intro')) pad(c, out, t, ch[1], P.sd * 8, 0.9, 900);
  if (full) {
    const m = BOSS_MEL[sec][bip][inBar];
    if (m) marimba(c, out, tt, hz(m), (inBar === 0 ? 0.85 : 0.7) + r() * 0.1, 0.42);
  } else if (sec === 'brk' || bip >= 2) {
    marimba(c, out, tt, hz(ch[1][BOSS_ARP[inBar]] + 12), 0.42, 0.3);
  }
}

// Victory: triumphant brass jingle, then a soft kalimba loop for the end card.
const VIC_CHORDS = [
  [48, [60, 64, 67]], // C
  [47, [59, 62, 67]], // G/B
  [45, [57, 60, 64]], // Am
  [41, [57, 60, 65]], // F
];
const VIC_LOOP_START = 10; // steps (8ths at 84 bpm) after the jingle

function jingle(c, out, t) {
  const B = (m, dt, du, pk) => {
    brass(c, out, t + dt, hz(m), du, pk);
    kalimba(c, out, t + dt, hz(m + 12), 0.45, 0.6);
  };
  B(72, 0.0, 0.12, 0.2);
  B(76, 0.14, 0.12, 0.2);
  B(79, 0.28, 0.12, 0.2);
  B(84, 0.42, 0.5, 0.22);
  [60, 64, 67].forEach((m) => brass(c, out, t + 0.42, hz(m), 0.5, 0.07));
  timpani(c, out, t + 0.42, hz(48), 1);
  B(81, 1.0, 0.13, 0.2);
  [53, 57, 60].forEach((m) => brass(c, out, t + 1.0, hz(m), 0.13, 0.06));
  B(83, 1.16, 0.13, 0.2);
  [55, 59, 62].forEach((m) => brass(c, out, t + 1.16, hz(m), 0.13, 0.06));
  B(84, 1.32, 1.3, 0.23);
  [60, 64, 67, 72].forEach((m) => brass(c, out, t + 1.32, hz(m), 1.3, 0.06));
  timpani(c, out, t + 1.32, hz(43), 1);
  noise(c, out, t + 1.1, {
    color: 'white', a: 0.25, d: 1.3, peak: 0.05,
    f: [{ type: 'highpass', f: 5000 }, { type: 'lowpass', f: 11000 }],
  });
  [88, 91, 96, 100].forEach((m, i) => bell(c, out, t + 1.4 + i * 0.09, hz(m), 0.05, 0.6));
}

function victoryStep(P, s, t) {
  const c = P.c, out = P.gain, r = P.rng;
  if (s === 0) {
    jingle(c, out, t);
    return;
  }
  if (s < VIC_LOOP_START) return;
  const ls = s - VIC_LOOP_START, bar = Math.floor(ls / 8), inBar = ls % 8;
  const ch = VIC_CHORDS[bar % 4];
  if (inBar === 0) {
    pad(c, out, t, ch[1], P.sd * 8 + 0.2, 0.8, 1000);
    softBass(c, out, t, ch[0], P.sd * 6, 0.7);
  }
  const arp = [0, 1, 2, 1, 3, 1, 2, 1];
  const tones = [ch[1][0], ch[1][1], ch[1][2], ch[1][0] + 12];
  kalimba(c, out, t, hz(tones[arp[inBar]] + 12), inBar === 0 ? 0.42 : 0.3, 0.9);
  if (inBar === 0 && bar % 2 === 0 && r() < 0.7) piano(c, out, t + 0.01, pick(r, PENTA.slice(5)), 0.45);
}

const TRACKS = {
  calm: { bpm: 70, level: 0.88, fadeIn: 2.0, init: () => ({ idx: 5, tpl: REST, pcs: new Set([0, 4, 7]) }), step: calmStep },
  boss: { bpm: 116, level: 0.88, fadeIn: 0.8, init: () => ({}), step: bossStep },
  victory: { bpm: 84, level: 1.35, fadeIn: 0.02, init: () => ({}), step: victoryStep },
};

export const SFX_NAMES = Object.freeze(Object.keys(SFX));
export const MUSIC_TRACKS = Object.freeze(Object.keys(TRACKS));
export const _synth = SFX; // shared synth table (dev harness / tests)

// ---------------------------------------------------------------------------
// Graph construction (shared by the live context and offline renders)
// ---------------------------------------------------------------------------
function buildGraph(c, cfg) {
  cfg = cfg || {};
  const g = {};
  g.master = c.createGain();
  g.master.gain.value = cfg.muted ? 0 : LEVEL.master;
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 38;
  hp.Q.value = 0;
  g.master.connect(hp);
  let tail = hp;
  if (cfg.compressor !== false) {
    // Gentle bus limiter. Note Chrome applies automatic makeup gain
    // ((1/curve(1))^0.6, about +6.7 dB here), so per-sound levels below are
    // calibrated through this exact chain by dev/audio.html.
    const k = c.createDynamicsCompressor();
    k.threshold.value = -14;
    k.knee.value = 6;
    k.ratio.value = 5;
    k.attack.value = 0.002;
    k.release.value = 0.2;
    // A fresh compressor starts fully clamped; a very short release for the
    // first 0.4 s lets it open before the first tap sound after unlock().
    const t0 = c.currentTime;
    k.release.setValueAtTime(0.01, t0);
    k.release.setValueAtTime(0.2, t0 + 0.4);
    tail.connect(k);
    tail = k;
    g.comp = k;
  }
  if (cfg.clipper !== false) {
    const ws = c.createWaveShaper();
    ws.curve = clipCurve();
    ws.oversample = 'none';
    tail.connect(ws);
    tail = ws;
  }
  tail.connect(c.destination);
  g.out = tail;

  // SFX bus with a gentle warm EQ (a touch of low shelf, softened top end).
  g.sfxIn = c.createGain();
  g.sfxIn.gain.value = LEVEL.sfx;
  const ls = c.createBiquadFilter();
  ls.type = 'lowshelf';
  ls.frequency.value = 160;
  ls.gain.value = 2;
  const hs = c.createBiquadFilter();
  hs.type = 'highshelf';
  hs.frequency.value = 6500;
  hs.gain.value = -4;
  g.sfxIn.connect(ls);
  ls.connect(hs);
  hs.connect(g.master);

  // Music: track gains -> duck stage -> music bus -> lowpass (leaves room for SFX).
  g.musicIn = c.createGain();
  g.musicBus = c.createGain();
  g.musicBus.gain.value = LEVEL.music;
  const mlp = c.createBiquadFilter();
  mlp.type = 'lowpass';
  mlp.frequency.value = 5200;
  mlp.Q.value = 0;
  g.musicIn.connect(g.musicBus);
  g.musicBus.connect(mlp);
  mlp.connect(g.master);

  g.revIn = null;
  if (cfg.reverb !== false) {
    const conv = c.createConvolver();
    conv.normalize = false; // the generated IR is already energy-normalized
    conv.buffer = buffers(c).ir;
    const ret = c.createGain();
    ret.gain.value = LEVEL.reverbReturn;
    g.revIn = c.createGain();
    g.revIn.connect(conv);
    conv.connect(ret);
    ret.connect(g.master);
    const ms = c.createGain();
    ms.gain.value = LEVEL.musicReverbSend;
    mlp.connect(ms);
    ms.connect(g.revIn);
  }
  g.duckEnd = 0;
  g.duckLevel = 1;
  return g;
}

// Music ducking so SFX stay on top; overlapping ducks keep the deeper level.
function duck(g, t, level, hold) {
  const p = g.musicIn.gain;
  let lvl = level;
  let end = t + hold;
  if (t < g.duckEnd) {
    lvl = Math.min(lvl, g.duckLevel);
    end = Math.max(end, g.duckEnd);
  }
  g.duckLevel = lvl;
  g.duckEnd = end;
  holdParam(p, t);
  p.setTargetAtTime(lvl, t, 0.035);
  p.setTargetAtTime(1, end, 0.3);
}

function normOpts(o) {
  o = o || {};
  return {
    pitch: clamp(num(o.pitch, 1), 0.25, 4),
    volume: clamp(num(o.volume, 1), 0, 2),
    pan: clamp(num(o.pan, 0), -1, 1),
    r: o.seed != null ? mulberry32(o.seed) : Math.random,
  };
}

function startVoice(c, g, name, def, t, p) {
  const input = c.createGain();
  input.gain.value = num(def.gain, 1) * p.volume;
  let tail = input;
  let pan = null;
  let send = null;
  if (c.createStereoPanner) {
    pan = c.createStereoPanner();
    const jit = def.panJitter ? (p.r() * 2 - 1) * def.panJitter : 0;
    pan.pan.value = clamp(p.pan + jit, -1, 1);
    input.connect(pan);
    tail = pan;
  }
  tail.connect(g.sfxIn);
  if (g.revIn && def.rev > 0) {
    send = c.createGain();
    send.gain.value = def.rev;
    tail.connect(send);
    send.connect(g.revIn);
  }
  const prev = RND;
  RND = p.r;
  let dur;
  try {
    dur = def.fn(c, input, t, p);
  } finally {
    RND = prev;
  }
  if (def.duck) duck(g, t, def.duck[0], def.duck[1]);
  const durSec = num(dur, def.dur);
  return {
    name,
    input,
    pan,
    send,
    prio: def.prio || 0,
    end: t + durSec,
    endMs: perfNow() + (durSec + 0.15) * 1000,
    stopped: false,
  };
}

function release(v) {
  for (const n of [v.input, v.pan, v.send]) {
    if (n) {
      try {
        n.disconnect();
      } catch (e) {
        /* already disconnected */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Music player
// ---------------------------------------------------------------------------
function createPlayer(c, g, name, t0, seed) {
  const def = TRACKS[name];
  const gain = c.createGain();
  gain.gain.value = 0;
  gain.connect(g.musicIn);
  const rng = mulberry32(seed);
  return {
    name, def, c, gain, rng, t0, sd: 60 / def.bpm / 2, step: 0,
    stopping: false, killAt: 0, st: def.init(rng),
  };
}

function schedulePlayer(P, until, live) {
  if (live) {
    // After a main-thread stall, drop missed notes instead of bunching them.
    const behind = P.c.currentTime - (P.t0 + P.step * P.sd);
    if (behind > 0.05) P.step += Math.ceil(behind / P.sd);
  }
  let guard = 0;
  while (P.t0 + P.step * P.sd < until && guard++ < 512) {
    const t = P.t0 + P.step * P.sd;
    try {
      P.def.step(P, P.step, t);
    } catch (e) {
      /* one bad note must never stop the music */
    }
    P.step++;
  }
}

// ---------------------------------------------------------------------------
// Live engine state
// ---------------------------------------------------------------------------
let ctx = null;
let G = null;
let muted = false;
let pendingTrack = null;
let player = null;
let playerSerial = 0;
let timer = null;
let hiddenSuspend = false;
let primed = false;
const voices = [];
const dying = [];
const fading = [];
const lastPlay = new Map();
let rateT0 = 0;
let rateN = 0;

function startTimer() {
  if (timer || typeof setInterval !== 'function') return;
  timer = setInterval(tick, TICK_MS);
}

function tick() {
  try {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (player && !player.stopping) {
      const hidden = typeof document !== 'undefined' && document.hidden;
      schedulePlayer(player, now + (hidden ? 1.2 : LOOKAHEAD), true);
    }
    reap(now);
  } catch (e) {
    /* never throw from the timer */
  }
}

function reap(now, nowMs) {
  if (nowMs === undefined) nowMs = perfNow();
  for (let i = voices.length - 1; i >= 0; i--) {
    if (now > voices[i].end + 0.15 || nowMs > voices[i].endMs) {
      release(voices[i]);
      voices.splice(i, 1);
    }
  }
  for (let i = dying.length - 1; i >= 0; i--) {
    if (now > dying[i].end + 0.05 || nowMs > dying[i].endMs) {
      release(dying[i]);
      dying.splice(i, 1);
    }
  }
  for (let i = fading.length - 1; i >= 0; i--) {
    if (now > fading[i].killAt) {
      try {
        fading[i].gain.disconnect();
      } catch (e) {
        /* ignore */
      }
      fading.splice(i, 1);
    }
  }
}

function fadeVoice(v, now, fade) {
  const gp = v.input.gain;
  holdParam(gp, now);
  gp.linearRampToValueAtTime(0, now + fade);
  v.end = Math.min(v.end, now + fade + 0.02);
  v.endMs = Math.min(v.endMs || Infinity, perfNow() + (fade + 0.05) * 1000);
}

function steal(prio, now) {
  while (dying.length >= MAX_DYING) {
    release(dying.shift());
  }
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (v.prio <= prio) {
      fadeVoice(v, now, 0.03);
      voices.splice(i, 1);
      dying.push(v);
      return true;
    }
  }
  return false;
}

function handleFor(v) {
  return {
    stop(fade) {
      try {
        if (!ctx || v.stopped) return;
        v.stopped = true;
        fadeVoice(v, ctx.currentTime, clamp(num(fade, 0.06), 0.005, 2));
      } catch (e) {
        /* ignore */
      }
    },
  };
}

function fadeOutPlayer(P, now, fade) {
  P.stopping = true;
  const gp = P.gain.gain;
  holdParam(gp, now);
  gp.linearRampToValueAtTime(0, now + fade);
  P.killAt = now + fade + 0.1;
  fading.push(P);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function unlock() {
  try {
    if (!AC) return false;
    if (!ctx) {
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        ctx = new AC();
      }
      G = buildGraph(ctx, { muted });
      startTimer();
    }
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      hiddenSuspend = false;
      const pr = ctx.resume();
      if (pr && pr.catch) pr.catch(noop);
    }
    if (!primed) {
      // iOS: playing a silent buffer inside the gesture fully unlocks output.
      primed = true;
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(0);
    }
    if (pendingTrack) {
      const tr = pendingTrack;
      pendingTrack = null;
      startMusic(tr);
    }
    return true;
  } catch (e) {
    return false;
  }
}

function play(name, opts) {
  try {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(SFX, name)) return null;
    if (!ctx || !G || muted || ctx.state === 'closed') return null;
    const def = SFX[name];
    const nowMs = perfNow();
    const last = lastPlay.get(name);
    if (last !== undefined && nowMs - last < Math.max(MIN_THROTTLE_MS, def.throttle || 0)) return null;
    if (nowMs - rateT0 > RATE_WINDOW_MS) {
      rateT0 = nowMs;
      rateN = 0;
    }
    if (rateN >= RATE_MAX) return null;
    const now = ctx.currentTime;
    if (voices.length >= MAX_VOICES) reap(now, nowMs);
    if (voices.length >= MAX_VOICES && !steal(def.prio || 0, now)) return null;
    rateN++;
    lastPlay.set(name, nowMs);
    const v = startVoice(ctx, G, name, def, now + 0.005, normOpts(opts));
    voices.push(v);
    return handleFor(v);
  } catch (e) {
    return null;
  }
}

function startMusic(track) {
  try {
    if (typeof track !== 'string' || !Object.prototype.hasOwnProperty.call(TRACKS, track)) return;
    if (!ctx || !G) {
      pendingTrack = track; // starts right after unlock()
      return;
    }
    pendingTrack = null;
    if (player && player.name === track && !player.stopping) return; // already playing: no-op
    const now = ctx.currentTime;
    const def = TRACKS[track];
    if (player) fadeOutPlayer(player, now, track === 'victory' ? 0.35 : 1.4);
    player = createPlayer(ctx, G, track, now + 0.06, (Math.random() * 4294967296) >>> 0);
    playerSerial++;
    const gp = player.gain.gain;
    gp.setValueAtTime(0, now);
    gp.linearRampToValueAtTime(def.level, now + def.fadeIn);
    schedulePlayer(player, now + LOOKAHEAD, true);
  } catch (e) {
    /* ignore */
  }
}

function stopMusic() {
  try {
    pendingTrack = null;
    if (!ctx || !player) {
      player = null;
      return;
    }
    fadeOutPlayer(player, ctx.currentTime, 1.5);
    player = null;
  } catch (e) {
    /* ignore */
  }
}

function setMuted(m) {
  try {
    muted = !!m;
    if (ctx && G) {
      const now = ctx.currentTime;
      const gp = G.master.gain;
      holdParam(gp, now);
      gp.setTargetAtTime(muted ? 0 : LEVEL.master, now, 0.07);
    }
  } catch (e) {
    /* ignore */
  }
}

function isMuted() {
  return muted;
}

function info() {
  try {
    return {
      supported: !!AC,
      unlocked: !!ctx,
      state: ctx ? ctx.state : 'none',
      muted,
      track: player ? player.name : null,
      pending: pendingTrack,
      serial: playerSerial,
      voices: voices.length,
      dying: dying.length,
      fading: fading.length,
      time: ctx ? Math.round(ctx.currentTime * 1000) / 1000 : 0,
      sampleRate: ctx ? ctx.sampleRate : 0,
    };
  } catch (e) {
    return { supported: false };
  }
}

function beatInfo() {
  try {
    if (!ctx || !player) return null;
    const bpm = player.def.bpm;
    return { track: player.name, bpm, beat: Math.max(0, ((ctx.currentTime - player.t0) * bpm) / 60) };
  } catch (e) {
    return null;
  }
}

export const GameAudio = Object.freeze({
  unlock,
  play,
  startMusic,
  stopMusic,
  setMuted,
  isMuted,
  info,
  beatInfo,
  _debug: () => ({ ctx, graph: G, voices: voices.length, player: player ? player.name : null }),
});
export default GameAudio;

// Auto-unlock on the first gesture (and re-resume after iOS interruptions),
// suspend while the tab is hidden.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const onGesture = () => {
    if (!ctx || ctx.state !== 'running') unlock();
  };
  for (const ev of ['pointerdown', 'touchend', 'mousedown', 'keydown']) {
    try {
      window.addEventListener(ev, onGesture, { capture: true, passive: true });
    } catch (e) {
      /* ignore */
    }
  }
  try {
    document.addEventListener('visibilitychange', () => {
      try {
        if (!ctx) return;
        if (document.hidden) {
          if (ctx.state === 'running') {
            hiddenSuspend = true;
            const pr = ctx.suspend();
            if (pr && pr.catch) pr.catch(noop);
          }
        } else if (hiddenSuspend) {
          hiddenSuspend = false;
          const pr = ctx.resume();
          if (pr && pr.catch) pr.catch(noop);
        }
      } catch (e) {
        /* ignore */
      }
    });
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Offline rendering (dev harness / automated loudness checks)
// ---------------------------------------------------------------------------
function offlineCtx(seconds, sr) {
  if (!OAC) throw new Error('OfflineAudioContext unavailable');
  const len = Math.max(1, Math.ceil(seconds * sr));
  try {
    return new OAC({ numberOfChannels: 2, length: len, sampleRate: sr });
  } catch (e) {
    return new OAC(2, len, sr);
  }
}

/**
 * Render one SFX through the real graph.
 * opts: { pitch, volume, pan, seed, sampleRate=44100, seconds, reverb=true,
 *         compressor=true, clipper=true }
 * Resolves { buffer: AudioBuffer, synthDur, declaredDur }.
 */
export async function renderOffline(name, opts) {
  opts = opts || {};
  const def = Object.prototype.hasOwnProperty.call(SFX, name) ? SFX[name] : null;
  if (!def) throw new Error('unknown sfx: ' + name);
  const sr = opts.sampleRate || 44100;
  const reverb = opts.reverb !== false;
  // Chrome's DynamicsCompressor starts fully clamped and releases over ~0.3 s,
  // so by default the sound starts after a settle lead (the live context is
  // long-running, so this matches what the player hears).
  const lead = num(opts.lead, opts.compressor === false ? 0.01 : 0.6);
  const secs = num(opts.seconds, lead + def.dur + (reverb ? 1.1 : 0.12) + 0.02);
  const c = offlineCtx(secs, sr);
  const g = buildGraph(c, { reverb, compressor: opts.compressor !== false, clipper: opts.clipper !== false });
  const v = startVoice(c, g, name, def, lead, normOpts(opts));
  const buffer = await c.startRendering();
  return { buffer, synthDur: v.end - lead, declaredDur: def.dur, lead };
}

/** Render `seconds` of a music track. Resolves { buffer }. */
export async function renderMusicOffline(track, seconds, opts) {
  opts = opts || {};
  const def = Object.prototype.hasOwnProperty.call(TRACKS, track) ? TRACKS[track] : null;
  if (!def) throw new Error('unknown track: ' + track);
  seconds = num(seconds, 16);
  const sr = opts.sampleRate || 44100;
  const c = offlineCtx(seconds, sr);
  const g = buildGraph(c, { reverb: opts.reverb !== false, compressor: opts.compressor !== false, clipper: opts.clipper !== false });
  const P = createPlayer(c, g, track, 0.05, num(opts.seed, 12345));
  P.gain.gain.value = def.level;
  schedulePlayer(P, seconds - 0.05, false);
  return { buffer: await c.startRendering() };
}

/**
 * Render a mixed scene: { seconds, music, musicSeed, events: [[time, name, opts], ...],
 *                         reverb, compressor, clipper, sampleRate }.
 * Ducking is applied exactly as in the live engine. Resolves { buffer }.
 */
export async function renderSceneOffline(scene) {
  scene = scene || {};
  const seconds = num(scene.seconds, 8);
  const sr = scene.sampleRate || 44100;
  const c = offlineCtx(seconds, sr);
  const g = buildGraph(c, { reverb: scene.reverb !== false, compressor: scene.compressor !== false, clipper: scene.clipper !== false });
  if (scene.music && Object.prototype.hasOwnProperty.call(TRACKS, scene.music)) {
    const P = createPlayer(c, g, scene.music, 0.05, num(scene.musicSeed, 777));
    P.gain.gain.value = TRACKS[scene.music].level;
    schedulePlayer(P, seconds - 0.05, false);
  }
  const evs = (scene.events || []).slice().sort((a, b) => a[0] - b[0]);
  for (const ev of evs) {
    const def = Object.prototype.hasOwnProperty.call(SFX, ev[1]) ? SFX[ev[1]] : null;
    if (def) startVoice(c, g, ev[1], def, Math.max(0.005, num(ev[0], 0)), normOpts(ev[2]));
  }
  return { buffer: await c.startRendering() };
}
