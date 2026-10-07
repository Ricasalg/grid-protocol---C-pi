/* ============================================================================
   The Grid: the arrival area.

   Built entirely in code. Layout is authored for guidance without text:
     - arrival platform at the origin (radius 8m), the only lit ground
     - a light path leading away from it toward the Arcade
     - a single very tall landmark on the horizon, visible from everywhere,
       acting as a visual "north" and the future narrative destination
     - mid-ground monoliths and arches to break the emptiness and give the
       player parallax while walking
     - data walls enclosing the space, so the boundary is legible as a system
       barrier rather than an invisible wall

   Coordinates: +Z is "into the map", toward the Arcade. The light path runs
   along +Z from the origin. Sector distance constants live here so the map,
   the descent camera and the world builder cannot drift apart.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE, quality } from '@/core/config';
import { Rng, volatileRng } from '@/core/rng';
import type { AABB } from '@/player/controller';
import {
  createDataWallMaterial,
  createEdgeMaterial,
  createFloorMaterial,
  createGlowMaterial,
  createLightPathMaterial,
  createParticleMaterial,
  createSkylineMaterial,
  createSkyMaterial,
  createStructureMaterial,
} from '@/render/materials';

/** Distance from the platform to the Arcade entrance. */
export const ARCADE_DISTANCE = 150;

/** Distance from the platform to the landmark tower at the far horizon. */
export const LANDMARK_DISTANCE = 620;

/** Half-extent of the playable square. */
export const WORLD_HALF = 210;

/** Radius of the arrival platform. */
export const PLATFORM_RADIUS = 8;

export interface GridInteractable {
  id: string;
  position: THREE.Vector3;
  /** Metres. */
  radius: number;
  label: string;
  kind: 'terminal' | 'arcade-machine' | 'door' | 'marker';
  /** Fires once per interaction press. */
  activate: () => void;
}

export class GridWorld {
  /**
   * A real Scene rather than a Group: the descent hands this to
   * `Renderer.setScene`, and RenderPass is typed against Scene. It also means
   * this world owns its own fog, so it keeps its atmosphere when the tunnel
   * scene is swapped out and back.
   */
  readonly group = new THREE.Scene();
  readonly interactables: GridInteractable[] = [];
  readonly colliders: AABB[] = [];

  /** Set by the descent; drives the landing ring and platform ignition. */
  private landingRing: THREE.Mesh | null = null;
  private landingAge = 99;
  private landingActive = false;

  private dust: THREE.Points | null = null;
  private skyline: THREE.InstancedMesh | null = null;

  private readonly disposables: Array<{ dispose(): void }> = [];

  /** Footstep ripple state fed into the floor shader. */
  private footstep = new THREE.Vector4(0, 0, 0, 1);

  constructor(seed: number) {
    this.group.name = 'grid';
    this.group.background = new THREE.Color(PALETTE.black);
    this.group.fog = new THREE.FogExp2(PALETTE.black, 0.0125);

    const rng = new Rng(seed);

    this.buildSky();
    this.buildFloor();
    this.buildPlatform();
    this.buildLightPath();
    this.buildSkyline(rng);
    this.buildLandmark(rng);
    this.buildMidground(rng);
    this.buildDataWalls();
    this.buildDust();
  }

  /* ---------------------------------------------------------------------
     Sky
     --------------------------------------------------------------------- */

  private buildSky(): void {
    // Large sphere, inward-facing. Radius exceeds the far plane's useful range
    // so it never clips; depthWrite off means it always sits behind.
    const geo = new THREE.SphereGeometry(1800, 32, 24);
    const mat = createSkyMaterial([PALETTE.cyan, PALETTE.violet]);
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    this.group.add(sky);
    this.disposables.push(geo, mat);
  }

  /* ---------------------------------------------------------------------
     Floor
     --------------------------------------------------------------------- */

