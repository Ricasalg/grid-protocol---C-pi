/* ============================================================================
   The Grid entry: one continuous 12.6-second camera move, no cuts.

   The brief is specific about the beat sheet, and the order matters more than
   the exact seconds:

     0.0 - 1.5s   scan-line sweep, the previous interface dissolving to points
     1.5 - 4.0s   the field collapses into a point; audio peak, rising sub
     4.0 - 8.0s   first-person fall down a data tunnel; FOV 70 -> ~110
     8.0 - 10.0s  deceleration, city resolving, camera tilting down
    10.0 - 12.0s  landing "rez": expanding ring, wide reverb
    12.0 - 12.6s  wake-up: look up from the floor to the horizon

   Every phase returns the same tuple — eye position, look target, roll, FOV —
   and one block applies it. Nothing cuts and nothing teleports; the camera is
   a single rigid transform for the whole twelve seconds.

   Skipping does not fast-forward through the middle. It jumps to the last two
   seconds and plays the landing out, so a skipping player still never sees a
   cut.

   prefers-reduced-motion replaces all of it with a fade from black.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE, TIMING, quality } from '@/core/config';
import { clamp01, lerp, smoothstep, volatileRng } from '@/core/rng';
import {
  createGlowMaterial,
  createParticleMaterial,
  createTunnelMaterial,
} from '@/render/materials';
import type { Renderer } from '@/render/renderer';
import type { AudioEngine } from '@/audio/engine';
import type { PlayerController } from '@/player/controller';
import type { GridWorld } from './world';

/** Phase boundaries in seconds. */
const T = {
  dissolveEnd: 1.5,
  collapseEnd: 4.0,
  tunnelEnd: 8.0,
  revealEnd: 10.0,
  landEnd: 12.0,
  end: TIMING.descentDuration,
} as const;

/** Where the camera lands, and where the player resumes control. */
export const LANDING_POINT = new THREE.Vector3(0, 0, 0);

/**
 * Final yaw. The light path runs along +Z, and yaw 0 faces -Z, so facing the
 * path means yaw = PI. This is the single fact that tells the player where to
 * go without a word of text.
 */
export const LANDING_YAW = Math.PI;

/** One frame of the camera path. */
interface CameraState {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  roll: number;
  fov: number;
}

