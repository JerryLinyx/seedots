// Timeline rig: data series over time (linear between the given points) plus marked events,
// with a cursor at the year a param sets. Readouts give each series at the cursor and how fast it changes there.
// The data itself must come from evidence (the video, a cited source); the rig only interpolates and measures.

import { Plot, fitRange } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type Series = { name: string; label: string; points: [number, number][] };
export type TimelineConfig = { series: Series[]; events?: { t: number; label: string }[]; at: string; t_label?: string; y_label?: string; source?: string };

const TONES = ["c0", "c2", "c3", "accent"] as const;
const TREND = ["rising", "falling", "flat"];

function value(s: Series, t: number): number {
  const p = s.points;
  if (t <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) if (t <= p[i][0]) return p[i - 1][1] + ((t - p[i - 1][0]) / (p[i][0] - p[i - 1][0])) * (p[i][1] - p[i - 1][1]);
  return p[p.length - 1][1];
}
const rate = (s: Series, t: number) => (value(s, t + 0.5) - value(s, t - 0.5)) / 1;

export const timelineRig: Rig<TimelineConfig> = {
  id: "timeline",
  label: "Timeline",

  check(c, params) {
    const out = checkExpr(c.at, params, "at");
    for (const s of c.series ?? []) {
      if (!(s.points?.length >= 2)) out.push(`${s.name}: need at least 2 points`);
      else if (s.points.some((p, i) => i > 0 && p[0] <= s.points[i - 1][0])) out.push(`${s.name}: times must increase`);
    }
    if (!c.series?.length) out.push("no series");
    return out;
  },

  observables(c) {
    return {
      numeric: c.series.flatMap((s) => [s.name, `${s.name}_rate`, `${s.name}_x_start`]),
      categories: Object.fromEntries(c.series.map((s) => [`${s.name}_trend`, TREND])),
    };
  },

  observe(c, env) {
    const t = ev(c.at, env);
    const out: Observed = {};
    for (const s of c.series) {
      const r = rate(s, t);
      const v = value(s, t);
      Object.assign(out, { [s.name]: v, [`${s.name}_rate`]: r, [`${s.name}_x_start`]: v / s.points[0][1] });
      out[`${s.name}_trend`] = Math.abs(r) < 1e-3 * Math.max(1, Math.abs(v)) ? TREND[2] : r > 0 ? TREND[0] : TREND[1];
    }
    return out;
  },

  frame(c) {
    const ts = c.series.flatMap((s) => s.points.map((p) => p[0]));
    return { t: [Math.min(...ts), Math.max(...ts)], y: fitRange([0, ...c.series.flatMap((s) => s.points.map((p) => p[1]))], 0.06) };
  },

  draw(c, env: Env, { frame }) {
    const t = ev(c.at, env);
    const p = new Plot(frame.t, frame.y).axes(c.t_label ?? "year", c.y_label ?? "");
    (c.events ?? []).forEach((e, i) => {
      p.vline(e.t, "muted", true);
      p.label(e.label, [e.t, frame.y[1] - ((frame.y[1] - frame.y[0]) * (i % 3)) * 0.07], "muted", { size: 11 });
    });
    c.series.forEach((s, j) => {
      const tone = TONES[j % 4];
      p.path(s.points, tone, { width: 2.4 });
      s.points.forEach((q) => p.dot(q, tone, 2.5));
      p.dot([t, value(s, t)], "accent", 6).label(`${s.label}: ${value(s, t).toFixed(2)}`, [t, value(s, t)], tone, { size: 12 });
    });
    p.vline(t, "accent", false);
    if (c.source) p.label(`data: ${c.source}`, [frame.t[0], frame.y[0]], "muted", { dy: -6, size: 10 });
    return [p];
  },
};
