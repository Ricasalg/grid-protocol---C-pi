/* ============================================================================
   Settings drawer.

   Opens on Escape, or from a discreet corner button. Contains volume and mute
   (required by the brief), plus the accessibility and quality switches that
   the rest of the engine actually reads.

   It also contains the save deletion control. That is a deliberate, visible,
   one-click-destructive action: it removes the single localStorage key this
   project owns and nothing else. The confirmation step exists so the button
   cannot be hit by accident.
   ========================================================================== */

import { bus } from '@/core/bus';
import { deleteSave, flushNow, loadSettings, saveSettings } from '@/core/save';
import type { AudioEngine } from '@/audio/engine';
import { el } from './dom';

export class SettingsDrawer {
  readonly root: HTMLElement;

  private readonly drawer: HTMLElement;
  private readonly volumeValue: HTMLElement;
  private readonly volumeInput: HTMLInputElement;
  private readonly muteToggle: HTMLInputElement;
  private readonly musicValue: HTMLElement;
  private readonly musicInput: HTMLInputElement;
  private readonly musicToggle: HTMLInputElement;
  private readonly qualitySelect: HTMLSelectElement;
  private readonly motionSelect: HTMLSelectElement;
  private readonly bobToggle: HTMLInputElement;
  private readonly invertToggle: HTMLInputElement;
  private readonly flashToggle: HTMLInputElement;

  private openState = false;
  private confirmingWipe = false;
  private readonly wipeBtn: HTMLButtonElement;
  private readonly wipeNote: HTMLElement;

  constructor(root: HTMLElement, audio: AudioEngine) {
    this.root = root;

    /* --- volume --- */
    const settings = loadSettings();
    this.volumeValue = el('span', { class: 'value', text: `${Math.round(settings.masterVolume * 100)}%` });

    this.volumeInput = el('input', {
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: String(Math.round(settings.masterVolume * 100)),
      'aria-label': 'Master volume',
    }) as HTMLInputElement;

    this.volumeInput.addEventListener('input', () => {
      const v = Number(this.volumeInput.value) / 100;
      audio.setVolume(v);
      this.volumeValue.textContent = `${this.volumeInput.value}%`;
    });

    /* --- mute --- */
    this.muteToggle = el('input', {
      type: 'checkbox',
      id: 'set-mute',
      checked: settings.muted,
    }) as HTMLInputElement;

    this.muteToggle.addEventListener('change', () => {
      audio.setMuted(this.muteToggle.checked);
    });

    /* --- music --- */
    // The radio has its own level, separate from the master, so the soundtrack
    // can be turned down for its own sake without touching footsteps or alarms.
    this.musicValue = el('span', {
      class: 'value',
      text: `${Math.round(settings.musicVolume * 100)}%`,
    });

    this.musicInput = el('input', {
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: String(Math.round(settings.musicVolume * 100)),
      'aria-label': 'Music volume',
    }) as HTMLInputElement;

    this.musicInput.addEventListener('input', () => {
      const v = Number(this.musicInput.value) / 100;
      audio.setMusicVolume(v);
      this.musicValue.textContent = `${this.musicInput.value}%`;
    });

    this.musicToggle = el('input', {
      type: 'checkbox',
      id: 'set-music',
      checked: settings.musicEnabled,
    }) as HTMLInputElement;

    this.musicToggle.addEventListener('change', () => {
      audio.setMusicEnabled(this.musicToggle.checked);
    });

    /* --- quality --- */
    this.qualitySelect = el('select', {
      id: 'set-quality',
      class: 'value',
      style:
        'background:transparent;border:1px solid var(--line);color:var(--ice);padding:6px 8px;font-family:inherit;font-size:11px;letter-spacing:.18em',
    }) as HTMLSelectElement;

    for (const [value, label] of [
      ['auto', 'AUTO'],
      ['high', 'HIGH'],
      ['medium', 'MEDIUM'],
      ['low', 'LOW'],
    ]) {
      this.qualitySelect.appendChild(el('option', { value, text: label }));
    }
    this.qualitySelect.value = settings.quality;

    this.qualitySelect.addEventListener('change', () => {
      saveSettings({ quality: this.qualitySelect.value as typeof settings.quality });
      bus.emit('quality:changed', { tier: this.qualitySelect.value });
    });

    /* --- reduced motion --- */
    this.motionSelect = el('select', {
      id: 'set-motion',
      class: 'value',
      style:
        'background:transparent;border:1px solid var(--line);color:var(--ice);padding:6px 8px;font-family:inherit;font-size:11px;letter-spacing:.18em',
    }) as HTMLSelectElement;

    for (const [value, label] of [
      ['auto', 'SYSTEM'],
      ['on', 'REDUCE'],
      ['off', 'FULL'],
    ]) {
      this.motionSelect.appendChild(el('option', { value, text: label }));
    }
    this.motionSelect.value = settings.reducedMotion;

    this.motionSelect.addEventListener('change', () => {
      saveSettings({
        reducedMotion: this.motionSelect.value as 'auto' | 'on' | 'off',
      });
      // Head bob and camera motion both read `motionOk`, which consults the
      // override each frame, so no further wiring is needed.
    });

    /* --- accessibility toggles --- */
    this.bobToggle = this.makeToggle('set-bob', settings.headBob, (on) =>
      saveSettings({ headBob: on }),
    );
    this.invertToggle = this.makeToggle('set-invert', settings.invertY, (on) =>
      saveSettings({ invertY: on }),
    );
    this.flashToggle = this.makeToggle('set-flash', settings.reducedFlash, (on) => {
      saveSettings({ reducedFlash: on });
      document.body.classList.toggle('reduced-flash', on);
    });

    /* --- save deletion --- */
    this.wipeNote = el('div', { class: 'settings-note', text: 'Progress is stored only in this browser.' });
    this.wipeBtn = el('button', {
      class: 'danger-btn',
      text: 'DELETE SAVE',
      onclick: () => this.handleWipe(),
    }) as HTMLButtonElement;

    this.drawer = el('div', { class: 'settings', role: 'dialog', 'aria-label': 'Settings' }, [
      el('div', { class: 'mono-label', text: 'SETTINGS' }),
      el('hr', { class: 'rule' }),

      this.row('VOLUME', [this.volumeValue, this.volumeInput]),
      this.rowLabel('MUTE', this.muteToggle, 'set-mute'),
      this.row('MUSIC', [this.musicValue, this.musicInput]),
      this.rowLabel('RADIO', this.musicToggle, 'set-music'),

      el('hr', { class: 'rule' }),

      this.row('QUALITY', [this.qualitySelect]),
      this.row('REDUCED MOTION', [this.motionSelect]),
      this.rowLabel('HEAD BOB', this.bobToggle, 'set-bob'),
      this.rowLabel('INVERT Y', this.invertToggle, 'set-invert'),
      this.rowLabel('REDUCE FLASHING', this.flashToggle, 'set-flash'),

      el('hr', { class: 'rule' }),

      this.wipeNote,
      this.wipeBtn,
    ]);

    root.appendChild(this.drawer);

    // Reflect the reduced-flash preference on load.
    if (settings.reducedFlash) document.body.classList.add('reduced-flash');
  }

