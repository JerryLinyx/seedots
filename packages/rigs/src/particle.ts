// Particle rig: one body moved by an acceleration written as formulas of its state (x, y, vx, vy, t) and params.
// Integrated with RK4. Drawn in space (y against x) or against time; a `reveal` param can play the motion.

import { Plot, fitRange } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type View = "space" | "x-t" | "y-t" | "v-t";
export type ParticleConfig = {
  start: { x: string; y: string; vx: string; vy: string };
  ax: string;
  ay: string;
  dt: number;
  duration: number;
  stop_at_ground?: boolean; // end the run when y falls below 0
  stop_x?: string; // end the run when x reaches this (the end of a track)
  views: View[];
  x_label?: string;
  y_label?: string;
  reveal?: string; // a param in seconds: show the motion up to this time
  period_of?: "x" | "y"; // measure the period of oscillation in this coordinate
};

type S = [number, number, number, number]; // x, y, vx, vy
const STATE = ["x", "y", "vx", "vy", "t"];

export function run(c: ParticleConfig, env: Env) {
  const acc = (s: S, t: number): [number, number] => {
    const e = { ...env, x: s[0], y: s[1], vx: s[2], vy: s[3], t };
    return [ev(c.ax, e), ev(c.ay, e)];
  };
  const d = (s: S, t: number): S => {
    const [ax, ay] = acc(s, t);
    return [s[2], s[3], ax, ay];
  };
  let s: S = [ev(c.start.x, env), ev(c.start.y, env), ev(c.start.vx, env), ev(c.start.vy, env)];
  const xEnd = c.stop_x ? ev(c.stop_x, env) : Infinity;
  const h = c.dt;
  const ts = [0];
  const ss = [s];
  for (let t = 0; t < c.duration - 1e-9; t += h) {
    const k1 = d(s, t);
    const k2 = d(s.map((v, i) => v + (h / 2) * k1[i]) as S, t + h / 2);
    const k3 = d(s.map((v, i) => v + (h / 2) * k2[i]) as S, t + h / 2);
    const k4 = d(s.map((v, i) => v + h * k3[i]) as S, t + h);
    const nx = s.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])) as S;
    if (!nx.every(Number.isFinite) || nx.some((v) => Math.abs(v) > 1e7)) break;
    if (c.stop_at_ground && t > 0 && nx[1] < 0) {
      // land exactly on y = 0
      const f = s[1] / (s[1] - nx[1]);
      ss.push(s.map((v, i) => v + (nx[i] - v) * f) as S);
      ts.push(t + h * f);
      break;
    }
    if (nx[0] >= xEnd) {
      const f = (xEnd - s[0]) / (nx[0] - s[0]);
      ss.push(s.map((v, i) => v + (nx[i] - v) * f) as S);
      ts.push(t + h * f);
      break;
    }
    s = nx;
    ss.push(s);
    ts.push(t + h);
  }
  return { ts, ss };
}

function period(ts: number[], xs: number[]): number {
  const mid = (Math.max(...xs) + Math.min(...xs)) / 2;
  const up: number[] = [];
  for (let i = 1; i < xs.length; i++)
    if (xs[i - 1] < mid && xs[i] >= mid) up.push(ts[i - 1] + ((mid - xs[i - 1]) / (xs[i] - xs[i - 1])) * (ts[i] - ts[i - 1]));
  return up.length >= 2 ? (up[up.length - 1] - up[0]) / (up.length - 1) : Infinity; // it does not oscillate
}

