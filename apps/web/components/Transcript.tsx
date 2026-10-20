"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmt } from "@/lib/api";
import type { Chapter, Sentence } from "@/lib/types";

export function Transcript({
  sentences,
  chapters,
  now,
  onSeek,
}: {
  sentences: Sentence[];
  chapters: Chapter[];
  now: number;
  onSeek: (t: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const current = useMemo(() => sentences.findIndex((s) => s.t0 <= now && now < s.t1), [sentences, now]);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? new Set(sentences.filter((s) => s.text.toLowerCase().includes(q)).map((s) => s.id)) : null;
  }, [query, sentences]);

  useEffect(() => {
    if (!follow || current < 0 || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-i="${current}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current, follow]);

  const chapterStart = new Map(chapters.map((c) => [Math.round(c.t0 * 10), c]));

  return (
    <div className="transcript">
      <div className="transcript-tools">
        <input placeholder="Search the transcript" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
      </div>
      <div className="transcript-body" ref={box} onWheel={() => setFollow(false)}>
        {sentences.length === 0 && <p className="muted">The transcript appears once captions are processed.</p>}
        {sentences.map((s, i) => {
          const ch = chapterStart.get(Math.round(s.t0 * 10));
          if (hits && !hits.has(s.id)) return null;
          return (
            <div key={s.id}>
              {ch && !hits && <div className="chapter-label">{ch.title}</div>}
              <button
                data-i={i}
                className={`sentence${i === current ? " current" : ""}${s.confidence < 0.8 ? " low" : ""}`}
                onClick={() => onSeek(s.t0)}
                title={s.confidence < 0.8 ? "Auto-generated captions; may contain errors" : undefined}
              >
                <span className="ts">{fmt(s.t0)}</span>
                <span>{s.text}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
