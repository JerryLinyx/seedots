// Feasibility cases for the rig templates. Part A rewrites the 13 L1 scenes the real model generated
// (data/learning.sqlite3, 2026-10-20) as v2 specs; part B follows chapter patterns seen in WeduLab
// (docs/research/2026-10-20-wedulab-teardown.md). Every case is pure data.

import type { SceneSpecV2 } from "./spec.ts";

export const SUBJECTS = ["Math", "Physics", "Chemistry", "Biology", "Geography", "History", "Economics", "Machine learning"] as const;
export type Subject = (typeof SUBJECTS)[number];
export type Case = { id: string; part: "A" | "B"; subject: Subject; was?: string; source: string; spec: SceneSpecV2 };

const range = (name: string, label: string, min: number, max: number, step: number, value: number, unit?: string) =>
  ({ name, label, min, max, step, value, ...(unit ? { unit } : {}) });

export const CASES: Case[] = [
  /* ================================================================ A: our generated L1 scenes */
  {
    id: "cosine-angle", part: "A", subject: "Machine learning", was: "function_plot (cos(theta) + 0*x, a flat line)", source: "Cosine similarity and the angle between vectors",
    spec: {
      version: 2, rig: "vectors", title: "Cosine similarity and the angle between vectors",
      prompt: "Drag the tip of b around the circle and watch the cosine similarity between a and b.",
      params: [range("theta", "Angle θ", 0, 3.14, 0.01, 1.05, "rad")],
      config: { extent: 1.4, unit_circle: true, pairs: [["a", "b"]], vectors: [
        { name: "a", x: "1", y: "0" },
        { name: "b", x: "cos(theta)", y: "sin(theta)", drag: { angle: "theta" } },
      ] },
      readouts: [{ label: "cos(a, b)", value: "cos_a_b", digits: 3 }, { label: "angle", value: "angle_a_b", digits: 1, unit: "°" }, { label: "a · b", value: "dot_a_b", digits: 3 }],
      tasks: [
        { text: "Make a and b orthogonal (cosine 0)", check: { of: "cos_a_b", op: "near", value: 0, tol: 0.03 } },
        { text: "Make them point mostly in opposite directions (cosine below −0.5)", check: { of: "cos_a_b", op: "<", value: -0.5 } },
      ],
      predict: { question: "What happens to the cosine similarity when the angle grows to 120° (θ ≈ 2.09)?", set: { theta: 2.09 }, observe: "cos_a_b", kind: "change" },
    },
  },
  {
    id: "cosine-embedding", part: "A", subject: "Machine learning", was: "function_plot (cos(x − a))", source: "Cosine similarity in the shared embedding space",
    spec: {
      version: 2, rig: "vectors", title: "Cosine similarity in the shared embedding space",
      prompt: "Rotate the image difference vector d and compare its similarity to three text directions.",
      params: [range("a", "Direction of d", -3.14, 3.14, 0.01, 0)],
      config: { extent: 1.4, unit_circle: true, pairs: [["d", "t1"], ["d", "t2"], ["d", "t3"]], vectors: [
        { name: "d", label: "d (image change)", x: "cos(a)", y: "sin(a)", drag: { angle: "a" } },
        { name: "t1", label: "“a hat”", x: "1", y: "0" },
        { name: "t2", label: "“a red hat”", x: "cos(0.9)", y: "sin(0.9)" },
        { name: "t3", label: "“a dog”", x: "cos(2.4)", y: "sin(2.4)" },
      ] },
      readouts: [{ label: "sim(d, “a hat”)", value: "cos_d_t1", digits: 3 }, { label: "sim(d, “a red hat”)", value: "cos_d_t2", digits: 3 }, { label: "sim(d, “a dog”)", value: "cos_d_t3", digits: 3 }],
      tasks: [{ text: "Point d so that “a red hat” is the best match", check: { of: "cos_d_t2", op: ">", value: 0.97 } }],
      predict: { question: "If d rotates to a = 1, what happens to its similarity with “a hat”?", set: { a: 1 }, observe: "cos_d_t1", kind: "change" },
    },
  },
  {
    id: "ddpm-noise", part: "A", subject: "Machine learning", was: "iteration", source: "Injected noise in DDPM sampling",
    spec: {
      version: 2, rig: "iteration", title: "Injected noise in DDPM sampling",
      prompt: "Each step pulls the sample toward 3 and adds noise. Step through a run, then change the noise.",
      params: [range("noise", "Injected noise", 0, 1, 0.05, 0.3), range("k", "Steps shown", 0, 60, 1, 60)],
      controls: ["noise"],
      config: { start: "0.5", update: "x - 0.5*(x - 3) + noise*sin(n)", steps: 60, x: { min: -2, max: 8, label: "sample" }, state_label: "sample value", target: "3", reveal: "k" },
      play: { param: "k", seconds: 3 },
      readouts: [{ label: "final sample", value: "final" }, { label: "distance from 3", value: "gap" }],
      predict: { question: "What happens to the trajectory if the injected noise is set to 0?", set: { noise: 0 }, observe: "behaviour", kind: "category" },
    },
  },
  {
    id: "score-time", part: "A", subject: "Machine learning", was: "function_plot", source: "Time conditioning of the score function",
    spec: {
      version: 2, rig: "function", title: "Time conditioning of the score function",
      prompt: "Lower the noise level t and watch the learned score sharpen around the two modes at ±2. The dashed curve is t = 1.",
      params: [range("t", "Noise level t", 0.1, 1, 0.05, 1)],
      config: {
        x: { min: -5, max: 5, label: "x" }, y_label: "s(x, t)",
        curves: [{ expr: "((-(x+2)/(t+0.25))*exp(-(x+2)^2/(2*(t+0.25))) + (-(x-2)/(t+0.25))*exp(-(x-2)^2/(2*(t+0.25)))) / (exp(-(x+2)^2/(2*(t+0.25))) + exp(-(x-2)^2/(2*(t+0.25))))", label: "learned score" }],
        marks: [{ kind: "ghost" }, { kind: "point", name: "score", at: "1.5" }],
      },
      readouts: [{ label: "score at x = 1.5", value: "score", digits: 3 }],
      predict: { question: "If you set t to 0.1, what happens to the score at x = 1.5?", set: { t: 0.1 }, observe: "score", kind: "change" },
    },
  },
  {
    id: "step-size", part: "A", subject: "Machine learning", was: "iteration", source: "Step-size scaling in deterministic diffusion",
    spec: {
      version: 2, rig: "iteration", title: "Step-size scaling",
      prompt: "Each update moves x downhill on (x − 3)². Change the step size and play the run.",
      params: [range("h", "Step size", 0.02, 1.1, 0.01, 0.1), range("k", "Steps shown", 0, 30, 1, 30)],
      controls: ["h"],
      config: { start: "0.5", update: "x - h*2*(x - 3)", steps: 30, objective: "(x - 3)^2", x: { min: -5, max: 10, label: "x" }, target: "3", reveal: "k" },
      play: { param: "k", seconds: 3 },
      readouts: [{ label: "steps to settle", value: "settle_step", digits: 0 }, { label: "final x", value: "final" }],
      tasks: [{ text: "Find a step size that settles in under 5 steps", check: { of: "settle_step", op: "<", value: 5 } }],
      predict: { question: "What happens to the updates if the step size is 1.05?", set: { h: 1.05 }, observe: "behaviour", kind: "category" },
    },
  },
  {
    id: "class-cond", part: "A", subject: "Machine learning", was: "iteration", source: "Class conditioning strength",
    spec: {
      version: 2, rig: "iteration", title: "Class conditioning strength",
      prompt: "The point balances a pull toward 0 against a class pull toward 3 of strength w.",
      params: [range("w", "Conditioning strength w", 0, 2, 0.1, 0.2)],
      config: { start: "0", update: "x + 0.1*(w*(3 - x) - x)", steps: 60, objective: "0.5*(x^2 + w*(x-3)^2)", x: { min: -1, max: 6, label: "position" }, target: "3*w/(1 + w)" },
      readouts: [{ label: "where it settles", value: "final" }],
      predict: { question: "What happens to the final point if the strength is set to 1?", set: { w: 1 }, observe: "final", kind: "change" },
    },
  },
  {
    id: "guidance", part: "A", subject: "Machine learning", was: "iteration", source: "Guidance scale in classifier-free guidance",
    spec: {
      version: 2, rig: "iteration", title: "Guidance scale",
      prompt: "Try several guidance scales, record where the sample ends each time, and look at the line through your points.",
      params: [range("alpha", "Guidance scale α", 0, 4, 0.1, 2)],
      config: { start: "0", update: "x + 0.1*(2*alpha - x)", steps: 80, x: { min: -1, max: 9, label: "x" }, state_label: "x", target: "2*alpha" },
      record: { x: "alpha", y: "final", x_label: "α", y_label: "final x" },
      readouts: [{ label: "final x", value: "final" }],
      predict: { question: "What happens to the final point when α is increased to 4?", set: { alpha: 4 }, observe: "final", kind: "change" },
    },
  },
  {
    id: "bet-ev", part: "A", subject: "Economics", was: "function_plot (EV as a line)", source: "Expected value of a mispriced bet",
    spec: {
      version: 2, rig: "sampling", title: "Expected value of a mispriced bet",
      prompt: "Each bet wins $100 with probability p and loses $1 otherwise. Play the bets and compare your average with the expected value.",
      params: [range("p", "Chance of winning p", 0, 1, 0.01, 0.1), range("n", "Bets placed", 0, 2000, 10, 200)],
      config: { outcomes: [{ label: "win +$100", p: "p", value: "100" }, { label: "lose −$1", p: "1 - p", value: "-1" }], draws: "n", max_draws: 2000 },
      play: { param: "n", seconds: 4 },
      readouts: [{ label: "expected value", value: "expected" }, { label: "your average", value: "mean" }],
      tasks: [{ text: "Find the p where the bet only just breaks even", check: { of: "expected", op: "near", value: 0, tol: 0.2 } }],
      predict: { question: "What happens to the expected value if p rises to 0.5?", set: { p: 0.5 }, observe: "expected", kind: "change" },
    },
  },
  {
    id: "var-sum", part: "A", subject: "Machine learning", was: "function_plot", source: "Variance of sum vs difference (IMAX)",
    spec: {
      version: 2, rig: "function", title: "Variance of the sum and the difference",
      prompt: "Two outputs with variance v and correlation x. Record Var(A+B) at x = 0.5 for several v.",
      params: [range("v", "Output variance v", 0, 2, 0.1, 1)],
      config: {
        x: { min: -1, max: 1, label: "correlation" }, y: { min: 0, max: 8, label: "variance" },
        curves: [{ expr: "2*v*(1+x)", label: "Var(A+B)" }, { expr: "2*v*(1-x)", label: "Var(A−B)" }],
        marks: [{ kind: "point", name: "var_sum", at: "0.5" }],
      },
      record: { x: "v", y: "var_sum", x_label: "v", y_label: "Var(A+B) at 0.5" },
      readouts: [{ label: "Var(A+B) at x = 0.5", value: "var_sum" }],
      predict: { question: "What happens to Var(A+B) at x = 0.5 when v drops to 0.2?", set: { v: 0.2 }, observe: "var_sum", kind: "change" },
    },
  },
  {
    id: "infonce-temp", part: "A", subject: "Machine learning", was: "function_plot (one softmax entry as a curve)", source: "InfoNCE temperature and softmax sharpness",
    spec: {
      version: 2, rig: "distribution", title: "InfoNCE temperature",
      prompt: "One positive key with similarity s and two negatives. Change the temperature τ and watch the probabilities.",
      params: [range("s", "Similarity of the positive s", -5, 5, 0.1, 2), range("tau", "Temperature τ", 0.1, 2, 0.05, 0.5)],
      config: { categories: ["positive", "negative 1", "negative 2"], series: [{ name: "q", label: "softmax", scores: ["s", "1", "0"], temperature: "tau" }] },
      readouts: [{ label: "P(positive)", value: "q_p0", digits: 3 }, { label: "entropy", value: "q_entropy", unit: "bits" }],
      tasks: [{ text: "Make the model almost certain of the positive (above 0.95)", check: { of: "q_p0", op: ">", value: 0.95 } }],
      predict: { question: "What happens to P(positive) when τ is increased to 2?", set: { tau: 2 }, observe: "q_p0", kind: "change" },
    },
  },
  {
    id: "moco-queue", part: "A", subject: "Machine learning", was: "function_plot", source: "Queue-based dictionary",
    spec: {
      version: 2, rig: "function", title: "A queue of negatives",
      prompt: "The queue holds at most 16 negatives. Change the mini-batch size and see how fast it fills.",
      params: [range("b", "Mini-batch size", 1, 8, 1, 4)],
      config: {
        x: { min: 0, max: 6, label: "training batches" }, y: { min: 0, max: 50, label: "negatives" },
        curves: [{ expr: "min(x*b, 16)", label: "in the queue" }, { expr: "b*x", label: "without a cap" }],
        marks: [{ kind: "point", name: "occ", at: "3" }],
      },
      readouts: [{ label: "queue after 3 batches", value: "occ", digits: 0 }],
      predict: { question: "What will the queue hold after 3 batches if the batch size is 8?", set: { b: 8 }, observe: "occ", kind: "change" },
    },
  },
  {
    id: "distill-temp", part: "A", subject: "Machine learning", was: "function_plot (two sigmoids)", source: "Temperature in softmax distillation",
    spec: {
      version: 2, rig: "distribution", title: "Temperature in distillation",
      prompt: "Teacher and student see the same logits (2, 1, 0.2) at their own temperatures.",
      params: [range("t", "Teacher temperature", 0.1, 3, 0.1, 0.7), range("s", "Student temperature", 0.1, 3, 0.1, 1.5)],
      config: { categories: ["class 1", "class 2", "class 3"], series: [
        { name: "teacher", label: "teacher", scores: ["2", "1", "0.2"], temperature: "t" },
        { name: "student", label: "student", scores: ["2", "1", "0.2"], temperature: "s" },
      ] },
      readouts: [{ label: "teacher top prob", value: "teacher_max", digits: 3 }, { label: "student top prob", value: "student_max", digits: 3 }, { label: "gap", value: "abs(teacher_p0 - student_p0)", digits: 3 }],
      tasks: [{ text: "Match the student to the teacher", check: { of: "abs(teacher_p0 - student_p0)", op: "<", value: 0.01 } }],
      predict: { question: "What happens to the teacher's top probability when its temperature rises to 2?", set: { t: 2 }, observe: "teacher_max", kind: "change" },
    },
  },
  {
    id: "redundancy", part: "A", subject: "Machine learning", was: "function_plot", source: "Why non-redundant dimensions matter",
    spec: {
      version: 2, rig: "function", title: "Shared variance and correlation",
      prompt: "Two embedding dimensions share some variance and each has its own. Change the unique part.",
      params: [range("u", "Unique variance", 0.1, 2, 0.1, 1)],
      config: { x: { min: 0, max: 2, label: "shared variance" }, y: { min: 0, max: 1, label: "correlation" }, curves: [{ expr: "x / (x + u)", label: "correlation" }], marks: [{ kind: "point", name: "corr", at: "1" }] },
      readouts: [{ label: "correlation at shared = 1", value: "corr", digits: 3 }],
      predict: { question: "What happens to the correlation at shared variance 1 if the unique variance drops to 0.1?", set: { u: 0.1 }, observe: "corr", kind: "change" },
    },
  },

  /* ================================================================ B: WeduLab chapter patterns */
  {
    id: "transform", part: "B", subject: "Math", source: "FuncLab · Transformations",
    spec: {
      version: 2, rig: "function", title: "Moving a sine wave",
      prompt: "y = a·sin(b(x − h)) + k. The dashed curve is where you started; the dot is the first peak.",
      params: [range("a", "Vertical scale a", -3, 3, 0.1, 1), range("b", "Horizontal squeeze b", 0.25, 4, 0.05, 1), range("h", "Shift right h", -4, 4, 0.1, 0), range("k", "Shift up k", -3, 3, 0.1, 0)],
      config: { x: { min: -6, max: 6, label: "x" }, y: { min: -5, max: 5, label: "y" }, curves: [{ expr: "a*sin(b*(x - h)) + k", label: "y" }], marks: [{ kind: "ghost" }, { kind: "point", name: "peak", at: "h + pi/(2*b)" }] },
      steps: ["Move the peak with h and k.", "Squeeze the wave with b.", "Flip it with a negative a."],
      tasks: [
        { text: "Put the first peak at x = 2", check: { of: "peak_x", op: "near", value: 2, tol: 0.08 } },
        { text: "Make that point reach y = 3", check: { of: "peak", op: "near", value: 3, tol: 0.08 } },
      ],
      predict: { question: "If b doubles to 2, where does the first peak move?", set: { b: 2 }, observe: "peak_x", kind: "change" },
    },
  },
  {
    id: "secant", part: "B", subject: "Math", source: "FuncLab · Secant to tangent",
    spec: {
      version: 2, rig: "function", title: "From secant to tangent",
      prompt: "The secant joins x₀ and x₀ + h. Shrink h and compare its slope with the tangent's.",
      params: [range("x0", "x₀", -2, 2, 0.1, 1), range("h", "Gap h", 0.01, 2, 0.01, 1.5)],
      config: { x: { min: -3, max: 3, label: "x" }, y: { min: -3, max: 4, label: "y" }, curves: [{ expr: "x^3/3 - x", label: "f" }], marks: [{ kind: "secant", name: "sec", a: "x0", b: "x0 + h" }, { kind: "tangent", name: "tan", at: "x0" }] },
      play: { param: "h", to: 0.01, seconds: 4 },
      readouts: [{ label: "secant slope", value: "sec", digits: 3 }, { label: "tangent slope", value: "tan", digits: 3 }, { label: "difference", value: "abs(sec - tan)", digits: 3 }],
      tasks: [{ text: "Get the secant within 0.05 of the tangent", check: { of: "abs(sec - tan)", op: "<", value: 0.05 } }],
      predict: { question: "What happens to the secant's slope as h shrinks to 0.01?", set: { h: 0.01 }, observe: "sec", kind: "change" },
    },
  },
  {
    id: "derivative-x2", part: "B", subject: "Math", source: "MotionLab pattern · record and fit",
    spec: {
      version: 2, rig: "function", title: "Find the slope rule of x²",
      prompt: "Drag the point along y = x². Record the tangent's slope at several places and look at the line through your data.",
      params: [range("x0", "x₀", -2, 2, 0.1, 1)],
      config: { x: { min: -2.5, max: 2.5, label: "x" }, y: { min: -1, max: 6, label: "y" }, curves: [{ expr: "x^2", label: "x²" }], marks: [{ kind: "tangent", name: "tan", at: "x0" }, { kind: "point", name: "pt", at: "x0", drag: "x0" }] },
      record: { x: "x0", y: "tan", x_label: "x₀", y_label: "slope" },
      readouts: [{ label: "tangent slope", value: "tan", digits: 3 }],
      tasks: [{ text: "Find where the tangent is flat", check: { of: "tan", op: "near", value: 0, tol: 0.05 } }],
      predict: { question: "Moving the point from x₀ = 1 to x₀ = 2, what happens to the slope?", set: { x0: 2 }, observe: "tan", kind: "change" },
    },
  },
  {
    id: "riemann", part: "B", subject: "Math", source: "FuncLab · Riemann sums",
    spec: {
      version: 2, rig: "function", title: "Riemann sums",
      prompt: "Rectangles under y = x² on [0, 2], using the left edge of each strip. Add more strips.",
      params: [range("n", "Strips n", 1, 200, 1, 4)],
      config: { x: { min: -0.2, max: 2.2, label: "x" }, y: { min: -0.3, max: 4.5, label: "y" }, curves: [{ expr: "x^2", label: "x²" }], marks: [{ kind: "riemann", name: "R", a: "0", b: "2", n: "n", rule: "left" }] },
      play: { param: "n", seconds: 5 },
      readouts: [{ label: "sum of rectangles", value: "R", digits: 4 }, { label: "exact area", value: "R_exact", digits: 4 }, { label: "error", value: "R_error", digits: 4 }],
      tasks: [{ text: "Get the error below 0.05", check: { of: "R_error", op: "<", value: 0.05 } }],
      predict: { question: "What happens to the error when you use 40 strips?", set: { n: 40 }, observe: "R_error", kind: "change" },
    },
  },
  {
    id: "matrix", part: "B", subject: "Math", source: "GeoSpace · vectors; linear maps",
    spec: {
      version: 2, rig: "vectors", title: "What a matrix does to the plane",
      prompt: "The shaded square is where the unit square lands under [[a, b], [c, d]].",
      params: [range("a", "a", -2, 2, 0.1, 1), range("b", "b", -2, 2, 0.1, 0), range("c", "c", -2, 2, 0.1, 0), range("d", "d", -2, 2, 0.1, 1)],
      config: { extent: 3, matrix: { a: "a", b: "b", c: "c", d: "d", apply_to: ["i", "j"] }, vectors: [{ name: "i", label: "A·e₁", x: "1", y: "0" }, { name: "j", label: "A·e₂", x: "0", y: "1" }] },
      readouts: [{ label: "determinant (area scale)", value: "det" }],
      tasks: [
        { text: "Squash the plane flat (determinant 0)", check: { of: "det", op: "near", value: 0, tol: 0.02 } },
        { text: "Flip the plane over (negative determinant)", check: { of: "det", op: "<", value: 0 } },
      ],
      predict: { question: "If d drops to 0.5, what happens to the area of the square?", set: { d: 0.5 }, observe: "det", kind: "change" },
    },
  },
  {
    id: "projection", part: "B", subject: "Math", source: "GeoSpace · vectors",
    spec: {
      version: 2, rig: "vectors", title: "Projection onto a direction",
      prompt: "Drag a and b. The thick segment is how much of a points along b.",
      params: [range("ax", "a x", -3, 3, 0.1, 2), range("ay", "a y", -3, 3, 0.1, 1.5), range("bx", "b x", -3, 3, 0.1, 2.5), range("by", "b y", -3, 3, 0.1, 0.5)],
      controls: [],
      config: { extent: 3.2, project: ["a", "b"], pairs: [["a", "b"]], vectors: [{ name: "a", x: "ax", y: "ay", drag: { x: "ax", y: "ay" } }, { name: "b", x: "bx", y: "by", drag: { x: "bx", y: "by" } }] },
      readouts: [{ label: "projection of a on b", value: "proj" }, { label: "cos(a, b)", value: "cos_a_b", digits: 3 }],
      tasks: [{ text: "Make the projection zero", check: { of: "proj", op: "near", value: 0, tol: 0.05 } }],
      predict: { question: "If a's tip moves left to x = −1, what happens to its projection on b?", set: { ax: -1 }, observe: "proj", kind: "change" },
    },
  },
  {
    id: "dice-lln", part: "B", subject: "Math", source: "PeaLab pattern · counting outcomes",
    spec: {
      version: 2, rig: "sampling", title: "The law of large numbers",
      prompt: "Roll a fair die again and again. Watch the running mean and the counts.",
      params: [range("n", "Rolls", 0, 3000, 10, 20)],
      config: { outcomes: ["1", "2", "3", "4", "5", "6"].map((v) => ({ label: v, p: "1", value: v })), draws: "n", max_draws: 3000, seed: 7 },
      play: { param: "n", seconds: 5 },
      readouts: [{ label: "running mean", value: "mean", digits: 3 }, { label: "expected", value: "expected", digits: 3 }, { label: "gap", value: "gap", digits: 3 }],
      tasks: [{ text: "Get the running mean within 0.05 of 3.5", check: { of: "gap", op: "<", value: 0.05 } }],
      predict: { question: "After 3000 rolls instead of 20, what happens to the gap between the running mean and 3.5?", set: { n: 3000 }, observe: "gap", kind: "change" },
    },
  },
  {
    id: "mendel-chi2", part: "B", subject: "Biology", source: "PeaLab · 3 : 1 and the chi-square test",
    spec: {
      version: 2, rig: "sampling", title: "Does it fit 3 : 1?",
      prompt: "Peas come out round with probability q. Mendel's hypothesis says 3 round : 1 wrinkled. Test it.",
      params: [range("q", "True chance of round q", 0.5, 0.95, 0.01, 0.75), range("n", "Peas counted", 0, 1000, 10, 100)],
      config: { outcomes: [{ label: "round", p: "q", expect: "3" }, { label: "wrinkled", p: "1 - q", expect: "1" }], draws: "n", max_draws: 1000, seed: 11, view: ["counts"] },
      readouts: [{ label: "χ²", value: "chi2", digits: 2 }, { label: "verdict (5%)", value: "fit" }],
      tasks: [{ text: "Find a true q that the test rejects", check: { of: "chi2", op: ">", value: 3.841 } }],
      predict: { question: "If the true chance of round drops to 0.5, what does the test say about 3 : 1?", set: { q: 0.5 }, observe: "fit", kind: "category" },
    },
  },
];

