/* ============================================================================
   Audio harness — measures the real AudioEngine in Node.

   There is no test runner in this project, and the standing rule is that
   nothing gets called "done" without a number behind it. So: stub out the Web
   Audio API, load the actual `src/audio/engine.ts` (via a Vite transform, so
   the `@/` alias resolves), drive it with a fixed timestep, and record what
   comes out.

   What this CAN prove: track durations, that the sequence advances on its own,
   that it never repeats a track back to back, that the music gain never reaches
   zero during a handover, that changing area mid-track does not restart the
   phrase, that `pulse` stays alive (which is what keeps the Grid's shaders
   breathing), and that settings survive a reload.

   What it CANNOT prove: anything about how the result sounds or looks. Only a
   person listening can do that. This file exists to catch the arithmetic being
   wrong, not to stand in for ears.
   ========================================================================== */

import { createServer } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* -------------------------------------------------------------------------
   The Web Audio stub
   ------------------------------------------------------------------------- */

/** Records every gain write so a test can assert on what a node was told. */
class Param {
  constructor(value = 0) {
    this.value = value;
    this.history = [];
  }
  setValueAtTime(v, t) { this.value = v; this.history.push({ op: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { this.value = v; this.history.push({ op: 'lin', v, t }); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.history.push({ op: 'exp', v, t }); }
  setTargetAtTime(v, t, c) { this.value = v; this.history.push({ op: 'target', v, t, c }); }
  cancelScheduledValues(t) { this.history.push({ op: 'cancel', t }); }
  /**
   * The value `setTargetAtTime` would have right now — needed to see a fade.
   *
   * Note this is not a real AudioParam; the real one is a curve the audio thread
   * walks. This is the analytic form, which is exact for an exponential approach
   * and close enough for `setValueAtTime`. It exists so a test can ask "how loud
   * was the music at t=95s" without a browser.
   */
  valueAt(t) {
    let last = this.value;
    for (const h of this.history) {
      if (h.t > t) break;
      switch (h.op) {
        case 'set':
        case 'exp':
        case 'lin':
          last = h.v;
          break;
        case 'target':
          // `cancel` and every other op land here too, so guard: a constant of
          // 0 or a missing one would divide by zero and poison the whole run.
          if (h.c > 0) last = h.v + (last - h.v) * Math.exp(-(t - h.t) / h.c);
          else last = h.v;
          break;
        default:
          break;
      }
    }
    return last;
  }
}

class StubNode {
  constructor(kind, ctx) {
    this.kind = kind;
    this.ctx = ctx;
    this.gain = new Param(1);
    this.frequency = new Param(440);
    this.Q = new Param(1);
    this.pan = new Param(0);
    this.type = 'sine';
    this.buffer = null;
    this.playbackRate = new Param(1);
    this.detune = new Param(0);
    this.threshold = new Param(-24);
    this.knee = new Param(30);
    this.ratio = new Param(12);
    this.attack = new Param(0.003);
    this.release = new Param(0.25);
    this.delayTime = new Param(0);
    this.outputs = [];
    this.started = false;
  }
  connect(dest) { this.outputs.push(dest); return dest; }
  disconnect() { this.outputs.length = 0; }
  start() { this.started = true; this.ctx.startedNodes++; }
  stop() { this.started = false; }
}

class StubContext {
  constructor(opts = {}) {
    this.state = opts.state ?? 'suspended';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = new StubNode('destination', this);
    this.nodes = [];
    this.startedNodes = 0;
    this.resumeCalls = 0;
    this.resumeShouldFail = opts.resumeShouldFail ?? false;
  }
  #make(kind) {
    const n = new StubNode(kind, this);
    this.nodes.push(n);
    return n;
  }
  createGain() { return this.#make('gain'); }
  createOscillator() { return this.#make('osc'); }
  createBiquadFilter() { return this.#make('biquad'); }
  createStereoPanner() { return this.#make('panner'); }
  createDynamicsCompressor() { return this.#make('comp'); }
  createDelay() { return this.#make('delay'); }
  createBuffer(ch, len) {
    return { length: len, numberOfChannels: ch, sampleRate: this.sampleRate, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() { return this.#make('bufsrc'); }
  async resume() {
    this.resumeCalls++;
    if (this.resumeShouldFail) return Promise.reject(new Error('blocked'));
    this.state = 'running';
  }
}

/* `window` and `localStorage` are the only globals the engine and `save.ts`
   actually touch. Both are minimal but faithful: storage persists to a Map
   within one process, which is what the persistence test needs. */
const store = new Map();
globalThis.window = {
  AudioContext: StubContext,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  location: { href: 'http://localhost/' },
};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.requestIdleCallback = (fn) => setTimeout(fn, 0);
globalThis.cancelIdleCallback = (h) => clearTimeout(h);

/* -------------------------------------------------------------------------
   Load the real engine
   ------------------------------------------------------------------------- */

const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.ts'),
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});
await server.ssrLoadModule('/src/audio/engine.ts');
const { AudioEngine } = await server.ssrLoadModule('/src/audio/engine.ts');

/* -------------------------------------------------------------------------
   Harness
   ------------------------------------------------------------------------- */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

/** `95.6` -> `"1:35.6"`. Rounds to tenths first, so 119.96 is `2:00.0` and not
    the nonsense `1:60.0`. */
function mmss(seconds) {
  const tenths = Math.round(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

/** Drive `engine.update(dt)` for `seconds`, one fixed step at a time. */
function run(engine, ctx, seconds, dt = 1 / 60, onStep = null) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    ctx.currentTime += dt;
    engine.update(dt);
    if (onStep) onStep(i);
  }
}

/** Start an engine on a context we control, so we can watch it. */
async function bootEngine(opts = {}) {
  const ctx = new StubContext(opts);
  globalThis.window.AudioContext = function () { return ctx; };
  const engine = new AudioEngine();
  await engine.start();
  return { engine, ctx };
}

/* =========================================================================
   1. Track lengths
   ========================================================================= */

section('1. Track lengths (every track, at its own area tempo)');

{
  const { engine, ctx } = await bootEngine({ state: 'running' });
  const tracks = [];
  // Walk the radio by pressing next; the queue is a bag-shuffle so this covers
  // the whole playlist eventually.
  for (let i = 0; i < 40; i++) {
    const t = engine.nowPlaying;
    tracks.push({ id: t.id, area: t.area, len: engine.trackLength });
    engine.nextTrack();
  }

  const unique = new Map(tracks.map((t) => [t.id, t]));
  console.log(`  ${unique.size} distinct tracks`);
  const rows = [...unique.values()].sort((a, b) => a.len - b.len);
  for (const r of rows) {
    console.log(`    ${r.id.padEnd(16)} ${r.area.padEnd(9)} ${mmss(r.len)}`);
  }

  const total = rows.reduce((a, r) => a + r.len, 0);
  console.log(`  total ${Math.floor(total / 60)}m ${(total % 60).toFixed(0)}s`);

  check('16 tracks in the playlist', unique.size === 16, `got ${unique.size}`);
  check('every track is 60s-180s long', rows.every((r) => r.len >= 60 && r.len <= 180),
    `range ${rows[0].len.toFixed(1)}s .. ${rows[rows.length - 1].len.toFixed(1)}s`);
  check('no two tracks the same length', new Set(rows.map((r) => r.id)).size === rows.length);
  check('total runtime > 15 minutes', total > 900, `${(total / 60).toFixed(1)} min`);
}

/* =========================================================================
   2. Auto-advance, unattended
   ========================================================================= */

section('2. Auto-advance — 20 minutes, nobody pressing anything');

{
  const { engine, ctx } = await bootEngine({ state: 'running' });
  const seen = [];
  const changes = [];
  let lastId = engine.nowPlaying.id;
  seen.push(lastId);

  // 20 minutes at 60fps.
  const minutes = 20;
  run(engine, ctx, minutes * 60, 1 / 60, () => {
    const id = engine.nowPlaying.id;
    if (id !== lastId) {
      seen.push(id);
      changes.push({ at: ctx.currentTime, from: lastId, to: id });
      lastId = id;
    }
  });

  console.log(`  ${changes.length} changes in ${minutes} minutes`);
  for (const c of changes.slice(0, 6)) {
    console.log(`    ${(c.at / 60).toFixed(1)}m  ${c.from} -> ${c.to}`);
  }
  if (changes.length > 6) console.log(`    ...`);

  check('the radio advances by itself', changes.length >= 5, `${changes.length} track changes`);

  let repeats = 0;
  for (let i = 1; i < seen.length; i++) if (seen[i] === seen[i - 1]) repeats++;
  check('never the same track twice in a row', repeats === 0, `${repeats} repeats`);

  // Within the first pass through the queue, no track may appear twice at all.
  const firstPass = seen.slice(0, 16);
  check('the first pass through the queue is a clean shuffle',
    new Set(firstPass).size === firstPass.length,
    `${new Set(firstPass).size}/${firstPass.length} distinct`);

  // A handover must not fire more than once per track; if the clock were reset
  // wrongly the changes would cluster.
  const gaps = changes.map((c, i) => (i ? c.at - changes[i - 1].at : c.at));
  const minGap = Math.min(...gaps);
  check('handovers are at least 45s apart', minGap >= 45, `closest ${minGap.toFixed(1)}s`);
}

/* =========================================================================
   3. Crossfade never cuts to silence
   ========================================================================= */

section('3. Crossfade — the music gain through a handover');

{
  const { engine, ctx } = await bootEngine({ state: 'running' });
  const musicGain = engine.probe.musicGain;
  const samples = [];
  const steps = Math.round(180 / (1 / 60));

  for (let i = 0; i < steps; i++) {
    ctx.currentTime += 1 / 60;
    engine.update(1 / 60);
    samples.push({
      t: ctx.currentTime,
      mix: engine.probe.trackMix,
      gain: musicGain.gain.valueAt(ctx.currentTime),
    });
  }

  const min = Math.min(...samples.map((s) => s.gain));
  const max = Math.max(...samples.map((s) => s.gain));
  const handover = samples.findIndex((s) => s.mix > 0.001);
  const during = samples.filter((s) => s.mix > 0 && s.mix < 1);

  console.log(`  gain range ${min.toFixed(4)} .. ${max.toFixed(4)}`);
  console.log(`  ${during.length} frames inside a handover`);
  if (during.length) {
    console.log(`  handover dip: ${Math.min(...during.map((s) => s.gain)).toFixed(4)}`);
  }

  check('the music gain never reaches zero', min > 0.01, `minimum ${min.toFixed(5)}`);
  check('a handover actually happens', handover > -1);
  check('the handover dips below the resting level',
    during.length > 0 && Math.min(...during.map((s) => s.gain)) < max * 0.95);
  check('the dip is not a hole',
    during.length > 0 && Math.min(...during.map((s) => s.gain)) > max * 0.5,
    `floor ${(during.length ? Math.min(...during.map((s) => s.gain)) / max : 0).toFixed(3)} of peak`);
  check('the handover takes ~2.5s',
    during.length > 0 && during.length * (1 / 60) >= 2.4 && during.length * (1 / 60) <= 2.7,
    `${(during.length * (1 / 60)).toFixed(2)}s`);
}

/* =========================================================================
   4. setArea() mid-track does not restart the music
   ========================================================================= */

section('4. Changing sector mid-track must not restart the track');

{
  const { engine, ctx } = await bootEngine({ state: 'running' });
  // Settle into a track, then let the phrase get going.
  run(engine, ctx, 12);
  const before = {
    id: engine.nowPlaying.id,
    clock: engine.trackPosition,
    step: engine.probe.step,
    pulse: engine.pulse,
  };

  engine.setArea('archive');
  const afterSet = { step: engine.probe.step, clock: engine.trackPosition, id: engine.nowPlaying.id };

  check('the track does not change', afterSet.id === before.id,
    `${before.id} -> ${afterSet.id}`);
  check('the sequencer step is not reset', afterSet.step === before.step,
    `step ${before.step} -> ${afterSet.step}`);
  check('the track clock is not reset', Math.abs(afterSet.clock - before.clock) < 1e-6,
    `clock ${before.clock.toFixed(3)}s -> ${afterSet.clock.toFixed(3)}s`);

  // And the pulse must still be alive across the retune — this is the part
  // that actually matters for the Grid.
  //
  // Measured as a mean, not a minimum: `pulse` decays between notes by design,
  // so its instantaneous minimum is a property of the tempo, not of health. What
  // has to hold is that the average keeps being pushed up by the sequencer.
  let sum = 0;
  let n = 0;
  let peak = 0;
  run(engine, ctx, 6, 1 / 60, () => {
    sum += engine.pulse;
    peak = Math.max(peak, engine.pulse);
    n++;
  });
  const meanPulse = sum / n;
  check('pulse keeps being fed across the retune', meanPulse > 0.05,
    `mean ${meanPulse.toFixed(4)}, peak ${peak.toFixed(4)}`);
  check('the track survived the retune', engine.nowPlaying.id === before.id);
}

/* =========================================================================
   5. pulse never dies — this is what the shaders read
   ========================================================================= */

section('5. `pulse` over 10 minutes, with the radio on and off');

{
  const { engine, ctx } = await bootEngine({ state: 'running' });
  let minOn = Infinity;
  let maxOn = 0;
  let sumOn = 0;
  let n = 0;

  run(engine, ctx, 600, 1 / 60, () => {
    minOn = Math.min(minOn, engine.pulse);
    maxOn = Math.max(maxOn, engine.pulse);
    sumOn += engine.pulse;
    n++;
  });

  console.log(`  pulse range ${minOn.toFixed(4)} .. ${maxOn.toFixed(4)}, mean ${(sumOn / n).toFixed(4)}`);

  check('pulse is non-zero throughout', minOn > 0.001, `minimum ${minOn.toFixed(5)}`);
  check('pulse actually moves', maxOn - minOn > 0.1, `swing ${(maxOn - minOn).toFixed(3)}`);

  // Now with the radio switched off: the sound must go, but the Grid must not.
  engine.setMusicEnabled(false);
  let minOff = Infinity;
  let sumOff = 0;
  let nOff = 0;
  run(engine, ctx, 120, 1 / 60, () => {
    minOff = Math.min(minOff, engine.pulse);
    sumOff += engine.pulse;
    nOff++;
  });
  const meanOff = sumOff / nOff;

  check('radio off silences the music layer',
    engine.probe.musicGain.gain.valueAt(ctx.currentTime) < 0.001,
    `gain ${engine.probe.musicGain.gain.valueAt(ctx.currentTime).toExponential(2)}`);
  check('radio off does not freeze the Grid (ambience still pulses)',
    minOff > 0.001, `minimum pulse ${minOff.toFixed(5)}`);

  // And the reverse, which is the one the radio has to earn: the mean pulse
  // with the music on must be meaningfully above the mean with it off, or the
  // sequencer has stopped contributing to the Grid's breathing.
  const meanOn = sumOn / n;
  console.log(`  mean pulse: on ${meanOn.toFixed(4)}  off ${meanOff.toFixed(4)}`);
  check('the sequencer is a real part of the pulse', meanOn > meanOff + 0.02,
    `on ${meanOn.toFixed(4)} vs off ${meanOff.toFixed(4)}`);

  engine.setMusicEnabled(true);
  // Read after the fade, not at the instant of the call. `setTargetAtTime`
  // approaches its target exponentially and the real AudioParam does exactly
  // this — at t=0 the value is still the old one. Reading it immediately would
  // be measuring the stub's eagerness, not the engine.
  run(engine, ctx, 1);
  check('radio back on restores the level',
    engine.probe.musicGain.gain.valueAt(ctx.currentTime) > 0.3,
    `gain ${engine.probe.musicGain.gain.valueAt(ctx.currentTime).toFixed(3)} after 1s`);
}

/* =========================================================================
   6. Settings survive a reload
   ========================================================================= */

section('6. Persistence — music settings across a "reload"');

{
  const { engine, ctx } = await bootEngine({ state: 'running' });
  engine.setMusicVolume(0.35);
  engine.setMusicEnabled(false);

  const raw = store.get('grid-protocol.settings.v1');
  check('settings are written to localStorage', !!raw);

  // A reload: a brand new Settings object read from the same storage.
  const reloaded = JSON.parse(raw);
  check('musicVolume persists', Math.abs(reloaded.musicVolume - 0.35) < 1e-9,
    `got ${reloaded.musicVolume}`);
  check('musicEnabled persists', reloaded.musicEnabled === false);
  check('existing settings are not clobbered',
    reloaded.hasOwnProperty('masterVolume') && reloaded.hasOwnProperty('quality'));

  // A save wipe must leave the radio settings alone — they are not progress.
  store.delete('grid-protocol.save.v1');
  check('radio settings are not touched by a save wipe',
    JSON.parse(store.get('grid-protocol.settings.v1')).musicVolume === 0.35);
}

/* =========================================================================
   7. Autoplay: a refused first gesture is retried
   ========================================================================= */

section('7. Autoplay — the browser that says no');

{
  // Context that refuses to resume, exactly as a locked-down browser does.
  const ctx = new StubContext({ state: 'suspended', resumeShouldFail: true });
  globalThis.window.AudioContext = function () { return ctx; };
  const engine = new AudioEngine();
  await engine.start();

  check('engine does NOT claim to be started', engine.probe.started === false);
  check('a start attempt was actually made', ctx.resumeCalls === 1);

  // The next gesture: now the browser lets it through.
  ctx.resumeShouldFail = false;
  const ok = await engine.retryStart();
  check('the retry starts the engine', ok === true && engine.probe.started === true);
  check('the engine is ready afterwards', engine.ready === true);
  check('the graph was built once, not rebuilt', ctx.nodes.filter((n) => n.kind === 'gain').length > 0);

  // And the sequencer actually produces sound after the retry.
  const before = ctx.startedNodes;
  run(engine, ctx, 5);
  check('notes are scheduled after the retry', ctx.startedNodes > before,
    `${ctx.startedNodes - before} voices started`);
}

/* =========================================================================
   8. Wipe the store and report
   ========================================================================= */

await server.close();

console.log(`\n${'='.repeat(52)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('='.repeat(52));

process.exit(fail ? 1 : 0);