// Optics rig, two benches. `lens`: a thin lens (f > 0 converging, f < 0 diverging), an object at distance u,
// the three principal rays and the image. `refraction`: a ray crossing from medium n1 into n2 (Snell's law),
// with total internal reflection past the critical angle.

import { Plot } from "./plot.ts";
import { checkExpr, ev, type Observables, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

export type OpticsConfig =
  | { bench: "lens"; f: string; u: string; h: string; extent?: number }
  | { bench: "refraction"; n1: string; n2: string; angle: string }; // angle of incidence in degrees

const IMAGE = ["real, inverted, smaller", "real, inverted, same size", "real, inverted, larger", "no image (rays parallel)", "virtual, upright, larger", "virtual, upright, smaller"];
const RAY = ["refracts", "totally reflected"];
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function lens(c: Extract<OpticsConfig, { bench: "lens" }>, env: Env) {
  const f = ev(c.f, env);
  const u = ev(c.u, env);
  const h = ev(c.h, env);
  const parallel = Math.abs(u - f) < 1e-6;
  const v = parallel ? Infinity : (u * f) / (u - f); // 1/u + 1/v = 1/f, real distances positive
  const m = parallel ? Infinity : -v / u;
  let kind: string;
  if (parallel) kind = IMAGE[3];
  else if (v > 0) kind = Math.abs(Math.abs(m) - 1) < 0.02 ? IMAGE[1] : Math.abs(m) < 1 ? IMAGE[0] : IMAGE[2];
  else kind = Math.abs(m) > 1 ? IMAGE[4] : IMAGE[5];
  return { f, u, h, v, m, kind };
}

function refraction(c: Extract<OpticsConfig, { bench: "refraction" }>, env: Env) {
  const n1 = ev(c.n1, env);
  const n2 = ev(c.n2, env);
  const a = ev(c.angle, env);
  const s = (n1 / n2) * Math.sin(rad(a));
  const critical = n1 > n2 ? deg(Math.asin(n2 / n1)) : NaN;
  return { n1, n2, a, tir: Math.abs(s) > 1, r: Math.abs(s) > 1 ? NaN : deg(Math.asin(s)), critical };
}

export const opticsRig: Rig<OpticsConfig> = {
  id: "optics",
  label: "Optics",

  check(c, params) {
    if (c.bench === "lens") return [...checkExpr(c.f, params, "f"), ...checkExpr(c.u, params, "u"), ...checkExpr(c.h, params, "h")];
    if (c.bench === "refraction") return [...checkExpr(c.n1, params, "n1"), ...checkExpr(c.n2, params, "n2"), ...checkExpr(c.angle, params, "angle")];
    return ["bench must be lens or refraction"];
  },

  observables(c): Observables {
    if (c.bench === "lens") return { numeric: ["v", "magnification", "image_height", "inv_u", "inv_v"], categories: { image: IMAGE } };
    return { numeric: ["refracted_angle", "critical_angle", "deviation"], categories: { ray: RAY } };
  },

  observe(c, env) {
    if (c.bench === "lens") {
      const L = lens(c, env);
      const big = (x: number) => (Number.isFinite(x) ? x : 1e9);
      return { v: big(L.v), magnification: big(L.m), image_height: big(L.m * L.h), inv_u: 1 / L.u, inv_v: Number.isFinite(L.v) ? 1 / L.v : 0, image: L.kind } as Observed;
    }
    const R = refraction(c, env);
    return { refracted_angle: R.tir ? 90 : R.r, critical_angle: Number.isFinite(R.critical) ? R.critical : 90, deviation: R.tir ? 180 - 2 * R.a : Math.abs(R.a - R.r), ray: R.tir ? RAY[1] : RAY[0] };
  },

  draw(c, env) {
    if (c.bench === "lens") {
      const L = lens(c, env);
      const e = c.extent ?? Math.max(4 * Math.abs(L.f), 1.5 * L.u);
      const H = 4 * Math.abs(L.h); // vertical scale follows the object, not the bench length
      const p = new Plot([-e, e], [-H, H], { h: 360 });
      p.hline(0, "ink", false);
      // the lens, and its focal points
      p.seg([0, -H * 0.85], [0, H * 0.85], "c3", { width: 3 });
      for (const s of [-1, 1]) p.dot([s * L.f, 0], "c3", 4).label(s < 0 ? "F" : "F′", [s * L.f, 0], "c3", { dy: 16, anchor: "middle", dx: 0 });
      p.dot([2 * L.f, 0], "muted", 3).dot([-2 * L.f, 0], "muted", 3);
      // the object, upright at x = -u
      p.arrow([-L.u, 0], [-L.u, L.h], "c0", { width: 3 }).label("object", [-L.u, L.h], "c0", { anchor: "middle", dx: 0 });
      const tip: [number, number] = [-L.u, L.h];
      const far = e * 1.2;
      // ray 1: parallel to the axis, then through F′ (or away from F for a diverging lens)
      p.seg(tip, [0, L.h], "c2", { width: 1.6 });
      const k1 = -L.h / L.f;
      p.seg([0, L.h], [far, L.h + k1 * far], "c2", { width: 1.6 });
      // ray 2: through the centre, undeviated
      p.seg(tip, [far, (-L.h / L.u) * far], "c2", { width: 1.6 });
      if (Number.isFinite(L.v) && Math.abs(L.v) < e) {
        const ih = L.m * L.h;
        if (L.v > 0) p.arrow([L.v, 0], [L.v, ih], "accent", { width: 3 }).label("image", [L.v, ih], "accent", { anchor: "middle", dx: 0, dy: ih < 0 ? 16 : -6 });
        else {
          // virtual: trace the refracted rays back as dashed lines
          p.seg([0, L.h], [L.v, ih], "muted", { dash: true }).seg([0, 0], [L.v, ih], "muted", { dash: true });
          p.arrow([L.v, 0], [L.v, ih], "accent", { width: 3, dash: true }).label("virtual image", [L.v, ih], "accent", { anchor: "middle", dx: 0 });
        }
      }
      return [p];
    }
    const R = refraction(c, env);
    const p = new Plot([-1.2, 1.2], [-1.2, 1.2], { h: 380, equal: true });
    p.rect(-1.6, -1.6, 1.6, 0, "c3", 0.12).hline(0, "ink", false).vline(0, "muted", true);
    p.label(`n₁ = ${R.n1}`, [-1.15, 0.9], "ink", { size: 13 }).label(`n₂ = ${R.n2}`, [-1.15, -1], "ink", { size: 13 });
    const a = rad(R.a);
    const from: [number, number] = [-Math.sin(a) * 1.1, Math.cos(a) * 1.1];
    p.arrow(from, [0, 0], "c2", { width: 2.4 });
    // the reflected ray is always there; it carries everything past the critical angle
    p.arrow([0, 0], [Math.sin(a) * 1.1, Math.cos(a) * 1.1], R.tir ? "c2" : "muted", { width: R.tir ? 2.4 : 1.2 });
    if (!R.tir) p.arrow([0, 0], [Math.sin(rad(R.r)) * 1.1, -Math.cos(rad(R.r)) * 1.1], "accent", { width: 2.4 });
    p.label(`${R.a.toFixed(0)}°`, [-0.18, 0.5], "c2", { anchor: "middle" });
    if (!R.tir) p.label(`${R.r.toFixed(1)}°`, [0.2, -0.5], "accent", { anchor: "middle" });
    else p.label("total internal reflection", [0, -0.6], "warn", { anchor: "middle", dx: 0, size: 14 });
    return [p];
  },
};
