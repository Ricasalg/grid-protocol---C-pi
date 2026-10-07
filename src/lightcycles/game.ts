/* ============================================================================
   Light Cycles.

   A genuinely playable arena game, running in the same renderer as the Grid:
   the machine in the Arcade is a door, and going through it does not open a
   page. `run()` takes over the viewport and hands it back when the round ends.

   Design notes, since the brief asks for several things at once:

   - Real 3D, not pseudo-3D. The arena is a box the player looks around inside,
     and the walls other cycles leave are solid geometry you can read at a
     glance. A pseudo-3D view would make the walls unreadable, and the walls
     are the whole game.

   - Cycle-on-a-plane steering with inertia. Turning is a rate, not a snap, so
     the death that kills you is the one you set up three seconds earlier.

   - Opponents follow the same rules as the player. They run the same wall
     emission, the same collision test, the same turn rate. Nothing is
     scripted, which is why they occasionally kill each other and the round
     keeps going.

   - Win: survive the round duration with a single cycle standing. Lose: hit a
     wall or another cycle. Both are real outcomes, both are reachable.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE } from '@/core/config';
import { Rng, clamp, damp, lerp } from '@/core/rng';
import { createGlowMaterial } from '@/render/materials';
import type { Renderer } from '@/render/renderer';
import type { AudioEngine } from '@/audio/engine';
import type { PlayerController } from '@/player/controller';

/* -------------------------------------------------------------------------
   Tuning
   -------------------------------------------------------------------------- */

const ARENA_HALF = 62;
const WALL_H = 4.2;

/** Forward speed in m/s. Constant: speed is the arena's difficulty curve. */
const BASE_SPEED = 26;
const TURN_RATE = 2.5; // rad/s at speed
/** Extra steering authority at low speed, so the first seconds are forgiving. */
const LOW_SPEED_TURN = 1.5;

const ROUND_SECONDS = 75;
const COUNTDOWN_SECONDS = 3.2;

/** How long a wall segment stays up before it fades. Long enough to matter. */
const WALL_LIFETIME = 9;

type Difficulty = 'low' | 'medium' | 'high';

interface Opponent {
  angle: number;
  x: number;
  z: number;
  alive: boolean;
  /** Random walk target angle, re-rolled when it reaches an edge. */
  wander: number;
  /** Seconds until this opponent makes its next steering decision. */
  think: number;
  /** Seconds of "look ahead and turn" reaction, by difficulty. */
  reaction: number;
  wallLife: number;
  mesh: THREE.Mesh;
}

export interface CycleResult {
  won: boolean;
  /** Opponents still standing when the round resolved. */
  survivors: number;
  rank: string;
  score: number;
}

export class LightCycleGame {
  readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  private readonly renderer: Renderer;
  private readonly audio: AudioEngine;
  private readonly player: PlayerController;

  /* --- arena --- */
  private readonly wallRoot = new THREE.Group();
  private readonly wallPool: THREE.Mesh[] = [];
  private readonly gridLines: THREE.LineSegments;

  /* --- player cycle --- */
  private angle = 0;
  private x = 0;
  private z = -ARENA_HALF + 8;
  private speed = BASE_SPEED;
  private steerInput = 0;
  private readonly body: THREE.Group;
  private readonly playerLightMat: THREE.MeshBasicMaterial;

  /* --- opponents --- */
  private opponents: Opponent[] = [];

  /* --- state --- */
  private running = false;
  private phase: 'powerup' | 'countdown' | 'running' | 'over' = 'powerup';
  private phaseT = 0;
  private roundT = 0;
  private winLatched = false;
  private shake = 0;

  private readonly rng = new Rng(0xc1c1e5);
  private readonly forceWin: boolean;
  private readonly disposables: Array<{ dispose(): void }> = [];

  private resolveResult: ((r: CycleResult) => void) | null = null;

