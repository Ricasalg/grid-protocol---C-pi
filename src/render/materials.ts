/* ============================================================================
   Procedural materials.

   Almost every surface in the Grid is generated here rather than loaded. That
   keeps the build tiny, lets the floor react to gameplay (footsteps, music
   pulse, the descent), and means nothing depends on an external texture.

   Shared idea: a small library of GLSL chunks (grid lines, fresnel rim, glow
   falloff, hash noise) composed per-material, so the whole world speaks the
   same visual language from one place.
   ========================================================================== */

import * as THREE from 'three';
import { PALETTE } from '@/core/config';

/* -------------------------------------------------------------------------
   Shared GLSL chunks
   -------------------------------------------------------------------------- */

const CHUNK_HASH = /* glsl */ `
  float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    return fract((p + p) * p);
  }
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

/**
 * Antialiased grid lines.
 *
 * `gridLine` returns coverage for a line every `scale` world units, keeping a
 * constant apparent width regardless of distance. Naive `fract()` grids alias
 * badly at grazing angles, which is exactly the case on a floor the player
 * spends the whole game looking across; fwidth() fixes it.
 */
const CHUNK_GRID = /* glsl */ `
  float gridLine(vec2 uv, float scale, float thickness) {
    vec2 coord = uv / scale;
    vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    float line = min(g.x, g.y);
    return 1.0 - smoothstep(0.0, thickness, line);
  }

  // Two overlaid grids: fine subdivisions plus emphasised major lines.
  float gridMask(vec2 uv, float scale, float thickness, float majorEvery) {
    float fine = gridLine(uv, scale, thickness);
    vec2 coord = uv / (scale * majorEvery);
    vec2 g = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
    float major = 1.0 - smoothstep(0.0, thickness, min(g.x, g.y));
    return clamp(fine * 0.45 + major, 0.0, 1.0);
  }
`;

/** Fresnel rim term: edges brighten, faces stay dark. The core TRON read. */
const CHUNK_FRESNEL = /* glsl */ `
  float fresnel(vec3 viewDir, vec3 normal, float power) {
    return pow(1.0 - clamp(dot(normalize(viewDir), normalize(normal)), 0.0, 1.0), power);
  }
