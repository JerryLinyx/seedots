"use client";

import { useState } from "react";
import { api, ApiError, fmt } from "@/lib/api";
import type { AttemptResult, Item } from "@/lib/types";
import { Markdown } from "./Markdown";

type Props = {
  item: Item;
  decisionId?: string;
  onSeek: (t: number) => void;
  onAnswered?: (r: AttemptResult) => void;
};

const LEVEL = ["", "Recall", "Understand", "Apply"];

export function ItemView({ item, decisionId, onSeek, onAnswered }: Props) {
  const p = item.payload;
  const [pick, setPick] = useState<number | null>(null);
  const [picks, setPicks] = useState<number[]>([]);
  const [order, setOrder] = useState<number[]>([]);
  const [pairs, setPairs] = useState<number[]>(() => (p.left || []).map(() => -1));
  const [hints, setHints] = useState(0);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const multi = item.type === "multi_choice";
  const choice = ["single_choice", "find_error", "predict", "multi_choice"].includes(item.type);
  const ready =
    (choice && !multi && pick !== null) ||
    (multi && picks.length > 0) ||
    (item.type === "ordering" && order.length === (p.items || []).length) ||
    (item.type === "matching" && pairs.every((x) => x >= 0));

  async function submit() {
    const response =
      item.type === "multi_choice"
        ? { indices: picks }
        : item.type === "ordering"
          ? { order }
          : item.type === "matching"
            ? { pairs }
            : { index: pick };
    setBusy(true);
    setError(null);
    try {
      const r = await api.attempt(item.id, response, { assisted: hints > 0, decision_id: decisionId });
      setResult(r);
      onAnswered?.(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't check the answer.");
    } finally {
      setBusy(false);
    }
  }

  const ans = (result?.answer || {}) as { index?: number; indices?: number[]; order?: number[]; pairs?: number[]; explanation?: string };
  const stateOf = (i: number) => {
    if (!result) return "";
    const right = multi ? ans.indices?.includes(i) : ans.index === i;
    const chosen = multi ? picks.includes(i) : pick === i;
    return right ? "right" : chosen ? "wrong" : "";
  };

  return (
    <div>
      <h3>{p.stem}</h3>

      {choice && (
        <ul className="choices">
          {(p.options || []).map((o, i) => {
            const on = multi ? picks.includes(i) : pick === i;
            return (
              <li key={i}>
                <button
                  type="button"
                  className={`choice${multi ? " square" : ""} ${stateOf(i)}`}
                  aria-pressed={on}
                  disabled={!!result}
                  onClick={() =>
                    multi ? setPicks((xs) => (xs.includes(i) ? xs.filter((x) => x !== i) : [...xs, i])) : setPick(i)
                  }
                >
                  <span className="bullet" />
                  <span>{o}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {item.type === "ordering" && (
        <>
          <p>Tap the steps in order.</p>
          <ul className="choices">
            {(p.items || []).map((o, i) => {
              const at = order.indexOf(i);
              const right = result && ans.order ? ans.order.indexOf(i) === at : null;
              return (
                <li key={i}>
                  <button
                    type="button"
                    className={`choice ${result ? (right ? "right" : "wrong") : ""}`}
                    aria-pressed={at >= 0}
                    disabled={!!result}
                    onClick={() => setOrder((xs) => (xs.includes(i) ? xs.filter((x) => x !== i) : [...xs, i]))}
                  >
                    {at >= 0 ? <span className="order-no">{at + 1}</span> : <span className="bullet" />}
                    <span>{o}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {item.type === "matching" && (
        <div className="match">
          {(p.left || []).map((l, i) => (
            <label key={i} style={{ display: "contents" }}>
              <span>{l}</span>
              <select
                value={pairs[i]}
                disabled={!!result}
                onChange={(e) => setPairs((xs) => xs.map((x, k) => (k === i ? Number(e.target.value) : x)))}
                aria-label={`Match for ${l}`}
              >
                <option value={-1}>Choose…</option>
                {(p.right || []).map((r, k) => (
                  <option key={k} value={k}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {!result && hints > 0 && (p.hints || []).slice(0, hints).map((h, i) => (
        <p className="hint" key={i}>
          {h}
        </p>
      ))}

      {!result && (
        <div className="icard-actions">
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "Checking…" : "Check answer"}
          </button>
          {(p.hints || []).length > hints && (
            <button className="btn btn-quiet" onClick={() => setHints((h) => h + 1)}>
              Show a hint
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="notice" role="alert" style={{ margin: "8px 0 0" }}>
          {error}
        </p>
      )}

      {result && (
        <div className={`feedback ${result.correct ? "ok" : "no"}`} role="status">
          <strong>{result.correct ? "That's it." : "Not quite."}</strong>
          {ans.explanation && <Markdown className="inline" text={ans.explanation} />}
          {result.evidence.length > 0 && (
            <div className="evidence">
              <span style={{ color: "var(--ink-3)" }}>Where the video says it:</span>
              {result.evidence.map((e) => (
                <button key={e.id} className="time-chip" onClick={() => onSeek(e.t0)} title={e.text}>
                  {fmt(e.t0)}
                </button>
              ))}
            </div>
          )}
          <div className="count-note">
            {LEVEL[item.level]} question. {result.counted_toward_mastery ? "Counts toward your mastery." : `Practice only: ${result.why_not_counted}.`}
          </div>
        </div>
      )}
    </div>
  );
}