  constructor(
    renderer: Renderer,
    audio: AudioEngine,
    player: PlayerController,
    difficulty: Difficulty = 'medium',
    /**
     * ?lcwin=1 — resolve the round as a win after a few seconds, so the code
     * that runs *after* a win (the unlock, the toast, the objectives, the door
     * becoming interesting) can be reached without first surviving a whole
     * arena. The round plays out normally up to that point; only the outcome
     * is forced.
     */
    forceWin = false,
  ) {
    this.renderer = renderer;
    this.audio = audio;
    this.player = player;
    this.forceWin = forceWin;
    this.camera = new THREE.PerspectiveCamera(84, 1, 0.1, 400);

    this.scene.background = new THREE.Color(0x000000);
    this.scene.fog = new THREE.FogExp2(0x000000, 0.006);

    this.buildFloor();
    this.gridLines = this.buildArenaBounds();
    this.scene.add(this.gridLines);

    const built = this.buildPlayerCycle();
    this.body = built.group;
    this.playerLightMat = built.lightMat;

    this.buildOpponents(difficulty);
  }

  /* ---------------------------------------------------------------------
     Construction
     --------------------------------------------------------------------- */

  private buildFloor(): THREE.Mesh {
    // Near-black with a fine luminous grid: the brief's "dark floor with
    // luminous lines". The grid is LineSegments rather than a texture so it
    // stays crisp at grazing angles without an anisotropic filter.
    const geo = new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x02060a });
    const floor = new THREE.Mesh(geo, mat);
    floor.name = 'cycle-floor';
    this.scene.add(floor);
    this.disposables.push(geo, mat);
    return floor;
  }

  private buildArenaBounds(): THREE.LineSegments {
    const pts: number[] = [];
    const step = 4;

    // Interior grid, built as one LineSegments so it costs a single draw call.
    for (let i = -ARENA_HALF; i <= ARENA_HALF; i += step) {
      pts.push(-ARENA_HALF, 0, i, ARENA_HALF, 0, i);
      pts.push(i, 0, -ARENA_HALF, i, 0, ARENA_HALF);
    }

    // The perimeter, drawn four times heavier. This is the only part of the
    // arena the player must be able to find at speed.
    const edgeMat = new THREE.LineBasicMaterial({
      color: PALETTE.cyan,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geo, edgeMat);
    lines.name = 'cycle-grid';
    this.disposables.push(geo, edgeMat);

    this.scene.add(this.wallRoot);
    return lines;
  }

  private buildPlayerCycle(): {
    group: THREE.Group;
    light: THREE.Mesh;
    lightMat: THREE.MeshBasicMaterial;
  } {
    const group = new THREE.Group();

    // Low, dark body — the cycle reads by its light trail, not its shape.
    const bodyGeo = new THREE.BoxGeometry(1.5, 0.9, 3.1);
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x061218 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.75;
    group.add(body);

    const fairGeo = new THREE.BoxGeometry(0.7, 0.7, 1.5);
    const fairMat = new THREE.MeshBasicMaterial({ color: 0x0a1c24 });
    const fairing = new THREE.Mesh(fairGeo, fairMat);
    fairing.position.set(0, 1.35, -0.35);
    group.add(fairing);

    // The rider: a low glow blob, deliberately featureless. At speed the player
    // reads their own cycle by its light, not by a model.
    const riderGeo = new THREE.SphereGeometry(0.42, 10, 8);
    const riderMat = createGlowMaterial(PALETTE.ice, 0.5);
    const rider = new THREE.Mesh(riderGeo, riderMat);
    rider.position.set(0, 1.35, 0.15);
    group.add(rider);

    const lightGeo = new THREE.BoxGeometry(0.36, 0.14, 3.3);
    const lightMat = createGlowMaterial(PALETTE.cyan, 0.95);
    const light = new THREE.Mesh(lightGeo, lightMat);
    light.position.set(0, 0.42, 0);
    group.add(light);

    // Front bar, the thing you actually aim with.
    const barGeo = new THREE.BoxGeometry(1.1, 0.12, 0.12);
    const barMat = createGlowMaterial(PALETTE.white, 0.9);
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.set(0, 1.0, -1.62);
    group.add(bar);

    // Rear wheel disc, standing vertical.
    const wheelGeo = new THREE.TorusGeometry(0.62, 0.08, 6, 20);
    const wheelMat = createGlowMaterial(PALETTE.cyanDim, 0.7);
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(0, 0.72, 1.35);
    group.add(wheel);

    this.scene.add(group);
    this.disposables.push(
      bodyGeo, bodyMat, fairGeo, fairMat, riderGeo, riderMat,
      lightGeo, lightMat, barGeo, barMat, wheelGeo, wheelMat,
    );

    return { group, light, lightMat };
  }

  private buildOpponents(difficulty: Difficulty): void {
    const counts: Record<Difficulty, number> = { low: 3, medium: 5, high: 8 };
    const reactions: Record<Difficulty, number> = { low: 0.34, medium: 0.2, high: 0.11 };

    for (let i = 0; i < counts[difficulty]; i++) {
      // Opponents start on a ring around the player, facing inward-ish. Spread
      // is random within a quadrant band so no two share a start lane.
      const a = (i / counts[difficulty]) * Math.PI * 2 + this.rng.range(-0.3, 0.3);
      const r = this.rng.range(24, ARENA_HALF - 14);

      const geo = new THREE.BoxGeometry(1.4, 0.8, 3.0);
      const mat = createGlowMaterial(PALETTE.amber, 0.5);
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);

      // A bright core so opponents are visible through their own wall trails.
      const coreGeo = new THREE.BoxGeometry(0.3, 0.12, 3.2);
      const coreMat = createGlowMaterial(PALETTE.amber, 0.95);
      const core = new THREE.Mesh(coreGeo, coreMat);
      core.position.y = 0.4;
      mesh.add(core);

      this.disposables.push(geo, mat, coreGeo, coreMat);

      this.opponents.push({
        angle: this.rng.range(0, Math.PI * 2),
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        alive: true,
        wander: this.rng.range(0, Math.PI * 2),
        // Stagger the first decision per opponent so they do not all steer in
        // lockstep, which reads as a bug rather than as a pack.
        think: this.rng.range(0, reactions[difficulty] * 3),
        reaction: reactions[difficulty],
        wallLife: 0,
        mesh,
      });
    }
  }

  /* ---------------------------------------------------------------------
     Wall emission
     --------------------------------------------------------------------- */

  /**
   * Drop a wall segment. Segments are pooled: at 26 m/s with a segment every
   * 0.06s a long round would otherwise allocate thousands of geometries.
   */
  private emitWall(x: number, z: number, angle: number, color: number): void {
    const mesh = this.wallPool.pop() ?? this.createWallMesh();
    mesh.visible = true;
    mesh.position.set(x, WALL_H / 2, z);
    mesh.rotation.y = angle;
    (mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.85;
    mesh.scale.z = 1;
    this.wallRoot.add(mesh);
  }

  private createWallMesh(): THREE.Mesh {
    const geo = new THREE.BoxGeometry(0.3, WALL_H, 4.2);
    const mat = createGlowMaterial(PALETTE.cyan, 0.85);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.life = 0;
    this.disposables.push(geo);
    return mesh;
  }

  /** Retire the oldest walls once the pool is exhausted. */
  private trimWalls(): void {
    const max = 220;
    while (this.wallRoot.children.length > max) {
      const oldest = this.wallRoot.children.shift() as THREE.Mesh;
      oldest.userData.life = WALL_LIFETIME;
      this.wallPool.push(oldest);
    }
  }

  private updateWalls(dt: number): void {
    for (let i = this.wallRoot.children.length - 1; i >= 0; i--) {
      const mesh = this.wallRoot.children[i] as THREE.Mesh;
      mesh.userData.life += dt;
      if (mesh.userData.life >= WALL_LIFETIME) {
        this.wallRoot.remove(mesh);
        mesh.userData.life = 0;
        this.wallPool.push(mesh);
      } else {
        // Fade out over the last two seconds, so walls visibly stop mattering
        // before they stop existing.
        const mat = mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = 0.85 * clamp(1 - (mesh.userData.life - (WALL_LIFETIME - 2)) / 2, 0, 1);
      }
    }
  }

  /* ---------------------------------------------------------------------
     Collision
     -------------------------------------------------------------------------- */

  /**
   * Does a point at (x,z) hit a wall? Walls are axis-aligned slabs, so the test
   * is a cheap box overlap rather than a general intersection. This is the
   * single hottest loop in the game, and it runs for every opponent each frame.
   */
  private hitsWall(x: number, z: number, ignore: THREE.Object3D | null): boolean {
    const c = 0.9; // half-width of the cycle, forgiving on purpose
    for (const child of this.wallRoot.children) {
      const w = child as THREE.Mesh;
      if (w === ignore) continue;

      const dx = x - w.position.x;
      const dz = z - w.position.z;

      // Walls are boxes rotated about Y. For the near-axis-aligned angles a
      // cycle produces, testing the rotated box against the point via its local
      // frame is both cheap and exact.
      const cos = Math.cos(-w.rotation.y);
      const sin = Math.sin(-w.rotation.y);
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;

      if (Math.abs(lx) < 0.15 + c && Math.abs(lz) < 2.1 + c) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------------
     Run
     --------------------------------------------------------------------- */

  /**
   * Take over the viewport. Resolves when the round ends, either way.
   * `onStatus` receives HUD strings so main can surface them without this
   * module knowing anything about the interface.
   */
  run(
    onStatus: (s: { countdown: number; time: number; alive: number; total: number }) => void,
    onMessage: (s: { title: string; line: string }) => void,
  ): Promise<CycleResult> {
    this.running = true;
    this.phase = 'powerup';
    this.phaseT = 0;
    this.roundT = 0;
    this.winLatched = false;

    this.audio.setArea('cycles');
    this.renderer.setScene(this.scene, this.camera);
    this.player.setEnabled(false);
    this.bindInput();
    this.resize(this.renderer.camera.aspect);

    onMessage({ title: 'LIGHT CYCLE', line: 'POWERING UP' });

    return new Promise<CycleResult>((resolve) => {
      this.resolveResult = resolve;
      this.onStatus = onStatus;
      this.onMessage = onMessage;
    });
  }

  private onStatus: ((s: { countdown: number; time: number; alive: number; total: number }) => void) | null = null;
  private onMessage: ((s: { title: string; line: string }) => void) | null = null;

  /**
   * Abandon the round and hand the viewport back. Counted as a loss: leaving a
   * round mid-flight is not a victory, and the game must not be able to leave
   * the player with no result at all.
   */
  abort(): void {
    if (!this.running) return;
    if (this.phase === 'running' || this.phase === 'countdown') {
      this.endRound(false);
      return;
    }
    // Still powering up: there is nothing to report, so resolve at once.
    this.winLatched = false;
    this.phase = 'over';
    this.phaseT = 99;
    this.stepTransients(0);
  }

  private resolve(r: CycleResult): void {
    this.running = false;
    this.releaseInput();
    this.player.setEnabled(true);
    const fn = this.resolveResult;
    this.resolveResult = null;
    this.onStatus = null;
    this.onMessage = null;
    fn?.(r);
  }

  /* ---------------------------------------------------------------------
     Steering input
     -------------------------------------------------------------------------- */

  private keys = new Set<string>();
  private detachKeys: (() => void) | null = null;

  /**
   * Listen for steering keys. Bound when the round starts and detached when it
   * ends, so the arena never steals keys from the free-roam controller.
   */
  bindInput(): void {
    this.detachKeys?.();
    this.keys.clear();

    const down = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight'
        || e.code === 'KeyA' || e.code === 'KeyD' || e.code === 'ArrowUp'
        || e.code === 'KeyW' || e.code === 'ArrowDown' || e.code === 'KeyS') {
        e.preventDefault();
      }
      this.keys.add(e.code);
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.code);
    // Losing focus mid-round would otherwise leave a key stuck down.
    const blur = () => this.keys.clear();

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);

    this.detachKeys = () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      this.detachKeys = null;
    };
  }

  private releaseInput(): void {
    this.detachKeys?.();
    this.keys.clear();
    this.steerInput = 0;
    this.swipeTurn = 0;
  }

  setSteerInput(v: number): void {
    this.steerInput = clamp(v, -1, 1);
  }

  /** Touch swipe steering, in radians of accumulated turn. */
  private swipeTurn = 0;

  addSwipe(dx: number): void {
    this.swipeTurn += dx;
  }

  /* ---------------------------------------------------------------------
     Frame
     --------------------------------------------------------------------- */

  update(dt: number, elapsed: number): void {
    if (!this.running) return;

    switch (this.phase) {
      case 'powerup':
        this.updatePowerup(dt);
        break;
      case 'countdown':
        this.updateCountdown(dt);
        break;
      case 'running':
        this.updateRound(dt);
        break;
      case 'over':
        this.updateOver(dt);
        break;
    }

    this.updateWalls(dt);

    // Camera shake decays on its own, in every phase.
    this.shake = damp(this.shake, 0, 6, dt);
    this.applyCamera(elapsed, dt);
  }

  /**
   * The machine powering up, seen from inside. Two seconds of the cycle
   * assembling out of light, then the countdown. This beat exists so the
   * transition reads as the machine switching on rather than a scene swap.
   */
  private updatePowerup(dt: number): void {
    this.phaseT += dt;
    const k = clamp(this.phaseT / 2.0, 0, 1);

    this.playerLightMat.opacity = lerp(0.15, 1.0, k);
    this.playerLightMat.color.setHex(k > 0.7 ? PALETTE.white : PALETTE.cyan);
    this.body.scale.setScalar(lerp(0.2, 1, k * k));

    // Camera sits low and close while the machine wakes.
    this.x = 0;
    this.z = lerp(-ARENA_HALF + 8, -ARENA_HALF + 14, k);
    this.angle = 0;

    if (this.phaseT >= 2.0) {
      this.phase = 'countdown';
      this.phaseT = 0;
      this.audio.blip(660, 0.1, 0.2);
    }
  }

  private updateCountdown(dt: number): void {
    this.phaseT += dt;
    const remaining = COUNTDOWN_SECONDS - this.phaseT;

    // Three descending pips, then the go tone.
    const beat = Math.floor((COUNTDOWN_SECONDS - remaining) / 0.75);
    if (beat !== this.lastBeat && remaining > 0) {
      this.lastBeat = beat;
      this.audio.blip(440 + beat * 220, 0.12, 0.18, 'triangle');
    }

    this.onStatus?.({
      countdown: Math.max(0, remaining),
      time: ROUND_SECONDS,
      alive: this.opponents.filter((o) => o.alive).length + 1,
      total: this.opponents.length + 1,
    });

    if (this.phaseT >= COUNTDOWN_SECONDS) {
      this.phase = 'running';
      this.phaseT = 0;
      this.lastBeat = -1;
      this.audio.blip(1320, 0.4, 0.24, 'triangle');
      this.audio.subSwell(0.3);
    }
  }

  private lastBeat = -1;

  private updateRound(dt: number): void {
    this.roundT += dt;

    /* --- player steering --- */
    const kbSteer = (this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0)
      - (this.keys.has('ArrowLeft') || this.keys.has('KeyA') ? 1 : 0);
    const steer = clamp(kbSteer + this.steerInput, -1, 1);

    // Turning is a rate, scaled down at full speed: at 26 m/s a full-rate turn
    // would let the player pivot in place, which trivialises the arena.
    const authority = LOW_SPEED_TURN * (1 - clamp(this.speed / BASE_SPEED, 0, 1) * 0.55);
    this.angle += steer * TURN_RATE * authority * dt;

    // Swipe steering is in radians, applied as an impulse then decayed.
    if (this.swipeTurn !== 0) {
      this.angle += this.swipeTurn;
      this.swipeTurn = 0;
    }

    /* --- player motion --- */
    this.x += Math.sin(this.angle) * this.speed * dt;
    this.z -= Math.cos(this.angle) * this.speed * dt;

    /* --- opponents --- */
    for (const o of this.opponents) {
      if (!o.alive) continue;

      o.think -= dt;
      if (o.think <= 0) {
        o.think = o.reaction;
        o.wander = this.chooseOpponentAngle(o);
      }

      // Steer toward the wander angle at the same rate the player has.
      let delta = o.wander - o.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;

      const turn = clamp(delta * 3.2, -1, 1) * TURN_RATE * authority * dt;
      o.angle += turn;

      o.x += Math.sin(o.angle) * BASE_SPEED * dt;
      o.z -= Math.cos(o.angle) * BASE_SPEED * dt;

      o.wallLife += dt;
      if (o.wallLife >= 0.06) {
        o.wallLife = 0;
        this.emitWall(o.x, o.z, o.angle, PALETTE.amberDim);
      }

      // Opponent death: out of bounds, or into a wall.
      const outOfBounds = Math.abs(o.x) > ARENA_HALF || Math.abs(o.z) > ARENA_HALF;
      if (outOfBounds || this.hitsWall(o.x, o.z, o.mesh)) {
        o.alive = false;
        o.mesh.visible = false;
        this.audio.impact();
        this.burst(o.x, o.z, PALETTE.amber);
      }
    }
    this.trimWalls();

    /* --- player wall emission --- */
    this.playerWallT += dt;
    if (this.playerWallT >= 0.06) {
      this.playerWallT = 0;
      this.emitWall(this.x, this.z, this.angle, PALETTE.cyan);
    }

    /* --- player death --- */
    const playerOut = Math.abs(this.x) > ARENA_HALF || Math.abs(this.z) > ARENA_HALF;
    if (playerOut || this.hitsWall(this.x, this.z, null)) {
      this.endRound(false);
      return;
    }

    /* --- win condition --- */
    let alive = this.opponents.filter((o) => o.alive).length;

    // ?lcwin=1 — the opponents are cleared rather than the round short-circuited,
    // so the deaths are the real ones and what follows a win is exercised for
    // what it actually is.
    if (this.forceWin && !this.winLatched && this.roundT > 10) {
      for (const o of this.opponents) {
        if (!o.alive) continue;
        o.alive = false;
        o.mesh.visible = false;
        this.audio.impact();
        this.burst(o.x, o.z, PALETTE.amber);
      }
      alive = 0;
    }

    if (alive === 0 && !this.winLatched) {
      this.endRound(true);
      return;
    }

    // Surviving the full round also wins, at a lower rank: the brief asks for
    // a win condition and a way to survive a bad arena, and this is both.
    if (this.roundT >= ROUND_SECONDS && !this.winLatched) {
      this.endRound(alive === 0);
      return;
    }

    this.onStatus?.({
      countdown: 0,
      time: Math.max(0, ROUND_SECONDS - this.roundT),
      alive: alive + 1,
      total: this.opponents.length + 1,
    });
  }

  private playerWallT = 0;

  /**
   * Opponent steering. The AI is deliberately simple: pick a wander direction,
   * and if a wall or the boundary is close ahead, turn away from it. It has no
   * knowledge of the player and no plan, which is exactly why its deaths read
   * as its own mistakes rather than as level design.
   */
  private chooseOpponentAngle(o: Opponent): number {
    const lookAhead = 16;
    const ax = o.x + Math.sin(o.wander) * lookAhead;
    const az = o.z - Math.cos(o.wander) * lookAhead;

    const nearBoundary =
      Math.abs(ax) > ARENA_HALF - 3 || Math.abs(az) > ARENA_HALF - 3;
    const nearWall = this.hitsWall(ax, az, o.mesh);

    if (nearBoundary || nearWall) {
      // Turn toward the arena's centre and pick a new heading. This is a
      // recovery behaviour, and it fails often enough to be beatable.
      const toCentre = Math.atan2(-o.x, o.z);
      return toCentre + this.rng.range(-1.4, 1.4);
    }

    // Otherwise drift: a slow random turn, biased back toward the centre so
    // opponents orbit rather than pin against a wall.
    const toCentre = Math.atan2(-o.x, o.z);
    return o.wander + this.rng.range(-0.5, 0.5) * 0.6 + Math.sin(toCentre) * 0.12;
  }

  /** The impact flash. Cheap: one additive ring that expands and dies. */
  private burst(x: number, z: number, color: number): void {
    const geo = new THREE.RingGeometry(0.5, 2.0, 24);
    geo.rotateX(-Math.PI / 2);
    const mat = createGlowMaterial(color, 0.9);
    const ring = new THREE.Mesh(geo, mat);
    ring.position.set(x, 0.5, z);
    this.scene.add(ring);

    let t = 0;
    const grow = (dt: number) => {
      t += dt;
      const k = clamp(t / 0.55, 0, 1);
      ring.scale.setScalar(1 + k * 9);
      mat.opacity = 0.9 * (1 - k);
      if (k >= 1) {
        this.scene.remove(ring);
        geo.dispose();
        mat.dispose();
      }
    };
    // Drive it off the same frame loop, one-shot.
    const off = this.transient(grow);
    void off;
  }

  private transients: Array<(dt: number) => void> = [];

  private transient(fn: (dt: number) => void): () => void {
    this.transients.push(fn);
    return () => {
      const i = this.transients.indexOf(fn);
      if (i >= 0) this.transients.splice(i, 1);
    };
  }

  private updateOver(dt: number): void {
    this.phaseT += dt;

    // Let the player coast for a beat before control returns, so death is not
    // an instant snap back to the machine.
    this.speed = damp(this.speed, 0, 3, dt);
    this.x += Math.sin(this.angle) * this.speed * dt;
    this.z -= Math.cos(this.angle) * this.speed * dt;
    this.playerLightMat.opacity = damp(this.playerLightMat.opacity, 0.05, 3, dt);

    if (this.phaseT > 2.4) {
      const survivors = this.opponents.filter((o) => o.alive).length;
      const won = this.winLatched;
      const rank = won ? (survivors === 0 ? 'SOLE SURVIVOR' : 'SURVIVOR') : 'DEREZZED';
      const score = Math.round(
        (won ? 1000 : 200) + survivors * 150 + (ROUND_SECONDS - this.roundT) * 12,
      );
      this.resolve({ won, survivors, rank, score });
    }
  }

  private endRound(won: boolean): void {
    this.phase = 'over';
    this.phaseT = 0;
    this.winLatched = won;

    if (won) {
      this.audio.discovery();
      this.onMessage?.({ title: 'GRID SECURED', line: 'ALL CYCLES DEREGISTERED' });
    } else {
      this.audio.disconnect();
      this.shake = 1;
      this.burst(this.x, this.z, PALETTE.red);
      this.onMessage?.({ title: 'DEREZZED', line: 'CONNECTION TERMINATED' });
    }
  }

  /* ---------------------------------------------------------------------
     Camera and visuals
     --------------------------------------------------------------------- */

  /**
   * Chase camera, close and low. High and far would make the walls readable but
   * would also flatten the speed and let the player see past their own turn.
   */
  private applyCamera(elapsed: number, dt: number): void {
    const back = 7.5;
    const height = 3.4;

    const targetX = this.x - Math.sin(this.angle) * back;
    const targetZ = this.z + Math.cos(this.angle) * back;

    // Positional damping rather than a hard mount: the camera lags into turns,
    // which is where the sense of speed comes from.
    this.camera.position.x = damp(this.camera.position.x, targetX, 14, dt);
    this.camera.position.y = height;
    this.camera.position.z = damp(this.camera.position.z, targetZ, 14, dt);

    // Look slightly ahead of the cycle, so a turn reveals what it is about to
    // hit a moment before impact.
    const lookX = this.x + Math.sin(this.angle) * 9;
    const lookZ = this.z - Math.cos(this.angle) * 9;

    const jitter = this.shake * 0.6;
    this.camera.lookAt(
      lookX + Math.sin(elapsed * 47) * jitter,
      1.6,
      lookZ + Math.cos(elapsed * 53) * jitter,
    );

    // Speed FOV: 78 at rest, 92 at full speed. Subtle, but it is felt.
    const targetFov = lerp(78, 92, clamp(this.speed / BASE_SPEED, 0, 1));
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, targetFov, 4, dt);
      this.camera.updateProjectionMatrix();
    }

    // Body transform.
    this.body.position.set(this.x, 0, this.z);
    this.body.rotation.y = this.angle;

    for (const o of this.opponents) {
      o.mesh.position.set(o.x, 0, o.z);
      o.mesh.rotation.y = o.angle;
    }
  }

  /** Push dt through the one-shot effects (impact rings). */
  stepTransients(dt: number): void {
    for (const fn of this.transients) fn(dt);
    if (this.transients.length > 24) this.transients.length = 24;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.scene.clear();
  }
}