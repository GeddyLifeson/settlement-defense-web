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

// Continuous volume level (0..1), independent of the mute toggle -- the two combine as
// `muted ? 0 : volume` everywhere the master gain is set. Persisted to localStorage so it
// survives a reload; mute intentionally is NOT persisted (matches its previous session-only
// behaviour, and a silently-still-muted reload would be a confusing surprise).
const VOLUME_KEY = 'settlement-defense-volume';
let volume = 0.5;
try {
  const stored = Number.parseFloat(localStorage.getItem(VOLUME_KEY));
  if (Number.isFinite(stored)) volume = Math.max(0, Math.min(1, stored));
} catch { /* localStorage unavailable -- fall back to the 0.5 default */ }

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
    masterGain.gain.value = muted ? 0 : volume;
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
  if (masterGain) masterGain.gain.value = muted ? 0 : volume;
}

export function toggleMute() {
  setMuted(!muted);
  return muted;
}

export function getVolume() { return volume; }

/** Console/soak-test verification hook: the ACTUAL live GainNode value, not just the stored
 *  `volume` number -- lets a test confirm the master gain really was scaled, not merely that the
 *  setter ran. Returns null if no AudioContext exists yet (nothing has played a sound this
 *  session). */
export function getMasterGainValue() { return masterGain ? masterGain.gain.value : null; }

/** Set the continuous volume level (0..1, clamped) and persist it. Does not touch `muted` --
 *  dragging the slider while muted updates the stored level but stays silent until unmuted,
 *  same as any normal OS volume slider. */
export function setVolume(value) {
  volume = Math.max(0, Math.min(1, value));
  try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* best effort */ }
  if (masterGain && !muted) masterGain.gain.value = volume;
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
const lastPlayed = { fire: 0, kill: 0, downed: 0, onBreak: 0, programComplete: 0, ratTier: 0 };
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

// ---------------------------------------------------------------- PA-catalog cues (7 new systems)
// All 7 below are wired from main.js's single `onRandomEvent` hook (world.js/factions.js/rats.js/
// security.js/weather.js already funnel their milestone text through that one callback -- see
// playRandomEventCue's text-discrimination dispatcher at the bottom of this file) except mood-break,
// which gets its own dedicated `world.onCitizenOnBreak` hook since citizens.js's per-tick mood pass
// never had an event-log text line to discriminate on in the first place.

// Unrest tier 1 (world.js: 'Unrest is spreading through the settlement') -- a mild rising minor
// second, the smallest dissonance step of the three tiers.
export function playUnrestTier1() {
  tone({ freq: 220, duration: 0.16, type: 'triangle', peakGain: 0.16 });
  tone({ freq: 233, duration: 0.22, type: 'triangle', peakGain: 0.18, start: 0.1 });
}

// Unrest tier 2 ('Unrest is escalating...') -- a harsher rising tritone, sawtooth for more edge.
export function playUnrestTier2() {
  tone({ freq: 196, duration: 0.14, type: 'sawtooth', peakGain: 0.18 });
  tone({ freq: 277, duration: 0.24, type: 'sawtooth', peakGain: 0.2, start: 0.1 });
}

// Unrest tier 3 ('Unrest has reached a breaking point...') -- three harsh rising square-wave
// stabs, the most severe of the three tiers.
export function playUnrestTier3() {
  tone({ freq: 175, duration: 0.1, type: 'square', peakGain: 0.18 });
  tone({ freq: 220, duration: 0.1, type: 'square', peakGain: 0.2, start: 0.09 });
  tone({ freq: 311, duration: 0.28, type: 'square', peakGain: 0.22, start: 0.18 });
}

// Unrest fully resolved ('The settlement has calmed') -- warm consonant descending-then-settling
// chime, deliberately the emotional opposite of the three escalation stingers above.
export function playUnrestResolve() {
  tone({ freq: 523, duration: 0.16, type: 'sine', peakGain: 0.16 });
  tone({ freq: 392, duration: 0.3, type: 'sine', peakGain: 0.18, start: 0.12 });
}

// Citizen mood break onset (CitizenFlags.OnBreak, citizens.js) -- a short low "strain" tone, not a
// full alarm since this is a routine, frequent-ish per-citizen event, not a colony-wide crisis.
// Throttled since a bad tick of stacking mood events can tip several citizens at once.
export function playMoodBreak() {
  throttled('onBreak', 150, () => {
    tone({ freq: 130, freqEnd: 100, duration: 0.2, type: 'triangle', peakGain: 0.14 });
  });
}

