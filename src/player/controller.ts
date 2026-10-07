/* ============================================================================
   First-person player controller.

   Camera at ~1.7m, capsule collision against axis-aligned boxes, no rigid-body
   physics. Movement is accelerated rather than instant and carries a short
   inertia tail, because instant velocity reads as "a cursor with a camera
   glued on" and this game lives or dies on the walking feeling good.

   Supports three input paths with identical semantics:
     - desktop keyboard + Pointer Lock mouse
     - touch: left virtual stick, right-half drag to look, on-screen action
     - scripted: the cinematic descent drives position/rotation directly

   There is no character mesh and no animation system anywhere in this project
   (verified: no SkinnedMesh, AnimationMixer or model loader exists). Everything
   a third-person controller would express through a skeleton is expressed here
   through the camera instead — bob, roll, lean, stride cadence. That is not a
   compromise: it is how first-person games since Doom have sold weight, and it
   is why no visual asset had to change to deliver this.

   Every feel number is in `MOVEMENT` in core/config.ts. Nothing in this file
   should hard-code a speed, a rate or a degree.
   ========================================================================== */

import * as THREE from 'three';
import { MOVEMENT, TIMING, quality } from '@/core/config';
import { clamp, damp, dampAngle } from '@/core/rng';
import { loadSettings } from '@/core/save';

export interface AABB {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/**
 * The locomotion state machine of §15.
 *
 * These are not cosmetic labels. Each one maps to a different set of camera
 * parameters — bob amplitude, roll, FOV — so the transition between them is a
 * change in how the camera moves, not a change in a variable nothing reads.
 */
export type MoveState =
  | 'IDLE'
  | 'START_WALK'
  | 'WALK'
  | 'START_RUN'
  | 'RUN'
  | 'DECELERATE'
  | 'STOP'
  | 'TURN_LEFT'
  | 'TURN_RIGHT'
  | 'TURN_180'
  | 'STRAFE_LEFT'
  | 'STRAFE_RIGHT'
  | 'MOVE_BACKWARD';

export interface ControllerCallbacks {
  /** Called when footfall lands — drives the floor ripple and the step sound. */
  onFootstep?: (position: THREE.Vector3, speed: number) => void;
  /** Called when the locomotion state changes. Diagnostics and audio can use it. */
  onStateChange?: (from: MoveState, to: MoveState) => void;
}

/** Speed below which the player counts as standing still, m/s. */
const IDLE_SPEED = 0.35;

/**
 * How fast the camera chases the aim angles, in exponential damping rate.
 *
 * High on purpose. §16 puts responsiveness above everything else, and this is
 * not the number that decides responsiveness — `rotationAcceleration` is. This
 * only decides what happens to a delta too large to be absorbed in one frame,
 * and at this rate that case resolves in roughly 30ms, which is under two
 * frames: a safety net against a snap, not a smoothing filter you can feel.
 */
const LOOK_FOLLOW_RATE = 26;

/** Eye height above the floor when standing still. */
const BASE_EYE: number = TIMING.eyeHeight;

/** Crouch offset used by the Light Cycles mini-game for a lower viewpoint. */
const CYCLE_EYE = 1.25;

/**
 * Re-exported so `import { WALK_SPEED } from '@/player/controller'` keeps
 * working. These now read the live tuning object at module load; anything that
 * needs a value the player has adjusted must read `MOVEMENT` instead.
 */
const WALK_SPEED = MOVEMENT.walkSpeed;
const RUN_SPEED = MOVEMENT.runSpeed;

export class PlayerController {
  readonly camera: THREE.PerspectiveCamera;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  /** Yaw in radians. 0 faces -Z. */
  yaw = 0;
  pitch = 0;

  /** True while the player is allowed to move and look. */
  enabled = false;

  /**
  * The sector's flat floor. Set by the world, never by movement — this is the
  * datum everything else is measured from, and it must not ratchet.
  */
  groundY = 0;

  /**
   * The height actually being stood on, which is `groundY` unless the player
   * is on a step. Kept separate precisely so that walking off a kerb can lower
   * it again; a single value that only ever rose would leave the player
   * stranded at kerb height forever.
   */
  private supportY = 0;

  /**
   * Smoothed camera height. Distinct from `position.y`, which stays pinned to
   * the support height: the logical position must stay exact so collision and
   * interaction checks are honest, while the camera eases so that a change of
   * support is a rise rather than a pop.
   */
  private eyeY = BASE_EYE;

  /** True once the eye height has been snapped, so it never eases in from 0. */
  private eyeYInitialised = false;

