// Reusable lab parts and materials. Every part is built in metres, sits on y = 0 unless said otherwise,
// casts and receives shadows, and owns its geometry (drop() frees it). Textures are drawn on canvases,
// so nothing is loaded from the network.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { noAO } from "./stage";

/* ------------------------------------------------------------------ materials */
export type Mats = ReturnType<typeof materials>;

export function materials(dark: boolean) {
  return {
    aluminium: new THREE.MeshStandardMaterial({ color: "#c9ced3", metalness: 0.85, roughness: 0.32 }),
    steel: new THREE.MeshStandardMaterial({ color: "#9aa1a8", metalness: 0.9, roughness: 0.25 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: "#3a3f44", metalness: 0.7, roughness: 0.4 }),
    brass: new THREE.MeshStandardMaterial({ color: "#c9a227", metalness: 0.8, roughness: 0.3 }),
    rubber: new THREE.MeshStandardMaterial({ color: "#1d1f20", roughness: 0.85 }),
    paper: new THREE.MeshStandardMaterial({ color: "#f4f1e8", roughness: 0.9, side: THREE.DoubleSide }),
    glass: new THREE.MeshPhysicalMaterial({ color: "#dff1f7", roughness: 0.05, transmission: 0.92, thickness: 0.02, ior: 1.5, transparent: true, opacity: 0.55 }),
    plastic: (color: string) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.38, clearcoat: 0.5, clearcoatRoughness: 0.2 }),
    wood: (repeat = 2) => {
      const t = woodTexture(dark);
      t.repeat.set(repeat, 1);
      return new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 });
    },
    /** Self-lit: brighter than white, so the bloom pass makes it glow. */
    glow: (color: string, intensity = 3) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), toneMapped: true }),
    ink: dark ? "#e6e2d8" : "#20251f",
  };
}

export function woodTexture(dark: boolean): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 256;
  const g = cv.getContext("2d")!;
  g.fillStyle = dark ? "#5a4130" : "#b48a5f";
  g.fillRect(0, 0, cv.width, cv.height);
  let seed = 9;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    const y = r() * cv.height;
    g.strokeStyle = `rgba(${dark ? "30,18,10" : "90,60,35"},${0.08 + r() * 0.18})`;
    g.lineWidth = 0.6 + r() * 2.2;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= cv.width; x += 32) g.lineTo(x, y + Math.sin(x / (90 + r() * 60) + i) * (2 + r() * 4));
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/* ------------------------------------------------------------------ helpers */
export function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) x.castShadow = x.receiveShadow = true;
  });
  return o;
}

export function textSprite(text: string, color: string, height = 0.018): THREE.Sprite {
  const cv = document.createElement("canvas");
  const g = cv.getContext("2d")!;
  g.font = "600 40px ui-sans-serif, system-ui, sans-serif";
  cv.width = Math.max(64, Math.ceil(g.measureText(text).width) + 24);
  cv.height = 64;
  g.font = "600 40px ui-sans-serif, system-ui, sans-serif";
  g.fillStyle = color;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, cv.width / 2, 34);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set((height * cv.width) / cv.height, height, 1);
  return noAO(s);
}

/** A soft round glow (sun, flame, LED halo), additive. */
export function glowSprite(color: string, size: number, opacity = 0.9): THREE.Sprite {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 128;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.set(size, size, 1);
  return noAO(s);
}

/** A shadow-catching floor at height y. */
export function floor(y: number, size: number, dark: boolean): THREE.Mesh {
  const f = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShadowMaterial({ opacity: dark ? 0.32 : 0.16 }));
  f.rotation.x = -Math.PI / 2;
  f.position.y = y;
  f.receiveShadow = true;
  return noAO(f);
}

/* ------------------------------------------------------------------ furniture and structure */
/** A wooden bench whose top surface is y = 0, from x0 to x1, standing on the floor at `floorY`. */
export function bench(m: Mats, x0: number, x1: number, depth: number, floorY: number): THREE.Group {
  const g = new THREE.Group();
  const wood = m.wood(2);
  const top = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.04, depth), wood);
  top.position.set((x0 + x1) / 2, -0.02, 0);
  g.add(top);
  const legH = -0.04 - floorY;
  for (const lx of [x0 + 0.05, x1 - 0.05])
    for (const lz of [-depth / 2 + 0.05, depth / 2 - 0.05]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, legH, 0.04), wood);
      leg.position.set(lx, -0.04 - legH / 2, lz);
      g.add(leg);
    }
  return shadowed(g);
}