/* ================================================================ broken on purpose: the gates must reject each */
const of = (id: string) => structuredClone(CASES.find((c) => c.id === id)!.spec);
const broken = (why: string, id: string, edit: (s: SceneSpecV2) => void) => {
  const spec = of(id);
  edit(spec);
  return { why, spec };
};

export const BROKEN: { why: string; spec: SceneSpecV2 }[] = [
  broken("formula reads an unknown name", "redundancy", (s) => ((s.config.curves as { expr: string }[])[0].expr = "x / (x + q)")),
  broken("formula does not parse", "score-time", (s) => ((s.config.curves as { expr: string }[])[0].expr = "exp(-x^2")),
  broken("task cannot be reached with the controls", "riemann", (s) => (s.params[0].max = 60)),
  broken("task is already done at the start", "matrix", (s) => (s.tasks![1].check = { of: "det", op: ">", value: 0 })),
  broken("predicted change makes no visible difference", "infonce-temp", (s) => (s.predict.set = { tau: 0.5 })),
  broken("predicted value is not on the slider", "secant", (s) => (s.predict.set = { h: 0.005 })),
  broken("predict watches an observable the rig does not have", "bet-ev", (s) => (s.predict.observe = "variance")),
  broken("scores do not match the categories", "distill-temp", (s) => ((s.config.series as { scores: string[] }[])[0].scores.pop())),
  broken("unknown rig", "guidance", (s) => (s.rig = "pendulum")),
  broken("a param range makes the curve undefined", "redundancy", (s) => (s.params[0].min = -1)),
];
