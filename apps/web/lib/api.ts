import type { AttemptResult, Citation, Decision, Mark, Pack, Settings, Signal, Video } from "./types";

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000").replace(/\/$/, "");
export const MEDIA_BASE = (process.env.NEXT_PUBLIC_MEDIA_BASE || "http://127.0.0.1:8001").replace(/\/$/, "");
const USER = "demo";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-SeeDots-User": USER, ...(init?.headers || {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not json */
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  videos: () => req<Video[]>("/api/videos"),
  addVideo: (url: string) => req<Video>("/api/videos", { method: "POST", body: JSON.stringify({ url }) }),
  pack: (id: string) => req<Pack>(`/api/videos/${id}/pack`),
  events: (events: unknown[]) => req<{ accepted: number }>("/api/events", { method: "POST", body: JSON.stringify({ events }) }),
  decide: (media_id: string, signal: Signal) =>
    req<Decision>("/api/decide", { method: "POST", body: JSON.stringify({ media_id, signal }) }),
  attempt: (item_id: string, response: Record<string, unknown>, assisted: boolean, confidence?: number) =>
    req<AttemptResult>("/api/attempts", {
      method: "POST",
      body: JSON.stringify({ item_id, response, assisted, confidence }),
    }),
  mark: (media_id: string, t: number, type: Mark["type"], note = "") =>
    req<Mark>("/api/marks", { method: "POST", body: JSON.stringify({ media_id, t, type, note }) }),
  settings: () => req<Settings>("/api/settings"),
  putSettings: (s: Partial<Settings>) => req<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  map: () =>
    req<{
      nodes: { id: string; name: string; definition: string | null; sources: { media_id: string; title: string; t0: number }[] }[];
      edges: { concept_id: string; type: string; videos: string[] }[];
    }>("/api/map"),
};

/** Streams the coach's answer (SSE over a POST). */
export async function askCoach(
  body: { media_id: string; t: number; question: string },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<Citation[]> {
  const res = await fetch(`${API_BASE}/api/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SeeDots-User": USER },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Coach unavailable (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let citations: Citation[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (!event || !data) continue;
      const parsed = JSON.parse(data);
      if (event === "delta") onDelta(parsed.text);
      else if (event === "done") citations = parsed.citations || [];
      else if (event === "error") throw new Error(parsed.message);
    }
  }
  return citations;
}

export function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
