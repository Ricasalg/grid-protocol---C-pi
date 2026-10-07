/* ============================================================================
   Sector transitions.

   The seam between the Plaza and the generated sectors. §9 says the opening is
   linear and then opens up; §10 says the network must feel bigger than one
   sitting can explore. Both are satisfied by the same mechanism: a door in the
   Grid that builds a different world, hands control over, and puts you back
   where you were standing when you leave.

   Three rules:

   1. **No loading screen.** A sector is generated synchronously on entry — it
      is a few hundred meshes, which is a frame or two, not a download. Anything
      longer than that and the player has to be told, which breaks the fiction.

   2. **You come back where you left.** The Plaza's position is remembered, so
      leaving and returning is seamless. Getting lost on the way back would be a
      failure of the map, not a puzzle.

   3. **Access is checked before the sector is built.** Refusing at the door is
      cheaper than building a world the player cannot use, and it lets the
      refusal be a terminal rather than a wall.

   This module owns the transition, not the game's rules — main.ts decides what
   entering a sector means for progression.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE } from '@/core/config';
import { Rng } from '@/core/rng';
import {
  createEdgeMaterial,
  createGlowMaterial,
} from '@/render/materials';
import { Sector, sectorDef } from './sector';
import { Swarm } from './pursuer';
import type { SectorDef } from './types';
import type { AABB } from '@/player/controller';

/**
 * A door standing in the Plaza, waiting to be a world.
 *
 * Built once, at boot, for every sector the save says might be reachable. It
 * is deliberately quiet: a slab of light with an identifier. It does not say
 * what is behind it, because the brief's whole point is that files are doors —
 * you find out by opening them.
 */
export class SectorPortal {
  readonly group = new THREE.Group();
  readonly interactables: Array<{
    id: string;
    position: THREE.Vector3;
    radius: number;
    label: string;
    kind: 'door';
    activate: () => void;
  }> = [];

  readonly colliders: AABB[] = [];

  private readonly def: SectorDef;
  private readonly frameMat: THREE.MeshBasicMaterial;
  private readonly labelMat: THREE.MeshBasicMaterial;
  private readonly slab: THREE.Mesh;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private glow = 0;

  constructor(def: SectorDef, index: number, position: THREE.Vector3) {
    this.def = def;

    this.group.position.copy(position);

    /* --- the frame: two uprights and a lintel, so it reads as a doorway --- */
    const H = 5.2;
    const W = 3.4;
    const T = 0.34;

    for (const sx of [-1, 1]) {
      const g = new THREE.BoxGeometry(T, H, T * 1.4);
      const m = createGlowMaterial(PALETTE.cyanDim, 0.5);
      const post = new THREE.Mesh(g, m);
      post.position.set(sx * (W / 2), H / 2, 0);
      this.group.add(post);
      this.disposables.push(g, m);
      this.colliders.push({
        min: new THREE.Vector3(position.x + sx * (W / 2) - T, 0, position.z - T),
        max: new THREE.Vector3(position.x + sx * (W / 2) + T, H, position.z + T),
      });
    }

    const lg = new THREE.BoxGeometry(W + T * 2, T, T * 1.4);
    const lm = createGlowMaterial(PALETTE.cyanDim, 0.5);
    const lintel = new THREE.Mesh(lg, lm);
    lintel.position.set(0, H, 0);
    this.group.add(lintel);
    this.disposables.push(lg, lm);

    /* --- the slab: what you see through it, before you go --- */
    const sg = new THREE.PlaneGeometry(W, H - 0.4);
    // Each portal shows its sector's own colour. This is the only preview the
    // player gets, and it is not a label.
    this.frameMat = createGlowMaterial(def.tone === 'security' ? PALETTE.amber : PALETTE.cyan, 0.14);
    this.slab = new THREE.Mesh(sg, this.frameMat);
    this.slab.position.set(0, (H - 0.4) / 2, 0);
    this.group.add(this.slab);
    this.disposables.push(sg, this.frameMat);

    const eg = new THREE.EdgesGeometry(sg);
    const em = createEdgeMaterial(PALETTE.ice, 0.55);
    const outline = new THREE.LineSegments(eg, em);
    outline.position.copy(this.slab.position);
    this.group.add(outline);
    this.disposables.push(eg, em);

    /* --- the identifier: the node name, in the world's own typography --- */
    const tg = new THREE.PlaneGeometry(2.6, 0.42);
    this.labelMat = createGlowMaterial(PALETTE.ice, 0.5);
    const label = new THREE.Mesh(tg, this.labelMat);
    label.position.set(0, H + 0.5, 0);
    this.group.add(label);
    this.disposables.push(tg, this.labelMat);

    /* --- an approach line, so it is visible from distance --- */
    const lg2 = new THREE.PlaneGeometry(0.5, 14);
    const lm2 = createGlowMaterial(PALETTE.cyanDim, 0.28);
    const lead = new THREE.Mesh(lg2, lm2);
    lead.rotation.x = -Math.PI / 2;
    lead.position.set(0, 0.03, -7);
    this.group.add(lead);
    this.disposables.push(lg2, lm2);

    // Portals fan out from the spawn so none hides behind another.
    this.group.rotation.y = Math.PI + index * 0.42;

    this.interactables.push({
      id: `portal-${def.id}`,
      position: new THREE.Vector3(position.x, 1.6, position.z),
      radius: 3.0,
      label: def.id === 'archive' ? 'ARCHIVE_07' : def.id.toUpperCase(),
      kind: 'door',
      activate: () => {
        this.pendingOpen = true;
      },
    });
  }

  /** Set by the interactable; main.ts drains this each frame. */
  pendingOpen = false;

  update(dt: number, elapsed: number, playerPos: THREE.Vector3): void {
    // Closer = brighter. The player is rewarded for approaching on foot rather
    // than being handed a map marker.
    const d = this.group.position.distanceTo(playerPos);
    const near = Math.max(0, 1 - d / 55);
    this.glow += (near - this.glow) * Math.min(dt * 3, 1);

    const pulse = 0.5 + Math.sin(elapsed * 0.9 + this.def.half) * 0.5;
    this.frameMat.opacity = 0.06 + this.glow * (0.16 + pulse * 0.1);
    this.labelMat.opacity = 0.25 + this.glow * 0.6;
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
   Sector session
   -------------------------------------------------------------------------- */

/**
 * A sector the player is currently inside, plus the way back.
 *
 * Held rather than created per-visit so the transition code in main.ts has a
 * single object to ask "where do I send them when they leave".
 */
export interface SectorSession {
  def: SectorDef;
  sector: Sector;
  swarm: Swarm | null;
  /** Where the player was standing in the Plaza, so we can put them back. */
  returnTo: THREE.Vector3;
  returnYaw: number;
}

export function buildSession(id: string, seed: number, returnTo: THREE.Vector3, returnYaw: number): SectorSession | null {
  const def = sectorDef(id);
  if (!def) return null;

  const sector = new Sector(def, seed);
  const swarm = def.hostile && def.pursuers > 0 ? new Swarm(def.pursuers, def.half, seed ^ 0x5eed) : null;

  if (swarm) sector.scene.add(swarm.group);

  return { def, sector, swarm, returnTo: returnTo.clone(), returnYaw };
}

export function disposeSession(session: SectorSession | null): void {
  if (!session) return;
  session.swarm?.dispose();
  session.sector.dispose();
}

/** Random but reproducible offset, so two visits to a sector differ a little. */
export function visitSeed(base: number, visit: number): number {
  return (base ^ (visit * 0x9e3779b1)) >>> 0;
}

export { Rng };