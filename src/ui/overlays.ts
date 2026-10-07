/* ============================================================================
   Chapter cards and the death overlay.

   Chapter cards mark the linear opening beats. They appear, hold, and fade on
   their own — the player is never asked to dismiss them, because being asked
   to dismiss a title card breaks the fiction that this is a place, not a
   product.

   The death overlay is the roguelike loop's visible face: CONNECTION LOST ->
   SYSTEM REINITIALIZING -> return to the Grid. Progression persists; the body
   does not.
   ========================================================================== */

import { el } from './dom';
import type { Ending } from '@/iso/endings';

/* -------------------------------------------------------------------------
   Chapter card
   ------------------------------------------------------------------------- */

export interface ChapterCard {
  root: HTMLElement;
  show(num: string, title: string, line: string, seconds?: number): void;
  hide(): void;
  /** Drives the hold timer so the card fades even with the loop paused. */
  update(dt: number): void;
}

export function createChapterCard(root: HTMLElement): ChapterCard {
  const numNode = el('div', { class: 'chapter-num' });
  const titleNode = el('div', { class: 'chapter-title' });
  const lineNode = el('div', { class: 'chapter-line' });

  const card = el('div', { class: 'chapter' }, [
    el('div', { class: 'chapter-inner' }, [numNode, titleNode, lineNode]),
  ]);

  root.appendChild(card);

  let timer = 0;
  let active = false;

  const hide = () => {
    if (!active) return;
    active = false;
    card.classList.remove('is-open');
  };

  return {
    root: card,
    show(num, title, line, seconds = 4.2) {
      clearTimeout(timer);
      numNode.textContent = num;
      titleNode.textContent = title;
      lineNode.textContent = line;
      card.classList.add('is-open');
      active = true;
      timer = window.setTimeout(hide, seconds * 1000);
    },
    hide,
    update(dt: number) {
      if (!active) return;
      timer -= dt * 1000;
      if (timer <= 0) hide();
    },
  };
}

/* -------------------------------------------------------------------------
   Death / reconnect
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   Ending

   The terminus. It arrives after the chapter card, holds, and then leaves the
   player in the world rather than on a credits screen — the ending is a
   readout, not a menu, and §13 asks the UI to disappear when it is not needed.
   -------------------------------------------------------------------------- */

export interface EndingOverlay {
  root: HTMLElement;
  /**
   * Play an ending. Resolves when the overlay is dismissed, so the caller can
   * continue without racing a timer.
   */
  play(ending: Ending): Promise<void>;
}

export function createEndingOverlay(root: HTMLElement): EndingOverlay {
  const titleNode = el('div', { class: 'ending-title' });
  const bodyNode = el('div', { class: 'ending-body' });
  const hintNode = el('div', { class: 'ending-hint', text: 'PRESS ANY KEY' });

  const overlay = el('div', { class: 'ending' }, [
    el('div', { class: 'ending-inner' }, [titleNode, bodyNode, hintNode]),
  ]);

  root.appendChild(overlay);

  let waiters: Array<() => void> = [];

  const finish = () => {
    if (!overlay.classList.contains('is-open')) return;
    overlay.classList.remove('is-open');
    document.body.classList.remove('is-ending');
    const w = waiters;
    waiters = [];
    for (const r of w) r();
  };

  // Any key or click dismisses it. The player finishes reading at their own
  // pace; making them wait out a timer would be a cutscene, which §3.5 rules
  // out for the whole narrative.
  const onKey = (e: KeyboardEvent) => {
    if (!overlay.classList.contains('is-open')) return;
    // The map and settings still respond, so a player who wants to check their
    // progress mid-ending is not locked out of their own save.
    if (e.code === 'Tab' || e.code === 'KeyM' || e.code === 'KeyO') return;
    e.preventDefault();
    window.removeEventListener('keydown', onKey, true);
    finish();
  };
  overlay.addEventListener('click', finish);

  return {
    root: overlay,

    play(ending: Ending) {
      titleNode.textContent = ending.title;
      // One text node with preserved newlines: an ending is a readout, and a
      // column of separately-revealed lines would read as a slideshow.
      bodyNode.textContent = ending.body.join('\n');
      overlay.classList.add('is-open');
      document.body.classList.add('is-ending');
      hintNode.style.opacity = '0';

      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        window.addEventListener('keydown', onKey, true);
      });
    },
  };
}

/* -------------------------------------------------------------------------
   Death / reconnect
   -------------------------------------------------------------------------- */

export interface DeathOverlay {
  root: HTMLElement;
  /** Run the full sequence. Resolves when control is handed back. */
  play(cause: string): Promise<void>;
  cancel(): void;
}

export function createDeathOverlay(root: HTMLElement): DeathOverlay {
  const titleNode = el('div', { class: 'death-title', text: 'CONNECTION LOST' });
  const subNode = el('div', { class: 'death-sub' });

  const overlay = el('div', { class: 'death' }, [
    el('div', { class: 'death-inner' }, [titleNode, subNode]),
  ]);

  root.appendChild(overlay);

  let cancelled = false;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });

  return {
    root: overlay,

    async play(cause: string) {
      cancelled = false;
      overlay.classList.add('is-open');
      document.body.classList.add('is-dying');

      titleNode.textContent = 'CONNECTION LOST';
      subNode.textContent = cause;

      await wait(1500);
      if (cancelled) return;

      subNode.textContent = 'SYSTEM REINITIALIZING';
      await wait(1800);
      if (cancelled) return;

      overlay.classList.remove('is-open');
      document.body.classList.remove('is-dying');
      subNode.textContent = '';
    },

    cancel() {
      cancelled = true;
      overlay.classList.remove('is-open');
      document.body.classList.remove('is-dying');
    },
  };
}