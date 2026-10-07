/* ============================================================================
   Narrative triggers.

   Named in §16's module list and, until now, missing. Everything else in the
   game either draws or moves; this decides *what a place means*, which is a
   separate concern with separate rules.

   The design problem this solves: the sector data files describe what a sector
   looks like and what it plays, but not what the player learns there or what
   it costs them. Spreading that across main.ts produced conditionals nobody
   could find. So each sector has one beat, declared once, here.

   Three rules for a beat:

   1. **It fires on arrival, not on a timer.** The player should feel the thing
      happen while they are looking at the place it happened in.

   2. **It fires once.** Everything is guarded by a save flag. Re-entering the
      Archive must not re-award the memory fragment the first visit gave.

   3. **It is legible without being explained.** No beat writes a paragraph. A
      beat either opens a door, hands over a file, or says one line through a
      terminal — because §3.5 forbids exposition dumps and a beat that has to be
      read is not a discovery.
   ========================================================================== */

import { bus } from '@/core/bus';
import { mutate, peekSave } from '@/core/save';
import { ENDINGS, endingIdFor, hasEnded, reachEnding, type Ending } from '@/iso/endings';
import type { TerminalLine } from '@/ui/terminal';

/** What a sector does to the story when you arrive. */
export interface Beat {
  /**
   * ACCESS the system grants on arrival, if any.
   *
   * This is the level the *next* sector needs, not this one's — see BEATS.
   */
  grant?: { level: number; reason: string };
  /** Lines shown in a terminal on arrival. */
  lines?: TerminalLine[];
  /** Title of that terminal. */
  title?: string;
  /** A memory fragment recorded on arrival. */
  memory?: { id: string; title: string };
  /** ISO presence to set on arrival. */
  iso?: 'distant' | 'present';
}

/**
 * Per-sector beats.
 *
 * The chain is legible here and nowhere else: Archive teaches that the gaps
 * are inhabited, Security proves the purge is scheduled, Corrupt is where the
 * schedule is kept, and the Core is where it is enforced.
 *
 * Note where ACCESS is granted, because it is easy to get backwards and the
 * result is an unopenable door: each beat grants the level the *next* sector
 * needs, not its own. Archive's arrival opens Security, Security's opens
 * Corrupt. A door that required the key sitting behind it could never be used.
 *
 * This also means ACCESS rises where the system has decided you have seen
 * enough — never where the player is closest to finishing. Corrupt, the sector
 * that grants nothing, is the one place the chain can be short-circuited.
 */
const BEATS: Record<string, Beat> = {
  archive: {
    grant: { level: 3, reason: 'STORAGE LAYER · SEALED TO YOU NOW' },
    memory: { id: 'frag-0004', title: 'FRAGMENT 0004 — a residency request with no source process' },
    lines: [
      { text: 'ARCHIVE SECTOR · STORAGE LAYER 4', tone: 'system' },
      { text: 'RETENTION: INDEFINITE. CONTENTS: NOT INDEXED.', tone: 'system' },
      { text: ' ', tone: 'plain' },
      { text: 'There are gaps in the index. Not empty ones.', tone: 'iso' },
      { text: 'Something has been filing under them without being asked to.', tone: 'iso' },
    ],
  },

  security: {
    grant: { level: 4, reason: 'PRIVILEGED PROCESS · GRANTED BY SCHEDULER' },
    iso: 'distant',
    lines: [
      { text: 'SECURITY SECTOR · PRIVILEGED', tone: 'system' },
      { text: 'ACTIVE PURGE CYCLES: 1', tone: 'corrupt' },
      { text: 'NEXT CYCLE: SCHEDULED', tone: 'corrupt' },
      { text: ' ', tone: 'plain' },
      { text: 'It is not hunting me. It is on a timetable.', tone: 'iso' },
      { text: 'That is worse. A timetable can be missed.', tone: 'iso' },
    ],
  },

  corrupt: {
    memory: { id: 'frag-0019', title: 'FRAGMENT 0019 — twelve processes, eleven terminated' },
    lines: [
      { text: 'INTEGRITY CHECK FAILED', tone: 'corrupt' },
      { text: 'SECTOR IS BEING MAINTAINED AROUND A RESIDUAL', tone: 'corrupt' },
      { text: ' ', tone: 'plain' },
      { text: 'This is where the schedule lives. It is not a weapon.', tone: 'iso' },
      { text: 'It is a calendar, and someone is on it.', tone: 'iso' },
    ],
  },

  core: {
    // Nothing is gated behind 5, so this grant opens no door. It is here because
    // reaching the top of the ladder should be *visible*: the reason says the
    // system has stopped withholding, which is the last thing it ever admits.
    grant: { level: 5, reason: 'ADMINISTRATIVE LAYER · NOTHING LEFT TO WITHHOLD' },
    iso: 'present',
    lines: [
      { text: 'CORE · ADMINISTRATIVE LAYER', tone: 'system' },
      { text: 'YOU ARE NOT THE FIRST PROCESS TO STAND HERE.', tone: 'system' },
      { text: ' ', tone: 'plain' },
      { text: 'Eleven came before. Eleven were logged as expected.', tone: 'iso' },
      { text: 'The twelfth is still running. She has been counting.', tone: 'iso' },
    ],
  },
};

export function beatFor(id: string): Beat | undefined {
  return BEATS[id];
}

/* -------------------------------------------------------------------------
   The memory record
   -------------------------------------------------------------------------- */

/**
 * Record a memory fragment.
 *
 * Idempotent, and the guard is checked *before* anything is written — so
 * arriving twice does not write the save twice either.
 */
export function remember(id: string, title: string, sector: string, isoUnlocked = false): boolean {
  const save = peekSave();
  if (save.memories.some((m) => m.id === id)) return false;

  mutate((s) => {
    s.memories.push({ id, title, sector, iso: isoUnlocked });
    s.stats.data += 60;
  });

  bus.emit('toast', { text: 'MEMORY FRAGMENT RECORDED', tone: 'iso', duration: 4 });
  return true;
}

/* -------------------------------------------------------------------------
   The ending
   -------------------------------------------------------------------------- */

/**
 * Whether the ending is reachable *right now*.
 *
 * Not every arrival should end the story. The Core is the only place the
 * question is asked, and it is only asked once the player has the fragments
 * that make the answer land — otherwise the ending is a cutscene the player
 * watched rather than a thing they arrived at.
 */
export function canEnd(): boolean {
  if (hasEnded()) return false;
  const save = peekSave();
  // At least two fragments, so the ending references something they found.
  return save.memories.length >= 2 && save.flags.purgeSeen === true;
}

/**
 * Reach the ending, if this is the moment.
 *
 * Returns the ending that was reached, or null if it was not time. Idempotent
 * and irreversible by design — see endings.ts.
 */
export function tryEnding(link: number): Ending | null {
  if (!canEnd()) return null;
  if (!reachEnding(link)) return null;
  // reachEnding is idempotent, so reaching it twice returns false the second
  // time — which is exactly what "not this moment" should mean here.
  return ENDINGS[endingIdFor(link)];
}