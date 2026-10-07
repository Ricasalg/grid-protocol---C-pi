/* ============================================================================
   Sector builder.

   Builds a walkable place from a SectorDef. This is the engine behind every
   node in network.json that is not the Plaza — the Plaza has its own hand-built
   world because it is the one the player spends the most time in and it carries
   the descent's landing.

   Design notes:

   * A sector is disposable. It is constructed on entry, thrown away on exit.
     Nothing persists except what the save file records.

   * Tone drives everything: fog colour, structure colour, how the walls behave.
     The Archive is calm and ordered. Security is amber and close. Corrupt is
     visibly broken. The Core is all of them at once. The player should be able
     to tell which sector they are in from a single frame, with the HUD off.

   * Density scales with the quality tier, so a low-end device walks the same
     layout in a lighter scene rather than a different one.

   This module owns no game state. It draws and it reports colliders.
   ========================================================================== */

import * as THREE from 'three';
import sectorsJson from '@/data/sectors.json';
import { PALETTE, quality } from '@/core/config';
import { Rng, clamp, damp } from '@/core/rng';
import {
  createEdgeMaterial,
  createFloorMaterial,
  createGlowMaterial,
  createParticleMaterial,
  createSkyMaterial,
  createStructureMaterial,
} from '@/render/materials';
import type { AABB } from '@/player/controller';
import type { SectorData, SectorDef, SectorTone } from './types';

const data = sectorsJson as SectorData;

export { data as SECTORS };
export type { SectorDef, SectorTone };

export function sectorDef(id: string): SectorDef | undefined {
  return data.sectors.find((s) => s.id === id);
}

export function allSectorIds(): string[] {
  return data.sectors.map((s) => s.id);
}

/** Per-tone palette. This is the whole visual identity of a sector. */
interface ToneLook {
  fog: number;
  structure: number;
  edge: number;
  accent: number;
  /** Structures flicker. 0 is steady. */
  glitch: number;
  /** Ambient motes. 0 is a clean void. */
  motes: number;
}

const LOOKS: Record<SectorTone, ToneLook> = {
  // Storage: cold, still, enormous. Nothing here is awake.
  archive: {
    fog: 0x03070c,
    structure: PALETTE.cyanDim,
    edge: PALETTE.ice,
    accent: PALETTE.cyan,
    glitch: 0,
    motes: 0.4,
  },
  // Security: amber is reserved for hostility, so this sector is amber.
  security: {
    fog: 0x0a0500,
    structure: PALETTE.amberDim,
    edge: PALETTE.amber,
    accent: PALETTE.red,
    glitch: 0.08,
    motes: 0.7,
  },
  // Corrupt: the palette itself is unreliable.
  corrupt: {
    fog: 0x05030a,
    structure: PALETTE.violet,
    edge: PALETTE.ice,
    accent: PALETTE.white,
    glitch: 0.45,
    motes: 1.0,
  },
  // The Core: it is not one colour. It is every colour, held together.
  core: {
    fog: 0x000000,
    structure: PALETTE.cyan,
    edge: PALETTE.white,
    accent: PALETTE.violet,
    glitch: 0.2,
    motes: 1.2,
  },
  // The ISO's layer. Violet, and warmer than it should be.
  iso: {
    fog: 0x050310,
    structure: PALETTE.violet,
    edge: PALETTE.ice,
    accent: PALETTE.violet,
    glitch: 0.02,
    motes: 0.8,
  },
};

/* -------------------------------------------------------------------------
   Built sector
   -------------------------------------------------------------------------- */

export class Sector {
  readonly scene: THREE.Scene;
  readonly colliders: AABB[] = [];

  readonly def: SectorDef;
  private readonly rng: Rng;
  private readonly look: ToneLook;
  private readonly disposables: Array<{ dispose(): void }> = [];

  /** Structures that flicker, kept so update() can drive them. */
  private readonly glitchers: Array<{ mat: THREE.ShaderMaterial; seed: number }> = [];

  /** The structures that make the sector legible as *its* sector. */
  private readonly monuments: THREE.Object3D[] = [];

  private fog: THREE.FogExp2;

