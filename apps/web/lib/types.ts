// Mirrors the learning backend's public contracts (services/seedots/learning/api.py).

export type Capabilities = {
  has_file: boolean;
  frames: boolean;
  native_seek: boolean;
  playback: "youtube_embed" | "file";
};

export type Video = {
  media_id: string;
  title: string | null;
  source_kind: string;
  source_uri: string;
  capabilities: Capabilities;
  platform_meta: { video_id?: string; channel?: string } & Record<string, unknown>;
  status: "registered" | "analyzing" | "ready" | "failed";
  status_detail: string | null;
  chapters: Chapter[];
  content: { chapters_total: number; chapters_done: number; chapters_failed: number };
};

export type Chapter = {
  id: string;
  t0: number;
  t1: number;
  title: string;
  content_status?: "pending" | "running" | "done" | "failed";
};

export type Sentence = { id: string; t0: number; t1: number; text: string; confidence: number; source: string };

export type EvidenceRef = { id: string; t0: number | null; t1: number | null; text?: string };

export type ChoicePayload = { stem: string; options: string[]; hints: string[] };
export type OrderingPayload = { stem: string; items: string[]; hints: string[] };
export type MatchingPayload = { stem: string; left: string[]; right: string[]; hints: string[] };

export type Item = {
  id: string;
  type: "single_choice" | "multi_choice" | "find_error" | "predict" | "ordering" | "matching";
  schema_version: number;
  version: number;
  chapter_id: string;
  level: number;
  concept_ids: string[];
  concepts: string[];
  evidence: EvidenceRef[];
  review_status: "auto_validated" | "human_reviewed";
  show_at: number | null;
  payload: ChoicePayload | OrderingPayload | MatchingPayload;
  attempted?: boolean;
};

export type Concept = {
  id: string;
  name: string;
  definition: string | null;
  occurrences: { chapter_id: string; t0: number; t1: number; role: string }[];
};

export type Mark = { id: string; t: number; type: "useful" | "resonate" | "confused"; note: string };

export type Settings = { focus_mode: boolean; max_cards_per_5min: number; purpose: string };

export type Pack = {
  video: Video;
  chapters: Chapter[];
  sentences: Sentence[];
  concepts: Concept[];
  items: Item[];
  marks: Mark[];
  settings: Settings;
};

export type SignalKind =
  | "rewind_repeat"
  | "long_pause"
  | "chapter_end"
  | "skip_ahead"
  | "confused_mark"
  | "predict_window"
  | "manual";

export type Signal = { kind: SignalKind; t: number; chapter_id?: string | null; detail?: Record<string, unknown> };

export type Action = "none" | "check_in" | "quiz" | "predict" | "rewatch" | "explain";

export type Decision = {
  action: Action;
  reason: string;
  selector: string;
  rule_action: Action;
  latency_ms: number;
  fallback: boolean;
  item?: Item;
  rewatch?: { evidence_id: string; t0: number; t1: number; item_id: string };
};

export type AttemptResult = {
  correct: boolean;
  answer: Record<string, unknown> & { explanation?: string };
  evidence: EvidenceRef[];
  counted_toward_mastery: boolean;
  why_not_counted: string | null;
  mastery: Record<string, { level: number; streak: number }>;
};

export type Citation = { ref: string; id: string; t0: number; t1: number };
