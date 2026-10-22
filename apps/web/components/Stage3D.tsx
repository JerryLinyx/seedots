"use client";

import { useEffect, useRef } from "react";
import { VIEWS } from "@/lib/lab3d";
import { createStage } from "@/lib/lab3d/stage";
import type { ViewHandle } from "@/lib/lab3d/types";
import type { Env, Observed, SceneSpecV2 } from "@seedots/rigs/spec.ts";

/** Mounts a 3D view of the scene's rig and keeps it in step with the params. */
export default function Stage3D({ spec, values, obs, locked, onSet }: { spec: SceneSpecV2; values: Env; obs: Observed; locked: boolean; onSet: (upd: Env) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<ViewHandle | null>(null);
  // the view calls back through refs so it never holds stale props
  const live = useRef({ locked, onSet });
  live.current = { locked, onSet };

  useEffect(() => {
    const view = VIEWS[spec.stage!.kind];
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const stage = createStage(canvas.current!, dark);
    if (process.env.NODE_ENV !== "production") (window as unknown as { __stage?: unknown }).__stage = stage; // debugging aid
    handle.current = view.build({ stage, set: (u) => live.current.onSet(u), locked: () => live.current.locked }, spec, values);
    return () => {
      handle.current?.dispose();
      handle.current = null;
      stage.dispose();
    };
  }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    handle.current?.update(values, obs);
  }, [values, obs]);

  return (
    <div className="stage3d">
      <canvas ref={canvas} />
      <span className="stage3d-hint">Drag to orbit · scroll to zoom{!locked && VIEWS[spec.stage!.kind].hint ? ` · ${VIEWS[spec.stage!.kind].hint}` : ""}</span>
    </div>
  );
}
