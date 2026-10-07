/* ============================================================================
   Audio engine.

   Everything is synthesised at runtime with the Web Audio API: no music files,
   no samples, no licensing questions, and the soundtrack can react to game
   state continuously rather than crossfading between fixed tracks.

   Architecture:
     master -> [per-layer gain] -> destination
       ambience   : slow evolving pad, always on
       music      : arpeggio/bass sequencer, per-area pattern
       sfx        : one-shot voices
       spatial    : a few world-anchored sources (the Arcade leaking out)

   A single pulse signal derived from the music's current amplitude is exposed
   to the renderer, so the Grid's grid-lines breathe with the beat. That link
   between audio and visuals is most of what makes the world feel alive.
   ========================================================================== */

import { loadSettings, saveSettings } from '@/core/save';
import { clamp, clamp01, damp, hashSeed, Rng } from '@/core/rng';
import { allTracks, RadioOrder, shapeOf, type Track } from './radio';

export type AreaId = 'grid' | 'arcade' | 'cycles' | 'archive' | 'security' | 'corrupt' | 'core' | 'iso';

/**
 * Is the context actually allowed to make sound?
 *
 * `AudioContext.state` is a live getter, but TypeScript keeps the narrowing from
 * an earlier `=== 'suspended'` check across an intervening `await`, so reading it
 * directly can make an honest `=== 'running'` look impossible. Going through a
 * helper loses the narrowing and gets a fresh read.
 */
function isRunning(ctx: BaseAudioContext): boolean {
  return ctx.state === 'running';
}

/**
 * How far the music dips during a track handover, as a fraction of the level the
 * player set. Below 1 the layer swells; at 1 it would sit flat and only the
 * notes changing would mark the transition.
 */
const MUSIC_XFADE_FLOOR = 0.55;

/**
 * Per-area musical identity. Each entry is a scale, a tempo and a timbre set;
 * switching areas crossfades layer gains rather than hard-cutting, so travel
 * between sectors feels continuous.
 */
interface AreaMusic {
  /** Semitone offsets from the root. */
  scale: number[];
  root: number;
  bpm: number;
  /** Waveform for the arpeggio voice. */
  wave: OscillatorType;
  /** Filter cutoff for the pad, Hz. */
  padCutoff: number;
  /** Whether the bass sequencer runs. */
  bass: boolean;
  /** Distortion/glitch amount, 0..1. Sets the Corrupt sector's character. */
  glitch: number;
  padGain: number;
  arpGain: number;
}

