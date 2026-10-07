/* ============================================================================
   Runtime configuration & quality tiers.

   Quality is auto-detected once at boot and can be adjusted live from the
   settings drawer. Every expensive system (bloom, particle counts, tunnel
   density, shadow-ish tricks) reads from here rather than hard-coding numbers,
   so the perf watchdog can degrade the whole game coherently.
   ========================================================================== */

import { loadSettings } from '@/core/save';

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityProfile {
  tier: QualityTier;

  /** Renderer pixel ratio ceiling. */
  maxPixelRatio: number;

  /** UnrealBloomPass resolution divisor (higher = cheaper). */
  bloomScale: number;
  bloomStrength: number;

  /** Rendered reflection plane resolution divisor for the mirrored skyline. */
  reflectionScale: number;

  /** Tunnel wall ring/segment counts during the descent. */
  tunnelSegments: number;
  tunnelRingSpacing: number;

  /** Ambient particle counts. */
  groundDust: number;
  skyMotes: number;

  /** Data-block instances flanking the descent tunnel. */
  tunnelGlyphs: number;

  /** Whether to run the fake-reflection pass at all. */
  reflections: boolean;

  /** Chromatic aberration strength in the composite pass. */
  aberration: number;

  /** Whether head bob and speed-driven FOV kicks are allowed. */
  cameraMotion: boolean;

  /** Arcade cabinet count. The Light Cycle is always built regardless. */
  arcadeMachines: number;

  /**
   * Multiplier for procedural sector content — structure count, ceiling ribs,
   * ambient motes. Sectors are generated, so this is the cheapest dial to turn
   * when a scene is too heavy: the layout is unchanged, only its density.
   */
  sectorDetail: number;
}

const PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    tier: 'low',
    maxPixelRatio: 1,
    bloomScale: 4,
    bloomStrength: 0.62,
    reflectionScale: 6,
    tunnelSegments: 7,
    tunnelRingSpacing: 2.4,
    groundDust: 260,
    skyMotes: 180,
    tunnelGlyphs: 70,
    reflections: false,
    aberration: 0,
    cameraMotion: false,
    arcadeMachines: 8,
    sectorDetail: 0.5,
  },
  medium: {
    tier: 'medium',
    maxPixelRatio: 1.5,
    bloomScale: 3,
    bloomStrength: 0.78,
    reflectionScale: 4,
    tunnelSegments: 11,
    tunnelRingSpacing: 1.7,
    groundDust: 700,
    skyMotes: 460,
    tunnelGlyphs: 140,
    reflections: true,
    aberration: 0.0009,
    cameraMotion: true,
    arcadeMachines: 16,
    sectorDetail: 0.75,
  },
  high: {
    tier: 'high',
    maxPixelRatio: 2,
    bloomScale: 2,
    bloomStrength: 0.92,
    reflectionScale: 3,
    tunnelSegments: 15,
    tunnelRingSpacing: 1.25,
    groundDust: 1400,
    skyMotes: 900,
    tunnelGlyphs: 240,
    reflections: true,
    aberration: 0.0016,
    cameraMotion: true,
    arcadeMachines: 24,
    sectorDetail: 1.0,
  },
};

/** Deep-freeze so no system can mutate the shared profile object. */
function freeze(p: QualityProfile): Readonly<QualityProfile> {
  return Object.freeze({ ...p });
}

export const QUALITY_PRESETS: Readonly<Record<QualityTier, Readonly<QualityProfile>>> =
  Object.freeze({
    low: freeze(PROFILES.low),
    medium: freeze(PROFILES.medium),
    high: freeze(PROFILES.high),
  });

/* -------------------------------------------------------------------------
   Live, mutable quality state. Systems read this object each frame.
   ------------------------------------------------------------------------- */

const initialTier = detectTier();
let current = { ...QUALITY_PRESETS[initialTier] };

export const quality = {
  /** Read-only view of the active profile. */
  get profile(): Readonly<QualityProfile> {
    return current;
  },
  get tier(): QualityTier {
    return current.tier;
  },

  /**
   * Apply a tier. Every system reads from `quality.profile`, so this is enough
   * to change the whole game's cost profile at runtime.
   */
  setTier(tier: QualityTier): void {
    current = { ...QUALITY_PRESETS[tier] };
  },

  /**
   * Nudge individual fields without a full tier switch. Used by the perf
   * watchdog, which prefers surgical reduction (particle counts, bloom
   * resolution) over a jarring visible tier flip.
   */
  patch(partial: Partial<QualityProfile>): void {
    current = { ...current, ...partial };
  },

  /** True when motion effects are safe for this device and user preference. */
  get motionOk(): boolean {
    return current.cameraMotion && !effectiveReducedMotion();
  },
};

