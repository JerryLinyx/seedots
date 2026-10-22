// Field rig: a scalar field h(x, y) drawn as a contour map (layered colour + contour lines), with a probe point
// (height, slope), an optional profile line drawn as a cross-section, and an optional gradient-descent walk.
// Covers contour maps and slope, potentials and equipotentials, loss landscapes.

import { behaviour } from "./expr.ts";
import { Plot } from "./plot.ts";
import { checkExpr, ev, type Observables, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

export type FieldConfig = {
  h: string; // uses x, y and params
  x: [number, number];
  y: [number, number];
  levels: string; // contour interval (formula)
  label?: string; // what h is (height, potential, loss)
  probe?: { x: string; y: string; drag?: { x: string; y: string } };
  profile?: { x1: string; y1: string; x2: string; y2: string };
  descent?: { x0: string; y0: string; rate: string; steps: number };
};

const N = 48; // grid cells per side for contours
export const at = (c: FieldConfig, env: Env) => (x: number, y: number) => ev(c.h, { ...env, x, y });
export function grad(h: (x: number, y: number) => number, x: number, y: number, c: FieldConfig): [number, number] {
  const e = 1e-4 * Math.max(c.x[1] - c.x[0], c.y[1] - c.y[0]);
  return [(h(x + e, y) - h(x - e, y)) / (2 * e), (h(x, y + e) - h(x, y - e)) / (2 * e)];
}
function walk(c: FieldConfig, env: Env) {
  if (!c.descent) return [];
  const h = at(c, env);
  const r = ev(c.descent.rate, env);
  let p: [number, number] = [ev(c.descent.x0, env), ev(c.descent.y0, env)];
  const out = [p];
  for (let k = 0; k < c.descent.steps; k++) {
    const g = grad(h, p[0], p[1], c);
    p = [p[0] - r * g[0], p[1] - r * g[1]];
    if (!p.every(Number.isFinite) || Math.abs(p[0]) > 1e6 || Math.abs(p[1]) > 1e6) break;
    out.push(p);
  }
  return out;
}

/** Marching squares: line segments where the field crosses `level`. */
export function contour(z: number[][], level: number, x: [number, number], y: [number, number], N = z.length - 1): [number, number][][] {
  const segs: [number, number][][] = [];
  const dx = (x[1] - x[0]) / N;
  const dy = (y[1] - y[0]) / N;
  const lerp = (a: number, b: number) => (level - a) / (b - a);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const v = [z[i][j], z[i + 1][j], z[i + 1][j + 1], z[i][j + 1]];
      if (!v.every(Number.isFinite)) continue;
      const P = [
        [x[0] + i * dx, y[0] + j * dy],
        [x[0] + (i + 1) * dx, y[0] + j * dy],
        [x[0] + (i + 1) * dx, y[0] + (j + 1) * dy],
        [x[0] + i * dx, y[0] + (j + 1) * dy],
      ];
      const pts: [number, number][] = [];
      for (let k = 0; k < 4; k++) {
        const a = v[k];
        const b = v[(k + 1) % 4];
        if ((a < level) !== (b < level)) {
          const t = lerp(a, b);
          pts.push([P[k][0] + (P[(k + 1) % 4][0] - P[k][0]) * t, P[k][1] + (P[(k + 1) % 4][1] - P[k][1]) * t]);
        }
      }
      if (pts.length === 2) segs.push(pts);
      if (pts.length === 4) segs.push([pts[0], pts[1]], [pts[2], pts[3]]);
    }
  return segs;
}

