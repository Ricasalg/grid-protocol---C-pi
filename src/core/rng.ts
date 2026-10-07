/* ============================================================================
   Deterministic pseudo-randomness.

   The Grid is procedurally assembled, but a *run* must be reproducible: when
   the player dies, the reconnect has to rebuild the same Grid they were
   exploring, or "the network feels bigger than one attempt" turns into "the
   network is different every time, so nothing matters".

   Everything world-generating therefore draws from a seeded stream. Pure
   cosmetic jitter (particle shimmer, flicker phase) uses Math.random via
   `volatileRng` since it must NOT be reproducible.
   ========================================================================== */

/** mulberry32 — small, fast, good enough distribution for level layout. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform pick. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fisher-Yates, in place, returns the same array. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  /** Fork a child stream — keeps subsystems from consuming each other's draws. */
  fork(salt: number): Rng {
    return new Rng((this.s ^ Math.imul(salt, 0x85ebca6b)) >>> 0);
  }

  /** Derive a stable sub-seed from a string (FNV-1a). */
  seedFrom(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
}

/** Hash a string to a 32-bit seed (module-level convenience). */
export function hashSeed(str: string): number {
  return new Rng(0).seedFrom(str);
}

/**
 * Non-reproducible randomness for purely visual jitter. Using the seeded
 * stream here would make every particle phase identical across a rebuild.
 */
export const volatileRng = {
  next: () => Math.random(),
  range: (min: number, max: number) => min + Math.random() * (max - min),
  int: (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1)),
  chance: (p: number) => Math.random() < p,
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  },
};

/* -------------------------------------------------------------------------
   Scalar helpers used all over the VFX and camera code.
   ------------------------------------------------------------------------- */

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp, clamped. */
export function invLerp(a: number, b: number, v: number): number {
  return clamp01((v - a) / (b - a || 1));
}

/** Hermite smoothstep between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential smoothing. `rate` is per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Smoothly approach an angle (radians) without taking the long way round. */
export function dampAngle(
  current: number,
  target: number,
  rate: number,
  dt: number,
): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-rate * dt));
}