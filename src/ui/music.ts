/* ============================================================================
   The radio strip.

   Four corners of the screen are already occupied — location top-left, settings
   top-right, energy bottom-left, LINK bottom-right — so this sits bottom-centre,
   the only place left that does not fight anything.

   It is deliberately almost absent. Collapsed, it is one thin line: the channel
   the broadcast is riding, the track's name, and five level pips. Nothing about
   it is a panel, a card or a dashboard. The transport opens only when asked, and
   folds itself away again on its own.

   The brief was explicit about this: a player occupying the interface was not
   wanted. So the transport is three glyphs and a slider, and they exist only
   while someone is actually reaching for them.
   ========================================================================== */

import { clamp01 } from '@/core/rng';
import type { AreaId, AudioEngine } from '@/audio/engine';
import { el, svgEl } from './dom';

/** How long the open panel waits before folding itself away, seconds. */
const FOLD_IDLE = 6;

/**
 * The broadcast channel each sector rides on.
 *
 * Fiction, but consistent fiction: the same sector always reads the same channel,
 * which is what makes the line informative rather than decorative. Ordered as
 * `AreaId` is declared, so adding an area is a one-line change here and
 * `CH 09` above it.
 */
const CHANNEL: Record<AreaId, string> = {
  grid: 'CH 01',
  arcade: 'CH 02',
  cycles: 'CH 03',
  archive: 'CH 04',
  security: 'CH 05',
  corrupt: 'CH 06',
  core: 'CH 07',
  iso: 'CH 08',
};

export interface MusicStrip {
  root: HTMLElement;
  show(): void;
  hide(): void;
  /** Advance the idle timer and push engine state onto the screen. */
  update(dt: number): void;
  /**
   * The browser refused the first gesture and the context is still suspended.
   *
   * The strip says so in the system's own voice and gets out of the way; the
   * player is never shown an autoplay policy, a codec, or a stack trace.
   */
  setBlocked(blocked: boolean): void;
}

/** An inline glyph. `svgEl` takes no children, so shapes are appended here. */
function icon(size: number, ...shapes: SVGElement[]): SVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', width: String(size), height: String(size) });
  for (const s of shapes) svg.appendChild(s);
  return svg;
}

