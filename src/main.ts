/* ============================================================================
   GRID PROTOCOL — entry point.

   This module is deliberately thin. It owns the *order of things* — the linear
   opening, the current mode, the input routing — and delegates every system to
   a module that knows only about itself.

   The opening is linear because the brief says it must be, and it is linear in
   exactly one respect: the order of discoveries. Nothing gates the player from
   turning around, and nothing is explained twice.

     boot -> descent -> plaza -> arcade -> light cycle -> back door
          -> the Spire (first ISO) -> the map opens

   SAFETY (brief §2): nothing here touches the filesystem, executes a program,
   or reads anything outside this tab. "Files", "terminals" and "network" are
   rendered text from src/data. The only persistence is localStorage, and the
   settings drawer offers a visible delete.
   ========================================================================== */

import * as THREE from 'three';
import { TIMING, quality } from '@/core/config';
import { bus } from '@/core/bus';
import { loadSettings, mutate, peekSave, randomSeed } from '@/core/save';
import { clamp } from '@/core/rng';
import { DEBUG, DebugOverlay } from '@/core/debug';
import { dumpScene, showDumpPanel } from '@/core/sceneDump';

import { Renderer } from '@/render/renderer';
import { Loop } from '@/render/loop';
import { setMaterialTime } from '@/render/materials';

import { AudioEngine } from '@/audio/engine';
import { PlayerController } from '@/player/controller';

import { GridWorld, ARCADE_DISTANCE, WORLD_HALF } from '@/grid/world';
import { Descent } from '@/grid/descent';
import { ArcadeBuilding, BACKDOOR_POS, CYCLE_STAND_POS } from '@/arcade/building';
import { LightCycleGame } from '@/lightcycles/game';
import { Iso } from '@/iso/iso';

import { SectorPortal, buildSession, disposeSession, visitSeed, type SectorSession } from '@/sectors/portal';
import { clampToSector, sectorDef } from '@/sectors/sector';
import { grantAccess, meets, refusal } from '@/core/access';
import { beatFor, remember, tryEnding } from '@/narrative/narrative';
import { ScreenFx } from '@/vfx/vfx';

import { Hud } from '@/ui/hud';
import { Terminal } from '@/ui/terminal';
import { MapOverlay } from '@/ui/map';
import { SettingsDrawer } from '@/ui/settings';
import { BootScreen } from '@/ui/boot';
import { createChapterCard, createDeathOverlay, createEndingOverlay } from '@/ui/overlays';
import { createTouchControls } from '@/ui/touch';
import { createMusicStrip } from '@/ui/music';
import { discover, markOpened } from '@/nodes/network';

/* The stylesheet is imported here, at the entry point, rather than from any one
   UI module. Nothing in src/ui imports it: the interface is generated into
   #ui at runtime, so there is no component that "owns" the CSS. Forgetting this
   line costs the entire visual system — the game still runs, still renders in
   3D, still answers to input, and arrives in the browser with no layout and no
   fonts. It looks like an art problem and it is a missing import. */
import '@/styles/main.css';

/* ===========================================================================
   Systems
   ========================================================================= */

type Mode = 'boot' | 'descent' | 'explore' | 'cycles' | 'secret' | 'sector' | 'dying';

/**
 * Diagnostics on `window`, so a number can be read without a build step.
 *
 * Typed rather than cast at each use: these are read from the browser console
 * and by an automated screenshot run, which cannot benefit from a type error
 * being caught at compile time but should still be documented in one place.
 */
declare global {
  interface Window {
    __verify?: () => unknown;
    __exposure?: () => { blown: number; mean: number; max: number; sampling: string } | null;
    __exposureImage?: () => string;
  }
}

/* ---------------------------------------------------------------------------
   Failure trap.

   Installed before anything else, and deliberately the only non-game code in
   this file. If module construction throws, every <script> aborts and the page
   is a silent black rectangle — which is indistinguishable from "the game is
   just very dark" and impossible to debug from the outside. This turns that
   into something readable on screen.

   §2's safety constraints still hold: this writes text into the DOM and
   nothing else. No network, no storage, no filesystem.
   --------------------------------------------------------------------------- */
function fatal(err: unknown): void {
  const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  const pre = document.createElement('pre');
  pre.textContent = `CONNECTION FAILED\n\n${msg}`;
  pre.style.cssText =
    'position:fixed;inset:0;z-index:99999;margin:0;padding:24px;' +
    'background:#05070c;color:#7fdff0;font:12px/1.5 ui-monospace,monospace;' +
    'white-space:pre-wrap;overflow:auto;letter-spacing:.04em';
  document.body.appendChild(pre);
}

window.addEventListener('error', (e) => { if (!document.querySelector('pre')) fatal(e.error ?? e.message); });
window.addEventListener('unhandledrejection', (e) => { if (!document.querySelector('pre')) fatal(e.reason); });


const canvas = document.getElementById('stage') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

const settings = loadSettings();
const audio = new AudioEngine();
const renderer = new Renderer(canvas);
const loop = new Loop();

/** The seed persists so a run is reproducible; the world is generated from it. */
const seed = DEBUG.seed ?? peekSave().runSeed ?? randomSeed();
if (DEBUG.seed === null && !peekSave().runSeed) mutate((s) => { s.runSeed = seed; });

// ?quality= overrides the auto-detected tier, for checking that the low and high
// profiles are both survivable. Without it the watchdog can move the tier
// mid-test and the thing under test is no longer the thing being tested.
if (DEBUG.quality) quality.setTier(DEBUG.quality);

const world = new GridWorld(seed);
const arcade = new ArcadeBuilding();
arcade.place();
world.group.add(arcade.group);

const player = new PlayerController(canvas, renderer.camera, {
  onFootstep: (pos, speed) => {
    world.onFootstep(pos);
    audio.footstep(clamp(speed / 8, 0.25, 1));
  },
});

