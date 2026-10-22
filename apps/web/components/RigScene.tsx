"use client";

import dynamic from "next/dynamic";
import { type FormEvent, type PointerEvent as RPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { num, Plot } from "@seedots/rigs/plot.ts";
import { answer, clampParam, defaults, predictOptions, readout, RIGS, taskDone, type Env, type ParamDef, type SceneSpecV2 } from "@seedots/rigs";

type Phase = "predict" | "try" | "seen";
// three.js only in the browser
const Stage3D = dynamic(() => import("./Stage3D"), { ssr: false, loading: () => <div className="stage3d loading" /> });
type Emit = (type: string, payload: Record<string, unknown>) => void;

/* ------------------------------------------------------------------ plot rendering */
// rounded so server and browser maths (which can differ in the last digit) render the same markup
const r2 = (v: number) => Math.round(v * 100) / 100;
const op = (v?: number) => (v == null ? undefined : Math.round(v * 1000) / 1000);
function PlotSvg({ plot, onDrag, locked }: { plot: Plot; onDrag: (id: string, p: [number, number]) => void; locked: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<string | null>(null);
  const local = (e: RPointerEvent): [number, number] => {
    const svg = ref.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [p.x, p.y];
  };
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${plot.w} ${plot.h}`}
      className="rig-plot"
      onPointerMove={(e) => drag.current && onDrag(drag.current, plot.inv(...local(e)))}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
    >
      <defs>
        {["c0", "c1", "c2", "c3", "accent", "muted", "ink", "warn"].map((t) => (
          <marker key={t} id={`ah-${t}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className={`t-${t} fill`} />
          </marker>
        ))}
      </defs>
      {plot.items.map((it, i) => {
        switch (it.k) {
          case "path":
            return <path key={i} d={it.d} className={`t-${it.tone} ${it.fill ? "fill" : "stroke"}`} strokeWidth={it.width ?? 2} strokeDasharray={it.dash ? "4 4" : undefined} opacity={op(it.opacity)} />;
          case "dot":
            return <circle key={i} cx={r2(it.x)} cy={r2(it.y)} r={it.r} className={`t-${it.tone} ${it.hollow ? "stroke" : "fill"} dot`} />;
          case "rect":
            return <rect key={i} x={r2(it.x)} y={r2(it.y)} width={r2(Math.max(0, it.w))} height={r2(Math.max(0, it.h))} className={`t-${it.tone} fill`} opacity={op(it.opacity)} />;
          case "text":
            return <text key={i} x={r2(it.x)} y={r2(it.y)} className={`t-${it.tone} label`} textAnchor={it.anchor ?? "start"} fontSize={it.size ?? 12}>{it.text}</text>;
          case "arrow":
            return <line key={i} x1={r2(it.x1)} y1={r2(it.y1)} x2={r2(it.x2)} y2={r2(it.y2)} className={`t-${it.tone} stroke`} strokeWidth={it.width ?? 2} strokeDasharray={it.dash ? "4 4" : undefined} markerEnd={`url(#ah-${it.tone})`} />;
          case "handle":
            return (
              <circle key={i} cx={r2(it.x)} cy={r2(it.y)} r={11} className={`rig-handle t-${it.tone}${locked ? " locked" : ""}`}
                onPointerDown={(e) => {
                  if (locked) return;
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  drag.current = it.id;
                }} />
            );
        }
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ controls */
function Control({ p, value, locked, target, onChange }: { p: ParamDef; value: number; locked: boolean; target?: number; onChange: (v: number) => void }) {
  const t = p.type ?? "range";
  if (t === "toggle")
    return (
      <label className={`rig-toggle${locked ? " locked" : ""}`}>
        <input type="checkbox" checked={value > 0} disabled={locked} onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
        <span>{p.label}</span>
      </label>
    );
  if (t === "seg")
    return (
      <div className={`rig-seg${locked ? " locked" : ""}`}>
        <span>{p.label}</span>
        <div role="group">
          {(p.options ?? []).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={v === value} disabled={locked} onClick={() => onChange(v)}>{l}</button>
          ))}
        </div>
      </div>
    );
  const pct = (v: number) => `${(((v - p.min!) / (p.max! - p.min!)) * 100).toFixed(1)}%`;
  return (
    <label className={`slider${locked ? " locked" : ""}`}>
      <span className="slider-top">
        <span>{p.label}</span>
        <output>{num(value)}{p.unit ? ` ${p.unit}` : ""}</output>
      </span>
      <span className="slider-track" style={{ ["--fill" as string]: pct(value) }}>
        {target != null && <i className="slider-target" style={{ left: pct(target) }} />}
        <input type="range" min={p.min} max={p.max} step={p.step} value={value} aria-disabled={locked} onChange={(e) => !locked && onChange(Number(e.target.value))} />
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ data dock: record points and fit a line */
function fit(rows: [number, number][]) {
  const n = rows.length;
  const mx = rows.reduce((a, r) => a + r[0], 0) / n;
  const my = rows.reduce((a, r) => a + r[1], 0) / n;
  const sxx = rows.reduce((a, r) => a + (r[0] - mx) ** 2, 0);
  const sxy = rows.reduce((a, r) => a + (r[0] - mx) * (r[1] - my), 0);
  const syy = rows.reduce((a, r) => a + (r[1] - my) ** 2, 0);
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : NaN };
}

function DataDock({ rec, rows, onRecord, onClear, locked }: { rec: NonNullable<SceneSpecV2["record"]>; rows: [number, number][]; onRecord: () => void; onClear: () => void; locked: boolean }) {
  const f = rows.length >= 2 ? fit(rows) : null;
  let plot: Plot | null = null;
  if (rows.length) {
    const xs = rows.map((r) => r[0]);
    const ys = rows.map((r) => r[1]);
    const pad = (a: number[]) => {
      const lo = Math.min(...a, 0);
      const hi = Math.max(...a, 0);
      const s = hi - lo || 1;
      return [lo - s * 0.1, hi + s * 0.1] as [number, number];
    };
    plot = new Plot(pad(xs), pad(ys), { w: 360, h: 220 }).axes(rec.x_label, rec.y_label);
    if (f) plot.fn((x) => f.intercept + f.slope * x, "c2", { width: 1.6, dash: true });
    rows.forEach((r) => plot!.dot(r, "accent", 4));
  }
  return (
    <div className="rig-dock">
      <div className="rig-dock-head">
        <b>Data</b>
        <button className="btn btn-quiet" type="button" disabled={locked} onClick={onRecord}>Record point</button>
        {rows.length > 0 && <button className="btn btn-quiet" type="button" onClick={onClear}>Clear</button>}
      </div>
      {plot && <PlotSvg plot={plot} onDrag={() => {}} locked />}
      {f && (
        <p className="rig-fit">
          Line through your points: slope <b>{num(f.slope, 3)}</b>, intercept <b>{num(f.intercept, 3)}</b>, R² {num(f.r2, 3)}
        </p>
      )}
      {!rows.length && <p className="rig-muted">Change the controls and record a few points to see the pattern.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ the scene */
export function RigScene({ spec, onEvent, onAsk, sceneId, preset, aside }: {
  spec: SceneSpecV2;
  onEvent?: Emit;
  onAsk?: (q: string) => void;
  sceneId?: string;
  /** Settings to apply once the learner has predicted (e.g. from a coach link "try it at tau = 2"). */
  preset?: Env;
  aside?: ReactNode;
}) {
  const rig = RIGS[spec.rig];
  const base = useMemo(() => defaults(spec), [spec]);
  const [values, setValues] = useState<Env>(base);
  const [phase, setPhase] = useState<Phase>("predict");
  const [guess, setGuess] = useState<string | null>(null);
  const [free, setFree] = useState(false);
  const [rows, setRows] = useState<[number, number][]>([]);
  const [why, setWhy] = useState("");
  const [playing, setPlaying] = useState(false);
  const emit = (t: string, p: Record<string, unknown> = {}) => onEvent?.(t, { scene_id: sceneId, rig: spec.rig, title: spec.title, ...p });
  useEffect(() => {
    emit("scene.open", { engine: "rig" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the frame covers the start, the predicted change and the play range, so axes never jump
  const frame = useMemo(() => {
    const envs = [base, { ...base, ...spec.predict.set }];
    if (spec.play) {
      const p = spec.params.find((x) => x.name === spec.play!.param)!;
      envs.push({ ...base, [p.name]: spec.play.to ?? p.max ?? p.value });
    }
    return rig.frame ? rig.frame(spec.config, envs) : {};
  }, [rig, spec, base]);
  const obs = useMemo(() => rig.observe(spec.config, values), [rig, spec, values]);
  const plots = useMemo(() => rig.draw(spec.config, values, { frame, base, obs }), [rig, spec, values, frame, base, obs]);
  const truth = useMemo(() => answer(rig, spec), [rig, spec]);
  const options = predictOptions(rig, spec);
  const locked = phase === "predict";

  const param = (n: string) => spec.params.find((p) => p.name === n)!;
  const atTarget = Object.entries(spec.predict.set).every(([k, v]) => Math.abs(values[k] - v) <= (param(k).step ?? 0.01) / 2 + 1e-9);
  useEffect(() => {
    if (phase === "try" && atTarget) {
      setPhase("seen");
      emit("scene.observe", { result: truth, predicted: guess, matched: truth === guess });
    }
  }, [phase, atTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  function set(upd: Env) {
    setValues((vs) => {
      const nx = { ...vs };
      for (const [k, v] of Object.entries(upd)) {
        const p = spec.params.find((x) => x.name === k);
        if (p && Number.isFinite(v)) nx[k] = clampParam(p, v);
      }
      return nx;
    });
  }

  // play: move one param from where it is to its end over a few seconds
  const raf = useRef<number | null>(null);
  function play() {
    if (!spec.play) return;
    const p = param(spec.play.param);
    const to = spec.play.to ?? p.max!;
    // from where it is; from the start again if it is already at the end
    const from = Math.abs(values[p.name] - to) < (p.step ?? 0.01) ? base[p.name] : values[p.name];
    const ms = (spec.play.seconds ?? 4) * 1000;
    const t0 = performance.now();
    setPlaying(true);
    emit("scene.play", { param: p.name });
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      set({ [p.name]: from + (to - from) * k });
      if (k < 1) raf.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    raf.current = requestAnimationFrame(tick);
  }
  useEffect(() => () => void (raf.current && cancelAnimationFrame(raf.current)), []);

  function reset() {
    setValues(base);
    setPhase("predict");
    setGuess(null);
    setFree(false);
    setRows([]);
    setWhy("");
  }
  function explain(e: FormEvent) {
    e.preventDefault();
    emit("scene.explain", { length: why.length });
    onAsk?.(`In "${spec.title}" I predicted it ${guess}; it ${truth}. My explanation: ${why.trim() || "(not sure)"} Is my reasoning right?`);
  }

  const shown = spec.params.filter((p) => free || !spec.controls || spec.controls.includes(p.name));
  const setLabel = Object.entries(spec.predict.set).map(([k, v]) => `${param(k).label} to ${num(v)}`).join(", ");

  return (
    <article className="lab rig">
      <header className="lab-head">
        <div>
          <h3>{spec.title}</h3>
          <p>{spec.prompt}</p>
        </div>
        <div className="rig-head-side">
          {aside}
          <span className="rig-tag">{rig.label}</span>
        </div>
      </header>
      <div className="lab-body">
        <div className="lab-plot">
          {spec.stage && <Stage3D spec={spec} values={values} obs={obs} locked={locked || playing} onSet={set} />}
          <div className={`rig-plots n${plots.length}${spec.stage ? " under3d" : ""}`}>
            {plots.map((p, i) => (
              <PlotSvg key={i} plot={p} locked={locked} onDrag={(id, pt) => rig.drag && set(rig.drag(spec.config, values, id, pt))} />
            ))}
          </div>
          {spec.readouts && (
            <dl className="rig-readouts">
              {spec.readouts.map((r) => {
                const v = readout(r.value, values, obs);
                return (
                  <div key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{typeof v === "number" ? num(v, r.digits ?? 2) : v}{r.unit ? ` ${r.unit}` : ""}</dd>
                  </div>
                );
              })}
            </dl>
          )}
          {spec.record && (
            <DataDock rec={spec.record} rows={rows} locked={locked}
              onRecord={() => {
                const x = readout(spec.record!.x, values, obs);
                const y = readout(spec.record!.y, values, obs);
                if (typeof x === "number" && typeof y === "number") setRows((r) => [...r, [x, y]]);
              }}
              onClear={() => setRows([])} />
          )}
        </div>

        <ol className="lab-steps">
          <li className={phase === "predict" ? "on" : "done"}>
            <span className="lab-step-name">Predict</span>
            <p className="lab-q">{spec.predict.question}</p>
            <div className="lab-options" role="group">
              {options.map((o) => (
                <button key={o} className="choice" aria-pressed={guess === o} disabled={phase !== "predict"}
                  onClick={() => {
                    setGuess(o);
                    setPhase("try");
                    emit("scene.predict", { choice: o });
                    if (preset) set(preset);
                  }}>
                  <span className="bullet" />
                  <span>{o}</span>
                </button>
              ))}
            </div>
          </li>
          <li className={phase === "try" ? "on" : phase === "seen" ? "done" : ""}>
            <span className="lab-step-name">Try it</span>
            {spec.steps && (
              <ol className="rig-guide">
                {spec.steps.map((s) => <li key={s}>{s}</li>)}
              </ol>
            )}
            <div className="sliders">
              {shown.map((p) => (
                <Control key={p.name} p={p} value={values[p.name]} locked={locked || playing}
                  target={phase === "try" && p.name in spec.predict.set ? spec.predict.set[p.name] : undefined}
                  onChange={(v) => {
                    set({ [p.name]: v });
                    emit("scene.set_param", { name: p.name, value: v });
                  }} />
              ))}
            </div>
            <div className="rig-actions">
              {spec.play && (
                <button className="btn btn-quiet" type="button" disabled={locked || playing} onClick={play}>
                  ▶ Play {param(spec.play.param).label}
                </button>
              )}
              {phase === "try" && <button className="btn btn-quiet" type="button" onClick={() => set(spec.predict.set)}>Set {setLabel}</button>}
            </div>
            {spec.tasks && (
              <ul className="rig-tasks">
                {spec.tasks.map((t) => {
                  const done = !locked && taskDone(t, values, obs);
                  return <li key={t.text} className={done ? "done" : ""}><i aria-hidden />{t.text}</li>;
                })}
              </ul>
            )}
          </li>
          <li className={phase === "seen" ? "on" : ""}>
            <span className="lab-step-name">See and explain</span>
            {phase === "seen" && (
              <>
                <p className={`lab-result ${truth === guess ? "match" : "miss"}`} role="status">
                  {truth === guess ? "As you predicted, it " : `You expected it ${guess}; it actually `}
                  <strong>{truth}</strong>.
                </p>
                <form className="lab-explain" onSubmit={explain}>
                  <label>Why does that happen, in your own words?</label>
                  <textarea className="field" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} />
                  <div>
                    <button className="btn btn-primary" type="submit" disabled={!onAsk}>Check my reasoning</button>
                    {!free && <button className="btn btn-quiet" type="button" onClick={() => setFree(true)}>Explore freely</button>}
                    <button className="btn btn-quiet" type="button" onClick={reset}>Start over</button>
                  </div>
                </form>
              </>
            )}
          </li>
        </ol>
      </div>
    </article>
  );
}
