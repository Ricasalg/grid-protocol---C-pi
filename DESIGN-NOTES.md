# GRID PROTOCOL — design document

Written before implementation, per the brief. This is the reasoning behind the
code; the code itself is documented in [`README.md`](./README.md) and in the
header comment of each module.

---

## (a) How I read the brief

Your priority order was **atmosphere → exploration → discovery → playability →
narrative**. I took that literally, and it decided almost everything else.

It rules out the two readings I think the brief is warning about. The first is
"a website with a TRON skin" — a landing page with neon CSS, a hero video, and
some lore text. The second is a literal clone: film sets, film dialogue, film
character designs. You asked for neither, and the priority order is what
excludes them, because a themed site is *about* TRON while this must be *set
inside a system*.

So the reading I committed to:

**The player is not looking at a world. The player is a process running inside
one, and the interface is the world itself.**

Three consequences fall out of that, and they shaped the build:

**The interface disappears.** Because the world is the protagonist (§13), there
is no HUD while exploring beyond ENERGY, no minimap, no quest marker, no
inventory screen you "open". You learn where to go by reading the floor. §18
asks that "the player knows where to go without text" — so the light path on the
floor is not decoration, it is the tutorial.

**Files are doors, not documents** (§11). `PROGRAM_001` is not a text file you
read. It is a place you go. This is the difference between a site and a world,
and it is the mechanic I would protect hardest.

**The system is the antagonist, and it is not malevolent — it is
administrative.** The purge is not a villain's cruelty, it is maintenance. The
ISO is not a reward for exploration, she is something the system is trying to
reclaim. The horror, such as it is, is bureaucratic.

On the ISO specifically (§3.4): I treated her as a character with a point of
view, not a romance track bolted on. The LINK meter is deliberately **not** a
dialogue meter — it has no branching text attached and no percentage on screen.
It rises when you do things that cost you something and falls when you do things
that don't, which is a design statement about what the relationship *is* rather
than a bar to fill. Her secret is never stated. It is assembled by the player
from fragments she chooses to give, and the gaps are load-bearing.

On endings (§3.4 requires at least three): they key off LINK bands, so they are
a consequence of how you treated her, not of a menu choice at the end. The
question each one answers is whether a relationship can be real inside a
simulated world — which is the same question the player is living inside the
whole time.

### What "inside a system" forced technically

This is the part that determined the stack. Being *inside* means:

- **No loading screens between areas.** Transitions are continuous — the
  descent is one camera for 12.6 seconds with no cut, the Light Cycle machine
  rewrites the scene in place rather than opening a new page (§7).
- **The world must be generated, not authored.** A hand-modelled city of
  thousands of buildings is not shippable in a browser as a design document;
  a seeded generator is (§12).
- **Audio cannot be files.** If the world is generated, its music has to be too,
  or it will not match the world's dimensions. §14 asks for original audio
  anyway.
- **The player must be able to be anywhere, so everything must be cheap.**
  Which means emissive materials and bloom instead of lights and shadow maps.

---

## (b) Stack, and why

**Vite + TypeScript + Three.js + Web Audio API. No other runtime dependency.**

Three.js is the only library. I considered Babylon.js and rejected it — heavier,
and its scene graph fights the "swap the whole scene" transition model this
game needs. Three is also the only one where hand-writing GLSL is a first-class
path rather than a workaround.

TypeScript in strict mode with `noUnusedLocals`, `noUnusedParameters` and
`noImplicitOverride`. For a project of this shape that is not pedantry: half the
work is a large set of small interfaces between modules, and the compiler is
what catches a signature drifting out from under a caller. `npm run build`
typechecks first, so a type error fails the build rather than shipping.

Vite for the dev server and build. Nothing about it is load-bearing — the
project is plain ES modules and would build under any bundler.

The Web Audio API rather than audio files, per §14. This is the decision I feel
best about, and it does more than satisfy the brief:

- It produces **zero audio assets**, which matters for §2 and §6.6.
- It makes the music **procedurally parameterised per area** (§14's "sonic
  identity"), so crossing a sector boundary is a crossfade between parameter
  sets rather than a fade between two encoded files. It is genuinely seamless.
- It makes the system **modular for licensed music later**, as §14 requires:
  each area is a named parameter block, so swapping in an audio file later means
  replacing one function, not restructuring the engine.
- It lets me export the music's amplitude envelope to the renderer. The grid
  lines on the floor pulse to the beat because the *same* signal that drives the
  oscillator amplitude drives the shader uniform. Those two things are in sync
  because they are the same number. A background track cannot do that.

One consequence worth flagging: synthesised music will not be as good as
recorded music. I have written it to be atmospheric and appropriate rather than
to imitate a reference, which §14 explicitly permits. If you later want real
music in the Grid, the seam is already there.

### The decision that shaped the graphics

§6.5 asks for a dark environment with few real lights and emissive materials
plus bloom. That is not just an art direction, it is what makes a 900-tower
procedural city run at 60fps in a browser with one draw call for the skyline.

**There is not a single image, model or audio file in this repository.** Every
building, every floor line, every particle and every sound is generated at
runtime. §6.6 says to prioritise procedural content and only use `.glb` where
genuinely necessary; for this project the honest answer turned out to be
nowhere. A world made of light does not need texture maps.

### Two constraints I would flag

**Fonts.** §6.6 forbids depending on an external CDN for anything critical, but
also asks for a self-hosted futuristic `.woff2`. These conflict if you have no
font file. I resolved it by vendoring Orbitron and Rajdhani (both SIL OFL 1.1,
which explicitly permits self-hosting) into `src/assets/fonts/` — 57 kB total —
and writing the `@font-face` rules with a system fallback stack, so if the files
are missing the game still runs.

**GLSL version.** Three's shaders compile as GLSL ES 1.00, which has no
`inverse()`. World-space billboarding derived that way silently produces a
black screen rather than a compile error in the build, so I used Three's
injected `cameraPosition` instead. This is the kind of failure that only appears
at runtime, which is why I flag it.

---

## (c) Architecture

```
src/
├── main.ts              The seam — constructs everything, routes between modes
├── core/                No Three.js, no DOM. Foundation.
│   ├── bus.ts             Typed event bus
│   ├── config.ts          Quality tiers, palette, timings, motion preferences
│   ├── rng.ts             Seeded PRNG + frame-rate-independent damping
│   └── save.ts            localStorage persistence
├── render/              Three.js plumbing.
│   ├── renderer.ts        WebGLRenderer + EffectComposer
│   ├── loop.ts            Update loop + perf watchdog
│   └── materials.ts       Every shader in one file
├── grid/                The Grid world.
│   ├── world.ts           Esplanade, skyline, light path, data walls
│   └── descent.ts         The 12.6s cinematic entry
├── player/              controller.ts — movement, collision, touch
├── arcade/              building.ts — the Arcade and its Light Cycle machine
├── lightcycles/         game.ts — the actual arena game
├── iso/                 iso.ts — QUELL: presence, dialogue, LINK
├── nodes/               The network graph and discovery state machine
├── audio/               engine.ts — the whole sound system
├── ui/                  DOM layer. Knows nothing about Three.js.
└── data/                network.json — content as data
```

Four rules, each of which I held to:

**1. Modules never import each other to signal.** Everything goes through a
typed `EventBus`. "Light Cycle game won" emits `cycle:win`; the HUD, the audio
engine and the progression system each decide independently what that means.
No module holds a reference to another to poke it. This is what let the Light
Cycle game be a self-contained file that knows nothing about the Arcade it sits
in.

**2. Content is data.** Sector definitions are in `src/data/network.json`. QUELL's
dialogue is a table of `{id, text, requires, once}`. Adding a sector means
editing JSON. The brief asks for content in data files separate from code
(§16), and it also asks for the sectors to feel authored rather than
algorithmic — which is exactly what a data file lets you do.

**3. Any system can be replaced because nothing owns the canvas.**
`renderer.setScene()` takes any scene. The descent, the Grid and the Light Cycle
arena are three independent scenes; the game is the thing that moves between
them. §7's "enter the game without opening a new page" is not a trick, it falls
out of this.

**4. Determinism where it matters.** Generation uses a seeded mulberry32 PRNG,
so a run is reproducible from `runSeed` — required by §12. A separate
`volatileRng` backed by `Math.random` handles visual jitter that *should not* be
reproducible, like particle drift. Mixing these up is how procedural generation
becomes unpredictable in the wrong way.

The UI layer is deliberately isolated: it is DOM over the canvas, and no `ui/`
module imports Three.js. That is what keeps §13's "the world is the
protagonist" cheap to enforce — the UI can only ever be a thin overlay, because
it has no handle on the 3D world at all.

---

## (d) Phased plan

Ordered so that each phase is **playable on its own**, not a scaffold.

### Fase 1 — the Grid exists *(delivered)*

Boot screen → descent → a real 3D Grid → the Arcade → Light Cycles → secret
passage → first ISO encounter → the first sector of the network → a map that
reveals itself → the first roguelike pressure → LINK begins.

The point of this phase is not feature count. It is proving the loop:
**explore → find a file-door → enter a game → something changes → the map is
bigger than before.** Everything else is built outward from that loop.

### Fase 2 — the network is bigger than one session

More sectors with distinct identities, ACCESS-gated progression, varied
file-doors, enemies that make the boundary dangerous rather than merely
emphatic, the `src/narrative/` and `src/vfx/` modules, the rest of QUELL's arc.

### Fase 3 — the world is finished

Easter eggs, multiple endings, the audio system accepting real music, final art
pass.

### Per phase, per §17

Complete code, one command to run it, and an honest list of what is implemented
and what is not.

---

## Status of Fase 1

Implemented and building:

- Boot sequence with the audio unlock and a skippable intro
- The 12.6s descent — one continuous camera, no cuts, skip button, reduced-motion
  fallback
- The Grid: esplanade, procedural skyline, pulsing light path, the landmark,
  monoliths, fog, particles, data walls
- First-person controller: acceleration, inertia, head bob, capsule-vs-AABB
  collision, full touch controls
- The Arcade: shell, neon sign, cabinets, the Light Cycle machine, the
  deliberately unremarkable back door
- Light Cycles: a real arena game — wall trails, collisions, AI opponents at
  three difficulties, win and lose conditions
- The secret passage, gated on winning
- QUELL: presence scale, off-beat light pattern, gated dialogue, LINK with
  persistence
- The network map with progressive discovery
- Boundary energy drain as the first roguelike mechanic, with `CONNECTION LOST`
  and a restart that keeps progression
- Settings: volume, mute, quality, reduced motion, **delete save**

## Fase 2 — the network opens

What Fase 1 deliberately left closed is now walkable.

- **Four sector doors in the Plaza**, fanned behind the spawn so none occludes
  another, each brightening as you approach rather than carrying a map marker.
  Entering one builds the world synchronously and swaps the scene — no loading
  screen, because a loading screen would admit that this is content being
  fetched rather than a place being walked into.
- **ACCESS that actually rises.** Crossing the secret passage grants 2; each
  sector's arrival grants the level the *next* door needs. A door that required
  the key sitting behind it could never be opened, so the ladder deliberately
  runs one step ahead of the player.
- **Pursuers.** Three of the four sectors are hostile. Strikes drain ENERGY,
  proximity drives a `dread` distortion, and the boundary drain now scales to
  the sector's own extent rather than the Plaza's.
- **`narrative/` and `vfx/`** — the two modules §16 named that were missing.
  The first holds the per-sector beats in one readable table; the second owns
  the three screen-level effects, which have no position in the world and so
  could not live in the scene or in `main.ts`.
- **The ISO arc and three endings**, gated behind fragments the player has to
  have found. Corrupt grants no ACCESS — it is the one place the chain can be
  short-circuited, which is what makes reaching the Core a decision.

Not yet done, and stated plainly:

- **It has never been run in a browser.** It typechecks and builds, and every
  module transforms, but WebGL shader compilation, Pointer Lock and Web Audio
  only fail at runtime. I am not going to claim §18 is met until I have seen it
  run.
- **No mobile verification.** Touch controls are implemented but untested.
- **Pursuer hue is hardcoded** to the amber default, so Corrupt and the Core
  look more alike than their data says they should.
- **Leaving a sector uses `Q`, not `Escape`.** Escape is universally "release
  the pointer"; giving it a second meaning makes both feel unreliable. `Q` is
  undiscoverable, though — nothing tells the player it exists.