/* --- colliders: the world plus the building --- */
player.setColliderBoxes([...world.colliders, ...arcade.colliders]);

/* --- UI --- */
const hud = new Hud(uiRoot);
const terminal = new Terminal(uiRoot);
const map = new MapOverlay(uiRoot);
const settingsDrawer = new SettingsDrawer(uiRoot, audio);
const chapter = createChapterCard(uiRoot);
const death = createDeathOverlay(uiRoot);
const endingOverlay = createEndingOverlay(uiRoot);
const touch = createTouchControls(uiRoot);
const fx = new ScreenFx(renderer);

/* The radio strip is created last of the UI so that the stylesheet's sibling
   selectors (`.terminal.is-open ~ .radio`) can reach it — the whole-screen
   overlays have to come first in the DOM for those to match. */
const radio = createMusicStrip(uiRoot, audio);

// Visibility is the HUD's to decide: both appear when the player is looking at
// the world and both go when something else takes the screen.
hud.attachRadio(radio);

const boot = new BootScreen(uiRoot, {
  onJackIn: () => { void startDescent(); },
});

const iso = new Iso();
world.group.add(iso.group);
iso.restoreDelivered(peekSave().readLogs);

const descent = new Descent(renderer, audio, world, player);

const debugOverlay = new DebugOverlay();

/* ===========================================================================
   PASSO 0 — scene diagnosis

   The Arcade was reported as a cyan wash with a white blade where a machine
   should be, a building that renders as wireframe, and a stray TERMINAL box.
   None of that is visible from here, so `?debug=scene` walks the built scene
   and prints what each object actually is and how its material is configured.

   It runs after one full frame so the renderer state — tone mapping, bloom
   parameters — has settled and can be read rather than guessed at. Read-only.
   =========================================================================== */

/** Expose the pixel values of a rendered frame, for the exposure probe. */
function installPixelProbe(): void {
  const gl = renderer.renderer.getContext();
  const probe = document.createElement('canvas');
  probe.width = 64;
  probe.height = 36;
  const ctx = probe.getContext('2d', { willReadFrequently: true });

  const measure = (): { blown: number; mean: number; max: number } | null => {
    if (!ctx) return null;
    const w = probe.width;
    const h = probe.height;
    const sw = gl.drawingBufferWidth;
    const sh = gl.drawingBufferHeight;
    if (!sw || !sh) return null;

    // The default framebuffer is not readable through a 2D canvas, so the
    // current colour buffer is read with readPixels and scaled down here.
    const full = new Uint8Array(sw * sh * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, full);

    const img = ctx.createImageData(w, h);
    let blown = 0;
    let sum = 0;
    let max = 0;
    let counted = 0;

    // Box-filter the full buffer down to 64x36. Sampling every 16th pixel
    // would alias badly on a scene made of thin bright lines, which is exactly
    // the case where the blown-out percentage has to be right.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        const x0 = Math.floor((x * sw) / w);
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w));
        const y0 = Math.floor((y * sh) / h);
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h));
        for (let sy = y0; sy < y1; sy += 2) {
          for (let sx = x0; sx < x1; sx += 2) {
            const i = (sy * sw + sx) * 4;
            r += full[i];
            g += full[i + 1];
            b += full[i + 2];
            n++;
          }
        }
        if (!n) continue;
        r /= n;
        g /= n;
        b /= n;
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        sum += lum;
        if (lum > max) max = lum;
        if (lum > 0.95) blown++;
        counted++;

        const o = (y * w + x) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    const total = counted || 1;
    return {
      blown: Math.round((blown / total) * 1000) / 10,
      mean: Math.round((sum / total) * 1000) / 1000,
      max: Math.round(max * 1000) / 1000,
    };
  };

  window.__exposure = () => {
    const m = measure();
    return m ? { ...m, sampling: '64x36 box-filtered from the default framebuffer' } : null;
  };
  window.__exposureImage = () => probe.toDataURL('image/png');

  if (DEBUG.exposureProbe) {
    const tick = () => {
      const m = measure();
      if (m) {
        debugOverlay.setExtra(
          `blown>0.95: ${m.blown}%   mean: ${m.mean}   max: ${m.max}`,
        );
      }
      window.setTimeout(tick, 500);
    };
    tick();
  }
}

/**
 * Print the Arcade's geometry and materials, and the render pipeline's live
 * parameters, to the console and to an on-screen panel.
 *
 * The pipeline half matters as much as the object half: the report describes
 * an image that is washed out, and an image is the product of the objects and
 * the pipeline together.
 */
function dumpArcadeScene(): void {
  const dump = dumpScene(arcade.group);

  const bloom = renderer.debugBloom();
  const fog = renderer.scene.fog;
  const t = renderer.renderer;

  const header = [
    'ARCADE SCENE DUMP',
    `building at world z = ${round1(arcade.group.position.z)}, half-depth 14 m`,
    '',
    'PIPELINE',
    `  toneMapping         ${t.toneMapping}  (${TONE_NAMES[t.toneMapping] ?? 'unknown'})`,
    `  exposure            ${t.toneMappingExposure}`,
    `  outputColorSpace    ${t.outputColorSpace}`,
    `  bloom.strength      ${bloom.strength}`,
    `  bloom.radius        ${bloom.radius}`,
    `  bloom.threshold     ${bloom.threshold}`,
    `  bloom resolution    ${bloom.width} x ${bloom.height}`,
    `  fog                 ${describeFog(fog)}`,
    `  quality tier        ${quality.tier}  arcadeMachines=${quality.profile.arcadeMachines}`,
    '',
    'SUMMARY',
    `  meshes                  ${dump.summary.meshes}`,
    `  additive meshes         ${dump.summary.additiveMeshes}`,
    `  transparent meshes      ${dump.summary.transparentMeshes}`,
    `  lines/points (no solid) ${dump.summary.nonMeshDrawables}`,
    `  largest additive area   ${dump.summary.largestAdditiveArea} m²  (${dump.summary.largestAdditiveName})`,
    '',
  ].join('\n');

  const text = `${header}${dump.table}`;
  // eslint-disable-next-line no-console
  console.log(text);
  showDumpPanel(text);
}

