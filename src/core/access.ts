/* ============================================================================
   ACCESS.

   §12 names ACCESS as the stat that unlocks sectors the player could not
   previously enter. This module owns when it rises, and — more importantly —
   what it costs.

   The temptation with an access stat is to hand it out for exploration, so the
   player always feels they are earning it. That is the wrong shape for this
   world. The system in GRID PROTOCOL is not a school; it is a machine that
   decides who is allowed to know what. ACCESS is not a reward for looking, it
   is something the system gives when it wants you to go somewhere it has
   prepared you for — including somewhere it wants you gone.

   So there are exactly two ways to rise:

   1. **The system grants it.** Via a terminal, a file, a door that opens
      because you did the thing it was watching for. This is the honest path.

   2. **You take it.** At a cost the game names out loud — DATA, or progress on
      the ISO, or the only advantage you had.

   Both are permanent. Neither is reversible except through the endings, which
   is deliberate: the brief asks for a relationship that can be lost through
   betrayal, and a stat that goes down on betrayal has to go somewhere.
   ========================================================================== */

import { bus } from '@/core/bus';
import { mutate, peekSave } from '@/core/save';

/** The ladder. Kept explicit so nothing else can invent a level. */
export const ACCESS_LEVELS = [1, 2, 3, 4, 5] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface AccessGrant {
  level: number;
  /** Why the system let you in. Shown verbatim. */
  reason: string;
}

/** The one line the player is told when a sector refuses them. */
export function refusal(lockedLines: string[]): string[] {
  return lockedLines.length > 0 ? lockedLines : ['ACCESS DENIED.'];
}

/**
 * Raise ACCESS to at least `level`.
 *
 * Never lowers. Idempotent: granting a level the player already has is a no-op
 * that returns null, so callers can call this freely on repeat triggers.
 *
 * @returns the new level, or null if nothing changed.
 */
export function grantAccess(level: number, reason: string): number | null {
  let result: number | null = null;

  mutate((s) => {
    if (s.stats.access >= level) return;

    // ACCESS never drops below 1, and never exceeds the ladder.
    const next = Math.min(level, Math.max(...ACCESS_LEVELS));
    s.stats.access = next;
    result = next;
  });

  if (result !== null) {
    bus.emit('access:changed', { level: result });
    // The reason is a first-class part of the event: the player should see why
    // the system decided they were ready, not just that they now are.
    bus.emit('toast', { text: `ACCESS ${result} · ${reason}`, tone: 'discovery' });
  }

  return result;
}

/** The player's current level. Read-only — must not dirty the save. */
export function currentAccess(): number {
  return peekSave().stats.access;
}

/** Whether the player may enter a node requiring `required`. */
export function meets(required: number): boolean {
  return currentAccess() >= required;
}