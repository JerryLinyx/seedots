"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fmt, mediaUrl } from "@/lib/api";
import { EventLog } from "@/lib/events";
import { InterventionPolicy } from "@/lib/policy";
import type { Decision, MarkType, Pack, Progress, Settings, Signal } from "@/lib/types";
import { Brand } from "./Brand";
import { Coach, type CoachHandle } from "./Coach";
import { DotRail } from "./DotRail";
import { InterventionCard } from "./InterventionCard";
import { ScenePanel } from "./SceneView";
import { FilePlayer, type PlayerHandle, YouTubePlayer } from "./Player";
import { Transcript } from "./Transcript";

type Card = Decision & { userInitiated: boolean; key: string };
type Tab = "transcript" | "coach" | "concepts";

const MARKS: { type: MarkType; label: string; key: string; color: string }[] = [
  { type: "useful", label: "Useful", key: "1", color: "var(--pollen)" },
  { type: "resonate", label: "Resonates", key: "2", color: "var(--lichen)" },
  { type: "confused", label: "Confusing", key: "3", color: "var(--ember)" },
];

const PURPOSES: { value: Settings["purpose"]; label: string }[] = [
  { value: "interest", label: "Curiosity" },
  { value: "exam", label: "An exam" },
  { value: "work", label: "Work" },
  { value: "research", label: "Research" },
];

function progressText(p: Progress | null, pack: Pack | null): string | null {
  const status = p?.status ?? pack?.video.status;
  if (status === "failed") return p?.detail || pack?.video.status_detail || "Couldn't read this video";
  const total = p?.chapters_total ?? pack?.chapters.length ?? 0;
  const done = p?.chapters_done ?? pack?.chapters.filter((c) => c.content_status === "done").length ?? 0;
  if (!total) return status === "ready" ? null : "Reading the video";
  const failed = p?.chapters_failed ?? pack?.chapters.filter((c) => c.content_status === "failed").length ?? 0;
  if (done + failed < total) return `Preparing questions, ${done} of ${total} chapters`;
  if (failed) return `Questions for ${failed} of ${total} chapters couldn't be prepared`;
  return null;
}

function failedChapters(p: Progress | null, pack: Pack | null): number {
  const total = p?.chapters_total ?? pack?.chapters.length ?? 0;
  const done = p?.chapters_done ?? pack?.chapters.filter((c) => c.content_status === "done").length ?? 0;
  const failed = p?.chapters_failed ?? pack?.chapters.filter((c) => c.content_status === "failed").length ?? 0;
  return failed && done + failed >= total ? failed : 0;
}

