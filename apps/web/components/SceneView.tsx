"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fmt, mediaUrl } from "@/lib/api";
import { behaviour, change, evaluate, iterate, parse } from "@/lib/expr";
import type { FunctionPlotSpec, IterationSpec, L2Spec, Scene, SceneParam } from "@/lib/types";

type Emit = (type: string, payload: Record<string, unknown>) => void;
type Phase = "predict" | "try" | "seen";

const W = 640;
const H = 360;
const M = { l: 48, r: 18, t: 18, b: 40 };

/* ------------------------------------------------------------------ plotting helpers */
function niceTicks(lo: number, hi: number, n = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
  return out;
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "∞";
  const a = Math.abs(v);
  return a >= 1000 || (a > 0 && a < 0.01) ? v.toExponential(1) : String(Math.round(v * 100) / 100);
}

function Axes({ xr, yr, xLabel, yLabel }: { xr: [number, number]; yr: [number, number]; xLabel: string; yLabel: string }) {
  const sx = (x: number) => M.l + ((x - xr[0]) / (xr[1] - xr[0])) * (W - M.l - M.r);
  const sy = (y: number) => H - M.b - ((y - yr[0]) / (yr[1] - yr[0])) * (H - M.t - M.b);
  return (
    <g className="axes">
      {niceTicks(yr[0], yr[1]).map((v) => (
        <g key={`y${v}`}>
          <line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} className={v === 0 ? "zero" : "grid"} />
          <text x={M.l - 8} y={sy(v) + 4} textAnchor="end">{fmtNum(v)}</text>
        </g>
      ))}
      {niceTicks(xr[0], xr[1], 6).map((v) => (
        <g key={`x${v}`}>
          <line x1={sx(v)} x2={sx(v)} y1={M.t} y2={H - M.b} className={v === 0 ? "zero" : "grid"} />
          <text x={sx(v)} y={H - M.b + 18} textAnchor="middle">{fmtNum(v)}</text>
        </g>
      ))}
      {xLabel && <text className="label" x={W - M.r} y={H - 6} textAnchor="end">{xLabel}</text>}
      {yLabel && <text className="label" x={M.l} y={M.t - 6}>{yLabel}</text>}
    </g>
  );
}

function scaler(xr: [number, number], yr: [number, number]) {
  const sx = (x: number) => M.l + ((x - xr[0]) / (xr[1] - xr[0])) * (W - M.l - M.r);
  const sy = (y: number) => H - M.b - ((Math.max(yr[0] - (yr[1] - yr[0]) * 0.08, Math.min(yr[1] + (yr[1] - yr[0]) * 0.08, y)) - yr[0]) / (yr[1] - yr[0])) * (H - M.t - M.b);
  return { sx, sy };
}

function range(values: number[], pad = 0.08): [number, number] {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [-1, 1];
  const lo = v[Math.floor(v.length * 0.02)];
  const hi = v[Math.ceil(v.length * 0.98) - 1];
  const span = hi - lo || Math.max(1, Math.abs(hi));
  return [lo - span * pad, hi + span * pad];
}