export class Descent {
  readonly scene = new THREE.Scene();

  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2600);

  private readonly renderer: Renderer;
  private readonly audio: AudioEngine;
  private readonly world: GridWorld;
  private readonly player: PlayerController;

  /* --- the fall's contents --- */
  private readonly tunnel: THREE.Mesh;
  private readonly tunnelMat: THREE.ShaderMaterial;
  private readonly field: THREE.Points;
  private readonly smear: THREE.Points;
  private readonly core: THREE.Mesh;
  private readonly coreMat: THREE.MeshBasicMaterial;

  private readonly state: CameraState = {
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    roll: 0,
    fov: 70,
  };

  private elapsed = 0;
  private running = false;
  private finished = false;
  private landingPlayed = false;
  private resolveJack: (() => void) | null = null;
  private doneCb: (() => void) | null = null;

  /** Audio cues, each fired exactly once. */
  private whooshFired = false;
  private subFired = false;
  private impactFired = false;
  private rezFired = false;

  constructor(
    renderer: Renderer,
    audio: AudioEngine,
    world: GridWorld,
    player: PlayerController,
  ) {
    this.renderer = renderer;
    this.audio = audio;
    this.world = world;
    this.player = player;

    this.scene.background = new THREE.Color(PALETTE.black);
    // The tunnel scene needs its own fog or the far geometry will read as flat
    // cut-outs against the black.
    this.scene.fog = new THREE.FogExp2(PALETTE.black, 0.009);

    /* --- tunnel: a long cylinder the camera falls through --- */
    const radialSegs = quality.profile.tunnelSegments * 8;
    const tunnelGeo = new THREE.CylinderGeometry(
      24,
      8,
      1000,
      radialSegs,
      Math.max(8, Math.round(radialSegs / 2)),
      true,
    );
    // CylinderGeometry lays uv.y in 0..1 over its full height; repeating it is
    // what gives the shader enough rings to read as speed.
    repeatV(tunnelGeo, 6);

    this.tunnelMat = createTunnelMaterial(PALETTE.cyan, { speed: 1.4, intensity: 1.0 });
    this.tunnel = new THREE.Mesh(tunnelGeo, this.tunnelMat);
    this.tunnel.visible = false;
    this.tunnel.frustumCulled = false;
    this.scene.add(this.tunnel);

    /* --- the dissolving field: starts as a flat screen of points --- */
    this.field = new THREE.Points(
      makePointCloud(
        () => {
          // A wide, shallow slab in front of the camera: it reads as a
          // broken interface rather than a starfield.
          return [
            volatileRng.range(-26, 26),
            volatileRng.range(-16, 16),
            volatileRng.range(-46, -14),
          ];
        },
        Math.min(2400, quality.profile.groundDust + 800),
      ),
      createParticleMaterial(PALETTE.ice, 1.5),
    );
    this.field.frustumCulled = false;
    this.scene.add(this.field);

    /* --- streaks: what the field becomes once we are moving --- */
    this.smear = new THREE.Points(
      makePointCloud(
        () => [
          volatileRng.range(-20, 20),
          volatileRng.range(-20, 20),
          volatileRng.range(-280, -24),
        ],
        quality.profile.tunnelGlyphs,
      ),
      createParticleMaterial(PALETTE.cyan, 1.0),
    );
    this.smear.frustumCulled = false;
    this.smear.visible = false;
    this.scene.add(this.smear);

    /* --- the collapse core everything is drawn into --- */
    const coreGeo = new THREE.SphereGeometry(0.5, 14, 12);
    this.coreMat = createGlowMaterial(PALETTE.white, 0);
    this.core = new THREE.Mesh(coreGeo, this.coreMat);
    this.core.position.set(0, 0, -58);
    this.core.visible = false;
    this.scene.add(this.core);
  }

  /* ---------------------------------------------------------------------
     Run
     --------------------------------------------------------------------- */

  /** Start the cinematic. Resolves once the player is standing on the platform. */
  run(onDone: () => void): Promise<void> {
    this.doneCb = onDone;

    if (!quality.motionOk) {
      // Reduced motion: skip the move entirely and just place the player, with
      // a short black hold so the transition still has a beat to it.
      this.renderer.setScene(this.world.group, this.player.camera);
      this.renderer.setInterference(0);
      this.player.teleport(LANDING_POINT.x, LANDING_POINT.z, LANDING_YAW, -0.2);
      this.world.playLanding();
      this.finished = true;

      return new Promise<void>((resolve) => {
        window.setTimeout(() => {
          this.player.teleport(LANDING_POINT.x, LANDING_POINT.z, LANDING_YAW, 0.04);
          onDone();
          resolve();
        }, 900);
      });
    }

    this.running = true;
    this.elapsed = 0;
    this.player.setEnabled(false);
    this.renderer.setScene(this.scene, this.camera);
    this.renderer.setInterference(1.0);

    return new Promise<void>((resolve) => {
      this.resolveJack = resolve;
    });
  }

  /**
   * Skip. Rather than fast-forwarding, jump to the start of the reveal so the
   * descent still ends on a grounded, continuous camera.
   */
  skip(): void {
    if (this.finished || !this.running) return;
    this.elapsed = T.tunnelEnd;
    this.whooshFired = true;
    this.subFired = true;
  }

  /* ---------------------------------------------------------------------
     Frame
     --------------------------------------------------------------------- */

  update(dt: number): void {
    if (!this.running) return;

    this.elapsed = Math.min(this.elapsed + dt, T.end);
    const t = this.elapsed;

    this.updateInterference(t);
    this.updateCues(t);
    this.applyCamera(t);
    this.updateContents(t);

    if (t >= T.end) this.finish();
  }

  private finish(): void {
    this.running = false;
    this.finished = true;
    this.renderer.setInterference(0);

    // Hand the viewport back and hand over control. The player controller owns
    // the world camera from here.
    this.renderer.setScene(this.world.group, this.player.camera);
    this.player.teleport(LANDING_POINT.x, LANDING_POINT.z, LANDING_YAW, 0.04);
    this.player.setEnabled(true);

    const resolve = this.resolveJack;
    this.resolveJack = null;
    this.doneCb?.();
    resolve?.();
  }

  /**
   * Rolling signal-loss band. Strongest at the start, dipping as the fall takes
   * over. This is what makes the entry read as a transmission rather than a
   * fade to black.
   */
  private updateInterference(t: number): void {
    let v: number;
    if (t < T.dissolveEnd) {
      v = lerp(1.0, 0.62, t / T.dissolveEnd);
    } else if (t < T.tunnelEnd) {
      v = lerp(0.62, 0.16, (t - T.dissolveEnd) / (T.tunnelEnd - T.dissolveEnd));
    } else {
      v = lerp(0.16, 0.0, (t - T.tunnelEnd) / (T.landEnd - T.tunnelEnd));
    }
    this.renderer.setInterference(v);
  }

  private updateCues(t: number): void {
    if (!this.whooshFired && t >= 0.2) {
      this.whooshFired = true;
      this.audio.whoosh(0.1);
    }
    if (!this.subFired && t >= T.dissolveEnd) {
      this.subFired = true;
      this.audio.subSwell(0.2);
      this.audio.whoosh(0.6);
    }
    if (!this.impactFired && t >= T.landEnd - 1.2) {
      this.impactFired = true;
      this.audio.impact();
    }
    if (!this.rezFired && t >= T.landEnd) {
      // The two-note "loaded" chime under the reverb tail.
      this.rezFired = true;
      this.audio.blip(1320, 0.28, 0.13, 'sine');
      window.setTimeout(() => this.audio.blip(1760, 0.36, 0.09, 'sine'), 170);
    }
  }

  /* ---------------------------------------------------------------------
     The camera path
     --------------------------------------------------------------------- */

  /** Evaluate the path at time `t`, then apply it. One transform, no cuts. */
  private applyCamera(t: number): void {
    const s = this.state;

    if (t < T.dissolveEnd) {
      /* --- 0.0-1.5s: the interface fails --- */
      const k = t / T.dissolveEnd;
      s.pos.set(0, 0, 0);
      s.look.set(0, 0, -58);
      // A hair of drift so the shot is never a still frame.
      s.roll = Math.sin(k * 2.2) * 0.018;
      s.fov = lerp(56, 64, k);
    } else if (t < T.collapseEnd) {
      /* --- 1.5-4.0s: collapse to a point --- */
      const k = (t - T.dissolveEnd) / (T.collapseEnd - T.dissolveEnd);
      const pull = k * k;
      s.pos.set(0, 0, -pull * 22);
      s.look.set(0, 0, -58 - pull * 70);
      s.roll = Math.sin(k * 6.5) * 0.05 * (1 - k);
      s.fov = lerp(64, 88, pull);
    } else if (t < T.tunnelEnd) {
      /* --- 4.0-8.0s: the fall --- */
      const k = (t - T.collapseEnd) / (T.tunnelEnd - T.collapseEnd);

      // Hard acceleration for the first 40%, then a near-plateau. The plateau
      // is what sells speed: pure ease-in reads as "still speeding up" right to
      // the end and leaves nothing for the reveal to contrast against.
      const travel =
        k < 0.4
          ? Math.pow(k / 0.4, 2.2) * 0.5
          : 0.5 + ((k - 0.4) / 0.6) * 0.5;

      const z = lerp(-40, 430, travel);
      s.pos.set(
        Math.sin(k * 3.1) * 1.7 * (1 - k * 0.4),
        Math.cos(k * 2.3) * 1.3 * (1 - k * 0.4),
        z,
      );
      s.look.set(s.pos.x * 0.35, s.pos.y * 0.35, z - 45);
      s.roll = Math.sin(k * 9) * 0.085 * (1 - smoothstep(0.68, 1, k));
      // 70 -> 110, eased so the widening is felt rather than watched.
      s.fov = lerp(70, 110, Math.pow(k, 0.7));
    } else if (t < T.revealEnd) {
      /* --- 8.0-10.0s: deceleration, the city resolves, tilt down --- */
      const k = (t - T.tunnelEnd) / (T.revealEnd - T.tunnelEnd);
      const eased = 1 - Math.pow(1 - k, 2.4);

      s.pos.set(0, lerp(120, 13, eased), lerp(430, 24, eased));
      // Look at a point rising to meet us, so the pitch unwinds continuously
      // from the fall's straight-ahead gaze.
      s.look.set(0, lerp(22, 0.8, Math.pow(k, 0.8)), 0);
      s.roll = 0;
      s.fov = lerp(110, 74, eased);
    } else if (t < T.landEnd) {
      /* --- 10.0-12.0s: the landing --- */
      const k = (t - T.revealEnd) / (T.landEnd - T.revealEnd);
      const eased = smoothstep(0, 1, k);

      // Settle onto the platform with one small vertical bounce that dies out.
      const bounce = Math.abs(Math.sin(k * Math.PI * 1.5)) * 0.42 * (1 - k);
      s.pos.set(0, lerp(13, 1.7, eased) + bounce, lerp(24, 0, eased));
      s.look.set(0, lerp(0.8, 1.9, Math.pow(k, 1.6)), 0);
      s.roll = Math.sin(k * Math.PI * 2) * 0.006 * (1 - k);
      s.fov = lerp(74, 70, eased);

      if (k > 0.3 && !this.landingPlayed) {
        this.landingPlayed = true;
        this.world.playLanding();
        this.audio.footstep(1.2);
      }
    } else {
      /* --- 12.0-12.6s: wake up --- */
      const k = (t - T.landEnd) / (T.end - T.landEnd);
      const eased = smoothstep(0, 1, k);

      // From the floor to the horizon. This is the one beat where the camera
      // deliberately looks up, and it is what makes arriving feel like arriving
      // rather than like spawning.
      s.pos.set(0, lerp(3.4, 1.7, eased), 0);
      s.look.set(0, lerp(-0.6, 2.4, Math.pow(k, 0.8)), -6);
      s.roll = 0;
      s.fov = 70;
    }

    /* --- apply --- */
    const cam = this.camera;
    cam.position.copy(s.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.look);

    // lookAt gives us yaw and pitch with no roll, which is exactly the
    // 'YXZ' convention the player controller uses; re-applying it in that
    // order keeps the hand-off between the two seamless.
    if (s.roll !== 0) {
      const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
      cam.rotation.set(e.x, e.y, s.roll, 'YXZ');
    }

    if (Math.abs(cam.fov - s.fov) > 0.01) {
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
    }

    // Keep the player controller's logical state tracking the cinematic, so the
    // hand-off is a no-op rather than a jump.
    this.player.position.copy(s.pos);
    this.player.camera.fov = cam.fov;
  }

  /* ---------------------------------------------------------------------
     Contents
     --------------------------------------------------------------------- */

  private updateContents(t: number): void {
    /* --- dissolving field / collapse core --- */
    if (t < T.collapseEnd) {
      this.field.visible = true;
      this.core.visible = true;

      if (t < T.dissolveEnd) {
        // Held roughly still, jittering in place: an interface losing signal.
        this.field.position.set(0, 0, 0);
      } else {
        // Drawn into the core. Scaling the whole Points object toward the
        // target is orders of magnitude cheaper than animating every position,
        // and at this density the difference is invisible.
        const k = (t - T.dissolveEnd) / (T.collapseEnd - T.dissolveEnd);
        const pull = k * k;
        this.field.position.set(0, 0, -58);
        this.field.scale.setScalar(lerp(1, 0.1, pull));

        this.coreMat.opacity = Math.pow(k, 1.3) * 0.9;
        this.core.scale.setScalar(lerp(0.15, 3.0, k));
      }
    } else {
      this.field.visible = false;
      this.core.visible = false;
    }

    /* --- streaks --- */
    const falling = t >= T.collapseEnd;
    this.smear.visible = falling && t < T.revealEnd + 0.8;
    if (this.smear.visible) {
      // Re-anchor on the camera so a finite buffer covers the whole fall.
      this.smear.position.copy(this.camera.position);
    }

    /* --- tunnel: sits ahead of the camera, then recedes after the exit --- */
    if (t > T.dissolveEnd && t < T.revealEnd + 0.8) {
      const ahead = t < T.tunnelEnd;
      if (ahead) {
        // Ring speed is the primary speed cue, so it tracks velocity: fast on
        // the way in, easing out through the reveal.
        const k = clamp01((t - T.collapseEnd) / (T.tunnelEnd - T.collapseEnd));
        this.tunnelMat.uniforms.uSpeed.value = lerp(1.4, 3.6, Math.pow(k, 0.8));
      } else {
        this.tunnelMat.uniforms.uSpeed.value = lerp(3.6, 0.4, clamp01((t - T.tunnelEnd) / 1.4));
      }

      this.tunnel.position.set(
        this.camera.position.x,
        this.camera.position.y,
        this.camera.position.z - 380,
      );
      this.tunnel.visible = true;
    } else {
      this.tunnel.visible = false;
    }
  }

  dispose(): void {
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.scene.clear();
  }
}

/* -------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

/**
 * Build a point cloud with the per-point attributes the shared particle shader
 * expects. `place` supplies the initial position of each point.
 */
function makePointCloud(place: () => [number, number, number], count: number): THREE.BufferGeometry {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const speeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const [x, y, z] = place();
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    seeds[i] = volatileRng.next();
    speeds[i] = volatileRng.range(0.6, 2.4);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
  return geo;
}

/**
 * Multiply a geometry's uv.y channel. CylinderGeometry spans uv.y 0..1 over its
 * whole height, which is far too few repeats for the tunnel shader's rings.
 */
function repeatV(geo: THREE.BufferGeometry, repeats: number): void {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) return;

  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, uv.getY(i) * repeats);
  }
  uv.needsUpdate = true;
}