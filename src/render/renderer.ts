/* ============================================================================
   Renderer, post-processing stack and the render loop.

   The whole project is emissive-line-on-black, so bloom is not decoration
   here, it is load-bearing: without it the Grid reads as flat geometry. The
   stack is therefore deliberately cheap-but-wide (low internal resolution,
   strong blur) rather than expensive-and-accurate.

   Order: scene -> (mirrored reflection pass) -> bloom -> composite -> screen
   ========================================================================== */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { quality } from '@/core/config';
import { loadSettings } from '@/core/save';
import { clamp } from '@/core/rng';

/* -------------------------------------------------------------------------
   Composite shader: chromatic aberration + vignette + film grain.

   Runs after bloom. Deliberately subtle — the brief asks for "minimal
   aberration" and "subtle grain", and both go wrong fast when overdone.
   -------------------------------------------------------------------------- */

const CompositeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uAberration: { value: 0.0012 },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.035 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** Extra scanline strength, raised during the descent. */
    uInterference: { value: 0 },
    /** 0..1 full-screen damage flash. Scaled by the reduced-flash setting. */
    uPunch: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uInterference;
    uniform float uPunch;
    uniform vec2 uResolution;
    varying vec2 vUv;

    // Cheap hash-based noise. Enough for grain; no texture fetch.
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Radial chromatic aberration: zero at centre, strongest at the edges.
      float amount = uAberration * (0.35 + r2 * 2.2);
      vec2 dir = normalize(centred + 1e-6);

      vec3 col;
      col.r = texture2D(tDiffuse, uv - dir * amount).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + dir * amount).b;

      // Vignette.
      float vig = 1.0 - smoothstep(0.28, 0.92, length(centred) * 1.28);
      col *= mix(1.0 - uVignette, 1.0, vig);

      // Animated grain, slightly stronger in the shadows where banding shows.
      float n = hash(uv * uResolution + fract(uTime) * 137.0) - 0.5;
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col += n * uGrain * (1.0 - lum * 0.65);

      // Damage: the whole frame desaturates toward red and the vignette
      // closes in. Damage should be felt before it is read, and this is the
      // only place in the pipeline that can do it without a HUD element —
      // §13 keeps the interface out of the way, so the screen itself has to
      // carry the hit.
      if (uPunch > 0.001) {
        float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
        vec3 hurt = mix(vec3(lum2), vec3(lum2 * 1.3, lum2 * 0.16, lum2 * 0.2), 0.9);
        col = mix(col, hurt, uPunch);
        float r2b = dot(centred, centred);
        col *= mix(1.0, 1.0 - smoothstep(0.05, 0.5, r2b) * 0.85, uPunch);
      }

      // Interference band: a rolling horizontal displacement used during the
      // jack-in, so the descent feels like signal loss rather than a fade.
      if (uInterference > 0.001) {
        float band = sin((uv.y - uTime * 0.35) * 90.0);
        float mask = smoothstep(0.55, 1.0, band) * uInterference;
        float shift = (hash(vec2(floor(uv.y * 140.0), floor(uTime * 22.0))) - 0.5);
        col += mask * shift * 0.34 * vec3(0.31, 0.89, 1.0);
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* -------------------------------------------------------------------------
   Renderer
   -------------------------------------------------------------------------- */

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;

  /**
   * The live scene/camera. These are reassigned when a different module takes
   * over the viewport (the Light Cycles mini-game runs in the same renderer),
   * so they are mutable rather than readonly.
   */
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;

  readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly composite: ShaderPass;
  private renderPass: RenderPass;

  /** Camera FOV is animated by the descent and by sprinting. */
  private baseFov = 70;

  private resizeObserver: ResizeObserver | null = null;
  private onResizeBound: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // bloom + grain hide most aliasing; MSAA is costly here
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });

    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    // Exponential fog gives the Grid its depth and hides the draw distance.
    this.scene.fog = new THREE.FogExp2(0x000000, 0.0125);

    this.camera = new THREE.PerspectiveCamera(
      this.baseFov,
      1,
      0.05,
      2600,
    );

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(256, 256),
      quality.profile.bloomStrength,
      0.85,
      0.06, // threshold: only genuinely bright lines bloom
    );
    this.composer.addPass(this.bloom);

    this.composite = new ShaderPass(CompositeShader);
    this.composite.renderToScreen = true;
    this.composer.addPass(this.composite);

    this.onResizeBound = () => this.resize();
    window.addEventListener('resize', this.onResizeBound, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResizeBound);
      this.resizeObserver.observe(document.body);
    }

    this.resize();
  }

  /** Base (non-kicked) field of view in degrees. */
  get baseFovValue(): number {
    return this.baseFov;
  }

  /**
   * Set the resting FOV. The descent and sprint both push the live camera
   * above this and damp back toward it.
   */
  setBaseFov(deg: number): void {
    this.baseFov = deg;
  }

  /** Extra degrees added on top of base, used for speed. */
  addFovOffset(deg: number): void {
    const next = clamp(this.baseFov + deg, 55, 130);
    if (Math.abs(this.camera.fov - next) > 0.01) {
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Swap the scene/camera a pass renders. Used by the Light Cycles mini-game,
   * which runs in the same renderer without opening a new page.
   */
  setScene(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.camera = camera;
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  /** Apply the active quality profile to the live pipeline. */
  applyQuality(): void {
    const p = quality.profile;
    this.bloom.strength = p.bloomStrength;
    this.composite.uniforms.uAberration.value = p.aberration;
    this.resize();
  }

  /** Rolling interference amount, 0..1. Used during the descent. */
  setInterference(amount: number): void {
    this.composite.uniforms.uInterference.value = amount;
  }

  /**
   * Live bloom parameters, for the scene dump.
   *
   * Read back rather than reconstructed from config: the watchdog can move the
   * strength at runtime, and a dump that reported the configured value would
   * report a value that is not on screen.
   */
  debugBloom(): { strength: number; radius: number; threshold: number; width: number; height: number } {
    return {
      strength: this.bloom.strength,
      radius: this.bloom.radius,
      threshold: this.bloom.threshold,
      width: this.bloom.resolution.width,
      height: this.bloom.resolution.height,
    };
  }

  /**
   * Full-screen damage, 0..1. Caller decays it.
   *
   * Scaled down hard when the player has asked for reduced flashing (§6.5 warns
   * about intense light effects and §16 asks that the preference be respected).
   * At the reduced setting the hit still registers as a hit — it just stops
   * being a strobe.
   */
  setPunch(amount: number): void {
    const scaled = loadSettings().reducedFlash ? amount * 0.22 : amount;
    this.composite.uniforms.uPunch.value = clamp(scaled, 0, 1);
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, quality.profile.maxPixelRatio);

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();

    const bw = Math.max(64, Math.floor(w / quality.profile.bloomScale));
    const bh = Math.max(64, Math.floor(h / quality.profile.bloomScale));
    this.bloom.setSize(bw, bh);

    this.composer.setSize(w, h);
    this.composite.uniforms.uResolution.value.set(w * dpr, h * dpr);
  }

  render(elapsed: number): void {
    this.composite.uniforms.uTime.value = elapsed;
    this.composer.render();
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResizeBound);
    this.resizeObserver?.disconnect();
    this.composer.dispose();
    this.bloom.dispose();
    this.renderer.dispose();
  }
}