/** Centimetre ticks and labels along x, on a face at height y and depth z. */
export function ruler(m: Mats, x0: number, length: number, y: number, z: number, every = 20): THREE.Group {
  const g = new THREE.Group();
  const n = Math.floor(length / 0.01);
  const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.0015, 0.008, 0.001), new THREE.MeshBasicMaterial({ color: "#222" }), n + 1);
  const M = new THREE.Matrix4();
  for (let i = 0; i <= n; i++) {
    const long = i % 10 === 0;
    M.compose(new THREE.Vector3(x0 + i * 0.01, y + (long ? -0.003 : 0), z), new THREE.Quaternion(), new THREE.Vector3(1, long ? 2 : 1, 1));
    ticks.setMatrixAt(i, M);
  }
  g.add(ticks);
  for (let cm = 0; cm <= length * 100 + 1e-6; cm += every) {
    const s = textSprite(String(cm), m.ink);
    s.position.set(x0 + cm / 100, y + 0.016, z + 0.02);
    g.add(s);
  }
  return g;
}

/** A retort stand: base plate, rod, and a boss-head with an arm along +x at height `armY`. */
export function retortStand(m: Mats, height: number, armY: number, armLength: number): THREE.Group {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.018, 0.14, 3, 0.006), m.darkMetal);
  base.position.y = 0.009;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, height, 16), m.steel);
  rod.position.set(-0.07, height / 2, 0);
  const boss = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.03, 0.03, 2, 0.004), m.darkMetal);
  boss.position.set(-0.07, armY, 0);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, armLength, 12), m.steel);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(-0.07 + armLength / 2, armY, 0);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.018, 12), m.brass);
  knob.rotation.x = Math.PI / 2;
  knob.position.set(-0.07, armY, 0.022);
  g.add(base, rod, boss, arm, knob);
  return shadowed(g);
}

/** A pulley wheel in a fork, axle along z, centred at the origin. */
export function pulley(m: Mats, r: number): THREE.Group {
  const g = new THREE.Group();
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.012, 40), m.aluminium);
  wheel.rotation.x = Math.PI / 2;
  const groove = new THREE.Mesh(new THREE.TorusGeometry(r, 0.0025, 8, 40), m.darkMetal);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.25, r * 0.25, 0.02, 16), m.brass);
  hub.rotation.x = Math.PI / 2;
  g.add(wheel, groove, hub);
  return shadowed(g);
}

/** Slotted masses on a hanger: n discs, the hook on top at y = height. Returns the group and its height. */
export function massStack(m: Mats, n: number, r = 0.018, h = 0.008): { group: THREE.Group; height: number } {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const d = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.92, 28), m.brass);
    d.position.y = h / 2 + i * h;
    g.add(d);
  }
  const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.04, 8), m.darkMetal);
  hook.position.y = n * h + 0.02;
  g.add(hook);
  return { group: shadowed(g), height: n * h + 0.04 };
}

/* ------------------------------------------------------------------ things that change shape */
/** A coil spring along +x from the origin; setLength() rewinds it. */
export function spring(m: Mats, turns: number, radius: number, wire: number) {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m.steel);
  mesh.castShadow = true;
  const set = (len: number) => {
    const pts: THREE.Vector3[] = [];
    const N = turns * 24;
    for (let i = 0; i <= N; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push(new THREE.Vector3((len * i) / N, Math.sin(a) * radius, Math.cos(a) * radius));
    }
    mesh.geometry.dispose();
    mesh.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N * 2, wire, 8, false);
  };
  return { mesh, setLength: set };
}

/** A solid arrow (shaft and cone) for forces and velocities; set() points it from `from` along `vec`. */
export function arrow(color: string, thickness = 0.006) {
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(thickness, thickness, 1, 12), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(thickness * 2.6, thickness * 7, 16), mat);
  const g = new THREE.Group();
  g.add(shaft, head);
  const up = new THREE.Vector3(0, 1, 0);
  const set = (from: THREE.Vector3, vec: THREE.Vector3) => {
    const len = vec.length();
    g.visible = len > 1e-4;
    if (!g.visible) return;
    const hl = Math.min(thickness * 7, len * 0.5);
    g.position.copy(from);
    g.quaternion.setFromUnitVectors(up, vec.clone().normalize());
    shaft.scale.y = len - hl;
    shaft.position.y = (len - hl) / 2;
    head.scale.setScalar(hl / (thickness * 7));
    head.position.y = len - hl / 2;
  };
  return { group: g, set };
}

