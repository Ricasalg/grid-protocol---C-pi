/* ============================================================================
   In-world HUD.

   Deliberately almost empty. The brief is explicit: the world is the
   protagonist and the UI disappears when it is not needed. So there is exactly
   one always-on gauge (ENERGY), one contextual prompt, transient toasts, a
   location readout that fades itself out, and the LINK meter, which stays
   hidden until the ISO has actually been met.

   Nothing here ever shows a menu or a dashboard.
   ========================================================================== */

import { bus } from '@/core/bus';
import { clamp01 } from '@/core/rng';
import { el, clear } from './dom';

export class Hud {
  readonly root: HTMLElement;

  private readonly hud: HTMLElement;
  private readonly energyFill: HTMLElement;
  private readonly energyValue: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly promptKey: HTMLElement;
  private readonly promptLabel: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly loc: HTMLElement;
  private readonly locName: HTMLElement;
  private readonly locSub: HTMLElement;
  private readonly link: HTMLElement;
  private readonly linkFill: HTMLElement;
  private readonly linkValue: HTMLElement;
  private readonly objectives: HTMLElement;
  private readonly objList: HTMLElement;
  private readonly hint: HTMLElement;

  /** Local timers, advanced from update() so they survive tab throttling. */
  private locTimer = 0;
  private promptShown = false;
  private hintTimer = 0;

  private currentPrompt = '';
  private currentKey = '';

  /**
   * The radio strip, which appears and disappears with the HUD.
   *
   * Typed loosely on purpose: `Hud` must not import `music.ts`, or the two
   * would know about each other in both directions.
   */
  private radio: { show(): void; hide(): void } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;

    /* --- energy --- */
    this.energyFill = el('i', { class: 'energy-fill' });
    this.energyValue = el('span', { class: 'mono-dim', text: '100' });

    /* --- interaction prompt --- */
    this.promptKey = el('span', { class: 'prompt-key', text: 'E' });
    this.promptLabel = el('span', { class: 'prompt-label' });
    this.prompt = el('div', { class: 'prompt' }, [this.promptKey, this.promptLabel]);

    /* --- toasts --- */
    this.toasts = el('div', { class: 'toasts' });

    /* --- location --- */
    this.locName = el('div', { class: 'loc-name' });
    this.locSub = el('div', { class: 'loc-sub' });
    this.loc = el('div', { class: 'loc' }, [this.locName, this.locSub]);

    /* --- LINK --- */
    this.linkFill = el('i', { class: 'link-fill' });
    this.linkValue = el('span', { class: 'mono-dim', text: '0' });
    this.link = el('div', { class: 'link' }, [
      el('span', { class: 'link-name mono-label', text: 'LINK' }),
      el('div', { class: 'link-track' }, [this.linkFill]),
      this.linkValue,
    ]);

    /* --- objectives --- */
    this.objList = el('div', { class: 'obj-list' });
    this.objectives = el('div', { class: 'objectives' }, [
      el('div', { class: 'mono-label', text: 'OBJECTIVES' }),
      this.objList,
    ]);

    /* --- controls hint --- */
    this.hint = el('div', { class: 'prompt hint' }, [
      el('span', { class: 'prompt-key', text: 'W A S D' }),
      el('span', { class: 'prompt-label', text: 'MOVE · SHIFT RUN · E INTERACT · ESC RELEASE' }),
    ]);

    this.hud = el('div', { class: 'hud' }, [
      this.loc,
      this.toasts,
      this.energyBlock(),
      this.link,
      this.objectives,
      this.prompt,
      this.hint,
    ]);

    root.appendChild(this.hud);