  /**
   * A labelled checkbox. The visible label is built by `row()`; here we only
   * need the input itself, wired to persist on change.
   */
  private makeToggle(
    id: string,
    initial: boolean,
    onChange: (on: boolean) => void,
  ): HTMLInputElement {
    const input = el('input', { type: 'checkbox', id, checked: initial }) as HTMLInputElement;
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  private row(label: string, children: Array<Node | null>): HTMLElement {
    return el('div', { class: 'settings-row' }, [
      el('label', { text: label }),
      el('div', { class: 'settings-row', style: 'gap:9px' }, children),
    ]);
  }

  private rowLabel(label: string, input: HTMLInputElement, id: string): HTMLElement {
    return el('label', { class: 'settings-row toggle', for: id }, [
      el('span', { class: 'mono-label', text: label }),
      input,
    ]);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  toggle(): void {
    if (this.openState) this.close();
    else this.show();
  }

  show(): void {
    // Reset the destructive button every time the drawer opens.
    this.confirmingWipe = false;
    this.wipeBtn.textContent = 'DELETE SAVE';
    this.wipeBtn.classList.remove('is-armed');
    this.openState = true;
    this.drawer.classList.add('is-open');
  }

  close(): void {
    this.openState = false;
    this.drawer.classList.remove('is-open');
  }

  /** Two-step confirmation, then a full local wipe and a reload. */
  private handleWipe(): void {
    if (!this.confirmingWipe) {
      this.confirmingWipe = true;
      this.wipeBtn.textContent = 'CONFIRM — ERASE ALL PROGRESS';
      this.wipeBtn.classList.add('is-armed');
      window.setTimeout(() => {
        if (!this.confirmingWipe) return;
        this.confirmingWipe = false;
        this.wipeBtn.textContent = 'DELETE SAVE';
        this.wipeBtn.classList.remove('is-armed');
      }, 4000);
      return;
    }

    deleteSave();
    // Make sure nothing pending re-writes the save we just removed.
    flushNow();
    bus.emit('save:wiped', {});
    window.location.reload();
  }

  handleKey(code: string): boolean {
    if (!this.openState) return false;
    if (code === 'Escape' || code === 'KeyO') {
      this.close();
      return true;
    }
    return false;
  }
}