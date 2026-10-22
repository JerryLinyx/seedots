// 3D labs: the same specs and gates as every other case, plus a `stage` that presents the rig in 3D.

import type { Case } from "./cases.ts";
import type { ParamDef } from "./spec.ts";

const range = (name: string, label: string, min: number, max: number, step: number, value: number, unit?: string): ParamDef =>
  ({ name, label, min, max, step, value, ...(unit ? { unit } : {}) });

const HILLS = "900*exp(-((x-1.4)^2 + (y-0.4)^2)/1.1) + 650*exp(-((x+1.5)^2 + (y+0.2)^2)/0.9) + 80";

export const CASES_3D: Case[] = [
  {
    id: "terrain-3d", part: "B", subject: "Geography", source: "Contour 3D · how contour lines form",
    spec: {
      version: 2, rig: "field", title: "How contour lines form",
      prompt: "Raise the blue water-level plane through the land: where it meets the ground is a contour line. Then walk the red pin over the hills.",
      params: [
        range("level", "Slice height", 100, 1000, 10, 300, "m"),
        { name: "dz", label: "Contour interval", type: "seg", value: 100, options: [[50, "50 m"], [100, "100 m"], [200, "200 m"]] },
        range("px", "Walker x", -3, 3, 0.02, 0, "km"),
        range("py", "Walker y", -2, 2, 0.02, -1.2, "km"),
      ],
      controls: ["level", "dz"],
      config: { h: HILLS, x: [-3, 3], y: [-2, 2], levels: "dz", label: "height (m)", probe: { x: "px", y: "py", drag: { x: "px", y: "py" } } },
      stage: { kind: "terrain", slice: "level", exaggeration: 1.1 },
      play: { param: "level", seconds: 6 },
      readouts: [{ label: "walker's height", value: "height", digits: 0, unit: "m" }, { label: "slope underfoot", value: "slope", digits: 0, unit: "m per km" }],
      steps: ["Play the slice from the valley floor to the peaks.", "Where the slice meets the ground, read the contour it makes on the map.", "Drag the pin: where the lines bunch up, the ground is steep."],
      tasks: [
        { text: "Stand on the higher summit (over 950 m)", check: { of: "height", op: ">", value: 950 } },
        { text: "Find a steep slope (over 600 m per km)", check: { of: "slope", op: ">", value: 600 } },
      ],
      predict: { question: "If the walker climbs to the top of the east hill (x = 1.4, y = 0.4), what happens to the slope underfoot?", set: { px: 1.4, py: 0.4 }, observe: "slope", kind: "change" },
    },
  },
  {
    id: "profile-3d", part: "B", subject: "Geography", source: "Contour 3D · terrain profile",
    spec: {
      version: 2, rig: "field", title: "Cutting a profile through the hills",
      prompt: "The red curtain stands on the line A → B; its top edge is the profile drawn in the chart below.",
      params: [range("ya", "A's y", -2, 2, 0.05, -1.6, "km"), range("yb", "B's y", -2, 2, 0.05, -1.6, "km")],
      config: { h: HILLS, x: [-3, 3], y: [-2, 2], levels: "100", label: "height (m)", profile: { x1: "-2.9", y1: "ya", x2: "2.9", y2: "yb" } },
      stage: { kind: "terrain", exaggeration: 1.1 },
      readouts: [{ label: "total climb", value: "climb", digits: 0, unit: "m" }, { label: "relief", value: "relief", digits: 0, unit: "m" }],
      tasks: [{ text: "Run the line over both summits", check: { of: "relief", op: ">", value: 880 } }],
      predict: { question: "If the line moves up through the middle of the map (both ends at y = 0.2), what happens to the climb?", set: { ya: 0.2, yb: 0.2 }, observe: "climb", kind: "change" },
    },
  },
  {
    id: "loss-3d", part: "B", subject: "Machine learning", source: "Gradient descent on a loss surface (reuses the terrain view)",
    spec: {
      version: 2, rig: "field", title: "Gradient descent on a loss surface",
      prompt: "The loss is a long, narrow valley. Each step goes downhill by the learning rate times the slope. Watch the path on the surface.",
      params: [range("lr", "Learning rate", 0.02, 0.6, 0.01, 0.1)],
      config: { h: "x^2/4 + 2*y^2", x: [-3, 3], y: [-2, 2], levels: "0.5", label: "loss", descent: { x0: "-2.6", y0: "1.5", rate: "lr", steps: 40 } },
      stage: { kind: "terrain", exaggeration: 0.7 },
      readouts: [{ label: "loss after 40 steps", value: "final_h", digits: 4 }],
      tasks: [{ text: "Reach a loss below 0.01 in 40 steps", check: { of: "final_h", op: "<", value: 0.01 } }],
      predict: { question: "If the learning rate is raised to 0.55, what happens to the descent?", set: { lr: 0.55 }, observe: "behaviour", kind: "category" },
    },
  },
  {
    id: "track-3d", part: "B", subject: "Physics", source: "MotionLab · Newton's second law with a ticker timer",
    spec: {
      version: 2, rig: "particle", title: "Newton's second law on a track",
      prompt: "A hanging mass m pulls a cart of mass M along a level track. The ticker timer prints a dot every 0.02 s on the tape. Run it, then record a against the pulling force for several m.",
      params: [
        range("m", "Hanging mass m", 0.01, 0.1, 0.01, 0.03, "kg"),
        range("M", "Cart mass M", 0.25, 1, 0.25, 0.5, "kg"),
        range("time", "Time", 0, 3, 0.005, 0, "s"),
      ],
      controls: ["m", "M"],
      config: { start: { x: "0", y: "0", vx: "0", vy: "0" }, ax: "m*9.8/(M + m)", ay: "0", dt: 0.002, duration: 3, stop_x: "0.9", views: ["x-t", "v-t"], reveal: "time", x_label: "x (m)" },
      stage: { kind: "track", length: 1.2, hanging: "m", cart: "M" },
      play: { param: "time", to: 3, seconds: 3 },
      record: { x: "m*9.8", y: "2*range/flight_time^2", x_label: "pull mg (N)", y_label: "a (m/s²)" },
      readouts: [{ label: "time to the end", value: "flight_time", digits: 3, unit: "s" }, { label: "a from the run", value: "2*range/flight_time^2", digits: 3, unit: "m/s²" }, { label: "mg / (M + m)", value: "m*9.8/(M + m)", digits: 3, unit: "m/s²" }],
      steps: ["Press Play to release the cart and watch the tape.", "Change m, run again, and Record point each time.", "The slope of a against mg is 1 / (M + m)."],
      tasks: [{ text: "Get the cart to the end in under 1 s", check: { of: "flight_time", op: "<", value: 1 } }],
      predict: { question: "If the hanging mass is doubled to 0.06 kg, what happens to the time the cart takes to reach the end?", set: { m: 0.06 }, observe: "flight_time", kind: "change" },
    },
  },
];