  constructor(def: SectorDef, seed: number) {
    this.def = def;
    this.rng = new Rng(seed);
    this.look = LOOKS[def.tone];

    this.scene = new THREE.Scene();
    this.fog = new THREE.FogExp2(this.look.fog, def.fog);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(this.look.fog);

    this.buildSky();
    this.buildFloor();
    if (def.ceiling > 0) this.buildCeiling(def.ceiling);
    this.buildStructures();
    this.buildBoundary();
    if (this.look.motes > 0) this.buildMotes();
  }

  /* ---------------------------------------------------------------------
     Construction
     --------------------------------------------------------------------- */

  private add<T extends { dispose(): void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private buildSky(): void {
    const geo = this.add(new THREE.SphereGeometry(600, 24, 16));
    // The sky is the sector's two defining colours, so it is worth reading at
    // a glance rather than as black.
    const mat = this.add(createSkyMaterial([this.look.fog, this.look.structure]));
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    this.scene.add(sky);
  }

  private buildFloor(): void {
    const size = this.def.half * 2;
    const geo = this.add(new THREE.PlaneGeometry(size, size, 1, 1));
    geo.rotateX(-Math.PI / 2);

    const mat = this.add(
      createFloorMaterial({
        color: this.look.structure,
        scale: 8,
        // Corrupt loses its grid. That is what corruption looks like.
        footstepResponse: this.def.tone === 'corrupt' ? 0.2 : 1.0,
      }),
    );

    const floor = new THREE.Mesh(geo, mat);
    floor.receiveShadow = false;
    this.scene.add(floor);
  }

  /** A lid, so enclosed sectors feel enclosed. */
  private buildCeiling(height: number): void {
    const geo = this.add(new THREE.PlaneGeometry(this.def.half * 2, this.def.half * 2));
    geo.rotateX(Math.PI / 2);
    const mat = this.add(createGlowMaterial(this.look.structure, 0.03));
    const ceiling = new THREE.Mesh(geo, mat);
    ceiling.position.y = height;
    this.scene.add(ceiling);

    // Ribs across it, so the ceiling has a scale to read against.
    const count = Math.round(8 * quality.profile.sectorDetail);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const rg = this.add(new THREE.BoxGeometry(this.def.half * 2, 0.3, 0.6));
      const rm = this.add(createEdgeMaterial(this.look.edge, 0.35));
      const rib = new THREE.LineSegments(new THREE.EdgesGeometry(rg), rm);
      this.add(rib.geometry as THREE.EdgesGeometry);
      rib.position.set(0, height - 0.2, (t - 0.5) * this.def.half * 1.9);
      this.scene.add(rib);
      rg.dispose();
    }
  }

  /**
   * The scattered forms.
   *
   * Three kinds, weighted per tone, because each sector should have a
   * recognisable grammar rather than one generic rubble pile.
   */
  private buildStructures(): void {
    const n = Math.round(this.def.density * quality.profile.sectorDetail);
    const { half } = this.def;

    for (let i = 0; i < n; i++) {
      // Keep the centre clear. A sector you cannot walk through is not a sector.
      const x = this.rng.range(-half, half);
      const z = this.rng.range(-half, half);
      if (Math.hypot(x, z) < 9) continue;

      const roll = this.rng.next();
      if (roll < 0.5) this.makeMonolith(x, z);
      else if (roll < 0.78) this.makeStack(x, z);
      else this.makePylon(x, z);
    }

    // Every sector gets one landmark, visible from its entrance, so the player
    // always has a "north". The Core's is enormous.
    this.makeMonument();
  }

  /** Tall slab, outlined. The Grid's vocabulary, reused. */
  private makeMonolith(x: number, z: number): void {
    const h = this.rng.range(4, 22);
    const w = this.rng.range(1.2, 3.6);
    const d = this.rng.range(1.2, 3.6);

    const geo = this.add(new THREE.BoxGeometry(w, h, d));
    const mat = this.add(
      createStructureMaterial(this.look.structure, { emissiveEdges: 1.0, scanSpeed: 0.3 }),
    );
    if (this.look.glitch > 0 && this.rng.chance(this.look.glitch * 2)) {
      this.glitchers.push({ mat, seed: this.rng.range(0, 100) });
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, h / 2, z);
    mesh.rotation.y = this.rng.range(0, Math.PI);
    this.scene.add(mesh);

    const eg = this.add(new THREE.EdgesGeometry(geo));
    const em = this.add(createEdgeMaterial(this.look.edge, 0.45));
    const edges = new THREE.LineSegments(eg, em);
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    this.scene.add(edges);

    this.colliders.push({
      min: new THREE.Vector3(x - w / 2, 0, z - d / 2),
      max: new THREE.Vector3(x + w / 2, h, z + d / 2),
    });
  }

