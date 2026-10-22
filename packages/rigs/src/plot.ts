// A small 2D plotting surface. Rigs call high-level primitives in data coordinates; the result is a
// display list that <PlotSvg> renders. Handles are draggable points: the host maps a drag back to data
// coordinates and asks the rig which params to change.

export type Tone = "c0" | "c1" | "c2" | "c3" | "ink" | "muted" | "accent" | "warn";

export type Item =
  | { k: "path"; d: string; tone: Tone; width?: number; dash?: boolean; fill?: boolean; opacity?: number }
  | { k: "dot"; x: number; y: number; r: number; tone: Tone; hollow?: boolean }
  | { k: "rect"; x: number; y: number; w: number; h: number; tone: Tone; opacity?: number }
  | { k: "text"; x: number; y: number; text: string; tone: Tone; anchor?: "start" | "middle" | "end"; size?: number }
  | { k: "arrow"; x1: number; y1: number; x2: number; y2: number; tone: Tone; width?: number; dash?: boolean }
  | { k: "handle"; id: string; x: number; y: number; tone: Tone };

export type Range = [number, number];
const M = { l: 46, r: 16, t: 16, b: 36 };

export class Plot {
  readonly items: Item[] = [];
  readonly w: number;
  readonly h: number;
  x: Range;
  y: Range;

  constructor(x: Range, y: Range, opts: { w?: number; h?: number; equal?: boolean } = {}) {
    this.w = opts.w ?? 640;
    this.h = opts.h ?? 400;
    this.x = x;
    this.y = y;
    if (opts.equal) {
      // same scale on both axes: widen whichever range is short
      const pw = this.w - M.l - M.r;
      const ph = this.h - M.t - M.b;
      const ux = (x[1] - x[0]) / pw;
      const uy = (y[1] - y[0]) / ph;
      if (ux > uy) {
        const c = (y[0] + y[1]) / 2;
        this.y = [c - (ux * ph) / 2, c + (ux * ph) / 2];
      } else {
        const c = (x[0] + x[1]) / 2;
        this.x = [c - (uy * pw) / 2, c + (uy * pw) / 2];
      }
    }
  }

  sx = (x: number) => M.l + ((x - this.x[0]) / (this.x[1] - this.x[0])) * (this.w - M.l - M.r);
  sy = (y: number) => this.h - M.b - ((y - this.y[0]) / (this.y[1] - this.y[0])) * (this.h - M.t - M.b);
  /** Screen (viewBox) to data coordinates, for drags. */
  inv = (px: number, py: number): [number, number] => [
    this.x[0] + ((px - M.l) / (this.w - M.l - M.r)) * (this.x[1] - this.x[0]),
    this.y[0] + ((this.h - M.b - py) / (this.h - M.t - M.b)) * (this.y[1] - this.y[0]),
  ];
  private clampY = (y: number) => {
    const pad = (this.y[1] - this.y[0]) * 0.08;
    return Math.max(this.y[0] - pad, Math.min(this.y[1] + pad, y));
  };

  axes(xLabel = "", yLabel = "", o: { xTicks?: boolean } = {}) {
    for (const v of ticks(this.y[0], this.y[1], 5)) {
      this.items.push({ k: "path", d: `M${M.l} ${this.sy(v)}H${this.w - M.r}`, tone: v === 0 ? "muted" : "ink", width: v === 0 ? 1.2 : 1, opacity: v === 0 ? 0.7 : 0.12 });
      this.items.push({ k: "text", x: M.l - 8, y: this.sy(v) + 4, text: num(v), tone: "muted", anchor: "end", size: 11 });
    }
    for (const v of o.xTicks === false ? [] : ticks(this.x[0], this.x[1], 6)) {
      this.items.push({ k: "path", d: `M${this.sx(v)} ${M.t}V${this.h - M.b}`, tone: v === 0 ? "muted" : "ink", width: v === 0 ? 1.2 : 1, opacity: v === 0 ? 0.7 : 0.12 });
      this.items.push({ k: "text", x: this.sx(v), y: this.h - M.b + 18, text: num(v), tone: "muted", anchor: "middle", size: 11 });
    }
    if (xLabel) this.items.push({ k: "text", x: this.w - M.r, y: this.h - 4, text: xLabel, tone: "ink", anchor: "end", size: 12 });
    if (yLabel) this.items.push({ k: "text", x: M.l, y: M.t - 4, text: yLabel, tone: "ink", size: 12 });
    return this;
  }

