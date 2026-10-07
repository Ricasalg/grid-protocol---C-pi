/* ============================================================================
   The Arcade: the one building the player walks toward.

   The brief asks for a façade that is recognisable from ~60m (neon sign, lit
   entrance, music leaking out) and for one machine inside that stands out — the
   Light Cycle. Everything else here is furniture: it exists to make the Light
   Cycle's isolation read as deliberate rather than arbitrary.

   All of it is procedural. No models, no textures, nothing loaded.

   Layout, in local coordinates (the building is placed and rotated by `place`):

     z = -14  front wall, with the entrance gap at x = 0
     z =  14  back wall
     x = -16 / +16  side walls
     y = 0 ground, y = 7 interior ceiling

   The Light Cycle sits on a raised plinth at the back-centre, facing the
   entrance, so the player walks past the ordinary machines to reach it.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE, quality } from '@/core/config';
import { Rng } from '@/core/rng';
import {
  createEdgeMaterial,
  createGlowMaterial,
  createStructureMaterial,
} from '@/render/materials';
import { ARCADE_DISTANCE } from '@/grid/world';
import type { AABB } from '@/player/controller';

/** Building footprint, in metres. */
const HALF_W = 16;
const HALF_D = 14;
const WALL_H = 7;

/** Where the Light Cycle machine stands, and where the player must stand. */
export const CYCLE_MACHINE_POS = new THREE.Vector3(0, 0, -9.5);
export const CYCLE_STAND_POS = new THREE.Vector3(0, 0, -6.2);

/** The unremarkable door behind the last machine. Finding it is the point. */
export const BACKDOOR_POS = new THREE.Vector3(11.5, 0, 13.4);

export interface ArcadeMachine {
  position: THREE.Vector3;
  /** Which machine this is; the Light Cycle is the only one that starts a game. */
  kind: 'arcade-machine' | 'light-cycle';
  label: string;
}

export class ArcadeBuilding {
  readonly group = new THREE.Group();
  readonly colliders: AABB[] = [];
  readonly machines: ArcadeMachine[] = [];

  /** The Light Cycle's housing, so the power-up can animate it. */
  private cycleHousing: THREE.Group | null = null;
  private cycleGlowMat: THREE.MeshBasicMaterial | null = null;
  private cycleRingMat: THREE.MeshBasicMaterial | null = null;
  private cycleRing: THREE.Mesh | null = null;

  /** Neon sign face, brightened when the player is near enough to read it. */
  private signMat: THREE.MeshBasicMaterial | null = null;

  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly rng = new Rng(0x5eed17);

  constructor() {
    this.buildShell();
    this.buildSign();
    this.buildInterior(this.rng);
    this.buildLightCycle();
    this.buildBackdoor();
  }

  /* ---------------------------------------------------------------------
     Shell
     --------------------------------------------------------------------- */

  private buildShell(): void {
    const wallMat = createStructureMaterial(PALETTE.cyanDim, {
      emissiveEdges: 0.55,
      windowDensity: 3.4,
      scanSpeed: 0.2,
    });

    const add = (
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
    ) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(x, y, z);
      this.group.add(mesh);
      this.colliders.push({
        min: new THREE.Vector3(x - w / 2, 0, z - d / 2),
        max: new THREE.Vector3(x + w / 2, h, z + d / 2),
      });
      this.disposables.push(geo);
      return mesh;
    };

    // Side and back walls, solid.
    add(0.6, WALL_H, HALF_D * 2, -HALF_W, WALL_H / 2, 0);
    add(0.6, WALL_H, HALF_D * 2, HALF_W, WALL_H / 2, 0);
    add(HALF_W * 2, WALL_H, 0.6, 0, WALL_H / 2, HALF_D);

    // Front wall in two pieces, leaving a 6m gap for the entrance. The player
    // must walk in through the opening; there is no door to open.
    const frontW = (HALF_W * 2 - 6) / 2;
    add(frontW, WALL_H, 0.6, -(3 + frontW / 2), WALL_H / 2, -HALF_D);
    add(frontW, WALL_H, 0.6, 3 + frontW / 2, WALL_H / 2, -HALF_D);