// Program completion (programs.js's Skills Workshop/Wellness Counseling/Community Circle) --
// bright ascending three-note chime, the "graduation" feel. Throttled since multiple citizens can
// finish a session on the same tick.
export function playProgramComplete() {
  throttled('programComplete', 150, () => {
    tone({ freq: 523, duration: 0.09, type: 'sine', peakGain: 0.16 });
    tone({ freq: 659, duration: 0.09, type: 'sine', peakGain: 0.18, start: 0.08 });
    tone({ freq: 880, duration: 0.18, type: 'sine', peakGain: 0.2, start: 0.16 });
  });
}

// Clique demand satisfied (factions.js) -- a bright quick "cha-ching", two fast high square blips.
export function playFactionSatisfied() {
  tone({ freq: 784, duration: 0.06, type: 'square', peakGain: 0.16 });
  tone({ freq: 1047, duration: 0.12, type: 'square', peakGain: 0.18, start: 0.06 });
}

// Clique demand unmet (factions.js) -- a low unresolved "trouble" tone, sawtooth descending.
export function playFactionUnmet() {
  tone({ freq: 220, freqEnd: 140, duration: 0.26, type: 'sawtooth', peakGain: 0.18 });
}

// Corrupt staff discovered (security.js) -- a distinct sharp alert/reveal stinger: a quick
// upward flick then a held note, deliberately not shaped like any combat/build cue above so it
// reads as "look at this" rather than "something got hit".
export function playCorruptDiscovered() {
  tone({ freq: 500, freqEnd: 900, duration: 0.08, type: 'square', peakGain: 0.16 });
  tone({ freq: 700, duration: 0.22, type: 'square', peakGain: 0.2, start: 0.08 });
}

// Rat infestation tier change (rats.js, both up and down transitions) -- skittering/scratchy
// noise burst, reusing noiseBurst() with a highpass filter for a thin, scratchy texture distinct
// from the turret/kill noise bursts' lowpass "thud" character. Throttled since escalating and
// de-escalating tiers can't both fire the same tick but keeps this consistent with the other
// per-system events above.
export function playRatTierChange() {
  throttled('ratTier', 150, () => {
    noiseBurst({ duration: 0.18, filterFreq: 3500, filterType: 'highpass', peakGain: 0.14 });
  });
}

// Severe weather onset (weather.js's Heatwave/Cold, onset only -- not every transition) -- a
// subtle wind/rain-like noise swell: longer duration, gentle lowpass, lower peak gain than the
// combat noise bursts so it reads as ambient rather than an alert.
export function playSevereWeatherOnset() {
  noiseBurst({ duration: 0.6, filterFreq: 500, filterType: 'lowpass', peakGain: 0.1 });
}

// ---------------------------------------------------------------- onRandomEvent text dispatcher
// main.js's world.onRandomEvent hook receives free-text milestone strings from several unrelated
// systems (world.js/factions.js/rats.js/security.js/weather.js/jobs.js) -- this matches on the
// exact/substring text each system is known to emit (verified against each source file) rather
// than adding a dedicated onXxx callback per system, since that text already reaches one place.
// Falls through silently (no cue) for every other random-event text this project already had
// before this pass (weather changes to non-severe states, wanderer/blight/trader events, etc).
export function playRandomEventCue(text) {
  if (typeof text !== 'string') return;
  if (text === 'Unrest is spreading through the settlement') playUnrestTier1();
  else if (text.startsWith('Unrest is escalating')) playUnrestTier2();
  else if (text.startsWith('Unrest has reached a breaking point')) playUnrestTier3();
  else if (text === 'The settlement has calmed') playUnrestResolve();
  else if (text.includes(' completes ')) playProgramComplete();
  else if (text.includes('demand satisfied')) playFactionSatisfied();
  else if (text.includes('demand went unmet')) playFactionUnmet();
  else if (text.includes('was caught quietly diverting supplies')) playCorruptDiscovered();
  else if (text.startsWith('Rat infestation has reached') || text === 'The rat infestation has died down') playRatTierChange();
  else if (text === 'Weather turns to Heatwave' || text === 'Weather turns to Cold') playSevereWeatherOnset();
}
