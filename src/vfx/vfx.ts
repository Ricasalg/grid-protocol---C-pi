/* ============================================================================
   Screen-level effects.

   Named in §16's module list and, until now, missing. Everything here is a
   post-processing input rather than a world object, which is exactly why it was
   worth its own module: these effects have no position, so they cannot live in
   the scene, and they must not live in main.ts either, because main.ts owns
   ordering rather than look.

   The rule the whole file follows: **the interface may disappear, but the world
   must still tell the player what just happened.** A red vignette and a closing
   frame convey a hit more honestly than a health bar, and §13 forbids the
   dashboard.
   ========================================================================== */

import { damp } from '@/core/rng';
import type { Renderer } from '@/render/renderer';

/**
 * Transient screen state.
 *
 * One class for three effects because they share a decay and a renderer handle;
 * splitting them would triple the wiring in main.ts for no benefit. Each effect
 * is set from a gameplay event and decays on its own, so a caller never has to
 * remember to turn anything off.
 */
export class ScreenFx {
  /** Damage flash, 0..1. */
  private punch = 0;
  /** Signal interference, 0..1. Used by the descent and by Corrupt. */
  private interference = 0;
  /** A sustained distortion while something hostile has eyes on you. */
  private dread = 0;

  /** How fast each of these falls back to nothing. */
  private readonly punchDecay = 5.5;
  private readonly interferenceDecay = 3;

  constructor(private readonly renderer: Renderer) {}

  /** A discrete hit. Stacks, but saturates: four hits should not be four flashes. */
  hit(strength = 1): void {
    this.punch = Math.min(1, this.punch + strength * 0.6);
  }

  /** A softer mark — losing a cycle, being refused at a door. */
  blip(strength = 0.35): void {
    this.punch = Math.min(0.6, this.punch + strength * 0.35);
  }

  /** Sustained interference, 0..1. Rises immediately, decays slowly. */
  setInterference(amount: number): void {
    this.interference = Math.max(this.interference, amount);
  }

  /** Sustained wrongness — something hunting you. 0..1, eased both ways. */
  setDread(amount: number): void {
    this.dreadTarget = amount;
  }

  private dreadTarget = 0;

  /**
   * Per-frame decay and upload.
   *
   * `dread` is eased rather than snapped, because a hard cut to and from the
   * hunted look would read as a bug and a linear one would fight the damped
   * motion everywhere else in the game.
   */
  update(dt: number): void {
    this.punch = Math.max(0, this.punch - dt * this.punchDecay * Math.max(0.2, this.punch));
    this.interference = Math.max(0, this.interference - dt * this.interferenceDecay * this.interference);
    this.dread = damp(this.dread, this.dreadTarget, 2.2, dt);
    this.dreadTarget = Math.max(0, this.dreadTarget - dt * 0.6);

    this.renderer.setPunch(this.punch);
    this.renderer.setInterference(this.interference + this.dread * 0.12);
  }

  /** Zero everything. Called on respawn, so a death cannot bleed into the next run. */
  reset(): void {
    this.punch = 0;
    this.interference = 0;
    this.dread = 0;
    this.dreadTarget = 0;
    this.renderer.setPunch(0);
    this.renderer.setInterference(0);
  }
}

/**
 * A one-shot screen-wide event that must complete before play resumes.
 *
 * The sector transition uses this: a brief blackout with rising interference,
 * which is what makes walking through a door feel like crossing a layer rather
 * than like a page load. Kept here rather than in main.ts so the timing lives
 * with the other effects.
 */
export function crossThreshold(fx: ScreenFx, milliseconds = 900): Promise<void> {
  fx.setInterference(1);
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}