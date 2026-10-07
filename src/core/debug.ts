/* ============================================================================
   Debug flags — query-string shortcuts for testing without replaying the opening.

   These exist because of a specific failure, recorded in ESTADO-DO-PROJECTO.md
   §6.3: a whole phase was reported complete on the strength of "it typechecks and
   it builds", and nobody had opened the page. Typecheck proves the types are
   right; build proves the modules are valid. Neither says what appears on screen.

   So the acceptance criteria for every milestone are visual, and testing them
   should not require walking 150m down the light path each time. These flags jump
   straight to the thing under test.

   SAFETY (§2): this reads location.search and nothing else. No filesystem, no
   network, no storage. A flag is a URL the developer types; the player never sees
   one unless they are the developer.

   Not shipped in a way that matters: the flags do nothing for anyone who does not
   put them in the URL, and the overlay only appears with ?debug=1.
   ========================================================================== */

/** Where to drop the player when the game starts. */
export type StartPoint =
  | 'boot'      // default: the normal linear opening
  | 'arcade'    // at the Arcade entrance, looking in
  | 'cycles'    // straight into the Light Cycle arena, no boot cinematic
  | 'passage';  // in the corridor behind the Arcade

/** Camera presets for reproducible screenshots. See §6 of the brief. */
export const CAMERA_PRESETS = [
  'arcade_far',
  'arcade_mid',
  'arcade_door',
  'arcade_side',
  'arcade_top',
  'arcade_inside',
  'arcade_hero',
] as const;

export type CameraPreset = (typeof CAMERA_PRESETS)[number];

export interface DebugFlags {
  /** ?debug=1 — FPS, mode, position, and the active flags. */
  showOverlay: boolean;

  /** ?start=arcade|cycles|passage — skip the opening. */
  start: StartPoint;

  /** ?lcwin=1 — the Light Cycle round resolves as a win after ~10s. */
  forceCycleWin: boolean;

  /** ?seed=12345 — fix the world seed, so a layout is reproducible. */
  seed: number | null;

  /** ?quality=low|medium|high — override the auto-detected tier. */
  quality: 'low' | 'medium' | 'high' | null;

  /** ?cam=<preset> — park the camera at a fixed pose for a reproducible shot. */
  cam: CameraPreset | null;

  /** ?debug=scene — dump the Arcade subtree's geometry and materials. */
  dumpScene: boolean;

  /** ?debug=exposure — sample the framebuffer and report blown-out pixels. */
  exposureProbe: boolean;
}

/** Anything the query string asked for that we did not recognise. */
const unknown: string[] = [];

/**
 * Read the flags once, at module load. `URLSearchParams` on a malformed query
 * string does not throw, but `Number()` on junk yields NaN, so every numeric
 * parse is checked rather than trusted.
 */
function read(): DebugFlags {
  const p = new URLSearchParams(window.location.search);

  const rawStart = (p.get('start') ?? 'boot').toLowerCase();
  const valid: StartPoint[] = ['boot', 'arcade', 'cycles', 'passage'];
  if (!valid.includes(rawStart as StartPoint)) {
    if (rawStart !== 'boot') unknown.push(`start=${rawStart}`);
  }

  const rawQuality = (p.get('quality') ?? '').toLowerCase();
  const validQuality = ['low', 'medium', 'high'];
  if (rawQuality && !validQuality.includes(rawQuality)) unknown.push(`quality=${rawQuality}`);

  const rawSeed = p.get('seed');
  let seed: number | null = null;
  if (rawSeed !== null) {
    const n = Number(rawSeed);
    if (Number.isFinite(n) && rawSeed.trim() !== '') seed = n >>> 0;
    else unknown.push(`seed=${rawSeed}`);
  }

  const validCam = CAMERA_PRESETS;

  // ?debug= takes a list of instruments: `?debug=scene,exposure`, and a bare
  // `?debug=1` still means the overlay alone, because that was the first
  // spelling and it should keep working.
  const rawDebug = (p.get('debug') ?? '').toLowerCase();
  const debugParts = rawDebug
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const camRaw = (p.get('cam') ?? '').toLowerCase();
  const cam = validCam.includes(camRaw as CameraPreset) ? (camRaw as CameraPreset) : null;
  if (camRaw && !cam) unknown.push(`cam=${camRaw}`);

  return {
    showOverlay:
      rawDebug === '1' ||
      debugParts.length === 0 ||
      debugParts.some((d) => d !== 'scene' && d !== 'exposure'),
    start: valid.includes(rawStart as StartPoint) ? (rawStart as StartPoint) : 'boot',
    forceCycleWin: p.get('lcwin') === '1',
    seed,
    quality: validQuality.includes(rawQuality) ? (rawQuality as 'low' | 'medium' | 'high') : null,
    cam,
    dumpScene: debugParts.includes('scene'),
    exposureProbe: debugParts.includes('exposure'),
  };
}

