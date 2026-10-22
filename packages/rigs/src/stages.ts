// Stage checks, kept free of three.js so the gates can run anywhere.

import type { SceneSpecV2 } from "./spec.ts";

type Checker = { rig: string; check(stage: Record<string, unknown>, params: Set<string>, spec: SceneSpecV2): string[] };

const param = (v: unknown, params: Set<string>, what: string) => (v == null || (typeof v === "string" && params.has(v)) ? [] : [`stage.${what}: no param ${String(v)}`]);

export const STAGES: Record<string, Checker> = {
  terrain: {
    rig: "field",
    check: (s, params) => [
      ...param(s.slice, params, "slice"),
      ...(s.exaggeration != null && !(Number(s.exaggeration) > 0 && Number(s.exaggeration) <= 10) ? ["stage.exaggeration must be in (0, 10]"] : []),
    ],
  },
  pendulum: { rig: "particle", check: (s, params) => (typeof s.length === "string" && params.has(s.length) ? [] : ["stage.length: name the string-length param"]) },
  spring: { rig: "particle", check: () => [] },
  launcher: {
    rig: "particle",
    check: (s, params, spec) => [
      ...(typeof s.angle === "string" && params.has(s.angle) ? [] : ["stage.angle: name the launch-angle param"]),
      ...(!(spec.config as { reveal?: string }).reveal ? ["launcher needs a reveal (time) param to play the flight"] : []),
    ],
  },
  bench: { rig: "optics", check: (_s, _p, spec) => ((spec.config as { bench?: string }).bench === "lens" ? [] : ["bench presents the lens bench only"]) },
  orbit: { rig: "sun", check: () => [] },
  track: {
    rig: "particle",
    check: (s, params, spec) => [
      ...param(s.hanging, params, "hanging"),
      ...param(s.cart, params, "cart"),
      ...(!(Number(s.length) > 0.2 && Number(s.length) <= 3) ? ["stage.length must be 0.2..3 m"] : []),
      ...(!(spec.config as { reveal?: string }).reveal ? ["track needs a reveal (time) param to play the run"] : []),
    ],
  },
};

export function checkStage(spec: SceneSpecV2): string[] {
  if (!spec.stage) return [];
  const st = STAGES[spec.stage.kind];
  if (!st) return [`unknown stage "${spec.stage.kind}"`];
  if (st.rig !== spec.rig) return [`stage ${spec.stage.kind} presents the ${st.rig} rig, not ${spec.rig}`];
  return st.check(spec.stage, new Set(spec.params.map((p) => p.name)), spec);
}