  /**
   * Where the camera actually is, as opposed to where the player is.
   *
   * These differ only by a fraction of a millimetre during normal play. They
   * diverge when something external moves the player — a collision push-out, a
   * teleport that gets clamped by the sector bounds — and this is what keeps
   * that case from reading as a jolt.
   */
  private camX = 0;
  private camZ = 0;

  /**
   * Yaw and pitch as the player aims them, versus as the camera shows them.
   *
   * Look input accumulates into the aim values at full precision; the camera
   * chases them. The gap is normally zero to a fraction of a degree — enough
   * that a large single-frame mouse delta (a flick, or the jump some browsers
   * deliver on pointer-lock entry) is spread over a few frames instead of
   * arriving as a snap.
   */
  private camYaw = 0;
  private camPitch = 0;

  /** Current locomotion state — see `MoveState`. */
  private state: MoveState = 'IDLE';

  /**
 * How far the body's actual heading lags the direction the camera is looking,
   * in radians. Signed: positive means the body is heading to the camera's
   * right of where the camera points.
   *
   * This is the single most useful number in the whole controller, and it took
   * one wrong implementation to find. The first attempt measured the frame-to-
   * frame change in course, which is near zero during any smooth turn — a
   * player sweeping the mouse round a corner at a constant rate never changes
   * course by more than a fraction of a degree per frame. That made the turn
   * states unreachable while looking like a correct curve.
   *
   * The heading error is the right measure because it answers the question a
   * player actually feels: *my view has swung round but my feet have not caught
   * up yet.* That gap is the turn. It is also precisely §3's requirement that
   * there be no lateral sliding while looking elsewhere — the sliding is
   * visible in this number, and it is what the speed penalty below is for.
   */
  private headingError = 0;

  /** Smoothed sideways input, for strafe roll. */
  private strafeBlend = 0;

  /** Smoothed forward input, positive or negative, for backward detection. */
  private forwardBlend = 0;

  /** Cached so the bob can be derived from the last frame's ground covered. */
  private lastSpeed = 0;

  /** The same value from the previous frame, so acceleration can be signed. */
  private previousSpeed = 0;

  /** Smoothed camera roll and pitch offset, radians. */
  private camRoll = 0;
  private camPitchOffset = 0;

  /**
   * Delta time of the last `update()`.
   *
   * `syncCamera()` is public because the render loop calls it, and `teleport`
   * calls it outside any frame; both need a step, and neither should have to
   * pass one in, since that would change every call site.
   */
  private lastDt = 1 / 60;

  /** Phase of the idle drift, advanced at its own slow rate. */
  private idlePhase = 0;

  /** This frame's idle drift, in metres and radians. Written by updateIdleDrift. */
  private driftX = 0;
  private driftY = 0;
  private driftRoll = 0;

  /** Boxes to collide with, in world space. */
  private colliders: AABB[] = [];

  private keys = new Set<string>();

  /* --- input state (shared by all three paths) --- */
  private inputX = 0;
  private inputZ = 0;
  private lookX = 0;
  private lookY = 0;

  /** Touch movement vector from the virtual stick, in [-1, 1]. */
  private touchMove = new THREE.Vector2();
  private touchRun = false;

  private bobPhase = 0;
  private bobAmount = 0;
  private stepAccumulator = 0;

  private pointerLocked = false;
  private baseEye: number = BASE_EYE;

  private cb: ControllerCallbacks;

  private readonly els: {
    canvas: HTMLCanvasElement;
    stick: HTMLElement | null;
    knob: HTMLElement | null;
    action: HTMLElement | null;
  };

  /** Set by main to suppress the desktop hint when touch controls are active. */
  usingTouch = false;

  constructor(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera, cb: ControllerCallbacks = {}) {
    this.camera = camera;
    this.cb = cb;
    this.position.set(0, 0, 0);
    this.velocity.set(0, 0, 0);

    this.els = {
      canvas,
      stick: null,
      knob: null,
      action: null,
    };

    this.bindKeyboard();
    this.bindMouse();
    this.bindTouch();
  }

  /* ---------------------------------------------------------------------
     Setup
     --------------------------------------------------------------------- */

  /** Register the touch control elements. Call once after the UI is built. */
  registerTouchElements(stick: HTMLElement, knob: HTMLElement, action: HTMLElement): void {
    this.els.stick = stick;
    this.els.knob = knob;
    this.els.action = action;
    this.usingTouch = true;
  }

  setColliderBoxes(boxes: AABB[]): void {
    this.colliders = boxes;
  }

  /** Eye height for the current mode. */
  setEyeHeight(h: number): void {
    this.baseEye = h;
  }

