// Mirrors the learning backend's API (services/seedots/learning/api.py).

export type Playback = { kind: "youtube_embed"; video_id: string } | { kind: "file"; path: string };

export type VideoStatus = "registered" | "analyzing" | "ready" | "failed";

export type Video = {
  media_id: string;
  title: string;
  source_kind: "platform" | "upload" | "webpage";
  visibility: "public" | "private";
  duration: number | null;
  playback: Playback;
  status: VideoStatus;
  status_detail: string;
  content: { chapters_total: number; chapters_done: number; chapters_failed: number; items: number };
  position: number;
};

export type Chapter = {
  id: string;
  t0: number;
  t1: number;
  title: string;
  summary: string;
  content_status: "pending" | "running" | "done" | "failed";
};

export type Sentence = {
  id: string;
  ref: string;
  t0: number;
  t1: number;
  text: string;
  confidence: number;
  needs_review: boolean;
};

export type Frame = { id: string; t: number; src: string };

export type ConceptHere = {
  id: string;
  name: string;
  occurrences: { chapter_id: string; t0: number; t1: number; role: string }[];
  elsewhere: { media_id: string; title: string; t0: number }[];
};

export type ItemType = "single_choice" | "multi_choice" | "find_error" | "predict" | "ordering" | "matching";

export type Item = {
  id: string;
  key: string;
  version: number;
  type: ItemType;
  chapter_id: string;
  level: number;
  concept_ids: string[];
  concepts: string[];
  evidence: { id: string; t0: number | null; t1: number | null }[];
  review_status: "auto_validated" | "human_reviewed";
  show_before: number | null;
  payload: {
    stem: string;
    options?: string[];
    items?: string[];
    left?: string[];
    right?: string[];
    hints?: string[];
  };
  attempted?: boolean;
  solved?: boolean;
};

export type MarkType = "useful" | "resonate" | "confused";
export type Mark = { id: string; t: number; type: MarkType; note: string };

export type Settings = {
  focus_mode: boolean;
  max_cards_per_5min: number;
  purpose: "interest" | "exam" | "work" | "research";
  language: string;
};

export type Pack = {
  video: Video;
  chapters: Chapter[];
  sentences: Sentence[];
  frames: Frame[];
  concepts: ConceptHere[];
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
  | "concept_seen_before"
  | "manual";

export type Signal = {
  kind: SignalKind;
  t: number;
  chapter_id?: string;
  concept_id?: string;
  detail?: Record<string, unknown>;
};

export type Action = "none" | "check_in" | "quiz" | "predict" | "rewatch" | "explain" | "link";

export type Decision = {
  decision_id: string;
  action: Action;
  reason: string;
  selector: string;
  rule_action: Action;
  fallback: boolean;
  item?: Item;
  rewatch?: { evidence_id: string; t0: number; t1: number; item_id: string };
  link?: { id: string; concept: string; concept_id: string; media_id: string; title: string; t0: number; t1: number };
};

export type AttemptResult = {
  correct: boolean;
  answer: Record<string, unknown>;
  evidence: { id: string; t0: number; t1: number; text: string }[];
  counted_toward_mastery: boolean;
  why_not_counted: string | null;
  mastery: Record<string, { level: number; streak: number }>;
};

export type Citation = {
  kind: "evidence" | "external";
  ref: string;
  id?: string;
  t0?: number;
  t1?: number;
  media_id?: string;
};

export type CoachMessage = { id?: string; role: "user" | "assistant"; content: string; citations: Citation[]; t?: number };

export type Progress = {
  status: VideoStatus;
  detail: string;
  chapters_total: number;
  chapters_done: number;
  chapters_failed: number;
  items: number;
};

export type MapNode = {
  id: string;
  name: string;
  definition: string;
  mastery: number | null;
  videos: number;
  linked?: boolean;
  sources: { media_id: string; title: string; chapter_id: string; t0: number; role: string }[];
};

export type KnowledgeMap = {
  nodes: MapNode[];
  edges: { source: string; target: string; kind: string; weight: number }[];
};

export type Card = {
  id: string;
  concept_id: string;
  title: string;
  body: string;
  status: "draft" | "confirmed" | "archived";
  sources: { id: string; revision: number }[];
};

export type ConceptPage = {
  id: string;
  name: string;
  definition: string;
  aliases: string[];
  misconceptions: string[];
  occurrences: {
    media_id: string;
    title: string;
    chapter_id: string;
    role: string;
    t0: number;
    t1: number;
    quotes: { id: string; t0: number; text: string }[];
  }[];
  mastery: { level: number; independent_correct: number; independent_wrong: number } | null;
  card: Card | null;
};

export type SearchResult = {
  concepts: { id: string; name: string; definition: string; match: "keyword" | "semantic" }[];
  moments: { media_id: string; title: string; id: string; t0: number; text: string }[];
  cards: Card[];
};
