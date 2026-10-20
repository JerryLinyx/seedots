"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";

type MapData = Awaited<ReturnType<typeof api.map>>;

export default function MapPage() {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.map().then(setData).catch((e: Error) => setError(e.message));
  }, []);

  const shared = new Set(data?.edges.map((e) => e.concept_id));
  return (
    <main className="page narrow">
      <p><Link href="/">← Library</Link></p>
      <h1>Knowledge map</h1>
      <p className="muted">
        Concepts from every video you added. A concept that appears in more than one video links them — the first dots, connected.
      </p>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      <ul className="concepts">
        {data?.nodes.map((n) => (
          <li key={n.id} className={shared.has(n.id) ? "shared" : ""}>
            <strong>{n.name}</strong>
            {n.definition && <span className="muted"> — {n.definition}</span>}
            <div className="sources">
              {n.sources.map((s, i) => (
                <Link key={i} className="chip" href={`/learn/${s.media_id}?t=${Math.floor(s.t0)}`}>
                  {s.title || s.media_id} · {fmt(s.t0)}
                </Link>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
