"use client";

import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from "react";
import { fmt, mediaUrl } from "@/lib/api";
import type { Chapter, ConceptHere, Frame, Mark } from "@/lib/types";

type Tip = { x: number; t: number; title?: string; body?: string; frame?: string };

/**
 * The video as a line of dots: chapter segments (lit when their questions are ready),
 * concepts where they are first taught, the learner's own marks, and the pollen playhead.
 */
export function DotRail({
  duration,
  now,
  chapters,
  concepts,
  marks,
  frames,
  onSeek,
}: {
  duration: number;
  now: number;
  chapters: Chapter[];
  concepts: ConceptHere[];
  marks: Mark[];
  frames: Frame[];
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const D = Math.max(duration, chapters.at(-1)?.t1 ?? 0, 1);
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), D) / D) * 100}%`;

  const conceptDots = useMemo(
    () => concepts.filter((c) => c.occurrences.length).map((c) => ({ c, t: c.occurrences[0].t0 })),
    [concepts],
  );
  const current = chapters.find((c) => c.t0 <= now && now < c.t1);

  function timeAt(clientX: number) {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * D;
  }
  function frameAt(t: number) {
    let best: Frame | undefined;
    for (const f of frames) if (f.t <= t + 0.5) best = f;
    return best?.src;
  }
  function hover(e: PointerEvent) {
    const r = ref.current!.getBoundingClientRect();
    const t = timeAt(e.clientX);
    const ch = chapters.find((c) => c.t0 <= t && t < c.t1);
    setTip({ x: e.clientX - r.left, t, title: ch?.title, frame: frameAt(t) });
  }
  function key(e: KeyboardEvent) {
    const step = e.shiftKey ? 30 : 5;
    if (e.key === "ArrowRight") onSeek(Math.min(D, now + step));
    else if (e.key === "ArrowLeft") onSeek(Math.max(0, now - step));
    else if (e.key === "Home") onSeek(0);
    else return;
    e.preventDefault();
  }

  return (
    <div>
      <div
        ref={ref}
        className="rail"
        role="slider"
        tabIndex={0}
        aria-label="Video timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(D)}
        aria-valuenow={Math.round(now)}
        aria-valuetext={`${fmt(now)} of ${fmt(D)}${current ? `, ${current.title}` : ""}`}
        onPointerMove={hover}
        onPointerLeave={() => setTip(null)}
        onPointerDown={(e) => onSeek(timeAt(e.clientX))}
        onKeyDown={key}
      >
        <div className="rail-track">
          {chapters.map((c) => (
            <span
              key={c.id}
              className={`rail-seg ${c === current ? "current" : c.content_status === "done" ? "done" : c.content_status === "running" ? "running" : ""}`}
              style={{ left: `calc(${pct(c.t0)} + 2px)`, width: `calc(${pct(c.t1 - c.t0)} - 4px)` }}
            />
          ))}
          {!chapters.length && <span className="rail-seg running" style={{ left: 0, width: "100%" }} />}
        </div>
        <div className="rail-played" style={{ width: pct(now) }} />
        {conceptDots.map(({ c, t }, i) => (
          <button
            key={c.id}
            type="button"
            tabIndex={-1}
            className={`rail-dot concept${c.elsewhere.length ? " linked" : ""}`}
            style={{ left: pct(t), animation: `dot-in .5s var(--spring) ${0.2 + i * 0.04}s both` }}
            aria-label={`${c.name} at ${fmt(t)}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSeek(t);
            }}
            onPointerEnter={(e) => {
              e.stopPropagation();
              const r = ref.current!.getBoundingClientRect();
              setTip({
                x: (Math.min(t, D) / D) * r.width,
                t,
                title: c.name,
                body: c.elsewhere.length ? `Also in ${c.elsewhere[0].title}` : "First taught here",
              });
            }}
          />
        ))}
        {marks.map((m) => (
          <button
            key={m.id}
            type="button"
            tabIndex={-1}
            className={`rail-dot mark ${m.type}`}
            style={{ left: pct(m.t) }}
            aria-label={`${m.type} mark at ${fmt(m.t)}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSeek(m.t);
            }}
          />
        ))}
        <div className="rail-head" style={{ left: pct(now) }} />
        {tip && (
          <div className="rail-tip" style={{ left: Math.max(70, Math.min(tip.x, (ref.current?.clientWidth ?? 0) - 70)) }}>
            {tip.frame && <img src={mediaUrl(tip.frame)} alt="" />}
            <b>{fmt(tip.t)}</b> {tip.title}
            {tip.body && <div>{tip.body}</div>}
          </div>
        )}
      </div>
      <div className="rail-legend" aria-hidden="true">
        <span><i style={{ background: "var(--moss)" }} />Concept introduced</span>
        <span><i style={{ background: "transparent", boxShadow: "0 0 0 1.5px var(--moss)" }} />Seen in another video</span>
        <span><i style={{ background: "var(--pollen)" }} />Useful</span>
        <span><i style={{ background: "var(--ember)" }} />Confusing</span>
      </div>
    </div>
  );
}
