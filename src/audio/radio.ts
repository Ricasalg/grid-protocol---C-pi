/* ============================================================================
   The radio — what the Grid plays.

   A track is not an audio file. It is a *recipe*: which area's musical palette
   to inherit, a seed that makes its own variation of that palette, and a title
   in the register of the system that is supposedly broadcasting it.

   Why recipes and not files: §2 of this project is "no network requests at
   runtime, no audio assets". Everything is synthesised. A file-based radio would
   mean either bundling audio (a licensing and size problem) or fetching it (a
   §2 violation). A recipe gives the thing the radio was actually for — variety,
   and continuity — for free.

   Two tracks drawn from the same area share a scale and a tempo, and that is
   the point: the *area* is the identity you recognise, and the seed is what
   keeps two tracks in the same area from sounding like the same track.
   ========================================================================== */

import { Rng } from '@/core/rng';
import type { AreaId } from './engine';

/** One broadcast. Not audio — instructions for synthesising it. */
export interface Track {
  /** Stable id, used as the seed source and as the settings-facing key. */
  id: string;
  /** Shown in the radio strip. Uppercase, `·` separated, in the system's voice. */
  title: string;
  /** The palette this track inherits. Same area = recognisably the same world. */
  area: AreaId;
  /**
   * Target length in seconds.
   *
   * Seconds rather than bars, deliberately. The areas run from 58bpm in the
   * Archive to 150bpm in the Cycles, so a fixed bar count would make a Cycles
   * track half the length of an Archive one — and conversely, hitting a
   * consistent length in bars would mean writing 70-bar tracks, which is not a
   * piece of music. Duration is the thing that has to stay consistent (nobody
   * wants a track that visibly rushes); bars is derived, and rounding to a
   * whole bar is what keeps the result musical.
   */
  seconds: number;
}

/**
 * The playlist.
 *
 * Ordered so that consecutive tracks differ. The engine shuffles within this
 * list rather than playing it straight, but "consecutive tracks differ" is still
 * the property worth designing for — a straight playthrough should not land two
 * `core` tracks back to back, because those are the heavy ones.
 *
 * Lengths sit between 96 and 132 seconds. That is the length at which a track
 * is long enough to establish itself and short enough that the handover is
 * something you notice happening rather than something you wait for. The spread
 * inside the range is deliberate: an early finish should be possible, so the
 * radio never feels like it is on a metronome.
 */
const PLAYLIST: readonly Track[] = [
  { id: 'frag-0007', title: 'FRAGMENT 0007 · STORAGE LAYER', area: 'archive', seconds: 124 },
  { id: 'sector-drift', title: 'SECTOR DRIFT', area: 'grid', seconds: 118 },
  { id: 'ch-arcade', title: 'CH 03 · RECREATION LAYER', area: 'arcade', seconds: 96 },
  { id: 'loop-11', title: 'BROADCAST LOOP 11', area: 'archive', seconds: 132 },
  { id: 'personal-freq', title: 'PERSONAL FREQUENCY', area: 'iso', seconds: 112 },
  { id: 'run-07', title: 'DEREGISTRATION RUN 07', area: 'cycles', seconds: 104 },
  { id: 'priv-proc', title: 'PRIVILEGED PROCESS', area: 'security', seconds: 120 },
  { id: 'frag-0019', title: 'FRAGMENT 0019 · ELEVEN TERMINATED', area: 'iso', seconds: 99 },
  { id: 'core-layer', title: 'ADMINISTRATIVE LAYER', area: 'core', seconds: 128 },
  { id: 'quiet-grid', title: 'OUTER GRID · SURFACE', area: 'grid', seconds: 131 },
  { id: 'integrity-fail', title: 'INTEGRITY FAILURE', area: 'corrupt', seconds: 108 },
  { id: 'loop-03', title: 'BROADCAST LOOP 03', area: 'grid', seconds: 121 },
  { id: 'arcade-idle', title: 'CREDITS REMAINING', area: 'arcade', seconds: 113 },
  { id: 'frag-0031', title: 'FRAGMENT 0031 · MAINTENANCE', area: 'archive', seconds: 126 },
  { id: 'core-drift', title: 'CORE · UNRESOLVED', area: 'core', seconds: 101 },
  { id: 'ch-09', title: 'CH 09 · PERSISTENT', area: 'security', seconds: 117 },
];

export function allTracks(): readonly Track[] {
  return PLAYLIST;
}

/**
 * The playlist in a playing order that will not repeat itself for a while.
 *
 * A bag-shuffle, not a plain shuffle: the tracks are dealt into a queue at
 * random and the queue is only reshuffled once it empties, so every track plays
 * exactly once per cycle. A plain shuffle can — and does — put the same track
 * twice in a row, which on a radio is the single most noticeable way to sound
 * broken.
 *
 * Seeded from the track list, so the shuffle is reproducible for a given save
 * but not the same on every boot.
 */
export class RadioOrder {
  private queue: number[] = [];

  constructor(private rng: Rng) {
    this.refill();
  }

  private refill(): void {
    this.queue = this.rng.shuffle(PLAYLIST.map((_, i) => i));
  }

  /** Index into PLAYLIST of the next track to play. */
  next(): number {
    if (!this.queue.length) this.refill();
    return this.queue.shift()!;
  }

  /**
   * The track that would play next, for looking ahead in the UI.
   *
   * There is deliberately no `previous()` here. The queue is a shuffled
   * permutation, so going backwards means consulting the history of what has
   * actually played — which is state the engine already keeps, and keeping a
   * second copy here would be a second thing to get out of step.
   */
  peek(): number {
    return this.queue.length ? this.queue[0] : PLAYLIST.length - 1;
  }
}

/**
 * Everything about a track that is derived rather than stored.
 *
 * Kept in one place so the engine does not grow a second place to look for
 * "what does this track sound like" — the area palette in `AREAS` stays the
 * single source of musical identity, and a track only says which one it wants.
 */
export interface TrackShape {
  /** Bars, rounded to a whole number from the track's target length. */
  bars: number;
  /** Seconds per bar at this track's tempo. */
  secondsPerBar: number;
  /** Total length in seconds. */
  duration: number;
  /** How busy the arpeggio is, 0..1. Derived, so two tracks differ in density. */
  density: number;
  /** How many arpeggio notes per bar, from density and the area's tempo. */
  stepsPerBar: number;
}

/** Per-area tempo is the engine's business; the shape only needs the totals. */
export function shapeOf(track: Track, bpm: number): TrackShape {
  const rng = new Rng(track.id.length * 2654435761);
  const secondsPerBar = (60 / bpm) * 4; // 4/4

  // Rounded to whole bars. A track that ends three quarters of the way through
  // a bar would hand over mid-phrase, which is the one thing §8 rules out.
  const bars = Math.max(8, Math.round(track.seconds / secondsPerBar));
  const density = rng.range(0.45, 1);

  // Snapped to a whole number of steps: an arpeggio that fires on 6.3 notes per
  // bar sounds like a sequencer with a bug rather than a deliberate rhythm.
  const stepsPerBar = Math.max(4, Math.round(density * 16));

  return {
    bars,
    secondsPerBar,
    duration: secondsPerBar * bars,
    density,
    stepsPerBar,
  };
}