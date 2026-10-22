"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { fmt } from "@/lib/api";
import type { Citation } from "@/lib/types";

// A bracket may hold several ids: [s0042], [s0063, s0069], [s0066–s0069] (same grammar as the backend).
const CITE = /\[((?:s\d{4}|o\d{1,2})(?:\s*(?:,|;|-|–|—|and)\s*(?:s\d{4}|o\d{1,2}))*)\](?!\()/g;
const REF = /s\d{4}|o\d{1,2}/g;
const EXTERNAL = /\(\s*not from the video\s*:?\s*\)/gi;

/** Evidence ids become `#cite-<id>` links and the external marker a `#ext` link, rendered below. */
function linkify(text: string, keepCites: boolean): string {
  let out = text.replace(CITE, (_m, group: string) =>
    keepCites ? (group.match(REF) ?? []).map((r) => `[${r}](#cite-${r})`).join("") : "",
  );
  out = out.replace(EXTERNAL, "[(not from the video)](#ext)");
  // Math is \(...\) / \[...\]; a lone "$" is money ("$50 a month"), so only $$ reaches remark-math.
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, m: string) => `\n$$\n${m.trim()}\n$$\n`);
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, m: string) => `$$${m.trim()}$$`);
  return out;
}

/** Model text (Markdown + LaTeX) with evidence citations shown as clickable moments. Raw HTML is not rendered. */
/** "#lab-scn_x?tau=2&s=1" → the lab id and the settings to open it at. */
export function parseLabLink(href: string): { id: string; set: Record<string, number> } | null {
  const m = href.match(/^#lab-([A-Za-z0-9_-]+)(?:\?(.*))?$/);
  if (!m) return null;
  const set: Record<string, number> = {};
  for (const [k, v] of new URLSearchParams(m[2] ?? "")) if (Number.isFinite(Number(v))) set[k] = Number(v);
  return { id: m[1], set };
}

export function Markdown({
  text,
  citations = [],
  onSeek,
  onOpenLab,
  className,
}: {
  text: string;
  citations?: Citation[];
  onSeek?: (t: number, mediaId?: string) => void;
  onOpenLab?: (id: string, set: Record<string, number>) => void;
  className?: string;
}) {
  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith("#cite-")) {
        const c = citations.find((x) => x.ref === href.slice(6));
        if (!c || c.t0 == null || !onSeek) return null;
        return (
          <button type="button" className="time-chip" onClick={() => onSeek(c.t0!, c.media_id)}>
            {fmt(c.t0)}
            {c.ref.startsWith("o") ? " in another video" : ""}
          </button>
        );
      }
      if (href === "#ext") return <span className="ext">{children}</span>;
      const lab = href ? parseLabLink(href) : null;
      if (lab) {
        // a lab result the coach computed: open the lab at the same settings
        if (!onOpenLab) return <span>{children}</span>;
        return (
          <button type="button" className="lab-chip" onClick={() => onOpenLab(lab.id, lab.set)}>
            {children}
          </button>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    },
  };
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[rehypeKatex]} components={components}>
        {linkify(text, !!onSeek)}
      </ReactMarkdown>
    </div>
  );
}