  /**
   * A stack of offset slabs. Reads as storage: the Archive is mostly these,
   * which is why it looks like a library nobody has opened in years.
   */
  private makeStack(x: number, z: number): void {
    const layers = this.rng.range(3, 9);
    let y = 0;
    let w = this.rng.range(3, 7);
    let d = w;

    for (let i = 0; i < layers; i++) {
      const th = this.rng.range(0.5, 1.8);
      const geo = this.add(new THREE.BoxGeometry(w, th, d));
      const mat = this.add(createStructureMaterial(this.look.structure, { emissiveEdges: 0.7 }));
      if (this.look.glitch > 0 && this.rng.chance(this.look.glitch)) {
        this.glitchers.push({ mat, seed: this.rng.range(0, 100) });
      }

      const mesh = new THREE.Mesh(geo, mat);
      // Each layer is nudged. Regular stacks read as furniture; nudged ones
      // read as something that grew under pressure.
      mesh.position.set(
        x + this.rng.range(-0.5, 0.5),
        y + th / 2,
        z + this.rng.range(-0.5, 0.5),
      );
      mesh.rotation.y = this.rng.range(-0.06, 0.06);
      this.scene.add(mesh);

      y += th;
      w = Math.max(1.5, w * this.rng.range(0.82, 0.99));
      d = Math.max(1.5, d * this.rng.range(0.82, 0.99));
    }

    this.colliders.push({
      min: new THREE.Vector3(x - w / 2, 0, z - d / 2),
      max: new THREE.Vector3(x + w / 2, y, z + d / 2),
    });
  }

  /** A mast with rings. Pylons are how sectors mark paths. */
  private makePylon(x: number, z: number): void {
    const h = this.rng.range(5, 15);

    const geo = this.add(new THREE.CylinderGeometry(0.2, 0.32, h, 6));
    const mat = this.add(createGlowMaterial(this.look.accent, 0.5));
    const mast = new THREE.Mesh(geo, mat);
    mast.position.set(x, h / 2, z);
    this.scene.add(mast);

    const rings = this.rng.range(2, 5);
    for (let r = 0; r < rings; r++) {
      const rg = this.add(new THREE.TorusGeometry(this.rng.range(0.7, 1.5), 0.05, 5, 18));
      rg.rotateX(Math.PI / 2);
      const rm = this.add(createGlowMaterial(this.look.edge, 0.4));
      const ring = new THREE.Mesh(rg, rm);
      ring.position.set(x, 1.8 + (r * (h - 2)) / rings, z);
      this.scene.add(ring);
    }

    this.colliders.push({
      min: new THREE.Vector3(x - 0.5, 0, z - 0.5),
      max: new THREE.Vector3(x + 0.5, h, z + 0.5),
    });
  }

  /** The one structure a sector is remembered by. */
  private makeMonument(): void {
    const { half } = this.def;
    const z = -half * 0.55;

    let h: number;
    let geo: THREE.BufferGeometry;
    if (this.def.tone === 'core') {
      // The Core is a machine, not a building.
      h = half * 0.55;
      geo = this.add(new THREE.IcosahedronGeometry(h * 0.4, 1));
    } else if (this.def.tone === 'corrupt') {
      h = half * 0.35;
      geo = this.add(new THREE.OctahedronGeometry(h * 0.35, 0));
    } else {
      h = half * 0.28;
      geo = this.add(new THREE.CylinderGeometry(h * 0.12, h * 0.3, h, 6, 1, true));
    }

    const mat = this.add(createStructureMaterial(this.look.accent, { emissiveEdges: 1.6, scanSpeed: 0.18 }));
    const monument = new THREE.Mesh(geo, mat);
    monument.position.set(0, h / 2, z);
    this.scene.add(monument);
    this.monuments.push(monument);

    const eg = this.add(new THREE.EdgesGeometry(geo));
    const em = this.add(createEdgeMaterial(this.look.edge, 0.85));
    const edges = new THREE.LineSegments(eg, em);
    edges.position.copy(monument.position);
    this.scene.add(edges);
    this.disposables.push(em);
    this.glitchers.push({ mat, seed: this.rng.range(0, 100) });

    this.colliders.push({
      min: new THREE.Vector3(-h * 0.4, 0, z - h * 0.4),
      max: new THREE.Vector3(h * 0.4, h, z + h * 0.4),
    });
  }

