/* ============================================================================
   Pursuers.

   The things that hunt you in Security, Corrupt and the Core.

   Design rules, in priority order:

   1. **They are readable.** An amber geometry that closes distance slowly, and
      a light bar that shows you which way it is looking even when it is behind
      you. A pursuer you cannot see is a bad experience; a pursuer you can see
      coming is tension.

   2. **They do not hit you unfairly.** They hunt by the shortest route, not by
      teleporting. They keep a small personal space around the player so they
      crowd rather than overlap, and they only damage on contact with a cooldown.

   3. **They can be outrun.** Speed is deliberately below the player's sprint,
      with a slow ramp only when they have been chasing a long time. A player
      who learns the sector can escape.

   They announce themselves on spawn and when they acquire you. Silence would
   make the sector feel arbitrary; a rising tone makes it feel hunted.

   This module owns no game state. It reports proximity; main.ts decides damage.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE } from '@/core/config';
import { Rng, clamp, damp } from '@/core/rng';
import { createEdgeMaterial, createGlowMaterial, createStructureMaterial } from '@/render/materials';

export type PursuerState = 'dormant' | 'hunting' | 'striking';

export interface Pursuer {
  group: THREE.Group;
  position: THREE.Vector3;
  state: PursuerState;
  /** Distance to the player, refreshed each frame by update(). */
  distance: number;
  /** True on the frame it transitions into hunting. */
  acquired: boolean;
  /**
   * Advance one frame.
   * @returns true on the frame it strikes the player.
   */
  update(dt: number, elapsed: number, playerPos: THREE.Vector3, half: number): boolean;
  dispose(): void;
}

/** Tunables. Deliberately readable as a block rather than scattered literals. */
const TUNE = {
  /** Below this, a pursuer is idle. Above, it hunts. */
  acquireRange: 46,
  /** Below this it strikes. */
  strikeRange: 2.2,
  /** Above this it loses interest and drifts back to dormant. */
  releaseRange: 78,

  baseSpeed: 3.4,
  /** Added per second of continuous pursuit, capped. */
  rampSpeed: 0.5,
  maxSpeed: 6.4,

  /** How fast it turns toward its target. Low = ponderous, readable. */
  turnRate: 1.6,

  /** Keeps a pursuer from standing inside the player. */
  crowdRadius: 3.4,

  /** Seconds between damage ticks while in contact. */
  strikeCooldown: 1.15,
};

/** One hunter. */
class PursuerImpl implements Pursuer {
  readonly group = new THREE.Group();
  readonly position = new THREE.Vector3();
  state: PursuerState = 'dormant';
  distance = Infinity;
  acquired = false;

  private readonly heading = new THREE.Vector3(0, 0, 1);
  private readonly desired = new THREE.Vector3();
  private readonly disposables: Array<{ dispose(): void }> = [];

  private readonly body: THREE.Mesh;
  private readonly barMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly bar: THREE.Mesh;
  private readonly core: THREE.Mesh;

  private chaseTime = 0;
  private strikeTimer = 0;
  private flickerSeed: number;
  private hit = false;

  constructor(x: number, z: number, rng: Rng, hue: number) {
    this.flickerSeed = rng.range(0, 100);

    /* --- body: an angular shell, not a box. It reads as a process. --- */
    const bodyGeo = new THREE.IcosahedronGeometry(0.85, 0);
    const bodyMat = createStructureMaterial(hue, { emissiveEdges: 1.4, scanSpeed: 0.8 });
    this.body = new THREE.Mesh(bodyGeo, bodyMat);
    this.body.position.y = 1.3;
    this.group.add(this.body);
    this.disposables.push(bodyGeo, bodyMat);

    const bodyEdges = new THREE.EdgesGeometry(bodyGeo);
    const edgeMat = createEdgeMaterial(PALETTE.white, 0.7);
    const bodyOutline = new THREE.LineSegments(bodyEdges, edgeMat);
    bodyOutline.position.copy(this.body.position);
    this.group.add(bodyOutline);
    this.disposables.push(bodyEdges, edgeMat);

    /* --- the bar: which way it is looking. Readable in peripheral vision. --- */
    const barGeo = new THREE.BoxGeometry(0.1, 0.1, 2.4);
    this.barMat = createGlowMaterial(PALETTE.amber, 0.9);
    this.bar = new THREE.Mesh(barGeo, this.barMat);
    this.bar.position.set(0, 1.3, 1.2);
    this.group.add(this.bar);
    this.disposables.push(barGeo, this.barMat);

    /* --- core: pulses faster the closer it is. Your distance readout. --- */
    const coreGeo = new THREE.SphereGeometry(0.22, 10, 8);
    this.coreMat = createGlowMaterial(hue, 0.95);
    this.core = new THREE.Mesh(coreGeo, this.coreMat);
    this.core.position.y = 1.3;
    this.group.add(this.core);
    this.disposables.push(coreGeo, this.coreMat);

    this.position.set(x, 0, z);
    this.group.position.copy(this.position);
  }

