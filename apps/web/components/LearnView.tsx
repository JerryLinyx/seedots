"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, MEDIA_BASE } from "@/lib/api";
import { EventLog } from "@/lib/events";
import { InterventionPolicy } from "@/lib/policy";
import type { Action, Mark, Pack, Settings, Signal } from "@/lib/types";
import { CardView, type Card } from "./Cards";
import { Coach } from "./Coach";
import { FilePlayer, YouTubePlayer, type PlayerHandle } from "./Player";
import { Transcript } from "./Transcript";

const MARKS: { type: Mark["type"]; label: string; key: string }[] = [
  { type: "useful", label: "Useful", key: "1" },
  { type: "resonate", label: "Resonates", key: "2" },
  { type: "confused", label: "Confused", key: "3" },
];

export function LearnView({ mediaId }: { mediaId: string }) {
  const [pack, setPack] = useState<Pack | null>(null);
  const [loadError, setLoadError] = useState("");
  const [playerError, setPlayerError] = useState("");
  const [now, setNow] = useState(0);
  const [tab, setTab] = useState<"learn" | "coach">("learn");
  const [cards, setCards] = useState<Card[]>([]);
  const [later, setLater] = useState<Card[]>([]);
  const [dot, setDot] = useState(false);
  const [pendingQ, setPendingQ] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const player = useRef<PlayerHandle>(null);
  const packRef = useRef<Pack | null>(null);
  const settingsRef = useRef<Settings>({ focus_mode: false, max_cards_per_5min: 1, purpose: "interest" });
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const log = useMemo(() => new EventLog(mediaId), [mediaId]);

  /* ------------------------------------------------------------ data */
  const load = useCallback(async () => {
    try {
      const p = await api.pack(mediaId);
      packRef.current = p;
      settingsRef.current = p.settings;
      setPack(p);
      setLoadError("");
      return p;
    } catch (e) {
      setLoadError((e as Error).message);
      return null;
    }
  }, [mediaId]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const p = await load();
      const busy =
        !p || p.video.status === "analyzing" || p.video.status === "registered" ||
        p.chapters.some((c) => c.content_status === "pending" || c.content_status === "running");
      if (!stop && busy && p?.video.status !== "failed") timer = setTimeout(loop, 5000);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    log.start();
    return () => log.stop();
  }, [log]);

  /* ------------------------------------------------------------ decisions */
  const onSignal = useCallback(
    async (signal: Signal, userInitiated: boolean) => {
      log.log("signal", signal.t, { ...signal, user_initiated: userInitiated });
      try {
        const d = await api.decide(mediaId, signal);
        log.log("decision", signal.t, { action: d.action, selector: d.selector, rule_action: d.rule_action });
        if (d.action === "none") return;
        if (d.action === "explain") {
          setTab("coach");
          setPendingQ("I'm confused about what was just said. Can you explain it?");
          return;
        }
        if (!userInitiated && !policy.current?.shownCard(d.action)) return;
        setCards((c) => [{ key: `${Date.now()}`, decision: d, t: signal.t, userInitiated }, ...c].slice(0, 3));
        log.log("card_shown", signal.t, { action: d.action, item_id: d.item?.id });
        if (tabRef.current !== "learn") setDot(true);
      } catch (e) {
        setToast(`Could not reach the learning service: ${(e as Error).message}`);
      }
    },
    [log, mediaId],
  );

  const policy = useRef<InterventionPolicy | null>(null);
  if (!policy.current && typeof window !== "undefined") {
    policy.current = new InterventionPolicy(
      () => settingsRef.current,
      () => packRef.current?.chapters ?? [],
      () => packRef.current?.items ?? [],
      (s, u) => void onSignal(s, u),
      (type, t, payload) => log.log(type, t, payload),
    );
  }

  /* ------------------------------------------------------------ playback loop */
  useEffect(() => {
    let beat = 0;
    const id = setInterval(() => {
      const p = player.current;
      if (!p) return;
      const tick = { t: p.time(), playing: p.playing(), rate: p.rate() };
      setNow(tick.t);
      policy.current?.tick(tick);
      if (tick.playing && ++beat % 60 === 0) log.log("heartbeat", tick.t, { rate: tick.rate });
    }, 250);
    return () => clearInterval(id);
  }, [log]);

  const seek = useCallback(
    (t: number) => {
      player.current?.seek(t);
      log.log("seek_requested", t, { source: "app" });
    },
    [log],
  );

  // deep link from the knowledge map: /learn/<id>?t=123
  useEffect(() => {
    const t = Number(new URLSearchParams(window.location.search).get("t"));
    if (!t) return;
    const id = setTimeout(() => player.current?.seek(t), 1500);
    return () => clearTimeout(id);
  }, []);

  /* ------------------------------------------------------------ marks */
  const mark = useCallback(
    async (type: Mark["type"]) => {
      const t = player.current?.time() ?? 0;
      try {
        const m = await api.mark(mediaId, t, type);
        setPack((p) => (p ? { ...p, marks: [...p.marks, m] } : p));
        log.log("mark", t, { type });
        if (type === "confused") policy.current?.user({ kind: "confused_mark", t });
        else setToast(`Marked “${MARKS.find((x) => x.type === type)?.label}” at ${fmt(m.t)}`);
      } catch (e) {
        setToast((e as Error).message);
      }
    },
    [log, mediaId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey) return;
      const m = MARKS.find((x) => x.key === e.key);
      if (m) void mark(m.type);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mark]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  /* ------------------------------------------------------------ cards */
  const closeCard = (card: Card, how: "dismissed" | "engaged" | "later") => {
    setCards((c) => c.filter((x) => x.key !== card.key));
    const action: Action = card.decision.action;
    if (how === "later") setLater((l) => [...l, card]);
    if (!card.userInitiated) {
      if (how === "dismissed") policy.current?.dismissed(action);
      else policy.current?.engaged(action);
    }
    log.log(`card_${how}`, player.current?.time() ?? 0, { action, item_id: card.decision.item?.id });
    if (how === "engaged" && card.decision.item) {
      setPack((p) =>
        p ? { ...p, items: p.items.map((i) => (i.id === card.decision.item?.id ? { ...i, attempted: true } : i)) } : p,
      );
    }
  };

  const toggleFocus = async () => {
    const next = !settingsRef.current.focus_mode;
    const s = await api.putSettings({ focus_mode: next });
    settingsRef.current = s;
    setPack((p) => (p ? { ...p, settings: s } : p));
    setToast(next ? "Focus mode: no interruptions. Use “Quiz me” when you are ready." : "Focus mode off");
  };

  /* ------------------------------------------------------------ render */
  if (loadError && !pack) {
    return (
      <main className="page narrow">
        <p className="error">{loadError}</p>
        <Link href="/">← Back</Link>
      </main>
    );
  }
  if (!pack) return <main className="page narrow"><p className="muted">Loading…</p></main>;

  const v = pack.video;
  const duration = Math.max(1, ...pack.chapters.map((c) => c.t1), ...pack.sentences.map((s) => s.t1));
  const chapter = pack.chapters.find((c) => c.t0 <= now && now < c.t1);
  const concepts = pack.concepts.filter((c) => c.occurrences.some((o) => chapter && o.chapter_id === chapter.id));
  const ready = pack.chapters.filter((c) => c.content_status === "done").length;

  return (
    <div className="learn">
      <aside className="rail">
        <Link href="/" title="Library">⌂</Link>
        <Link href="/map" title="Knowledge map">◎</Link>
      </aside>

      <section className="center">
        <header className="video-head">
          <h1>{v.title || "Untitled"}</h1>
          <p className="muted small">
            {v.platform_meta.channel ? `${v.platform_meta.channel} · ` : ""}
            {v.status === "ready"
              ? `${ready}/${pack.chapters.length} chapters prepared`
              : v.status === "failed" ? `Failed: ${v.status_detail}` : `Preparing: ${v.status_detail || v.status}`}
          </p>
        </header>

        {v.capabilities.playback === "youtube_embed" && v.platform_meta.video_id ? (
          <YouTubePlayer ref={player} videoId={v.platform_meta.video_id as string} onError={setPlayerError} />
        ) : (
          <FilePlayer ref={player} src={`${MEDIA_BASE}/v1/media/${v.media_id}/file`} />
        )}
        {playerError && <p className="error">{playerError}</p>}

        <div className="toolbar">
          <button onClick={() => { setTab("coach"); }} title="Ask about the current moment">Ask about this moment</button>
          {MARKS.map((m) => (
            <button key={m.type} onClick={() => void mark(m.type)} title={`Shortcut: ${m.key}`}>
              {m.label} <kbd>{m.key}</kbd>
            </button>
          ))}
          <span className="spacer" />
          <button onClick={() => policy.current?.user({ kind: "manual", t: now })}>Quiz me</button>
          <label className="switch">
            <input type="checkbox" checked={pack.settings.focus_mode} onChange={() => void toggleFocus()} /> Focus
          </label>
        </div>

        <div className="timeline" onClick={(e) => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * duration);
        }}>
          {pack.chapters.map((c) => (
            <div key={c.id} className={`seg ${c.content_status}`} style={{ left: `${(c.t0 / duration) * 100}%`, width: `${((c.t1 - c.t0) / duration) * 100}%` }} title={`${c.title} (${c.content_status})`} />
          ))}
          {pack.marks.map((m) => (
            <span key={m.id} className={`pin ${m.type}`} style={{ left: `${(m.t / duration) * 100}%` }} title={`${m.type} ${fmt(m.t)}`} />
          ))}
          <span className="playhead" style={{ left: `${(now / duration) * 100}%` }} />
        </div>

        <Transcript sentences={pack.sentences} chapters={pack.chapters} now={now} onSeek={seek} />
      </section>

      <aside className="side">
        <div className="now">
          <span className="muted small">{fmt(now)}</span>
          <strong>{chapter?.title || "—"}</strong>
          {concepts.length > 0 && <span className="muted small">{concepts.map((c) => c.name).join(" · ")}</span>}
        </div>
        <div className="tabs">
          <button className={tab === "learn" ? "on" : ""} onClick={() => { setTab("learn"); setDot(false); }}>
            Learn{dot && <i className="dot" />}
          </button>
          <button className={tab === "coach" ? "on" : ""} onClick={() => setTab("coach")}>Coach</button>
        </div>
        <div className="tab-body" hidden={tab !== "learn"}>
          {cards.length === 0 && (
            <div className="empty">
              <p>Cards appear at natural pauses: the end of a chapter, after you rewind, or before a reveal.</p>
              <p className="muted small">
                {pack.items.length} items ready · {pack.settings.focus_mode ? "focus mode on" : `at most ${pack.settings.max_cards_per_5min} card per 5 min`}
              </p>
            </div>
          )}
          {cards.map((c) => (
            <CardView key={c.key} card={c} onSeek={seek} onClose={closeCard}
              onAsk={(q) => { setTab("coach"); setPendingQ(q); }}
              log={(type, payload) => log.log(type, player.current?.time() ?? 0, payload)} />
          ))}
          {later.length > 0 && (
            <div className="later">
              <p className="muted small">Saved for later</p>
              {later.map((c) => (
                <button key={c.key} className="link" onClick={() => { setLater((l) => l.filter((x) => x.key !== c.key)); setCards((cs) => [c, ...cs]); }}>
                  {c.decision.item?.payload.stem.slice(0, 60) || c.decision.action} · {fmt(c.t)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="tab-body" hidden={tab !== "coach"}>
          <Coach mediaId={mediaId} sentences={pack.sentences} now={() => player.current?.time() ?? now}
            onSeek={seek} pending={pendingQ} onPendingHandled={() => setPendingQ(null)} />
        </div>
      </aside>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
