"use client";

import Link from "next/link";
import { useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Decision } from "@/lib/types";
import { ItemView } from "./ItemView";

const KIND: Record<string, string> = {
  quiz: "Check yourself",
  predict: "Before the video says it",
  check_in: "Quick check-in",
  rewatch: "Worth another look",
  explain: "Let's untangle this",
  link: "You've met this before",
  lab: "Try it in the lab",
};

type Props = {
  card: Decision & { userInitiated: boolean };
  onClose: (engaged: boolean) => void;
  onSeek: (t: number) => void;
  onAsk: (question: string) => void;
  onPlay: () => void;
  onOpenLab?: (id: string) => void;
};

export function InterventionCard({ card, onClose, onSeek, onAsk, onPlay, onOpenLab }: Props) {
  const [leaving, setLeaving] = useState(false);
  const [answered, setAnswered] = useState(false);

  function close(engaged: boolean) {
    setLeaving(true);
    if (!engaged) void api.outcome(card.decision_id, "dismissed").catch(() => undefined);
    setTimeout(() => onClose(engaged), 200);
  }

  const kind = card.action === "quiz" && card.userInitiated ? "Quiz me" : KIND[card.action];

  return (
    <article className={`icard${leaving ? " leaving" : ""}`} data-action={card.action} aria-live="polite">
      <div className="icard-kind">
        <i aria-hidden="true" />
        <span>{kind}</span>
      </div>
      <button className="btn btn-icon icard-close" aria-label="Dismiss" onClick={() => close(answered)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {(card.action === "quiz" || card.action === "predict") && card.item && (
        <ItemView
          item={card.item}
          decisionId={card.decision_id}
          onSeek={onSeek}
          onAnswered={() => setAnswered(true)}
        />
      )}

      {card.action === "check_in" && (
        <>
          <h3>How is this part landing?</h3>
          <div className="icard-actions">
            <button className="btn" onClick={() => { onPlay(); close(true); }}>
              Clear, keep going
            </button>
            <button className="btn" onClick={() => { onAsk("Can you explain this part another way?"); close(true); }}>
              Explain it another way
            </button>
          </div>
        </>
      )}

      {card.action === "rewatch" && card.rewatch && (
        <>
          <h3>
            An earlier answer on this idea went astray. The video covers it from {fmt(card.rewatch.t0)} to{" "}
            {fmt(card.rewatch.t1)}.
          </h3>
          <div className="icard-actions">
            <button className="btn btn-primary" onClick={() => { onSeek(card.rewatch!.t0); onPlay(); close(true); }}>
              Replay from {fmt(card.rewatch.t0)}
            </button>
            <button className="btn btn-quiet" onClick={() => close(false)}>
              Not now
            </button>
          </div>
        </>
      )}

      {card.action === "explain" && (
        <>
          <h3>Tell the coach what feels unclear, or let it start from this moment.</h3>
          <div className="icard-actions">
            <button className="btn btn-primary" onClick={() => { onAsk(""); close(true); }}>
              Explain this moment
            </button>
          </div>
        </>
      )}

      {card.action === "link" && card.link && (
        <>
          <h3>
            {card.link.concept} also came up in “{card.link.title}”.
          </h3>
          <div className="icard-actions">
            <Link className="btn btn-primary" href={`/learn/${card.link.media_id}?t=${Math.floor(card.link.t0)}`}
              onClick={() => void api.resolveLink(card.link!.id, "confirmed")}>
              Open at {fmt(card.link.t0)}
            </Link>
            <button className="btn" onClick={() => { void api.resolveLink(card.link!.id, "confirmed"); close(true); }}>
              Keep the connection
            </button>
            <button className="btn btn-quiet" onClick={() => { void api.resolveLink(card.link!.id, "dismissed"); close(false); }}>
              Not related
            </button>
          </div>
        </>
      )}

      {card.action === "lab" && card.lab && (
        <>
          <h3>“{card.lab.title}”: predict what happens, then try it.</h3>
          <div className="icard-actions">
            <button className="btn btn-primary" onClick={() => { onOpenLab?.(card.lab!.id); close(true); }}>
              Open the lab
            </button>
            <button className="btn btn-quiet" onClick={() => close(false)}>
              Later
            </button>
          </div>
        </>
      )}

      {!card.userInitiated && card.reason && <p className="icard-why">Why now: {card.reason}</p>}
    </article>
  );
}
