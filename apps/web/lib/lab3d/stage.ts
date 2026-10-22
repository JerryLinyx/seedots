// The 3D stage every lab shares: renderer, camera, orbit controls, image-based lighting, a key light with
// soft shadows, picking, a frame loop and a post-processing chain:
//   render (4× MSAA) → ambient occlusion (GTAO) → bloom (only what is brighter than white) → output
//   (tone mapping, sRGB) → vignette and grain.
// If frames get slow the stage drops effects one at a time (AO first, then bloom, then pixel ratio).
// Views add their objects to `stage.root` and never touch the renderer.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export type Quality = "high" | "medium" | "low";

/** Layer for things ambient occlusion must not see: shadow-only floors, sprites, labels, glows, pixel lines. */
export const NO_AO = 1;
export function noAO<T extends THREE.Object3D>(o: T): T {
  o.traverse((x) => x.layers.set(NO_AO));
  return o;
}

export type Stage = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  root: THREE.Group;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  dark: boolean;
  /** Canvas size in device pixels, kept current for pixel-width lines. */
  resolution: THREE.Vector2;
  quality(): Quality;
  setQuality(q: Quality): void;
  /** Tune the effects for a scene: AO radius in world units, bloom strength. */
  look(o: { aoRadius?: number; bloom?: number; exposure?: number; background?: string }): void;
  pick(e: PointerEvent, objects: THREE.Object3D[]): THREE.Intersection | null;
  frame(from: [number, number, number], target: [number, number, number]): void;
  /** Size the key light's shadow box to the scene (half-width in world units). */
  shadowBox(half: number): void;
  onFrame(fn: (dt: number) => void): () => void;
  dispose(): void;
};

const VIGNETTE = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.32 }, uGrain: { value: 0.035 }, uTime: { value: 0 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uVignette; uniform float uGrain; uniform float uTime; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      c.rgb += (hash(vUv * 1000.0) - 0.5) * uGrain;
      gl_FragColor = c;
    }`,
};

export function createStage(canvas: HTMLCanvasElement, dark: boolean): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  let pixelRatio = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = dark ? 1.0 : 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const bg = new THREE.Color(dark ? "#121815" : "#e7eae2");
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 25, 80);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = dark ? 0.5 : 0.75;

  const hemi = new THREE.HemisphereLight(dark ? "#cfe0d6" : "#ffffff", dark ? "#1b231f" : "#b9c3b8", dark ? 0.55 : 0.85);
  const sun = new THREE.DirectionalLight("#fff4e4", dark ? 2.3 : 2.6);
  sun.position.set(-5, 9, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 4;
  scene.add(hemi, sun, sun.target);

  const root = new THREE.Group();
  scene.add(root);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 300);
  camera.layers.enable(NO_AO);
  const aoCamera = new THREE.PerspectiveCamera(); // the main camera without the NO_AO layer
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 0.2;
  controls.maxDistance = 60;

  // post-processing chain, into a multisampled half-float target
  const target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, camera);
  const ao = new GTAOPass(scene, aoCamera, 2, 2);
  ao.blendIntensity = dark ? 0.9 : 0.75;
  const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.55, 0.5, 1.3); // threshold above lit white: only self-lit parts glow
  const output = new OutputPass();
  const vignette = new ShaderPass(VIGNETTE);
  vignette.uniforms.uVignette.value = dark ? 0.38 : 0.22;
  composer.addPass(renderPass);
  composer.addPass(ao);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(vignette);

  const resolution = new THREE.Vector2(1, 1);
  const ray = new THREE.Raycaster();
  ray.params.Line = { threshold: 0.01 };
  const ndc = new THREE.Vector2();
  const frameFns = new Set<(dt: number) => void>();
  let quality: Quality = "high";

  const applyQuality = () => {
    ao.enabled = quality === "high";
    bloom.enabled = quality !== "low";
    vignette.uniforms.uGrain.value = quality === "low" ? 0 : 0.035;
    pixelRatio = quality === "low" ? 1 : Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(pixelRatio);
    resize();
  };

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    resolution.set(w * pixelRatio, h * pixelRatio);
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && (m as LineMaterial).isLineMaterial) (m as LineMaterial).resolution.copy(resolution);
    });
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // drop effects when frames are slow: average over 90 frames, at most one step every 3 s
  let acc = 0;
  let n = 0;
  let lastStep = performance.now();
  const watch = (dt: number) => {
    acc += dt;
    n++;
    if (n < 90) return;
    const avg = acc / n;
    acc = n = 0;
    const now = performance.now();
    if (avg > 1 / 40 && now - lastStep > 3000 && quality !== "low" && document.visibilityState === "visible") {
      quality = quality === "high" ? "medium" : "low";
      lastStep = now;
      applyQuality();
    }
  };

  let last = performance.now();
  let raf = 0;
  let t = 0;
  const loop = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    controls.update();
    frameFns.forEach((fn) => fn(dt));
    aoCamera.copy(camera);
    aoCamera.layers.set(0);
    vignette.uniforms.uTime.value = t % 10;
    composer.render(dt);
    watch(dt);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    renderer, scene, root, camera, controls, sun, hemi, dark, resolution,
    quality: () => quality,
    setQuality(q) {
      quality = q;
      applyQuality();
    },
    look(o) {
      if (o.aoRadius != null) ao.updateGtaoMaterial({ radius: o.aoRadius, distanceExponent: 1, thickness: o.aoRadius * 0.5, scale: 1, samples: 16 });
      if (o.bloom != null) bloom.strength = o.bloom;
      if (o.exposure != null) renderer.toneMappingExposure = o.exposure;
      if (o.background) {
        bg.set(o.background);
        (scene.fog as THREE.Fog).color.copy(bg);
      }
    },
    pick(e, objects) {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return ray.intersectObjects(objects, true)[0] ?? null;
    },
    frame(from, target) {
      camera.position.set(...from);
      controls.target.set(...target);
      controls.update();
    },
    shadowBox(half) {
      const sc = sun.shadow.camera;
      [sc.left, sc.right, sc.top, sc.bottom, sc.near, sc.far] = [-half, half, half, -half, 0.05, half * 8];
      sc.updateProjectionMatrix();
    },
    onFrame(fn) {
      frameFns.add(fn);
      return () => frameFns.delete(fn);
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        [m.material].flat().forEach((x) => (x as THREE.Material | undefined)?.dispose());
      });
      composer.dispose();
      target.dispose();
      ao.dispose();
      bloom.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}

/** Free a subtree's GPU resources and detach it. */
export function drop(o: THREE.Object3D | null | undefined) {
  if (!o) return;
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    [m.material].flat().forEach((y) => {
      const mat = y as (THREE.Material & { map?: THREE.Texture | null }) | undefined;
      mat?.map?.dispose();
      mat?.dispose();
    });
  });
  o.removeFromParent();
}
