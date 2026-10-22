// Function rig: y = f(x; params), plus marks that measure the curve — a point, a tangent, a secant,
// a Riemann sum, the exact area, and a faint copy of the curve at its starting params.

import { Plot, fitRange } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type Curve = { expr: string; label: string };
type Mark =
  | { kind: "point"; name: string; curve?: number; at: string; drag?: string }
  | { kind: "tangent"; name: string; curve?: number; at: string }
  | { kind: "secant"; name: string; curve?: number; a: string; b: string }
  | { kind: "riemann"; name: string; curve?: number; a: string; b: string; n: string; rule?: "left" | "right" | "mid" }
  | { kind: "area"; name: string; curve?: number; a: string; b: string }
  | { kind: "ghost"; curve?: number }
  | { kind: "intersect"; name: string; curves: [number, number]; from?: string; to?: string } // where two curves meet
  | { kind: "band"; name: string; curve?: number; level: string; a: string; b: string } // area between a curve and y = level
  | { kind: "vline"; at: string; label?: string };

export type FunctionConfig = {
  x: { min: number; max: number; label: string };
  y?: { min: number; max: number; label: string };
  y_label?: string;
  curves: Curve[];
  marks?: Mark[];
};

const f = (c: FunctionConfig, i: number | undefined, env: Env) => (x: number) => ev(c.curves[Math.min(i ?? 0, c.curves.length - 1)].expr, { ...env, x });
const slope = (g: (x: number) => number, x: number) => {
  const h = 1e-4 * Math.max(1, Math.abs(x));
  return (g(x + h) - g(x - h)) / (2 * h);
};
function simpson(g: (x: number) => number, a: number, b: number, n = 400): number {
  const h = (b - a) / n;
  let s = g(a) + g(b);
  for (let i = 1; i < n; i++) s += g(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}
function riemann(g: (x: number) => number, a: number, b: number, n: number, rule: string) {
  const k = Math.max(1, Math.round(n));
  const w = (b - a) / k;
  const rects: [number, number, number][] = [];
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const x0 = a + i * w;
    const xs = rule === "right" ? x0 + w : rule === "mid" ? x0 + w / 2 : x0;
    const y = g(xs);
    rects.push([x0, x0 + w, y]);
    sum += y * w;
  }
  return { sum, rects };
}

