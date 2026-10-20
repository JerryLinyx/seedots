"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fmt } from "@/lib/api";
import type { ConceptPage, KnowledgeMap, SearchResult } from "@/lib/types";
import { Brand } from "./Brand";
import { Constellation } from "./Constellation";
import { Markdown } from "./Markdown";

const LEVELS = ["Not checked yet", "Recalls it", "Understands it", "Applies it"];

function ConceptDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [c, setC] = useState<ConceptPage | null>(null);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setC(null);
    setEditing(false);
    void api.concept(id).then((x) => {
      setC(x);
      setTimeout(() => head.current?.focus(), 50);
    });
  }, [id]);

  async function draft() {
    setBusy(true);
    setError(null);
    try {
      const card = await api.draftCard(id);
      setC((x) => (x ? { ...x, card } : x));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't draft the card.");
    } finally {
      setBusy(false);
    }
  }
  async function save(status?: "confirmed") {
    if (!c?.card) return;
    const card = await api.updateCard(c.card.id, { body: editing ? body : undefined, status });
    setC({ ...c, card });
    setEditing(false);
  }

  if (!c) return <aside className="drawer" aria-busy="true" />;
  const level = c.mastery?.level ?? 0;
  return (
    <aside className="drawer" aria-labelledby="concept-title">
      <button className="btn btn-quiet" onClick={onClose} style={{ marginLeft: -10, marginBottom: 12 }}>
        Close
      </button>
      <h2 id="concept-title" ref={head} tabIndex={-1}>
        {c.name}
      </h2>
      {c.definition && <p className="def">{c.definition}</p>}
      <div className="ladder" aria-label={`Mastery: ${LEVELS[level]}`}>
        {[1, 2, 3].map((l) => (
          <i key={l} className={l <= level ? "on" : ""} />
        ))}
        <span>{LEVELS[level]}</span>
      </div>

      <h3>Your card</h3>
      {c.card ? (
        <div className="kcard">
          <div className="state">{c.card.status === "confirmed" ? "Confirmed by you" : "Draft from your videos, check it before keeping"}</div>
          <h4>{c.card.title}</h4>
          {editing ? (
            <textarea className="field" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Card text" />
          ) : (
            <Markdown className="body" text={c.card.body} />
          )}
          <div className="icard-actions" style={{ marginTop: 12 }}>
            {editing ? (
              <>
                <button className="btn btn-primary" onClick={() => void save()}>
                  Save card
                </button>
                <button className="btn btn-quiet" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {c.card.status !== "confirmed" && (
                  <button className="btn btn-primary" onClick={() => void save("confirmed")}>
                    Keep this card
                  </button>
                )}
                <button className="btn" onClick={() => { setBody(c.card!.body); setEditing(true); }}>
                  Edit
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div>
          <p className="def" style={{ fontSize: "var(--t-m)" }}>
            Draft a short card from what your videos say about {c.name}. You review it before it's kept.
          </p>
          <button className="btn btn-primary" onClick={() => void draft()} disabled={busy}>
            {busy ? "Drafting…" : "Draft a card"}
          </button>
          {error && <p className="notice" style={{ margin: "8px 0 0" }}>{error}</p>}
        </div>
      )}

      {c.misconceptions.length > 0 && (
        <>
          <h3>Common mix-ups</h3>
          <ul className="misc">
            {c.misconceptions.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </>
      )}

      <h3>Where it's taught</h3>
      {c.occurrences.map((o) => (
        <div className="occ" key={`${o.media_id}-${o.chapter_id}`}>
          <Link className="title" href={`/learn/${o.media_id}?t=${Math.floor(o.t0)}`}>
            {o.title}
          </Link>
          <Link className="time-chip" href={`/learn/${o.media_id}?t=${Math.floor(o.t0)}`}>
            {fmt(o.t0)}
          </Link>
          {o.quotes.slice(0, 1).map((q) => (
            <blockquote key={q.id}>{q.text}</blockquote>
          ))}
        </div>
      ))}
    </aside>
  );
}

export function MapView() {
  const [map, setMap] = useState<KnowledgeMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const sky = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 760 });

  useEffect(() => {
    // lay out in real pixels so labels stay legible on any screen shape
    const el = sky.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setSize({ w: Math.round(width), h: Math.round(height - 160) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    api.map().then(setMap).catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't load the map."));
  }, []);

  useEffect(() => {
    if (!q.trim()) return setResults(null);
    const h = setTimeout(() => void api.search(q).then(setResults).catch(() => undefined), 220);
    return () => clearTimeout(h);
  }, [q]);

  const stars = useMemo(
    () => ({
      nodes: (map?.nodes ?? []).map((n) => ({ id: n.id, label: n.name, weight: n.videos, level: n.mastery })),
      edges: map?.edges ?? [],
    }),
    [map],
  );
  const videos = new Set(map?.nodes.flatMap((n) => n.sources.map((s) => s.media_id)) ?? []).size;

  return (
    <>
      <header className="topbar ruled">
        <Brand />
        <span className="topbar-title">Knowledge map</span>
        <span className="spacer" />
        <nav aria-label="Main">
          <Link className="btn btn-quiet" href="/">
            Your videos
          </Link>
        </nav>
      </header>
      <main className={`mapview${selected ? " open" : ""}`}>
        <section className="sky" aria-label="Concepts" ref={sky}>
          {map && map.nodes.length > 0 && (
            <div className="sky-search">
              <label htmlFor="search" className="sr-only">
                Search concepts, moments and cards
              </label>
              <input
                id="search"
                className="field"
                type="search"
                placeholder="Search what you've learned"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ borderRadius: 999, boxShadow: "var(--float)" }}
              />
              {results && (
                <div className="results">
                  {!results.concepts.length && !results.moments.length && !results.cards.length && (
                    <p style={{ margin: 8, color: "var(--ink-3)" }}>Nothing matches “{q}”.</p>
                  )}
                  {results.concepts.length > 0 && <h5>Concepts</h5>}
                  {results.concepts.map((c) => (
                    <button key={c.id} onClick={() => { setSelected(c.id); setQ(""); }}>
                      {c.name}
                    </button>
                  ))}
                  {results.moments.length > 0 && <h5>Moments</h5>}
                  {results.moments.map((m) => (
                    <Link key={m.id} href={`/learn/${m.media_id}?t=${Math.floor(m.t0)}`}>
                      <span className="time-chip" style={{ marginRight: 8 }}>{fmt(m.t0)}</span>
                      {m.text}
                    </Link>
                  ))}
                  {results.cards.length > 0 && <h5>Cards</h5>}
                  {results.cards.map((c) => (
                    <button key={c.id} onClick={() => { setSelected(c.concept_id); setQ(""); }}>
                      {c.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {map && map.nodes.length > 0 && (
            <>
              <Constellation nodes={stars.nodes} edges={stars.edges} selected={selected} onSelect={setSelected} width={size.w} height={Math.max(320, size.h)} labels="all" />
              <p className="sky-caption">
                {map.nodes.length} concepts from {videos} video{videos === 1 ? "" : "s"}. Ringed dots appear in more than one
                video; filled dots are ones you've practised.
              </p>
            </>
          )}
          {map && map.nodes.length === 0 && (
            <div className="sky-empty">
              <div>
                <h2>Your map starts with one video.</h2>
                <p>Every concept a video teaches becomes a dot here. Watch a second video on a related topic and the dots begin to connect.</p>
                <Link className="btn btn-primary" href="/">
                  Add a video
                </Link>
              </div>
            </div>
          )}
          {error && (
            <div className="sky-empty">
              <p role="alert">{error}</p>
            </div>
          )}
        </section>
        {selected ? <ConceptDrawer id={selected} onClose={() => setSelected(null)} /> : <div />}
      </main>
    </>
  );
}