export const fieldRig: Rig<FieldConfig> = {
  id: "field",
  label: "Field / contour map",

  check(c, params) {
    const out: string[] = [];
    out.push(...checkExpr(c.h, new Set([...params, "x", "y"]), "h"), ...checkExpr(c.levels, params, "levels"));
    if (!(c.x?.[0] < c.x?.[1] && c.y?.[0] < c.y?.[1])) out.push("empty x or y range");
    if (c.probe) {
      out.push(...checkExpr(c.probe.x, params, "probe.x"), ...checkExpr(c.probe.y, params, "probe.y"));
      if (c.probe.drag && (!params.has(c.probe.drag.x) || !params.has(c.probe.drag.y))) out.push("probe.drag: unknown params");
    }
    if (c.profile) for (const k of ["x1", "y1", "x2", "y2"] as const) out.push(...checkExpr(c.profile[k], params, `profile.${k}`));
    if (c.descent) {
      out.push(...checkExpr(c.descent.x0, params, "descent.x0"), ...checkExpr(c.descent.y0, params, "descent.y0"), ...checkExpr(c.descent.rate, params, "descent.rate"));
      if (!(c.descent.steps >= 1 && c.descent.steps <= 500)) out.push("descent.steps must be 1..500");
    }
    return out;
  },

  observables(c): Observables {
    const numeric = ["h_max", "h_min"];
    if (c.probe) numeric.push("height", "slope", "probe_x", "probe_y");
    if (c.profile) numeric.push("climb", "drop", "relief");
    if (c.descent) numeric.push("final_h", "final_x", "final_y");
    return { numeric, categories: c.descent ? { behaviour: ["settles down", "keeps bouncing", "blows up"] } : {} };
  },

  observe(c, env) {
    const h = at(c, env);
    const out: Observed = {};
    let mx = -Infinity;
    let mn = Infinity;
    for (let i = 0; i <= 30; i++)
      for (let j = 0; j <= 30; j++) {
        const v = h(c.x[0] + ((c.x[1] - c.x[0]) * i) / 30, c.y[0] + ((c.y[1] - c.y[0]) * j) / 30);
        if (Number.isFinite(v)) (mx = Math.max(mx, v), mn = Math.min(mn, v));
      }
    Object.assign(out, { h_max: mx, h_min: mn });
    if (c.probe) {
      const [px, py] = [ev(c.probe.x, env), ev(c.probe.y, env)];
      Object.assign(out, { height: h(px, py), slope: Math.hypot(...grad(h, px, py, c)), probe_x: px, probe_y: py });
    }
    if (c.profile) {
      const q = c.profile;
      const [x1, y1, x2, y2] = [ev(q.x1, env), ev(q.y1, env), ev(q.x2, env), ev(q.y2, env)];
      const hs = Array.from({ length: 101 }, (_, k) => h(x1 + ((x2 - x1) * k) / 100, y1 + ((y2 - y1) * k) / 100));
      let climb = 0;
      let drop = 0;
      for (let k = 1; k < hs.length; k++) (hs[k] > hs[k - 1] ? (climb += hs[k] - hs[k - 1]) : (drop += hs[k - 1] - hs[k]));
      Object.assign(out, { climb, drop, relief: Math.max(...hs) - Math.min(...hs) });
    }
    if (c.descent) {
      const w = walk(c, env);
      const last = w[w.length - 1];
      const hv = w.map((p) => h(p[0], p[1]));
      const escaped = w.length < c.descent.steps + 1;
      Object.assign(out, {
        final_h: escaped ? 1e9 : h(last[0], last[1]),
        final_x: last[0],
        final_y: last[1],
        behaviour: escaped ? "blows up" : behaviour(hv),
      });
    }
    return out;
  },

  frame(c, envs) {
    // colour bands keep one scale across the scene
    let mx = -Infinity;
    let mn = Infinity;
    for (const env of envs) {
      const h = at(c, env);
      for (let i = 0; i <= 24; i++)
        for (let j = 0; j <= 24; j++) {
          const v = h(c.x[0] + ((c.x[1] - c.x[0]) * i) / 24, c.y[0] + ((c.y[1] - c.y[0]) * j) / 24);
          if (Number.isFinite(v)) (mx = Math.max(mx, v), mn = Math.min(mn, v));
        }
    }
    return { z: [mn, mx] };
  },

  draw(c, env, { frame }) {
    const h = at(c, env);
    const step = Math.max(1e-6, ev(c.levels, env));
    const map = new Plot(c.x, c.y, { h: c.profile ? 330 : 400, equal: true }).axes("", "");
    const z: number[][] = [];
    for (let i = 0; i <= N; i++) {
      z.push([]);
      for (let j = 0; j <= N; j++) z[i].push(h(c.x[0] + ((c.x[1] - c.x[0]) * i) / N, c.y[0] + ((c.y[1] - c.y[0]) * j) / N));
    }
    // layered colour, coarse
    const [lo, hi] = frame.z;
    const M = 24;
    for (let i = 0; i < M; i++)
      for (let j = 0; j < M; j++) {
        const x0 = c.x[0] + ((c.x[1] - c.x[0]) * i) / M;
        const y0 = c.y[0] + ((c.y[1] - c.y[0]) * j) / M;
        const v = h(x0 + (c.x[1] - c.x[0]) / M / 2, y0 + (c.y[1] - c.y[0]) / M / 2);
        const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
        map.rect(x0, y0, x0 + (c.x[1] - c.x[0]) / M, y0 + (c.y[1] - c.y[0]) / M, t > 0.5 ? "c2" : "c0", 0.08 + 0.5 * Math.abs(t - 0.5));
      }
    const first = Math.ceil(lo / step) * step;
    for (let L = first, k = 0; L <= hi && k < 60; L += step, k++)
      for (const s of contour(z, L, c.x, c.y)) map.seg(s[0], s[1], "ink", { width: Math.abs(L / step) % 5 < 1e-6 ? 1.6 : 0.9, opacity: 0.7 });
    const out = [map];
    if (c.descent) {
      const w = walk(c, env).filter((p) => p[0] >= c.x[0] && p[0] <= c.x[1] && p[1] >= c.y[0] && p[1] <= c.y[1]);
      map.path(w, "accent", { width: 1.8 });
      w.forEach((p, i) => map.dot(p, i === 0 ? "c3" : "accent", i === 0 ? 5 : 2.8));
    }
    if (c.profile) {
      const q = c.profile;
      const [x1, y1, x2, y2] = [ev(q.x1, env), ev(q.y1, env), ev(q.x2, env), ev(q.y2, env)];
      map.seg([x1, y1], [x2, y2], "accent", { width: 2.4 }).label("A", [x1, y1], "accent", { size: 13 }).label("B", [x2, y2], "accent", { size: 13 });
      const len = Math.hypot(x2 - x1, y2 - y1);
      const pr = new Plot([0, len], [lo - (hi - lo) * 0.05, hi + (hi - lo) * 0.1], { h: 200 }).axes("distance along A → B", c.label ?? "height");
      const pts = Array.from({ length: 121 }, (_, k) => [(len * k) / 120, h(x1 + ((x2 - x1) * k) / 120, y1 + ((y2 - y1) * k) / 120)] as [number, number]);
      pr.path([[0, lo - (hi - lo) * 0.05], ...pts, [len, lo - (hi - lo) * 0.05]], "c0", { fill: true, opacity: 0.3, width: 0 }).path(pts, "c0", { width: 2.2 });
      out.push(pr);
    }
    if (c.probe) {
      const [px, py] = [ev(c.probe.x, env), ev(c.probe.y, env)];
      const g = grad(h, px, py, c);
      const gl = Math.hypot(...g) || 1;
      const L = (c.x[1] - c.x[0]) * 0.08;
      map.arrow([px, py], [px + (g[0] / gl) * L, py + (g[1] / gl) * L], "c3", { width: 2 });
      map.dot([px, py], "accent", 6).label(`${h(px, py).toFixed(1)}`, [px, py], "ink", { size: 12 });
      if (c.probe.drag) map.handle("probe", [px, py]);
    }
    return out;
  },

  drag(c, _env, id, [x, y]) {
    if (id !== "probe" || !c.probe?.drag) return {};
    return { [c.probe.drag.x]: x, [c.probe.drag.y]: y };
  },
};
