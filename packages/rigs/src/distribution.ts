// Distribution rig: one or more series of scores over the same categories, turned into probabilities
// (softmax with a temperature, or plain normalising) and drawn as grouped bars.

import { Plot } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type Series = { name: string; label: string; scores: string[]; temperature?: string; transform?: "softmax" | "normalize" };
export type DistributionConfig = { categories: string[]; series: Series[]; y_label?: string };

const TONES = ["c0", "c2", "c3", "c1"] as const;

function probs(s: Series, env: Env): number[] {
  const v = s.scores.map((x) => ev(x, env));
  if (s.transform === "normalize") {
    const z = v.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    return v.map((x) => Math.max(0, x) / z);
  }
  const t = s.temperature ? ev(s.temperature, env) : 1;
  const m = Math.max(...v.map((x) => x / t));
  const e = v.map((x) => Math.exp(x / t - m));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / z);
}

export const distributionRig: Rig<DistributionConfig> = {
  id: "distribution",
  label: "Distribution",

  check(c, params) {
    const out: string[] = [];
    if (!(c.categories?.length >= 2)) out.push("need at least 2 categories");
    if (!c.series?.length) out.push("no series");
    for (const s of c.series ?? []) {
      if (s.scores.length !== c.categories.length) out.push(`${s.name}: ${s.scores.length} scores for ${c.categories.length} categories`);
      s.scores.forEach((x, i) => out.push(...checkExpr(x, params, `${s.name}.scores[${i}]`)));
      if (s.temperature) out.push(...checkExpr(s.temperature, params, `${s.name}.temperature`));
    }
    return out;
  },

  observables(c) {
    const numeric = c.series.flatMap((s) => [...c.categories.map((_, i) => `${s.name}_p${i}`), `${s.name}_max`, `${s.name}_entropy`]);
    return { numeric, categories: Object.fromEntries(c.series.map((s) => [`${s.name}_top`, c.categories])) };
  },

  observe(c, env) {
    const out: Observed = {};
    for (const s of c.series) {
      const p = probs(s, env);
      p.forEach((x, i) => (out[`${s.name}_p${i}`] = x));
      out[`${s.name}_max`] = Math.max(...p);
      out[`${s.name}_entropy`] = -p.reduce((a, x) => a + (x > 0 ? x * Math.log2(x) : 0), 0);
      out[`${s.name}_top`] = c.categories[p.indexOf(Math.max(...p))];
    }
    return out;
  },

  draw(c, env) {
    const k = c.categories.length;
    const p = new Plot([-0.6, k - 0.4], [0, 1.05]).axes("", c.y_label ?? "probability", { xTicks: false });
    const w = 0.8 / c.series.length;
    c.series.forEach((s, j) => {
      probs(s, env).forEach((v, i) => {
        const x0 = i - 0.4 + j * w;
        p.rect(x0 + 0.02, 0, x0 + w - 0.02, v, TONES[j % 4], 0.75);
        p.label(v.toFixed(2), [x0 + w / 2, v], "ink", { anchor: "middle", dx: 0, size: 11 });
      });
    });
    c.categories.forEach((cat, i) => p.label(cat, [i, 0], "ink", { anchor: "middle", dx: 0, dy: 30, size: 12 }));
    if (c.series.length > 1) c.series.forEach((s, j) => p.label(s.label, [k - 0.45, 1.02 - j * 0.07], TONES[j % 4], { anchor: "end", dx: 0, size: 12 }));
    return [p];
  },
};
