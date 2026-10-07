/* ============================================================================
   Digital sector map.

   Opens on Tab. It is not a menu — it is a readout of what the player has
   actually seen. Undiscovered nodes render as dim outlines labelled
   UNKNOWN NODE; discovered ones show their real name; locked ones show amber.
   Edges appear only once both ends are known, which is what sells the map as a
   picture of a discovered network rather than a diagram of a designed one.
   ========================================================================== */

import { bus } from '@/core/bus';
import { el, svgEl, clear } from './dom';
import { allNodes, isVisible, stateOf, isUnlocked, getNode } from '@/nodes/network';
import type { NodeDef } from '@/nodes/types';

/** SVG viewBox is 0..100 on both axes; node coords are normalised 0..1. */
const VB = 100;

export class MapOverlay {
  readonly root: HTMLElement;

  private readonly overlay: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly linksNode: SVGElement;
  private readonly nodesNode: SVGElement;
  private readonly statusNode: HTMLElement;

  private currentId = 'plaza';
  private openState = false;

  constructor(root: HTMLElement) {
    this.root = root;

    this.linksNode = svgEl('g', {});
    this.nodesNode = svgEl('g', {});
    this.statusNode = el('div', { class: 'mono-label', style: 'margin-top:14px;text-align:center' });

    this.svg = svgEl('svg', {
      viewBox: `0 0 ${VB} ${VB}`,
      preserveAspectRatio: 'xMidYMid meet',
    });
    this.svg.appendChild(this.linksNode);
    this.svg.appendChild(this.nodesNode);

    this.overlay = el('div', { class: 'map', role: 'dialog', 'aria-label': 'Network map' }, [
      el('div', { class: 'map-canvas bracket' }, [this.svg]),
      this.statusNode,
    ]);

    root.appendChild(this.overlay);

    bus.on('node:discovered', () => {
      if (this.openState) this.render();
    });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  setCurrent(id: string): void {
    this.currentId = id;
  }

  toggle(): void {
    if (this.openState) this.close();
    else this.show();
  }

  show(): void {
    this.render();
    this.openState = true;
    this.overlay.classList.add('is-open');
  }

  close(): void {
    this.openState = false;
    this.overlay.classList.remove('is-open');
  }

  handleKey(code: string): boolean {
    if (!this.openState) return false;
    if (code === 'Tab' || code === 'Escape' || code === 'KeyM') {
      this.close();
      return true;
    }
    return false;
  }

  private render(): void {
    clear(this.linksNode);
    clear(this.nodesNode);

    const nodes = allNodes().filter((n) => isVisible(n.id));

    /* --- edges: only between two visible nodes --- */
    for (const node of nodes) {
      if (!node.parent) continue;
      const parent = getNode(node.parent);
      if (!parent || !isVisible(parent.id)) continue;

      // A link is "hot" when it leads somewhere the player can actually go.
      const hot = stateOf(node.id, this.currentId) !== 'unknown' && isUnlocked(node.id);

      const line = svgEl('line', {
        class: hot ? 'map-link is-hot' : 'map-link',
        x1: parent.map.x * VB,
        y1: parent.map.y * VB,
        x2: node.map.x * VB,
        y2: node.map.y * VB,
      });
      this.linksNode.appendChild(line);
    }

    /* --- nodes --- */
    for (const node of nodes) {
      const state = stateOf(node.id, this.currentId);
      const unlocked = isUnlocked(node.id);

      const classes = ['map-node'];
      if (state === 'unknown') classes.push('is-unknown');
      else classes.push('is-known');
      if (state === 'current') classes.push('is-current');
      if (!unlocked) classes.push('is-locked');

      const cx = node.map.x * VB;
      const cy = node.map.y * VB;

      const label =
        state === 'unknown' ? (node.unknownLabel ?? 'UNKNOWN NODE') : node.name;

      const group = svgEl('g', { class: classes.join(' '), tabindex: '0' });

      const title = svgEl('title', { text: `${label} — ${node.subtitle}` });
      group.appendChild(title);

      group.appendChild(svgEl('circle', { class: 'node-ring', cx, cy, r: 9 }));
      group.appendChild(svgEl('circle', { class: 'node-core', cx, cy, r: 2.6 }));

      const text = svgEl('text', { class: 'node-label', x: cx, y: cy + 16, text: label });
      group.appendChild(text);

      // An ACCESS lock is worth saying out loud.
      if (!unlocked) {
        const lock = svgEl('text', {
          class: 'node-label',
          x: cx,
          y: cy - 13,
          text: `ACCESS ${node.access}`,
        });
        group.appendChild(lock);
      }

      this.nodesNode.appendChild(group);
    }

    const known = nodes.filter((n) => stateOf(n.id, this.currentId) !== 'unknown').length;
    this.statusNode.textContent =
      `DISCOVERED ${known} / ${allNodes().length} NODES · TAB TO CLOSE`;
  }

  /** Nodes laid out for the minimap-less world. Exposed for debug overlays. */
  layout(): Array<NodeDef & { state: string }> {
    return allNodes().map((n) => ({ ...n, state: stateOf(n.id, this.currentId) }));
  }
}