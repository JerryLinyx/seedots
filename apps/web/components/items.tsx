"use client";

/**
 * Learning-item renderers, one per `type` (mirrors the backend registry in item_types.py).
 * Each renderer only collects a response; grading happens on the server.
 */
import { useState, type ReactNode } from "react";
import type { ChoicePayload, Item, MatchingPayload, OrderingPayload } from "@/lib/types";

export type Response = Record<string, unknown>;
type RendererProps = { item: Item; disabled: boolean; onChange: (r: Response | null) => void };

function Choice({ item, disabled, onChange }: RendererProps) {
  const p = item.payload as ChoicePayload;
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div className="options">
      {p.options.map((o, i) => (
        <button
          key={i}
          disabled={disabled}
          className={`option${sel === i ? " selected" : ""}`}
          onClick={() => {
            setSel(i);
            onChange({ index: i });
          }}
        >
          <span className="letter">{String.fromCharCode(65 + i)}</span>
          {o}
        </button>
      ))}
    </div>
  );
}

function Multi({ item, disabled, onChange }: RendererProps) {
  const p = item.payload as ChoicePayload;
  const [sel, setSel] = useState<number[]>([]);
  const toggle = (i: number) => {
    const next = sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i];
    setSel(next);
    onChange(next.length ? { indices: next } : null);
  };
  return (
    <div className="options">
      {p.options.map((o, i) => (
        <button key={i} disabled={disabled} className={`option${sel.includes(i) ? " selected" : ""}`} onClick={() => toggle(i)}>
          <span className="letter">{sel.includes(i) ? "✓" : String.fromCharCode(65 + i)}</span>
          {o}
        </button>
      ))}
      <p className="muted small">Select all that apply.</p>
    </div>
  );
}

function Ordering({ item, disabled, onChange }: RendererProps) {
  const p = item.payload as OrderingPayload;
  const [order, setOrder] = useState<number[]>(() => p.items.map((_, i) => i));
  const move = (pos: number, d: -1 | 1) => {
    const next = [...order];
    const j = pos + d;
    if (j < 0 || j >= next.length) return;
    [next[pos], next[j]] = [next[j], next[pos]];
    setOrder(next);
    onChange({ order: next });
  };
  return (
    <ol className="ordering">
      {order.map((idx, pos) => (
        <li key={idx}>
          <span>{p.items[idx]}</span>
          <span className="move">
            <button disabled={disabled || pos === 0} onClick={() => move(pos, -1)} aria-label="Move up">↑</button>
            <button disabled={disabled || pos === order.length - 1} onClick={() => move(pos, 1)} aria-label="Move down">↓</button>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Matching({ item, disabled, onChange }: RendererProps) {
  const p = item.payload as MatchingPayload;
  const [pairs, setPairs] = useState<(number | null)[]>(() => p.left.map(() => null));
  const set = (i: number, v: string) => {
    const next = [...pairs];
    next[i] = v === "" ? null : Number(v);
    setPairs(next);
    onChange(next.every((x) => x !== null) ? { pairs: next } : null);
  };
  return (
    <div className="matching">
      {p.left.map((l, i) => (
        <label key={i}>
          <span>{l}</span>
          <select disabled={disabled} value={pairs[i] ?? ""} onChange={(e) => set(i, e.target.value)}>
            <option value="">Choose…</option>
            {p.right.map((r, j) => (
              <option key={j} value={j}>
                {r}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

const RENDERERS: Record<Item["type"], (p: RendererProps) => ReactNode> = {
  single_choice: Choice,
  find_error: Choice,
  predict: Choice,
  multi_choice: Multi,
  ordering: Ordering,
  matching: Matching,
};

export function ItemBody(props: RendererProps) {
  const R = RENDERERS[props.item.type];
  return R ? <R {...props} /> : <p className="muted">This item type is not supported yet.</p>;
}

export const TYPE_LABEL: Record<Item["type"], string> = {
  single_choice: "Check",
  multi_choice: "Check",
  find_error: "Spot the error",
  predict: "Predict",
  ordering: "Put in order",
  matching: "Match",
};
