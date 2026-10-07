/* ============================================================================
   Touch controls.

   Only mounted on touch devices. The stick and the look area are handled by
   the player controller itself (it listens on the canvas), so this module
   only has to draw the stick and provide the interact button.
   ========================================================================== */

import { el } from './dom';

export interface TouchControls {
  root: HTMLElement;
  stick: HTMLElement;
  knob: HTMLElement;
  action: HTMLElement;
  show(): void;
  hide(): void;
  setActionVisible(visible: boolean, label?: string): void;
  setActionLabel(label: string): void;
}

export function createTouchControls(root: HTMLElement): TouchControls {
  const knob = el('div', { class: 'stick-knob' });
  const stick = el('div', { class: 'stick' }, [knob]);

  const actionLabel = el('span', { text: 'E' });
  const action = el('button', { class: 'touch-act' }, [actionLabel]);

  const layer = el('div', { class: 'touch-layer' }, [stick, action]);
  root.appendChild(layer);

  return {
    root: layer,
    stick,
    knob,
    action,
    show() {
      layer.classList.add('is-on');
    },
    hide() {
      layer.classList.remove('is-on');
    },
    setActionVisible(visible) {
      action.style.display = visible ? '' : 'none';
    },
    setActionLabel(label) {
      actionLabel.textContent = label;
    },
  };
}