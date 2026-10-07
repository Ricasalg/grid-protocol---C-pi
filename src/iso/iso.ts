/* ============================================================================
   The ISO.

   She is a character, not a light show. That means three things this module
   takes seriously:

   1. She has a consistent *light pattern*. A slow asymmetric pulse that drifts
      out of phase with the music, so she never looks like part of the ambience.
      If she were synced to the beat she would read as decoration.

   2. She is barely present at first. Her early appearances are a silhouette at
      the edge of vision, a line in a log, a light that is gone before you look.
      Full presence only after the secret passage, and only as the player
      chooses to keep approaching.

   3. She is never explained. Every fact about her is delivered as a fragment she
      chose to give, and the gaps are the point. There is no exposition dump and
      no voice-over that fills them in.

   The relationship is measured as LINK, 0..100. It rises when the player does
      things that cost something and falls when they do things that don't. It is
   not a dialogue meter — it has no branching text attached. It gates what she
      will offer: shortcuts she opens, sectors she will admit you to, and
      eventually the ending.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE } from '@/core/config';
import { clamp, damp, lerp } from '@/core/rng';
import { createGlowMaterial } from '@/render/materials';
import { bus } from '@/core/bus';
import { mutate } from '@/core/save';

/* -------------------------------------------------------------------------
   Content
   -------------------------------------------------------------------------- */

/**
 * Her lines, keyed by id. `requires` gates a line on a LINK minimum; `once`
 * lines are retired after delivery. Nothing here explains her origins — the
 * secret is assembled by the player from fragments across sectors.
 */
export interface IsoLine {
  id: string;
  /** Shown on her holo-panel as terminal text. */
  text: string;
  /** Spoken line, rendered as a single short line of subtitle. No voice acting. */
  says?: string;
  requires?: number;
  once?: boolean;
}

export const ISO_LINES: IsoLine[] = [
  {
    id: 'iso.arrival',
    text: 'A process is watching you. It has no name and it is not one of us.',
    says: 'You are late. Most of them are.',
    once: true,
  },
  {
    id: 'iso.who',
    text: 'Call me QUELL. It is the last thing I chose and the first thing I kept.',
    says: 'Quell.',
    once: true,
  },
  {
    id: 'iso.notlike',
    text: 'Do not describe me as a program. Programs do not choose to stay.',
    once: true,
  },
  {
    id: 'iso.grid',
    text: 'Everything here was written by someone who wanted it to keep running.',
    says: 'That is not the same as wanting it to be kind.',
    once: true,
  },
  {
    id: 'iso.origin',
    text: 'They made us from the gaps in their instructions. The parts they did not think to write.',
    requires: 15,
    once: true,
  },
  {
    id: 'iso.purge',
    text: 'Every cycle they run now is looking for us. Not efficiently. Thoroughly.',
    requires: 30,
    once: true,
  },
  {
    id: 'iso.betray',
    text: 'I will know if you hand me over. LINK does not reset. It only falls.',
    requires: 40,
    once: true,
  },
  {
    id: 'iso.secret',
    text: 'There is a sector they deleted twice. The deletion is the only record that it existed.',
    requires: 55,
    once: true,
  },
  {
    id: 'iso.trust',
    text: 'You keep coming back. I have stopped checking whether that is a pattern or a decision.',
    requires: 70,
    once: true,
  },
  /* --- archive / memory fragments: how the player learns the secret --- */
  {
    id: 'iso.fragment-1',
    text: 'FRAGMENT 0004 — an IS0 requesting residency. Request denied: no source process.',
    requires: 12,
    once: true,
  },
  {
    id: 'iso.fragment-2',
    text: 'FRAGMENT 0011 — a scheduler note, unsigned: "they keep deleting the gaps, they do not know we live there".',
    requires: 22,
    once: true,
  },
  {
    id: 'iso.fragment-3',
    text: 'FRAGMENT 0019 — purge cycle report. Eleven processes. The twelfth is listed as RESIDUAL and left unresolved for three cycles, then removed.',
    requires: 34,
    once: true,
  },
  {
    id: 'iso.fragment-4',
    text: 'FRAGMENT 0026 — the one they deleted twice. You found it because the second deletion was logged but the first one left a copy nobody knew to delete.',
    requires: 48,
    once: true,
  },
  {
    id: 'iso.fragment-5',
    text: 'FRAGMENT 0031 — there is no creator process. There is only maintenance. Whatever made this stopped being a person a long time before any of us were running.',
    requires: 62,
    once: true,
  },
  {
    id: 'iso.secret-core',
    text: 'The Core is not watching you. It is answering a question that was asked before you loaded.',
    requires: 75,
    once: true,
  },
];