  /**
   * The world edge.
   *
   * Not an invisible wall — §6.4 is explicit that limits are data walls. These
   * are dense enough that you read them as a wall of the world, and the
   * boundary energy drain in main.ts turns leaning on one into a decision.
   */
  private buildBoundary(): void {
    const { half } = this.def;

    for (let side = 0; side < 4; side++) {
      const horizontal = side % 2 === 0;
      const sign = side < 2 ? 1 : -1;

      const geo = this.add(
        new THREE.PlaneGeometry(half * 2, 9, 1, 1),
      );
      const mat = this.add(
        createStructureMaterial(this.look.accent, { emissiveEdges: 1.2, scanSpeed: 0.9 }),
      );
      const wall = new THREE.Mesh(geo, mat);

      if (horizontal) {
        wall.position.set(0, 4.5, sign * half);
      } else {
        wall.rotation.y = Math.PI / 2;
        wall.position.set(sign * half, 4.5, 0);
      }
      this.scene.add(wall);
      this.glitchers.push({ mat, seed: this.rng.range(0, 100) });
    }
  }

  /** Slow ambient motes. Density and colour are the tone's signature. */
  private buildMotes(): void {
    const count = Math.round(420 * quality.profile.sectorDetail * this.look.motes);
    if (count < 1) return;

    const geo = this.add(new THREE.BufferGeometry());
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    const speed = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      pos[i * 3] = this.rng.range(-this.def.half, this.def.half);
      pos[i * 3 + 1] = this.rng.range(0.2, 14);
      pos[i * 3 + 2] = this.rng.range(-this.def.half, this.def.half);
      seed[i] = this.rng.next();
      speed[i] = this.rng.range(0.1, 0.6);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));

    const mat = this.add(createParticleMaterial(this.look.accent, 1.4));
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.scene.add(points);
  }

  /* ---------------------------------------------------------------------
     Frame
     --------------------------------------------------------------------- */

  update(dt: number, elapsed: number): void {
    // Glitch: structures drop out and return. Never fully — a sector you cannot
    // navigate is a bug, not an effect.
    for (const g of this.glitchers) {
      const n = Math.sin(elapsed * 7.3 + g.seed) * Math.sin(elapsed * 2.1 + g.seed * 1.7);
      const drop = n > 0.86 - this.look.glitch * 0.5 ? 0.25 : 1.0;
      const target = drop;
      g.mat.opacity = damp(g.mat.opacity, target, 9, dt);
    }

    // The monument turns, slowly. It is the only thing in the sector that
    // moves on its own, which is what makes it read as the sector's centre.
    const m = this.monuments[0];
    if (m) m.rotation.y += dt * 0.06;
  }

  /** Footstep dust, same idea as the Grid's. */
  onFootstep(position: THREE.Vector3): void {
    // Sectors do not have per-footstep dust yet; the Grid's own handler covers
    // the Plaza. Kept so the interface matches and a future sector can add it.
    void position;
  }

  applyQuality(): void {
    void this;
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // Shared uniforms and already-released geometry are not worth crashing on.
      }
    }
    this.disposables.length = 0;
    this.scene.clear();
  }
}

/** Convenience: the colliders, already in the shape the controller wants. */
export function clampToSector(p: THREE.Vector3, half: number): void {
  const limit = half - 1.5;
  p.x = clamp(p.x, -limit, limit);
  p.z = clamp(p.z, -limit, limit);
}