/* -------------------------------------------------------------------------
   Device / preference detection
   ------------------------------------------------------------------------- */

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The effective reduced-motion decision, combining the OS preference with the
 * player's in-game override. `auto` defers to the OS; `on` and `off` force it.
 *
 * This lives here rather than in the settings panel because the descent reads
 * it before any UI is on screen.
 */
export function effectiveReducedMotion(): boolean {
  const override = loadSettings().reducedMotion;
  if (override === 'on') return true;
  if (override === 'off') return false;
  return prefersReducedMotion();
}

/**
 * Users can ask the OS for reduced flashing (photosensitive epilepsy support).
 * We honour it by softening full-screen luminance changes; note this is a
 * separate query from prefers-reduced-motion.
 */
export function prefersReducedFlash(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-flash: reduce)').matches
  );
}

export function isTouchDevice(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  );
}

function detectTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';

  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const coarse = isTouchDevice();

  // Very small viewports are usually phones; treat as low regardless of cores.
  const small = typeof innerWidth === 'number' && innerWidth < 520;

  if (small || cores <= 4 || mem <= 3) return coarse || small ? 'low' : 'medium';
  if (cores >= 8 && mem >= 8) return 'high';
  return 'medium';
}

/* -------------------------------------------------------------------------
   Global timings that more than one system needs to agree on.
   ------------------------------------------------------------------------- */

export const TIMING = {
  /** Length of the cinematic descent, seconds. */
  descentDuration: 12.6,
  /** Boot sequence before the call to action appears. */
  bootDuration: 7.2,
  /** How long the control hint stays up after control is handed over. */
  controlHintDuration: 5.0,
  /** Camera height in metres — first person. */
  eyeHeight: 1.7,
  /** Player capsule radius for collision. */
  playerRadius: 0.42,
} as const;

/* -------------------------------------------------------------------------
   Movement tuning
   -------------------------------------------------------------------------

   Every number that decides how the character feels lives here, in one object,
   so it can be tuned without reading the controller. The values are starting
   points, not physics constants: each is commented with what raising or
   lowering it actually does, because "walk speed 4.6" on its own does not tell
   you whether the game will feel heavy or floaty.

   This is a live mutable object rather than a frozen profile, for the same
   reason `quality` is: these are feel dials, and being able to push one at
   runtime is how you find the value. Nothing else in the codebase writes to it.
   ------------------------------------------------------------------------- */

export interface MovementTuning {
  /** Ground speed with no run modifier, m/s. Lower = heavier, deliberate. */
  walkSpeed: number;

  /** Ground speed while Shift (or a full-throw stick) is held, m/s. */
  runSpeed: number;

  /**
   * Hard ceiling on horizontal speed, m/s. Normally never reached — it exists
   * so that collision pushes, or a future slope, cannot launch the player.
   */
  maxSpeed: number;

  /**
   * How fast velocity approaches the target while input is held. Higher =
   * more instant. The current value reaches ~95% of top speed in about 0.21s,
   * which is roughly where a modern shooter stops feeling sluggish.
   */
  accelRate: number;

  /**
   * How fast velocity bleeds off when input is released. Deliberately lower
   * than accelRate: stopping should have a little more weight than starting,
   * which is what sells a body behind the camera.
   */
  decelRate: number;

  /**
   * Extra damping applied to the sideways component of velocity when the wish
   * direction differs from the current one. Higher = tighter, more carved
   * turns and less of a skid; lower = looser, more like ice.
   */
  directionChangeSensitivity: number;

  /**
   * How much the target speed drops at a full 180-degree turn, 0..1. 0 means
   * you keep full speed through any change of direction (fast, arcadey, and
   * prone to looking like sliding); higher values make hard turns cost speed.
   */
  turnSpeedPenalty: number;

  /** Global multiplier on mouse/touch look. 1 = the value already in use. */
  rotationSpeed: number;