  /** Place the player. Used on spawn, teleport and after a death/reconnect. */
  teleport(x: number, z: number, yaw?: number, pitch?: number): void {
    this.position.set(x, this.groundY, z);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = pitch;

    // A teleport is a cut, not a move. Every eased value has to come with it,
    // or the camera spends the next second gliding in from wherever it was —
    // which on the descent hand-off would be a visible sweep across the Grid.
    this.camX = x;
    this.camZ = z;
    this.supportY = this.groundY;
    this.eyeY = this.groundY + this.baseEye;
    this.eyeYInitialised = true;
    this.camYaw = this.yaw;
    this.camPitch = this.pitch;
    this.state = 'IDLE';
    this.headingError = 0;
    this.strafeBlend = 0;
    this.forwardBlend = 0;
    this.stepAccumulator = 0;
    this.lastSpeed = 0;

    this.syncCamera();
  }

  /** True while the pointer is locked (desktop) — gates the look hint. */
  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.keys.clear();
      this.touchMove.set(0, 0);
      this.inputX = 0;
      this.inputZ = 0;
    }
  }

  /* ---------------------------------------------------------------------
     Desktop input
     --------------------------------------------------------------------- */

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      // Never swallow devtools/reload shortcuts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);

      // Prevent the page scrolling out from under the canvas.
      if (
        [
          'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ',
          'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
        ].includes(e.code)
      ) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    // A dropped window focus must not leave keys stuck down.
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.touchMove.set(0, 0);
    });
  }

  private bindMouse(): void {
    const canvas = this.els.canvas;

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      if (!this.pointerLocked) {
        this.keys.clear();
        this.inputX = 0;
        this.inputZ = 0;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked || !this.enabled) return;

      const s = loadSettings();
      const sens = 0.0022 * s.sensitivity;

      this.lookX -= e.movementX * sens;
      this.lookY -= e.movementY * sens * (s.invertY ? -1 : 1);
    });
  }

  /** Request pointer lock. Must be called from a user gesture. */
  requestPointerLock(): void {
    if (this.usingTouch) return;
    const el = this.els.canvas as HTMLCanvasElement & {
      requestPointerLock?: (o?: { unadjustedMovement?: boolean }) => Promise<void> | void;
    };
    // `unadjustedMovement` skips OS mouse acceleration, which is wrong for a
    // game camera — but it is rejected on some platforms, so fall back.
    try {
      const r = el.requestPointerLock?.({ unadjustedMovement: false });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => el.requestPointerLock?.());
      }
    } catch {
      el.requestPointerLock?.();
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /* ---------------------------------------------------------------------
     Touch input
     --------------------------------------------------------------------- */

  private stickPointerId: number | null = null;
  private lookPointerId: number | null = null;
  private stickOrigin = new THREE.Vector2();
  private lookLast = new THREE.Vector2();

  private bindTouch(): void {
    // The right half of the screen looks around; the left half drives the
    // stick. Registered on the canvas so HUD elements sit above it.
    const canvas = this.els.canvas;

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch') return;

        const leftHalf = e.clientX < window.innerWidth * 0.45;

        if (leftHalf && this.stickPointerId === null) {
          this.stickPointerId = e.pointerId;
          this.stickOrigin.set(e.clientX, e.clientY);
          // The visual stick springs to wherever the thumb landed.
          const stick = this.els.stick;
          if (stick) {
            stick.style.left = `${e.clientX - 64}px`;
            stick.style.bottom = `${window.innerHeight - e.clientY - 64}px`;
          }
          this.moveKnob(e.clientX - this.stickOrigin.x, e.clientY - this.stickOrigin.y);
        } else if (!leftHalf && this.lookPointerId === null) {
          this.lookPointerId = e.pointerId;
          this.lookLast.set(e.clientX, e.clientY);
        }
      },
      { passive: true },
    );

    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'touch') return;

        if (e.pointerId === this.stickPointerId) {
          this.moveKnob(e.clientX - this.stickOrigin.x, e.clientY - this.stickOrigin.y);
        } else if (e.pointerId === this.lookPointerId) {
          const sens = 0.0045 * loadSettings().sensitivity;
          this.lookX -= (e.clientX - this.lookLast.x) * sens;
          this.lookY -= (e.clientY - this.lookLast.y) * sens;
          this.lookLast.set(e.clientX, e.clientY);
        }
      },
      { passive: true },
    );

    const end = (e: PointerEvent) => {
      if (e.pointerId === this.stickPointerId) {
        this.stickPointerId = null;
        this.touchMove.set(0, 0);
        this.touchRun = false;
        this.moveKnob(0, 0);
        this.resetStickPosition();
      }
      if (e.pointerId === this.lookPointerId) this.lookPointerId = null;
    };

    canvas.addEventListener('pointerup', end, { passive: true });
    canvas.addEventListener('pointercancel', end, { passive: true });
  }

  private moveKnob(dx: number, dy: number): void {
    const max = 56;
    const len = Math.hypot(dx, dy);
    const clamped = len > max ? max / len : 1;

    this.touchMove.set(
      clamp((dx * clamped) / max, -1, 1),
      clamp((dy * clamped) / max, -1, 1),
    );

    // Past 80% of the throw, the stick reads as "run".
    this.touchRun = len > max * 0.82;

    const knob = this.els.knob;
    if (knob) {
      knob.style.transform = `translate(${dx * clamped}px, ${dy * clamped}px)`;
    }
  }

  private resetStickPosition(): void {
    const stick = this.els.stick;
    if (!stick) return;
    stick.style.left = '';
    stick.style.bottom = '';
  }

  /* ---------------------------------------------------------------------
     Per-frame update
     --------------------------------------------------------------------- */

  update(dt: number): void {
    this.lastDt = dt;

    if (this.enabled) {
      this.consumeInput();
    } else {
      this.inputX = 0;
      this.inputZ = 0;
    }

    // Look is always applied when enabled, even at zero movement.
    if (this.enabled) {
      this.applyLook();
    }
    this.lookX = 0;
    this.lookY = 0;

    this.integrate(dt);
    this.updateState();
    this.updateBob(dt);
    this.syncCamera();
  }

  /**
   * Turn this frame's accumulated mouse/touch delta into aim angles.
   *
   * Two things happen here that did not before.
   *
   * First, the delta is ramped by how large it is. A 2-pixel correction and a
   * 400-pixel flick both arrive as "movement this frame", and treating them
   * identically is why mouselook feels either sluggish or twitchy — there is
   * no way to win. Below `rotationAcceleration` the response stays exactly 1:1,
   * so aiming stays precise; above it, response ramps to
   * `rotationAccelerationMax`, so turning around is fast. §16 asks for
   * responsiveness first, and this is the part that buys it without paying in
   * precision.
   *
   * Second, the angles are stored as aim values rather than written straight
   * into the camera. `syncCamera` chases them, which is where the residual
   * smoothing lives — so that a single enormous delta, which browsers really
   * do emit on pointer-lock entry, arrives over several frames instead of as a
   * cut.
   */
  private applyLook(): void {
    const m = MOVEMENT;
    const raw = this.lookX + this.lookY;
    let gain = m.rotationSpeed;

    if (m.rotationAcceleration > 0) {
      const excess = Math.abs(raw) - m.rotationAcceleration;
      if (excess > 0) {
        const t = clamp(excess / m.rotationAcceleration, 0, 1);
        gain *= 1 + (m.rotationAccelerationMax - 1) * t;
      }
    }

    this.yaw += this.lookX * gain;
    this.pitch = clamp(
      this.pitch + this.lookY * gain,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );
  }

  private consumeInput(): void {
    let x = this.touchMove.x;
    let z = this.touchMove.y;

    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;

    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }

    this.inputX = x;
    this.inputZ = z;
  }

  /** True while the player is holding a run modifier. */
  private get wantsRun(): boolean {
    return this.touchRun || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  private integrate(dt: number): void {
    const m = MOVEMENT;
    this.previousSpeed = this.lastSpeed;

    // Movement is in the camera's yaw frame only — no pitch contribution,
    // which is what makes looking down not slow you down.
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);

    // Forward is -Z rotated by yaw.
    const wishX = this.inputX * cos - this.inputZ * sin;
    const wishZ = this.inputX * sin + this.inputZ * cos;

    const wishLen = Math.hypot(wishX, wishZ);

    /* --- §2 and §3: how far is the body from where the camera looks? --- */
    //
    // Measured between the actual velocity heading and the camera's forward
    // direction, not between this frame's input and last frame's input.
    //
    // The difference matters at speed. A diagonal change of input is a small
    // course change when you are nearly stopped and a large one at 8 m/s,
    // because over a single frame you barely travelled far enough for the
    // course to matter — or for it to be noticed. Measuring the real angle
    // between where the feet are going and where the eyes are looking makes the
    // penalty depend on the thing the player perceives, which is the lag.

    // Camera forward in world space: yaw 0 faces -Z, so forward is
    // (-sin yaw, -cos yaw). This is the same convention `syncCamera` applies.
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);

    let headingTarget = 0;
    if (wishLen > 1e-4) {
      // Signed angle from the camera's forward to the wish direction.
      // atan2 of the cross/dot pair, which is robust for every angle including
      // the 180-degree one where a plain acos would lose its sense of sign.
      const cross = fwdX * wishZ - fwdZ * wishX;
      const dot = fwdX * wishX + fwdZ * wishZ;
      headingTarget = Math.atan2(cross, dot);
    }

    // Smoothed, so the penalty cannot pop on and off between frames as the
    // angle wobbles around a threshold.
    this.headingError = damp(this.headingError, headingTarget, m.directionChangeSensitivity, dt);

    // A hard turn costs speed. §2 asks for this explicitly; §13 asks for it not
    // to be exaggerated, hence the modest default.
    //
    // The penalty scales with the square of the lag. That shape is deliberate:
    // it leaves small corrections and normal walking essentially untouched, so
    // §16's responsiveness is preserved, while rising steeply only for the
    // large angles where a real player would expect to slow down. A linear ramp
    // taxes ordinary movement for the sake of a dramatic turn.
    const lag = Math.abs(this.headingError) / Math.PI; // 0..1
    const penalty = m.turnSpeedPenalty * lag * lag;

    // This scales the *target*, not the achieved speed, and that distinction is
    // load-bearing. Capping the target lets the exponential damp still govern
    // how the speed arrives — it just arrives lower. Scaling the achieved speed
    // instead fights the damp on the following frame and cuts far harder than
    // the parameter asks for.
    const speed = Math.min(
      this.wantsRun ? m.runSpeed : m.walkSpeed,
      m.runSpeed * (1 - penalty),
    );

    const targetX = wishX * speed;
    const targetZ = wishZ * speed;

    const moving = this.inputX !== 0 || this.inputZ !== 0;
    const rate = moving ? m.accelRate : m.decelRate;

    this.velocity.x = damp(this.velocity.x, targetX, rate, dt);
    this.velocity.z = damp(this.velocity.z, targetZ, rate, dt);

    // Hard ceiling. Should never bind in normal play — a wall-slide that gains
    // speed, or a future slope, is the kind of thing that would.
    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontal > m.maxSpeed) {
      const s = m.maxSpeed / horizontal;
      this.velocity.x *= s;
      this.velocity.z *= s;
    }

    let nextX = this.position.x + this.velocity.x * dt;
    let nextZ = this.position.z + this.velocity.z * dt;

    // Axis-separated collision resolution: move on each axis, and if that
    // motion is blocked, zero the corresponding velocity component. This is
    // the cheapest approach that still slides along walls instead of sticking.
    const resolved = this.resolveCollision(nextX, nextZ);
    if (resolved.hitX) this.velocity.x = 0;
    if (resolved.hitZ) this.velocity.z = 0;

    this.position.x = resolved.x;
    this.position.z = resolved.z;

    /* --- §12: ground contact --- */
    //
    // Find the floor under the new position, then let the camera ease onto it.
    // `position.y` is pinned to the support height so collision and every
    // interaction check downstream stays honest; `eyeY` is what the camera
    // reads, and it is damped. Writing the same value to both is what produced
    // the one-frame pop when the support under the player changed.
    this.supportY = this.supportHeight(this.position.x, this.position.z);

    const targetEye = this.supportY + this.baseEye;
    if (!this.eyeYInitialised) {
      this.eyeY = targetEye;
      this.eyeYInitialised = true;
    } else {
      this.eyeY = damp(this.eyeY, targetEye, m.groundSmoothing, dt);
    }
    this.position.y = this.supportY;

    /* --- §7 and §8: is this forward, back or sideways? --- */
    //
    // Measured in the camera frame, before smoothing. The strafe blend drives
    // camera roll and the shorter strafe stride; the forward blend's sign is
    // what separates walking backwards from walking forwards.
    const strafeTarget = this.inputX;
    const forwardTarget = -this.inputZ; // W is -1 in the raw axis frame
    this.strafeBlend = damp(this.strafeBlend, strafeTarget, m.directionChangeSensitivity, dt);
    this.forwardBlend = damp(this.forwardBlend, forwardTarget, m.directionChangeSensitivity, dt);

    // Sprinting nudges the FOV out; the renderer's base FOV eases it back.
    if (quality.motionOk) {
      const t = clamp((horizontal - m.walkSpeed) / (m.runSpeed - m.walkSpeed), 0, 1);
      this.camera.fov = 70 + t * 6;
    }

    this.lastSpeed = Math.hypot(this.velocity.x, this.velocity.z);
  }

  /* ---------------------------------------------------------------------
     §15 — the locomotion state machine
     --------------------------------------------------------------------- */

  /** Classify this frame into one of the §15 states. */
  private classify(): MoveState {
    const m = MOVEMENT;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const hasInput = this.inputX !== 0 || this.inputZ !== 0;

    if (!hasInput) {
      // §15 separates DECELERATE, STOP and IDLE. They are genuinely different
      // camera behaviours — coasting, the last of the settling, and standing —
      // so they are genuinely different states rather than one state with a
      // speed attached. The bands are wide enough that each is held for
      // several frames and can be acted on, rather than flickering past.
      if (speed > m.walkSpeed * 0.6) return 'DECELERATE';
      if (speed > IDLE_SPEED) return 'STOP';
      return 'IDLE';
    }

    /* --- which way is the body pointing, relative to the camera? --- */
    //
    // This is the discriminator between a strafe and a turn, and it has to be
    // the input composition rather than the magnitude of the course change.
    // In first person a pure strafe *is* a 90-degree course change, so
    // measuring only the course change makes STRAFE_LEFT unreachable: every
    // strafe reports as a 180. What separates them is that a strafe is lateral
    // motion with no forward component, while a turn is forward motion whose
    // heading is rotating.

    const lateral = Math.abs(this.strafeBlend);
    const forward = this.forwardBlend;

    /* --- backward --- */
    //
    // Checked before strafe: backing away while sidestepping should read
    // mostly as backing away, and a diagonal of S+A should be a retreat rather
    // than a shuffle.
    if (forward < -0.4) {
      if (lateral < 0.6) return 'MOVE_BACKWARD';
      return this.strafeBlend < 0 ? 'STRAFE_LEFT' : 'STRAFE_RIGHT';
    }

    /* --- strafe --- */
    //
    // A lateral input with the forward component still forward, which is the
    // plain A or D case.
    if (lateral > 0.6) {
      return this.strafeBlend < 0 ? 'STRAFE_LEFT' : 'STRAFE_RIGHT';
    }

    /* --- turn --- */
    //
    // Forward motion while the body's heading lags the camera's. The lag is
    // what a turn *is* in first person: the view swings, the feet follow.
    const lag = Math.abs(this.headingError);
    if (lag > 1.9) return 'TURN_180';
    if (lag > 0.5) return this.headingError < 0 ? 'TURN_LEFT' : 'TURN_RIGHT';

    /* --- gait --- */
    //
    // The thresholds sit slightly below the target speeds so the state
    // reaches WALK/RUN while there is still a little acceleration left to
    // give. Otherwise START_RUN flickers for as long as the exponential tail
    // takes to converge, which reads as a stutter rather than a transition.
    if (speed < m.walkSpeed * 0.9) return 'START_WALK';
    if (this.wantsRun) {
      return speed < m.runSpeed * 0.9 ? 'START_RUN' : 'RUN';
    }
    return 'WALK';
  }

  private updateState(): void {
    const next = this.classify();
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.cb.onStateChange?.(from, next);
  }

  /* ---------------------------------------------------------------------
     §13 — small, involuntary-looking camera motion
     --------------------------------------------------------------------- */

  /**
   * The idle drift.
   *
   * Standing still in first person, a perfectly frozen camera reads as a
   * screenshot. Two incommensurable sine waves at a fraction of a hertz give
   * a couple of millimetres of movement that the eye reads as "held" rather
   * than "paused". The amplitude is four thousandths of a metre. It is the
   * difference between a screenshot and a person, and it is also the first
   * thing to delete if anyone finds it distracting.
   */
  private updateIdleDrift(dt: number): void {
    this.idlePhase += dt * MOVEMENT.idleDriftRate;
    const s = this.idleSpeedFraction();

    this.driftY =
      Math.sin(this.idlePhase * 1.7) * MOVEMENT.idleDrift * s;
    this.driftX =
      (Math.sin(this.idlePhase * 0.9 + 1.3) * 0.7 +
        Math.sin(this.idlePhase * 2.3 + 0.4) * 0.3) *
      MOVEMENT.idleDrift *
      s;
    this.driftRoll = Math.sin(this.idlePhase * 1.1 + 2.1) * 0.0009 * s;
  }

  /**
   * How still the player currently is, 1 = perfectly idle, 0 = moving fast.
   *
   * Squared so it falls away quickly with speed — the drift must vanish well
   * before walking speed, or it becomes a wobble on top of the bob.
   */
  private idleSpeedFraction(): number {
    const t = clamp(1 - this.lastSpeed / 1.2, 0, 1);
    return t * t;
  }

  /**
   * The height of the floor under a given point.
   *
   * §12 asks for the player to sit on the ground rather than through it, and to
   * follow slopes. This world has no slopes — every sector is flat — but it
   * does have steps: thresholds, plinths, the lip of a platform. Treating
   * `groundY` as a constant meant the camera could sit inside any of them.
   *
   * So the support height is found per frame: the highest collider top that is
   * within `stepHeight` of the current one and whose footprint the player
   * overlaps. Clamped to `stepHeight` above the current height, which is what
   * makes it a step-up rather than a teleport up a wall — the player walks up
   * a kerb, and does not levitate to the roof.
   */
  private supportHeight(x: number, z: number): number {
    const m = MOVEMENT;
    const base = this.groundY;
    const ceiling = base + m.stepHeight;
    const r = TIMING.playerRadius;

    let best = base;
    for (const box of this.colliders) {
      if (box.max.y <= best || box.max.y > ceiling) continue;
      // Only consider boxes the player actually stands on top of.
      if (x + r <= box.min.x || x - r >= box.max.x) continue;
      if (z + r <= box.min.z || z - r >= box.max.z) continue;
      best = box.max.y;
    }
    return best;
  }

  /**
   * Capsule (approximated as a circle in plan) against AABBs.
   *
   * For each box, find the closest point on the box to the player's centre in
   * the XZ plane; if that distance is less than the radius, push out along the
   * shortest axis. Re-resolves after each push so corners behave.
   */
  private resolveCollision(x: number, z: number): { x: number; z: number; hitX: boolean; hitZ: boolean } {
    const r = TIMING.playerRadius;
    let px = x;
    let pz = z;
    let hitX = false;
    let hitZ = false;

    for (let iter = 0; iter < 2; iter++) {
      let moved = false;

      for (const box of this.colliders) {
        // Skip boxes entirely above the player's feet — walkways overhead.
        if (box.min.y > this.supportY + 2.0) continue;

        // Skip boxes the player is standing on top of. Without this, a kerb
        // that has just been stepped onto keeps pushing horizontally from a
        // face the player is no longer behind, and they cannot walk off it.
        if (box.max.y <= this.supportY + MOVEMENT.stepHeight) continue;

        const cx = clamp(px, box.min.x, box.max.x);
        const cz = clamp(pz, box.min.z, box.max.z);

        const dx = px - cx;
        const dz = pz - cz;
        const d2 = dx * dx + dz * dz;

        // Outside the box, and further than the radius: no contact.
        if (d2 > r * r) continue;

        // Inside the box (d2 === 0): push out the shortest way.
        if (d2 < 1e-8) {
          const toMinX = px - box.min.x;
          const toMaxX = box.max.x - px;
          const toMinZ = pz - box.min.z;
          const toMaxZ = box.max.z - pz;
          const min = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);

          if (min === toMinX) { px = box.min.x - r; hitX = true; }
          else if (min === toMaxX) { px = box.max.x + r; hitX = true; }
          else if (min === toMinZ) { pz = box.min.z - r; hitZ = true; }
          else { pz = box.max.z + r; hitZ = true; }

          moved = true;
          continue;
        }

        const d = Math.sqrt(d2);
        const push = r - d;
        px += (dx / d) * push;
        pz += (dz / d) * push;

        if (Math.abs(dx) > Math.abs(dz)) hitX = true;
        else hitZ = true;

        moved = true;
      }

      if (!moved) break;
    }

    return { x: px, z: pz, hitX, hitZ };
  }

  private updateBob(dt: number): void {
    const m = MOVEMENT;
    const settings = loadSettings();
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    if (quality.motionOk && settings.headBob && speed > IDLE_SPEED) {
      /* --- §6: phase derived from distance, not from time --- */
      //
      // This is the whole reason the head never slides. If the bob advanced by
      // `dt * frequency` its rate would depend on frame rate and on a fixed
      // frequency, so at any speed other than exactly that frequency the feet
      // would be sliding. Deriving the phase from ground actually covered
      // makes one full cycle exactly `strideLength` metres, at any speed and
      // any frame rate. The feet cannot slide, because the maths does not allow
      // it.
      this.bobPhase += (speed * dt) / m.strideLength * Math.PI * 2;

      // §7 and §8: walking backwards and strafing are not walking forwards
      // with a smaller amplitude. The direction is read from the smoothed
      // input blends, and it selects both an amplitude and a stride length, so
      // backing away also takes shorter, quicker steps — which is what a real
      // person does when they back off from something.
      const scale = this.bobScale();

      // Two oscillations per stride cycle, offset for the lateral component.
      const target =
        (Math.sin(this.bobPhase) * 0.6 + Math.sin(this.bobPhase * 2) * 0.4) *
        m.bobAmplitude *
        scale.amplitude *
        clamp(speed / m.walkSpeed, 0, 1.6);

      this.bobAmount = damp(this.bobAmount, target, 12, dt);

      // Footfalls fire on distance covered, against the stride length for the
      // direction being walked. Same reasoning as the phase above.
      this.stepAccumulator += speed * dt;
      if (this.stepAccumulator > m.strideLength * scale.stride) {
        this.stepAccumulator = 0;
        this.cb.onFootstep?.(this.position, speed);
      }
    } else {
      this.bobAmount = damp(this.bobAmount, 0, 10, dt);
      // Still needs draining when the bob is off, or the first step after a
      // pause comes with a partial stride's worth of credit and fires late.
      this.stepAccumulator = 0;
    }
  }

  /**
   * Amplitude and stride multipliers for the direction currently being walked.
   *
   * §8 asks for a lateral transition rather than artificial motion, and this
   * is that transition: as the input blends from forward to sideways, the
   * amplitude and the stride length interpolate continuously. There is no
   * switch, so there is nothing to pop — but the endpoints are measurably
   * different, so a strafe does not read as a forward walk with the volume
   * turned down.
   */
  private bobScale(): { amplitude: number; stride: number } {
    const m = MOVEMENT;

    // Backward takes precedence over strafe: backing away while sidestepping
    // should read mostly as backing away.
    const backward = Math.max(0, -this.forwardBlend);
    const lateral = Math.abs(this.strafeBlend);
    const blend = Math.min(1, backward + lateral);

    if (blend < 1e-3) return { amplitude: m.bobForward, stride: 1 };

    const amplitude =
      m.bobForward * (1 - blend) +
      (backward > lateral ? m.bobBackward : m.bobStrafe) * blend;
    const stride =
      1 * (1 - blend) +
      (backward > lateral ? m.backwardStrideScale : m.strafeStrideScale) * blend;

    return { amplitude, stride };
  }

  /** Push the logical state onto the actual camera. */
  syncCamera(): void {
    const m = MOVEMENT;
    const dt = this.lastDt;
    this.updateIdleDrift(dt);

    /* --- position --- */
    //
    // The camera chases the player rather than being pinned to it. During
    // normal play the gap is far below a millimetre; what it buys is that the
    // collision push-out at the end of `integrate` — which moves the player
    // without moving the camera — arrives as a soft correction instead of a
    // snap.
    this.camX = damp(this.camX, this.position.x, m.cameraFollowRate, dt);
    this.camZ = damp(this.camZ, this.position.z, m.cameraFollowRate, dt);

    /* --- §13 and §14: the involuntary camera motion --- */
    //
    // Roll from strafing and turning, pitch from acceleration. Both are small
    // enough to be below conscious notice: strafeRoll of 0.012 rad is about
    // 0.7 degrees. §13 is explicit that the goal is realism, not exaggeration,
    // so these are deliberately near the floor of what registers.
    const rollTarget =
      -this.strafeBlend * m.strafeRoll * clamp(this.lastSpeed / m.walkSpeed, 0, 1.5) +
      clamp(this.headingError, -1, 1) * m.turnRoll +
      this.driftRoll;

    // Forward lean under acceleration: measure how much the speed is still
    // growing, which is the actual signal of "pushing off".
    const accelT =
      clamp((this.lastSpeed - this.previousSpeed) / (m.walkSpeed * 0.5), 0, 1);
    const pitchTarget = -accelT * m.accelPitch + this.bobAmount * 0.35;

    this.camRoll = damp(this.camRoll, rollTarget, 9, dt);
    this.camPitchOffset = damp(this.camPitchOffset, pitchTarget, 9, dt);

    this.camera.position.set(
      this.camX + this.driftX,
      this.eyeY + this.bobAmount + this.driftY,
      this.camZ,
    );

    // §14: the camera eases toward where the player is aiming. `dampAngle` is
    // used rather than `damp` so that crossing ±PI takes the short way round
    // instead of spinning the long way through zero.
    this.camYaw = dampAngle(this.camYaw, this.yaw, LOOK_FOLLOW_RATE, dt);
    this.camPitch = damp(this.camPitch, this.pitch, LOOK_FOLLOW_RATE, dt);

    // YXZ order: yaw about world Y, then pitch about local X. Anything else
    // introduces roll when you look up.
    this.camera.rotation.set(
      this.camPitch + this.camPitchOffset,
      this.camYaw,
      this.camRoll,
      'YXZ',
    );
  }

  /** Current horizontal speed, m/s. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Point the camera is looking at, for proximity interaction. */
  getLookTarget(out = new THREE.Vector3()): THREE.Vector3 {
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(this.camera.rotation);
    return out.copy(this.camera.position).addScaledVector(dir, 6);
  }

  dispose(): void {
    this.keys.clear();
    this.colliders.length = 0;
  }
}

export { WALK_SPEED, RUN_SPEED, CYCLE_EYE, BASE_EYE };