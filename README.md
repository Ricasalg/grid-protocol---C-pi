# GRID PROTOCOL

> *Everything you can see is inside a system. Nothing you do here touches yours.*

An interactive, explorable 3D browser experience set inside a forgotten digital
system. First person, real-time, in WebGL.

Inspired by the atmosphere of *TRON: Legacy*, but the world, characters,
systems, names and music are original to this project. See [`CREDITS.md`](./CREDITS.md).

---

## Run it

Requires **Node.js 18+**.

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**.

That is the whole procedure. There is no second step, no asset pipeline to run,
no account, no API key, and nothing to configure.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload at `localhost:5173`. |
| `npm run build` | Typecheck, then production build into `dist/`. |
| `npm run preview` | Serve the production build at `localhost:4173`. |
| `npm run typecheck` | Typecheck only. |

### Controls

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look (click the canvas to capture the pointer) |
| `Shift` | Run |
| `E` / `Enter` | Interact with the highlighted object |
| `Q` | Leave a sector and return to the Plaza |
| `Esc` | Release the pointer |
| `Tab` / `M` | Network map |
| `O` | Settings — volume, mute, quality, reduced motion, **delete save** |

Settings opens with `O`, and also from the discreet corner button.

`Q` rather than `Esc` for leaving a sector is deliberate: `Esc` already means
"release the pointer" everywhere, and a key with two meanings makes both feel
broken. Nothing on screen mentions `Q` yet, which is a real gap.

**Touch:** left half of the screen is a virtual joystick, right half is drag to
look, with a contextual interaction button on the right.

### The first thirty seconds

The intro is short and skippable — press `Esc` or click **SKIP** at any point.
Clicking also unlocks the browser's audio, which cannot start without a gesture.

Walk towards the light path on the floor. It leads to the Arcade, about 150
metres north. You do not need to read anything to know where to go.

After the opening — winning a Light Cycle round, then finding the door behind the
Arcade — four more doors stand in the Plaza, fanned behind where you arrive.
They are labelled only by node name. What is behind each one is not written down
anywhere, which is the point.

---

## Security

This project cannot affect your machine, and this is enforced by what it does not
do:

- It **does not** read, write, move or delete any file on your computer.
- It **does not** access your documents, folders, or any local path.
- It **does not** execute programs or shell commands.
- It **does not** change Windows settings, the registry, or environment variables.
- It **does not** install anything, and requests no dangerous permissions.
- It **does not** use the File System Access API or a file picker.
- It makes **no network requests** at runtime — no CDN, no font service, no
  analytics, no telemetry. Fonts are served from this repository.

Every terminal, file, log and "network connection" in the game is fictional
content drawn inside the WebGL canvas.

**Your progress is stored only in this browser**, in `localStorage`, under
`grid-protocol.save.v1` and `grid-protocol.settings.v1`. To erase it, open
**Settings → DELETE SAVE** and confirm. That removes the keys and reloads.

---

## Project layout

```
src/
├── main.ts              The seam: constructs every system and routes between modes
├── core/
│   ├── bus.ts           Typed event bus — modules never import each other to signal
│   ├── config.ts        Quality tiers, palette, timings, motion preferences
│   ├── rng.ts           Seeded PRNG (mulberry32) + frame-rate-independent damping
│   └── save.ts          localStorage persistence, coalesced to idle
├── render/
│   ├── renderer.ts      WebGLRenderer + EffectComposer (bloom, vignette, aberration, grain)
│   ├── loop.ts          Fixed-clock update loop with a median-based perf watchdog
│   └── materials.ts     Every ShaderMaterial in the project, in one place
├── grid/
│   ├── world.ts         The Grid: esplanade, skyline, light path, data walls
│   └── descent.ts       The 12.6s cinematic entry — one continuous camera, no cuts
├── player/
│   └── controller.ts    First-person movement, capsule-vs-AABB collision, touch
├── arcade/
│   └── building.ts      The Arcade: shell, sign, cabinets, the Light Cycle machine
├── lightcycles/
│   └── game.ts          The Light Cycle game: arena, walls, AI opponents, win/lose
├── iso/
│   └── iso.ts           QUELL — presence, light pattern, dialogue, the LINK bond
├── nodes/
│   ├── types.ts         Node/sector model
│   └── network.ts       The node graph, discovery state machine, pathfinding
├── audio/
│   └── engine.ts        Procedural Web Audio: synthesis, spatial sources, area blending
├── ui/
│   ├── boot.ts          The boot sequence
│   ├── hud.ts           ENERGY, sector, subtitles — fades out when unneeded
│   ├── map.ts           The network map, revealed progressively
│   ├── terminal.ts      Fictional terminals
│   ├── overlays.ts      Chapter cards, connection-lost, endings
│   ├── settings.ts      Volume, mute, quality, motion, delete save
│   ├── touch.ts         Mobile joystick and look-drag
│   └── dom.ts           Minimal element helper
├── data/
│   └── network.json     Sector and node content — data, not code
├── assets/
│   └── fonts/           Self-hosted .woff2 (Orbitron, Rajdhani) — SIL OFL 1.1
└── styles/
    ├── main.css         All UI
    └── font.css         Self-hosted @font-face declarations
```

`src/vite-env.d.ts` is a one-line Vite type reference. There are no other files —
in particular, `src/narrative/` and `src/vfx/` are Fase 2 work, not Fase 1.

### Architecture principles

**Modules never import each other to signal.** They emit typed events on a
central bus. `Light Cycle game won` does not need to know that the HUD exists.

**Content is data.** Sector definitions live in `src/data/network.json`; QUELL's
dialogue is a table in `src/iso/iso.ts`. Adding a sector means editing JSON, not
editing logic.

**Every system is separable and swappable.** `renderer.setScene()` takes any
scene. The descent, the Grid and the Light Cycle arena are three independent
scenes; the game is the thing that moves between them.

**Everything is procedural.** There is not one binary asset in the repository —
no models, no textures, no audio files. Geometry is generated, materials are
GLSL, and sound is synthesised by oscillators at runtime. This is a deliberate
consequence of the "dark environment, few lights, emissive and bloom" direction:
a world built from light needs no texture maps.

**Determinism where it matters.** Generation uses a seeded PRNG so a run is
reproducible from `runSeed`, with a separate `volatileRng` for visual jitter
that should not be reproducible.

---

## Accessibility

- `prefers-reduced-motion` is respected automatically. The descent becomes a
  simple fade, and head bob and camera motion are disabled.
- **Settings → REDUCED MOTION** overrides that: `SYSTEM` follows the OS,
  `REDUCE` forces it on for anyone who gets motion sick here without the OS
  flag, `FULL` forces the cinematic. It takes effect immediately.
- `prefers-reduced-flash` softens the intro flashes.
- A photosensitivity notice appears at boot, and light effects can be damped.
- The whole experience is playable with keyboard alone.

---

## Design notes

The reasoning behind the stack, the architecture and the phase plan — why these
choices and not others — is in [`DESIGN-NOTES.md`](./DESIGN-NOTES.md).

## Credits

Original work. See [`CREDITS.md`](./CREDITS.md) for licences and attributions.