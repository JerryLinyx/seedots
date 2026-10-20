"use client";

import { useMemo, useState } from "react";

export type StarNode = { id: string; label: string; weight: number; level: number | null };
export type StarEdge = { source: string; target: string; weight: number };

type Placed = StarNode & { x: number; y: number; r: number };

/** Small deterministic PRNG so layouts are stable between renders. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Force layout, run to rest synchronously (graphs here are tens of nodes, not thousands). */
function layout(nodes: StarNode[], edges: StarEdge[], w: number, h: number, labelRoom: number): Placed[] {
  const rand = rng(hash(nodes.map((n) => n.id).join("|")));
  const pts = nodes.map((n, i) => {
    const a = i * 2.39996; // golden-angle spiral start: even, organic spread
    const rad = Math.sqrt(i + 0.5) / Math.sqrt(nodes.length) * 0.45;
    return {
      ...n,
      x: 0.5 + Math.cos(a) * rad + (rand() - 0.5) * 0.02,
      y: 0.5 + Math.sin(a) * rad + (rand() - 0.5) * 0.02,
      vx: 0,
      vy: 0,
      r: 6 + Math.min(4, n.weight - 1) * 3.5 + (n.weight > 1 ? 2 : 0),
    };
  });
  const idx = new Map(pts.map((p, i) => [p.id, i]));
  const links = edges.filter((e) => idx.has(e.source) && idx.has(e.target));
  const k = 0.9 / Math.sqrt(Math.max(1, pts.length)); // ideal spacing in unit space
  for (let step = 0; step < 400; step++) {
    const cool = 1 - step / 400;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = Math.max(1e-4, dx * dx + dy * dy);
        const f = (k * k) / d2 * 0.02;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
    }
    for (const l of links) {
      const a = pts[idx.get(l.source)!];
      const b = pts[idx.get(l.target)!];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1e-3, Math.hypot(dx, dy));
      const f = ((d - k) / d) * 0.04 * Math.min(2, l.weight);
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const p of pts) {
      p.vx += (0.5 - p.x) * 0.01;
      p.vy += (0.5 - p.y) * 0.01;
      const sp = Math.hypot(p.vx, p.vy);
      const lim = 0.03 * cool + 0.001;
      if (sp > lim) {
        p.vx = (p.vx / sp) * lim;
        p.vy = (p.vy / sp) * lim;
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.6;
      p.vy *= 0.6;
    }
  }
  // fit the result into the box, leaving room on the right for labels
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 36;
  const sx = (w - pad * 2 - labelRoom) / Math.max(1e-3, x1 - x0);
  const sy = (h - pad * 2) / Math.max(1e-3, y1 - y0);
  // stretch to the box's shape, but never distort by more than 1.6x
  const fx = Math.min(sx, sy * 1.6);
  const fy = Math.min(sy, sx * 1.6);
  const ox = pad + (w - pad * 2 - labelRoom - (x1 - x0) * fx) / 2;
  const oy = pad + (h - pad * 2 - (y1 - y0) * fy) / 2;
  return pts.map(({ vx: _vx, vy: _vy, ...p }) => ({ ...p, x: ox + (p.x - x0) * fx, y: oy + (p.y - y0) * fy }));
}

function fill(level: number | null) {
  if (level == null) return "var(--paper)";
  return level >= 3 ? "var(--moss)" : level === 2 ? "var(--moss-2)" : "var(--lichen)";
}

export function Constellation({
  nodes,
  edges,
  width = 1000,
  height = 720,
  selected,
  onSelect,
  labels = "all",
  revealKey,
}: {
  nodes: StarNode[];
  edges: StarEdge[];
  width?: number;
  height?: number;
  selected?: string | null;
  onSelect?: (id: string) => void;
  labels?: "all" | "top" | "none";
  revealKey?: string;
}) {
  const placed = useMemo(
    () => layout(nodes, edges, width, height, labels === "none" ? 0 : 110),
    [nodes, edges, width, height, labels],
  );
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover || selected || null;
  const topLabels = useMemo(
    () => new Set([...placed].sort((a, b) => b.weight - a.weight).slice(0, 10).map((p) => p.id)),
    [placed],
  );

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role={onSelect ? "group" : "img"}
      aria-label={onSelect ? "Concept map" : "Concepts you have met"}
      key={revealKey}
      className="constellation"
    >
      <g>
        {edges.map((e, i) => {
          const a = byId.get(e.source);
          const b = byId.get(e.target);
          if (!a || !b) return null;
          const hot = focus === e.source || focus === e.target;
          return (
            <line
              key={`${e.source}-${e.target}`}
              className={`edge${hot ? " hot" : ""}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              strokeWidth={hot ? 1.6 : 1}
              opacity={focus && !hot ? 0.35 : 0.9}
              style={{ animation: `fade-in 0.8s ${0.5 + i * 0.012}s both` }}
            />
          );
        })}
      </g>
      {placed.map((p, i) => {
        const showLabel = labels === "all" || (labels === "top" && topLabels.has(p.id)) || p.id === focus;
        const dim = focus && focus !== p.id && !edges.some((e) =>
          (e.source === focus && e.target === p.id) || (e.target === focus && e.source === p.id));
        return (
          <g
            key={p.id}
            className={`node${p.id === selected ? " selected" : ""}`}
            transform={`translate(${p.x} ${p.y})`}
            opacity={dim ? 0.45 : 1}
            tabIndex={onSelect ? 0 : -1}
            role={onSelect ? "button" : undefined}
            aria-label={onSelect ? `${p.label}, in ${p.weight} video${p.weight === 1 ? "" : "s"}` : undefined}
            onClick={() => onSelect?.(p.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect?.(p.id);
              }
            }}
            onMouseEnter={() => setHover(p.id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(p.id)}
            onBlur={() => setHover(null)}
            style={{ transition: "opacity .2s" }}
          >
            <g style={{ animation: `dot-in 0.6s var(--spring) ${i * 0.035}s both`, transformBox: "fill-box", transformOrigin: "center" }}>
              <circle className="halo" r={p.r + 6} />
              <circle r={p.r} fill={fill(p.level)} stroke="var(--moss)" strokeWidth={p.level == null ? 1.6 : 0} />
              {p.weight > 1 && <circle r={p.r + 3.5} fill="none" stroke="var(--moss)" strokeWidth="1" opacity="0.5" />}
            </g>
            {showLabel && (
              <text x={p.r + 8} y={4} style={{ animation: `fade-in .5s ${0.3 + i * 0.035}s both` }}>
                {p.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Unlabelled field of dots for the welcome screen before anything has been learned. */
export function AmbientSky({ count = 26 }: { count?: number }) {
  const { nodes, edges } = useMemo(() => {
    const rand = rng(7);
    const nodes: StarNode[] = Array.from({ length: count }, (_, i) => ({
      id: `a${i}`,
      label: "",
      weight: rand() < 0.25 ? 2 : 1,
      level: rand() < 0.3 ? 1 + Math.floor(rand() * 3) : null,
    }));
    const edges: StarEdge[] = [];
    for (let i = 1; i < count; i++) {
      if (rand() < 0.62) edges.push({ source: `a${i}`, target: `a${Math.floor(rand() * i)}`, weight: 1 });
    }
    return { nodes, edges };
  }, [count]);
  return <Constellation nodes={nodes} edges={edges} width={600} height={600} labels="none" />;
}
