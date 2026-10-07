/* ============================================================================
   Boot sequence.

   Opens on near-black. A handful of luminous characters, a minimal progress
   bar, then the single call to action. The sequence is deliberately slow and
   deliberately almost empty — the brief asks for `SYSTEM INITIALIZING` ->
   `CONNECTION ESTABLISHED` -> `USER DETECTED` -> `ENTER THE GRID`, and nothing
   else. No splash art, no feature list, no menu.

   The JACK IN button doubles as the audio unlock gesture required by browsers,
   so the player never has to hunt for a second "click to enable sound".
   ========================================================================== */

import { TIMING } from '@/core/config';
import { el, clear } from './dom';

export interface BootCallbacks {
  /** Fired when the player commits. `viaKeyboard` lets main skip the fade. */
  onJackIn: (viaKeyboard: boolean) => void;
  /** Fired while progress advances, 0..1, for the asset warm-up. */
  onProgress?: (t: number) => void;
}

/**
 * The boot lines, in order. Each is a line of fictional system text; nothing
 * here reads or touches the real system.
 */
const LINES: Array<{ text: string; at: number }> = [
  { text: 'SYSTEM INITIALIZING', at: 0.05 },
  { text: 'SUBSYSTEM MOUNTED', at: 1.15 },
  { text: 'PERIPHERALS SYNCHRONISED', at: 2.05 },
  { text: 'USER CACHE RESUMED', at: 3.0 },
  { text: 'CONNECTION ESTABLISHED', at: 4.15 },
  { text: 'USER DETECTED', at: 5.5 },
];

export class BootScreen {
  readonly root: HTMLElement;

  private readonly screen: HTMLElement;
  private readonly logNode: HTMLElement;
  private readonly barFill: HTMLElement;
  private readonly action: HTMLButtonElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly footer: HTMLElement;

  private elapsed = 0;
  private nextLine = 0;
  private progress = 0;
  private revealed = false;
  private done = false;
  private readonly cb: BootCallbacks;

  /** Resolves when the player jacks in. Lets main await the gesture. */
  private resolveJackIn!: () => void;
  readonly jackIn: Promise<void>;

  constructor(root: HTMLElement, cb: BootCallbacks) {
    this.root = root;
    this.cb = cb;
    this.jackIn = new Promise<void>((resolve) => {
      this.resolveJackIn = resolve;
    });

    this.logNode = el('div', { class: 'boot-log' });
    this.barFill = el('i');
    this.action = el('button', {
      class: 'action',
      text: 'JACK IN',
      style: 'visibility:hidden',
      onclick: () => this.commit(false),
    }) as HTMLButtonElement;

    this.skipBtn = el('button', {
      class: 'ghost-btn corner-bl',
      text: 'SKIP',
      style: 'visibility:hidden',
      onclick: () => {
        this.fastForward();
      },
    }) as HTMLButtonElement;

    this.footer = el('div', { class: 'mono-dim', style: 'letter-spacing:.24em;font-size:10px;text-align:center' });

    this.screen = el('div', { class: 'screen' }, [
      el('div', { class: 'screen-inner' }, [
        this.logNode,
        el('div', { class: 'boot-title', text: 'GRID PROTOCOL' }),
        el('div', { class: 'boot-bar' }, [this.barFill]),
        this.action,
      ]),
      this.skipBtn,
      this.footer,
    ]);

    root.appendChild(this.screen);
  }

  /** Reveal the opening state. Called once the canvas exists. */
  begin(): void {
    // Fade in from black rather than appearing instantly.
    requestAnimationFrame(() => this.screen.classList.add('is-open'));
  }

  /** Jump straight to the call to action. */
  fastForward(): void {
    for (let i = this.nextLine; i < LINES.length; i++) this.appendLine(LINES[i]);
    this.nextLine = LINES.length;
    this.elapsed = TIMING.bootDuration;
    this.progress = 1;
    this.revealAction();
  }

  private appendLine(line: { text: string }): void {
    const node = el('div', { class: 'boot-line', text: line.text });
    this.logNode.appendChild(node);
    // Keep at most five lines so the log never grows into a wall of text.
    while (this.logNode.childElementCount > 5) {
      this.logNode.firstElementChild?.remove();
    }
  }

  private revealAction(): void {
    if (this.revealed) return;
    this.revealed = true;

    this.barFill.style.width = '100%';
    this.action.style.visibility = 'visible';
    this.skipBtn.style.visibility = 'hidden';
    this.footer.textContent = 'HEADPHONES RECOMMENDED · PRESS ENTER TO JACK IN';

    this.action.focus({ preventScroll: true });
  }

  private commit(viaKeyboard: boolean): void {
    if (this.done) return;
    this.done = true;

    this.action.style.visibility = 'hidden';
    this.footer.textContent = '';
    this.screen.classList.remove('is-open');

    this.cb.onJackIn(viaKeyboard);
    this.resolveJackIn();
  }

  /** Enter or Space commits. Returns true if the key was consumed. */
  handleKey(code: string): boolean {
    if (this.done || !this.revealed) return false;
    if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
      this.commit(true);
      return true;
    }
    return false;
  }

  update(dt: number): void {
    if (this.done) return;

    if (!this.revealed) {
      this.elapsed += dt;

      while (this.nextLine < LINES.length && this.elapsed >= LINES[this.nextLine].at) {
        this.appendLine(LINES[this.nextLine]);
        this.nextLine++;
      }

      this.progress = Math.min(1, this.elapsed / TIMING.bootDuration);
      this.barFill.style.width = `${(this.progress * 100).toFixed(1)}%`;
      this.cb.onProgress?.(this.progress);

      if (this.elapsed >= TIMING.bootDuration) this.revealAction();
    }

    this.skipBtn.style.visibility = this.revealed ? 'hidden' : 'visible';
  }

  /** Wipe for the death overlay's use — not needed here, kept for symmetry. */
  clearLines(): void {
    clear(this.logNode);
    this.nextLine = 0;
  }
}