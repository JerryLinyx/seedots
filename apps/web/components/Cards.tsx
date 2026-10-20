"use client";

import { useState, type ReactNode } from "react";
import { api, fmt } from "@/lib/api";
import type { AttemptResult, Decision, Item } from "@/lib/types";
import { ItemBody, TYPE_LABEL, type Response } from "./items";

export type Card = { key: string; decision: Decision; t: number; userInitiated: boolean };

type Handlers = {
  onSeek: (t: number) => void;
  onAsk: (question: string) => void;
  onClose: (card: Card, how: "dismissed" | "engaged" | "later") => void;
  log: (type: string, payload?: Record<string, unknown>) => void;
};

export function CardView({ card, ...h }: { card: Card } & Handlers) {
  const d = card.decision;
  const head = (label: string) => (
    <div className="card-head">
      <span className="card-kind">{label}</span>
      <span className="muted small">{fmt(card.t)}</span>
      <button className="link small" onClick={() => h.onClose(card, "later")} title="Answer later">Later</button>
      <button className="icon" onClick={() => h.onClose(card, "dismissed")} aria-label="Dismiss">×</button>
    </div>
  );

  if (d.action === "check_in") {
    return (
      <div className="card">
        {head("Check-in")}
        <p className="card-stem">You went over this part a few times. Stuck here?</p>
        <div className="row-buttons">
          <button onClick={() => { h.onAsk("I don't get this part. Can you explain it?"); h.onClose(card, "engaged"); }}>
            I don’t get it
          </button>
          <button onClick={() => { h.onSeek(Math.max(0, card.t - 15)); h.onClose(card, "engaged"); }}>Watch it again</button>
          <button className="ghost" onClick={() => h.onClose(card, "dismissed")}>Just taking notes</button>
        </div>
        <Why d={d} />
      </div>
    );
  }
  if (d.action === "rewatch" && d.rewatch) {
    const r = d.rewatch;
    return (
      <div className="card">
        {head("Rewatch")}
        <p className="card-stem">
          An earlier answer suggests revisiting {fmt(r.t0)}–{fmt(r.t1)}, where this idea is introduced.
        </p>
        <div className="row-buttons">
          <button onClick={() => { h.onSeek(r.t0); h.onClose(card, "engaged"); }}>Jump to {fmt(r.t0)}</button>
          <button className="ghost" onClick={() => h.onClose(card, "dismissed")}>No thanks</button>
        </div>
        <Why d={d} />
      </div>
    );
  }
  if ((d.action === "quiz" || d.action === "predict") && d.item) {
    return <ItemCard card={card} item={d.item} head={head(TYPE_LABEL[d.item.type])} {...h} />;
  }
  return null;
}

function Why({ d }: { d: Decision }) {
  return (
    <p className="why" title={`selector ${d.selector}; rules would choose ${d.rule_action}; ${d.latency_ms} ms`}>
      {d.reason}
      {d.fallback ? " · rules (model unavailable)" : ""}
    </p>
  );
}

function ItemCard({ card, item, head, ...h }: { card: Card; item: Item; head: ReactNode } & Handlers) {
  const [resp, setResp] = useState<Response | null>(null);
  const [hints, setHints] = useState(0);
  const [confidence, setConfidence] = useState(3);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isChoice = ["single_choice", "find_error", "predict"].includes(item.type);
  const p = item.payload;

  const submit = async () => {
    if (!resp) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.attempt(item.id, resp, hints > 0, isChoice ? confidence : undefined);
      setResult(r);
      h.log("attempt", { item_id: item.id, correct: r.correct, hints, confidence });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      {head}
      <p className="card-stem">{p.stem}</p>
      {item.concepts.length > 0 && <p className="muted small">Concept: {item.concepts.join(", ")} · level {item.level}</p>}
      <ItemBody item={item} disabled={!!result} onChange={setResp} />
      {isChoice && !result && (
        <label className="confidence">
          How sure are you? <input type="range" min={1} max={5} value={confidence} onChange={(e) => setConfidence(+e.target.value)} />
          <span>{["", "guess", "unsure", "fairly", "sure", "certain"][confidence]}</span>
        </label>
      )}
      {!result && p.hints.slice(0, hints).map((x, i) => <p key={i} className="hint">Hint: {x}</p>)}
      {!result && (
        <div className="row-buttons">
          <button className="primary" disabled={!resp || busy} onClick={submit}>
            {item.type === "predict" ? "Lock in prediction" : "Submit"}
          </button>
          {hints < p.hints.length && (
            <button className="ghost" onClick={() => { setHints(hints + 1); h.log("hint", { item_id: item.id }); }}>
              Hint
            </button>
          )}
          <button className="ghost" onClick={() => h.onClose(card, "dismissed")}>Skip</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {result && (
        <div className={`result ${result.correct ? "ok" : "bad"}`}>
          <strong>
            {item.type === "predict"
              ? result.correct ? "Your prediction holds." : "The video goes another way."
              : result.correct ? "Correct." : "Not quite."}
          </strong>
          {typeof result.answer.explanation === "string" && <p>{result.answer.explanation}</p>}
          <div className="evidence">
            {result.evidence.map((e) => (
              <button key={e.id} className="chip" onClick={() => h.onSeek(e.t0 ?? 0)} title={e.text}>
                ▶ {fmt(e.t0 ?? 0)}
              </button>
            ))}
          </div>
          <p className="muted small">
            {result.counted_toward_mastery ? "Counted toward mastery." : `Not counted toward mastery: ${result.why_not_counted}.`}
          </p>
          <div className="row-buttons">
            {!result.correct && (
              <button onClick={() => h.onAsk(`I answered "${p.stem}" wrong. Can you explain why?`)}>Ask the coach why</button>
            )}
            <button className="primary" onClick={() => h.onClose(card, "engaged")}>Back to video</button>
          </div>
        </div>
      )}
    </div>
  );
}