  /**
   * Mouse delta (rad/frame) at which look speed starts ramping up. Below it,
   * small corrections stay 1:1 and precise; above it, sustained flicks get
   * faster. This is the "rotation acceleration" of a mouselook, and it is the
   * single biggest contributor to a camera feeling responsive without feeling
   * twitchy. Set to 0 to disable the ramp entirely.
   */
  rotationAcceleration: number;

  /** Ceiling on that ramp, as a multiplier. 1.6 means 60% faster at full flick. */
  rotationAccelerationMax: number;

  /** Head-bob amplitude in metres at full walk speed. Kept very small. */
  bobAmplitude: number;

  /**
   * Metres per footstep. Bob phase is derived from distance covered against
   * this, which is what guarantees the head never slides: the body oscillates
   * at a rate fixed to ground covered, not to time elapsed.
   */
  strideLength: number;

  /** Forward head-bob amplitude as a fraction of the base. */
  bobForward: number;
  /** Backward head-bob amplitude as a fraction of the base. Shorter, shyer. */
  bobBackward: number;
  /** Strafe head-bob amplitude as a fraction of the base. */
  bobStrafe: number;
  /**
   * Backward and strafe steps cover this fraction of the stride distance, so
   * they fire more often. This is what makes backing away read as different
   * from walking rather than as walking with a dimmer bob.
   */
  backwardStrideScale: number;
  strafeStrideScale: number;

  /**
   * Rate at which the camera's height eases toward the support height. Higher
   * = tighter to the floor. This is smoothing, not physics: it removes the
   * one-frame pop when the support under the player changes.
   */
  groundSmoothing: number;

  /** Highest ledge, in metres, the player walks over instead of colliding. */
  stepHeight: number;

  /**
   * Camera roll while strafing or turning, in radians. 0.012 is about 0.7
   * degrees — below conscious notice, above the threshold where the world
   * feels nailed to the head. §13 of the brief warns against exaggeration.
   */
  strafeRoll: number;
  turnRoll: number;

  /**
   * Camera pitch offset at top speed, radians. A fraction of a degree of
   * forward intent. Any more and it becomes a lurch.
   */
  accelPitch: number;

  /** Amplitude of the standing idle drift, in metres. Sub-millimetre scale. */
  idleDrift: number;

  /** Rate the idle drift evolves at. Slow enough to never read as a loop. */
  idleDriftRate: number;

  /**
   * Rate the camera position eases toward the logical player position. Only
   * visible when something external snaps the position (a collision pop, a
   * teleport being clamped); high enough that it never reads as input lag.
   */
  cameraFollowRate: number;
}

/**
 * Starting values. Chosen to be close to what the controller already did, so
 * that turning this on is a refinement rather than a change of character —
 * the brief asks for an evolution of the existing feel, not a replacement.
 */
const DEFAULT_MOVEMENT: MovementTuning = {
  walkSpeed: 4.6,
  runSpeed: 8.4,
  maxSpeed: 9.6,
  accelRate: 14,
  decelRate: 10,
  directionChangeSensitivity: 9,
  turnSpeedPenalty: 0.45,
  rotationSpeed: 1,
  rotationAcceleration: 0.055,
  rotationAccelerationMax: 1.6,
  bobAmplitude: 0.035,
  strideLength: 2.1,
  bobForward: 1,
  bobBackward: 0.55,
  bobStrafe: 0.85,
  backwardStrideScale: 1.35,
  strafeStrideScale: 1.15,
  groundSmoothing: 18,
  stepHeight: 0.35,
  strafeRoll: 0.012,
  turnRoll: 0.008,
  accelPitch: 0.008,
  idleDrift: 0.004,
  idleDriftRate: 0.7,
  cameraFollowRate: 22,
};

export const MOVEMENT: MovementTuning = { ...DEFAULT_MOVEMENT };

/** Restore every dial to its shipped value. Used by the settings reset. */
export function resetMovement(): void {
  Object.assign(MOVEMENT, DEFAULT_MOVEMENT);
}

/** Palette in one place so VFX and UI never drift apart. */
export const PALETTE = {
  black: 0x000000,
  ink: 0x04070c,
  cyan: 0x4fe3ff,
  cyanDim: 0x1d6f88,
  ice: 0xbfefff,
  white: 0xffffff,
  amber: 0xff9c2b,
  amberDim: 0x8a4d0e,
  violet: 0xa06bff,
  red: 0xff3b52,
} as const;