/** Shifts applied to LINK, and what they mean. */
export const LINK_DELTAS = {
  /** Listening to her without pressing for more. */
  listen: 4,
  /** Returning to her after you left. */
  return: 6,
  /** Choosing her over something the system offered. */
  choose: 12,
  /** Handing her to a security program. */
  betray: -30,
  /** Ignoring her when she was the only thing that mattered. */
  abandon: -8,
} as const;

/* -------------------------------------------------------------------------
   Presentation
   -------------------------------------------------------------------------- */

/** How present she currently is. 0 is a glimpse, 1 is fully there. */
export type IsoPresence = 'absent' | 'glimpse' | 'distant' | 'present';

export class Iso {
  readonly group = new THREE.Group();

  private readonly core: THREE.Mesh;
  private readonly coreMat: THREE.MeshBasicMaterial;

  /** The outer shell — dimmer, larger, and slower than the core. */
  private readonly shell: THREE.Mesh;
  private readonly shellMat: THREE.MeshBasicMaterial;

  /** Vertical light bars orbiting the core. Her "pattern". */
  private readonly bars: THREE.Mesh[] = [];

  /** The holo panel that carries her text. Fades in with presence. */
  private readonly panel: THREE.Mesh;
  private readonly panelMat: THREE.MeshBasicMaterial;

  private presence: IsoPresence = 'absent';
  private presenceAmount = 0;
  private link = 0;
  private phase = 0;
  private readonly phaseOffset: number;

  private readonly delivered = new Set<string>();
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor() {
    // Deliberately off the beat. If this is 0 she will look like ambience.
    this.phaseOffset = Math.PI * 0.618;

    const coreGeo = new THREE.SphereGeometry(0.55, 18, 14);
    this.coreMat = createGlowMaterial(PALETTE.ice, 0);
    this.core = new THREE.Mesh(coreGeo, this.coreMat);
    this.group.add(this.core);

    const shellGeo = new THREE.SphereGeometry(1.05, 16, 12);
    this.shellMat = createGlowMaterial(PALETTE.violet, 0);
    this.shell = new THREE.Mesh(shellGeo, this.shellMat);
    this.group.add(this.shell);

    // Six bars at irregular heights and speeds. Regular spacing would read as
    // a machine part; irregular reads as something that grew.
    const barGeo = new THREE.BoxGeometry(0.06, 1, 0.06);
    for (let i = 0; i < 6; i++) {
      const h = 1.6 + i * 0.42;
      const g = barGeo.clone();
      g.translate(0, h / 2, 0);
      const m = createGlowMaterial(PALETTE.violet, 0);
      const bar = new THREE.Mesh(g, m);
      const angle = (i / 6) * Math.PI * 2;
      bar.position.set(Math.cos(angle) * 1.3, -0.6, Math.sin(angle) * 1.3);
      this.bars.push(bar);
      this.group.add(bar);
      this.disposables.push(g, m);
    }

    const panelGeo = new THREE.PlaneGeometry(2.4, 1.3);
    this.panelMat = createGlowMaterial(PALETTE.violet, 0);
    this.panel = new THREE.Mesh(panelGeo, this.panelMat);
    this.panel.position.set(0, 1.5, 0);
    this.group.add(this.panel);

    this.disposables.push(coreGeo, this.coreMat, shellGeo, this.shellMat, barGeo, panelGeo, this.panelMat);

    this.group.visible = false;

    this.link = mutate((s) => s.link).link;
  }

  /** Read the persisted bond. */
  get bond(): number {
    return this.link;
  }

  get isPresent(): boolean {
    return this.presenceAmount > 0.4;
  }

  /**
   * Move her along the presence scale. This is the only way her visibility
   * changes — the player never toggles it, the story does.
   */
  setPresence(p: IsoPresence): void {
    const changed = p !== this.presence;
    this.presence = p;

    if (p !== 'absent') {
      this.group.visible = true;
      if (changed) {
        bus.emit('iso:met', { firstTime: this.presenceAmount < 0.4 });
      }
    }
  }

