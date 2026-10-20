"use client";

import { memo, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Chapter, Sentence } from "@/lib/types";

function Line({
  s,
  now,
  onSeek,
  onFixed,
}: {
  s: Sentence;
  now: boolean;
  onSeek: (t: number) => void;
  onFixed: (id: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(s.text);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    try {
      const r = await api.correct(s.id, text);
      onFixed(s.id, r.text);
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save the correction.");
    }
  }

  if (editing) {
    return (
      <div className="tr-line now" data-id={s.id}>
        <span className="pin" />
        <div className="tr-edit">
          <label className="sr-only" htmlFor={`fix-${s.id}`}>
            Correct this line
          </label>
          <textarea id={`fix-${s.id}`} className="field" value={text} rows={3} onChange={(e) => setText(e.target.value)} autoFocus />
          {error && <span className="notice" style={{ margin: 0 }}>{error}</span>}
          <div>
            <button className="btn btn-primary" onClick={() => void save()} disabled={!text.trim()}>
              Save correction
            </button>
            <button className="btn btn-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`tr-line${now ? " now" : ""}${s.needs_review || s.confidence < 0.8 ? " unsure" : ""}`}
      data-id={s.id}
      onClick={() => onSeek(s.t0)}
      role="button"
      tabIndex={-1}
    >
      <span className="pin" aria-hidden="true" />
      <span className="txt">{s.text}</span>
      <button
        className="btn btn-icon fix"
        aria-label="Correct this line"
        title="Correct this line"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 12l1-3.5L9.5 2 12 4.5 5.5 11z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

const MemoLine = memo(Line);

export function Transcript({
  sentences,
  chapters,
  now,
  onSeek,
  onFixed,
}: {
  sentences: Sentence[];
  chapters: Chapter[];
  now: number;
  onSeek: (t: number) => void;
  onFixed: (id: string, text: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);
  const current = sentences.findIndex((s) => s.t0 <= now && now < s.t1 + 0.6);
  const currentId = current >= 0 ? sentences[current].id : null;

  useEffect(() => {
    if (!currentId || Date.now() - userScrolledAt.current < 6000) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(currentId)}"]`);
    const scroller = box.current?.parentElement;
    if (!el || !scroller) return;
    const top = el.offsetTop - scroller.clientHeight * 0.32;
    scroller.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [currentId]);

  useEffect(() => {
    const scroller = box.current?.parentElement;
    if (!scroller) return;
    const mark = () => (userScrolledAt.current = Date.now());
    scroller.addEventListener("wheel", mark, { passive: true });
    scroller.addEventListener("touchmove", mark, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", mark);
      scroller.removeEventListener("touchmove", mark);
    };
  }, []);

  if (!sentences.length) {
    return <p className="coach-empty" style={{ padding: 24 }}>The transcript appears here as soon as the video has been read.</p>;
  }

  let ci = -1;
  return (
    <div className="transcript" ref={box}>
      {sentences.map((s) => {
        const chIdx = chapters.findIndex((c) => c.t0 <= s.t0 && s.t0 < c.t1);
        const head = chIdx !== ci && chIdx >= 0;
        if (head) ci = chIdx;
        return (
          <div key={s.id}>
            {head && (
              <div className="tr-chapter">
                Chapter {chIdx + 1}: {chapters[chIdx].title}
              </div>
            )}
            <MemoLine s={s} now={s.id === currentId} onSeek={onSeek} onFixed={onFixed} />
          </div>
        );
      })}
    </div>
  );
}
