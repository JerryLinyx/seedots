// The rig contract and the generic gates every spec passes before it is shown.
// Facts come from code: the answer to a prediction is computed by running the rig, never taken from the model.

import { change, evaluate, names, parse, type Node } from "./expr.ts";
import { checkStage } from "./stages.ts";
import type { Plot } from "./plot.ts";
import type { Env, Observed, ParamDef, SceneSpecV2 } from "./spec.ts";

export interface Rig<C = any> {
  id: string;
  label: string;
  /** Config problems (shape, formulas) — empty when fine. */
  check(config: C, params: Set<string>): string[];
  /** Names of observables this config exposes, with the categories of the non-numeric ones. */
  observables(config: C): Observables;
  observe(config: C, env: Env): Observed;
  draw(config: C, env: Env, ctx: DrawCtx): Plot[];
  /** A drag on handle `id` to data point `p` → param updates. */
  drag?(config: C, env: Env, id: string, p: [number, number]): Env;
  /** Ranges for drawing that stay fixed across the param envs the spec reaches. */
  frame?(config: C, envs: Env[]): Frame;
}

export type Observables = { numeric: string[]; categories: Record<string, string[]> };
export type Frame = Record<string, [number, number]>;
/** `frame` stays fixed for the whole scene so the axes do not jump while the learner drags; `base` is the starting params. */
export type DrawCtx = { frame: Frame; base: Env; obs: Observed };

/* ------------------------------------------------------------------ formulas */
const cache = new Map<string, Node>();
export function expr(src: string): Node {
  let n = cache.get(src);
  if (!n) {
    n = parse(src);
    cache.set(src, n);
  }
  return n;
}
export const ev = (src: string, env: Env): number => evaluate(expr(src), env);

/** Problems with one formula: does it parse, and does it read only names it may read. */
export function checkExpr(src: unknown, allowed: Set<string>, where: string): string[] {
  if (typeof src !== "string" || !src.trim()) return [`${where}: missing formula`];
  let n: Node;
  try {
    n = expr(src);
  } catch (e) {
    return [`${where}: ${(e as Error).message} in "${src}"`];
  }
  const unknown = [...names(n)].filter((v) => !allowed.has(v));
  return unknown.length ? [`${where}: unknown name ${unknown.join(", ")} in "${src}"`] : [];
}

/* ------------------------------------------------------------------ params */
export function defaults(spec: SceneSpecV2): Env {
  return Object.fromEntries(spec.params.map((p) => [p.name, p.value]));
}
export function clampParam(p: ParamDef, v: number): number {
  if ((p.type ?? "range") !== "range") return v;
  const step = p.step ?? 0.01;
  const q = Math.round((v - (p.min ?? 0)) / step) * step + (p.min ?? 0);
  return Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, Number(q.toFixed(10))));
}
/** Values a param can take, for sweeps: ends, default and a few in between. */
function sweep(p: ParamDef): number[] {
  if (p.type === "toggle") return [0, 1];
  if (p.type === "seg") return (p.options ?? []).map(([v]) => v);
  const lo = p.min ?? 0;
  const hi = p.max ?? 1;
  return [lo, (lo + hi) / 2, hi, p.value, lo + (hi - lo) * 0.25, lo + (hi - lo) * 0.75];
}

/** Env with the rig's numeric observables merged in, for readouts and tasks. */
export function withObs(env: Env, obs: Observed): Env {
  const out = { ...env };
  for (const [k, v] of Object.entries(obs)) if (typeof v === "number") out[k] = v;
  return out;
}

export function readout(value: string, env: Env, obs: Observed): number | string {
  if (value in obs) return obs[value];
  try {
    return ev(value, withObs(env, obs));
  } catch {
    return NaN;
  }
}

export function taskDone(t: NonNullable<SceneSpecV2["tasks"]>[number], env: Env, obs: Observed): boolean {
  const v = readout(t.check.of, env, obs);
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (t.check.op === "<") return v < t.check.value;
  if (t.check.op === ">") return v > t.check.value;
  return Math.abs(v - t.check.value) <= (t.check.tol ?? 0.05 * Math.max(1, Math.abs(t.check.value)));
}

/* ------------------------------------------------------------------ prediction */
export const CHANGE = ["goes up", "goes down", "stays about the same"];

export function predictOptions(rig: Rig, spec: SceneSpecV2): string[] {
  if (spec.predict.kind === "change") return CHANGE;
  return rig.observables(spec.config).categories[spec.predict.observe] ?? [];
}

/** The true outcome, by running the rig at the defaults and at the predicted change. */
export function answer(rig: Rig, spec: SceneSpecV2): string {
  const base = defaults(spec);
  const after = { ...base, ...spec.predict.set };
  const b = rig.observe(spec.config, base)[spec.predict.observe];
  const a = rig.observe(spec.config, after)[spec.predict.observe];
  return spec.predict.kind === "change" ? change(Number(b), Number(a)) : String(a);
}

