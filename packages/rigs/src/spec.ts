// Scene spec v2: a scene is data. A rig (prebuilt, hand-written) does the drawing and the maths;
// the spec only chooses the rig, its formulas, the controls and the learning steps around it.
// Formulas use the scene expression language (lib/expr.ts), so a spec never carries code.

export type ParamDef = {
  name: string;
  label: string;
  type?: "range" | "toggle" | "seg"; // default range
  min?: number;
  max?: number;
  step?: number;
  value: number;
  options?: [number, string][]; // seg
  unit?: string;
};

/** A readout shows an observable, or a formula over params and numeric observables. */
export type Readout = { label: string; value: string; digits?: number; unit?: string };

/** A task is ticked when an observable crosses a threshold. */
export type Task = { text: string; check: { of: string; op: "<" | ">" | "near"; value: number; tol?: number } };

export type Predict = {
  question: string;
  set: Record<string, number>; // the change the learner will make
  observe: string; // an observable of the rig
  kind: "change" | "category"; // numeric change (up/down/same) or the rig's category value
};

export type SceneSpecV2 = {
  version: 2;
  rig: string;
  title: string;
  prompt: string;
  params: ParamDef[];
  controls?: string[]; // which params get a control; default all
  config: Record<string, unknown>; // rig-specific
  readouts?: Readout[];
  play?: { param: string; to?: number; seconds?: number }; // animate one param from its value to `to`
  steps?: string[]; // what to do, in order
  tasks?: Task[];
  record?: { x: string; y: string; x_label: string; y_label: string }; // data dock: record points, fit a line
  predict: Predict;
  stage?: { kind: string } & Record<string, unknown>; // a 3D presentation of the same rig (lib/lab3d)
};

export type Env = Record<string, number>;
export type Observed = Record<string, number | string>;