const AREAS: Record<AreaId, AreaMusic> = {
  grid: {
    scale: [0, 3, 7, 10, 14],
    root: 45, // A
    bpm: 74,
    wave: 'triangle',
    padCutoff: 520,
    bass: true,
    glitch: 0,
    padGain: 0.30,
    arpGain: 0.10,
  },
  arcade: {
    // Bright, energetic, driving.
    scale: [0, 2, 4, 7, 9, 12],
    root: 52, // E
    bpm: 128,
    wave: 'square',
    padCutoff: 1500,
    bass: true,
    glitch: 0.04,
    padGain: 0.18,
    arpGain: 0.20,
  },
  cycles: {
    // Relentless. Pure pulse.
    scale: [0, 3, 5, 7, 10, 12],
    root: 45,
    bpm: 150,
    wave: 'sawtooth',
    padCutoff: 900,
    bass: true,
    glitch: 0.10,
    padGain: 0.14,
    arpGain: 0.26,
  },
  archive: {
    // Slow, wide, unresolved.
    scale: [0, 2, 5, 7, 9],
    root: 38,
    bpm: 58,
    wave: 'sine',
    padCutoff: 340,
    bass: false,
    glitch: 0,
    padGain: 0.36,
    arpGain: 0.07,
  },
  security: {
    // Minor second, tritone-ish: deliberately uncomfortable.
    scale: [0, 1, 3, 6, 8, 11],
    root: 43,
    bpm: 104,
    wave: 'sawtooth',
    padCutoff: 1100,
    bass: true,
    glitch: 0.16,
    padGain: 0.16,
    arpGain: 0.18,
  },
  corrupt: {
    scale: [0, 1, 4, 6, 7, 11],
    root: 41,
    bpm: 96,
    wave: 'square',
    padCutoff: 700,
    bass: true,
    glitch: 0.55,
    padGain: 0.22,
    arpGain: 0.15,
  },
  core: {
    // Epic: wide fifths, big root, driving.
    scale: [0, 7, 12, 14, 19],
    root: 33,
    bpm: 120,
    wave: 'sawtooth',
    padCutoff: 1000,
    bass: true,
    glitch: 0.06,
    padGain: 0.30,
    arpGain: 0.22,
  },
  iso: {
    // Her motif: sparse, high, slightly detuned, and unmistakably not the Grid's
    // own music. Two voices a few cents apart beat against each other.
    scale: [0, 2, 7, 9, 14, 16],
    root: 57,
    bpm: 66,
    wave: 'triangle',
    padCutoff: 620,
    bass: false,
    glitch: 0,
    padGain: 0.26,
    arpGain: 0.13,
  },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private layers!: {
    ambience: GainNode;
    music: GainNode;
    sfx: GainNode;
  };

  /**
   * The music layer's own gain, ahead of `layers.music`.
   *
   * Separate so the radio can be turned down, or off, without touching the
   * master volume or the ambience. It exists as its own node rather than as a
   * multiplier on `layers.music` so that changing it never has to re-apply
   * whatever `duck()` last set.
   */
  private musicGain: GainNode | null = null;

  private padOsc: OscillatorNode[] = [];
  private padFilter: BiquadFilterNode | null = null;

  private arpTimer = 0;
  private bassTimer = 0;
  private step = 0;

  private current: AreaId = 'grid';
  private target: AreaId = 'grid';
  private mix = 1; // 0..1 crossfade between current and target

  /* --- the radio ---
     The track is a separate question from the area. The area is where the
     player is and it is driven by `setArea()`; the track is what the radio is
     broadcasting and it advances on its own. They are deliberately independent,
     which is what lets travel between sectors retune the music continuously
     instead of interrupting it. */
  private radio: RadioOrder;
  /**
   * Index into the playlist. Assigned in the constructor from the shuffled
   * queue, never left at 0: starting at index 0 would always open on
   * `PLAYLIST[0]` regardless of the shuffle, and that track is also in the
   * queue — so it could legitimately come round a second time a few minutes
   * later, which is exactly the "the radio skipped backwards" moment.
   */
  private trackIndex: number;
  private trackClock = 0;
  /** How far through the crossfade into the current track, 0..1. */
  private trackMix = 1;
  /** Indices already played this session, oldest first. Drives previousTrack. */
  private history: number[] = [];

  /**
   * Read-only view for the measurement harness (`tools/audio-harness.mjs`).
   *
   * The harness asserts on things that are genuinely internal — the sequencer
   * step, the crossfade position, the music gain node — and it is the only
   * thing that needs to see them. Marked `readonly` rather than dropped to
   * `private` outright so the access is deliberate and greppable instead of
   * scattered `as any` casts through the harness.
   */
  get probe(): {
    step: number;
    trackMix: number;
    musicGain: GainNode | null;
    started: boolean;
  } {
    return {
      step: this.step,
      trackMix: this.trackMix,
      musicGain: this.musicGain,
      started: this.started,
    };
  }

  private started = false;
  private startedAt = 0;

  /** Smoothed musical amplitude, read by the renderer each frame. */
  pulse = 0;
  /**
   * The value `pulse` chases. It rises on every note and decays.
   *
   * This is load-bearing and must keep being bumped by every voice: it is what
   * `main.ts` hands to `setMaterialTime()`, which drives the `uPulse` uniform
   * read by roughly a dozen materials. If the music stops and this decays to
   * zero, the Grid stops breathing — the grid lines go static and the floor
   * scanline stops moving. Silencing the radio must not do that.
   */
  private pulseInstant = 0;

  /** Rolling percussive hits for a visual "beat" flash. */
  private beatEnergy = 0;

  /* --- spatial sources --- */
  private spatial: Array<{ osc: OscillatorNode; gain: GainNode; pan: StereoPannerNode }> = [];

  private noiseBuffer: AudioBuffer | null = null;

  constructor() {
    // No audio graph is built until a user gesture unlocks the context.
    this.radio = new RadioOrder(new Rng(hashSeed('grid-protocol.radio')));
    // Draw the opening track from the same shuffled queue everything else comes
    // from, so it is not a special case and cannot repeat soon after.
    this.trackIndex = this.radio.next();
  }

  /* ---------------------------------------------------------------------
     Lifecycle
     --------------------------------------------------------------------- */

  /** Must be called from a user gesture (the JACK IN click). */
  async start(): Promise<void> {
    if (this.started) return;

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!Ctor) {
      console.warn('[audio] Web Audio unavailable; running silent.');
      return;
    }

    this.ctx = new Ctor();
    // Autoplay policy: the context may start suspended even after a gesture in
    // some browsers. Resume is safe to call repeatedly.
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* retried by the gesture handler installed in main */
      }
    }

    this.buildGraph();
    // Only claim to be started once the context is genuinely running. Setting
    // this unconditionally — which is what it used to do — combined with the
    // `if (this.started) return` guard at the top meant that a browser which
    // refused the first resume could never be retried: the engine looked
    // started, `update()` sequencered notes into a suspended context where
    // they were never heard, and `pulse` sat at zero so the Grid never lit up.
    // Leaving it false lets the next gesture finish the job.
    //
    // Read through a local: `ctx.state` is a getter that can change under us,
    // and TypeScript keeps the narrowing from the `=== 'suspended'` check above
    // across the await — which makes the honest comparison look impossible.
    this.started = isRunning(this.ctx);
    this.startedAt = this.ctx.currentTime;
    this.applyVolume();
  }

  /**
   * Finish a start that the browser refused.
   *
   * `start()` builds the graph once and then waits for permission to actually
   * make sound, so this only has to resume and confirm. Called from the first
   * pointer or key event after the first attempt, because that is the gesture
   * the autoplay policy was waiting for.
   */
  async retryStart(): Promise<boolean> {
    if (!this.ctx || isRunning(this.ctx)) return this.started;
    try {
      await this.ctx.resume();
    } catch {
      return false;
    }
    this.started = isRunning(this.ctx);
    if (this.started) this.startedAt = this.ctx.currentTime;
    return this.started;
  }

  get ready(): boolean {
    return this.started && this.ctx !== null && isRunning(this.ctx);
  }

  private buildGraph(): void {
    const ctx = this.ctx!;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;

    // A gentle limiter keeps the synth stack from clipping when several layers
    // and effects overlap.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;

    this.master.connect(limiter);
    limiter.connect(ctx.destination);

    this.layers = {
      ambience: ctx.createGain(),
      music: ctx.createGain(),
      sfx: ctx.createGain(),
    };
    this.layers.ambience.gain.value = 0.7;
    this.layers.music.gain.value = 0.55;
    this.layers.sfx.gain.value = 0.9;

    // The radio's own level sits between the music layer and the master, so
    // changing it is a single gain write that cannot disturb the duck state or
    // the master volume.
    this.musicGain = ctx.createGain();
    const s = loadSettings();
    this.musicGain.gain.value = s.musicEnabled ? s.musicVolume : 0.0001;
    this.layers.music.connect(this.musicGain);

    for (const l of Object.values(this.layers)) {
      if (l === this.layers.music) continue; // routed via musicGain
      l.connect(this.master);
    }
    this.musicGain.connect(this.master);

    this.buildNoiseBuffer();
    this.buildPad();
    this.buildAmbience();
  }

  /** A second of white noise, reused by every noise-based voice. */
  private buildNoiseBuffer(): void {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 1.0;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  /**
   * The pad: six detuned oscillators through a lowpass. Slight detune per
   * voice is what turns a static drone into something that sounds alive and
   * slightly unstable.
   */
  private buildPad(): void {
    const ctx = this.ctx!;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = AREAS.grid.padCutoff;
    this.padFilter.Q.value = 0.7;

    const padGain = ctx.createGain();
    padGain.gain.value = AREAS.grid.padGain;

    this.padFilter.connect(padGain);
    padGain.connect(this.layers.music);

    // Oscillators start silent; the sequencer opens them as chord tones arrive.
    const degrees = [0, 7, 12, 14, 19, 24];
    for (const d of degrees) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = this.midiToFreq(AREAS.grid.root + d);
      osc.detune.value = (Math.random() - 0.5) * 9;

      const vg = ctx.createGain();
      vg.gain.value = 0.0001;

      osc.connect(vg);
      vg.connect(this.padFilter);
      osc.start();

      this.padOsc.push(osc);
    }
  }

  /**
   * Room tone: filtered noise plus two very low drones. This is what makes the
   * Grid sound like a large empty space rather than a small room.
   */
  private buildAmbience(): void {
    const ctx = this.ctx!;

    // Airy noise, heavily filtered — distant system hum.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.6;

    const g = ctx.createGain();
    g.gain.value = 0.045;

    src.connect(bp);
    bp.connect(g);
    g.connect(this.layers.ambience);
    src.start();

    // Two sub drones an octave apart.
    for (const f of [38, 57]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;

      const dg = ctx.createGain();
      dg.gain.value = 0.05;

      // Slow LFO on the drone's level: the Grid's breathing.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.05 + Math.random() * 0.05;

      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.035;

      lfo.connect(lfoGain);
      lfoGain.connect(dg.gain);

      osc.connect(dg);
      dg.connect(this.layers.ambience);

      osc.start();
      lfo.start();
    }
  }

  /* ---------------------------------------------------------------------
     Volume
     --------------------------------------------------------------------- */

  /**
   * Push the radio's own level to the graph.
   *
   * `setTargetAtTime` with a 0.12s constant, matching `applyVolume`: a radio
   * volume control that clicks is worse than one that takes a moment to settle.
   */
  applyMusicVolume(): void {
    if (!this.musicGain || !this.ctx) return;
    const target = this.musicTarget();
    this.musicGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
  }

  /**
   * The gain the music layer should settle at, before any track crossfade.
   *
   * Both the volume control and the crossfade write this same node, so the
   * resting level is computed in one place: two copies of "what does music at
   * level 70% look like" would drift apart the first time the rules changed.
   */
  private musicTarget(): number {
    const s = loadSettings();
    return s.musicEnabled ? Math.max(0.0001, s.musicVolume) : 0.0001;
  }

  /** Turn the soundtrack on or off, leaving every other sound alone. */
  setMusicEnabled(on: boolean): void {
    saveSettings({ musicEnabled: on });
    this.applyMusicVolume();
  }

  /** Radio level, 0..1, independent of the master. */
  setMusicVolume(v: number): void {
    saveSettings({ musicVolume: clamp01(v) });
    this.applyMusicVolume();
  }

  get musicEnabled(): boolean {
    return loadSettings().musicEnabled;
  }

  get musicVolume(): number {
    return loadSettings().musicVolume;
  }

  applyVolume(): void {
    if (!this.master || !this.ctx) return;
    const s = loadSettings();
    const target = s.muted ? 0.0001 : Math.max(0.0001, s.masterVolume);

    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.12);
  }

  setVolume(v: number): void {
    saveSettings({ masterVolume: clamp01(v) });
    this.applyVolume();
  }

  setMuted(m: boolean): void {
    saveSettings({ muted: m });
    this.applyVolume();
  }

  get volume(): number {
    return loadSettings().masterVolume;
  }

  get muted(): boolean {
    return loadSettings().muted;
  }

  /* ---------------------------------------------------------------------
     Area switching
     --------------------------------------------------------------------- */

  /**
   * Retune to a new area's musical identity.
   *
   * Note what this deliberately no longer does: it used to reset `this.step`,
   * which restarted the arpeggio from the top of the scale. Travelling between
   * sectors therefore cut the phrase it was in the middle of — the music did not
   * stop, but it audibly restarted, which reads as the track being interrupted.
   * The scale, root and timbre now glide over the crossfade instead, and the
   * track's own position carries straight through.
   */
  setArea(area: AreaId): void {
    if (area === this.target) return;
    this.current = this.target;
    this.target = area;
    this.mix = 0;
  }

  get area(): AreaId {
    return this.target;
  }

  /* ---------------------------------------------------------------------
     The radio
     --------------------------------------------------------------------- */

  /** The track currently playing. */
  get nowPlaying(): Track {
    return allTracks()[this.trackIndex];
  }

  /** The track that will follow, for the strip's lookahead. */
  get upNext(): Track {
    return allTracks()[this.radio.peek()];
  }

  /** Seconds elapsed in the current track. */
  get trackPosition(): number {
    return this.trackClock;
  }

  /** Total length of the current track, seconds. */
  get trackLength(): number {
    return shapeOf(this.nowPlaying, AREAS[this.nowPlaying.area].bpm).duration;
  }

  /** Skip to the next track. Crossfades rather than cutting. */
  nextTrack(): void {
    this.history.push(this.trackIndex);
    // Bound the history so a long session cannot grow it without limit. Eight
    // is far more than `previousTrack` can usefully walk back through.
    if (this.history.length > 8) this.history.shift();

    this.trackIndex = this.radio.next();
    this.trackClock = 0;
    this.trackMix = 0;
    // A new track means a new area's palette; retune without a crossfade
    // restart, so the sequencer keeps its place and only the notes change.
    this.retuneTo(this.nowPlaying.area);
  }

  /** Go back to the previous track. Crossfades rather than cutting. */
  previousTrack(): void {
    const at = this.history.lastIndexOf(this.trackIndex);
    const back = at > 0 ? this.history[at - 1] : this.history[this.history.length - 1];
    if (back === undefined) return;

    this.history.pop();
    this.trackIndex = back;
    this.trackClock = 0;
    this.trackMix = 0;
    this.retuneTo(this.nowPlaying.area);
  }

  /** Point the area crossfade at a new area without disturbing the phrase. */
  private retuneTo(area: AreaId): void {
    if (area === this.target) return;
    this.current = this.target;
    this.target = area;
    this.mix = 0;
  }

  /* ---------------------------------------------------------------------
     Ducking
     --------------------------------------------------------------------- */

  /**
   * Dim the music without stopping it (menus, terminals, reading).
   *
   * `duck(0)` must return the layer to its unducked level, so that level lives
   * here as a constant rather than being written into the node by hand. It used
   * to be hard-coded at both ends, which meant the two could drift apart
   * unnoticed — and it now sits behind the radio's own gain, so the ducked and
   * unducked values have to be explicit about what they mean.
   */
  private static readonly MUSIC_LEVEL = 0.55;

  duck(amount: number, seconds = 0.6): void {
    if (!this.ctx || !this.layers) return;
    const g = this.layers.music.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(
      AudioEngine.MUSIC_LEVEL * (1 - clamp01(amount)),
      this.ctx.currentTime,
      seconds / 3,
    );
  }

  unduck(seconds = 0.8): void {
    this.duck(0, seconds);
  }

  /* ---------------------------------------------------------------------
     Per-frame sequencing
     --------------------------------------------------------------------- */

  /**
   * Called every frame. Advances the arpeggio and bass sequencers using the
   * current area's tempo and scale, and updates the pulse signal.
   */
  update(dt: number): void {
    if (!this.ctx || !this.started) return;

    // Fade the master in on the very first frames so jack-in does not click.
    if (this.ctx.currentTime - this.startedAt < 1.5) {
      this.applyVolume();
    }

    this.advanceTrack(dt);

    const from = AREAS[this.current];
    const to = AREAS[this.target];
    this.mix = Math.min(1, this.mix + dt / 2.5);

    // Blend the two areas' parameters during the crossfade.
    const area: AreaMusic = {
      scale: this.mix >= 1 ? to.scale : from.scale,
      root: Math.round(from.root + (to.root - from.root) * this.mix),
      bpm: from.bpm + (to.bpm - from.bpm) * this.mix,
      wave: this.mix >= 1 ? to.wave : from.wave,
      padCutoff: from.padCutoff + (to.padCutoff - from.padCutoff) * this.mix,
      bass: this.mix >= 0.5 ? to.bass : from.bass,
      glitch: from.glitch + (to.glitch - from.glitch) * this.mix,
      padGain: from.padGain + (to.padGain - from.padGain) * this.mix,
      arpGain: from.arpGain + (to.arpGain - from.arpGain) * this.mix,
    };

    if (this.padFilter) {
      this.padFilter.frequency.setTargetAtTime(area.padCutoff, this.ctx.currentTime, 0.4);
    }

    this.sequence(area, dt);
    this.updatePulse(dt);
  }

  /**
   * Advance the track clock and hand over when it runs out.
   *
   * The handover goes through `nextTrack()` so that a track ending on its own
   * and the player pressing the skip button are the same code path — otherwise
   * an automatic transition would quietly drift away from the manual one, and
   * the first symptom would be the radio skipping backwards on a manual press.
   */
  private advanceTrack(dt: number): void {
    const length = shapeOf(this.nowPlaying, AREAS[this.nowPlaying.area].bpm).duration;

    this.trackClock += dt;
    if (this.trackMix < 1) {
      // Same 2.5s the area crossfade uses, so a track change and a retune are
      // indistinguishable in length and the seam never announces itself.
      this.trackMix = Math.min(1, this.trackMix + dt / 2.5);

      // The fade itself. `trackMix` goes 0 -> 1 over the change, and the gain
      // follows it down from its level into the tail of the outgoing track and
      // back up to full under the incoming one. Because it never passes through
      // zero on its own — the two ends sum to one — the music dips but is never
      // cut, and `pulseInstant` keeps feeding `uPulse` across the seam so the
      // Grid does not blink when the broadcast hands over.
      if (this.musicGain && this.ctx) {
        const g = this.musicGain.gain;
        g.cancelScheduledValues(this.ctx.currentTime);
        // Below the base level while handing over, back to it after. The floor is
        // where a crossfade sits: the two tracks overlap, so the sum holds
        // roughly the amplitude the player set rather than doubling it.
        const ceiling = this.musicTarget();
        const floor = ceiling * (this.musicEnabled ? MUSIC_XFADE_FLOOR : 1);
        g.setTargetAtTime(floor + (ceiling - floor) * this.trackMix, this.ctx.currentTime, 0.2);
      }
    }

    if (this.trackClock >= length) {
      // Carry the overshoot into the new track rather than dropping it, or a
      // long frame would shorten the track that follows.
      const overshoot = this.trackClock - length;
      this.nextTrack();
      this.trackClock = overshoot;
    }
  }

  private sequence(area: AreaMusic, dt: number): void {
    const beat = 60 / area.bpm;

    // --- arpeggio ---
    // `stepsPerBar` comes from the track rather than being a fixed eighth-note
    // pulse, which is what lets two tracks from the same area differ in how
    // busy they are without needing two sequencers.
    const shape = shapeOf(this.nowPlaying, area.bpm);
    const stepTime = beat / (shape.stepsPerBar / 4);

    this.arpTimer -= dt;
    if (this.arpTimer <= 0) {
      this.arpTimer += stepTime;
      this.step++;

      // Walk the scale, occasionally skipping — avoids a rigid ostinato.
      const idx = this.step % area.scale.length;
      const octave = Math.floor(this.step / area.scale.length) % 2;
      const deg = area.scale[idx] + octave * 12;

      this.playArp(area, deg);
      this.pulseInstant = Math.min(1, this.pulseInstant + 0.28);
    }

    // --- bass ---
    if (area.bass) {
      this.bassTimer -= dt;
      if (this.bassTimer <= 0) {
        this.bassTimer += beat;
        // Root on 1, fifth on 3 — a simple, driving pattern.
        const deg = this.step % 8 === 0 ? 0 : this.step % 4 === 0 ? 7 : 0;
        this.playBass(area, deg);
      }
    }
  }

  /** One arpeggio note: short, filtered, with a per-area timbre. */
  private playArp(area: AreaMusic, degree: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = area.wave;
    const freq = this.midiToFreq(area.root + degree + 24);
    osc.frequency.setValueAtTime(freq, now);

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(2600, now);
    filt.frequency.exponentialRampToValueAtTime(700, now + 0.22);
    filt.Q.value = 3;

    const g = ctx.createGain();
    const peak = area.arpGain * (0.7 + Math.random() * 0.3);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    osc.connect(filt);
    filt.connect(g);
    g.connect(this.layers.music);

    // Glitch: a short detuned doubling, used by the Corrupt/Security areas.
    if (area.glitch > 0.3 && Math.random() < area.glitch) {
      osc.frequency.setValueAtTime(freq * 1.06, now + 0.04);
    }

    osc.start(now);
    osc.stop(now + 0.34);
  }

  /** One bass note: sub-heavy, slow attack. */
  private playBass(area: AreaMusic, degree: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(this.midiToFreq(area.root + degree), now);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(area.padGain * 0.5, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

    osc.connect(g);
    g.connect(this.layers.music);
    osc.start(now);
    osc.stop(now + 0.6);

    this.pulseInstant = Math.min(1, this.pulseInstant + 0.16);
    this.beatEnergy = 1;
  }

  private updatePulse(dt: number): void {
    // Attack fast, release slow: reads as a musical envelope rather than noise.
    this.pulseInstant = Math.max(0, this.pulseInstant - dt * 1.6);
    this.pulse = damp(this.pulse, this.pulseInstant, 12, dt);
    this.beatEnergy = Math.max(0, this.beatEnergy - dt * 3.2);
  }

  /** 0..1, spikes on each bass hit. Used for visual beat reactions. */
  get beat(): number {
    return this.beatEnergy;
  }

  private midiToFreq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /* ---------------------------------------------------------------------
     SFX
     --------------------------------------------------------------------- */

  /** Generic blip: the Grid's UI sound. */
  blip(freq = 880, duration = 0.07, volume = 0.16, type: OscillatorType = 'square'): void {
    if (!this.ctx || !this.layers) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.82, now + duration);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(volume, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(g);
    g.connect(this.layers.sfx);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Confirmation/positive tone: two rising notes. */
  confirm(): void {
    if (!this.ctx) return;
    this.blip(660, 0.09, 0.14, 'triangle');
    window.setTimeout(() => this.blip(990, 0.13, 0.14, 'triangle'), 80);
  }

  /** Rejection: a falling pair. */
  deny(): void {
    if (!this.ctx) return;
    this.blip(320, 0.10, 0.14, 'square');
    window.setTimeout(() => this.blip(210, 0.16, 0.12, 'square'), 90);
  }

  /** Soft, crystalline footfall. */
  footstep(speed = 1): void {
    if (!this.ctx || !this.layers || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    // Randomising the read offset avoids the same click every step.
    const offset = Math.random() * 0.9;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400 + Math.random() * 1800;
    bp.Q.value = 3.5;

    const g = ctx.createGain();
    const v = 0.05 * clamp(speed, 0.5, 1.8);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(v, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.layers.sfx);

    src.start(now, offset, 0.14);
  }

  /** Rising whoosh for the descent. `t` is 0..1 through the sequence. */
  whoosh(t: number): void {
    if (!this.ctx || !this.layers || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 2.6;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    // Filter opens as the fall accelerates — the classic "speed" cue.
    bp.frequency.setValueAtTime(300, now);
    bp.frequency.exponentialRampToValueAtTime(1800 + t * 2600, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.14 + t * 0.12, now + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.layers.sfx);
    src.start(now);
    src.stop(now + dur + 0.1);
  }

  /** Sub-bass swell under the descent, tied to velocity. */
  subSwell(t: number): void {
    if (!this.ctx || !this.layers) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 4.0;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(30, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + dur);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.16 + t * 0.2, now + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(g);
    g.connect(this.layers.sfx);
    osc.start(now);
    osc.stop(now + dur + 0.1);
  }

  /** Impact with reverb tail: the landing. */
  impact(): void {
    if (!this.ctx || !this.layers || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Low thud.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.5);

    const og = ctx.createGain();
    og.gain.setValueAtTime(0.34, now);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);

    osc.connect(og);
    og.connect(this.layers.sfx);
    osc.start(now);
    osc.stop(now + 0.75);

    // Noise burst through a long convolution-free delay: a cheap plate.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;

    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.11;

    const fb = ctx.createGain();
    fb.gain.value = 0.42;

    const wet = ctx.createGain();
    wet.gain.setValueAtTime(0.22, now);
    wet.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);

    src.connect(hp);
    hp.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(wet);
    wet.connect(this.layers.sfx);

    src.start(now, Math.random() * 0.5, 0.3);
  }

  /** Bright rising arpeggio: sector discovered. */
  discovery(): void {
    if (!this.ctx) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      window.setTimeout(() => this.blip(f, 0.22, 0.12, 'triangle'), i * 85);
    });
  }

  /** Alarm: used by security systems and hostile programs. */
  alarm(): void {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) {
      window.setTimeout(() => this.blip(440, 0.14, 0.16, 'sawtooth'), i * 200);
    }
  }

  /** Connection lost: everything drops out at once. */
  disconnect(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.25);
    window.setTimeout(() => this.applyVolume(), 2200);
  }

  /* ---------------------------------------------------------------------
     Spatial sources
     --------------------------------------------------------------------- */

  /**
   * A world-anchored looping source with distance attenuation, used for the
   * Arcade's music leaking out into the plaza. This is the audio half of
   * "you can hear the way to go".
   */
  createSpatialSource(freq: number, type: OscillatorType = 'sawtooth'): {
    update: (playerX: number, playerZ: number, sourceX: number, sourceZ: number, maxDist: number) => void;
    stop: () => void;
  } {
    if (!this.ctx || !this.layers) {
      return { update: () => {}, stop: () => {} };
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 1200;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const pan = ctx.createStereoPanner();

    osc.connect(filt);
    filt.connect(gain);
    gain.connect(pan);
    pan.connect(this.layers.ambience);

    // A slow tremolo so it reads as "music from a building", not a test tone.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 3.1;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.4;
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);

    osc.start(now);
    lfo.start(now);

    this.spatial.push({ osc, gain, pan });

    return {
      update: (px, pz, sx, sz, maxDist) => {
        const d = Math.hypot(px - sx, pz - sz);
        const t = clamp01(1 - d / maxDist);
        // Equal-power-ish falloff, squared for a natural rolloff.
        const vol = t * t * 0.3;
        gain.gain.setTargetAtTime(vol, ctx.currentTime, 0.15);
        // Brighter when close: the filter opening reads as proximity.
        filt.frequency.setTargetAtTime(400 + t * 2600, ctx.currentTime, 0.2);
        pan.pan.setTargetAtTime(clamp((sx - px) / Math.max(maxDist, 1), -1, 1), ctx.currentTime, 0.2);
      },
      stop: () => {
        try {
          gain.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
          osc.stop(ctx.currentTime + 0.6);
          lfo.stop(ctx.currentTime + 0.6);
        } catch {
          /* already stopped */
        }
      },
    };
  }

  /* ---------------------------------------------------------------------
     Lifecycle helpers
     --------------------------------------------------------------------- */

  /** Seconds of audio time elapsed. */
  get time(): number {
    return this.ctx ? this.ctx.currentTime - this.startedAt : 0;
  }

  suspend(): Promise<void> | undefined {
    return this.ctx?.suspend();
  }

  resume(): Promise<void> | undefined {
    return this.ctx?.resume();
  }
}