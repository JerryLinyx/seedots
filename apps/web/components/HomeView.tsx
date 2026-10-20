"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AddVideo } from "@/components/AddVideo";
import { Brand } from "@/components/Brand";
import { HeroTitle } from "@/components/HeroTitle";
import { AmbientSky, Constellation } from "@/components/Constellation";
import { api, ApiError, fmt, mediaUrl } from "@/lib/api";
import type { KnowledgeMap, Video } from "@/lib/types";

const SAMPLE = "https://www.youtube.com/watch?v=ub1D6RQocRU";

function Thumb({ v }: { v: Video }) {
  const src =
    v.playback.kind === "youtube_embed"
      ? `https://i.ytimg.com/vi/${v.playback.video_id}/mqdefault.jpg`
      : mediaUrl(`/api/videos/${v.media_id}/frames/k0001.jpg`);
  const pct = v.duration ? Math.min(100, (v.position / v.duration) * 100) : 0;
  return (
    <div className="thumb">
      <img src={src} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      {pct > 1 && <span className="resume" style={{ width: `${pct}%` }} />}
    </div>
  );
}

function statusText(v: Video): string {
  if (v.status === "failed") return v.status_detail || "Couldn't read this video";
  const { chapters_total: total, chapters_done: done } = v.content;
  if (v.status !== "ready" && !total) return "Reading the video";
  if (total && done < total) return `Preparing questions, ${done} of ${total} chapters`;
  return `${v.content.items} questions across ${total} chapter${total === 1 ? "" : "s"}`;
}

function ChapterDots({ v }: { v: Video }) {
  const { chapters_total: total, chapters_done: done, chapters_failed: failed } = v.content;
  if (!total) return null;
  return (
    <span className="chapter-dots" aria-hidden="true">
      {Array.from({ length: Math.min(total, 24) }, (_, i) => (
        <i key={i} className={i < done ? "done" : i < done + failed ? "failed" : i === done + failed ? "busy" : ""} />
      ))}
    </span>
  );
}

export function HomeView() {
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [map, setMap] = useState<KnowledgeMap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      Promise.all([api.videos(), api.map()])
        .then(([v, m]) => {
          if (!alive) return;
          setVideos(v);
          setMap(m);
          setError(null);
        })
        .catch((e) => alive && setError(e instanceof ApiError ? e.message : "Couldn't load your videos."));
    void load();
    const timer = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const stars = useMemo(() => {
    if (!map?.nodes.length) return null;
    const nodes = map.nodes.slice(0, 40).map((n) => ({ id: n.id, label: n.name, weight: n.videos, level: n.mastery }));
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: map.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
  }, [map]);

  async function remove(id: string) {
    setVideos((vs) => vs?.filter((v) => v.media_id !== id) ?? null);
    await api.remove(id).catch(() => undefined);
  }

  return (
    <>
      <header className="topbar">
        <Brand />
        <span className="spacer" />
        <nav aria-label="Main">
          <Link className="btn btn-quiet" href="/map">
            <span className="wide-only">Knowledge map</span><span className="narrow-only">Map</span>
          </Link>
        </nav>
      </header>
      <main className="home">
        <section className="hero" aria-labelledby="hero-title">
          <div>
            <HeroTitle />
            <p className="lede">
              Watch any lesson with a quiet study partner beside it. SeeDots checks your understanding at natural
              pauses, answers with the exact moment in the video, and links what you learn across everything you
              watch.
            </p>
            <AddVideo initialUrl={videos && videos.length === 0 ? SAMPLE : ""} />
          </div>
          <div className="hero-art" aria-hidden={!stars}>
            {stars ? (
              <Link href="/map" aria-label="Open your knowledge map">
                <Constellation nodes={stars.nodes} edges={stars.edges} width={600} height={600} labels="top" />
              </Link>
            ) : (
              <AmbientSky />
            )}
          </div>
        </section>

        <section className="shelf" aria-labelledby="shelf-title">
          <div className="shelf-head">
            <h2 id="shelf-title">Your videos</h2>
            {videos && videos.length > 0 && (
              <p>
                {videos.length} video{videos.length === 1 ? "" : "s"}, {map?.nodes.length ?? 0} concepts
              </p>
            )}
          </div>
          {error && (
            <p className="shelf-empty" role="alert">
              {error}
            </p>
          )}
          {videos && videos.length === 0 && !error && (
            <p className="shelf-empty">
              Nothing here yet. Add a video above; a sample lecture is filled in so you can try it straight away.
            </p>
          )}
          <ul className="shelf-list">
            {videos?.map((v) => (
              <li key={v.media_id} style={{ position: "relative" }}>
                <Link className="shelf-row" href={`/learn/${v.media_id}`}>
                  <Thumb v={v} />
                  <div style={{ minWidth: 0 }}>
                    <h3 className="shelf-title">{v.title || "Untitled video"}</h3>
                    <div className="shelf-sub">
                      <ChapterDots v={v} />
                      <span>{statusText(v)}</span>
                      {v.position > 5 && <span>Stopped at {fmt(v.position)}</span>}
                    </div>
                  </div>
                  <span style={{ width: 96 }} />
                </Link>
                <button
                  className="btn btn-quiet row-remove"
                  style={{ position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)" }}
                  onClick={() => void remove(v.media_id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
