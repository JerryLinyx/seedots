// A 3D view presents an existing rig in three dimensions. The rig still does the maths and the gates still
// check the spec; a view only builds objects from the spec and moves them when params change.

import type { Env, Observed, SceneSpecV2 } from "@seedots/rigs/spec.ts";
import type { Stage } from "./stage";

export type ViewCtx = {
  stage: Stage;
  /** Change params (clamped by the host), e.g. from a drag in the scene. */
  set(upd: Env): void;
  /** True while the learner has not predicted yet: drags are refused. */
  locked(): boolean;
};

export type ViewHandle = { update(env: Env, obs: Observed): void; dispose(): void };

export type View3D = {
  kind: string;
  rig: string; // the rig this view presents
  label: string;
  hint?: string; // what the learner can grab in the scene
  build(ctx: ViewCtx, spec: SceneSpecV2, env: Env): ViewHandle;
};