  private buildFloor(): void {
    const geo = new THREE.PlaneGeometry(WORLD_HALF * 2.6, WORLD_HALF * 2.6, 1, 1);
    geo.rotateX(-Math.PI / 2);

    const mat = createFloorMaterial({ scale: 4.0 });
    const floor = new THREE.Mesh(geo, mat);
    floor.name = 'floor';
    this.group.add(floor);
    this.disposables.push(geo, mat);

    // Cache the material for the per-frame footstep update.
    this.floorMat = mat;
  }

  private floorMat: THREE.ShaderMaterial | null = null;

  /* ---------------------------------------------------------------------
     Arrival platform
     --------------------------------------------------------------------- */

  private buildPlatform(): void {
    // The platform: a low cylinder with a bright rim, plus concentric rings.
    // It is the one place on the map that is unambiguously solid, which is how
    // the player learns that surfaces matter.
    const geo = new THREE.CylinderGeometry(PLATFORM_RADIUS, PLATFORM_RADIUS + 0.4, 0.28, 64);
    const mat = createStructureMaterial(PALETTE.cyan, { emissiveEdges: 1.4, scanSpeed: 0.8 });
    const platform = new THREE.Mesh(geo, mat);
    platform.position.y = 0.14;
    platform.name = 'platform';
    this.group.add(platform);
    this.disposables.push(geo, mat);

    // Emissive rim: the bright circle visible from the descent.
    const rimGeo = new THREE.TorusGeometry(PLATFORM_RADIUS, 0.06, 8, 96);
    rimGeo.rotateX(Math.PI / 2);
    const rimMat = createGlowMaterial(PALETTE.cyan, 0.9);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = 0.3;
    this.group.add(rim);
    this.disposables.push(rimGeo, rimMat);

    // Concentric guide rings on the platform surface.
    for (let i = 1; i <= 4; i++) {
      const r = (PLATFORM_RADIUS / 5) * i;
      const ringGeo = new THREE.TorusGeometry(r, 0.018, 6, 72);
      ringGeo.rotateX(Math.PI / 2);
      const ringMat = createGlowMaterial(PALETTE.cyan, 0.32 - i * 0.05);
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.y = 0.3;
      this.group.add(ring);
      this.disposables.push(ringGeo, ringMat);
    }

    // The landing ring that expands on arrival.
    const lrGeo = new THREE.RingGeometry(0.6, 1.0, 64);
    lrGeo.rotateX(-Math.PI / 2);
    const lrMat = createGlowMaterial(PALETTE.ice, 0);
    this.landingRing = new THREE.Mesh(lrGeo, lrMat);
    this.landingRing.position.y = 0.36;
    this.landingRing.visible = false;
    this.group.add(this.landingRing);
    this.disposables.push(lrGeo, lrMat);

    // Nothing on the platform should block the player.
  }

  /* ---------------------------------------------------------------------
     The light path
     --------------------------------------------------------------------- */

