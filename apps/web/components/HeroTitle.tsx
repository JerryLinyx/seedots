"use client";

import { useEffect, useRef, useState } from "react";

/** The headline's full stops are real dots, and the two are joined: the product, set in type. */
export function HeroTitle() {
  const h1 = useRef<HTMLHeadingElement>(null);
  const a = useRef<HTMLSpanElement>(null);
  const b = useRef<HTMLSpanElement>(null);
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number; len: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      if (!h1.current || !a.current || !b.current) return;
      const o = h1.current.getBoundingClientRect();
      const p = a.current.getBoundingClientRect();
      const q = b.current.getBoundingClientRect();
      const x1 = p.left + p.width / 2 - o.left;
      const y1 = p.top + p.height / 2 - o.top;
      const x2 = q.left + q.width / 2 - o.left;
      const y2 = q.top + q.height / 2 - o.top;
      setLine({ x1, y1, x2, y2, len: Math.hypot(x2 - x1, y2 - y1) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (h1.current) ro.observe(h1.current);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, []);

  return (
    <h1 id="hero-title" ref={h1} className="hero-title" aria-label="See the dots. Connect them.">
      <span className="line" aria-hidden="true">
        See the dots<span ref={a} className="tdot tdot-a" />
      </span>
      <span className="line" aria-hidden="true">
        Connect them<span ref={b} className="tdot tdot-b" />
      </span>
      {line && (
        <svg className="tlink" aria-hidden="true">
          <path
            d={`M${line.x1} ${line.y1} Q${Math.max(line.x1, line.x2) + line.len * 0.5} ${(line.y1 + line.y2) / 2} ${line.x2} ${line.y2}`}
            pathLength={1}
            style={{ strokeDasharray: 1, strokeDashoffset: 1 }}
          />
        </svg>
      )}
    </h1>
  );
}