export const particleRig: Rig<ParticleConfig> = {
  id: "particle",
  label: "Motion",

  check(c, params) {
    const out: string[] = [];
    const st = new Set([...params, ...STATE]);
    for (const k of ["x", "y", "vx", "vy"] as const) out.push(...checkExpr(c.start?.[k], params, `start.${k}`));
    out.push(...checkExpr(c.ax, st, "ax"), ...checkExpr(c.ay, st, "ay"));
    if (!(c.dt > 0 && c.duration > 0 && c.duration / c.dt <= 5000)) out.push("dt and duration must give 1..5000 steps");
    if (!c.views?.length) out.push("no views");
    if (c.reveal && !params.has(c.reveal)) out.push(`reveal: no param ${c.reveal}`);
    if (c.stop_x) out.push(...checkExpr(c.stop_x, params, "stop_x"));
    return out;
  },

  observables(c) {
    const numeric = ["range", "max_height", "flight_time", "final_speed", "max_speed", "x_final", "y_final"];
    if (c.period_of) numeric.push("period", "amplitude_end");
    return { numeric, categories: {} };
  },

  observe(c, env) {
    const { ts, ss } = run(c, env);
    const last = ss[ss.length - 1];
    const sp = ss.map((s) => Math.hypot(s[2], s[3]));
    const out: Observed = {
      range: last[0] - ss[0][0],
      max_height: Math.max(...ss.map((s) => s[1])),
      flight_time: ts[ts.length - 1],
      final_speed: sp[sp.length - 1],
      max_speed: Math.max(...sp),
      x_final: last[0],
      y_final: last[1],
    };
    if (c.period_of) {
      const k = c.period_of === "x" ? 0 : 1;
      const xs = ss.map((s) => s[k]);
      out.period = period(ts, xs);
      const tail = xs.slice(Math.floor(xs.length * 0.9));
      out.amplitude_end = (Math.max(...tail) - Math.min(...tail)) / 2;
    }
    return out;
  },

  frame(c, envs) {
    const runs = envs.map((e) => run(c, e));
    const all = runs.flatMap((r) => r.ss);
    const T = Math.max(...runs.map((r) => r.ts[r.ts.length - 1]));
    return {
      x: fitRange(all.map((s) => s[0]), 0.06),
      y: fitRange([0, ...all.map((s) => s[1])], 0.06),
      v: fitRange(all.flatMap((s) => [s[2], s[3]]), 0.06),
      t: [0, T],
    };
  },

  draw(c, env, { frame }) {
    const { ts, ss } = run(c, env);
    const upto = c.reveal ? env[c.reveal] : Infinity;
    const n = Math.max(1, ts.findIndex((t) => t > upto) < 0 ? ts.length : ts.findIndex((t) => t > upto));
    const shown = ss.slice(0, n);
    const now = shown[shown.length - 1];
    const size = c.views.length > 1 ? { h: 260 } : {};
    return c.views.map((v) => {
      if (v === "space") {
        const p = new Plot(frame.x, frame.y, { ...size, equal: true }).axes(c.x_label ?? "x (m)", c.y_label ?? "y (m)");
        if (c.stop_at_ground) p.hline(0, "ink", false);
        p.path(shown.map((s) => [s[0], s[1]]), "c0", { width: 2 });
        p.dot([now[0], now[1]], "accent", 7);
        p.arrow([now[0], now[1]], [now[0] + now[2] * 0.15, now[1] + now[3] * 0.15], "c2", { width: 1.6 });
        return p;
      }
      const k = v === "x-t" ? 0 : 1;
      const yr = v === "v-t" ? frame.v : v === "x-t" ? frame.x : frame.y;
      const p = new Plot(frame.t, yr, size).axes("t (s)", v === "v-t" ? "v (m/s)" : v === "x-t" ? "x" : "y");
      if (v === "v-t") {
        p.path(shown.map((s, i) => [ts[i], s[2]]), "c0", { width: 2 });
        p.path(shown.map((s, i) => [ts[i], s[3]]), "c2", { width: 2 });
        p.label("vx", [frame.t[1], ss[ss.length - 1][2]], "c0", { anchor: "end" }).label("vy", [frame.t[1], ss[ss.length - 1][3]], "c2", { anchor: "end" });
      } else p.path(shown.map((s, i) => [ts[i], s[k]]), "c0", { width: 2 });
      p.vline(ts[n - 1], "accent", false);
      return p;
    });
  },
};
