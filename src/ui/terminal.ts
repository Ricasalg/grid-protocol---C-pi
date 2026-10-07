/* ============================================================================
   Terminal overlay.

   This is a *reading surface*, not a shell. There is no command line: nothing
   the player types reaches a real interpreter, nothing is executed, and every
   line of content is fiction authored in the data files. The panel exists so
   the world can speak without putting text into the 3D scene.

   Content is typed to keep the tone consistent: 'system' for the Grid, 'iso'
   for her, 'warn' for security, 'corrupt' for damaged data.
   ========================================================================== */

import { el, clear } from './dom';

export type TerminalTone = 'system' | 'iso' | 'warn' | 'corrupt' | 'plain';

export interface TerminalLine {
  text: string;
  tone?: TerminalTone;
}

export interface TerminalContent {
  title: string;
  lines: TerminalLine[];
  /** Buttons rendered under the body. */
  actions?: Array<{ label: string; primary?: boolean; onClick: () => void }>;
  /** If set, only one action and it closes on click. */
  dismissible?: boolean;
}

export class Terminal {
  readonly root: HTMLElement;

  private readonly overlay: HTMLElement;
  private readonly titleNode: HTMLElement;
  private readonly linesNode: HTMLElement;
  private readonly actionsNode: HTMLElement;

  private openState = false;
  private onCloseCb: (() => void) | null = null;

  /** Animated type-on, in seconds per line. */
  private typeSpeed = 0.016;
  private revealTimer = 0;
  private pendingLines: TerminalLine[] = [];
  private revealed = 0;
  private typing = false;

  constructor(root: HTMLElement) {
    this.root = root;

    this.titleNode = el('div', { class: 'terminal-title' });
    this.linesNode = el('div', { class: 'terminal-lines' });
    this.actionsNode = el('div', { class: 'terminal-actions' });

    this.overlay = el(
      'div',
      {
        class: 'terminal',
        role: 'dialog',
        'aria-modal': 'true',
        tabindex: '-1',
      },
      [
        el('div', { class: 'terminal-body bracket' }, [
          this.titleNode,
          this.linesNode,
          this.actionsNode,
        ]),
      ],
    );

    // Clicking the backdrop (but not the body) dismisses.
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });

    root.appendChild(this.overlay);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  /** True while lines are still typing in. Skippable input skips them. */
  get isTyping(): boolean {
    return this.typing;
  }

  /**
   * Present content. Lines type on one after another; `fast` reveals them all,
   * which is what pressing E during the reveal does.
   */
  show(content: TerminalContent, fast = false): void {
    this.titleNode.textContent = content.title;
    this.pendingLines = content.lines;
    this.revealed = 0;
    this.typing = true;
    this.revealTimer = 0;

    clear(this.linesNode);
    clear(this.actionsNode);

    const actions = content.actions ?? [];
    if (content.dismissible || actions.length === 0) {
      this.actionsNode.appendChild(
        el('button', {
          class: 'text-btn is-primary',
          text: 'CLOSE',
          onclick: () => this.close(),
        }),
      );
    }
    for (const action of actions) {
      const btn = el('button', {
        class: action.primary ? 'text-btn is-primary' : 'text-btn',
        text: action.label,
        onclick: () => {
          this.close();
          action.onClick();
        },
      });
      this.actionsNode.appendChild(btn);
    }

    this.openState = true;
    this.overlay.classList.add('is-open');
    // Focus without scrolling; the overlay traps nothing else, but this lets
    // Escape and Enter work without a click target.
    this.overlay.focus({ preventScroll: true });

    if (fast) this.finishTyping();
  }

  /** Reveal all remaining lines immediately. */
  finishTyping(): void {
    if (!this.typing) return;
    this.typing = false;
    for (const line of this.pendingLines) {
      this.pendingLines.shift();
      this.appendLine(line);
      this.revealed++;
    }
  }

  private appendLine(line: TerminalLine): void {
    const p = el('p', {
      class: line.tone && line.tone !== 'plain' ? `tone-${line.tone}` : '',
      text: line.text,
    });
    this.linesNode.appendChild(p);
    // Keep the newest line in view on small screens.
    this.overlay.querySelector('.terminal-body')?.scrollTo({
      top: this.linesNode.scrollHeight,
      behavior: 'smooth',
    });
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.overlay.classList.remove('is-open');
    this.typing = false;
    const cb = this.onCloseCb;
    this.onCloseCb = null;
    cb?.();
  }

  /** Called on the Escape/Enter key. Returns true if it consumed the key. */
  handleKey(code: string): boolean {
    if (!this.openState) return false;
    if (code === 'Escape' || code === 'Enter' || code === 'KeyE') {
      if (this.typing) {
        this.finishTyping();
        return true;
      }
      this.close();
      return true;
    }
    return false;
  }

  /** Register a one-shot callback fired when the panel closes. */
  onClose(cb: () => void): void {
    this.onCloseCb = cb;
  }

  update(dt: number): void {
    if (!this.typing || this.pendingLines.length === 0) return;

    this.revealTimer -= dt;
    while (this.revealTimer <= 0 && this.pendingLines.length > 0) {
      const line = this.pendingLines.shift()!;
      this.appendLine(line);
      this.revealed++;
      // Blank lines and system headers get a longer beat.
      const pause = line.text.length > 90 ? this.typeSpeed * 3 : line.text.length === 0 ? this.typeSpeed * 8 : this.typeSpeed;
      this.revealTimer += pause;
    }

    if (this.pendingLines.length === 0) this.typing = false;
  }

  setTypeSpeed(s: number): void {
    this.typeSpeed = s;
  }
}