export function LearnView({ mediaId }: { mediaId: string }) {
  const params = useSearchParams();
  const startAt = Number(params.get("t") || "") || null;
  const [pack, setPack] = useState<Pack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(0);
  const [cards, setCards] = useState<Card[]>([]);
  const [tab, setTab] = useState<Tab>("transcript");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [flash, setFlash] = useState<MarkType | null>(null);
  const [watch, setWatch] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashNote = useCallback((text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 4000);
  }, []);

  const player = useRef<PlayerHandle>(null);
  const coach = useRef<CoachHandle>(null);
  const packRef = useRef<Pack | null>(null);
  packRef.current = pack;
  const log = useMemo(() => new EventLog(mediaId), [mediaId]);
  const seeded = useRef(false);

  // ---------------------------------------------------------------- data
  const loadPack = useCallback(async () => {
    try {
      const p = await api.pack(mediaId);
      setPack(p);
      setError(null);
      return p;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "This video isn't in your library." : (e as Error).message);
      return null;
    }
  }, [mediaId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const p = await loadPack();
      if (!p || !alive) return;
      const settled =
        watch === 0 &&
        (p.video.status === "failed" ||
        (p.video.status === "ready" && p.chapters.length > 0 && p.chapters.every((c) => c.content_status === "done" || c.content_status === "failed")));
      if (settled) return;
      try {
        let lastDone = -1;
        for await (const { data } of await api.progress(mediaId)) {
          if (!alive) break;
          setProgress(data);
          if (data.chapters_done !== lastDone || data.status === "ready") {
            lastDone = data.chapters_done;
            await loadPack();
          }
        }
        await loadPack();
      } catch {
        /* the stream ended; the page keeps working with what it has */
      }
    })();
    return () => {
      alive = false;
    };
  }, [mediaId, loadPack, watch]);

  async function retryChapters() {
    try {
      const { restarted } = await api.retry(mediaId);
      if (restarted) {
        setProgress(null);
        setWatch((w) => w + 1);
      }
    } catch {
      /* the status line stays as it was */
    }
  }

  // ---------------------------------------------------------------- policy + decisions
  const settingsRef = useRef<Settings>({ focus_mode: false, max_cards_per_5min: 1, purpose: "interest", language: "en" });
  if (pack) settingsRef.current = pack.settings;

  const policyRef = useRef<InterventionPolicy | null>(null);
  const decide = useCallback(
    async (signal: Signal, userInitiated: boolean) => {
      try {
        const d = await api.decide(mediaId, signal);
        if (d.action === "none") {
          if (signal.kind === "manual") flashNote("You've answered every question for this chapter.");
          return;
        }
        if (!userInitiated && !policyRef.current?.shownCard(d.action)) {
          void api.outcome(d.decision_id, "suppressed").catch(() => undefined);
          return;
        }
        void api.outcome(d.decision_id, "shown").catch(() => undefined);
        log.log("card_shown", signal.t, { action: d.action, decision_id: d.decision_id });
        // one card at a time: a newer moment replaces an older, unanswered one
        setCards([{ ...d, userInitiated, key: d.decision_id }]);
      } catch {
        /* a failed decision never interrupts watching */
      }
    },
    [mediaId, log, flashNote],
  );

  if (!policyRef.current) {
    policyRef.current = new InterventionPolicy(
      () => settingsRef.current,
      () => packRef.current?.chapters ?? [],
      () => packRef.current?.items ?? [],
      () => packRef.current?.concepts ?? [],
      (signal, userInitiated) => void decide(signal, userInitiated),
      (type, t, payload) => log.log(type, t, payload),
    );
  }

  // ---------------------------------------------------------------- playback loop
  useEffect(() => {
    log.start();
    const timer = setInterval(() => {
      const p = player.current;
      if (!p) return;
      const t = p.time();
      const d = p.duration();
      if (d && !seeded.current) {
        seeded.current = true;
        const resume = startAt ?? (packRef.current?.video.position && packRef.current.video.position > 5 ? packRef.current.video.position : null);
        if (resume) {
          p.seek(resume);
          policyRef.current?.reset();
        }
      }
      setNow(t);
      if (d) setDuration(d);
      policyRef.current?.tick({ t, playing: p.playing(), rate: p.rate() });
    }, 250);
    const save = setInterval(() => {
      const t = player.current?.time();
      if (t) void api.position(mediaId, t).catch(() => undefined);
    }, 10_000);
    return () => {
      clearInterval(timer);
      clearInterval(save);
      log.stop();
      const t = player.current?.time();
      if (t) void api.position(mediaId, t).catch(() => undefined);
    };
  }, [mediaId, log, startAt]);

  const seek = useCallback(
    (t: number, otherMedia?: string) => {
      if (otherMedia && otherMedia !== mediaId) {
        window.location.href = `/learn/${otherMedia}?t=${Math.floor(t)}`;
        return;
      }
      const from = player.current?.time() ?? 0;
      player.current?.seek(t);
      policyRef.current?.onSeek(from, t);
      setNow(t);
    },
    [mediaId],
  );

  // ---------------------------------------------------------------- marks & shortcuts
  const addMark = useCallback(
    async (type: MarkType) => {
      const t = player.current?.time() ?? now;
      setFlash(type);
      setTimeout(() => setFlash(null), 450);
      try {
        const m = await api.mark(mediaId, t, type);
        setPack((p) => (p ? { ...p, marks: [...p.marks, m].sort((a, b) => a.t - b.t) } : p));
      } catch {
        /* keep watching */
      }
      if (type === "confused") policyRef.current?.user({ kind: "confused_mark", t });
    },
    [mediaId, now],
  );

  const currentChapter = pack?.chapters.find((c) => c.t0 <= now && now < c.t1) ?? pack?.chapters[0];
  const quizMe = useCallback(() => {
    const t = player.current?.time() ?? now;
    policyRef.current?.user({ kind: "manual", t, chapter_id: currentChapter?.id });
  }, [now, currentChapter]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const m = MARKS.find((x) => x.key === e.key);
      if (m) void addMark(m.type);
      else if (e.key === "q") quizMe();
      else if (e.key === "k" || e.key === " ") {
        if (el.closest("button, [role=slider]")) return;
        e.preventDefault();
        const p = player.current;
        if (p) (p.playing() ? p.pause() : p.play());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addMark, quizMe]);

  async function saveSettings(patch: Partial<Settings>) {
    setPack((p) => (p ? { ...p, settings: { ...p.settings, ...patch } } : p));
    const s = await api.saveSettings(patch).catch(() => null);
    if (s) setPack((p) => (p ? { ...p, settings: s } : p));
  }

  const sceneEvent = useCallback(
    (type: string, payload: Record<string, unknown>) => log.log(type, player.current?.time() ?? null, payload),
    [log],
  );

  // open a lab (from a coach link or a card), optionally at given settings
  const [labOpen, setLabOpen] = useState<{ id: string; set?: Record<string, number>; n: number } | null>(null);
  const openLab = useCallback(
    (id: string, set?: Record<string, number>) => {
      // a lab of another chapter: go to that chapter first, so its lab section is the one shown
      const lab = pack?.scenes.find((x) => x.id === id);
      const ch = lab && pack?.chapters.find((c) => c.id === lab.chapter_id);
      if (ch && ch.id !== currentChapter?.id) seek(ch.t0);
      setLabOpen({ id, set, n: Date.now() });
      log.log("scene.open_request", player.current?.time() ?? null, { scene_id: id, set: set ?? {} });
    },
    [log, pack, currentChapter, seek],
  );

  function askCoach(q: string) {
    setTab("coach");
    setTimeout(() => coach.current?.ask(q), 0);
  }

  // ---------------------------------------------------------------- render
  const status = progressText(progress, pack);
  const failed = (progress?.status ?? pack?.video.status) === "failed";
  const chIndex = pack && currentChapter ? pack.chapters.indexOf(currentChapter) : -1;
  const D = duration || pack?.video.duration || 0;

  return (
    <>
      <header className="topbar ruled">
        <Brand />
        <span className="topbar-title" title={pack?.video.title}>
          {pack?.video.title}
        </span>
        <span className="spacer" />
        {status && (
          <span className={`status-line${failed ? " failed" : ""}`} role="status">
            <i aria-hidden="true" />
            {status}
            {failedChapters(progress, pack) > 0 && !failed && (
              <button className="link-btn" onClick={() => void retryChapters()}>
                Retry
              </button>
            )}
          </span>
        )}
        <nav aria-label="Main">
          <Link className="btn btn-quiet" href="/map">
            <span className="wide-only">Knowledge map</span><span className="narrow-only">Map</span>
          </Link>
          <button
            className="btn btn-quiet"
            aria-expanded={settingsOpen}
            aria-controls="study-settings"
            onClick={() => setSettingsOpen((o) => !o)}
          >
            <span className="wide-only">Study settings</span><span className="narrow-only">Settings</span>
          </button>
        </nav>
        {settingsOpen && pack && (
          <div className="pop" id="study-settings" role="dialog" aria-label="Study settings">
            <h3>How SeeDots joins in</h3>
            <label className="toggle">
              <span>Focus mode: no prompts until I ask</span>
              <input
                type="checkbox"
                checked={pack.settings.focus_mode}
                onChange={(e) => void saveSettings({ focus_mode: e.target.checked })}
              />
            </label>
            <label>
              <span>At most {pack.settings.max_cards_per_5min} prompt{pack.settings.max_cards_per_5min === 1 ? "" : "s"} every five minutes</span>
              <input
                type="range"
                min={0}
                max={4}
                value={pack.settings.max_cards_per_5min}
                onChange={(e) => void saveSettings({ max_cards_per_5min: Number(e.target.value) })}
              />
            </label>
            <label>
              <span>I'm learning this for</span>
              <select value={pack.settings.purpose} onChange={(e) => void saveSettings({ purpose: e.target.value as Settings["purpose"] })}>
                {PURPOSES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </div>
        )}
      </header>

      {error ? (
        <main className="home">
          <div className="sky-empty" style={{ position: "static", minHeight: "60vh" }}>
            <div>
              <h2>{error}</h2>
              <p>
                <Link href="/">Add it from the home page</Link> and it will open here.
              </p>
            </div>
          </div>
        </main>
      ) : (
        <main className="learn">
          <section className="stage" aria-label="Video">
            <div className="stage-inner">
              {pack ? (
                pack.video.playback.kind === "youtube_embed" ? (
                  <YouTubePlayer ref={player} videoId={pack.video.playback.video_id} onError={setPlayerError} />
                ) : (
                  <FilePlayer ref={player} src={mediaUrl(pack.video.playback.path)} onError={setPlayerError} />
                )
              ) : (
                <div className="player-frame" />
              )}
              {playerError && <p className="notice" role="alert" style={{ margin: "10px 0 0" }}>{playerError}</p>}

              <DotRail
                duration={D}
                now={now}
                chapters={pack?.chapters ?? []}
                concepts={pack?.concepts ?? []}
                marks={pack?.marks ?? []}
                frames={pack?.frames ?? []}
                onSeek={seek}
              />

              <div className="now-strip">
                <div>
                  {currentChapter ? (
                    <>
                      <span className="chapter-no">
                        Chapter {chIndex + 1} of {pack!.chapters.length}, {fmt(currentChapter.t0)} to {fmt(currentChapter.t1)}
                      </span>
                      <h2>{currentChapter.title}</h2>
                      {currentChapter.summary && <p>{currentChapter.summary}</p>}
                    </>
                  ) : (
                    <>
                      <span className="chapter-no">{fmt(now)}</span>
                      <h2>{failed ? "This video couldn't be read" : "Finding the chapters"}</h2>
                      <p>
                        {failed
                          ? pack?.video.status_detail || "Try another video."
                          : "You can start watching now. Questions appear chapter by chapter, starting where you are."}
                      </p>
                    </>
                  )}
                </div>
                <div className="marks" role="group" aria-label="Mark this moment">
                  {MARKS.map((m) => (
                    <button
                      key={m.type}
                      className={`btn mark-btn${flash === m.type ? " flash" : ""}`}
                      onClick={() => void addMark(m.type)}
                      title={`Mark this moment as ${m.label.toLowerCase()} (${m.key})`}
                    >
                      <i style={{ background: m.color }} aria-hidden="true" />
                      {m.label}
                      <kbd aria-hidden="true">{m.key}</kbd>
                    </button>
                  ))}
                  <button className="btn btn-primary" onClick={quizMe} disabled={!pack?.items.length} title="Quiz me on this chapter (q)">
                    Quiz me
                  </button>
                  {note && (
                    <span className="quiz-note" role="status">
                      {note}
                    </span>
                  )}
                </div>
              </div>

              {pack && currentChapter && (
                <ScenePanel
                  mediaId={mediaId}
                  chapterId={currentChapter.id}
                  chapterTitle={currentChapter.title}
                  scenes={pack.scenes}
                  onEvent={sceneEvent}
                  onAsk={askCoach}
                  onSeek={seek}
                  open={labOpen && pack.scenes.some((x) => x.id === labOpen.id && x.chapter_id === currentChapter.id) ? labOpen : null}
                />
              )}
            </div>
          </section>

          <aside className="panel" aria-label="Study panel">
            <div className="cards">
              {cards.map((c) => (
                <InterventionCard
                  key={c.key}
                  card={c}
                  onSeek={seek}
                  onAsk={askCoach}
                  onPlay={() => player.current?.play()}
                  onOpenLab={(id) => openLab(id)}
                  onClose={(engaged) => {
                    if (engaged) policyRef.current?.engaged(c.action);
                    else policyRef.current?.dismissed(c.action);
                    setCards((cs) => cs.filter((x) => x.key !== c.key));
                    if (c.item) void loadPack();
                  }}
                />
              ))}
            </div>
            <div className="tabs" role="tablist" aria-label="Study panel">
              {(
                [
                  ["transcript", "Transcript", pack?.sentences.length],
                  ["coach", "Coach", null],
                  ["concepts", "Concepts", pack?.concepts.length],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  role="tab"
                  id={`tab-${id}`}
                  aria-controls={`panel-${id}`}
                  aria-selected={tab === id}
                  className="tab"
                  onClick={() => setTab(id)}
                >
                  {label}
                  {count ? <span className="count">{count}</span> : null}
                </button>
              ))}
            </div>
            <div className="tabpanel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === "transcript" && (
                <Transcript
                  sentences={pack?.sentences ?? []}
                  chapters={pack?.chapters ?? []}
                  now={now}
                  onSeek={seek}
                  onFixed={(id, text) =>
                    setPack((p) => (p ? { ...p, sentences: p.sentences.map((s) => (s.id === id ? { ...s, text, confidence: 1, needs_review: false } : s)) } : p))
                  }
                />
              )}
              {tab === "coach" && (
                <Coach ref={coach} mediaId={mediaId} now={() => player.current?.time() ?? now} onSeek={seek} nowLabel={fmt(now)}
                  onOpenLab={openLab} />
              )}
              {tab === "concepts" && (
                <ul className="concepts">
                  {!pack?.concepts.length && (
                    <li className="coach-empty" style={{ border: 0 }}>
                      Concepts show up here as each chapter is prepared.
                    </li>
                  )}
                  {pack?.concepts.map((c) => (
                    <li key={c.id}>
                      <h4>{c.name}</h4>
                      <div className="times">
                        {c.occurrences.map((o) => (
                          <button key={o.chapter_id} className="time-chip" onClick={() => seek(o.t0)}>
                            {fmt(o.t0)}
                          </button>
                        ))}
                      </div>
                      {c.elsewhere.length > 0 && (
                        <div className="also">
                          Also in{" "}
                          {c.elsewhere.slice(0, 2).map((e, i) => (
                            <span key={e.media_id}>
                              {i > 0 && " and "}
                              <Link href={`/learn/${e.media_id}?t=${Math.floor(e.t0)}`}>{e.title}</Link>
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </main>
      )}
    </>
  );
}