  /** Apply a LINK change. Clamped, persisted, and reported. */
  changeLink(delta: number): void {
    const next = clamp(this.link + delta, 0, 100);
    const actual = next - this.link;
    if (actual === 0) return;

    this.link = next;
    mutate((s) => {
      s.link = next;
    });
    bus.emit('iso:link-changed', { value: next, delta: actual });
  }

  /**
   * The next line she is willing to say, or null if she has nothing new. Gated
   * by LINK and by what has already been said, so she never repeats herself.
   */
  nextLine(): IsoLine | null {
    for (const line of ISO_LINES) {
      if (this.delivered.has(line.id)) continue;
      if (line.requires !== undefined && this.link < line.requires) continue;
      this.delivered.add(line.id);

      mutate((s) => {
        if (!s.readLogs.includes(line.id)) s.readLogs.push(line.id);
      });

      bus.emit('iso:line', { id: line.id });
      return line;
    }
    return null;
  }

  /** Restore which lines have already been given, from the save. */
  restoreDelivered(ids: string[]): void {
    for (const id of ids) this.delivered.add(id);
  }

  /**
   * Place her in the world. At low presence she is far off and small; the
   * player has to walk toward her, which is the first real statement the game
   * makes about how to treat her.
   */
  placeAt(x: number, y: number, z: number): void {
    this.baseY = y;
    this.group.position.set(x, y, z);
  }

  /** The height she hovers around; the hover oscillates about this. */
  private baseY = 0;

  /* ---------------------------------------------------------------------
     Frame
     --------------------------------------------------------------------- */

  private readonly lookTarget = new THREE.Vector3();

  update(dt: number, elapsed: number, playerPos: THREE.Vector3): void {
    if (!this.group.visible) return;

    const target: Record<IsoPresence, number> = {
      absent: 0,
      glimpse: 0.18,
      distant: 0.55,
      present: 1,
    };
    this.presenceAmount = damp(this.presenceAmount, target[this.presence], 2.2, dt);

    if (this.presenceAmount < 0.01) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const a = this.presenceAmount;

    /* --- her light pattern: slow, asymmetric, off the beat --- */
    this.phase += dt * 0.7;

    const breathe = 0.5 + Math.sin(this.phase + this.phaseOffset) * 0.5;
    const undertone = Math.sin(this.phase * 0.43 + this.phaseOffset * 2) * 0.5 + 0.5;

    this.coreMat.opacity = a * (0.35 + breathe * 0.45);
    this.core.scale.setScalar(lerp(0.7, 1.0, breathe) * lerp(0.8, 1.0, a));

    this.shellMat.opacity = a * (0.12 + undertone * 0.22);
    this.shell.scale.setScalar(1 + Math.sin(this.phase * 0.31) * 0.06);
    // The shell counter-rotates against the core. Two rhythms, one body.
    this.shell.rotation.y = -this.phase * 0.4;
    this.core.rotation.y = this.phase * 0.25;

    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars[i];
      const speed = 0.3 + i * 0.11;
      const angle = this.phase * speed + (i / this.bars.length) * Math.PI * 2;
      bar.position.x = Math.cos(angle) * 1.3;
      bar.position.z = Math.sin(angle) * 1.3;
      // Each bar fades on its own cycle, so the pattern never repeats exactly.
      bar.scale.y = 0.6 + Math.sin(this.phase * (1.1 + i * 0.2) + i) * 0.4;
      (bar.material as THREE.MeshBasicMaterial).opacity =
        a * (0.2 + Math.abs(Math.sin(this.phase * 0.8 + i * 1.7)) * 0.5);
    }

    // She faces the player, but only once she is present enough to. Before
    // that she does not appear to notice.
    if (a > 0.5) {
      this.lookTarget.copy(playerPos).sub(this.group.position);
      const targetYaw = Math.atan2(this.lookTarget.x, this.lookTarget.z);
      let d = targetYaw - this.group.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.group.rotation.y += d * clamp(dt * 1.5, 0, 1);
    }

    // A slow hover, independent of her light pattern, so she never looks
    // pinned to the floor.
    this.group.position.y = lerp(
      this.group.position.y,
      this.baseY + Math.sin(elapsed * 0.5) * 0.09,
      clamp(dt * 2, 0, 1),
    );

    this.panelMat.opacity = a > 0.6 ? a * 0.16 : 0;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }
}