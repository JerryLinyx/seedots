import { crossRig } from "./cross.ts";
import { distributionRig } from "./distribution.ts";
import { fieldRig } from "./field.ts";
import { functionRig } from "./function.ts";
import { iterationRig } from "./iteration.ts";
import { opticsRig } from "./optics.ts";
import { particleRig } from "./particle.ts";
import type { Rig } from "./runtime.ts";
import { samplingRig } from "./sampling.ts";
import { stocksRig } from "./stocks.ts";
import { sunRig } from "./sun.ts";
import { timelineRig } from "./timeline.ts";
import { vectorsRig } from "./vectors.ts";

export const RIGS: Record<string, Rig> = Object.fromEntries(
  [functionRig, iterationRig, vectorsRig, distributionRig, samplingRig, fieldRig, particleRig, opticsRig, stocksRig, crossRig, sunRig, timelineRig].map((r) => [r.id, r]),
);

export * from "./runtime.ts";
export type * from "./spec.ts";