export const DEBUG: DebugFlags = read();

/** Flags we were handed that we could not use — surfaced by the overlay. */
export const DEBUG_UNKNOWN: readonly string[] = unknown;

/** True when any shortcut was requested, so the game can skip the opening. */
export function hasDebugStart(): boolean {
  return DEBUG.start !== 'boot';
}

/* ---------------------------------------------------------------------------
   Overlay
   ------------------------------------------------------------------------ */

/**
 * A fixed readout in the corner: FPS, mode, position, and the flags in force.
 *
 * FPS is measured over a rolling window rather than per-frame, because a single
 * frame's delta is noise and would make the number unreadable.
 */
export class DebugOverlay {
  private readonly node: HTMLElement | null;
  private accum = 0;
  private frames = 0;
  private fps = 0;
  private timer = 0;
  /** An extra line, set by a diagnostic instrument rather than per frame. */
  private extra = '';
  /**
   * The flags in force, held because update() rewrites the node's textContent
   * each frame and would otherwise drop this line after the first tick.
   */
  private flags = '';

  constructor() {
    if (!DEBUG.showOverlay) {
      this.node = null;
      return;
    }

    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:99998;margin:0;padding:8px 10px;' +
      'background:rgba(4,7,12,.82);border:1px solid #1d6f88;color:#4fe3ff;' +
      'font:11px/1.45 ui-monospace,Consolas,monospace;letter-spacing:.03em;' +
      'pointer-events:none;white-space:pre;border-radius:2px';

    const flags = [
      DEBUG.start !== 'boot' ? `start=${DEBUG.start}` : null,
      DEBUG.forceCycleWin ? 'lcwin' : null,
      DEBUG.seed !== null ? `seed=${DEBUG.seed}` : null,
      DEBUG.quality ? `quality=${DEBUG.quality}` : null,
      DEBUG.cam ? `cam=${DEBUG.cam}` : null,
      DEBUG.dumpScene ? 'scene' : null,
      DEBUG.exposureProbe ? 'exposure' : null,
      DEBUG_UNKNOWN.length ? `IGNORED: ${DEBUG_UNKNOWN.join(', ')}` : null,
    ].filter(Boolean);

    pre.textContent = flags.join(' · ');
    this.flags = flags.join(' · ');
    document.body.appendChild(pre);
    this.node = pre;
  }

  /** `mode` and `pos` are read from the live game, so the overlay cannot drift. */
  update(dt: number, mode: string, pos: { x: number; y: number; z: number }): void {
    if (!this.node) return;

    this.accum += dt;
    this.frames++;
    this.timer += dt;

    // Recompute the rate four times a second. Faster and the digits are noise.
    if (this.timer >= 0.25) {
      this.fps = Math.round(this.frames / this.accum);
      this.accum = 0;
      this.frames = 0;
      this.timer = 0;
    }

    this.node.textContent = [
      this.flags,
      `${this.fps} fps   ${mode.toUpperCase()}`,
      `x ${pos.x.toFixed(1)}  y ${pos.y.toFixed(1)}  z ${pos.z.toFixed(1)}`,
      this.extra,
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** One extra line under the readout — used by the exposure probe. */
  setExtra(text: string): void {
    this.extra = text;
  }
}