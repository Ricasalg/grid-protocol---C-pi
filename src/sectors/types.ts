/* ============================================================================
   Sector content model.

   A sector is a walkable place. The Grid (grid/world.ts) is one sector —
   the Plaza — and so is the Arcade's interior, the Archive, Security, the
   Corrupted Zone and the Core.

   The difference from a "level" is that sectors share no state with each
   other beyond the save file. They are built when entered, entered through a
   single generic door, and thrown away when left. That is what lets the
   network be bigger than one sitting.

   This file is the contract the JSON content and the runtime agree on. It
   imports one type, from audio, so the contract cannot drift from the engine.
   ========================================================================== */

import type { AreaId } from '@/audio/engine';

/** What a sector is for. Determines its lighting, fog and audio identity. */
export type SectorTone =
  /** Cold, ordered, quiet. Storage. */
  | 'archive'
  /** Hostile. Amber light, tight fog, things that hunt. */
  | 'security'
  /** Failing. Visible geometry errors, dropped frames of light. */
  | 'corrupt'
  /** The administrative layer. Everything, at once. */
  | 'core'
  /** The ISO's layer. Violet, warm despite being cold. */
  | 'iso';

/**
 * How the sector is generated. Every sector is procedural, but not every
 * sector should look the same procedural.
 */
export interface SectorDef {
  id: string;

  /** Which node in network.json this sector is. */
  node: string;

  title: string;
  subtitle: string;

  /**
   * Audio area id, from audio/engine.ts.
   *
   * Typed as `AreaId` rather than `string` so a sector cannot name an area that
   * does not exist: a typo here would otherwise be a silent no-op in the audio
   * graph at the exact moment the player enters the sector.
   */
  music: AreaId;

  tone: SectorTone;

  /** Half-extent of the walkable area, in metres. */
  half: number;

  /**
   * Access level required to enter. Mirrors the node's, but lives here too
   * because the door checks it before spending time building the sector.
   */
  access: number;

  /** How many structural forms to scatter. Scales with the quality tier. */
  density: number;

  /** Height of the ceiling, or 0 for open sky. */
  ceiling: number;

  /** Exponential fog density. Higher = you see less. */
  fog: number;

  /** Whether this sector spawns anything that hunts the player. */
  hostile: boolean;

  /** Lights that seek the player when hostile. */
  pursuers: number;

  /** Text shown when the door refuses entry. */
  locked: string[];
}

/** Every sector, keyed by id. Loaded from data/sectors.json. */
export interface SectorData {
  sectors: SectorDef[];
}

export function findSector(data: SectorData, id: string): SectorDef | undefined {
  return data.sectors.find((s) => s.id === id);
}