"use client";

import { useEffect, useRef, useState } from "react";
import { askCoach, fmt } from "@/lib/api";
import type { Citation, Sentence } from "@/lib/types";

type Msg = { role: "user" | "assistant"; text: string; t: number; citations?: Citation[]; error?: boolean };

/** Render "[s0042]" citations as clickable timestamps. */
function Rendered({ text, refs, onSeek }: { text: string; refs: Map<string, number>; onSeek: (t: number) => void }) {
  const parts = text.split(/(\[s\d{4}\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[(s\d{4})\]$/.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        const t = refs.get(m[1]);
        return t === undefined ? null : (
          <button key={i} className="chip inline" onClick={() => onSeek(t)}>
            ▶ {fmt(t)}
          </button>
        );
      })}
    </>
  );
}

export function Coach({
  mediaId,
  sentences,
  now,
  onSeek,
  pending,
  onPendingHandled,
}: {
  mediaId: string;
  sentences: Sentence[];
  now: () => number;
  onSeek: (t: number) => void;
  pending: string | null;
  onPendingHandled: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const refs = new Map(sentences.map((s) => [s.id.split(".").pop() as string, s.t0]));

  const ask = async (question: string) => {
    if (busy) return;
    const t = now();
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: question || "Explain this moment.", t }, { role: "assistant", text: "", t }]);
    try {
      const citations = await askCoach({ media_id: mediaId, t, question }, (delta) =>
        setMsgs((m) => {
          const copy = [...m];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, text: last.text + delta };
          return copy;
        }),
      );
      setMsgs((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { ...copy[copy.length - 1], citations };
        return copy;
      });
    } catch (e) {
      setMsgs((m) => {
        const copy = [...m];
        copy[copy.length - 1] = { role: "assistant", text: (e as Error).message, t, error: true };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (pending !== null && !busy) {
      onPendingHandled();
      void ask(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [msgs]);

  return (
    <div className="coach">
      <div className="coach-msgs">
        {msgs.length === 0 && (
          <p className="muted">
            Ask about what you are watching. The coach sees the transcript around the current moment and cites it.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}${m.error ? " error" : ""}`}>
            {m.role === "user" && <span className="muted small">at {fmt(m.t)}</span>}
            <div>{m.role === "assistant" ? <Rendered text={m.text || "…"} refs={refs} onSeek={onSeek} /> : m.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="coach-input"
        onSubmit={(e) => {
          e.preventDefault();
          const q = input.trim();
          setInput("");
          void ask(q);
        }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about this moment…" />
        <button className="primary" disabled={busy}>
          Ask
        </button>
      </form>
    </div>
  );
}
