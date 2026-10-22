import { benchView } from "./bench";
import { launcherView } from "./launcher";
import { orbitView } from "./orbit";
import { pendulumView, springView } from "./oscillators";
import { terrainView } from "./terrain";
import { trackView } from "./track";
import type { View3D } from "./types";

export const VIEWS: Record<string, View3D> = Object.fromEntries(
  [terrainView, trackView, pendulumView, springView, launcherView, benchView, orbitView].map((v) => [v.kind, v]),
);