  private buildLightPath(): void {
    // A wide, flat strip running from the platform toward the Arcade. The
    // material's shader carries the travelling pulses, so geometry is a plane.
    const length = ARCADE_DISTANCE + 60;
    const geo = new THREE.PlaneGeometry(9, length, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // Shift so the strip starts at the platform edge and runs to the Arcade.
    geo.translate(0, 0, length / 2 + PLATFORM_RADIUS * 0.5);

    const mat = createLightPathMaterial(PALETTE.cyan);
    const path = new THREE.Mesh(geo, mat);
    path.position.y = 0.06;
    path.name = 'light-path';
    this.group.add(path);
    this.disposables.push(geo, mat);
  }

  /* ---------------------------------------------------------------------
     Distant skyline
     --------------------------------------------------------------------- */

  private buildSkyline(rng: Rng): void {
    const count = 900;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = createSkylineMaterial(PALETTE.cyan);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.name = 'skyline';

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();

    for (let i = 0; i < count; i++) {
      // Ring the city around the player at 220..900m. Angular distribution is
      // uniform, radius weighted outward so the near edge isn't a hard line.
      const angle = rng.range(0, Math.PI * 2);
      const radius = 220 + Math.pow(rng.next(), 0.6) * 680;

      const w = rng.range(14, 46);
      const d = rng.range(14, 46);
      // Exponential height distribution: a few towers dominate, most are low.
      const h = rng.range(18, 60) + Math.pow(rng.next(), 3.2) * 190;

      pos.set(Math.cos(angle) * radius, h / 2, Math.sin(angle) * radius);
      scale.set(w, h, d);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI));

      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);
    }

    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.skyline = mesh;
    this.disposables.push(geo, mat);
  }

  /* ---------------------------------------------------------------------
     The landmark
     --------------------------------------------------------------------- */

  private buildLandmark(rng: Rng): void {
    // One structure far taller and brighter than anything else, placed to be
    // visible from anywhere in the sector. It is the map's only fixed point.
    const h = 340;
    const geo = new THREE.CylinderGeometry(9, 26, h, 6, 1, true);
    const mat = createStructureMaterial(PALETTE.ice, {
      emissiveEdges: 1.8,
      scanSpeed: 0.12,
      windowDensity: 2.2,
    });
    const tower = new THREE.Mesh(geo, mat);
    tower.position.set(-70, h / 2, LANDMARK_DISTANCE);
    tower.name = 'landmark';
    this.group.add(tower);
    this.disposables.push(geo, mat);

    // A bright vertical spine so it reads as a beacon, not just a tall box.
    const spineGeo = new THREE.CylinderGeometry(0.5, 0.5, h * 0.9, 6);
    spineGeo.translate(0, 0, -18);
    const spineMat = createGlowMaterial(PALETTE.ice, 0.5);
    const spine = new THREE.Mesh(spineGeo, spineMat);
    spine.position.copy(tower.position);
    this.group.add(spine);
    this.disposables.push(spineGeo, spineMat);

    // Slowly rotating halo near the top: the beacon sweeping the sector.
    const haloGeo = new THREE.TorusGeometry(34, 0.5, 6, 64);
    haloGeo.rotateX(Math.PI / 2);
    const haloMat = createGlowMaterial(PALETTE.ice, 0.34);
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.position.set(tower.position.x, h * 0.82, tower.position.z);
    halo.name = 'landmark-halo';
    this.group.add(halo);
    this.disposables.push(haloGeo, haloMat);
    this.halo = halo;

    // A few surrounding lesser spires so the landmark belongs to a district.
    for (let i = 0; i < 7; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const r = rng.range(50, 190);
      const sh = rng.range(60, 180);

      const g = new THREE.BoxGeometry(rng.range(8, 20), sh, rng.range(8, 20));
      const m = createStructureMaterial(PALETTE.cyanDim, { emissiveEdges: 0.7 });
      const s = new THREE.Mesh(g, m);
      s.position.set(
        tower.position.x + Math.cos(angle) * r,
        sh / 2,
        tower.position.z + Math.sin(angle) * r,
      );
      this.group.add(s);
      this.disposables.push(g, m);
    }
  }

  private halo: THREE.Mesh | null = null;

  /* ---------------------------------------------------------------------
     Midground structures
     --------------------------------------------------------------------- */

  private buildMidground(rng: Rng): void {
    // Monoliths, arches and pylons flanking the light path. Placed to frame
    // the walk rather than block it: everything stays clear of the corridor.
    const corridorHalfWidth = 7;

    for (let i = 0; i < 46; i++) {
      const side = rng.chance(0.5) ? -1 : 1;
      const z = rng.range(18, ARCADE_DISTANCE + 40);
      const x = side * (corridorHalfWidth + Math.pow(rng.next(), 0.7) * 120);

      const kind = rng.next();

      if (kind < 0.45) {
        // Monolith: tall thin slab, outlined.
        const h = rng.range(6, 26);
        const w = rng.range(1.4, 4);
        const d = rng.range(1.4, 4);
        const g = new THREE.BoxGeometry(w, h, d);
        const m = createStructureMaterial(PALETTE.cyan, { emissiveEdges: 1.1 });
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(x, h / 2, z);
        mesh.rotation.y = rng.range(0, Math.PI);
        this.group.add(mesh);
        this.disposables.push(g, m);

        const eg = new THREE.EdgesGeometry(g);
        const em = createEdgeMaterial(PALETTE.ice, 0.5);
        const edges = new THREE.LineSegments(eg, em);
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        this.group.add(edges);
        this.disposables.push(eg, em);

        this.colliders.push({
          min: new THREE.Vector3(x - w / 2, 0, z - d / 2),
          max: new THREE.Vector3(x + w / 2, h, z + d / 2),
        });
      } else if (kind < 0.78) {
        // Pylon: a stack of thin rings on a mast.
        const h = rng.range(4, 12);
        const g = new THREE.CylinderGeometry(0.22, 0.34, h, 6);
        const m = createGlowMaterial(PALETTE.cyan, 0.55);
        const mesh = new THREE.Mesh(g, m);
        mesh.position.set(x, h / 2, z);
        this.group.add(mesh);
        this.disposables.push(g, m);

        for (let r = 0; r < 3; r++) {
          const rg = new THREE.TorusGeometry(0.9, 0.05, 5, 20);
          rg.rotateX(Math.PI / 2);
          const rm = createGlowMaterial(PALETTE.ice, 0.45);
          const ring = new THREE.Mesh(rg, rm);
          ring.position.set(x, 1.6 + r * (h / 4), z);
          this.group.add(ring);
          this.disposables.push(rg, rm);
        }

        this.colliders.push({
          min: new THREE.Vector3(x - 0.5, 0, z - 0.5),
          max: new THREE.Vector3(x + 0.5, h, z + 0.5),
        });
      } else {
        // Arch: two legs and a lintel, framing a view.
        const span = rng.range(7, 16);
        const h = rng.range(7, 16);
        const thick = 0.5;

        const legGeo = new THREE.BoxGeometry(thick, h, thick);
        const legMat = createGlowMaterial(PALETTE.cyanDim, 0.7);
        for (const s of [-1, 1]) {
          const leg = new THREE.Mesh(legGeo, legMat);
          leg.position.set(x + s * span / 2, h / 2, z);
          this.group.add(leg);
          this.disposables.push(legGeo);
        }

        const topGeo = new THREE.BoxGeometry(span + thick, thick, thick);
        const top = new THREE.Mesh(topGeo, legMat);
        top.position.set(x, h, z);
        this.group.add(top);
        this.disposables.push(topGeo);

        this.colliders.push({
          min: new THREE.Vector3(x - span / 2 - 1, 0, z - 1),
          max: new THREE.Vector3(x - span / 2 + 1, h, z + 1),
        });
      }
    }

    // Floating platforms far off the path: scale cues and future destinations.
    for (let i = 0; i < 14; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const r = rng.range(90, 190);
      const y = rng.range(14, 46);

      const g = new THREE.BoxGeometry(rng.range(10, 26), 0.8, rng.range(10, 26));
      const m = createGlowMaterial(PALETTE.cyanDim, 0.34);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
      this.group.add(mesh);
      this.disposables.push(g, m);
    }
  }

  /* ---------------------------------------------------------------------
     Data walls (world boundary)
     --------------------------------------------------------------------- */

  private buildDataWalls(): void {
    // Four curtains enclosing the sector. The player can see them, walk up to
    // them and understand why they cannot pass, which an invisible wall cannot
    // achieve.
    const h = 90;
    const len = WORLD_HALF * 2;
    const mat = createDataWallMaterial(PALETTE.cyanDim);

    for (let i = 0; i < 4; i++) {
      const geo = new THREE.PlaneGeometry(len, h);
      const wall = new THREE.Mesh(geo, mat);
      wall.position.y = h / 2;

      const a = (i * Math.PI) / 2;
      wall.position.x = Math.sin(a) * WORLD_HALF;
      wall.position.z = Math.cos(a) * WORLD_HALF;
      wall.rotation.y = a;

      this.group.add(wall);
      this.disposables.push(geo);
    }
    this.disposables.push(mat);
  }

  /* ---------------------------------------------------------------------
     Particles
     --------------------------------------------------------------------- */

  private buildDust(): void {
    const count = quality.profile.groundDust;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const speeds = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // Spread across the walkable area, biased toward the path.
      const nearPath = volatileRng.chance(0.45);
      const x = nearPath
        ? volatileRng.range(-40, 40)
        : volatileRng.range(-WORLD_HALF * 0.8, WORLD_HALF * 0.8);
      const z = volatileRng.range(0, ARCADE_DISTANCE + 80);

      positions[i * 3] = x;
      positions[i * 3 + 1] = volatileRng.range(0, 90);
      positions[i * 3 + 2] = z;

      seeds[i] = volatileRng.next();
      speeds[i] = volatileRng.range(0.4, 2.6);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));

    const mat = createParticleMaterial(PALETTE.cyan, 1.0);
    this.dust = new THREE.Points(geo, mat);
    this.dust.frustumCulled = false;
    this.dust.name = 'dust';
    this.group.add(this.dust);
    this.disposables.push(geo, mat);
  }

  /* ---------------------------------------------------------------------
     Interactables
     --------------------------------------------------------------------- */

  addInteractable(i: GridInteractable): void {
    this.interactables.push(i);
  }

  /* ---------------------------------------------------------------------
     Per-frame
     --------------------------------------------------------------------- */

  /** Feed the footstep ripple into the floor shader. */
  onFootstep(position: THREE.Vector3): void {
    this.footstep.set(position.x, position.z, 0, 0);
  }

  /** Trigger the landing ring expansion once the descent completes. */
  playLanding(): void {
    this.landingActive = true;
    this.landingAge = 0;
    if (this.landingRing) this.landingRing.visible = true;
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3): void {
    // Footstep ripple ages out over ~1s.
    if (this.footstep.w < 1) {
      this.footstep.w = Math.min(1, this.footstep.w + dt);
      if (this.floorMat) {
        (this.floorMat.uniforms.uFootstep.value as THREE.Vector4).copy(this.footstep);
      }
    }

    // Landing ring: expands and fades over ~1.6s.
    if (this.landingActive && this.landingRing) {
      this.landingAge += dt;
      const t = Math.min(1, this.landingAge / 1.6);
      const scale = 1 + t * PLATFORM_RADIUS * 1.25;

      this.landingRing.scale.setScalar(scale);
      const mat = this.landingRing.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - t) * 0.85;

      if (t >= 1) {
        this.landingActive = false;
        this.landingRing.visible = false;
      }
    }

    // Beacon sweep on the landmark.
    if (this.halo) {
      this.halo.rotation.y = elapsed * 0.22;
      this.halo.position.y = 340 * 0.82 + Math.sin(elapsed * 0.3) * 4;
    }

    // Keep the particle field centred on the player so a finite buffer covers
    // the whole walkable area without needing a huge number of points.
    if (this.dust) {
      // Wrapping is done in the shader; here we only re-anchor the origin so
      // the drift never accumulates far from the camera.
      this.dust.position.x = 0;
      this.dust.position.z = 0;
      void playerPos;
    }
  }

  /** Rebuild instance counts after a quality change. */
  applyQuality(): void {
    // The skyline is the heaviest object; drop instances on the low tier rather
    // than rebuilding the whole world.
    if (this.skyline) {
      const full = 900;
      const visible =
        quality.tier === 'low' ? 340 : quality.tier === 'medium' ? 620 : full;
      this.skyline.count = Math.min(visible, full);
    }

    if (this.dust) {
      const geo = this.dust.geometry;
      const total = quality.profile.groundDust;
      geo.setDrawRange(0, Math.min(total, geo.getAttribute('position').count));
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }
}