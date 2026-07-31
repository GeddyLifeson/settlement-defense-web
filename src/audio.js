// Procedural sound effects via the Web Audio API. No audio files anywhere in this project --
// every cue here is synthesized at runtime with oscillators/noise + gain envelopes, matching the
// hand-drawn-Canvas2D "no external assets" rule that also applies to art.
//
// Presentation-layer concern only: this module is never imported by the simulation modules
// (world.js/siege.js/jobs.js). Instead main.js wires SimWorld's onXxx callback hooks to the
// play* functions below, the same callback-injection pattern those modules already use for
// onScrap. That keeps the sim decoupled from anything audio/DOM-related.

let ctx = null;
let masterGain = null;
let muted = false;

// Browsers refuse to start an AudioContext (or keep it running) until a user gesture has
// happened on the page -- creating one before that is fine, it just starts 'suspended' and
// produces no sound until resumed. We lazily create on first play*() call and attempt a
// resume() on every subsequent user gesture (both are cheap/idempotent), so playback quietly
// "just works" the moment the browser allows it instead of the caller needing to know about
// AudioContext lifecycle at all.
function getCtx() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null; // no Web Audio support -- degrade to silent, never throw
  try {
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 0.5;
    masterGain.connect(ctx.destination);
  } catch {
    ctx = null;
  }
  return ctx;
}

function unlock() {
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
}
// Any of these count as "a user gesture happened" -- attach once at module load so callers
// never have to think about unlocking explicitly.
['pointerdown', 'keydown'].forEach((evt) => window.addEventListener(evt, unlock, { passive: true }));

export function isMuted() { return muted; }

export function setMuted(value) {
  muted = value;
  if (masterGain) masterGain.gain.value = muted ? 0 : 0.5;
}

export function toggleMute() {
  setMuted(!muted);
  return muted;
}

// ---------------------------------------------------------------- low-level synth helpers

function tone({ freq, freqEnd = null, start = 0, duration = 0.15, type = 'sine', peakGain = 0.22 }) {
  const c = getCtx();
  if (!c) return; // no Web Audio in this environment -- silently no-op
  try {
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (freqEnd != null) osc.frequency.linearRampToValueAtTime(freqEnd, t0 + duration);
    const g = c.createGain();
    // Quick linear attack then exponential decay -- avoids the click/pop of a hard on/off edge.
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peakGain, t0 + Math.min(0.01, duration * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  } catch {
    // Never let a synthesis failure bubble into the game loop.
  }
}

function noiseBurst({ duration = 0.15, filterFreq = 1200, filterType = 'lowpass', peakGain = 0.25 }) {
  const c = getCtx();
  if (!c) return;
  try {
    const bufferSize = Math.max(1, Math.floor(c.sampleRate * duration));
    const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buffer;
    const filter = c.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const g = c.createGain();
    const t0 = c.currentTime;
    g.gain.setValueAtTime(peakGain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(g);
    g.connect(masterGain);
    src.start(t0);
    src.stop(t0 + duration + 0.03);
  } catch {
    // ditto
  }
}

// ---------------------------------------------------------------- debounce for high-frequency cues
// Turret fire and kills can both happen many times in the same tick during a big wave (several
// turrets/tesla chains/guards all resolving at once) -- without a cap that's a wall of noise, not
// a sound effect. A simple "don't replay within N ms" gate per cue is enough since ticks run at
// 10Hz (100ms apart) already.
const lastPlayed = { fire: 0, kill: 0, downed: 0 };
function throttled(key, minGapMs, fn) {
  const now = performance.now();
  if (now - lastPlayed[key] < minGapMs) return;
  lastPlayed[key] = now;
  fn();
}

// ---------------------------------------------------------------- public cues

// Blueprint finished construction: short cheerful two-note ascending blip.
export function playBuildComplete() {
  tone({ freq: 660, duration: 0.09, type: 'sine', peakGain: 0.18 });
  tone({ freq: 880, duration: 0.14, type: 'sine', peakGain: 0.2, start: 0.09 });
}

// Turret/tesla firing -- cheap, throttled low blip so a full wave doesn't turn into static.
export function playTurretFire() {
  throttled('fire', 90, () => {
    tone({ freq: 190, freqEnd: 110, duration: 0.06, type: 'square', peakGain: 0.14 });
  });
}

// Attacker killed -- a short descending "thud", noise + tone layered.
export function playKill() {
  throttled('kill', 80, () => {
    noiseBurst({ duration: 0.1, filterFreq: 900, peakGain: 0.2 });
    tone({ freq: 300, freqEnd: 110, duration: 0.14, type: 'sawtooth', peakGain: 0.16 });
  });
}

// Wave incoming alert -- two low ominous pulses, not throttled (one push per wave already).
export function playWaveAlert() {
  tone({ freq: 150, duration: 0.22, type: 'sawtooth', peakGain: 0.2 });
  tone({ freq: 165, duration: 0.28, type: 'sawtooth', peakGain: 0.2, start: 0.28 });
}

// Citizen downed/died -- a sad descending sweep, throttled since a bad tick can down/kill
// several citizens at once against a wave.
export function playCitizenDowned() {
  throttled('downed', 120, () => {
    tone({ freq: 420, freqEnd: 160, duration: 0.32, type: 'sine', peakGain: 0.18 });
  });
}
