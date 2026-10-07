/* ============================================================================
   Network registry: which nodes exist, which the player has found, and how the
   map should present them.

   This owns the discovery state machine from the brief:
     UNKNOWN NODE  ->  DISCOVERED  ->  ARCHIVE SECTOR

   A node is *known* once the player has entered it or opened it as a file.
   Its children stay unknown until it is known — so arriving somewhere reveals
   the shape of the next place, but never the place after that. That is the
   whole trick behind "I'm not browsing pages, I'm discovering a network".
   ========================================================================== */

import networkJson from '@/data/network.json';
import { bus } from '@/core/bus';
import { loadSave, mutate } from '@/core/save';
import type { NetworkData, NodeDef, NodeState } from './types';

const data = networkJson as NetworkData;

export { data as NETWORK };
export type { NodeDef, NodeState };

export function getNode(id: string): NodeDef | undefined {
  return data.nodes.find((n) => n.id === id);
}

export function allNodes(): NodeDef[] {
  return data.nodes;
}

export function rootNode(): NodeDef {
  const root = data.nodes.find((n) => n.id === data.root);
  if (!root) throw new Error('network.json has no root node');
  return root;
}

export function childrenOf(id: string): NodeDef[] {
  return data.nodes.filter((n) => n.parent === id);
}

/** Every node, in discovery order from the root. Used for the map layout. */
export function isKnown(id: string): boolean {
  return loadSave().discoveredSectors.includes(id);
}

/** A node is visible on the map if it or an ancestor is known. */
export function isVisible(id: string): boolean {
  const node = getNode(id);
  if (!node) return false;
  if (isKnown(id)) return true;
  // Direct children of a known node appear as undiscovered hints.
  return node.parent !== null && isKnown(node.parent);
}

/** Whether the player's ACCESS level lets them enter. */
export function isUnlocked(id: string): boolean {
  const node = getNode(id);
  if (!node) return false;
  return loadSave().stats.access >= node.access;
}

/** Current state, for the map renderer. */
export function stateOf(id: string, currentId: string): NodeState {
  if (id === currentId) return 'current';
  if (isKnown(id)) return 'known';
  return 'unknown';
}

/* -------------------------------------------------------------------------
   Discovery
   ------------------------------------------------------------------------- */

/**
 * Mark a node discovered. Idempotent: only the first call emits and records
 * flags, so returning to the Plaza does not re-fire the arrival toast.
 */
export function discover(id: string, opts: { silent?: boolean } = {}): boolean {
  const node = getNode(id);
  if (!node) return false;

  const save = loadSave();
  if (save.discoveredSectors.includes(id)) return false;

  mutate((s) => {
    s.discoveredSectors.push(id);
    if (node.setsFlags) {
      for (const f of node.setsFlags) s.flags[f] = true;
    }
    // Discovery is worth a little DATA — the reward loop for exploring.
    s.stats.data += 25;
    s.stats.reputation += 5;
    for (const r of node.reveals ?? []) {
      if (!s.openedFiles.includes(r)) s.openedFiles.push(r);
    }
  });

  if (!node.silent && !opts.silent) {
    bus.emit('node:discovered', { id, name: node.name });
  }

  bus.emit('sector:enter', { id, firstTime: true });
  return true;
}

/** Fast-travel anchor: unlocked when the node is discovered. */
export function isTravelUnlocked(id: string): boolean {
  return loadSave().unlockedNodes.includes(id) || isKnown(id);
}

/** Record an opened file-node without granting full node knowledge. */
export function markOpened(id: string, kind: string): void {
  const save = loadSave();
  if (save.openedFiles.includes(id)) return;
  mutate((s) => {
    s.openedFiles.push(id);
    s.stats.data += 40;
  });
  bus.emit('node:opened', { id, kind });
}

/** Breadcrumb trail for the location readout. */
export function pathTo(id: string): string[] {
  const chain: string[] = [];
  let cursor = getNode(id);
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    chain.unshift(cursor.name);
    cursor = cursor.parent ? getNode(cursor.parent) : undefined;
  }
  return chain;
}