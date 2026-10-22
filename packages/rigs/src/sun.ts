// Sun rig: where the sun is overhead through the year, and what that means at one latitude —
// day length and the noon sun's altitude. Left: Earth at that date, lit from the left, with the terminator;
// right: day length over the year with the chosen day marked.

import { Plot } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

export type SunConfig = { latitude: string; day: string; tilt?: string; compare?: string[] }; // compare: more latitudes on the year chart

const DAYTYPE = ["ordinary day and night", "polar day (sun never sets)", "polar night (sun never rises)"];
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Subsolar latitude (declination) in degrees for a day of the year (1 = 1 January). */
const decl = (day: number, tilt: number) => -tilt * Math.cos((2 * Math.PI * (day + 10)) / 365);

function sun(lat: number, day: number, tilt: number) {
  const d = decl(day, tilt);
  const x = -Math.tan(rad(lat)) * Math.tan(rad(d));
  const len = x <= -1 ? 24 : x >= 1 ? 0 : (24 / Math.PI) * Math.acos(x);
  return { decl: d, length: len, noon: 90 - Math.abs(lat - d), kind: x <= -1 ? DAYTYPE[1] : x >= 1 ? DAYTYPE[2] : DAYTYPE[0] };
}

export const sunRig: Rig<SunConfig> = {
  id: "sun",
  label: "Sun & seasons",

  check(c, params) {
    return [...checkExpr(c.latitude, params, "latitude"), ...checkExpr(c.day, params, "day"), ...(c.tilt ? checkExpr(c.tilt, params, "tilt") : []), ...(c.compare ?? []).flatMap((x, i) => checkExpr(x, params, `compare[${i}]`))];
  },

  observables() {
    return { numeric: ["declination", "day_length", "noon_altitude", "night_length"], categories: { daytype: DAYTYPE } };
  },

  observe(c, env) {
    const tilt = c.tilt ? ev(c.tilt, env) : 23.44;
    const s = sun(ev(c.latitude, env), ev(c.day, env), tilt);
    return { declination: s.decl, day_length: s.length, night_length: 24 - s.length, noon_altitude: s.noon, daytype: s.kind } as Observed;
  },

  draw(c, env: Env) {
    const tilt = c.tilt ? ev(c.tilt, env) : 23.44;
    const lat = ev(c.latitude, env);
    const day = ev(c.day, env);
    const s = sun(lat, day, tilt);
    // Earth seen side-on; the sun's rays come from the left, so the subsolar point sits at the left limb
    const e = new Plot([-1.6, 1.6], [-1.3, 1.3], { h: 300, equal: true });
    for (let k = -3; k <= 3; k++) e.arrow([-1.6, k * 0.3], [-1.05, k * 0.3], "c2", { width: 1.2 });
    const circle = (r: number) => Array.from({ length: 121 }, (_, i) => [r * Math.cos((i / 60) * Math.PI), r * Math.sin((i / 60) * Math.PI)] as [number, number]);
    e.path(circle(1), "c0", { fill: true, opacity: 0.18, width: 0 }).path(circle(1), "c0", { width: 1.6 });
    // night half: x > 0 in the sun's frame
    e.path(Array.from({ length: 61 }, (_, i) => [Math.cos(-Math.PI / 2 + (i / 60) * Math.PI), Math.sin(-Math.PI / 2 + (i / 60) * Math.PI)] as [number, number]), "ink", { fill: true, opacity: 0.35, width: 0 });
    // the axis tilted by the declination: north pole tips toward the sun when declination > 0
    const a = rad(s.decl);
    const axis: [number, number] = [-Math.sin(a), Math.cos(a)];
    e.seg([axis[0] * -1.25, axis[1] * -1.25], [axis[0] * 1.25, axis[1] * 1.25], "muted", { width: 1.4 }).label("N", [axis[0] * 1.25, axis[1] * 1.25], "ink", { size: 12 });
    // latitude circle seen edge-on: a chord perpendicular to the axis
    const L = rad(lat);
    const cx = Math.sin(L) * axis[0];
    const cy = Math.sin(L) * axis[1];
    const perp: [number, number] = [axis[1], -axis[0]];
    const hw = Math.cos(L);
    e.seg([cx - perp[0] * hw, cy - perp[1] * hw], [cx + perp[0] * hw, cy + perp[1] * hw], "accent", { width: 2.4 });
    e.label(`${lat.toFixed(0)}°`, [cx + perp[0] * hw, cy + perp[1] * hw], "accent", { size: 12 });
    // the equator and the subsolar point
    e.seg([-perp[0], -perp[1]], [perp[0], perp[1]], "muted", { dash: true });
    e.dot([-1, 0], "c2", 5).label("sun overhead", [-1, 0], "c2", { dx: -4, dy: 16, anchor: "end", size: 11 });

    const y = new Plot([1, 365], [0, 24], { h: 260 }).axes("day of the year", "day length (h)");
    for (const m of [80, 172, 266, 355]) y.vline(m, "muted", true);
    const curve = (la: number) => (d: number) => sun(la, d, tilt).length;
    (c.compare ?? []).forEach((x) => {
      const la = ev(x, env);
      y.fn(curve(la), "c3", { width: 1.4, opacity: 0.7 }).label(`${la.toFixed(0)}°`, [365, curve(la)(365)], "c3", { anchor: "end", size: 11 });
    });
    y.fn(curve(lat), "c0", { width: 2.6 }).dot([day, s.length], "accent", 6).label(`${s.length.toFixed(1)} h`, [day, s.length], "ink", { size: 12 });
    return [e, y];
  },
};