export const functionRig: Rig<FunctionConfig> = {
  id: "function",
  label: "Function",

  check(c, params) {
    const out: string[] = [];
    if (!c.x || !(c.x.min < c.x.max)) out.push("x range is empty");
    if (!c.curves?.length) out.push("no curves");
    const allowed = new Set([...params, "x"]);
    c.curves?.forEach((cv, i) => out.push(...checkExpr(cv.expr, allowed, `curve ${i}`)));
    for (const m of c.marks ?? []) {
      if ("curve" in m && m.curve != null && !(m.curve >= 0 && m.curve < c.curves.length)) out.push(`mark: no curve ${m.curve}`);
      for (const k of ["at", "a", "b", "n"] as const) if (k in m) out.push(...checkExpr((m as Record<string, string>)[k], params, `${m.kind}.${k}`));
      if (m.kind === "point" && m.drag && !params.has(m.drag)) out.push(`point.drag: no param ${m.drag}`);
      if (m.kind === "intersect") {
        if (!m.curves?.every((i) => i >= 0 && i < c.curves.length)) out.push("intersect: no such curve");
        for (const k of ["from", "to"] as const) if (m[k]) out.push(...checkExpr(m[k], params, `intersect.${k}`));
      }
      if (m.kind === "band") out.push(...checkExpr(m.level, params, "band.level"));
    }
    return out;
  },

  observables(c) {
    const numeric: string[] = [];
    for (const m of c.marks ?? []) {
      if (m.kind === "point") numeric.push(m.name, `${m.name}_x`);
      if (m.kind === "tangent" || m.kind === "secant") numeric.push(m.name);
      if (m.kind === "riemann") numeric.push(m.name, `${m.name}_exact`, `${m.name}_error`);
      if (m.kind === "area" || m.kind === "band") numeric.push(m.name);
      if (m.kind === "intersect") numeric.push(`${m.name}_x`, `${m.name}_y`);
    }
    return { numeric, categories: {} };
  },

  observe(c, env) {
    const out: Observed = {};
    for (const m of c.marks ?? []) {
      if (m.kind === "ghost" || m.kind === "vline") continue;
      const g = f(c, "curve" in m ? m.curve : 0, env);
      if (m.kind === "point") {
        const x = ev(m.at, env);
        out[m.name] = g(x);
        out[`${m.name}_x`] = x;
      } else if (m.kind === "tangent") out[m.name] = slope(g, ev(m.at, env));
      else if (m.kind === "secant") {
        const [a, b] = [ev(m.a, env), ev(m.b, env)];
        out[m.name] = (g(b) - g(a)) / (b - a);
      } else if (m.kind === "riemann") {
        const [a, b] = [ev(m.a, env), ev(m.b, env)];
        const s = riemann(g, a, b, ev(m.n, env), m.rule ?? "left").sum;
        const exact = simpson(g, a, b);
        Object.assign(out, { [m.name]: s, [`${m.name}_exact`]: exact, [`${m.name}_error`]: Math.abs(s - exact) });
      } else if (m.kind === "area") out[m.name] = simpson(g, ev(m.a, env), ev(m.b, env));
      else if (m.kind === "band") {
        const L = ev(m.level, env);
        out[m.name] = Math.abs(simpson((x) => g(x) - L, ev(m.a, env), ev(m.b, env)));
      } else if (m.kind === "intersect") {
        const [x, y] = meet(c, m, env);
        Object.assign(out, { [`${m.name}_x`]: x, [`${m.name}_y`]: y });
      }
    }
    return out;
  },

  frame(c, envs) {
    if (c.y) return { y: [c.y.min, c.y.max] };
    const ys: number[] = [];
    for (const env of envs)
      c.curves.forEach((_, i) => {
        const g = f(c, i, env);
        for (let k = 0; k <= 120; k++) ys.push(g(c.x.min + ((c.x.max - c.x.min) * k) / 120));
      });
    return { y: fitRange(ys) };
  },

  draw(c, env, { frame, base }) {
    const p = new Plot([c.x.min, c.x.max], frame.y).axes(c.x.label, c.y?.label ?? c.y_label ?? "");
    for (const m of c.marks ?? []) {
      const g = "curve" in m ? f(c, m.curve, env) : f(c, 0, env);
      if (m.kind === "riemann") {
        const [a, b] = [ev(m.a, env), ev(m.b, env)];
        for (const [x0, x1, y] of riemann(g, a, b, ev(m.n, env), m.rule ?? "left").rects) p.rect(x0, 0, x1, y, "c2", 0.3);
      } else if (m.kind === "area") {
        const [a, b] = [ev(m.a, env), ev(m.b, env)];
        const pts: [number, number][] = [[a, 0]];
        for (let k = 0; k <= 120; k++) {
          const x = a + ((b - a) * k) / 120;
          pts.push([x, g(x)]);
        }
        pts.push([b, 0]);
        p.path(pts, "c1", { fill: true, opacity: 0.18, width: 0 });
      } else if (m.kind === "band") {
        const [a, b, L] = [ev(m.a, env), ev(m.b, env), ev(m.level, env)];
        const pts: [number, number][] = [[a, L]];
        for (let k = 0; k <= 120; k++) pts.push([a + ((b - a) * k) / 120, g(a + ((b - a) * k) / 120)]);
        pts.push([b, L]);
        p.path(pts, "c2", { fill: true, opacity: 0.25, width: 0 });
      } else if (m.kind === "ghost") p.fn(f(c, m.curve, base), "muted", { dash: true, width: 1.5, opacity: 0.6 });
      else if (m.kind === "vline") p.vline(ev(m.at, env));
    }
    c.curves.forEach((cv, i) => {
      p.fn(f(c, i, env), (["c0", "c1", "c2", "c3"] as const)[i % 4], { width: 2.5 });
      if (c.curves.length > 1) p.label(cv.label, [c.x.max, f(c, i, env)(c.x.max)], (["c0", "c1", "c2", "c3"] as const)[i % 4], { anchor: "end", dx: -4, dy: -8, size: 12 });
    });
    for (const m of c.marks ?? []) {
      const g = "curve" in m ? f(c, m.curve, env) : f(c, 0, env);
      if (m.kind === "tangent") {
        const x = ev(m.at, env);
        const k = slope(g, x);
        const span = (c.x.max - c.x.min) * 0.3;
        p.seg([x - span, g(x) - k * span], [x + span, g(x) + k * span], "c2", { width: 2 }).dot([x, g(x)], "c2", 5);
      } else if (m.kind === "secant") {
        const [a, b] = [ev(m.a, env), ev(m.b, env)];
        const k = (g(b) - g(a)) / (b - a);
        p.fn((x) => g(a) + k * (x - a), "c3", { width: 1.8 }).dot([a, g(a)], "c3", 4.5).dot([b, g(b)], "c3", 4.5);
      } else if (m.kind === "intersect") {
        const [x, y] = meet(c, m, env);
        if (!Number.isFinite(x)) continue;
        p.seg([x, frame.y[0]], [x, y], "muted", { dash: true }).seg([c.x.min, y], [x, y], "muted", { dash: true });
        p.dot([x, y], "accent", 6).label(`(${fmt(x)}, ${fmt(y)})`, [x, y], "ink", { size: 12 });
      } else if (m.kind === "point") {
        const x = ev(m.at, env);
        p.vline(x).dot([x, g(x)], "accent", 6).label(`(${fmt(x)}, ${fmt(g(x))})`, [x, g(x)], "ink", { size: 12 });
        if (m.drag) p.handle(`point:${m.drag}`, [x, g(x)]);
      }
    }
    return [p];
  },

  drag(c, _env, id, [x]) {
    const [, param] = id.split(":");
    return param ? { [param]: Math.max(c.x.min, Math.min(c.x.max, x)) } : {};
  },
};

/** Where curves i and j meet, by bisection on their difference over [from, to] (default: the x range). */
function meet(c: FunctionConfig, m: Extract<Mark, { kind: "intersect" }>, env: Env): [number, number] {
  const gi = f(c, m.curves[0], env);
  const gj = f(c, m.curves[1], env);
  const d = (x: number) => gi(x) - gj(x);
  let a = m.from ? ev(m.from, env) : c.x.min;
  let b = m.to ? ev(m.to, env) : c.x.max;
  // find a sign change first
  let found = false;
  for (let k = 0; k < 200 && !found; k++) {
    const x0 = a + ((b - a) * k) / 200;
    const x1 = a + ((b - a) * (k + 1)) / 200;
    if (d(x0) === 0) return [x0, gi(x0)];
    if (d(x0) * d(x1) < 0) ([a, b, found] = [x0, x1, true]);
  }
  if (!found) return [Infinity, Infinity]; // they do not meet on this chart
  for (let k = 0; k < 60; k++) {
    const mid = (a + b) / 2;
    if (d(a) * d(mid) <= 0) b = mid;
    else a = mid;
  }
  return [(a + b) / 2, gi((a + b) / 2)];
}

const fmt = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "—");