/* ------------------------------------------------------------------ gates */
export type GateReport = { ok: boolean; problems: string[]; answer?: string; observables: number };

export function gate(rig: Rig | undefined, spec: SceneSpecV2): GateReport {
  const problems: string[] = [];
  if (!rig) return { ok: false, problems: [`unknown rig "${spec.rig}"`], observables: 0 };
  const pnames = new Set(spec.params.map((p) => p.name));

  for (const p of spec.params) {
    const t = p.type ?? "range";
    if (t === "range" && !((p.min ?? 0) < (p.max ?? 0) && (p.step ?? 0) > 0)) problems.push(`param ${p.name}: bad range`);
    if (t === "range" && (p.value < (p.min ?? -Infinity) || p.value > (p.max ?? Infinity))) problems.push(`param ${p.name}: default out of range`);
    if (t === "seg" && !(p.options ?? []).some(([v]) => v === p.value)) problems.push(`param ${p.name}: default is not an option`);
  }
  for (const c of spec.controls ?? []) if (!pnames.has(c)) problems.push(`control ${c}: no such param`);
  problems.push(...rig.check(spec.config, pnames));
  problems.push(...checkStage(spec));
  if (problems.length) return { ok: false, problems, observables: 0 };

  const { numeric, categories } = rig.observables(spec.config);
  const known = new Set([...numeric, ...Object.keys(categories)]);
  const readable = new Set([...pnames, ...numeric]);

  for (const r of spec.readouts ?? []) if (!known.has(r.value)) problems.push(...checkExpr(r.value, readable, `readout "${r.label}"`));
  for (const t of spec.tasks ?? []) if (!known.has(t.check.of)) problems.push(...checkExpr(t.check.of, readable, `task "${t.text}"`));
  if (spec.record) {
    problems.push(...checkExpr(spec.record.x, readable, "record x"));
    problems.push(...checkExpr(spec.record.y, readable, "record y"));
  }
  if (spec.play && !pnames.has(spec.play.param)) problems.push(`play: no such param ${spec.play.param}`);

  const pr = spec.predict;
  if (!known.has(pr.observe)) problems.push(`predict: unknown observable ${pr.observe}`);
  if (pr.kind === "change" && !numeric.includes(pr.observe)) problems.push(`predict: ${pr.observe} is not numeric`);
  if (pr.kind === "category" && !categories[pr.observe]) problems.push(`predict: ${pr.observe} has no categories`);
  for (const [k, v] of Object.entries(pr.set)) {
    const p = spec.params.find((x) => x.name === k);
    if (!p) problems.push(`predict: no such param ${k}`);
    else if (clampParam(p, v) !== v) problems.push(`predict: ${k} = ${v} is not a reachable value`);
  }
  if (problems.length) return { ok: false, problems, observables: known.size };

  // every param at its ends and middle: the rig must give finite numbers (one param moved at a time)
  const base = defaults(spec);
  for (const p of spec.params)
    for (const v of sweep(p)) {
      const obs = rig.observe(spec.config, { ...base, [p.name]: v });
      const bad = numeric.filter((k) => typeof obs[k] !== "number" || Number.isNaN(obs[k] as number));
      if (bad.length) problems.push(`${p.name} = ${v}: ${bad.join(", ")} not a number`);
    }

  const truth = answer(rig, spec);
  const opts = predictOptions(rig, spec);
  if (!opts.includes(truth)) problems.push(`predict: outcome "${truth}" is not one of the options`);
  if (pr.kind === "change" && truth === "stays about the same") problems.push("predict: the change makes no visible difference");

  // tasks must start undone and be reachable somewhere in the param space
  for (const t of spec.tasks ?? []) {
    if (taskDone(t, base, rig.observe(spec.config, base))) problems.push(`task "${t.text}": already done at the defaults`);
    else if (!reachable(rig, spec, t)) problems.push(`task "${t.text}": not reachable with the controls`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 8), answer: truth, observables: known.size };
}

function reachable(rig: Rig, spec: SceneSpecV2, t: NonNullable<SceneSpecV2["tasks"]>[number]): boolean {
  const ctl = spec.params; // drags can set params that have no control, so search them all
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 300; i++) {
    const env = defaults(spec);
    for (const p of ctl) {
      const vals = sweep(p);
      env[p.name] = i < vals.length ? vals[i] : (p.type ?? "range") === "range" ? (p.min ?? 0) + rnd() * ((p.max ?? 1) - (p.min ?? 0)) : vals[Math.floor(rnd() * vals.length)];
    }
    if (taskDone(t, env, rig.observe(spec.config, env))) return true;
  }
  return false;
}
