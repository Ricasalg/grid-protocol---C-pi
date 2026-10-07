/* ============================================================================
   Network content model.

   The Grid is a graph of nodes, not a list of levels. Every node has exactly
   one parent, which is what lets the map start almost empty and fill in as the
   player discovers edges — you only ever learn about a node by walking to its
   neighbour, or by opening a file that names it.

   Nothing in this file imports engine code; it is the contract that the JSON
   content and the runtime both agree on.
   ========================================================================== */

/** How a node is represented in the 3D world and how it plays. */
export type NodeKind =
  /** An open area you walk through. */
  | 'sector'
  /** A file-like object that acts as a door. */
  | 'file'
  /** An arena/mini-game. */
  | 'arena'
  /** Readable content: terminals, logs, memories. */
  | 'archive'
  /** A hostile process. */
  | 'security'
  /** Visibly damaged data. */
  | 'corrupt'
  /** The ISO's presence. Always rendered differently. */
  | 'iso';

/** Discovery state, the progression the map visualises. */
export type NodeState = 'unknown' | 'known' | 'current';

export interface NodeDef {
  id: string;
  /** Display name. Unknown nodes never show their real name. */
  name: string;
  /** Shown instead of the name while the node is undiscovered. */
  unknownLabel?: string;
  kind: NodeKind;

  /** Parent node id. The map root has none. */
  parent: string | null;

  /**
   * Minimum ACCESS level required. Locked nodes are visible on the map (you
   * know they exist) but cannot be entered.
   */
  access: number;

  /** One-line subtitle under the name in the location readout. */
  subtitle: string;

  /** Short prose for when the node is opened as a terminal. */
  /** Empty for nodes with no readable surface. */
  description?: string;

  /** Map layout, normalised 0..1 within the map canvas. */
  map: { x: number; y: number };

  /** Audio identity while this node is the active area. */
  music?: string;

  /**
   * Opening this node sets these flags. Used by the narrative layer to record
   * that a beat has happened.
   */
  setsFlags?: string[];

  /** Unlocks this other node when opened (file-doors revealing new places). */
  reveals?: string[];

  /** Whether opening it counts as a first discovery for the toasts. */
  silent?: boolean;
}

/** Static network layout, loaded once at boot. */
export interface NetworkData {
  root: string;
  nodes: NodeDef[];
}

export function findNode(data: NetworkData, id: string): NodeDef | undefined {
  return data.nodes.find((n) => n.id === id);
}

/** Direct children of a node. */
export function childrenOf(data: NetworkData, id: string): NodeDef[] {
  return data.nodes.filter((n) => n.parent === id);
}

/** The chain from the root down to `id`, root first. Used for breadcrumbs. */
export function pathTo(data: NetworkData, id: string): NodeDef[] {
  const chain: NodeDef[] = [];
  let cursor = findNode(data, id);
  const guard = new Set<string>();

  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parent ? findNode(data, cursor.parent) : undefined;
  }

  return chain;
}