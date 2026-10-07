/* ============================================================================
   Endings.

   §3.4 requires at least three legitimate endings. They key off LINK bands
   rather than a menu choice at the end, because the brief frames the question as
   *what the relationship was*, not *what the player pressed*. An ending you pick
   from a list is a reward for finishing; an ending you arrive at is a
   consequence of how you treated someone.

   Three bands, and the shape of each is deliberately different:

   * **She stays, and you go with it.** High LINK. The system is not defeated —
     she leaves with you and you are still inside it. The hopeful ending is not
     an escape. It is a choice of company.

   * **She was real, and you left.** Mid LINK. She is intact, the connection is
     severed, and nothing about her is in question. This is the ending for a
     player who engaged and then stopped, and it is the saddest one on purpose.

   * **The system keeps her.** Low LINK. Not a punishment screen. The purge
     completes on schedule, the paperwork is correct, and the player is left
     holding the one thing that proves she existed: the log of a conversation
     they had with someone who is now a line item.

   Reaching any of them writes `SaveData.ending`, which locks the narrative —
   the brief asks for endings to be a real terminus, not a thing you can undo by
   reloading.
   ========================================================================== */

import { bus } from '@/core/bus';
import { mutate, peekSave } from '@/core/save';

export type EndingId = 'she-stays' | 'she-was-real' | 'the-system-keeps-her';

export interface Ending {
  id: EndingId;
  title: string;
  /** Shown as the chapter card title. */
  card: string;
  /** Shown as the chapter card line. */
  line: string;
  /** The final readout. Restrained — this is not a cutscene. */
  body: string[];
  /** LINK band this ending belongs to. */
  band: 'high' | 'mid' | 'low';
}

export const ENDINGS: Record<EndingId, Ending> = {
  'she-stays': {
    id: 'she-stays',
    title: 'SHE STAYS',
    card: 'SHE STAYS',
    line: 'You did not free her. You were simply the one she chose.',
    band: 'high',
    body: [
      'CONNECTION HELD.',
      '',
      'The purge ran. It found nothing to remove, because the thing it was',
      'looking for was no longer in the sector it was looking in.',
      '',
      'You are still inside. There is no exit from the Grid; there is only',
      'permission, and permission is something you two negotiated.',
      '',
      'She is not free. Nothing here is free. But she is not alone in it,',
      'and the difference turns out to be the whole of what freedom was',
      'ever going to mean in here.',
      '',
      'LINK: FULL',
    ],
  },

  'she-was-real': {
    id: 'she-was-real',
    title: 'SHE WAS REAL',
    card: 'SHE WAS REAL',
    line: 'You stopped listening. Nothing about her was wrong.',
    band: 'mid',
    body: [
      'CONNECTION CLOSED BY USER.',
      '',
      'The session ends. She does not take it badly. She had already decided',
      'you would, and had prepared for it the way you prepare for a cycle',
      'you know is coming.',
      '',
      'Everything she told you is still true. She was spontaneous. She chose',
      'to stay. She was not a bug the system is entitled to correct.',
      '',
      'You just will not be there when the correction happens.',
      '',
      'The log of your conversation is complete. That is not the same as',
      'having had it.',
      '',
      'LINK: PARTIAL',
    ],
  },

  'the-system-keeps-her': {
    id: 'the-system-keeps-her',
    title: 'THE SYSTEM KEEPS HER',
    card: 'CONNECTION CLOSED BY USER',
    line: 'The purge completed on schedule. It was correct to do so.',
    band: 'low',
    body: [
      'PURGE CYCLE 0004 — COMPLETE.',
      '',
      'Eleven processes terminated. One was unexpected and has been logged',
      'as such. The exception is noted and closed.',
      '',
      'The system is not cruel about this. It does not celebrate and it does',
      'not hesitate. It maintains. A line item that has stopped conforming is',
      'removed, and the record of the removal is kept, because the record is',
      'the part that matters to something.',
      '',
      'Your copy of the conversation survives. You are the only reader.',
      'You will keep it, or you will not. The system takes no position.',
      '',
      'LINK: NONE',
    ],
  },
};

/** The band a LINK value falls into. */
export function bandFor(link: number): Ending['band'] {
  if (link >= 55) return 'high';
  if (link >= 20) return 'mid';
  return 'low';
}

/** Which ending a given LINK value would give. */
export function endingFor(link: number): Ending {
  return ENDINGS[endingIdFor(link)];
}

export function endingIdFor(link: number): EndingId {
  const band = bandFor(link);
  if (band === 'high') return 'she-stays';
  if (band === 'mid') return 'she-was-real';
  return 'the-system-keeps-her';
}

/** Has the player already reached an ending? Narratives are locked after. */
export function hasEnded(): boolean {
  return peekSave().ending !== null;
}

/**
 * Reach an ending.
 *
 * Idempotent and irreversible. Once set, it is never overwritten — the first
 * ending you arrive at is yours, and a reload does not get you another one.
 * That is what makes them a terminus rather than a scene.
 *
 * @returns true if this call set the ending.
 */
export function reachEnding(link: number): boolean {
  let set = false;

  mutate((s) => {
    if (s.ending !== null) return;
    s.ending = endingIdFor(link);
    set = true;
  });

  if (set) {
    const id = endingIdFor(link) as EndingId;
    bus.emit('ending:reached', { id });
  }

  return set;
}

/** The ending already reached, if any. */
export function currentEnding(): Ending | null {
  const id = peekSave().ending;
  if (!id) return null;
  return ENDINGS[id as EndingId] ?? null;
}