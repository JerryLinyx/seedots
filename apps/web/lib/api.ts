import type {
  AttemptResult,
  Card,
  CoachMessage,
  ConceptPage,
  Decision,
  KnowledgeMap,
  Mark,
  MarkType,
  Pack,
  Progress,
  SearchResult,
  Settings,
  Signal,
  Video,
} from "./types";

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000").replace(/\/$/, "");

/** Dev identity until hosted auth is wired: one learner per browser. */
export const USER = "demo";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-SeeDots-User", USER);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "Can't reach SeeDots. Check that the backend is running.");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

const json = (body: unknown) => JSON.stringify(body);

/** Reads a server-sent event stream from a fetch response (works for POST, unlike EventSource). */
export async function* readSSE(res: Response): AsyncGenerator<{ event: string; data: any }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

async function stream(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-SeeDots-User", USER);
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok || !res.body) throw new ApiError(res.status, res.statusText);
  return readSSE(res);
}

export const api = {
  videos: () => req<Video[]>("/api/videos"),
  video: (id: string) => req<Video>(`/api/videos/${id}`),
  addLink: (url: string, rightsStatement?: string) =>
    req<Video>("/api/videos", { method: "POST", body: json({ url, rights_statement: rightsStatement || null }) }),
  upload: (file: File, captions?: File | null) => {
    const fd = new FormData();
    fd.append("file", file);
    if (captions) fd.append("captions", captions);
    return req<Video>("/api/videos/upload", { method: "POST", body: fd });
  },
  remove: (id: string) => req<{ ok: boolean }>(`/api/videos/${id}`, { method: "DELETE" }),
  position: (id: string, t: number) => req(`/api/videos/${id}/position`, { method: "PUT", body: json({ t }) }),
  pack: (id: string) => req<Pack>(`/api/videos/${id}/pack`),
  progress: (id: string) =>
    stream(`/api/videos/${id}/progress`) as Promise<AsyncGenerator<{ event: string; data: Progress }>>,
  events: (events: unknown[]) => req<{ accepted: number }>("/api/events", { method: "POST", body: json({ events }) }),
  decide: (media_id: string, signal: Signal) =>
    req<Decision>("/api/decide", { method: "POST", body: json({ media_id, signal }) }),
  outcome: (decisionId: string, outcome: "shown" | "dismissed" | "suppressed") =>
    req(`/api/decisions/${decisionId}/outcome`, { method: "POST", body: json({ outcome }) }),
  attempt: (item_id: string, response: Record<string, unknown>, opts: { assisted?: boolean; decision_id?: string }) =>
    req<AttemptResult>("/api/attempts", {
      method: "POST",
      body: json({ item_id, response, assisted: !!opts.assisted, decision_id: opts.decision_id || null }),
    }),
  coach: (media_id: string, t: number, question: string) =>
    stream("/api/coach", { method: "POST", body: json({ media_id, t, question }) }),
  thread: (media_id: string) => req<CoachMessage[]>(`/api/coach/${media_id}`),
  mark: (media_id: string, t: number, type: MarkType, note = "") =>
    req<Mark>("/api/marks", { method: "POST", body: json({ media_id, t, type, note }) }),
  unmark: (id: string) => req(`/api/marks/${id}`, { method: "DELETE" }),
  correct: (evidenceId: string, text: string) =>
    req<{ id: string; revision: number; text: string }>(`/api/evidence/${evidenceId}`, {
      method: "PATCH",
      body: json({ text }),
    }),
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (s: Partial<Settings>) => req<Settings>("/api/settings", { method: "PUT", body: json(s) }),
  map: () => req<KnowledgeMap>("/api/map"),
  concept: (id: string) => req<ConceptPage>(`/api/concepts/${id}`),
  search: (q: string) => req<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`),
  draftCard: (conceptId: string) => req<Card>(`/api/concepts/${conceptId}/card`, { method: "POST" }),
  updateCard: (id: string, patch: Partial<Pick<Card, "title" | "body" | "status">>) =>
    req<Card>(`/api/cards/${id}`, { method: "PATCH", body: json(patch) }),
  resolveLink: (id: string, status: "confirmed" | "dismissed") =>
    req(`/api/links/${id}`, { method: "POST", body: json({ status }) }),
};

/** Absolute URL for media the backend serves (the <video>/<img> tags cannot send headers). */
export function mediaUrl(path: string): string {
  return `${API_BASE}${path}${path.includes("?") ? "&" : "?"}u=${USER}`;
}

export function fmt(t: number | null | undefined): string {
  if (t == null || !isFinite(t)) return "–";
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
