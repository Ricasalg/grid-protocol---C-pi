/* ============================================================================
   Persistence.

   Everything the player accumulates lives in one namespaced localStorage key.
   Nothing here touches the filesystem, the network, or any user document — the
   save is a handful of JSON bytes the browser keeps for this origin.

   The player can wipe it from the settings drawer (Settings -> Delete Save),
   which is also exposed on the boot screen so it is reachable before any game
   state exists.
   ========================================================================== */

const KEY = 'grid-protocol.save.v1';
const SETTINGS_KEY = 'grid-protocol.settings.v1';

export interface MemoryFragment {
  id: string;
  title: string;
  /** Where it was found, for the memories list. */
  sector: string;
  /** ISO-unlocked memories are only listed once LINK is high enough. */
  iso?: boolean;
}

export interface SaveData {
  version: number;
  createdAt: number;
  updatedAt: number;

  /** Total time connected, seconds. */
  playtime: number;

  stats: {
    level: number;
    energy: number;
    data: number;
    access: number;
    reputation: number;
  };

  /** Bond with the ISO, 0..100. Three ending bands key off this. */
  link: number;

  /** Sector ids the player has entered at least once. */
  discoveredSectors: string[];

  /** File/node ids opened. */
  openedFiles: string[];

  /** Collected memory fragments (ISO's memories). */
  memories: MemoryFragment[];

  /** Terminal/log lines that persist as "read" markers. */
  readLogs: string[];

  /** Fast-travel anchors unlocked by exploration. */
  unlockedNodes: string[];

  /** Permanent roguelike upgrades purchased with DATA. */
  upgrades: string[];

  /** Quest flags: arbitrary named booleans set by story beats. */
  flags: Record<string, boolean>;

  /** Counters, e.g. cycles wins/losses. */
  counters: Record<string, number>;

  /** Which ending the player reached, if any. Locks the narrative. */
  ending: string | null;

  /** Whether the cinematic descent has been watched at least once. */
  seenDescent: boolean;

  /** Random seed of the current run, so a death re-rolls the same Grid. */
  runSeed: number;
}

export interface Settings {
  masterVolume: number;
  muted: boolean;
  quality: 'low' | 'medium' | 'high' | 'auto';
  headBob: boolean;
  invertY: boolean;
  sensitivity: number;
  reducedFlash: boolean;
  /**
   * Player-facing override for reduced motion.
   *
   * `prefers-reduced-motion` is honoured on load (see config.prefersReducedMotion),
   * but that only helps users whose operating system already carries the setting.
   * Anyone who gets motion sick here without that OS flag needs a way in.
   * `auto` defers to the system; true/false override it.
   */
  reducedMotion: 'auto' | 'on' | 'off';

  /**
   * Whether the radio plays at all. Separate from `muted` on purpose: muting
   * silences the whole game, while this turns off just the music and leaves
   * footsteps, alarms and interface sounds exactly where they are.
   */
  musicEnabled: boolean;

  /**
   * Music level, 0..1. A separate gain from `masterVolume` so the soundtrack
   * can be turned down for its own sake — a long ambient drone at full volume
   * is tiring in a way that one at a quarter is not.
   */
  musicVolume: number;
}

const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.8,
  muted: false,
  quality: 'auto',
  headBob: true,
  invertY: false,
  sensitivity: 1.0,
  reducedFlash: false,
  reducedMotion: 'auto',
  musicEnabled: true,
  musicVolume: 0.7,
};

function newSave(): SaveData {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    playtime: 0,
    stats: { level: 1, energy: 100, data: 0, access: 1, reputation: 0 },
    link: 0,
    discoveredSectors: [],
    openedFiles: [],
    memories: [],
    readLogs: [],
    unlockedNodes: [],
    upgrades: [],
    flags: {},
    counters: {},
    ending: null,
    seenDescent: false,
    runSeed: randomSeed(),
  };
}

export function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

let cache: SaveData | null = null;
let settingsCache: Settings | null = null;
let flushHandle = 0;

/** localStorage can throw (private mode, quota, disabled). Never let it crash. */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage unavailable — the run simply won't persist. */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------
   Save
   ------------------------------------------------------------------------- */

export function loadSave(): SaveData {
  if (cache) return cache;

  const raw = safeGet(KEY);
  if (!raw) {
    cache = newSave();
    return cache;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    // Merge onto a fresh save so a save written by an older build still loads
    // with every field present.
    const base = newSave();
    cache = {
      ...base,
      ...parsed,
      stats: { ...base.stats, ...(parsed.stats ?? {}) },
      flags: { ...(parsed.flags ?? {}) },
      counters: { ...(parsed.counters ?? {}) },
      // Arrays: trust the shape if present, otherwise fall back to empty.
      discoveredSectors: parsed.discoveredSectors ?? [],
      openedFiles: parsed.openedFiles ?? [],
      memories: parsed.memories ?? [],
      readLogs: parsed.readLogs ?? [],
      unlockedNodes: parsed.unlockedNodes ?? [],
      upgrades: parsed.upgrades ?? [],
    };
  } catch {
    // Corrupt payload — start clean rather than trapping the player.
    cache = newSave();
  }

  return cache;
}

/**
 * Persist, coalesced. Many systems mutate the save during a frame (data
 * pickups, discovery, playtime); writing on every one would stall the main
 * thread, so we batch writes into an idle callback.
 */
export function save(): void {
  if (!cache) return;
  cache.updatedAt = Date.now();

  if (flushHandle) return;
  flushHandle = requestIdleCallbackShim(() => {
    flushHandle = 0;
    flushNow();
  });
}

export function flushNow(): void {
  if (!cache) return;
  safeSet(KEY, JSON.stringify(cache));
}

/** Test/debug helper: current save without touching storage. */
export function peekSave(): SaveData {
  return loadSave();
}

export function deleteSave(): void {
  cache = null;
  safeRemove(KEY);
}

/**
 * Mutate the save through a callback. Keeps call sites declarative:
 *   mutate(s => { s.stats.data += 10 })
 */
export function mutate(fn: (s: SaveData) => void): SaveData {
  const s = loadSave();
  fn(s);
  save();
  return s;
}

/* -------------------------------------------------------------------------
   Settings (separate key: settings must survive a save wipe)
   ------------------------------------------------------------------------- */

export function loadSettings(): Settings {
  if (settingsCache) return settingsCache;

  const raw = safeGet(SETTINGS_KEY);
  if (!raw) {
    settingsCache = { ...DEFAULT_SETTINGS };
    return settingsCache;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    settingsCache = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    settingsCache = { ...DEFAULT_SETTINGS };
  }

  return settingsCache;
}

export function saveSettings(next: Partial<Settings>): Settings {
  const merged = { ...loadSettings(), ...next };
  settingsCache = merged;
  safeSet(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

/* -------------------------------------------------------------------------
   requestIdleCallback shim — Safari lacks it.
   ------------------------------------------------------------------------- */

function requestIdleCallbackShim(fn: () => void): number {
  const ric = (
    globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    }
  ).requestIdleCallback;

  if (typeof ric === 'function') return ric(fn, { timeout: 400 });

  return window.setTimeout(fn, 120);
}