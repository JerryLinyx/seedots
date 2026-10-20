import { api } from "./api";

type LearningEvent = {
  event_id: string;
  session_id: string;
  media_id: string;
  media_time: number | null;
  client_seq: number;
  occurred_at: number;
  type: string;
  payload: Record<string, unknown>;
};

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Buffers learning events and flushes them in batches; the server dedupes by event_id. */
export class EventLog {
  private queue: LearningEvent[] = [];
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly session = uuid();

  constructor(private mediaId: string) {}

  start() {
    this.timer = setInterval(() => void this.flush(), 5000);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    void this.flush();
  }

  private onVisibility = () => {
    this.log(document.visibilityState === "hidden" ? "page_hidden" : "page_visible", null);
    if (document.visibilityState === "hidden") void this.flush();
  };

  log(type: string, mediaTime: number | null, payload: Record<string, unknown> = {}) {
    this.queue.push({
      event_id: uuid(),
      session_id: this.session,
      media_id: this.mediaId,
      media_time: mediaTime,
      client_seq: ++this.seq,
      occurred_at: Date.now(),
      type,
      payload,
    });
  }

  async flush() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await api.events(batch);
    } catch {
      this.queue.unshift(...batch); // retry later; ids make it idempotent
    }
  }
}
