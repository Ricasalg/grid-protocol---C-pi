/* ============================================================================
   The frame loop and the performance watchdog.

   A single rAF drives everything: world update, then render. Systems register
   an `update(dt, elapsed)` callback and never touch rAF themselves, so there
   is exactly one place where frame ordering is decided.

   The watchdog watches a rolling median of frame time and steps quality down
   when the device can't hold the target. It only ever reduces, never
   oscillates: after a drop it waits a few seconds before considering another,
   and it will not climb back up unprompted (hysteresis), because a visible
   quality flip mid-exploration is worse than a slightly soft image.
   ========================================================================== */

import { quality, type QualityTier } from '@/core/config';
import { bus } from '@/core/bus';

export interface LoopSystem {
  update(dt: number, elapsed: number): void;
  /** Optional: called after render, for late-frame work. */
  late?(): void;
}

const ORDER: QualityTier[] = ['high', 'medium', 'low'];

export class Loop {
  private systems: LoopSystem[] = [];
  private raf = 0;
  private running = false;

  private last = 0;
  private elapsed = 0;

  /** Rolling window of frame durations, milliseconds. */
  private samples: number[] = [];
  private sampleIndex = 0;
  private readonly sampleSize = 90;

  private cooldown = 0;
  private droppedThisSession = false;

  /** Live FPS, smoothed. Read by the HUD. */
  fps = 60;

  onFrame: ((dt: number, elapsed: number) => void) | null = null;

  add(system: LoopSystem): () => void {
    this.systems.push(system);
    return () => {
      const i = this.systems.indexOf(system);
      if (i >= 0) this.systems.splice(i, 1);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Seconds of simulated time since the loop started. */
  get time(): number {
    return this.elapsed;
  }

  private tick = (now: number): void => {
    if (!this.running) return;

    // Clamp dt so an alt-tab or a long GC pause cannot teleport the player
    // through a wall or fast-forward the Light Cycles simulation.
    const rawDt = (now - this.last) / 1000;
    const dt = Math.min(Math.max(rawDt, 0), 0.05);
    this.last = now;
    this.elapsed += dt;

    this.fps = this.fps * 0.92 + (1 / Math.max(rawDt, 0.0001)) * 0.08;
    this.sample(rawDt * 1000);
    this.watchdog(dt);

    for (const s of this.systems) {
      try {
        s.update(dt, this.elapsed);
      } catch (err) {
        console.error('[loop] system update failed:', err);
      }
    }

    this.onFrame?.(dt, this.elapsed);

    for (const s of this.systems) s.late?.();

    this.raf = requestAnimationFrame(this.tick);
  };

  private sample(ms: number): void {
    this.samples[this.sampleIndex] = ms;
    this.sampleIndex = (this.sampleIndex + 1) % this.sampleSize;
  }

  /**
   * Median rather than mean: one 300ms hitch from a GC pause or a tab switch
   * should not drag the whole verdict down.
   */
  private medianFrameMs(): number {
    const valid = this.samples.filter((v): v is number => typeof v === 'number');
    if (valid.length < this.sampleSize * 0.6) return 0;
    const sorted = [...valid].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private watchdog(dt: number): void {
    this.cooldown -= dt;

    // Target ~55 FPS on desktop. Below that for a sustained window, step down.
    const budget = 18.2;
    const median = this.medianFrameMs();
    if (median === 0) return;

    if (median > budget) {
      if (this.cooldown > 0) return;

      const idx = ORDER.indexOf(quality.tier);
      if (idx >= 0 && idx < ORDER.length - 1) {
        const next = ORDER[idx + 1];
        quality.setTier(next);
        this.applyTier(next);
        this.cooldown = 6;
        this.resetSamples();
        console.info(
          `[perf] median frame ${median.toFixed(1)}ms — reducing quality to "${next}"`,
        );
      } else {
        // Already at the floor. Nudge the cheap knobs instead of stopping.
        if (!this.droppedThisSession) {
          this.droppedThisSession = true;
          quality.patch({ groundDust: 60, skyMotes: 40, tunnelGlyphs: 20 });
          this.cooldown = 8;
          this.resetSamples();
        }
      }
    }
  }

  private applyTier(tier: QualityTier): void {
    // Systems listening for this rebuild their instance counts.
    bus.emit('quality:changed', { tier });
  }

  private resetSamples(): void {
    this.samples.length = 0;
    this.sampleIndex = 0;
  }
}