`;

/* -------------------------------------------------------------------------
   Shared uniform block
   ------------------------------------------------------------------------- */

/**
 * Time and audio reactivity are pushed to every material from one place, so a
 * single per-frame loop drives the whole world's pulse. `uPulse` follows the
 * music's amplitude; the grid breathing with it is most of what sells "the
 * Grid is a running system".
 */
export interface SharedUniforms {
  uTime: { value: number };
  uPulse: { value: number };
}

export const sharedUniforms: SharedUniforms = {
  uTime: { value: 0 },
  uPulse: { value: 0 },
};

/* -------------------------------------------------------------------------
   Floor
   -------------------------------------------------------------------------- */

export interface FloorMaterialOptions {
  color?: number;
  /** World units between fine lines. */
  scale?: number;
  /** How strongly the grid reacts to footfalls (0 disables). */
  footstepResponse?: number;
  fogNear?: number;
}

/**
 * The Grid floor: near-black, semi-reflective, with fine luminous lines that
 * pulse to the music and flare locally under the player's feet.
 *
 * "Reflection" here is faked in the shader rather than sampled from a render
 * target: the floor darkens and gains a faint vertical smear of the grid
 * colour at grazing angles, plus a mirrored, blurred copy of the light lines.
 * At the distances the player actually sees it, this is indistinguishable from
 * a real reflection and costs one extra grid evaluation instead of a second
 * scene render.
 */
export function createFloorMaterial(opts: FloorMaterialOptions = {}): THREE.ShaderMaterial {
  const {
    color = PALETTE.cyan,
    scale = 4.0,
    footstepResponse = 1.0,
  } = opts;

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
      uScale: { value: scale },
      uFootstep: { value: new THREE.Vector4(0, 0, 0, 0) }, // xz = position, z = age
      uFootstepResponse: { value: footstepResponse },
      uFogColor: { value: new THREE.Color(0x000000) },
      uFogDensity: { value: 0.0125 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4 uFootstep;
      uniform float uFootstepResponse;
      varying vec3 vWorld;
      varying float vRipple;

      void main() {
        vec3 pos = position;

        // Footstep ripple: an expanding ring displacement centred on the last
        // footfall. Age 0 -> just landed, 1 -> faded out.
        float age = uFootstep.w;
        if (age < 1.0 && age > 0.0 && uFootstepResponse > 0.0) {
          float d = distance(pos.xz, uFootstep.xy);
          float radius = age * 7.0;
          float ring = exp(-abs(d - radius) * 2.2) * (1.0 - age);
          pos.y += ring * 0.14 * uFootstepResponse;
          vRipple = ring;
        } else {
          vRipple = 0.0;
        }

        vec4 world = modelMatrix * vec4(pos, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColor;
      uniform float uScale;
      uniform vec4 uFootstep;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying vec3 vWorld;
      varying float vRipple;

      ${CHUNK_HASH}
      ${CHUNK_GRID}

      void main() {
        vec2 uv = vWorld.xz;

        // Fine grid + emphasised major lines every 8 cells.
        float g = gridMask(uv, uScale, 1.0, 8.0);

        // A second, much larger grid gives the floor a sense of scale so the
        // player can read distance while walking toward the light path.
        float major = gridLine(uv, uScale * 32.0, 1.6);

        // Pulse travelling outward from the arrival platform: the Grid's
        // heartbeat, and a directional cue that says "the centre is behind you".
        float dist = length(uv);
        float wave = sin(dist * 0.16 - uTime * 1.5) * 0.5 + 0.5;
        float waveBand = pow(wave, 6.0);

        float intensity = g * (0.34 + uPulse * 0.55) + major * 0.5;
        intensity += waveBand * 0.12 * (0.4 + uPulse);
        intensity += vRipple * 1.5;

        // Fake reflection: brighter, smeared lines when viewed at a grazing
        // angle, faked by boosting the grid with a vertically-stretched sample.
        float graze = 1.0 - clamp(abs(normalize(cameraPosition - vWorld).y), 0.0, 1.0);
        float reflectMask = gridLine(uv * vec2(1.0, 0.22), uScale, 1.2);
        float reflect = reflectMask * pow(graze, 2.4) * 0.32;

        // Base is very dark but not pure black: keeps the plane readable and
        // stops large areas from banding in the composite's grain pass.
        vec3 base = vec3(0.004, 0.012, 0.020);

        vec3 col = base;
        col += uColor * intensity * 0.85;
        col += uColor * reflect;

        // Localised glow under the player's feet, always present: the player
        // is a light source in a dark world, which keeps them readable.
        float prox = exp(-distance(uv, uFootstep.xy) * 0.09) * 0.35;
        col += uColor * prox * (0.5 + uPulse * 0.4);

        // Distance fade into black. Exponential fog, matched to the scene's.
        float d = distance(cameraPosition, vWorld);
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
        col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    fog: false,
    transparent: false,
    depthWrite: true,
  });
}

/* -------------------------------------------------------------------------
   Light path (the road to the Arcade)
   -------------------------------------------------------------------------- */

/**
 * The guidance path. Bright, wide, unmistakable, with light pulses travelling
 * along it toward the Arcade so the direction reads without any text.
 */
export function createLightPathMaterial(color: number = PALETTE.cyan): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
      uFogColor: { value: new THREE.Color(0x000000) },
      uFogDensity: { value: 0.0125 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColor;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying vec3 vWorld;

      ${CHUNK_HASH}

      void main() {
        // vWorld.x runs across the path; vWorld.z runs along it (0 at the
        // platform, increasing toward the Arcade).
        float across = abs(vWorld.x);
        float along = vWorld.z;

        // Soft-edged core so the path has a glow rather than a hard border.
        float core = exp(-across * 0.55);

        // Pulses travelling toward the Arcade. Three in flight at different
        // phases, sped up by the music.
        float speed = 9.0 + uPulse * 12.0;
        float p = fract((along / 46.0) - uTime * (speed / 46.0));
        float pulseA = exp(-pow((p - 0.5) * 7.0, 2.0));
        float p2 = fract((along / 31.0) - uTime * (speed / 31.0) + 0.4);
        float pulseB = exp(-pow((p2 - 0.5) * 9.0, 2.0)) * 0.6;

        // Static rail lines along both edges: permanent, so the path is
        // findable even when no pulse is in view.
        float rail = exp(-abs(across - 3.1) * 9.0);

        float intensity = core * 0.30 + rail * 0.85 + pulseA * 0.9 + pulseB * 0.5;
        intensity *= 0.75 + uPulse * 0.45;

        vec3 col = uColor * intensity;

        float d = distance(cameraPosition, vWorld);
        float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
        col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

        gl_FragColor = vec4(col, clamp(intensity, 0.0, 1.0));
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Structural surfaces (monoliths, pylons, buildings)
   -------------------------------------------------------------------------- */

/**
 * The workhorse surface for architecture. Dark faces, luminous edges, a
 * scrolling data texture on the sides, and a fresnel rim so silhouettes stay
 * legible against a black sky without needing real lights.
 */
export function createStructureMaterial(
  color: number = PALETTE.cyan,
  opts: { emissiveEdges?: number; scanSpeed?: number; windowDensity?: number } = {},
): THREE.ShaderMaterial {
  const { emissiveEdges = 1.0, scanSpeed = 0.35, windowDensity = 1.0 } = opts;

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
      uEdge: { value: emissiveEdges },
      uScanSpeed: { value: scanSpeed },
      uWindowDensity: { value: windowDensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec3 vView;
      varying vec2 vUv;

      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);

        // View vector in world space, so fresnel stays correct for instanced
        // and rotated geometry. cameraPosition is a uniform Three.js injects
        // into every shader; deriving it from inverse(viewMatrix) would need
        // GLSL ES 3.00, which we do not compile against.
        vView = cameraPosition - world.xyz;

        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColor;
      uniform float uEdge;
      uniform float uScanSpeed;
      uniform float uWindowDensity;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec3 vView;
      varying vec2 vUv;

      ${CHUNK_HASH}
      ${CHUNK_FRESNEL}

      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(vView);

        // Dark, slightly metallic body. Deliberately near-black: in this world
        // surfaces are defined by their lines, not their faces.
        vec3 col = vec3(0.006, 0.014, 0.024);

        // Fresnel rim: the silhouette.
        float rim = fresnel(V, N, 3.0);
        col += uColor * rim * 0.55 * uEdge;

        // Face-local grid, giving every surface the same visual DNA as the
        // floor but scaled to the object's own proportions.
        float g = gridLine(vUv * vec2(6.0, 10.0), 1.0, 1.2);
        col += uColor * g * 0.14;

        // Vertical scan: a bright band travelling up the face, like data
        // moving through the structure. Ties the city to the music.
        float scan = fract(vWorld.y * 0.09 - uTime * uScanSpeed);
        float scanBand = exp(-pow((scan - 0.5) * 9.0, 2.0));
        col += uColor * scanBand * (0.30 + uPulse * 0.5) * uEdge;

        // Emissive windows: sparse bright cells, flickering on a hashed
        // per-cell phase so the city looks inhabited without costing lights.
        vec2 cell = floor(vUv * vec2(8.0, 24.0) * uWindowDensity);
        float lit = step(0.82, hash21(cell + floor(vWorld.xz)));
        float flick = 0.6 + 0.4 * hash11(uTime * 0.7 + hash21(cell) * 40.0);
        col += uColor * lit * flick * 0.5 * g;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Skyline (distant city)
   -------------------------------------------------------------------------- */

/**
 * The distant city. Rendered as instanced boxes with an emissive window
 * pattern and a strong distance fade, so thousands of towers cost one draw
 * call and read as a huge, hazy metropolis.
 */
export function createSkylineMaterial(color: number = PALETTE.cyan): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
      },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vHeight;

      void main() {
        vUv = uv;
        // instanceMatrix carries each tower's placement. Three.js already binds
        // it for InstancedMesh, so we only apply it once.
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vHeight = world.y;
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColor;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vHeight;

      ${CHUNK_HASH}

      void main() {
        // Windows as a hashed grid on the tower's UVs. Density is high so the
        // towers read as fine-grained surfaces even at low internal resolution.
        vec2 cell = floor(vUv * vec2(9.0, 40.0));
        float r = hash21(cell);
        float lit = step(0.55, r);
        float flick = 0.65 + 0.35 * hash11(uTime * 0.5 + r * 60.0);

        vec3 col = vec3(0.004, 0.010, 0.018);
        col += uColor * lit * flick * 0.42;

        // A few towers carry a brighter vertical spine: landmarks in the haze.
        float spine = step(0.94, hash21(vec2(floor(vUv.x * 9.0), 3.7)));
        col += uColor * spine * 0.55;

        // Distance fade. The city must feel far away and partly unresolved.
        float d = distance(cameraPosition, vWorld);
        float fade = smoothstep(900.0, 220.0, d);
        float haze = mix(0.10, 0.42, fade);
        col *= haze;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Aurora / sky
   -------------------------------------------------------------------------- */

/**
 * Sky dome. No sun, no stars — a black field with a distant light curtain, slow
 * crossing data trails, and a faint horizon glow. It is what makes the space
 * feel vast rather than like an enclosed room.
 */
export function createSkyMaterial(
  colors: number[] = [PALETTE.cyan, PALETTE.violet],
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColorA: { value: new THREE.Color(colors[0] ?? PALETTE.cyan) },
      uColorB: { value: new THREE.Color(colors[1] ?? PALETTE.violet) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying vec3 vDir;

      ${CHUNK_HASH}

      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);

        // Base: near black, with a cold lift just above the horizon so the
        // skyline has something to silhouette against.
        vec3 col = mix(vec3(0.004, 0.012, 0.022), vec3(0.001, 0.002, 0.006), pow(h, 0.55));

        // Aurora: two interfering sine curtains high in the sky. They drift
        // rather than pulse — they are the Grid dreaming, not its machinery.
        float a1 = sin(vDir.x * 2.4 + uTime * 0.09) * 0.5 + 0.5;
        float a2 = sin(vDir.z * 1.7 - uTime * 0.06 + vDir.y * 2.0) * 0.5 + 0.5;
        float curtain = pow(a1 * a2, 2.2) * smoothstep(0.02, 0.62, h);
        col += mix(uColorA, uColorB, a1) * curtain * (0.11 + uPulse * 0.10);

        // Data trails: thin bright streaks crossing the sky. They are the only
        // thing in the sky that moves fast, which suggests traffic.
        float trail = smoothstep(0.982, 1.0, hash11(floor(vDir.x * 40.0 + floor(uTime * 1.4) * 7.3)));
        col += uColorA * trail * smoothstep(0.1, 0.7, h) * 0.6;

        // Horizon bloom, faint, symmetric — the city's own light bouncing off
        // an atmosphere the Grid does not admit to having.
        float horizon = exp(-pow((h - 0.5) * 16.0, 2.0));
        col += uColorA * horizon * 0.05;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Particles
   -------------------------------------------------------------------------- */

/**
 * Rising motes. Point sprites with a soft radial falloff, wrapped vertically
 * so the field is infinite for a fixed buffer size.
 */
export function createParticleMaterial(
  color: number = PALETTE.cyan,
  sizeScale: number = 1.0,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
      uSize: { value: sizeScale },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSize;
      uniform float uPixelRatio;
      attribute float aSeed;
      attribute float aSpeed;
      varying float vAlpha;

      void main() {
        vec3 p = position;

        // Rise, with a per-particle drift and a wrap so the field never ends.
        p.y = mod(p.y + uTime * aSpeed, 90.0);
        p.x += sin(uTime * 0.24 + aSeed * 12.0) * 2.4;
        p.z += cos(uTime * 0.19 + aSeed * 9.0) * 2.4;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float dist = -mv.z;

        // Fade in at the bottom of the wrap and out at the top, so particles
        // never pop into or out of existence.
        float cycle = p.y / 90.0;
        vAlpha = smoothstep(0.0, 0.12, cycle) * (1.0 - smoothstep(0.6, 1.0, cycle));

        // Near particles slightly larger; keeps the field from looking uniform.
        float size = uSize * (1.0 + aSeed) * (34.0 / max(dist, 1.0));
        gl_PointSize = clamp(size * uPixelRatio, 1.0, 22.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uPulse;
      varying float vAlpha;

      void main() {
        // Radial falloff, squared, so the sprite has a soft core and no
        // visible square edge (the classic point-sprite giveaway).
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;

        float falloff = pow(1.0 - d * 2.0, 2.4);
        float a = falloff * vAlpha * (0.5 + uPulse * 0.5);

        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Holographic panels (terminals, sign, the ISO's projections)
   -------------------------------------------------------------------------- */

/**
 * Screen-space holographic surface. Used for the Arcade sign, in-world
 * terminals and the ISO's manifestations — anything that should read as
 * projected light rather than solid matter.
 */
export function createHoloMaterial(color: number = PALETTE.cyan): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;

      ${CHUNK_HASH}

      void main() {
        vec2 uv = vUv;

        // Scanlines across the panel.
        float lines = 0.65 + 0.35 * sin(uv.y * 260.0 - uTime * 2.2);

        // Data blocks scrolling upward: the panel is showing something.
        vec2 block = floor(vec2(uv.x * 14.0, uv.y * 22.0 - uTime * 0.8));
        float data = step(0.76, hash21(block)) * 0.55;

        // Occasional glitch: a horizontal slice displaced sideways.
        float glitchRow = floor(uv.y * 44.0);
        float glitch = step(0.995, hash11(glitchRow + floor(uTime * 5.0)));
        uv.x += glitch * (hash11(glitchRow * 3.1) - 0.5) * 0.08;

        // Edge falloff so the panel has no hard rectangular border.
        vec2 d = abs(uv - 0.5);
        float edge = (1.0 - smoothstep(0.42, 0.5, d.x)) * (1.0 - smoothstep(0.42, 0.5, d.y));

        float a = (lines * 0.35 + data) * edge * uOpacity * (0.65 + uPulse * 0.35);
        vec3 col = uColor * a;

        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Tunnel (the descent)
   -------------------------------------------------------------------------- */

/**
 * The data tunnel. A cylinder of luminous longitudinal lines plus travelling
 * rings, viewed from inside. The speed cue comes almost entirely from the
 * ring spacing and the moving glyph blocks, so this shader concentrates on
 * making the wall itself read as fast-moving signal.
 */
export function createTunnelMaterial(
  color: number = PALETTE.cyan,
  opts: { speed?: number; intensity?: number } = {},
): THREE.ShaderMaterial {
  const { speed = 1.0, intensity = 1.0 } = opts;

  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
      uSpeed: { value: speed },
      uIntensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vView;

      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vView = cameraPosition - world.xyz;

        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColor;
      uniform float uSpeed;
      uniform float uIntensity;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vView;

      ${CHUNK_HASH}
      ${CHUNK_FRESNEL}

      void main() {
        // uv.x wraps around the tunnel, uv.y runs along it.
        float around = vUv.x;

        // Longitudinal lines: evenly spaced bright filaments.
        float strands = abs(fract(around * 24.0) - 0.5) * 2.0;
        float filament = pow(1.0 - strands, 14.0);

        // Travelling rings: the primary speed cue. Frequency rises with uSpeed
        // so acceleration is visible in the geometry, not just the audio.
        float rings = fract(vUv.y * 40.0 - uTime * uSpeed * 5.0);
        float ring = exp(-pow((rings - 0.5) * 11.0, 2.0));

        // Glyph blocks: brighter patches riding the rings, like packets.
        float blockSeed = hash21(vec2(floor(around * 24.0), floor(vUv.y * 40.0 - uTime * uSpeed * 5.0)));
        float packet = ring * step(0.55, blockSeed);

        // Inner edge glow (fresnel on a cylinder viewed from inside is the
        // opposite of the usual case, so invert the term).
        float edge = fresnel(-normalize(vView), normalize(vNormalW), 1.4);

        float lum = filament * 0.5 + ring * 0.35 + packet * 0.8 + edge * 0.12;
        lum *= (0.7 + uPulse * 0.5) * uIntensity;

        vec3 col = uColor * lum;
        gl_FragColor = vec4(col, clamp(lum, 0.0, 1.0));
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Data walls (the world's edge)
   -------------------------------------------------------------------------- */

/**
 * The boundary of the map. Not an invisible wall: a dense curtain of falling
 * data that is opaque and obviously a system barrier. The player can read it
 * as "you cannot pass", which is why it is built from the same vocabulary as
 * everything else.
 */
export function createDataWallMaterial(color: number = PALETTE.cyanDim): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: sharedUniforms.uTime,
      uPulse: sharedUniforms.uPulse,
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPulse;
      uniform vec3 uColor;
      varying vec2 vUv;

      ${CHUNK_HASH}

      void main() {
        // Dense falling data columns.
        vec2 col = floor(vec2(vUv.x * 90.0, vUv.y * 26.0 - uTime * 1.6));
        float r = hash21(col);
        float streak = step(0.62, r);

        // Occasional bright "packets" running the full height.
        float packet = step(0.985, hash11(floor(vUv.x * 90.0) + floor(uTime * 2.2)));

        float base = streak * 0.35 + packet * 0.8;

        // Fade out at the top so the wall has no hard ceiling line.
        base *= 1.0 - smoothstep(0.55, 1.0, vUv.y);
        base *= 0.5 + uPulse * 0.4;

        gl_FragColor = vec4(uColor * base, clamp(base, 0.0, 1.0));
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/* -------------------------------------------------------------------------
   Small utilities
   -------------------------------------------------------------------------- */

/**
 * Line material for EdgesGeometry outlines. Cheaper than a full structure
 * material and reads as pure wireframe, which is how most of the world's
 * detail is done.
 */
export function createEdgeMaterial(
  color: number = PALETTE.cyan,
  opacity = 0.85,
): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
}

/** Uniform-coloured additive material for rings, halos and impact flashes. */
export function createGlowMaterial(
  color: number = PALETTE.cyan,
  opacity = 1.0,
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
}

/**
 * Push the shared per-frame values into a material created by this module.
 * Materials not built here (MeshBasicMaterial etc.) ignore these.
 */
export function setMaterialTime(elapsed: number, pulse: number): void {
  sharedUniforms.uTime.value = elapsed;
  sharedUniforms.uPulse.value = pulse;
}