export function createMusicStrip(root: HTMLElement, audio: AudioEngine): MusicStrip {
  /* --- collapsed line: channel · track · level pips --- */

  const channel = el('span', { class: 'radio-channel', text: 'CH 01' });
  const title = el('span', { class: 'radio-title', text: '' });

  const meter = el('i', { class: 'radio-meter' });
  const pips: HTMLElement[] = [];
  for (let i = 0; i < 5; i++) {
    const pip = el('i', { class: 'radio-pip' });
    pips.push(pip);
    meter.appendChild(pip);
  }

  const expandBtn = el('button', {
    class: 'radio-expand clickable',
    type: 'button',
    title: 'Radio controls',
    'aria-label': 'Radio controls',
  }, [
    icon(11, svgEl('path', {
      d: 'M3 10 L8 5 L13 10',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.3',
    })),
  ]);

  const head = el('div', { class: 'radio-head' }, [channel, title, meter, expandBtn]);

  /* --- the "tune in" prompt shown when autoplay was refused --- */

  const blockedNote = el('span', { class: 'radio-blocked', text: 'SIGNAL LOST · CLICK TO TUNE IN' });

  /* --- transport --- */

  const playPath = svgEl('path', { d: 'M4 2 L13 8 L4 14 Z', fill: 'currentColor' });
  const playBtn = el('button', {
    class: 'radio-btn radio-play clickable',
    type: 'button',
    title: 'Radio on/off',
    'aria-label': 'Radio on/off',
  }, [icon(13, playPath)]);

  const prevBtn = el('button', {
    class: 'radio-btn clickable',
    type: 'button',
    title: 'Previous track',
    'aria-label': 'Previous track',
  }, [
    icon(13,
      svgEl('path', { d: 'M12 2 L5 8 L12 14 Z', fill: 'currentColor' }),
      svgEl('path', { d: 'M4 2 H2.2 V14 H4 Z', fill: 'currentColor' })),
  ]);

  const nextBtn = el('button', {
    class: 'radio-btn clickable',
    type: 'button',
    title: 'Next track',
    'aria-label': 'Next track',
  }, [
    icon(13,
      svgEl('path', { d: 'M4 2 L11 8 L4 14 Z', fill: 'currentColor' }),
      svgEl('path', { d: 'M11.8 2 H13.8 V14 H11.8 Z', fill: 'currentColor' })),
  ]);

  const volume = el('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '1',
    value: String(Math.round(audio.musicVolume * 100)),
    class: 'radio-volume',
    'aria-label': 'Music volume',
  }) as HTMLInputElement;

  const upNext = el('span', { class: 'radio-next', text: '' });

  const panel = el('div', { class: 'radio-panel' }, [
    el('div', { class: 'radio-transport' }, [prevBtn, playBtn, nextBtn]),
    el('label', { class: 'radio-volume-wrap' }, [volume]),
    upNext,
  ]);

  const fill = el('i', { class: 'radio-fill' });
  const trackBar = el('div', { class: 'radio-track' }, [fill]);

  const strip = el('div', { class: 'radio' }, [head, blockedNote, panel, trackBar]);

  root.appendChild(strip);

  /* --- state --- */

  let open = false;
  let idle = 0;
  let visible = false;
  let blocked = false;
  let lastChannel = '';
  let lastTitle = '';

  function setOpen(next: boolean): void {
    if (open === next) return;
    open = next;
    idle = 0;
    strip.classList.toggle('is-open', open);
  }

  /** Any interaction with the strip opens it and restarts the idle countdown. */
  function wake(): void {
    idle = 0;
    if (!open) setOpen(true);
  }

  /** Clicks never reach the world: the strip sits over the canvas. */
  function onControlClick(fn: () => void): (ev: Event) => void {
    return (ev) => {
      ev.stopPropagation();
      fn();
      wake();
    };
  }

  expandBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    setOpen(!open);
  });
  prevBtn.addEventListener('click', onControlClick(() => audio.previousTrack()));
  nextBtn.addEventListener('click', onControlClick(() => audio.nextTrack()));
  playBtn.addEventListener('click', onControlClick(() => audio.setMusicEnabled(!audio.musicEnabled)));

  volume.addEventListener('input', () => {
    const v = Number(volume.value) / 100;
    audio.setMusicVolume(v);
    // Dragging the slider off zero while the radio is switched off is a request
    // to hear something, not just to move a handle.
    if (v > 0 && !audio.musicEnabled) audio.setMusicEnabled(true);
    sync();
    wake();
  });

  /**
   * Push engine state onto the screen.
   *
   * Every write is guarded by a comparison. This runs every frame, and writing
   * `textContent` with the string already there is still a mutation — it
   * invalidates layout for a line that has not changed, sixty times a second.
   */
  function sync(): void {
    if (!visible) return;

    const track = audio.nowPlaying;
    const ch = CHANNEL[track.area];
    if (ch !== lastChannel) {
      lastChannel = ch;
      channel.textContent = ch;
    }

    if (track.title !== lastTitle) {
      lastTitle = track.title;
      title.textContent = track.title;
    }

    const on = audio.musicEnabled;
    playBtn.classList.toggle('is-off', !on);
    playPath.setAttribute(
      'd',
      on ? 'M4 2 L13 8 L4 14 Z' : 'M3 2 H5 V14 H3 Z M7 2 H9 V14 H7 Z M11 2 H13 V14 H11 Z',
    );
    playBtn.title = on ? 'Radio on/off' : 'Radio silent — click to resume';

    // The pips read the same pulse the Grid's shaders read, so the strip is
    // genuinely part of the world rather than a widget pasted over it.
    const lit = clamp01(audio.pulse) * pips.length;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('is-lit', on && lit > i);

    if (!open) return;

    const pct = clamp01(audio.trackPosition / Math.max(1, audio.trackLength));
    fill.style.width = `${(pct * 100).toFixed(2)}%`;
    upNext.textContent = `NEXT · ${audio.upNext.title}`;
  }

  return {
    root: strip,

    show() {
      visible = true;
      strip.classList.add('is-visible');
      sync();
    },

    hide() {
      visible = false;
      setOpen(false);
      strip.classList.remove('is-visible');
    },

    update(dt: number) {
      if (!visible) return;
      sync();

      if (open) {
        idle += dt;
        if (idle > FOLD_IDLE) setOpen(false);
      }
    },

    setBlocked(next: boolean) {
      blocked = next;
      strip.classList.toggle('is-blocked', blocked);
      // While blocked there is nothing to listen to, so the transport is noise.
      // The prompt folds itself away as soon as the context starts.
      if (visible) setOpen(blocked);
    },
  };
}