    // Lintel over the entrance.
    const lintelGeo = new THREE.BoxGeometry(6.4, 1.6, 0.6);
    const lintel = new THREE.Mesh(lintelGeo, wallMat);
    lintel.position.set(0, WALL_H - 0.8, -HALF_D);
    this.group.add(lintel);
    this.disposables.push(lintelGeo);

    // Ceiling slab, so the interior is enclosed and the interior lights read.
    const ceilGeo = new THREE.BoxGeometry(HALF_W * 2, 0.4, HALF_D * 2);
    const ceil = new THREE.Mesh(ceilGeo, wallMat);
    ceil.position.y = WALL_H;
    this.group.add(ceil);
    this.disposables.push(ceilGeo);

    // The floor inside is a little brighter than the esplanade, which is what
    // makes the doorway glow from a distance.
    const floorGeo = new THREE.PlaneGeometry(HALF_W * 2, HALF_D * 2);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = createGlowMaterial(PALETTE.cyanDim, 0.09);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = 0.02;
    this.group.add(floor);
    this.disposables.push(floorGeo, floorMat);

    this.disposables.push(wallMat);
  }

  /* ---------------------------------------------------------------------
     Façade
     --------------------------------------------------------------------- */

  private buildSign(): void {
    // A vertical blade sign on the front wall, read from far down the path.
    // This is the single strongest "that is a building with a purpose" cue, and
    // it is why the building is identifiable at 60m from its silhouette alone.

    const mastGeo = new THREE.BoxGeometry(0.35, 9, 0.35);
    const mastMat = createGlowMaterial(PALETTE.cyanDim, 0.5);
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(-10, 11, -HALF_D - 0.4);
    this.group.add(mast);
    this.disposables.push(mastGeo, mastMat);

    // Sign face: an outlined slab. The lettering is drawn into the emissive
    // material's density so it needs no texture — see the shader's uLabel term.
    const faceGeo = new THREE.BoxGeometry(3.6, 8.4, 0.25);
    this.signMat = createGlowMaterial(PALETTE.cyan, 0.55);
    const face = new THREE.Mesh(faceGeo, this.signMat);
    face.position.set(-10, 16.4, -HALF_D - 0.4);
    this.group.add(face);
    this.disposables.push(faceGeo, this.signMat);

    const edgeGeo = new THREE.EdgesGeometry(faceGeo);
    const edgeMat = createEdgeMaterial(PALETTE.ice, 0.85);
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.position.copy(face.position);
    this.group.add(edges);
    this.disposables.push(edgeGeo, edgeMat);

    // Entrance surround: a lit frame around the gap, pulsing slowly.
    const frameMat = createGlowMaterial(PALETTE.ice, 0.7);
    for (const [w, h, x, y] of [
      [0.3, 5.4, -3.1, 2.7],
      [0.3, 5.4, 3.1, 2.7],
      [6.5, 0.3, 0, 5.4],
    ] as const) {
      const g = new THREE.BoxGeometry(w, h, 0.4);
      const bar = new THREE.Mesh(g, frameMat);
      bar.position.set(x, y, -HALF_D - 0.1);
      this.group.add(bar);
      this.disposables.push(g);
    }
    this.disposables.push(frameMat);
  }

  /* ---------------------------------------------------------------------
     Interior
     --------------------------------------------------------------------- */

  private buildInterior(rng: Rng): void {
    const count = quality.profile.arcadeMachines;
    const cabinetGeo = new THREE.BoxGeometry(1.1, 1.9, 0.9);
    const screenGeo = new THREE.PlaneGeometry(0.86, 0.72);
    const cabinetMat = createStructureMaterial(PALETTE.cyanDim, { emissiveEdges: 0.9 });

    // Cabinets line both side walls in rows, facing the corridor, leaving the
    // centre clear so the Light Cycle at the back stays visible on approach.
    const rows = Math.floor(count / 2);
    for (let i = 0; i < rows; i++) {
      for (const side of [-1, 1]) {
        const z = -10 + i * 3.4;
        if (z > 8) continue;

        const g = cabinetGeo.clone();
        const cab = new THREE.Mesh(g, cabinetMat);
        cab.position.set(side * 12.6, 0.95, z);
        // Rotate to face the corridor.
        cab.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
        this.group.add(cab);

        // The lit screen, angled back like a real cabinet's.
        const sg = screenGeo.clone();
        const sm = createGlowMaterial(
          rng.chance(0.18) ? PALETTE.amber : PALETTE.cyan,
          rng.range(0.35, 0.7),
        );
        const screen = new THREE.Mesh(sg, sm);
        screen.position.set(side * 12.05, 1.45, z);
        screen.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
        screen.rotation.x = -0.28;
        this.group.add(screen);

        const eg = new THREE.EdgesGeometry(g);
        const em = createEdgeMaterial(PALETTE.ice, 0.32);
        const edges = new THREE.LineSegments(eg, em);
        edges.position.copy(cab.position);
        edges.rotation.copy(cab.rotation);
        this.group.add(edges);

        this.colliders.push({
          min: new THREE.Vector3(side * 12.6 - 0.7, 0, z - 0.7),
          max: new THREE.Vector3(side * 12.6 + 0.7, 1.9, z + 0.7),
        });

        this.machines.push({
          position: new THREE.Vector3(side * 12.6, 0, z),
          kind: 'arcade-machine',
          label: 'TERMINAL',
        });

        this.disposables.push(g, sg, sm, eg, em);
      }
    }

    this.disposables.push(cabinetGeo, screenGeo, cabinetMat);
  }

  /* ---------------------------------------------------------------------
     The Light Cycle
     --------------------------------------------------------------------- */

  private buildLightCycle(): void {
    const housing = new THREE.Group();
    housing.position.copy(CYCLE_MACHINE_POS);

    // Plinth: three steps up to the machine. Its height is why the machine
    // reads as important from across the room.
    const plinthMat = createStructureMaterial(PALETTE.cyan, {
      emissiveEdges: 1.2,
      scanSpeed: 0.9,
    });
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BoxGeometry(9 - i * 1.6, 0.22, 5 - i * 0.8);
      const step = new THREE.Mesh(g, plinthMat);
      step.position.set(0, 0.11 + i * 0.22, 0);
      housing.add(step);
      this.disposables.push(g);
    }

    // The cycle itself: a low, wide body with a long fairing and a light bar
    // along the top — the silhouette of a light cycle, at rest.
    const bodyGeo = new THREE.BoxGeometry(2.1, 0.7, 4.4);
    const bodyMat = createStructureMaterial(PALETTE.ice, { emissiveEdges: 1.6 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.1;
    housing.add(body);

    const fairGeo = new THREE.BoxGeometry(0.9, 0.55, 2.2);
    const fairing = new THREE.Mesh(fairGeo, bodyMat);
    fairing.position.set(0, 1.66, -0.5);
    housing.add(fairing);

    const barGeo = new THREE.BoxGeometry(0.34, 0.1, 4.6);
    this.cycleGlowMat = createGlowMaterial(PALETTE.cyan, 0.35);
    const bar = new THREE.Mesh(barGeo, this.cycleGlowMat);
    bar.position.set(0, 1.96, 0);
    housing.add(bar);

    // Front light bar, angled down like a headlamp.
    const lampGeo = new THREE.BoxGeometry(0.9, 0.12, 0.14);
    const lamp = new THREE.Mesh(lampGeo, this.cycleGlowMat);
    lamp.position.set(0, 1.2, -2.24);
    housing.add(lamp);

    // Rear wheel glow: a torus standing in the vertical plane.
    const wheelGeo = new THREE.TorusGeometry(0.72, 0.09, 8, 32);
    const wheelMat = createGlowMaterial(PALETTE.cyanDim, 0.6);
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(0, 0.98, 1.9);
    housing.add(wheel);

    // A halo ring flat on the plinth, dark until the machine is powered up.
    const ringGeo = new THREE.RingGeometry(2.6, 3.4, 64);
    ringGeo.rotateX(-Math.PI / 2);
    this.cycleRingMat = createGlowMaterial(PALETTE.cyan, 0);
    this.cycleRing = new THREE.Mesh(ringGeo, this.cycleRingMat);
    this.cycleRing.position.y = 0.7;
    housing.add(this.cycleRing);

    this.group.add(housing);
    this.cycleHousing = housing;

    this.colliders.push({
      min: new THREE.Vector3(-4.6, 0, -12.2),
      max: new THREE.Vector3(4.6, 2.1, -7.2),
    });

    this.machines.push({
      position: new THREE.Vector3(CYCLE_MACHINE_POS.x, 0, CYCLE_MACHINE_POS.z),
      kind: 'light-cycle',
      label: 'LIGHT CYCLE',
    });

    this.disposables.push(
      bodyGeo, fairGeo, barGeo, lampGeo, wheelGeo, wheelMat, ringGeo, bodyMat, plinthMat,
    );
  }

  /* ---------------------------------------------------------------------
     The unremarkable door
     --------------------------------------------------------------------- */

  private buildBackdoor(): void {
    // Deliberately dull. No neon, no rim light, no sound. A player who has been
    // looking for something will pass it several times; a player who has not
    // will walk straight past. That is the design.
    const frameGeo = new THREE.BoxGeometry(1.9, 3.2, 0.3);
    const frameMat = createStructureMaterial(PALETTE.cyanDim, { emissiveEdges: 0.18 });
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.position.copy(BACKDOOR_POS);
    this.group.add(frame);

    // A single dim strip above it — enough to be interactable, not enough to
    // be interesting.
    const stripGeo = new THREE.BoxGeometry(1.5, 0.08, 0.1);
    const stripMat = createGlowMaterial(PALETTE.cyanDim, 0.22);
    const strip = new THREE.Mesh(stripGeo, stripMat);
    strip.position.set(BACKDOOR_POS.x, 3.45, BACKDOOR_POS.z - 0.2);
    this.group.add(strip);

    this.disposables.push(frameGeo, frameMat, stripGeo, stripMat);
  }

  /* ---------------------------------------------------------------------
     Placement
     --------------------------------------------------------------------- */

  /**
   * Put the building at the end of the light path, entrance facing the player.
   *
   * The colliders move with it. They are written in local space as the shell is
   * built, but the collision code has no scene graph to walk — it only ever sees
   * bare AABBs in world space. Moving the group without translating the boxes
   * leaves the physics standing where the building was drawn, and an invisible
   * wall appears at the origin: the player walks off the arrival platform and
   * stops in open air with nothing to show for it. Face -Z, toward the platform;
   * no rotation, so the entrance gap is already on the -Z side.
   */
  place(): void {
    this.group.position.set(0, 0, ARCADE_DISTANCE + HALF_D + 6);

    for (const box of this.colliders) {
      box.min.z += this.group.position.z;
      box.max.z += this.group.position.z;
    }
  }

  /* ---------------------------------------------------------------------
     Per-frame
     --------------------------------------------------------------------- */

  update(_dt: number, elapsed: number, playerPos: THREE.Vector3): void {
    // The Light Cycle's halo breathes slowly and brightens as the player closes
    // in. This is the only advance "invitation" the machine gives.
    if (this.cycleRingMat && this.cycleRing) {
      const d = playerPos.distanceTo(
        new THREE.Vector3(CYCLE_MACHINE_POS.x + this.group.position.x, 0, CYCLE_MACHINE_POS.z + this.group.position.z),
      );
      const proximity = 1 - Math.min(1, Math.max(0, (d - 6) / 34));
      const idle = 0.06 + proximity * 0.16;
      this.cycleRingMat.opacity = idle * (0.7 + Math.sin(elapsed * 1.6) * 0.3);
      this.cycleRing.scale.setScalar(1 + Math.sin(elapsed * 1.6) * 0.02);
    }

    if (this.cycleGlowMat) {
      // Base glow of the parked machine: a slow cycle, not a pulse.
      this.cycleGlowMat.opacity = 0.3 + Math.sin(elapsed * 0.9) * 0.08;
    }

    if (this.signMat) {
      // The sign is brighter the closer the player is; from 100m it is a
      // sliver, from 60m it reads as text.
      const d = playerPos.distanceTo(
        new THREE.Vector3(this.group.position.x, 0, this.group.position.z),
      );
      const near = 1 - Math.min(1, Math.max(0, (d - 20) / 120));
      this.signMat.opacity = 0.35 + near * 0.45 + Math.sin(elapsed * 2.2) * 0.04;
    }
  }

  /** Raise the machine's glow as it powers up. 0 = parked, 1 = fully lit. */
  setCyclePower(amount: number): void {
    if (this.cycleGlowMat) this.cycleGlowMat.opacity = 0.3 + amount * 0.7;
    if (this.cycleRingMat) this.cycleRingMat.opacity = amount * 0.9;
    if (this.cycleHousing) this.cycleHousing.position.y = amount * 0.12;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }
}