// Vectors rig: 2D vectors from formulas, optionally draggable, an optional 2x2 matrix applied to them,
// and measures between pairs (dot product, cosine, angle, projection).

import { Plot } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type Vec = { name: string; x: string; y: string; label?: string; drag?: { x: string; y: string } | { angle: string; degrees?: boolean } };
export type VectorsConfig = {
  extent: number; // half-width of the view
  vectors: Vec[];
  matrix?: { a: string; b: string; c: string; d: string; apply_to: string[] };
  pairs?: [string, string][]; // measures between these
  project?: [string, string]; // projection of the first onto the second
  unit_circle?: boolean;
};

const TONES = ["c0", "c1", "c2", "c3"] as const;
const vec = (c: VectorsConfig, v: Vec, env: Env): [number, number] => [ev(v.x, env), ev(v.y, env)];
const mat = (c: VectorsConfig, env: Env) => (c.matrix ? [ev(c.matrix.a, env), ev(c.matrix.b, env), ev(c.matrix.c, env), ev(c.matrix.d, env)] : null);
const apply = (m: number[], [x, y]: [number, number]): [number, number] => [m[0] * x + m[1] * y, m[2] * x + m[3] * y];

/** Each vector after the matrix (if it applies to it). */
function points(c: VectorsConfig, env: Env): Record<string, [number, number]> {
  const m = mat(c, env);
  const out: Record<string, [number, number]> = {};
  for (const v of c.vectors) {
    const p = vec(c, v, env);
    out[v.name] = m && c.matrix!.apply_to.includes(v.name) ? apply(m, p) : p;
  }
  return out;
}

export const vectorsRig: Rig<VectorsConfig> = {
  id: "vectors",
  label: "Vectors",

  check(c, params) {
    const out: string[] = [];
    if (!(c.extent > 0)) out.push("extent must be positive");
    if (!c.vectors?.length) out.push("no vectors");
    const nm = new Set(c.vectors?.map((v) => v.name));
    for (const v of c.vectors ?? []) {
      out.push(...checkExpr(v.x, params, `${v.name}.x`), ...checkExpr(v.y, params, `${v.name}.y`));
      if (v.drag && "x" in v.drag && (!params.has(v.drag.x) || !params.has(v.drag.y))) out.push(`${v.name}.drag: unknown params`);
      if (v.drag && "angle" in v.drag && !params.has(v.drag.angle)) out.push(`${v.name}.drag: unknown param ${v.drag.angle}`);
    }
    if (c.matrix) {
      for (const k of ["a", "b", "c", "d"] as const) out.push(...checkExpr(c.matrix[k], params, `matrix.${k}`));
      for (const n of c.matrix.apply_to) if (!nm.has(n)) out.push(`matrix.apply_to: no vector ${n}`);
    }
    for (const pr of [...(c.pairs ?? []), ...(c.project ? [c.project] : [])]) for (const n of pr) if (!nm.has(n)) out.push(`pair: no vector ${n}`);
    return out;
  },

  observables(c) {
    const numeric = c.vectors.flatMap((v) => [`${v.name}_x`, `${v.name}_y`, `${v.name}_len`]);
    for (const [a, b] of c.pairs ?? []) numeric.push(`dot_${a}_${b}`, `cos_${a}_${b}`, `angle_${a}_${b}`);
    if (c.project) numeric.push("proj");
    if (c.matrix) numeric.push("det");
    return { numeric, categories: {} };
  },

  observe(c, env) {
    const P = points(c, env);
    const out: Observed = {};
    for (const [n, [x, y]] of Object.entries(P)) Object.assign(out, { [`${n}_x`]: x, [`${n}_y`]: y, [`${n}_len`]: Math.hypot(x, y) });
    for (const [a, b] of c.pairs ?? []) {
      const dot = P[a][0] * P[b][0] + P[a][1] * P[b][1];
      const cos = dot / (Math.hypot(...P[a]) * Math.hypot(...P[b]) || NaN);
      Object.assign(out, { [`dot_${a}_${b}`]: dot, [`cos_${a}_${b}`]: cos, [`angle_${a}_${b}`]: (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI });
    }
    if (c.project) {
      const [a, b] = c.project;
      out.proj = (P[a][0] * P[b][0] + P[a][1] * P[b][1]) / (Math.hypot(...P[b]) || NaN);
    }
    const m = mat(c, env);
    if (m) out.det = m[0] * m[3] - m[1] * m[2];
    return out;
  },

  draw(c, env) {
    const e = c.extent;
    const p = new Plot([-e, e], [-e, e], { equal: true }).axes();
    const m = mat(c, env);
    if (m) {
      // the image of the unit grid, faint
      for (let k = -Math.ceil(e); k <= Math.ceil(e); k++) {
        p.seg(apply(m, [k, -e * 2]), apply(m, [k, e * 2]), "c3", { width: 1, opacity: 0.35 });
        p.seg(apply(m, [-e * 2, k]), apply(m, [e * 2, k]), "c3", { width: 1, opacity: 0.35 });
      }
      p.path([[0, 0], apply(m, [1, 0]), apply(m, [1, 1]), apply(m, [0, 1])], "c2", { fill: true, opacity: 0.3, width: 0 });
    }
    if (c.unit_circle) p.path(Array.from({ length: 121 }, (_, i) => [Math.cos((i / 60) * Math.PI), Math.sin((i / 60) * Math.PI)] as [number, number]), "muted", { dash: true, width: 1.2 });
    const P = points(c, env);
    if (c.project) {
      const [a, b] = c.project;
      const ub = Math.hypot(...P[b]) || 1;
      const t = (P[a][0] * P[b][0] + P[a][1] * P[b][1]) / ub / ub;
      const foot: [number, number] = [P[b][0] * t, P[b][1] * t];
      p.seg(P[a], foot, "muted", { dash: true }).arrow([0, 0], foot, "accent", { width: 4 });
    }
    c.vectors.forEach((v, i) => {
      const tone = TONES[i % 4];
      p.arrow([0, 0], P[v.name], tone, { width: 2.6 }).label(v.label ?? v.name, P[v.name], tone, { size: 13 });
      if (v.drag) p.handle(`vec:${v.name}`, P[v.name], tone);
    });
    return [p];
  },

  drag(c, _env, id, [x, y]) {
    const v = c.vectors.find((w) => `vec:${w.name}` === id);
    if (!v?.drag) return {};
    if ("angle" in v.drag) {
      const a = Math.atan2(y, x); // (-π, π]; the param's range clamps it
      return { [v.drag.angle]: v.drag.degrees ? (a * 180) / Math.PI : a };
    }
    return { [v.drag.x]: x, [v.drag.y]: y };
  },
};
