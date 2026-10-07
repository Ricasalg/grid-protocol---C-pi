/* ============================================================================
   Typed event bus.

   Systems never import each other. The Grid world, the ISO, the audio engine,
   the HUD and the narrative layer all talk through this. Handlers are held in
   a Map, so unsubscribing is exact — no leaks when a sector tears down.
   ========================================================================== */

/**
 * The full event vocabulary. Keeping it in one interface means a typo is a
 * compile error rather than a silent no-op at runtime.
 */
export interface Events {
  /* --- flow / chapters --- */
  'boot:complete': { t: number };
  'boot:start-jackin': { viaKeyboard: boolean };
  'descent:complete': { t: number };
  'descent:skipped': { atPhase: string };
  'player:control': { t: number };

  /* --- world / sectors --- */
  'sector:enter': { id: string; firstTime: boolean };
  'sector:leave': { id: string };
  'node:discovered': { id: string; name: string };
  'node:opened': { id: string; kind: string };

  /* --- player --- */
  'player:teleport': { to: string; reason: string };
  'player:damage': { amount: number; source: string };
  'player:died': { cause: string };
  'player:levelup': { level: number };

  /* --- progression --- */
  'stat:changed': { key: string; value: number; delta: number };
  'data:gained': { amount: number; reason: string };
  'access:changed': { level: number };
  'unlock:upgrade': { id: string };

  /* --- ISO --- */
  'iso:met': { firstTime: boolean };
  'iso:line': { id: string };
  'iso:link-changed': { value: number; delta: number };
  'iso:unlocked': { what: string };

  /* --- ui --- */
  'toast': { text: string; tone?: 'discovery' | 'warn' | 'iso'; duration?: number };
  'hud:control-hint': { show: boolean };
  'save:wiped': Record<string, never>;

  /* --- misc --- */
  'quality:changed': { tier: string };
  'cycle:win': { score: number; rank: string };
  'cycle:lose': { reason: string };
  'ending:reached': { id: string };
}

type Handler<T> = (payload: T) => void;

/** Specificity: handlers keyed by the event name they subscribe to. */
export class EventBus {
  private map = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(handler as Handler<never>);

    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  /** Subscribe for exactly one delivery. */
  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.map.get(event);
    if (!set) return;

    // Copy before iterating: a handler may unsubscribe itself or a sibling.
    for (const handler of Array.from(set)) {
      try {
        (handler as Handler<Events[K]>)(payload);
      } catch (err) {
        // One bad listener must not take down the frame.
        console.error(`[bus] handler for "${String(event)}" threw:`, err);
      }
    }
  }

  /** Remove every handler (used on hard teardown / save wipe). */
  clear(): void {
    this.map.clear();
  }
}

/** The single bus instance for the whole app. */
export const bus = new EventBus();