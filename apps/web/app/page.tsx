"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import type { Video } from "@/lib/types";

const SAMPLE = "https://www.youtube.com/watch?v=ub1D6RQocRU";

function statusText(v: Video): string {
  if (v.status === "failed") return v.status_detail || "Failed";
  if (v.status !== "ready") return `Preparing · ${v.status_detail || v.status}`;
  const { chapters_total: n, chapters_done: d } = v.content;
  return n && d < n ? `Transcript ready · learning content ${d}/${n} chapters` : "Ready";
}

export default function Home() {
  const [url, setUrl] = useState(SAMPLE);
  const [videos, setVideos] = useState<Video[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setVideos(await api.videos());
      setError("");
    } catch (e) {
      setError(`Learning service unreachable: ${(e as Error).message}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.addVideo(url.trim());
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page narrow">
      <header className="brand">
        <h1>SeeDots</h1>
        <p className="muted">See the dots. Connect them. Paste a lecture or talk; SeeDots reads it and stays beside you while you watch.</p>
      </header>

      <form className="add" onSubmit={add}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="YouTube link" />
        <button className="primary" disabled={busy || !url.trim()}>{busy ? "Adding…" : "Add video"}</button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="library">
        {videos.length === 0 && <li className="muted">No videos yet.</li>}
        {videos.map((v) => (
          <li key={v.media_id}>
            <Link href={`/learn/${v.media_id}`}>
              <strong>{v.title || v.source_uri}</strong>
              <span className={`status ${v.status}`}>{statusText(v)}</span>
            </Link>
          </li>
        ))}
      </ul>

      <footer className="muted small">
        <Link href="/map">Knowledge map</Link> · YouTube videos play in the official embedded player and are never downloaded.
      </footer>
    </main>
  );
}