/** A pixel-width polyline (trails, rays, outlines). `glow` > 1 makes it bloom. */
export function polyline(color: string, width: number, resolution: THREE.Vector2, glow = 1, dashed = false) {
  const mat = new LineMaterial({ color: new THREE.Color(color).multiplyScalar(glow).getHex(), linewidth: width, dashed, dashSize: 0.02, gapSize: 0.014, worldUnits: false });
  if (glow > 1) mat.color = new THREE.Color(color).multiplyScalar(glow); // keep the HDR value the hex would clamp
  mat.resolution.copy(resolution);
  const line = noAO(new Line2(new LineGeometry(), mat));
  line.frustumCulled = false;
  const set = (pts: THREE.Vector3[]) => {
    line.visible = pts.length >= 2;
    if (!line.visible) return;
    // a fresh geometry each time: re-setting positions would leave the old GPU buffers behind
    const geo = new LineGeometry();
    geo.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
    line.geometry.dispose();
    line.geometry = geo;
    if (dashed) line.computeLineDistances();
  };
  return { line, set };
}

/** A candle with a flickering flame that blooms; the flame tip is at y = height. */
export function candle(m: Mats, height: number) {
  const g = new THREE.Group();
  const wax = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.013, height - 0.03, 24), new THREE.MeshStandardMaterial({ color: "#f3ead8", roughness: 0.6 }));
  wax.position.y = (height - 0.03) / 2;
  const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.0008, 0.0008, 0.008, 6), m.rubber);
  wick.position.y = height - 0.026;
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12), m.glow("#ffb347", 4));
  flame.scale.set(1, 2.4, 1);
  flame.position.y = height - 0.012;
  const halo = glowSprite("#ffb347", 0.07, 0.75);
  halo.position.y = height - 0.012;
  const light = new THREE.PointLight("#ffb347", 0.6, 0.6, 2);
  light.position.y = height - 0.01;
  g.add(shadowed(wax), wick, flame, halo, light);
  let t = 0;
  const tick = (dt: number) => {
    t += dt;
    const f = 1 + 0.08 * Math.sin(t * 17) + 0.05 * Math.sin(t * 29);
    flame.scale.set(1, 2.4 * f, 1);
    light.intensity = 0.6 * f;
  };
  return { group: g, tick };
}

/** A convex (or concave) lens on a holder, axis along x, centre at height y = h. */
export function lens(m: Mats, radius: number, thickness: number, h: number, concave = false): THREE.Group {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const y = (radius * i) / 24;
    const bulge = thickness * (1 - (y / radius) ** 2);
    pts.push(new THREE.Vector2(concave ? thickness * 0.3 + thickness - bulge : bulge + 0.0015, y));
  }
  const half = new THREE.LatheGeometry(pts.reverse(), 48);
  const body = new THREE.Group();
  for (const s of [1, -1]) {
    const piece = new THREE.Mesh(half, m.glass);
    piece.rotation.z = (s * -Math.PI) / 2;
    body.add(piece);
  }
  body.position.y = h;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.003, 8, 48), m.darkMetal);
  rim.rotation.y = Math.PI / 2;
  rim.position.y = h;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, h - radius, 12), m.steel);
  stem.position.y = (h - radius) / 2;
  g.add(body, shadowed(rim), shadowed(stem), carriage(m));
  return g;
}

/** A small carriage that rides an optical bench rail. */
export function carriage(m: Mats): THREE.Mesh {
  const c = new THREE.Mesh(new RoundedBoxGeometry(0.04, 0.016, 0.05, 2, 0.003), m.darkMetal);
  c.position.y = 0.008;
  return shadowed(c);
}

/** A sphere textured with simple latitude bands and continents drawn from noise (no map data). */
export function globeTexture(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 1024;
  cv.height = 512;
  const g = cv.getContext("2d")!;
  const img = g.createImageData(cv.width, cv.height);
  const noise = (x: number, y: number) =>
    Math.sin(x * 3.1 + Math.sin(y * 2.3)) * 0.5 + Math.sin(x * 7.3 + y * 5.1) * 0.25 + Math.sin(x * 13.7 - y * 11.3) * 0.12 + Math.cos(y * 4.2 + x * 1.7) * 0.4;
  for (let j = 0; j < cv.height; j++)
    for (let i = 0; i < cv.width; i++) {
      const lon = (i / cv.width) * Math.PI * 2;
      const lat = (0.5 - j / cv.height) * Math.PI;
      const n = noise(Math.cos(lat) * Math.cos(lon) * 2, Math.sin(lat) * 2 + Math.cos(lat) * Math.sin(lon));
      const ice = Math.abs(lat) > 1.2;
      const land = n > 0.35;
      const k = (j * cv.width + i) * 4;
      const [r, gg, b] = ice ? [235, 240, 245] : land ? (Math.abs(lat) < 0.35 ? [96, 140, 70] : [150, 150, 95]) : [38, 86, 140];
      img.data[k] = r;
      img.data[k + 1] = gg;
      img.data[k + 2] = b;
      img.data[k + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