/** Three.js has no name lookup for tone mapping; this is the readable form. */
const TONE_NAMES: Record<number, string> = {
  [THREE.NoToneMapping]: 'NoToneMapping',
  [THREE.LinearToneMapping]: 'LinearToneMapping',
  [THREE.ReinhardToneMapping]: 'ReinhardToneMapping',
  [THREE.CineonToneMapping]: 'CineonToneMapping',
  [THREE.ACESFilmicToneMapping]: 'ACESFilmicToneMapping',
  [THREE.AgXToneMapping]: 'AgXToneMapping',
  [THREE.NeutralToneMapping]: 'NeutralToneMapping',
};

/** `Fog` is linear and has no density; saying so is more useful than a blank. */
function describeFog(fog: THREE.Scene['fog']): string {
  if (!fog) return 'none';
  const colour = `#${fog.color.getHexString()}`;
  if (fog instanceof THREE.FogExp2) {
    return `FogExp2 colour ${colour} density ${fog.density}`;
  }
  return `Fog (linear) colour ${colour} near ${fog.near} far ${fog.far}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Exposed for the console and for an automated browser. */
function installVerify(): void {
  window.__verify = () => {
    const t = renderer.renderer;
    const bloom = renderer.debugBloom();
    return {
      quality: quality.tier,
      toneMapping: TONE_NAMES[t.toneMapping] ?? String(t.toneMapping),
      toneMappingExposure: t.toneMappingExposure,
      bloom: { strength: bloom.strength, radius: bloom.radius, threshold: bloom.threshold },
      fog: describeFog(renderer.scene.fog),
      arcade: {
        buildingZ: round1(arcade.group.position.z),
        machines: arcade.machines.length,
        colliders: arcade.colliders.length,
        summary: dumpScene(arcade.group).summary,
      },
      exposure: window.__exposure ? window.__exposure() : null,
      player: {
        x: round1(player.position.x),
        y: round1(player.position.y),
        z: round1(player.position.z),
        mode,
      },
    };
  };
}

if (DEBUG.dumpScene || DEBUG.exposureProbe) {
  installPixelProbe();
  installVerify();
  // One frame, so tone mapping and bloom have their final values.
  window.setTimeout(() => {
    if (DEBUG.dumpScene) dumpArcadeScene();
  }, 400);
}

/* ===========================================================================
   Mode
   ========================================================================= */

let mode: Mode = 'boot';

/** Where the player is standing when they re-enter a mode. */
const SPAWN = { x: 0, z: 0, yaw: Math.PI };

function setMode(next: Mode): void {
  mode = next;
  // Any overlay that was open for the previous mode closes on the way out.
  if (next !== 'explore') hud.setPrompt('', '');
}

/* ===========================================================================
   Audio gesture retry

   The JACK IN click is supposed to be the gesture that unlocks the context. On
   some browsers — and in some embedded contexts — it is not enough, and the
   policy only gives up on a *later* user gesture.

   `AudioEngine.start()` therefore reports what actually happened rather than
   assuming it worked, and this listens for the next real interaction to try
   again. Without it a single refusal leaves the game permanently silent and,
   worse, leaves `audio.pulse` at zero so the Grid stops breathing — the world
   looks broken in a way that has nothing to do with audio.
   =========================================================================== */

let audioRetryPending = false;

async function attemptAudioRetry(): Promise<void> {
  if (!audioRetryPending) return;
  audioRetryPending = false;
  if (await audio.retryStart()) radio.setBlocked(false);
}

function installAudioGestureRetry(): void {
  const try_ = (): void => {
    void attemptAudioRetry();
  };
  // `pointerdown` rather than `click`: it fires earlier and it fires for drags,
  // which a click never does.
  window.addEventListener('pointerdown', try_, { passive: true });
  window.addEventListener('keydown', try_);
  window.addEventListener('wheel', try_, { passive: true });
}

installAudioGestureRetry();

/* ===========================================================================
   The opening (§9)
   ========================================================================= */

/** The Spire: the ISO's sector, reached through the passage. */
const SPIRE = new THREE.Vector3(-52, 0, ARCADE_DISTANCE + 120);

async function startDescent(): Promise<void> {
  // The jack-in click is the audio gesture. Starting here means the context is
  // never left suspended behind a silent first screen.
  await audio.start();
  audio.setArea('grid');

  // If the browser refused even that, say so in the system's own voice and pick
  // the job up on the next gesture — see `installAudioGestureRetry`.
  audioRetryPending = !audio.ready;
  radio.setBlocked(audioRetryPending);

  // Hide the boot screen before the descent swaps the scene, so the fade runs
  // against black rather than against a half-drawn world.
  bootScreenOut();

  // A debug start still comes through here, not around it: the jack-in click is
  // the only gesture that unlocks audio, and a browser that starts muted is a
  // worse thing to debug than the twelve seconds it saves.
  if (DEBUG.start !== 'boot') {
    applyDebugStart();
    return;
  }

  setMode('descent');
  hud.hide();

  await descent.run(onDescentComplete);
}

/**
 * Drop the player at one of the debug start points.
 *
 * Each of these reaches a state the normal opening arrives at, so what is being
 * tested downstream is the real thing and not a special case that only works
 * under a flag.
 */
function applyDebugStart(): void {
  switch (DEBUG.start) {
    case 'cycles':
      // Straight into the arena. runCycles() checks `mode === 'explore'` and
      // swaps the scene itself, so the mode is set up here and it does the rest.
      setMode('explore');
      player.setEnabled(true);
      hud.show();
      void runCycles();
      break;

    case 'passage':
      // The passage is gated on winning a Light Cycle round, so the flag is set
      // rather than the gate removed — enterSecret() then runs for real,
      // including the ACCESS grant and the tunnel handover. It teleports to the
      // Spire itself, so there is nothing to place the player at beforehand.
      mutate((s) => { s.flags.cyclesWon = true; });
      setMode('explore');
      player.setEnabled(true);
      hud.show();
      void enterSecret();
      break;

    case 'arcade':
    default:
      // At the entrance, looking in. The building's front wall is at local
      // z = -14 and the group sits at ARCADE_DISTANCE + HALF_D + 6, so this
      // stands just outside the 6m gap in the façade, facing the Light Cycle.
      setMode('explore');
      player.setEnabled(true);
      hud.show();
      player.teleport(0, arcade.group.position.z - 18, Math.PI, 0);
      hud.setLocation('THE ARCADE', 'DEBUG START');
      break;
  }
}

function bootScreenOut(): void {
  document.getElementById('ui')?.classList.add('is-booting-out');
}

function onDescentComplete(): void {
  bus.emit('descent:complete', { t: 0 });

  // Hand over control and the pointer.
  setMode('explore');
  hud.show();
  player.setEnabled(true);
  audio.setArea('grid');

  // The player knows where to go because the light path is the only thing in
  // the world pointing anywhere. No marker, no arrow, no text.
  bus.emit('hud:control-hint', { show: true });
  window.setTimeout(() => bus.emit('hud:control-hint', { show: false }), TIMING.controlHintDuration * 1000);

  // Point the camera at the Arcade, so the first frame of free movement is
  // already looking down the path.
  player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, 0.02);

  discover('plaza');
  map.setCurrent('plaza');

  hud.setObjectives([
    { label: 'FIND THE SOURCE OF THE MUSIC', done: false },
    { label: 'JACK IN', done: true },
  ]);

  // The Arcade's music fades in with distance — the player hears the way
  // before they see it. maxDist is deliberately long: it should be audible from
  // the platform, faintly.
  arcadeAudioSource = audio.createSpatialSource(220, 'square');
  updateArcadeAudio();

  if (settings.headBob === false) document.body.classList.add('no-bob');

  chapter.show('01', 'THE GRID', 'Something is running here.');
}

let arcadeAudioSource: { update(px: number, pz: number, sx: number, sz: number, maxDist: number): void; stop(): void } | null = null;

function updateArcadeAudio(): void {
  if (!arcadeAudioSource) return;
  arcadeAudioSource.update(
    player.position.x,
    player.position.z,
    arcade.group.position.x,
    arcade.group.position.z,
    170,
  );
}

/* ===========================================================================
   Interaction
   ========================================================================= */

/** The object the player is closest to and roughly looking at. */
let focused: {
  id: string;
  label: string;
  radius: number;
  activate: () => void;
} | null = null;

const lookDir = new THREE.Vector3();

function registerInteractables(): void {
  // The ordinary cabinets: they read, they do nothing. This is deliberate —
  // a machine that turns on and has no game teaches the player to stop trying.
  for (const m of arcade.machines) {
    if (m.kind !== 'arcade-machine') continue;
    world.addInteractable({
      id: `cab-${m.position.x}-${m.position.z}`,
      position: m.position.clone().setY(1).add(arcade.group.position),
      radius: 1.8,
      label: 'TERMINAL',
      kind: 'arcade-machine',
      activate: () => {
        terminal.show({
          title: 'ARCADE TERMINAL',
          lines: [
            { text: 'SERVICE STATE: OPERATIONAL', tone: 'system' },
            { text: 'ACCOUNT: CLOSED (2019-04-02)', tone: 'corrupt' },
            { text: 'CREDITS REMAINING: 1,481', tone: 'system' },
            { text: ' ', tone: 'plain' },
            { text: 'A machine is still drawing power.', tone: 'iso' },
            { text: 'It is not the first, and it is not the last.', tone: 'iso' },
          ],
          actions: [{ label: 'CLOSE', primary: true, onClick: () => terminal.close() }],
        });
      },
    });
  }

  // The Light Cycle.
  world.addInteractable({
    id: 'light-cycle',
    position: CYCLE_STAND_POS.clone().setY(1.5).add(arcade.group.position),
    radius: 2.6,
    label: 'LIGHT CYCLE',
    kind: 'arcade-machine',
    activate: () => { void runCycles(); },
  });

  // The unremarkable door.
  world.addInteractable({
    id: 'backdoor',
    position: BACKDOOR_POS.clone().setY(1.5).add(arcade.group.position),
    radius: 2.2,
    label: 'DOOR',
    kind: 'door',
    activate: () => { void enterSecret(); },
  });
}

registerInteractables();

function updateFocus(): void {
  if (mode !== 'explore') {
    if (focused) {
      focused = null;
      hud.setPrompt('');
    }
    return;
  }

  player.getLookTarget(lookDir).normalize();

  let best: typeof focused = null;
  let bestScore = Infinity;

  for (const it of world.interactables) {
    const dx = it.position.x - player.position.x;
    const dz = it.position.z - player.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > it.radius) continue;

    // Proximity plus gaze. A cone rather than a radius check, so the player
    // has to actually look at things — which is what makes "the object lights
    // up when you notice it" work.
    const nx = dx / (dist || 1);
    const nz = dz / (dist || 1);
    const facing = nx * lookDir.x + nz * lookDir.z;
    if (facing < 0.55) continue;

    const score = dist - facing * 1.2;
    if (score < bestScore) {
      bestScore = score;
      best = { id: it.id, label: it.label, radius: it.radius, activate: it.activate };
    }
  }

  if (best?.id !== focused?.id) {
    focused = best;
    if (best) {
      hud.setPrompt(best.label, hud.interactKey);
      audio.blip(1400, 0.04, 0.06, 'sine');
    } else {
      hud.setPrompt('');
    }
  }
}

function activateFocused(): void {
  if (mode !== 'explore' || !focused) return;
  audio.confirm();
  focused.activate();
}

/* ===========================================================================
   Light Cycles
   ========================================================================= */

let cycles: LightCycleGame | null = null;

async function runCycles(): Promise<void> {
  if (mode !== 'explore') return;

  setMode('cycles');
  arcadeAudioSource?.stop();
  arcadeAudioSource = null;

  // The machine powers up before the scene swaps, so the transition is
  // continuous: we are still in the Arcade when it starts.
  arcade.setCyclePower(1);
  audio.subSwell(0.4);

  await new Promise((r) => window.setTimeout(r, 700));

  cycles = new LightCycleGame(renderer, audio, player, 'medium', DEBUG.forceCycleWin);
  cycles.resize(renderer.camera.aspect);

  hud.hide();

  const result = await cycles.run(
    (s) => {
      if (s.countdown > 0) {
        hud.setPrompt(String(Math.ceil(s.countdown)), '');
      } else {
        hud.setPrompt(`${Math.floor(s.time)}s · ${s.alive}/${s.total}`, '');
      }
    },
    (m) => {
      chapter.show('02', m.title, m.line, 3.2);
    },
  );

  cycles.dispose();
  cycles = null;

  // The Light Cycle arena borrowed the renderer's scene and camera and gave
  // neither back: `dispose()` clears the arena but the renderer keeps its
  // pointer, so without this the next frame draws the cleared arena through the
  // cycles camera and the player is returned to a black screen.
  renderer.setScene(world.group, player.camera);

  arcade.setCyclePower(0);
  hud.show();
  hud.setPrompt('');

  audio.setArea('arcade');
  arcadeAudioSource = audio.createSpatialSource(220, 'square');
  updateArcadeAudio();

  // Progression persists regardless of the outcome.
  mutate((s) => {
    s.counters.cyclesPlayed = (s.counters.cyclesPlayed ?? 0) + 1;
    if (result.won) {
      s.counters.cyclesWon = (s.counters.cyclesWon ?? 0) + 1;
      s.stats.data += result.score;
      s.stats.reputation += 20;
    }
    s.flags.cyclesPlayed = true;
    // Winning the game is what reveals the passage. Losing does not close the
    // door — it just makes the door further away.
    if (result.won) s.flags.cyclesWon = true;
  });

  bus.emit(result.won ? 'cycle:win' : 'cycle:lose', {
    score: result.score,
    rank: result.rank,
    reason: result.rank,
  });

  if (result.won) {
    iso.changeLink(6);
    hud.toast('SECTOR UNSEALED', 'discovery');
    discover('cycles');
    map.setCurrent('cycles');
    hud.setObjectives([
      { label: 'WIN A LIGHT CYCLE ROUND', done: true },
      { label: 'FIND WHAT IS BEHIND THE ARCADE', done: false },
    ]);
  } else {
    hud.toast(`${result.rank} · ${result.score}`, 'warn');
  }

  setMode('explore');
}

/* ===========================================================================
   The secret passage (§8)
   ========================================================================= */

async function enterSecret(): Promise<void> {
  if (mode !== 'explore') return;

  const save = peekSave();
  if (!save.flags.cyclesWon) {
    // The door is real before the game is won. It just is not a door yet.
    terminal.show({
      title: 'ACCESS DENIED',
      lines: [
        { text: 'This door is not locked.', tone: 'system' },
        { text: 'It is simply not interesting yet.', tone: 'system' },
        { text: ' ', tone: 'plain' },
        { text: 'Something on the other side is not finished.', tone: 'iso' },
      ],
      actions: [{ label: 'CLOSE', primary: true, onClick: () => terminal.close() }],
    });
    audio.deny();
    return;
  }

  setMode('secret');
  markOpened('arcade-back', 'door');
  discover('arcade-back');
  discover('spire');
  map.setCurrent('spire');

  // The first rung of ACCESS, granted by crossing the threshold — not by any
  // sector. Every later grant happens on arrival at the sector *below* the door
  // it opens, because a door that needs the key sitting behind it is a door
  // nobody can use. See narrative.ts.
  grantAccess(2, 'CROSSED THE THRESHOLD · NETWORK MAPPED FROM HERE');

  chapter.show('03', 'UNKNOWN NODE', 'The Arcade stops.');

  // Cross the tunnel. The descent machinery is reused with a much shorter
  // move: the point is the handover, not the ride.
  audio.subSwell(0.5);
  audio.whoosh(0.8);

  player.teleport(SPIRE.x, SPIRE.z, Math.PI * 0.5, 0);
  iso.placeAt(SPIRE.x + 9, 1.7, SPIRE.z + 4);
  iso.setPresence('distant');

  await new Promise((r) => window.setTimeout(r, 1400));

  audio.setArea('iso');
  setMode('explore');
  hud.show();
  hud.setObjectives([
    { label: 'WIN A LIGHT CYCLE ROUND', done: true },
    { label: 'FIND WHAT IS BEHIND THE ARCADE', done: true },
    { label: 'LISTEN', done: false },
  ]);

  chapter.show('04', 'THE SPIRE', 'She was already here.');
}

/* ===========================================================================
   Sectors (§10, §11)

   Doors in the Plaza that open into generated worlds. Everything the player can
   reach beyond the opening lives behind one of these, and each is a different
   tone, a different piece of music, and a different thing to find out.

   The transition is deliberately quiet. There is no loading screen and no page
   change: the world is built, the scene swaps, and the player is standing in it
   a frame later. Anything slower would break the illusion that this is a place
   being walked through rather than content being loaded.
   ========================================================================= */

const SECTOR_IDS = ['archive', 'security', 'corrupt', 'core'] as const;

/** The active sector, or null while the player is in the Plaza. */
let session: SectorSession | null = null;

/**
 * Portals only exist in the Plaza, so they are driven only there. Their glow is
 * driven here rather than through world.update because they are not part of
 * GridWorld's own contents — they are the sector system's contribution to it.
 */
function updatePortalFocus(): void {
  for (const p of portals) {
    p.update(dtNow, elapsedNow, player.position);
    if (p.pendingOpen) {
      p.pendingOpen = false;
      void openPortal(defIdFor(p));
    }
  }
}

function defIdFor(portal: SectorPortal): string {
  return portal.interactables[0].id.replace('portal-', '');
}

/** Frame clock, shared with the portal update above. */
let dtNow = 0;
let elapsedNow = 0;

/** Portals stand in a shallow arc around the spawn, facing inward. */
const portals: SectorPortal[] = [];

for (let i = 0; i < SECTOR_IDS.length; i++) {
  const def = sectorDef(SECTOR_IDS[i]);
  if (!def) continue;

  // A fan behind the spawn, so the doors are visible from the arrival platform
  // without being a corridor. Their spread means none occludes another.
  const angle = Math.PI * 0.5 + (i - (SECTOR_IDS.length - 1) / 2) * 0.62;
  const dist = 34;
  const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);

  const portal = new SectorPortal(def, i, pos);
  portals.push(portal);
  world.group.add(portal.group);

  world.addInteractable({
    id: portal.interactables[0].id,
    position: portal.interactables[0].position,
    radius: portal.interactables[0].radius,
    label: portal.interactables[0].label,
    kind: 'door',
    activate: () => { void openPortal(def.id); },
  });
}

/**
 * Enter a sector through its door.
 *
 * ACCESS is checked at the threshold, not inside. A door that refuses you is a
 * terminal the system speaks through, which is more honest than a world that
 * turns out to be solid when you walk into it.
 */
async function openPortal(id: string): Promise<void> {
  if (mode !== 'explore' || session) return;

  const def = sectorDef(id);
  if (!def) return;

  if (!meets(def.access)) {
    audio.deny();
    fx.blip(0.5);
    terminal.show({
      title: 'ACCESS DENIED',
      lines: refusal(def.locked).map((text) => ({ text, tone: 'warn' as const })),
      actions: [{ label: 'CLOSE', primary: true, onClick: () => terminal.close() }],
    });
    return;
  }

  /* --- ACCESS is not granted here. It was granted the moment the door became
     reachable — by crossing the threshold, or by arriving at the sector below
     this one. Granting it at the door it unlocks would mean every door needed
     the key sitting behind it. --- */

  setMode('sector');

  const returnTo = player.position.clone();
  const returnYaw = player.yaw;

  const visit = peekSave().counters[`visits_${id}`] ?? 0;
  const built = buildSession(id, visitSeed(seed, visit), returnTo, returnYaw);
  if (!built) {
    setMode('explore');
    return;
  }
  session = built;

  // The blackout is what makes this read as crossing a layer. Short — the point
  // is the handover, not the ride.
  fx.setInterference(1);
  arcadeAudioSource?.stop();
  arcadeAudioSource = null;
  audio.subSwell(0.35);

  await new Promise((r) => window.setTimeout(r, 620));

  renderer.setScene(session.sector.scene, player.camera);
  player.setColliderBoxes(session.sector.colliders);

  player.teleport(0, 0, Math.PI * 0.5, 0);
  audio.setArea(session.def.music);

  mutate((s) => {
    s.counters[`visits_${id}`] = visit + 1;
    s.counters.sectorEntries = (s.counters.sectorEntries ?? 0) + 1;
    s.flags[`entered_${id}`] = true;
  });

  discover(id);
  map.setCurrent(id);
  bus.emit('sector:enter', { id, firstTime: visit === 0 });

  // Her position is relative to the sector she appears in, not the Plaza.
  iso.placeAt(session.def.half * 0.25, 1.7, session.def.half * 0.1);

  hud.show();
  setMode('explore');

  chapter.show(
    String(SECTOR_IDS.indexOf(id as (typeof SECTOR_IDS)[number]) + 5).padStart(2, '0'),
    session.def.title.toUpperCase(),
    session.def.subtitle,
  );

  applyBeat(id, visit === 0);
}

/** Run the narrative beat for a sector, on first arrival only. */
function applyBeat(id: string, firstTime: boolean): void {
  const beat = beatFor(id);
  if (!beat || !firstTime) return;

  if (beat.memory) {
    remember(beat.memory.id, beat.memory.title, id);
  }

  if (beat.iso) {
    iso.setPresence(beat.iso);
  }

  if (beat.lines) {
    // The terminal carries the beat's voice. Nothing is explained that the
    // sector itself already shows.
    window.setTimeout(() => {
      if (mode === 'explore' && !terminal.isOpen) {
        terminal.show({
          title: beat.title ?? session?.def.title.toUpperCase() ?? id.toUpperCase(),
          lines: beat.lines ?? [],
          actions: [{ label: 'CLOSE', primary: true, onClick: () => terminal.close() }],
        });
      }
    }, 1400);
  }

  // Corrupt is where the schedule is found — the flag the ending gates on.
  if (id === 'corrupt') {
    mutate((s) => {
      s.flags.purgeSeen = true;
    });
  }

  if (id === 'core') {
    // The Core is the only place the question is asked.
    iso.setPresence('present');
    window.setTimeout(() => { void attemptEnding(); }, 2200);
  }
}

/**
 * Leave a sector, returning the player to the Plaza exactly where they stood.
 *
 * Getting lost on the way back would be a failure of the map rather than a
 * puzzle, so the return position is captured at entry and restored here.
 */
async function exitSector(): Promise<void> {
  if (!session || mode !== 'explore') return;

  const leaving = session;
  setMode('sector');

  fx.setInterference(0.8);
  audio.whoosh(0.5);

  await new Promise((r) => window.setTimeout(r, 480));

  disposeSession(leaving);
  session = null;

  renderer.setScene(world.group, player.camera);
  player.setColliderBoxes([...world.colliders, ...arcade.colliders]);

  player.teleport(leaving.returnTo.x, leaving.returnTo.z, leaving.returnYaw, 0);
  // The Plaza's music is the grid's; the Spire's is hers. Leaving a sector
  // returns you to whatever the opening left you in.
  audio.setArea(peekSave().flags.cyclesWon ? 'iso' : 'grid');

  arcadeAudioSource = audio.createSpatialSource(220, 'square');
  updateArcadeAudio();

  bus.emit('sector:leave', { id: leaving.def.id });
  map.setCurrent(peekSave().flags.cyclesWon ? 'spire' : 'plaza');

  setMode('explore');
  hud.show();
  fx.reset();
}

/** The ending, when this is the moment. Idempotent; silently declines. */
async function attemptEnding(): Promise<void> {
  if (mode !== 'explore' && mode !== 'sector') return;

  const reached = tryEnding(iso.bond);
  if (!reached) return;

  setMode('sector');
  player.setEnabled(false);
  hud.hide();
  fx.setInterference(1);

  chapter.show('—', reached.card, reached.line, 5);
  await new Promise((r) => window.setTimeout(r, 4200));

  await endingOverlay.play(reached);
  fx.reset();

  hud.show();
  player.setEnabled(true);
  setMode('explore');
}

/* ===========================================================================
   Death and reconnection (§12)
   ========================================================================= */

async function die(cause: string): Promise<void> {
  if (mode === 'dying') return;

  // Losing a cycle round is not dying. Only the roguelike run is.
  setMode('dying');
  player.setEnabled(false);
  hud.setPrompt('');
  audio.disconnect();
  fx.reset();

  bus.emit('player:died', { cause });

  // A death inside a sector drops you back to the Plaza, not to the last
  // corridor you were killed in. The reconnect is a return to the surface, and
  // the sector is rebuilt from its seed when — and if — you walk back in.
  const wasInSector = session;
  if (wasInSector) {
    disposeSession(wasInSector);
    session = null;
    renderer.setScene(world.group, player.camera);
    player.setColliderBoxes([...world.colliders, ...arcade.colliders]);
  }

  await death.play(cause);

  // The body resets; the progression does not. This is the whole point of the
  // roguelike layer: you keep what you discovered, you lose where you were.
  mutate((s) => {
    s.runSeed = randomSeed();
    s.stats.energy = 100;
    s.counters.deaths = (s.counters.deaths ?? 0) + 1;
  });

  energy = 100;
  audio.setArea('grid');
  player.teleport(SPAWN.x, SPAWN.z, SPAWN.yaw, 0.02);
  player.setEnabled(true);
  hud.show();
  setMode('explore');
  player.requestPointerLock();
}

/* ===========================================================================
   Input routing
   ========================================================================= */

window.addEventListener('keydown', (e) => {
  // Boot owns the keyboard until the player commits.
  if (boot.handleKey(e.code)) return;

  // Overlays get first refusal, so a key never reaches two systems.
  if (terminal.isOpen) {
    if (terminal.handleKey(e.code)) e.preventDefault();
    return;
  }
  if (map.isOpen) {
    if (map.handleKey(e.code)) e.preventDefault();
    return;
  }
  if (settingsDrawer.isOpen) {
    if (settingsDrawer.handleKey(e.code)) e.preventDefault();
    return;
  }

  switch (e.code) {
    case 'Tab':
    case 'KeyM':
      e.preventDefault();
      map.toggle();
      break;

    case 'KeyO':
      e.preventDefault();
      settingsDrawer.toggle();
      break;

    case 'Escape':
      // Escape always returns the pointer rather than opening anything.
      player.exitPointerLock();
      break;

    case 'KeyQ':
      // Leaving a sector is deliberately not "Escape" — Escape is the universal
      // "let go of the mouse", and spending it on two meanings at once makes
      // both feel unreliable. Q is chosen because nothing else in the Grid uses
      // it and because it reads as "quit this context".
      if (session && mode === 'explore' && !terminal.isOpen) {
        e.preventDefault();
        void exitSector();
      }
      break;

    case 'KeyE':
    case 'Enter':
      // Enter is E only while a terminal is typing: it finishes the reveal.
      if (e.code === 'KeyE' || terminal.isTyping) {
        e.preventDefault();
        if (terminal.isTyping) terminal.finishTyping();
        else activateFocused();
      }
      break;

    default:
      break;
  }
});

// The canvas takes the pointer on click, but only while exploring — otherwise
// a click on a menu would fight the menus.
canvas.addEventListener('click', () => {
  if (mode === 'explore' && !terminal.isOpen && !map.isOpen && !settingsDrawer.isOpen) {
    player.requestPointerLock();
  }
});

if (quality.tier !== 'low' && 'ontouchstart' in window) {
  touch.show();
  player.registerTouchElements(touch.stick, touch.knob, touch.action);
  touch.action.addEventListener('click', activateFocused);
}

/* --- bus wiring --- */
bus.on('toast', (p) => hud.toast(p.text, p.tone, p.duration));
bus.on('node:discovered', (p) => {
  audio.discovery();
  hud.toast(`DISCOVERED · ${p.name}`, 'discovery');
});

bus.on('quality:changed', ({ tier }) => {
  if (tier === 'high' || tier === 'medium' || tier === 'low') {
    quality.setTier(tier);
    renderer.applyQuality();
    world.applyQuality();
  }
});

bus.on('iso:link-changed', ({ value }) => {
  hud.setLink(value);
});

bus.on('iso:met', ({ firstTime }) => {
  if (firstTime) hud.toast('SOMETHING NOTICED YOU', 'iso');
});

/**
 * The roguelike pressure for Fase 1.
 *
 * The data walls are the world boundary, and in the fiction they are also the
 * part of the Grid that is being reclaimed. Leaning against one drains ENERGY
 * rather than simply stopping the player, which is what turns "I cannot go
 * there" into a decision. Losing all of it is a CONNECTION LOST, and the run
 * restarts with progression intact.
 */
let energy = 100;
let drainAccum = 0;

function updateEnergy(dt: number): void {
  // The boundary is wherever the world currently ends: the Plaza's data walls
  // or the sector's. Leaning on it is never blocked outright — it costs ENERGY,
  // which turns "I cannot go there" into a decision rather than a wall.
  const limit = (session ? session.def.half : WORLD_HALF) - 1.5;
  const atWall =
    Math.abs(player.position.x) > limit || Math.abs(player.position.z) > limit;

  if (atWall) {
    drainAccum += dt;
    if (drainAccum >= 0.25) {
      drainAccum = 0;
      energy = Math.max(0, energy - 1);
      bus.emit('player:damage', { amount: 1, source: 'data-wall' });
      fx.hit(0.35);
      if (energy % 5 === 0) audio.alarm();
    }
  } else {
    // Slow recovery, so backing off is always a real option.
    drainAccum = 0;
    if (energy < 100) energy = Math.min(100, energy + dt * 1.6);
  }

  hud.setEnergy(energy / 100);

  if (energy <= 0) {
    void die(session ? 'OVERRUN AT THE SECTOR BOUNDARY' : 'ENERGY EXHAUSTED AT THE BOUNDARY');
  }
}

/**
 * Pursuers.
 *
 * Strikes cost ENERGY at a flat rate and add to the same pool as the boundary
 * drain, so a player who is being hunted and a player who is leaning on a wall
 * are solving the same problem by different means. The dread post-effect rises
 * with the nearest hunter so being hunted is felt before it is read.
 */
let huntAccum = 0;

function updateThreat(dt: number, elapsed: number): void {
  if (!session?.swarm) {
    fx.setDread(0);
    return;
  }

  const strikes = session.swarm.update(dt, elapsed, player.position, session.def.half);
  const closest = session.swarm.closest();

  // The screen tightens as they close. Purely proportional, no threshold — the
  // player should notice the pressure building rather than a warning appearing.
  fx.setDread(session.swarm.anyHunting ? 0.35 + (1 - Math.min(closest / 46, 1)) * 0.65 : 0);

  if (strikes > 0) {
    huntAccum += dt;
    if (huntAccum >= 0.5) {
      huntAccum = 0;
      energy = Math.max(0, energy - 6);
      bus.emit('player:damage', { amount: 6, source: 'pursuer' });
      fx.hit(0.9);
      audio.alarm();
      hud.setEnergy(energy / 100);
    }
  }
}

/* ===========================================================================
   The loop
   ========================================================================= */

let isoPromptT = 0;

loop.add({
  update(dt: number, elapsed: number) {
    audio.update(dt);
    dtNow = dt;
    elapsedNow = elapsed;

    switch (mode) {
      case 'boot':
        boot.update(dt);
        break;

      case 'descent':
        descent.update(dt);
        break;

      case 'cycles':
        cycles?.update(dt, elapsed);
        cycles?.stepTransients(dt);
        break;

      case 'explore':
      case 'secret':
      case 'sector':
      case 'dying':
        player.update(dt);
        player.syncCamera();

        if (session) {
          // Inside a sector the Plaza is not drawn at all — the scene is the
          // sector's. Keeping it updated off-screen would cost frames for
          // nothing and would only pay off if we could ever see both.
          session.sector.update(dt, elapsed);
          clampToSector(player.position, session.def.half);
          updateThreat(dt, elapsed);
        } else {
          world.update(dt, elapsed, player.position);
          arcade.update(dt, elapsed, player.position);
          updateArcadeAudio();
          updatePortalFocus();
        }

        iso.update(dt, elapsed, player.position);
        updateFocus();
        updateEnergy(dt);
        break;
    }

    // Shared per-frame work.
    hud.update(dt);
    terminal.update(dt);
    chapter.update(dt);
    radio.update(dt);
    fx.update(dt);
    debugOverlay.update(dt, mode, player.position);

    // The material uniforms every shader reads: elapsed time and the audio
    // amplitude, so the grid lines breathe with the music.
    setMaterialTime(elapsed, audio.pulse);

    // The ISO speaks, unprompted, on her own schedule. Never on a timer the
    // player can read; only when they are close and have nothing else to do.
    if (mode === 'explore' && iso.isPresent) {
      isoPromptT -= dt;
      if (isoPromptT <= 0) {
        isoPromptT = 12;
        const line = iso.nextLine();
        if (line) {
          terminal.show({
            title: 'UNKNOWN PROCESS',
            lines: [{ text: line.text, tone: 'iso' }],
            actions: [{ label: 'ACKNOWLEDGE', primary: true, onClick: () => terminal.close() }],
          });
          iso.changeLink(4);
        }
      }
    }

    // Touch: the action button only appears when something is focused.
    if (player.usingTouch) {
      touch.setActionVisible(!!focused && mode === 'explore', hud.interactKey);
    }
  },
});

/* The render is the last thing that happens in a frame.

   Wiring it here rather than calling renderer.render() once at startup is the
   whole difference between a live world and a black canvas: the loop updates
   every system and then draws the result. Without this the canvas keeps the
   single frame drawn before the world had any light in it, and every HUD
   counter keeps ticking over an image that is never repainted. */
loop.onFrame = (_dt, elapsedNow2) => {
  renderer.render(elapsedNow2);
};

renderer.render(0);
loop.start();
boot.begin();

/* A first frame of the boot screen needs the loop running but nothing else
   touched, so the world is built up-front and simply not shown yet. */
world.group.add(iso.group);

/* ===========================================================================
   Diagnostics
   ========================================================================= */

// Kept deliberately small: this is a game, not a dashboard.
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __grid: { renderer, player, world, arcade, audio, quality, bus, seed },
  });
}

/** Exposed so the descent's skip button can reach it. */
(window as unknown as Record<string, () => void>).__gridSkip = () => {
  if (mode === 'descent') descent.skip();
};

/** Exposed for the boot screen's SKIP affordance. */
(window as unknown as Record<string, () => void>).__gridFastBoot = () => boot.fastForward();