  /**
   * @returns true on the frame this pursuer strikes the player.
   */
  update(
    dt: number,
    elapsed: number,
    playerPos: THREE.Vector3,
    half: number,
  ): boolean {
    this.acquired = false;

    const toPlayer = this.desired.copy(playerPos).sub(this.position);
    toPlayer.y = 0;
    this.distance = toPlayer.length();

    /* --- state machine --- */
    if (this.state === 'dormant' && this.distance < TUNE.acquireRange) {
      this.state = 'hunting';
      this.chaseTime = 0;
      this.acquired = true;
    } else if (this.state === 'hunting' && this.distance > TUNE.releaseRange) {
      this.state = 'dormant';
      this.chaseTime = 0;
    }

    /* --- movement --- */
    if (this.state !== 'dormant') {
      this.chaseTime += dt;

      const speed = Math.min(TUNE.baseSpeed + this.chaseTime * TUNE.rampSpeed, TUNE.maxSpeed);

      // Steer toward the player, but hold a little distance once close, so it
      // orbits and crowds instead of shoving.
      if (this.distance < TUNE.crowdRadius) {
        // Push outward once inside the crowd radius.
        toPlayer.normalize().multiplyScalar(-1);
      } else {
        toPlayer.normalize();
      }

      // Turn toward the heading rather than snapping the position, so the bar
      // visibly leads the movement.
      const targetHeading = toPlayer.lengthSq() > 0.001 ? toPlayer.clone().normalize() : this.heading;
      this.heading.lerp(targetHeading, clamp(dt * TUNE.turnRate, 0, 1)).normalize();

      this.position.addScaledVector(this.heading, speed * dt);

      // Stay in the sector. A hunter that leaves the world is a bug the player
      // will notice and blame us for.
      const limit = half - 2;
      this.position.x = clamp(this.position.x, -limit, limit);
      this.position.z = clamp(this.position.z, -limit, limit);

      this.group.position.copy(this.position);
      this.group.rotation.y = Math.atan2(this.heading.x, this.heading.z);
    }

    /* --- strike --- */
    this.strikeTimer = Math.max(0, this.strikeTimer - dt);
    this.hit = false;
    if (this.state !== 'dormant' && this.distance < TUNE.strikeRange && this.strikeTimer <= 0) {
      this.state = 'striking';
      this.strikeTimer = TUNE.strikeCooldown;
      this.hit = true;
    } else if (this.state === 'striking' && this.distance > TUNE.strikeRange * 1.4) {
      this.state = 'hunting';
    }

    /* --- presentation --- */

    // The bar sweeps, so a stationary pursuer is never fully static.
    const sweep = elapsed * 1.6 + this.flickerSeed;
    this.bar.position.x = Math.sin(sweep) * 0.7;
    this.bar.position.y = 1.3 + Math.cos(sweep * 0.7) * 0.35;

    // Colour reports state without any UI: dim and slow when dormant, bright
    // and fast when hunting.
    const hunting = this.state !== 'dormant';
    const targetCore = hunting ? 0.95 : 0.28;
    const targetBar = hunting ? 0.9 : 0.35;
    this.coreMat.opacity = damp(this.coreMat.opacity, targetCore, 4, dt);
    this.barMat.opacity = damp(this.barMat.opacity, targetBar, 4, dt);

    // Core pulse rate scales with proximity — a heartbeat you feel.
    const rate = 2 + (1 - clamp(this.distance / 60, 0, 1)) * 6;
    const pulse = 0.6 + Math.sin(elapsed * rate + this.flickerSeed) * 0.4;
    this.core.scale.setScalar(0.8 + pulse * 0.5);

    // Dormant bodies drift, hunting bodies lock upright. Subtle, but it means
    // you can tell a sleeping one from a live one without the bar.
    this.body.rotation.y += dt * (hunting ? 1.4 : 0.25);
    this.body.rotation.x = damp(this.body.rotation.x, hunting ? 0 : 0.4, 2, dt);

    return this.hit;
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* already released */
      }
    }
    this.disposables.length = 0;
    this.group.clear();
  }
}

/* -------------------------------------------------------------------------
   Swarm
   -------------------------------------------------------------------------- */

/**
 * The set of pursuers in a sector. Added to and removed from the sector scene,
 * and driven once per frame.
 */
export class Swarm {
  readonly group = new THREE.Group();
  readonly members: Pursuer[] = [];

  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(count: number, half: number, seed: number, hue: number = PALETTE.amber) {
    const rng = new Rng(seed);

    for (let i = 0; i < count; i++) {
      // Spawn away from the origin, so the player is not hit on arrival.
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(half * 0.45, half * 0.9);
      const p = new PursuerImpl(Math.cos(a) * r, Math.sin(a) * r, rng, hue);
      this.members.push(p);
      this.group.add(p.group);
    }
  }

  /**
   * @returns how many struck this frame — main.ts applies damage and the alarm.
   */
  update(dt: number, elapsed: number, playerPos: THREE.Vector3, half: number): number {
    let strikes = 0;
    for (const p of this.members) {
      if (p.update(dt, elapsed, playerPos, half)) strikes++;
    }
    return strikes;
  }

  /** True if any member is currently hunting. Drives ambient tension audio. */
  get anyHunting(): boolean {
    return this.members.some((m) => m.state !== 'dormant');
  }

  /** Closest member, or Infinity. Used for the HUD proximity warning. */
  closest(): number {
    let best = Infinity;
    for (const m of this.members) best = Math.min(best, m.distance);
    return best;
  }

  reset(): void {
    for (const m of this.members) {
      m.state = 'dormant';
      m.group.position.copy(m.position);
    }
  }

  dispose(): void {
    for (const m of this.members) m.dispose();
    this.members.length = 0;
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* already released */
      }
    }
    this.disposables.length = 0;
    this.group.clear();
  }
}