  /** y = f(x) across the visible x range; breaks where f is not finite. */
  fn(f: (x: number) => number, tone: Tone = "c0", o: { width?: number; dash?: boolean; opacity?: number; from?: number; to?: number } = {}) {
    const a = o.from ?? this.x[0];
    const b = o.to ?? this.x[1];
    const pts: [number, number][] = [];
    for (let i = 0; i <= 240; i++) {
      const x = a + ((b - a) * i) / 240;
      pts.push([x, f(x)]);
    }
    return this.path(pts, tone, o);
  }

  path(pts: [number, number][], tone: Tone = "c0", o: { width?: number; dash?: boolean; fill?: boolean; opacity?: number } = {}) {
    let d = "";
    let pen = false;
    for (const [x, y] of pts) {
      if (!Number.isFinite(y) || !Number.isFinite(x)) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${this.sx(x).toFixed(1)} ${this.sy(this.clampY(y)).toFixed(1)}`;
      pen = true;
    }
    if (o.fill && d) d += "Z";
    if (d) this.items.push({ k: "path", d, tone, width: o.width, dash: o.dash, fill: o.fill, opacity: o.opacity });
    return this;
  }

  seg(a: [number, number], b: [number, number], tone: Tone = "muted", o: { width?: number; dash?: boolean; opacity?: number } = {}) {
    return this.path([a, b], tone, o);
  }
  vline(x: number, tone: Tone = "muted", dash = true) {
    return this.seg([x, this.y[0]], [x, this.y[1]], tone, { dash });
  }
  hline(y: number, tone: Tone = "muted", dash = true) {
    return this.seg([this.x[0], y], [this.x[1], y], tone, { dash });
  }
  dot(p: [number, number], tone: Tone = "c0", r = 5, hollow = false) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) this.items.push({ k: "dot", x: this.sx(p[0]), y: this.sy(this.clampY(p[1])), r, tone, hollow });
    return this;
  }
  rect(x0: number, y0: number, x1: number, y1: number, tone: Tone = "c0", opacity = 0.25) {
    const [a, b] = [this.sx(Math.min(x0, x1)), this.sx(Math.max(x0, x1))];
    const [c, d] = [this.sy(this.clampY(Math.max(y0, y1))), this.sy(this.clampY(Math.min(y0, y1)))];
    if ([a, b, c, d].every(Number.isFinite)) this.items.push({ k: "rect", x: a, y: c, w: b - a, h: d - c, tone, opacity });
    return this;
  }
  arrow(a: [number, number], b: [number, number], tone: Tone = "c0", o: { width?: number; dash?: boolean } = {}) {
    this.items.push({ k: "arrow", x1: this.sx(a[0]), y1: this.sy(a[1]), x2: this.sx(b[0]), y2: this.sy(b[1]), tone, ...o });
    return this;
  }
  label(text: string, p: [number, number], tone: Tone = "ink", o: { dx?: number; dy?: number; anchor?: "start" | "middle" | "end"; size?: number } = {}) {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1]))
      this.items.push({ k: "text", x: this.sx(p[0]) + (o.dx ?? 6), y: this.sy(this.clampY(p[1])) + (o.dy ?? -6), text, tone, anchor: o.anchor, size: o.size });
    return this;
  }
  handle(id: string, p: [number, number], tone: Tone = "accent") {
    if (Number.isFinite(p[0]) && Number.isFinite(p[1])) this.items.push({ k: "handle", id, x: this.sx(p[0]), y: this.sy(this.clampY(p[1])), tone });
    return this;
  }
}

export function ticks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
  return out;
}

export function num(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a < 1e-9) return "0";
  if (a >= 10000 || (a > 0 && a < 0.001)) return v.toExponential(1);
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return (Object.is(r, -0) ? 0 : r).toString();
}

/** A y range that keeps the given values in frame (trims extreme outliers). */
export function fitRange(values: number[], pad = 0.08): Range {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [-1, 1];
  const lo = v[Math.floor(v.length * 0.01)];
  const hi = v[Math.ceil(v.length * 0.99) - 1];
  const span = hi - lo || Math.max(1, Math.abs(hi));
  return [lo - span * pad, hi + span * pad];
}
