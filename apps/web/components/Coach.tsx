"use client";

import { type FormEvent, type ReactNode, forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Citation, CoachMessage } from "@/lib/types";

export type CoachHandle = { ask: (question: string) => void };

const CITE = /\[(s\d{4}|o\d{1,2})\]|\(not from the video\)/g;

function render(text: string, cites: Citation[], onSeek: (t: number, mediaId?: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    out.push(text.slice(last, m.index));
    if (m[1]) {
      const c = cites.find((x) => x.ref === m[1]);
      out.push(
        c && c.t0 != null ? (
          <button key={m.index} className="time-chip" onClick={() => onSeek(c.t0!, c.media_id)}>
            {fmt(c.t0)}
            {c.ref.startsWith("o") ? " in another video" : ""}
          </button>
        ) : null,
      );
    } else {
      out.push(
        <span key={m.index} className="ext">
          (not from the video)
        </span>,
      );
    }
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export const Coach = forwardRef<
  CoachHandle,
  { mediaId: string; now: () => number; onSeek: (t: number, mediaId?: string) => void; nowLabel: string }
>(function Coach({ mediaId, now, onSeek, nowLabel }, ref) {
  const [log, setLog] = useState<CoachMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.thread(mediaId).then(setLog).catch(() => undefined);
  }, [mediaId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  async function ask(question: string) {
    if (busy) return;
    const q = question.trim() || "I'm confused about this part. Can you explain it?";
    setBusy(true);
    setDraft("");
    setLog((l) => [...l, { role: "user", content: q, citations: [] }, { role: "assistant", content: "", citations: [] }]);
    try {
      for await (const { event, data } of await api.coach(mediaId, now(), q)) {
        if (event === "delta") {
          setLog((l) => {
            const copy = [...l];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, content: last.content + data.text };
            return copy;
          });
        } else if (event === "done") {
          setLog((l) => {
            const copy = [...l];
            copy[copy.length - 1] = { ...copy[copy.length - 1], citations: data.citations };
            return copy;
          });
        } else if (event === "error") {
          throw new Error(data.message);
        }
      }
    } catch (e) {
      setLog((l) => {
        const copy = [...l];
        copy[copy.length - 1] = {
          role: "assistant",
          content: e instanceof Error && e.message ? e.message : "The coach is unavailable right now.",
          citations: [],
        };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  useImperativeHandle(ref, () => ({ ask: (q) => void ask(q) }));

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(draft);
  }

  return (
    <div className="coach">
      <div className="coach-log" ref={logRef} aria-live="polite">
        {!log.length && (
          <p className="coach-empty">
            Ask about what you're watching. The coach reads the transcript around {nowLabel}, answers briefly, and
            points to the exact moments it relies on.
          </p>
        )}
        {log.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg-user">
              {m.content}
            </div>
          ) : (
            <div key={i} className="msg-bot">
              {render(m.content, m.citations, onSeek)}
              {busy && i === log.length - 1 && <span className="caret" aria-label="Writing" />}
            </div>
          ),
        )}
      </div>
      <form className="coach-form" onSubmit={submit}>
        <label htmlFor="coach-q" className="sr-only">
          Ask the coach
        </label>
        <textarea
          id="coach-q"
          className="field"
          rows={1}
          placeholder="Why does this step work?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Ask
        </button>
      </form>
    </div>
  );
});
