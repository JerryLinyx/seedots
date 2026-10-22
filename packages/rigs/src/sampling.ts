// Sampling rig: draw outcomes with given probabilities (seeded, so every run of the same spec is the same),
// and compare what was observed with what was expected — running mean vs expected value, counts vs
// expected counts, and a chi-square test.

import { Plot, fitRange } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type Outcome = { label: string; p: string; value?: string; expect?: string }; // expect: the hypothesis the chi-square tests (default p)
export type SamplingConfig = {
  outcomes: Outcome[];
  draws: string; // formula for how many draws (usually a param)
  max_draws: number;
  seed?: number;
  view?: ("mean" | "counts")[];
};

const TONES = ["c0", "c2", "c3", "c1"] as const;
// 5% critical values of chi-square, df = 1..10
const CHI05 = [0, 3.841, 5.991, 7.815, 9.488, 11.07, 12.59, 14.07, 15.51, 16.92, 18.31];
const FIT = ["fits the expected ratio", "does not fit the expected ratio"];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function norm(v: number[]): number[] {
  const z = v.reduce((a, b) => a + Math.max(0, b), 0) || 1;
  return v.map((x) => Math.max(0, x) / z);
}

function simulate(c: SamplingConfig, env: Env, draws?: number) {
  const raw = c.outcomes.map((o) => Math.max(0, ev(o.p, env)));
  const p = norm(raw);
  const val = c.outcomes.map((o, i) => (o.value ? ev(o.value, env) : i));
  const n = draws ?? Math.max(0, Math.min(c.max_draws, Math.round(ev(c.draws, env))));
  const r = rng(c.seed ?? 42);
  const counts = p.map(() => 0);
  const means: number[] = [];
  let sum = 0;
  for (let k = 0; k < n; k++) {
    // the same uniform stream for every param setting: changing p moves outcomes, not the luck
    const u = r();
    let i = 0;
    for (let acc = p[0]; u > acc && i < p.length - 1; acc += p[++i]);
    counts[i]++;
    sum += val[i];
    means.push(sum / (k + 1));
  }
  const ev_ = p.reduce((a, x, i) => a + x * val[i], 0);
  const h = c.outcomes.some((o) => o.expect) ? norm(c.outcomes.map((o, i) => (o.expect ? ev(o.expect, env) : raw[i]))) : p;
  let chi2 = 0;
  h.forEach((x, i) => x > 0 && n > 0 && (chi2 += (counts[i] - n * x) ** 2 / (n * x)));
  return { p, h, val, n, counts, means, ev: ev_, chi2 };
}

export const samplingRig: Rig<SamplingConfig> = {
  id: "sampling",
  label: "Sampling",

  check(c, params) {
    const out: string[] = [];
    if (!(c.outcomes?.length >= 2)) out.push("need at least 2 outcomes");
    if (!(c.max_draws >= 1 && c.max_draws <= 20000)) out.push("max_draws must be 1..20000");
    c.outcomes?.forEach((o, i) => {
      out.push(...checkExpr(o.p, params, `outcome ${i}.p`));
      if (o.value) out.push(...checkExpr(o.value, params, `outcome ${i}.value`));
      if (o.expect) out.push(...checkExpr(o.expect, params, `outcome ${i}.expect`));
    });
    out.push(...checkExpr(c.draws, params, "draws"));
    return out;
  },

  observables(c) {
    return {
      numeric: ["n", "mean", "expected", "gap", "chi2", ...c.outcomes.flatMap((_, i) => [`count${i}`, `freq${i}`])],
      categories: { fit: FIT },
    };
  },

  observe(c, env) {
    const s = simulate(c, env);
    const mean = s.n ? s.means[s.n - 1] : 0;
    const out: Observed = { n: s.n, mean, expected: s.ev, gap: Math.abs(mean - s.ev), chi2: s.chi2 };
    s.counts.forEach((k, i) => Object.assign(out, { [`count${i}`]: k, [`freq${i}`]: s.n ? k / s.n : 0 }));
    const df = Math.min(10, c.outcomes.length - 1);
    out.fit = s.n && s.chi2 > CHI05[df] ? FIT[1] : FIT[0];
    return out;
  },

  frame(c, envs) {
    // the running mean after the first few draws, and the expected value, at every env the scene reaches
    const ys = envs.flatMap((env) => {
      const s = simulate(c, env, c.max_draws);
      return [s.ev, ...s.means.slice(Math.min(20, s.means.length - 1))];
    });
    return { y: fitRange(ys, 0.15) };
  },

  draw(c, env, { frame }) {
    const s = simulate(c, env);
    const views = c.view ?? ["mean", "counts"];
    const plots: Plot[] = [];
    const size = views.length > 1 ? { h: 250 } : {};
    if (views.includes("mean")) {
      const p = new Plot([0, c.max_draws], frame.y, size).axes("draws", "running mean");
      p.hline(s.ev, "c2", false).label(`expected ${fmt(s.ev)}`, [c.max_draws, s.ev], "c2", { anchor: "end", dx: -4, size: 12 });
      p.path(s.means.map((m, i) => [i + 1, m]), "accent", { width: 1.8 });
      if (s.n) p.dot([s.n, s.means[s.n - 1]], "accent", 5);
      plots.push(p);
    }
    if (views.includes("counts")) {
      const k = c.outcomes.length;
      const top = Math.max(1, ...s.counts, ...s.h.map((x) => x * s.n)) * 1.15;
      const p = new Plot([-0.6, k - 0.4], [0, top], size).axes("", "count", { xTicks: false });
      c.outcomes.forEach((o, i) => {
        p.rect(i - 0.3, 0, i + 0.3, s.counts[i], TONES[i % 4], 0.7);
        p.seg([i - 0.38, s.h[i] * s.n], [i + 0.38, s.h[i] * s.n], "ink", { width: 2, dash: true });
        p.label(o.label, [i, 0], "ink", { anchor: "middle", dx: 0, dy: 30, size: 12 });
        p.label(String(s.counts[i]), [i, s.counts[i]], "ink", { anchor: "middle", dx: 0, size: 11 });
      });
      plots.push(p);
    }
    return plots;
  },
};

const fmt = (v: number) => String(Math.round(v * 100) / 100);
