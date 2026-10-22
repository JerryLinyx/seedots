// Stocks rig (system dynamics): named quantities that change through flows written as formulas of the stocks,
// t and params. Integrated with RK4. Pulses add an amount to a stock at a moment (a dose, a second infection,
// adding reactant). Covers reaction kinetics, populations, epidemics, immune responses, water balance, battles.

import { Plot, fitRange } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type Stock = { name: string; label: string; init: string };
type Flow = { from?: string; to?: string; rate: string };
type Pulse = { stock: string; at: string; amount: string };
export type StocksConfig = {
  stocks: Stock[];
  flows: Flow[];
  pulses?: Pulse[];
  end: number;
  dt: number;
  show?: string[]; // stocks to plot, default all
  phase?: [string, string]; // also plot one stock against another
  y_label?: string;
  t_label?: string;
  reveal?: string; // a param in time units: draw up to here
};

const TONES = ["c0", "c2", "accent", "c3", "c1"] as const;

function run(c: StocksConfig, env: Env) {
  const names = c.stocks.map((s) => s.name);
  const deriv = (y: number[], t: number) => {
    const e: Env = { ...env, t };
    names.forEach((n, i) => (e[n] = y[i]));
    const d = y.map(() => 0);
    for (const f of c.flows) {
      const r = ev(f.rate, e);
      if (f.from) d[names.indexOf(f.from)] -= r;
      if (f.to) d[names.indexOf(f.to)] += r;
    }
    return d;
  };
  let y = c.stocks.map((s) => ev(s.init, env));
  const pulses = (c.pulses ?? []).map((p) => ({ i: names.indexOf(p.stock), at: ev(p.at, env), amount: ev(p.amount, env), done: false }));
  const h = c.dt;
  const ts = [0];
  const ys = [y];
  for (let t = 0; t < c.end - 1e-9; t += h) {
    const k1 = deriv(y, t);
    const k2 = deriv(y.map((v, i) => v + (h / 2) * k1[i]), t + h / 2);
    const k3 = deriv(y.map((v, i) => v + (h / 2) * k2[i]), t + h / 2);
    const k4 = deriv(y.map((v, i) => v + h * k3[i]), t + h);
    y = y.map((v, i) => Math.max(0, v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]))); // stocks never go negative
    for (const p of pulses)
      if (!p.done && t + h >= p.at) {
        y[p.i] += p.amount;
        p.done = true;
      }
    if (!y.every(Number.isFinite)) break;
    ts.push(t + h);
    ys.push(y);
  }
  return { ts, ys, names };
}

export const stocksRig: Rig<StocksConfig> = {
  id: "stocks",
  label: "Stocks & flows",

  check(c, params) {
    const out: string[] = [];
    if (!c.stocks?.length) out.push("no stocks");
    const names = new Set(c.stocks?.map((s) => s.name));
    const st = new Set([...params, ...names, "t"]);
    for (const s of c.stocks ?? []) out.push(...checkExpr(s.init, params, `${s.name}.init`));
    for (const f of c.flows ?? []) {
      if (f.from && !names.has(f.from)) out.push(`flow from unknown stock ${f.from}`);
      if (f.to && !names.has(f.to)) out.push(`flow to unknown stock ${f.to}`);
      out.push(...checkExpr(f.rate, st, `flow ${f.from ?? "∅"}→${f.to ?? "∅"}`));
    }
    for (const p of c.pulses ?? []) {
      if (!names.has(p.stock)) out.push(`pulse into unknown stock ${p.stock}`);
      out.push(...checkExpr(p.at, params, "pulse.at"), ...checkExpr(p.amount, params, "pulse.amount"));
    }
    if (!(c.dt > 0 && c.end > 0 && c.end / c.dt <= 5000)) out.push("dt and end must give 1..5000 steps");
    if (c.reveal && !params.has(c.reveal)) out.push(`reveal: no param ${c.reveal}`);
    for (const n of [...(c.show ?? []), ...(c.phase ?? [])]) if (!names.has(n)) out.push(`no stock ${n}`);
    return out;
  },

  observables(c) {
    return { numeric: c.stocks.flatMap((s) => [`${s.name}_final`, `${s.name}_max`, `${s.name}_tmax`, `${s.name}_t90`]), categories: {} };
  },

  observe(c, env) {
    const { ts, ys, names } = run(c, env);
    const out: Observed = {};
    names.forEach((n, i) => {
      const v = ys.map((y) => y[i]);
      const max = Math.max(...v);
      const fin = v[v.length - 1];
      // time to cover 90% of the way from the start to the end value
      const goal = v[0] + 0.9 * (fin - v[0]);
      const k = v.findIndex((x) => (fin >= v[0] ? x >= goal : x <= goal));
      Object.assign(out, { [`${n}_final`]: fin, [`${n}_max`]: max, [`${n}_tmax`]: ts[v.indexOf(max)], [`${n}_t90`]: Math.abs(fin - v[0]) < 1e-9 ? 0 : ts[Math.max(0, k)] });
    });
    return out;
  },

  frame(c, envs) {
    const show = c.show ?? c.stocks.map((s) => s.name);
    const vals = envs.flatMap((e) => {
      const r = run(c, e);
      return r.ys.flatMap((y) => show.map((n) => y[r.names.indexOf(n)]));
    });
    const [lo, hi] = fitRange([0, ...vals], 0.05);
    return { y: [Math.min(0, lo), hi] };
  },

  draw(c, env, { frame }) {
    const { ts, ys, names } = run(c, env);
    const upto = c.reveal ? env[c.reveal] : Infinity;
    const n = ts.filter((t) => t <= upto + 1e-9).length || 1;
    const show = c.show ?? names;
    const size = c.phase ? { h: 270 } : {};
    const p = new Plot([0, c.end], frame.y, size).axes(c.t_label ?? "time", c.y_label ?? "amount");
    for (const pl of c.pulses ?? []) p.vline(ev(pl.at, env), "muted", true);
    show.forEach((name, j) => {
      const i = names.indexOf(name);
      const tone = TONES[j % TONES.length];
      p.path(ys.slice(0, n).map((y, k) => [ts[k], y[i]]), tone, { width: 2.4 });
      const last = ys[n - 1][i];
      p.label(c.stocks[i].label, [ts[n - 1], last], tone, { size: 12 });
    });
    if (c.reveal) p.vline(ts[n - 1], "accent", false);
    const out = [p];
    if (c.phase) {
      const [a, b] = c.phase.map((x) => names.indexOf(x));
      const all = ys.map((y) => [y[a], y[b]] as [number, number]);
      const q = new Plot(fitRange([0, ...all.map((x) => x[0])]), fitRange([0, ...all.map((x) => x[1])]), size).axes(c.stocks[a].label, c.stocks[b].label);
      q.path(all.slice(0, n), "c3", { width: 2 }).dot(all[n - 1], "accent", 5);
      out.push(q);
    }
    return out;
  },
};