function path(points: [number, number][]): string {
  let d = "";
  let pen = false;
  for (const [x, y] of points) {
    if (!Number.isFinite(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/* ------------------------------------------------------------------ L1: function plot */
function FunctionPlot({ spec, values }: { spec: FunctionPlotSpec; values: Record<string, number> }) {
  const nodes = useMemo(() => spec.curves.map((c) => parse(c.expr)), [spec]);
  const xs = useMemo(() => Array.from({ length: 201 }, (_, i) => spec.x.min + ((spec.x.max - spec.x.min) * i) / 200), [spec]);
  // fixed y range: the default state and the predicted state both stay in frame
  const yr = useMemo(() => {
    const envs = [Object.fromEntries(spec.params.map((p) => [p.name, p.value]))];
    envs.push({ ...envs[0], [spec.predict.param]: spec.predict.to });
    return range(envs.flatMap((env) => nodes.flatMap((n) => xs.map((x) => evaluate(n, { ...env, x })))));
  }, [spec, nodes, xs]);
  const { sx, sy } = scaler([spec.x.min, spec.x.max], yr);
  const ox = spec.predict.observe?.x;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title}>
      <Axes xr={[spec.x.min, spec.x.max]} yr={yr} xLabel={spec.x.label} yLabel={spec.y_label} />
      {nodes.map((n, i) => (
        <path key={i} className={`curve c${i}`} d={path(xs.map((x) => [sx(x), sy(evaluate(n, { ...values, x }))]))} />
      ))}
      {ox != null && (
        <g className="probe">
          <line x1={sx(ox)} x2={sx(ox)} y1={M.t} y2={H - M.b} />
          <circle cx={sx(ox)} cy={sy(evaluate(nodes[spec.predict.observe?.curve ?? 0], { ...values, x: ox }))} r={6} />
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ L1: iteration */
function Iteration({ spec, values }: { spec: IterationSpec; values: Record<string, number> }) {
  const update = useMemo(() => parse(spec.update), [spec]);
  const obj = useMemo(() => (spec.objective ? parse(spec.objective) : null), [spec]);
  const xsTrace = iterate(update, spec.start, spec.steps, values);
  const grid = useMemo(() => Array.from({ length: 201 }, (_, i) => spec.x.min + ((spec.x.max - spec.x.min) * i) / 200), [spec]);
  const key = JSON.stringify(values);
  if (obj) {
    const env0 = Object.fromEntries(spec.params.map((p) => [p.name, p.value]));
    const yr = range(grid.map((x) => evaluate(obj, { ...env0, x })), 0.06);
    const { sx, sy } = scaler([spec.x.min, spec.x.max], yr);
    // draw steps while they stay on the chart; say so when they leave it
    const pts: [number, number][] = [];
    let left: number | null = null;
    for (let i = 0; i < xsTrace.length; i++) {
      const x = xsTrace[i];
      const y = Number.isFinite(x) ? evaluate(obj, { ...values, x }) : NaN;
      const span = yr[1] - yr[0];
      if (!Number.isFinite(y) || x < spec.x.min || x > spec.x.max || y > yr[1] + span * 0.08) {
        left = i;
        break;
      }
      pts.push([sx(x), sy(y)]);
    }
    return (
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title}>
        <Axes xr={[spec.x.min, spec.x.max]} yr={yr} xLabel={spec.x.label} yLabel="" />
        <path className="curve c1" d={path(grid.map((x) => [sx(x), sy(evaluate(obj, { ...values, x }))]))} />
        <g key={key} className="trace">
          <path className="steps" d={path(pts)} />
          {pts.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={i === 0 ? 6 : 4.5} className={i === 0 ? "start" : ""}
              style={{ animationDelay: `${Math.min(i, 40) * 22}ms` }} />
          ))}
          {left != null && pts.length > 0 && (
            <text className="escape" x={pts[pts.length - 1][0]} y={M.t + 4} textAnchor="middle"
              style={{ animationDelay: `${Math.min(pts.length, 40) * 22}ms` }}>
              off the chart at step {left}
            </text>
          )}
        </g>
      </svg>
    );
  }
  const yr = range(xsTrace);
  const { sx, sy } = scaler([0, spec.steps], yr);
  const pts = xsTrace.map((v, i) => [sx(i), sy(v)] as [number, number]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title}>
      <Axes xr={[0, spec.steps]} yr={yr} xLabel="step" yLabel={spec.state_label} />
      <g key={key} className="trace">
        <path className="steps" d={path(pts)} />
        {pts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={3.5} style={{ animationDelay: `${Math.min(i, 40) * 18}ms` }} />
        ))}
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ L2: generated code in a sandbox */
function CodeScene({
  spec,
  sceneId,
  values,
  onReady,
  onObserve,
  onAck,
  onError,
}: {
  spec: L2Spec;
  sceneId: string;
  values: Record<string, number>;
  onReady: () => void;
  onObserve: (name: string, value: number | string) => void;
  onAck: (name: string, value: number) => void;
  onError: (msg: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const dark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== frame.current?.contentWindow || !e.data?.__seedots) return;
      const m = e.data;
      if (m.type === "ready") {
        ready.current = true;
        onReady();
      } else if (m.type === "observe") onObserve(m.name, m.value);
      else if (m.type === "ack") onAck(m.name, Number(m.value));
      else if (m.type === "error") onError(String(m.message));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onReady, onObserve, onAck, onError]);

  useEffect(() => {
    if (!ready.current) return;
    for (const [name, value] of Object.entries(values)) {
      frame.current?.contentWindow?.postMessage({ __seedots: 1, type: "set_param", name, value }, "*");
    }
  }, [values]);

  return (
    <iframe
      ref={frame}
      title={spec.title}
      className="lab-frame"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={`${mediaUrl(`/api/scenes/${sceneId}/runner`)}${dark ? "#theme=dark" : ""}`}
    />
  );
}

/* ------------------------------------------------------------------ the experiment loop */
function Slider({ p, value, disabled, target, onChange, onCommit }: {
  p: SceneParam;
  value: number;
  disabled: boolean;
  target?: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const pct = (v: number) => `${((v - p.min) / (p.max - p.min)) * 100}%`;
  return (
    <label className={`slider${disabled ? " locked" : ""}`}>
      <span className="slider-top">
        <span>{p.label || p.name}</span>
        <output>{fmtNum(value)}</output>
      </span>
      <span className="slider-track" style={{ ["--fill" as string]: pct(value) }}>
        {target != null && <i className="slider-target" style={{ left: pct(target) }} title={`Try ${fmtNum(target)}`} />}
        <input
          type="range"
          min={p.min}
          max={p.max}
          step={p.step}
          value={value}
          aria-disabled={disabled}
          onChange={(e) => !disabled && onChange(Number(e.target.value))}
          onPointerUp={(e) => !disabled && onCommit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => !disabled && onCommit(Number((e.target as HTMLInputElement).value))}
        />
      </span>
    </label>
  );
}

export function SceneLab({ scene, onEvent, onAsk, onSeek }: { scene: Scene; onEvent: Emit; onAsk: (q: string) => void; onSeek: (t: number) => void }) {
  const spec = scene.spec!;
  const pred = spec.predict;
  const defaults = useMemo(() => Object.fromEntries(spec.params.map((p) => [p.name, p.value])), [spec]);
  const [values, setValues] = useState<Record<string, number>>(defaults);
  const [phase, setPhase] = useState<Phase>("predict");
  const [guess, setGuess] = useState<string | null>(null);
  const [explanation, setExplanation] = useState("");
  const [l2, setL2] = useState<{
    ready: boolean;
    obs: Record<string, number | string>;
    acked: Record<string, number>; // last value each control was confirmed at by the scene
    baseline?: number | string;
    error?: string;
  }>({ ready: false, obs: {}, acked: {} });
  const target = spec.params.find((p) => p.name === pred.param)!;
  const atTarget = Math.abs(values[pred.param] - pred.to) <= target.step / 2 + 1e-9;

  useEffect(() => {
    onEvent("scene.open", { scene_id: scene.id, level: scene.level });
  }, [scene.id, scene.level, onEvent]);

  // the result, computed exactly like the server computed the answer
  const outcome = useMemo((): string | null => {
    if (!atTarget) return null;
    if (scene.level === "l2") {
      // only trust an observation the scene made after it applied the target value
      if (Math.abs((l2.acked[pred.param] ?? NaN) - pred.to) > target.step / 2 + 1e-9) return null;
      const after = l2.obs[pred.observation!];
      if (after === undefined || l2.baseline === undefined) return null;
      return typeof after === "string" ? after : change(Number(l2.baseline), Number(after));
    }
    const s = spec as FunctionPlotSpec | IterationSpec;
    const obs = (env: Record<string, number>): number | string => {
      if (s.component === "function_plot") {
        const n = parse(s.curves[Math.min(pred.observe?.curve ?? 0, s.curves.length - 1)].expr);
        return evaluate(n, { ...env, x: pred.observe?.x ?? 0 });
      }
      const xs = iterate(parse(s.update), s.start, s.steps, env);
      return pred.observe?.kind === "behaviour" ? behaviour(xs) : xs[xs.length - 1];
    };
    const after = obs({ ...defaults, [pred.param]: pred.to });
    return pred.observe?.kind === "behaviour" ? String(after) : change(Number(obs(defaults)), Number(after));
  }, [atTarget, scene.level, l2, pred, spec, defaults, target]);

  useEffect(() => {
    if (phase === "try" && outcome) {
      setPhase("seen");
      onEvent("scene.observe", { scene_id: scene.id, result: outcome, predicted: guess, matched: outcome === guess });
    }
  }, [phase, outcome, guess, scene.id, onEvent]);

  const onReady = useCallback(() => setL2((s) => ({ ...s, ready: true })), []);
  const onObserve = useCallback(
    (name: string, value: number | string) =>
      setL2((s) => {
        const obs = { ...s.obs, [name]: value };
        // the baseline is whatever the scene reported at its defaults
        const baseline = s.baseline === undefined && name === pred.observation ? value : s.baseline;
        return { ...s, obs, baseline };
      }),
    [pred.observation],
  );
  const onAck = useCallback((name: string, value: number) => setL2((s) => ({ ...s, acked: { ...s.acked, [name]: value } })), []);
  const onError = useCallback((msg: string) => setL2((s) => ({ ...s, error: msg })), []);

  function predict(option: string) {
    setGuess(option);
    setPhase("try");
    onEvent("scene.predict", { scene_id: scene.id, choice: option });
  }
  function set(name: string, v: number, commit = false) {
    setValues((vs) => ({ ...vs, [name]: v }));
    if (commit) onEvent("scene.set_param", { scene_id: scene.id, name, value: v });
  }
  function reset() {
    setValues(defaults);
    setPhase("predict");
    setGuess(null);
    setExplanation("");
    setL2((s) => ({ ...s, obs: {}, acked: {}, baseline: undefined }));
  }
  function explain(e: FormEvent) {
    e.preventDefault();
    const label = target.label || target.name;
    onEvent("scene.explain", { scene_id: scene.id, length: explanation.length });
    onAsk(`In the "${spec.title}" interactive I predicted it ${guess}. When I set ${label} to ${fmtNum(pred.to)} it ${outcome}. ` +
      `My explanation: ${explanation.trim() || "(I'm not sure why.)"} Is my reasoning right?`);
  }

  const L1 = scene.level === "l1" ? (spec as FunctionPlotSpec | IterationSpec) : null;
  const firstEvidence = scene.evidence.find((e) => e.t0 != null);

  return (
    <article className="lab" aria-labelledby={`lab-${scene.id}`}>
      <header className="lab-head">
        <div>
          <h3 id={`lab-${scene.id}`}>{spec.title}</h3>
          <p>{spec.prompt}</p>
        </div>
        {firstEvidence && (
          <button className="time-chip" onClick={() => onSeek(firstEvidence.t0!)} title="Where the video explains this">
            {fmt(firstEvidence.t0)}
          </button>
        )}
      </header>
      <div className="lab-body">
        <div className="lab-plot">
          {L1?.component === "function_plot" && <FunctionPlot spec={L1 as FunctionPlotSpec} values={values} />}
          {L1?.component === "iteration" && <Iteration spec={L1 as IterationSpec} values={values} />}
          {scene.level === "l2" && (
            <CodeScene spec={spec as L2Spec} sceneId={scene.id} values={values} onReady={onReady} onObserve={onObserve} onAck={onAck} onError={onError} />
          )}
          {scene.level === "l2" && l2.error && <p className="notice lab-error">The interactive hit a problem: {l2.error}</p>}
        </div>

        <ol className="lab-steps">
          <li className={phase === "predict" ? "on" : "done"}>
            <span className="lab-step-name">Predict</span>
            <p className="lab-q">{pred.question}</p>
            <div className="lab-options" role="group" aria-label="Your prediction">
              {pred.options.map((o) => (
                <button key={o} className="choice" aria-pressed={guess === o} disabled={phase !== "predict"} onClick={() => predict(o)}>
                  <span className="bullet" />
                  <span>{o}</span>
                </button>
              ))}
            </div>
          </li>
          <li className={phase === "try" ? "on" : phase === "seen" ? "done" : ""}>
            <span className="lab-step-name">Try it</span>
            <div className="sliders">
              {spec.params.map((p) => (
                <Slider key={p.name} p={p} value={values[p.name]} disabled={phase === "predict"}
                  target={phase === "try" && p.name === pred.param ? pred.to : undefined}
                  onChange={(v) => set(p.name, v)} onCommit={(v) => set(p.name, v, true)} />
              ))}
            </div>
            {phase === "try" && (
              <button className="btn btn-quiet lab-jump" onClick={() => set(pred.param, pred.to, true)}>
                Set {target.label || target.name} to {fmtNum(pred.to)}
              </button>
            )}
          </li>
          <li className={phase === "seen" ? "on" : ""}>
            <span className="lab-step-name">See and explain</span>
            {phase === "seen" && outcome && (
              <>
                <p className={`lab-result ${outcome === guess ? "match" : "miss"}`} role="status">
                  {outcome === guess ? "As you predicted, it " : `You expected it ${guess}; it actually `}
                  <strong>{outcome}</strong>.
                </p>
                <form className="lab-explain" onSubmit={explain}>
                  <label htmlFor={`why-${scene.id}`}>Why does that happen, in your own words?</label>
                  <textarea id={`why-${scene.id}`} className="field" rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
                  <div>
                    <button className="btn btn-primary" type="submit">Check my reasoning</button>
                    <button className="btn btn-quiet" type="button" onClick={reset}>Start over</button>
                  </div>
                </form>
              </>
            )}
          </li>
        </ol>
      </div>
      {Object.keys(scene.checks).length > 0 && (
        <p className="lab-checks">
          {scene.level === "l2" ? "Built for this chapter and" : "Built from this chapter and"} checked before showing:{" "}
          {Object.entries(scene.checks).map(([k, v], i, a) => (
            <span key={k}>{k}{v !== "passed" ? ` (${v})` : ""}{i < a.length - 1 ? ", " : "."}</span>
          ))}
        </p>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ requesting an L2 scene */
const STAGES: [string, string][] = [
  ["queued", "Queued"],
  ["drafting", "Writing"],
  ["checking", "Testing in the sandbox"],
  ["verifying", "Final check"],
  ["reviewing", "Screenshot review"],
  ["ready", "Ready"],
];

function Progress({ scene }: { scene: Scene }) {
  const reached = new Set(scene.progress.log.map((l) => l.stage));
  const last = scene.progress.log[scene.progress.log.length - 1];
  const attempts = Math.max(0, ...scene.progress.log.map((l) => l.attempt ?? 0));
  return (
    <div className="lab-progress" role="status" aria-live="polite">
      <ol>
        {STAGES.map(([id, label]) => (
          <li key={id} className={scene.progress.stage === id ? "now" : reached.has(id) ? "done" : ""}>
            <i aria-hidden="true" />
            {label}
            {id === "checking" && attempts > 1 ? `, draft ${attempts}` : ""}
          </li>
        ))}
      </ol>
      {last && <p>{scene.status === "failed" ? scene.error : last.note}</p>}
    </div>
  );
}

export function ScenePanel({
  mediaId,
  chapterId,
  chapterTitle,
  scenes,
  onEvent,
  onAsk,
  onSeek,
}: {
  mediaId: string;
  chapterId: string;
  chapterTitle: string;
  scenes: Scene[];
  onEvent: Emit;
  onAsk: (q: string) => void;
  onSeek: (t: number) => void;
}) {
  const [extra, setExtra] = useState<Scene[]>([]);
  const all = useMemo(() => {
    const byId = new Map<string, Scene>();
    for (const s of [...scenes, ...extra]) byId.set(s.id, s);
    return [...byId.values()].filter((s) => s.chapter_id === chapterId);
  }, [scenes, extra, chapterId]);
  const ready = all.filter((s) => s.status === "ready");
  const pending = all.filter((s) => s.level === "l2" && s.status !== "ready");
  const [active, setActive] = useState<string | null>(null);
  const shown = ready.find((s) => s.id === active) ?? ready[ready.length - 1];
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // follow generating scenes until they settle
  useEffect(() => {
    const live = pending.filter((s) => s.status === "queued" || s.status === "generating");
    if (!live.length) return;
    const h = setTimeout(async () => {
      const fresh = await Promise.all(live.map((s) => api.scene(s.id).catch(() => s)));
      setExtra((xs) => [...xs.filter((x) => !fresh.some((f) => f.id === x.id)), ...fresh]);
      const done = fresh.find((f) => f.status === "ready");
      if (done) setActive(done.id);
    }, 1200);
    return () => clearTimeout(h);
  }, [pending]);

  async function request(e: FormEvent) {
    e.preventDefault();
    setAsking(true);
    setError(null);
    try {
      const s = await api.requestScene(mediaId, chapterId, ask);
      setExtra((xs) => [...xs, s]);
      onEvent("scene.request", { scene_id: s.id, chapter_id: chapterId });
      setAsk("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start building the interactive.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <section className="lab-wrap" aria-label="Try it yourself">
      <div className="lab-title-row">
        <h2>Try it yourself</h2>
        {ready.length > 1 && (
          <div className="lab-switch" role="tablist" aria-label="Interactives for this chapter">
            {ready.map((s) => {
              const n = ready.filter((x) => x.level === "l2").indexOf(s);
              return (
                <button key={s.id} role="tab" aria-selected={shown?.id === s.id} onClick={() => setActive(s.id)}>
                  {s.level === "l2" ? (n > 0 ? `Built for you (${n + 1})` : "Built for you") : "Quick experiment"}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {shown ? (
        <SceneLab key={shown.id} scene={shown} onEvent={onEvent} onAsk={onAsk} onSeek={onSeek} />
      ) : (
        !pending.length && (
          <p className="lab-empty">
            No ready-made experiment for “{chapterTitle}”. Describe what you'd like to play with and SeeDots will build
            one, test it in a sandbox, and show it here.
          </p>
        )
      )}
      {pending.map((s) => (
        <Progress key={s.id} scene={s} />
      ))}
      <form className="lab-request" onSubmit={request}>
        <label htmlFor={`ask-${chapterId}`} className="sr-only">
          What would you like to experiment with?
        </label>
        <input
          id={`ask-${chapterId}`}
          className="field"
          placeholder={shown ? "Want a different angle? Describe it" : "e.g. let me change the step size and watch it converge"}
          value={ask}
          maxLength={500}
          onChange={(e) => setAsk(e.target.value)}
        />
        <button className="btn" type="submit" disabled={asking || pending.some((s) => s.status !== "failed")}>
          {asking ? "Starting…" : "Build an interactive"}
        </button>
      </form>
      {error && <p className="notice" role="alert" style={{ margin: 0 }}>{error}</p>}
    </section>
  );
}
