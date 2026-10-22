// Iteration rig: x(n+1) = update(x(n); params). Drawn on its objective when there is one, else as a time series.
// `reveal` names a param that limits how many steps are shown, so a player can step through the run.

import { behaviour, iterate } from "./expr.ts";
import { Plot, fitRange } from "./plot.ts";
import { checkExpr, ev, expr, type Rig } from "./runtime.ts";
import type { Env } from "./spec.ts";

export type IterationConfig = {
  start: string; // formula, may use params
  update: string; // uses x, n and params
  steps: number;
  objective?: string | null; // uses x and params
  x: { min: number; max: number; label: string };
  state_label?: string;
  target?: string; // a formula the run should approach; exposes `gap`
  reveal?: string;
};

const BEHAVIOUR = ["settles down", "keeps bouncing", "blows up"];
const run = (c: IterationConfig, env: Env) => iterate(expr(c.update), ev(c.start, env), c.steps, env);

export const iterationRig: Rig<IterationConfig> = {
  id: "iteration",
  label: "Iteration",

  check(c, params) {
    const out: string[] = [];
    if (!(c.steps >= 1 && c.steps <= 500)) out.push("steps must be 1..500");
    if (!c.x || !(c.x.min < c.x.max)) out.push("x range is empty");
    out.push(...checkExpr(c.start, params, "start"));
    out.push(...checkExpr(c.update, new Set([...params, "x", "n"]), "update"));
    if (c.objective) out.push(...checkExpr(c.objective, new Set([...params, "x"]), "objective"));
    if (c.target) out.push(...checkExpr(c.target, params, "target"));
    if (c.reveal && !params.has(c.reveal)) out.push(`reveal: no param ${c.reveal}`);
    return out;
  },

  observables(c) {
    return { numeric: ["final", "settle_step", ...(c.target ? ["gap"] : [])], categories: { behaviour: BEHAVIOUR } };
  },

  observe(c, env) {
    const xs = run(c, env);
    const last = xs[xs.length - 1];
    const scale = 1 + Math.max(...xs.filter(Number.isFinite).map(Math.abs));
    const settle = xs.findIndex((v, i) => i > 0 && xs.slice(i).every((w, j, a) => j === 0 || Math.abs(w - a[j - 1]) < 1e-3 * scale));
    const out: Record<string, number | string> = {
      final: Number.isFinite(last) ? last : Math.sign(last || 1) * 1e9,
      behaviour: behaviour(xs),
      settle_step: settle < 0 ? c.steps : settle,
    };
    if (c.target) out.gap = Math.min(1e9, Math.abs((out.final as number) - ev(c.target, env)));
    return out;
  },

  frame(c, envs) {
    if (c.objective) {
      const ys: number[] = [];
      for (const env of envs) for (let k = 0; k <= 120; k++) ys.push(ev(c.objective, { ...env, x: c.x.min + ((c.x.max - c.x.min) * k) / 120 }));
      return { y: fitRange(ys, 0.06) };
    }
    return { y: [c.x.min, c.x.max] };
  },

  draw(c, env, { frame }) {
    const xs = run(c, env);
    const shown = c.reveal ? Math.max(0, Math.min(xs.length - 1, Math.round(env[c.reveal]))) : xs.length - 1;
    const tone = "accent" as const;
    if (c.objective) {
      const obj = (x: number) => ev(c.objective!, { ...env, x });
      const p = new Plot([c.x.min, c.x.max], frame.y).axes(c.x.label, "");
      p.fn(obj, "c1", { width: 2.2 });
      if (c.target) p.vline(ev(c.target, env), "c2");
      let off: number | null = null;
      for (let i = 0; i <= shown; i++) {
        const x = xs[i];
        if (!Number.isFinite(x) || x < c.x.min || x > c.x.max) {
          off = i;
          break;
        }
        if (i > 0) p.arrow([xs[i - 1], obj(xs[i - 1])], [x, obj(x)], "muted", { width: 1.2 });
        p.dot([x, obj(x)], i === 0 ? "c0" : tone, i === 0 ? 6 : 4);
      }
      if (off != null) p.label(`off the chart at step ${off}`, [c.x.min + (c.x.max - c.x.min) * 0.5, frame.y[1]], "warn", { anchor: "middle", dy: 4 });
      return [p];
    }
    const p = new Plot([0, c.steps], frame.y).axes("step", c.state_label ?? "x");
    if (c.target) p.hline(ev(c.target, env), "c2");
    p.path(xs.slice(0, shown + 1).map((v, i) => [i, v]), tone, { width: 1.8 });
    xs.slice(0, shown + 1).forEach((v, i) => p.dot([i, v], tone, 3));
    return [p];
  },
};