    bus.on('toast', (p) => this.toast(p.text, p.tone, p.duration));
    bus.on('hud:control-hint', (p) => {
      this.hint.classList.toggle('is-open', p.show);
      this.hintTimer = p.show ? 5 : 0;
    });
    bus.on('iso:link-changed', (p) => this.setLink(p.value));
    bus.on('iso:met', () => this.link.classList.add('is-open'));
  }

  private energyBlock(): HTMLElement {
    return el('div', { class: 'energy' }, [
      el('div', { class: 'energy-head' }, [
        el('span', { class: 'mono-label', text: 'ENERGY' }),
        this.energyValue,
      ]),
      el('div', { class: 'energy-track' }, [this.energyFill]),
    ]);
  }

  /* ---------------------------------------------------------------------
     Visibility
     --------------------------------------------------------------------- */

  show(): void {
    this.hud.classList.add('is-open');
    // The radio follows the HUD exactly. Both are answers to the same question
    // — is the player currently looking at the world, or at something that owns
    // the screen — so having one drive the other removes fourteen call sites
    // that would each have to remember.
    this.radio?.show();
  }

  hide(): void {
    this.hud.classList.remove('is-open');
    this.radio?.hide();
  }

  /** Attached after construction; see `main.ts`. */
  attachRadio(strip: { show(): void; hide(): void }): void {
    this.radio = strip;
  }

  /* ---------------------------------------------------------------------
     Gauges
     --------------------------------------------------------------------- */

  /** `v` is 0..1. */
  setEnergy(v: number): void {
    const pct = clamp01(v);
    this.energyFill.style.width = `${(pct * 100).toFixed(1)}%`;
    this.energyFill.classList.toggle('is-low', pct < 0.3);
    this.energyValue.textContent = String(Math.round(pct * 100));
  }

  /** LINK is 0..100. */
  setLink(v: number): void {
    const pct = clamp01(v / 100);
    this.linkFill.style.width = `${(pct * 100).toFixed(1)}%`;
    this.linkValue.textContent = String(Math.round(v));
    this.link.classList.add('is-open');
  }

  /* ---------------------------------------------------------------------
     Location readout — appears on arrival, then gets out of the way
     --------------------------------------------------------------------- */

  setLocation(name: string, sub: string, holdSeconds = 6): void {
    this.locName.textContent = name;
    this.locSub.textContent = sub;
    this.loc.classList.add('is-open');
    this.locTimer = holdSeconds;
  }

  /* ---------------------------------------------------------------------
     Interaction prompt
     --------------------------------------------------------------------- */

  /**
   * Show the contextual prompt. Passing an empty label hides it. Re-showing the
   * same prompt is a no-op, so callers can call this every frame.
   */
  setPrompt(label: string, key = 'E'): void {
    if (label === this.currentPrompt && this.promptShown === (label !== '')) return;

    this.currentPrompt = label;
    this.currentKey = key;

    if (!label) {
      this.prompt.classList.remove('is-open');
      this.promptShown = false;
      return;
    }

    this.promptKey.textContent = key;
    this.promptLabel.textContent = label;
    this.prompt.classList.add('is-open');
    this.promptShown = true;
  }

  /** The key currently bound to the interact action, or '' when nothing is. */
  get interactKey(): string {
    return this.promptShown ? this.currentKey : '';
  }

  /* ---------------------------------------------------------------------
     Toasts
     --------------------------------------------------------------------- */

  toast(text: string, tone?: 'discovery' | 'warn' | 'iso', duration = 3.4): void {
    const node = el('div', {
      class: tone ? `toast tone-${tone}` : 'toast',
      text,
    });

    this.toasts.appendChild(node);

    // Cap the stack: a burst of discoveries should not paper over the world.
    while (this.toasts.childElementCount > 3) {
      this.toasts.firstElementChild?.remove();
    }

    window.setTimeout(() => {
      node.classList.add('is-leaving');
      window.setTimeout(() => node.remove(), 440);
    }, duration * 1000);
  }

  /* ---------------------------------------------------------------------
     Objectives
     --------------------------------------------------------------------- */

  setObjectives(items: Array<{ label: string; done: boolean }>): void {
    clear(this.objList);
    for (const item of items) {
      this.objList.appendChild(
        el('div', { class: item.done ? 'obj is-done' : 'obj' }, [
          el('span', { class: 'dot', text: item.done ? '×' : '>' }),
          el('span', { text: item.label }),
        ]),
      );
    }
    this.objectives.classList.add('is-open');
  }

  hideObjectives(): void {
    this.objectives.classList.remove('is-open');
  }

  /* ---------------------------------------------------------------------
     Frame update
     --------------------------------------------------------------------- */

  update(dt: number): void {
    if (this.locTimer > 0) {
      this.locTimer -= dt;
      if (this.locTimer <= 0) this.loc.classList.remove('is-open');
    }

    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hint.classList.remove('is-open');
    }
  }

  /** Wipe transient state when a sector reloads. */
  reset(): void {
    clear(this.toasts);
    this.setPrompt('');
    this.link.classList.remove('is-open');
  }
}