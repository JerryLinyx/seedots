import type { Action, Chapter, ConceptHere, Item, Settings, Signal } from "./types";

/**
 * Intervention policy (front end). Turns raw playback into signals and enforces the hard
 * constraints from PRD §6.4 *before* anything reaches the backend:
 *   - proactive cards only at natural pauses (user pause, chapter end, after a seek settles)
 *   - at most N proactive cards per 5 minutes; user-initiated ones do not count
 *   - focus mode: no proactive cards at all
 *   - a card type dismissed twice in a row is muted for 10 minutes
 * The backend only decides WHAT to show.
 */
export type Tick = { t: number; playing: boolean; rate: number };

const REWIND_MIN = 2; // seconds back to count as a rewind
const SKIP_MIN = 25; // seconds forward to count as a skip
const LONG_PAUSE_MS = 8000;
const PREDICT_LEAD = 25; // seconds before a predict item's reveal

export class InterventionPolicy {
  private last: Tick | null = null;
  private lastWall = 0;
  private rewinds: { from: number; to: number; at: number }[] = [];
  private pausedAt: number | null = null;
  private pauseFired = false;
  private shown: number[] = [];
  private dismissStreak: Partial<Record<Action, number>> = {};
  private mutedUntil: Partial<Record<Action, number>> = {};
  private firedChapterEnds = new Set<string>();
  private firedPredicts = new Set<string>();
  private firedLinks = new Set<string>();
  private quietUntil = 0;

  constructor(
    private getSettings: () => Settings,
    private getChapters: () => Chapter[],
    private getItems: () => Item[],
    private getConcepts: () => ConceptHere[],
    private emit: (signal: Signal, userInitiated: boolean) => void,
    private log: (type: string, t: number, payload?: Record<string, unknown>) => void,
  ) {}

  /** Called every ~250ms with the player state. Seeks are inferred for players without seek events. */
  tick(now: Tick) {
    const wall = performance.now();
    const prev = this.last;
    this.last = now;
    const dtWall = (wall - this.lastWall) / 1000;
    this.lastWall = wall;
    if (!prev || wall < this.quietUntil) return;

    const expected = prev.playing ? prev.t + dtWall * prev.rate : prev.t;
    const jump = now.t - expected;
    if (Math.abs(jump) > 1.5 && dtWall < 2) this.onSeek(prev.t, now.t, true);

    if (prev.playing && !now.playing) {
      this.pausedAt = wall;
      this.pauseFired = false;
      this.log("pause", now.t);
    }
    if (!prev.playing && now.playing) {
      this.pausedAt = null;
      this.log("play", now.t);
    }
    if (prev.rate !== now.rate) this.log("rate", now.t, { rate: now.rate });

    if (!now.playing && this.pausedAt && !this.pauseFired && wall - this.pausedAt > LONG_PAUSE_MS) {
      this.pauseFired = true;
      this.proactive({ kind: "long_pause", t: now.t });
    }

    if (now.playing) {
      for (const c of this.getChapters()) {
        if (prev.t < c.t1 && now.t >= c.t1 && now.t - c.t1 < 3 && !this.firedChapterEnds.has(c.id)) {
          this.firedChapterEnds.add(c.id);
          this.proactive({ kind: "chapter_end", t: now.t, chapter_id: c.id });
        }
      }
      const soon = this.getItems().find(
        (i) =>
          i.type === "predict" && !i.attempted && i.show_before !== null && !this.firedPredicts.has(i.id) &&
          i.show_before! - now.t > 3 && i.show_before! - now.t <= PREDICT_LEAD,
      );
      if (soon) {
        this.firedPredicts.add(soon.id);
        this.proactive({ kind: "predict_window", t: now.t }, true);
      }
      // a concept the learner met in another video starts being taught: offer the link once
      for (const c of this.getConcepts()) {
        if (!c.elsewhere.length || this.firedLinks.has(c.id)) continue;
        const first = c.occurrences[0];
        if (first && prev.t < first.t0 + 4 && now.t >= first.t0 + 4) {
          this.firedLinks.add(c.id);
          this.proactive({ kind: "concept_seen_before", t: now.t, concept_id: c.id }, true);
        }
      }
    }
  }

  /** Forget the last tick, e.g. after a programmatic seek (resume) that is not the learner's doing. */
  reset(quietMs = 1500) {
    this.last = null;
    this.quietUntil = performance.now() + quietMs; // the player may report the old time for a moment
  }

  /** Native players report seeks directly. */
  onSeek(from: number, to: number, inferred = false) {
    this.log("seek", to, { from, to, inferred });
    if (to < from - REWIND_MIN) {
      const at = performance.now();
      this.rewinds = this.rewinds.filter((r) => at - r.at < 90_000);
      const overlapping = this.rewinds.filter((r) => Math.max(r.to, to) < Math.min(r.from, from) + 5);
      this.rewinds.push({ from, to, at });
      if (overlapping.length >= 1) {
        this.rewinds = [];
        this.proactive({ kind: "rewind_repeat", t: to, detail: { from, to } });
      }
    } else if (to > from + SKIP_MIN) {
      const skipped = this.getChapters().find((c) => c.t0 >= from - 1 && c.t1 <= to + 1);
      if (skipped) this.proactive({ kind: "skip_ahead", t: to, chapter_id: skipped.id, detail: { from, to } });
    }
  }

  /** The user did something explicit (confused mark, "quiz me"). Never blocked, never counted. */
  user(signal: Signal) {
    this.emit(signal, true);
  }

  private proactive(signal: Signal, skipPauseRule = false) {
    const s = this.getSettings();
    if (s.focus_mode) return this.log("suppressed", signal.t, { kind: signal.kind, why: "focus_mode" });
    const now = performance.now();
    this.shown = this.shown.filter((x) => now - x < 5 * 60_000);
    if (this.shown.length >= Math.max(0, s.max_cards_per_5min)) {
      return this.log("suppressed", signal.t, { kind: signal.kind, why: "rate_limit" });
    }
    // natural pause: chapter end, after a seek, or while paused. Predict windows are exempt
    // because the card sits beside the video and does not pause it.
    const atPause = ["chapter_end", "long_pause", "rewind_repeat", "skip_ahead"].includes(signal.kind);
    if (!atPause && !skipPauseRule) return this.log("suppressed", signal.t, { kind: signal.kind, why: "not_a_pause" });
    this.emit(signal, false);
  }

  /** Called when a proactive card is actually shown (the backend may have said "none"). */
  shownCard(action: Action): boolean {
    const until = this.mutedUntil[action] || 0;
    if (performance.now() < until) return false;
    this.shown.push(performance.now());
    return true;
  }

  dismissed(action: Action) {
    const n = (this.dismissStreak[action] || 0) + 1;
    this.dismissStreak[action] = n;
    if (n >= 2) {
      this.mutedUntil[action] = performance.now() + 10 * 60_000;
      this.dismissStreak[action] = 0;
    }
  }

  engaged(action: Action) {
    this.dismissStreak[action] = 0;
  }
}
