// Terrain view of the field rig: the field as a block of land with layered colour, contour lines laid on the
// ground, an optional horizontal slice (how a contour line forms), a walker pin you drag over the ground,
// and a profile curtain along A → B.

import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { names } from "@/lib/expr";
import { at, contour, grad, type FieldConfig } from "@seedots/rigs/field.ts";
import { ev, expr } from "@seedots/rigs/runtime.ts";
import type { Env } from "@seedots/rigs/spec.ts";
import { drop, noAO } from "./stage";
import type { View3D } from "./types";

type TerrainStage = { kind: "terrain"; exaggeration?: number; slice?: string; water?: number };

// hypsometric tints, low to high
const RAMP = ["#3f6f4a", "#6f9a58", "#b7b56a", "#c99a5b", "#9a7155", "#e9e4da"].map((c) => new THREE.Color(c));
function tint(t: number, out: THREE.Color) {
  const x = Math.max(0, Math.min(0.999, t)) * (RAMP.length - 1);
  const i = Math.floor(x);
  return out.copy(RAMP[i]).lerp(RAMP[i + 1], x - i);
}

export const terrainView: View3D = {
  kind: "terrain",
  rig: "field",
  label: "3D terrain",
  hint: "drag the red pin over the ground",

  build(ctx, spec, env0) {
    const { stage } = ctx;
    const c = spec.config as unknown as FieldConfig;
    const st = spec.stage as unknown as TerrainStage;
    const W = c.x[1] - c.x[0];
    const D = c.y[1] - c.y[0];
    const cx = (c.x[0] + c.x[1]) / 2;
    const cy = (c.y[0] + c.y[1]) / 2;
    const NX = 160;
    const NY = Math.max(40, Math.round((NX * D) / W));
    const hParams = [...names(expr(c.h))].filter((n) => n !== "x" && n !== "y");

    // a fixed vertical scale for the whole scene, from the field at its starting params
    let lo = Infinity;
    let hi = -Infinity;
    const h0 = at(c, env0);
    for (let i = 0; i <= 40; i++)
      for (let j = 0; j <= 40; j++) {
        const v = h0(c.x[0] + (W * i) / 40, c.y[0] + (D * j) / 40);
        if (Number.isFinite(v)) (lo = Math.min(lo, v), hi = Math.max(hi, v));
      }
    const relief = 0.22 * W * (st.exaggeration ?? 1);
    const Y = (h: number) => ((h - lo) / (hi - lo || 1)) * relief;
    const X = (x: number) => x - cx;
    const Z = (y: number) => -(y - cy);
    const base = -0.05 * W;

    const group = new THREE.Group();
    stage.root.add(group);
    stage.frame([0, W * 0.62 + relief * 0.6, W * 1.05 + relief * 0.4], [0, relief * 0.2, 0]);
    stage.shadowBox(W * 0.75);
    stage.look({ aoRadius: W * 0.04, bloom: 0.4 });

    let land: THREE.Group | null = null;
    let lines: THREE.Group | null = null;
    let slice: THREE.Group | null = null;
    let curtain: THREE.Group | null = null;
    let walk: THREE.Group | null = null;
    let landKey = "";
    let lineKey = "";
    let z: number[][] = [];

    function buildLand(env: Env) {
      drop(land);
      land = new THREE.Group();
      const h = at(c, env);
      const pos: number[] = [];
      const col: number[] = [];
      const tmp = new THREE.Color();
      z = [];
      for (let i = 0; i <= NX; i++) {
        z.push([]);
        for (let j = 0; j <= NY; j++) {
          const x = c.x[0] + (W * i) / NX;
          const y = c.y[0] + (D * j) / NY;
          const v = h(x, y);
          z[i].push(v);
        }
      }
      const idx: number[] = [];
      for (let j = 0; j <= NY; j++)
        for (let i = 0; i <= NX; i++) {
          const x = c.x[0] + (W * i) / NX;
          const y = c.y[0] + (D * j) / NY;
          const v = z[i][j];
          pos.push(X(x), Y(v), Z(y));
          tint((v - lo) / (hi - lo || 1), tmp);
          col.push(tmp.r, tmp.g, tmp.b);
        }
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const a = j * (NX + 1) + i;
          // y runs toward −z, so this winding faces up
          idx.push(a, a + 1, a + NX + 1, a + 1, a + NX + 2, a + NX + 1);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const surface = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 }));
      surface.castShadow = surface.receiveShadow = true;
      surface.name = "surface";
      land.add(surface);

      // the cut sides of the block, banded like strata
      const side = (pts: [number, number, number][]) => {
        const p: number[] = [];
        const cl: number[] = [];
        const ix: number[] = [];
        pts.forEach(([x, y, top], k) => {
          for (const [yy, dark] of [[top, 0.55], [base, 0.3]] as const) {
            p.push(X(x), yy, Z(y));
            const band = 0.42 + 0.08 * Math.sin(yy * 40);
            tmp.setRGB(band * 0.62 * (dark + 0.45), band * 0.5 * (dark + 0.45), band * 0.4 * (dark + 0.45));
            cl.push(tmp.r, tmp.g, tmp.b);
          }
          if (k > 0) {
            const a = (k - 1) * 2;
            ix.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
          }
        });
        const sg = new THREE.BufferGeometry();
        sg.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
        sg.setAttribute("color", new THREE.Float32BufferAttribute(cl, 3));
        sg.setIndex(ix);
        sg.computeVertexNormals();
        const m = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
        m.receiveShadow = true;
        land!.add(m);
      };
      side(Array.from({ length: NX + 1 }, (_, i) => [c.x[0] + (W * i) / NX, c.y[0], Y(z[i][0])]));
      side(Array.from({ length: NX + 1 }, (_, i) => [c.x[0] + (W * i) / NX, c.y[1], Y(z[i][NY])]));
      side(Array.from({ length: NY + 1 }, (_, j) => [c.x[0], c.y[0] + (D * j) / NY, Y(z[0][j])]));
      side(Array.from({ length: NY + 1 }, (_, j) => [c.x[1], c.y[0] + (D * j) / NY, Y(z[NX][j])]));
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * 3, D * 3), new THREE.ShadowMaterial({ opacity: stage.dark ? 0.35 : 0.18 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = base - 0.001;
      floor.receiveShadow = true;
      land.add(noAO(floor));
      if (st.water != null) {
        const sea = new THREE.Mesh(new THREE.BoxGeometry(W, Math.max(0.002, Y(st.water) - base), D), new THREE.MeshPhysicalMaterial({ color: "#4f86a6", transparent: true, opacity: 0.55, roughness: 0.15, transmission: 0.2 }));
        sea.position.y = (Y(st.water) + base) / 2;
        land.add(sea);
      }
      group.add(land);
    }

    // marching squares wants a square grid; resample to one
    function buildLines(env: Env) {
      drop(lines);
      lines = new THREE.Group();
      const step = Math.max(1e-6, ev(c.levels, env));
      const N = 120;
      const h = at(c, env);
      const zz: number[][] = [];
      for (let i = 0; i <= N; i++) {
        zz.push([]);
        for (let j = 0; j <= N; j++) zz[i].push(h(c.x[0] + (W * i) / N, c.y[0] + (D * j) / N));
      }
      const thin: number[] = [];
      const thick: number[] = [];
      for (let L = Math.ceil(lo / step) * step, k = 0; L <= hi && k < 80; L += step, k++) {
        const target = Math.abs(Math.round(L / step)) % 5 === 0 ? thick : thin;
        for (const [a, b] of contour(zz, L, c.x, c.y, N)) target.push(X(a[0]), Y(L) + 0.004 * W, Z(a[1]), X(b[0]), Y(L) + 0.004 * W, Z(b[1]));
      }
      for (const [arr, color, op] of [[thin, stage.dark ? "#1c2420" : "#3a3f33", 0.55], [thick, stage.dark ? "#0b0f0d" : "#2a2d24", 0.9]] as const) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(arr as number[], 3));
        lines.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op })));
      }
      group.add(noAO(lines));
    }

    function buildSlice(env: Env) {
      drop(slice);
      if (!st.slice) return;
      slice = new THREE.Group();
      const L = env[st.slice];
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.04, D * 1.04), new THREE.MeshBasicMaterial({ color: "#3d8fd6", transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.y = Y(L);
      const rim = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W * 1.04, D * 1.04)), new THREE.LineBasicMaterial({ color: "#7cc0f5" }));
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = Y(L);
      slice.add(plane, rim);
      const N = 120;
      const h = at(c, env);
      const zz: number[][] = [];
      for (let i = 0; i <= N; i++) {
        zz.push([]);
        for (let j = 0; j <= N; j++) zz[i].push(h(c.x[0] + (W * i) / N, c.y[0] + (D * j) / N));
      }
      const arr: number[] = [];
      for (const [a, b] of contour(zz, L, c.x, c.y, N)) arr.push(X(a[0]), Y(L) + 0.003 * W, Z(a[1]), X(b[0]), Y(L) + 0.003 * W, Z(b[1]));
      if (arr.length) {
        // where the plane meets the ground: a thick line, in pixels
        const g = new LineSegmentsGeometry().setPositions(arr);
        const mat = new LineMaterial({ color: 0xffc23a, linewidth: 3.5, resolution: stage.resolution.clone() });
        slice.add(new LineSegments2(g, mat));
      }
      group.add(noAO(slice));
    }

    // the walker: a pin standing on the ground, and an arrow pointing uphill
    const pin = new THREE.Group();
    if (c.probe) {
      const s = W * 0.012;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.18, s * 0.18, s * 5, 12), new THREE.MeshStandardMaterial({ color: "#d9d4c7", roughness: 0.4 }));
      stem.position.y = s * 2.5;
      const head = new THREE.Mesh(new THREE.SphereGeometry(s, 24, 16), new THREE.MeshStandardMaterial({ color: "#b5442e", roughness: 0.35, emissive: "#b5442e", emissiveIntensity: 0.15 }));
      head.position.y = s * 5;
      head.name = "handle";
      stem.castShadow = head.castShadow = true;
      pin.add(stem, head);
      group.add(pin);
    }
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), W * 0.07, 0x5b7fa6, W * 0.02, W * 0.012);
    if (c.probe) group.add(arrow);

    function placePin(env: Env) {
      if (!c.probe) return;
      const h = at(c, env);
      const px = ev(c.probe.x, env);
      const py = ev(c.probe.y, env);
      pin.position.set(X(px), Y(h(px, py)), Z(py));
      const g = grad(h, px, py, c);
      const e = W * 0.002;
      const dir = new THREE.Vector3(g[0], 0, -g[1]);
      if (dir.lengthSq() > 1e-12) {
        dir.normalize();
        // follow the slope so the arrow lies on the ground
        const ahead = h(px + dir.x * e, py - dir.z * e);
        dir.y = (Y(ahead) - Y(h(px, py))) / e;
        arrow.setDirection(dir.normalize());
        arrow.visible = true;
      } else arrow.visible = false;
      arrow.position.set(X(px), Y(h(px, py)) + W * 0.004, Z(py));
    }

    function buildCurtain(env: Env) {
      drop(curtain);
      if (!c.profile) return;
      curtain = new THREE.Group();
      const q = c.profile;
      const [x1, y1, x2, y2] = [ev(q.x1, env), ev(q.y1, env), ev(q.x2, env), ev(q.y2, env)];
      const h = at(c, env);
      const p: number[] = [];
      const ix: number[] = [];
      const top: number[] = [];
      const K = 160;
      for (let k = 0; k <= K; k++) {
        const x = x1 + ((x2 - x1) * k) / K;
        const y = y1 + ((y2 - y1) * k) / K;
        const yy = Y(h(x, y)) + 0.002 * W;
        p.push(X(x), yy, Z(y), X(x), base, Z(y));
        top.push(X(x), yy + 0.003 * W, Z(y));
        if (k > 0) ix.push((k - 1) * 2, (k - 1) * 2 + 1, k * 2, k * 2, (k - 1) * 2 + 1, k * 2 + 1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      g.setIndex(ix);
      curtain.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: "#b5442e", transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false })));
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.Float32BufferAttribute(top, 3));
      curtain.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: "#b5442e" })));
      group.add(noAO(curtain));
    }

    function buildWalk(env: Env) {
      drop(walk);
      if (!c.descent) return;
      walk = new THREE.Group();
      const h = at(c, env);
      const r = ev(c.descent.rate, env);
      let p: [number, number] = [ev(c.descent.x0, env), ev(c.descent.y0, env)];
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= c.descent.steps; k++) {
        if (p[0] < c.x[0] || p[0] > c.x[1] || p[1] < c.y[0] || p[1] > c.y[1] || !p.every(Number.isFinite)) break;
        pts.push(new THREE.Vector3(X(p[0]), Y(h(p[0], p[1])) + 0.008 * W, Z(p[1])));
        const g = grad(h, p[0], p[1], c);
        p = [p[0] - r * g[0], p[1] - r * g[1]];
      }
      walk.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: "#b5442e" })));
      const ball = new THREE.SphereGeometry(W * 0.006, 12, 8);
      const mat = new THREE.MeshStandardMaterial({ color: "#b5442e" });
      const inst = new THREE.InstancedMesh(ball, mat, Math.max(1, pts.length));
      pts.forEach((v, i) => inst.setMatrixAt(i, new THREE.Matrix4().makeTranslation(v.x, v.y, v.z)));
      walk.add(inst);
      group.add(noAO(walk));
    }

    // dragging the pin: pick its head, then follow the ground under the pointer
    const canvas = stage.renderer.domElement;
    let dragging = false;
    const down = (e: PointerEvent) => {
      if (!c.probe?.drag || ctx.locked()) return;
      const hit = stage.pick(e, [pin]);
      if (hit) {
        dragging = true;
        stage.controls.enabled = false;
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const move = (e: PointerEvent) => {
      if (!dragging || !land) return;
      const hit = stage.pick(e, land.children.filter((o) => o.name === "surface"));
      if (hit) ctx.set({ [c.probe!.drag!.x]: hit.point.x + cx, [c.probe!.drag!.y]: -hit.point.z + cy });
    };
    const up = () => {
      dragging = false;
      stage.controls.enabled = true;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);

    const update = (env: Env) => {
      const lk = hParams.map((n) => env[n]).join(",");
      if (lk !== landKey || !land) {
        landKey = lk;
        buildLand(env);
        lineKey = "";
      }
      const k2 = `${lk}|${ev(c.levels, env)}`;
      if (k2 !== lineKey) {
        lineKey = k2;
        buildLines(env);
      }
      buildSlice(env);
      placePin(env);
      buildCurtain(env);
      buildWalk(env);
    };
    update(env0);

    return {
      update,
      dispose() {
        canvas.removeEventListener("pointerdown", down);
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        drop(group);
      },
    };
  },
};
