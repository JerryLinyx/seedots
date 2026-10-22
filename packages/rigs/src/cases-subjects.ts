// Subject sets: physics, chemistry, biology, geography, history and economics, each built from the shared rigs.
// Models are teaching models: where a case uses real data (timeline), the source is named in the spec.

import type { Case } from "./cases.ts";
import type { ParamDef } from "./spec.ts";

const range = (name: string, label: string, min: number, max: number, step: number, value: number, unit?: string): ParamDef =>
  ({ name, label, min, max, step, value, ...(unit ? { unit } : {}) });
const geno = (name: string, label: string, value: number, letter = "A"): ParamDef => ({
  name, label, type: "seg", value,
  options: [[0, `${letter}${letter}`], [1, `${letter}${letter.toLowerCase()}`], [2, `${letter.toLowerCase()}${letter.toLowerCase()}`]],
});

export const SUBJECT_CASES: Case[] = [
  /* ================================================================ physics */
  {
    id: "projectile", part: "B", subject: "Physics", source: "MotionLab · projectile",
    spec: {
      version: 2, rig: "particle", title: "Projectile motion",
      prompt: "Launch a ball at speed v₀ and angle θ (no air). Play the flight and read off how far it lands.",
      params: [range("angle", "Launch angle θ", 5, 85, 1, 30, "°"), range("v0", "Launch speed v₀", 5, 30, 1, 20, "m/s"), range("time", "Time", 0, 6, 0.02, 6, "s")],
      controls: ["angle", "v0"],
      config: { start: { x: "0", y: "0", vx: "v0*cos(angle*pi/180)", vy: "v0*sin(angle*pi/180)" }, ax: "0", ay: "-9.8", dt: 0.01, duration: 6, stop_at_ground: true, views: ["space"], reveal: "time" },
      stage: { kind: "launcher", angle: "angle" },
      play: { param: "time", seconds: 3 },
      readouts: [{ label: "range", value: "range", unit: "m" }, { label: "highest point", value: "max_height", unit: "m" }, { label: "time in the air", value: "flight_time", unit: "s" }],
      tasks: [
        { text: "Find the angle that throws furthest", check: { of: "range / (v0^2/9.8)", op: ">", value: 0.998 } },
        { text: "Throw higher than 15 m", check: { of: "max_height", op: ">", value: 15 } },
      ],
      predict: { question: "Raising the angle from 30° to 45°, what happens to the range?", set: { angle: 45 }, observe: "range", kind: "change" },
    },
  },
  {
    id: "spring", part: "B", subject: "Physics", source: "WaveLab · simple harmonic motion, damping",
    spec: {
      version: 2, rig: "particle", title: "A mass on a spring",
      prompt: "x″ = −(k/m)·x − (c/m)·x′. Change the mass, the stiffness and the damping.",
      params: [range("m", "Mass m", 0.5, 5, 0.1, 1, "kg"), range("k", "Stiffness k", 1, 20, 0.5, 4, "N/m"), range("c", "Damping c", 0, 4, 0.05, 0.2)],
      config: { start: { x: "1", y: "0", vx: "0", vy: "0" }, ax: "-(k/m)*x - (c/m)*vx", ay: "0", dt: 0.01, duration: 20, views: ["x-t"], period_of: "x" },
      stage: { kind: "spring" },
      readouts: [{ label: "measured period", value: "period", unit: "s" }, { label: "2π√(m/k)", value: "2*pi*sqrt(m/k)", unit: "s" }, { label: "swing at the end", value: "amplitude_end" }],
      tasks: [{ text: "Stop it swinging within 20 s (end swing below 0.01)", check: { of: "amplitude_end", op: "<", value: 0.01 } }],
      predict: { question: "If the mass is 4 kg instead of 1 kg, what happens to the period?", set: { m: 4 }, observe: "period", kind: "change" },
    },
  },
  {
    id: "pendulum", part: "B", subject: "Physics", source: "WaveLab · measuring g with a pendulum",
    spec: {
      version: 2, rig: "particle", title: "Measure g with a pendulum",
      prompt: "θ″ = −(g/L)·sin θ. Record the period T for several lengths L; T² against L is a line of slope 4π²/g.",
      params: [range("L", "Length L", 0.2, 2, 0.05, 1, "m"), range("theta0", "Release angle", 5, 80, 1, 10, "°")],
      config: { start: { x: "theta0*pi/180", y: "0", vx: "0", vy: "0" }, ax: "-(9.8/L)*sin(x)", ay: "0", dt: 0.005, duration: 12, views: ["x-t"], period_of: "x", y_label: "θ (rad)" },
      stage: { kind: "pendulum", length: "L" },
      record: { x: "L", y: "period^2", x_label: "L (m)", y_label: "T² (s²)" },
      readouts: [{ label: "period T", value: "period", digits: 3, unit: "s" }, { label: "g from this swing", value: "4*pi^2*L/period^2", digits: 2, unit: "m/s²" }],
      tasks: [{ text: "Swing wide enough that T is 10% longer than the small-swing value", check: { of: "period / (2*pi*sqrt(L/9.8))", op: ">", value: 1.1 } }],
      predict: { question: "If the string is 2 m instead of 1 m, what happens to the period?", set: { L: 2 }, observe: "period", kind: "change" },
    },
  },
  {
    id: "terminal", part: "B", subject: "Physics", source: "MotionLab · free fall, with air",
    spec: {
      version: 2, rig: "particle", title: "Falling through air",
      prompt: "Gravity pulls down; drag k·v² pushes back. Watch the speed level off at the terminal speed.",
      params: [range("k", "Drag coefficient k", 0.005, 0.1, 0.005, 0.02)],
      config: { start: { x: "0", y: "0", vx: "0", vy: "0" }, ax: "0", ay: "-9.8 + k*vy^2", dt: 0.01, duration: 10, views: ["v-t"] },
      readouts: [{ label: "speed after 10 s", value: "final_speed", unit: "m/s" }, { label: "terminal speed √(g/k)", value: "sqrt(9.8/k)", unit: "m/s" }],
      tasks: [{ text: "Fall slower than 15 m/s at the end", check: { of: "final_speed", op: "<", value: 15 } }],
      predict: { question: "With four times the drag (k = 0.08), what happens to the speed after 10 s?", set: { k: 0.08 }, observe: "final_speed", kind: "change" },
    },
  },
  {
    id: "lens", part: "B", subject: "Physics", source: "OpticsLab · converging lens",
    spec: {
      version: 2, rig: "optics", title: "Images from a converging lens",
      prompt: "Move the candle along the bench. Record 1/u and 1/v for a few positions: they lie on a line whose intercept is 1/f.",
      params: [range("u", "Object distance u", 0.12, 1, 0.01, 0.6, "m"), range("f", "Focal length f", 0.1, 0.3, 0.01, 0.2, "m")],
      config: { bench: "lens", f: "f", u: "u", h: "0.08", extent: 1.2 },
      stage: { kind: "bench" },
      record: { x: "inv_u", y: "inv_v", x_label: "1/u", y_label: "1/v" },
      readouts: [{ label: "image distance v", value: "v", unit: "m" }, { label: "magnification", value: "magnification" }, { label: "image", value: "image" }],
      tasks: [
        { text: "Make the image the same size as the object", check: { of: "abs(magnification) - 1", op: "near", value: 0, tol: 0.03 } },
        { text: "Use it as a magnifying glass (virtual image)", check: { of: "v", op: "<", value: 0 } },
      ],
      predict: { question: "Move the candle in to u = 0.3 m. What kind of image do you get?", set: { u: 0.3 }, observe: "image", kind: "category" },
    },
  },
  {
    id: "tir", part: "B", subject: "Physics", source: "OpticsLab · total internal reflection",
    spec: {
      version: 2, rig: "optics", title: "Total internal reflection",
      prompt: "Light goes from glass (n₁) into air (n₂). Tilt the ray and watch the refracted ray.",
      params: [range("angle", "Angle of incidence", 0, 89, 1, 30, "°"), range("n1", "n₁", 1, 2.4, 0.01, 1.5), range("n2", "n₂", 1, 2.4, 0.01, 1)],
      controls: ["angle", "n1"],
      config: { bench: "refraction", n1: "n1", n2: "n2", angle: "angle" },
      readouts: [{ label: "refracted angle", value: "refracted_angle", digits: 1, unit: "°" }, { label: "critical angle", value: "critical_angle", digits: 1, unit: "°" }],
      tasks: [{ text: "Find the critical angle", check: { of: "abs(angle - critical_angle)", op: "<", value: 1 } }],
      predict: { question: "At 50° from glass into air, what happens to the ray?", set: { angle: 50 }, observe: "ray", kind: "category" },
    },
  },
  {
    id: "interference", part: "B", subject: "Physics", source: "WaveLab · superposition",
    spec: {
      version: 2, rig: "function", title: "Two waves add up",
      prompt: "Two equal waves, the second shifted by a phase φ. Their sum is the thick curve.",
      params: [range("phi", "Phase difference φ", 0, 6.28, 0.02, 0, "rad"), range("t", "Time", 0, 6.28, 0.02, 0)],
      controls: ["phi"],
      config: {
        x: { min: 0, max: 12.6, label: "x" }, y: { min: -2.4, max: 2.4, label: "displacement" },
        curves: [{ expr: "sin(x - t) + sin(x - t + phi)", label: "sum" }, { expr: "sin(x - t)", label: "wave 1" }, { expr: "sin(x - t + phi)", label: "wave 2" }],
        marks: [{ kind: "point", name: "crest", at: "pi/2 + t" }],
      },
      play: { param: "t", seconds: 4 },
      readouts: [{ label: "sum at the marked crest", value: "crest", digits: 3 }, { label: "amplitude of the sum 2|cos(φ/2)|", value: "2*abs(cos(phi/2))", digits: 3 }],
      tasks: [{ text: "Make the waves cancel out", check: { of: "2*abs(cos(phi/2))", op: "<", value: 0.05 } }],
      predict: { question: "If the second wave is shifted by half a wavelength (φ = π), what happens to the sum at the crest?", set: { phi: 3.14 }, observe: "crest", kind: "change" },
    },
  },

  /* ================================================================ chemistry */
  {
    id: "half-life", part: "B", subject: "Chemistry", source: "Reaction rates · first order",
    spec: {
      version: 2, rig: "stocks", title: "A first-order reaction",
      prompt: "A turns into B at rate k·[A]. Change k and watch how fast A runs out.",
      params: [range("k", "Rate constant k", 0.05, 1, 0.01, 0.2, "1/s")],
      config: { stocks: [{ name: "A", label: "[A]", init: "1" }, { name: "B", label: "[B]", init: "0" }], flows: [{ from: "A", to: "B", rate: "k*A" }], end: 30, dt: 0.05, y_label: "concentration (mol/L)", t_label: "time (s)" },
      readouts: [{ label: "half-life ln2 / k", value: "log(2)/k", unit: "s" }, { label: "time to use 90% of A", value: "A_t90", unit: "s" }, { label: "[A] at 30 s", value: "A_final", digits: 3 }],
      tasks: [{ text: "Use up 90% of A within 5 s", check: { of: "A_t90", op: "<", value: 5 } }],
      predict: { question: "If k rises to 0.5, what happens to the time it takes to use up 90% of A?", set: { k: 0.5 }, observe: "A_t90", kind: "change" },
    },
  },
  {
    id: "equilibrium", part: "B", subject: "Chemistry", source: "The Micro World · reaching equilibrium",
    spec: {
      version: 2, rig: "stocks", title: "Reaching equilibrium",
      prompt: "A ⇌ B, forward rate k_f·[A], backward rate k_r·[B]. Record [B]/[A] at the end for a few rate pairs.",
      params: [range("kf", "Forward k_f", 0.05, 1, 0.05, 0.3), range("kr", "Backward k_r", 0.05, 1, 0.05, 0.3)],
      config: { stocks: [{ name: "A", label: "[A]", init: "1" }, { name: "B", label: "[B]", init: "0" }], flows: [{ from: "A", to: "B", rate: "kf*A" }, { from: "B", to: "A", rate: "kr*B" }], end: 40, dt: 0.05, y_label: "concentration", t_label: "time" },
      record: { x: "kf/kr", y: "B_final/A_final", x_label: "k_f / k_r", y_label: "[B]/[A] at equilibrium" },
      readouts: [{ label: "[B]/[A] at the end", value: "B_final/A_final", digits: 3 }, { label: "K = k_f / k_r", value: "kf/kr", digits: 3 }],
      predict: { question: "If the backward rate drops to k_r = 0.1, what happens to [B] at equilibrium?", set: { kr: 0.1 }, observe: "B_final", kind: "change" },
    },
  },
  {
    id: "le-chatelier", part: "B", subject: "Chemistry", source: "The Micro World · Le Chatelier",
    spec: {
      version: 2, rig: "stocks", title: "Disturbing an equilibrium",
      prompt: "A ⇌ B settles, then at t = 20 extra A is added. Watch the system respond.",
      params: [range("add", "A added at t = 20", 0, 1, 0.1, 0)],
      config: { stocks: [{ name: "A", label: "[A]", init: "1" }, { name: "B", label: "[B]", init: "0" }], flows: [{ from: "A", to: "B", rate: "0.3*A" }, { from: "B", to: "A", rate: "0.15*B" }], pulses: [{ stock: "A", at: "20", amount: "add" }], end: 50, dt: 0.05, y_label: "concentration", t_label: "time" },
      readouts: [{ label: "[B] at the end", value: "B_final", digits: 3 }, { label: "[B]/[A] at the end", value: "B_final/A_final", digits: 3 }],
      predict: { question: "If 1 mol/L of A is added at t = 20, what happens to [B] at the end?", set: { add: 1 }, observe: "B_final", kind: "change" },
    },
  },
  {
    id: "catalyst", part: "B", subject: "Chemistry", source: "The Micro World · catalysis",
    spec: {
      version: 2, rig: "stocks", title: "What a catalyst changes",
      prompt: "A catalyst speeds both directions of A ⇌ B by the same factor. Compare where it ends and how fast it gets there.",
      params: [range("cat", "Catalyst speed-up", 1, 5, 0.5, 1, "×")],
      config: { stocks: [{ name: "A", label: "[A]", init: "1" }, { name: "B", label: "[B]", init: "0" }], flows: [{ from: "A", to: "B", rate: "cat*0.2*A" }, { from: "B", to: "A", rate: "cat*0.1*B" }], end: 40, dt: 0.05, y_label: "concentration", t_label: "time" },
      readouts: [{ label: "[B] at the end", value: "B_final", digits: 3 }, { label: "time to 90% of the way", value: "B_t90", digits: 2 }],
      predict: { question: "With a 4× catalyst, what happens to the time it takes to reach equilibrium?", set: { cat: 4 }, observe: "B_t90", kind: "change" },
    },
  },
  {
    id: "arrhenius", part: "B", subject: "Chemistry", source: "The Micro World · temperature",
    spec: {
      version: 2, rig: "function", title: "Rate and temperature",
      prompt: "k = A·e^(−Ea/RT). The curve is the rate constant across temperatures; the dot is room temperature.",
      params: [range("Ea", "Activation energy Ea", 20, 100, 1, 50, "kJ/mol")],
      config: { x: { min: 250, max: 400, label: "temperature (K)" }, y_label: "k (relative)", curves: [{ expr: "1e9*exp(-Ea*1000/(8.314*x))", label: "k" }], marks: [{ kind: "point", name: "k300", at: "300" }, { kind: "point", name: "k310", at: "310" }] },
      readouts: [{ label: "k at 310 K ÷ k at 300 K", value: "k310/k300", digits: 2 }],
      tasks: [{ text: "Make a 10 K rise double the rate", check: { of: "k310/k300", op: "near", value: 2, tol: 0.05 } }],
      predict: { question: "With a higher activation energy (80 kJ/mol), what happens to k at 300 K?", set: { Ea: 80 }, observe: "k300", kind: "change" },
    },
  },

  /* ================================================================ biology */
  {
    id: "mono-cross", part: "B", subject: "Biology", source: "PeaLab · monohybrid and test cross",
    spec: {
      version: 2, rig: "cross", title: "One gene: round and wrinkled peas",
      prompt: "Choose each parent's genotype. The square shows every pairing of gametes; the bars show 400 offspring.",
      params: [geno("m", "Mother", 1), geno("f", "Father", 1), range("n", "Offspring raised", 0, 1000, 10, 400)],
      config: { genes: [{ letter: "A", dominant: "round", recessive: "wrinkled" }], mother: ["m"], father: ["f"], offspring: "n", seed: 3 },
      readouts: [{ label: "ratio", value: "ratio" }, { label: "χ² of the counts", value: "chi2", digits: 2 }],
      tasks: [{ text: "Get only round peas", check: { of: "p1", op: "<", value: 0.001 } }],
      predict: { question: "Cross Aa with aa (a test cross). What ratio of round to wrinkled do you expect?", set: { f: 2 }, observe: "ratio", kind: "category" },
    },
  },
  {
    id: "di-cross", part: "B", subject: "Biology", source: "PeaLab · dihybrid cross",
    spec: {
      version: 2, rig: "cross", title: "Two genes: 9 : 3 : 3 : 1",
      prompt: "Seed colour (A: yellow / green) and shape (B: round / wrinkled), inherited independently.",
      params: [geno("mA", "Mother, colour", 1), geno("mB", "Mother, shape", 1, "B"), geno("fA", "Father, colour", 1), geno("fB", "Father, shape", 1, "B")],
      config: { genes: [{ letter: "A", dominant: "yellow", recessive: "green" }, { letter: "B", dominant: "round", recessive: "wrinkled" }], mother: ["mA", "mB"], father: ["fA", "fB"] },
      readouts: [{ label: "ratio", value: "ratio" }],
      predict: { question: "Cross AaBb with aabb. What ratio do you expect?", set: { fA: 2, fB: 2 }, observe: "ratio", kind: "category" },
    },
  },
  {
    id: "incomplete", part: "B", subject: "Biology", source: "Genetics · incomplete dominance",
    spec: {
      version: 2, rig: "cross", title: "Red, pink and white flowers",
      prompt: "In snapdragons neither colour allele dominates: one copy of each gives pink.",
      params: [geno("m", "Mother", 0, "R"), geno("f", "Father", 2, "R")],
      config: { genes: [{ letter: "R", dominant: "red", recessive: "white", mode: "incomplete", middle: "pink" }], mother: ["m"], father: ["f"] },
      readouts: [{ label: "ratio", value: "ratio" }],
      predict: { question: "Cross two pink plants (Rr × Rr). What ratio of colours do you expect?", set: { m: 1, f: 1 }, observe: "ratio", kind: "category" },
    },
  },
  {
    id: "logistic", part: "B", subject: "Biology", source: "Ecology · population growth",
    spec: {
      version: 2, rig: "stocks", title: "Population growth with a limit",
      prompt: "dN/dt = r·N·(1 − N/K). The population grows fast, then levels off at the carrying capacity K.",
      params: [range("r", "Growth rate r", 0.1, 1.5, 0.05, 0.5), range("K", "Carrying capacity K", 200, 1000, 50, 500)],
      config: { stocks: [{ name: "N", label: "population", init: "10" }], flows: [{ to: "N", rate: "r*N*(1 - N/K)" }], end: 40, dt: 0.05, y_label: "individuals", t_label: "time (years)" },
      readouts: [{ label: "population at the end", value: "N_final", digits: 0 }, { label: "time to 90% of the way", value: "N_t90", digits: 1 }],
      tasks: [{ text: "Get close to the limit within 10 years", check: { of: "N_t90", op: "<", value: 10 } }],
      predict: { question: "If the habitat can support 800 instead of 500, what happens to the final population?", set: { K: 800 }, observe: "N_final", kind: "change" },
    },
  },
  {
    id: "predator-prey", part: "B", subject: "Biology", source: "Ecology · predators and prey",
    spec: {
      version: 2, rig: "stocks", title: "Predators and prey",
      prompt: "Hares grow on their own and are eaten by lynx; lynx grow by eating hares and die off without them.",
      params: [range("a", "Hare growth", 0.5, 1.5, 0.05, 1), range("m", "Lynx death rate", 0.2, 1, 0.05, 0.5)],
      config: {
        stocks: [{ name: "H", label: "hares", init: "40" }, { name: "P", label: "lynx", init: "9" }],
        flows: [{ to: "H", rate: "a*H" }, { from: "H", rate: "0.1*H*P" }, { to: "P", rate: "0.02*H*P" }, { from: "P", rate: "m*P" }],
        end: 40, dt: 0.02, phase: ["H", "P"], y_label: "animals", t_label: "time",
      },
      readouts: [{ label: "most hares", value: "H_max", digits: 0 }, { label: "most lynx", value: "P_max", digits: 0 }],
      predict: { question: "If lynx die faster (m = 0.8), what happens to the largest number of hares?", set: { m: 0.8 }, observe: "H_max", kind: "change" },
    },
  },
  {
    id: "sir", part: "B", subject: "Biology", source: "ImmuneLab · epidemics and vaccination",
    spec: {
      version: 2, rig: "stocks", title: "An epidemic and vaccination",
      prompt: "Susceptible → infected at β·S·I/N, infected → recovered at γ·I. Vaccinate part of the town before it starts.",
      params: [range("beta", "Infection rate β", 0.1, 1, 0.05, 0.4), range("gamma", "Recovery rate γ", 0.05, 0.5, 0.01, 0.1), range("v", "Share vaccinated", 0, 0.95, 0.05, 0)],
      config: {
        stocks: [{ name: "S", label: "susceptible", init: "(1 - v)*990" }, { name: "I", label: "infected", init: "10" }, { name: "R", label: "recovered or immune", init: "v*990" }],
        flows: [{ from: "S", to: "I", rate: "beta*S*I/1000" }, { from: "I", to: "R", rate: "gamma*I" }],
        end: 160, dt: 0.1, y_label: "people", t_label: "days",
      },
      readouts: [{ label: "R₀ = β/γ", value: "beta/gamma", digits: 2 }, { label: "peak infected", value: "I_max", digits: 0 }, { label: "peak on day", value: "I_tmax", digits: 0 }],
      tasks: [{ text: "Stop the outbreak (peak below 20)", check: { of: "I_max", op: "<", value: 20 } }],
      predict: { question: "If 60% are vaccinated, what happens to the peak?", set: { v: 0.6 }, observe: "I_max", kind: "change" },
    },
  },
  {
    id: "immune-memory", part: "B", subject: "Biology", source: "ImmuneLab · immunological memory (a toy model)",
    spec: {
      version: 2, rig: "stocks", title: "Primary and secondary response",
      prompt: "The same antigen arrives on day 0 and again on day 40. Memory cells formed the first time make the second response faster and bigger.",
      params: [range("q", "Memory strength", 0, 3, 0.1, 1.5)],
      config: {
        stocks: [{ name: "Ag", label: "antigen", init: "1" }, { name: "Ab", label: "antibody", init: "0" }, { name: "M", label: "memory cells", init: "0" }],
        flows: [
          { from: "Ag", rate: "2*Ag*Ab" },
          { to: "Ab", rate: "(0.2 + q*M)*Ag" },
          { to: "M", rate: "0.1*Ag" },
          { from: "Ab", rate: "0.08*Ab" },
        ],
        pulses: [{ stock: "Ag", at: "40", amount: "1" }],
        end: 80, dt: 0.05, show: ["Ag", "Ab"], y_label: "level", t_label: "days",
      },
      readouts: [{ label: "highest antibody level", value: "Ab_max", digits: 2 }, { label: "memory cells at the end", value: "M_final", digits: 2 }],
      predict: { question: "With no memory (strength 0), what happens to the highest antibody level?", set: { q: 0 }, observe: "Ab_max", kind: "change" },
    },
  },

  /* ================================================================ geography */
  {
    id: "contours", part: "B", subject: "Geography", source: "Contour 3D · reading a contour map",
    spec: {
      version: 2, rig: "field", title: "Reading a contour map",
      prompt: "Two hills and a saddle. Drag the walker and read the height and the slope; the arrow points uphill.",
      params: [range("px", "Walker x", -3, 3, 0.05, 0, "km"), range("py", "Walker y", -2, 2, 0.05, -1.2, "km"), { name: "dz", label: "Contour interval", type: "seg", value: 100, options: [[50, "50 m"], [100, "100 m"], [200, "200 m"]] }],
      controls: ["dz"],
      config: { h: "900*exp(-((x-1.4)^2 + (y-0.4)^2)/1.1) + 650*exp(-((x+1.5)^2 + (y+0.2)^2)/0.9) + 80", x: [-3, 3], y: [-2, 2], levels: "dz", label: "height (m)", probe: { x: "px", y: "py", drag: { x: "px", y: "py" } } },
      readouts: [{ label: "height", value: "height", digits: 0, unit: "m" }, { label: "slope", value: "slope", digits: 0, unit: "m per km" }],
      tasks: [
        { text: "Climb to the higher summit (over 950 m)", check: { of: "height", op: ">", value: 950 } },
        { text: "Find a steep spot (over 600 m per km)", check: { of: "slope", op: ">", value: 600 } },
      ],
      predict: { question: "If the walker goes up to the top of the east hill (x = 1.4, y = 0.4), what happens to the slope underfoot?", set: { px: 1.4, py: 0.4 }, observe: "slope", kind: "change" },
    },
  },
  {
    id: "profile", part: "B", subject: "Geography", source: "Contour 3D · terrain profile",
    spec: {
      version: 2, rig: "field", title: "Drawing a terrain profile",
      prompt: "The line A → B cuts across the map; the lower chart is the ground along it.",
      params: [range("ya", "A's y", -2, 2, 0.05, -1.6, "km"), range("yb", "B's y", -2, 2, 0.05, -1.6, "km")],
      config: { h: "900*exp(-((x-1.4)^2 + (y-0.4)^2)/1.1) + 650*exp(-((x+1.5)^2 + (y+0.2)^2)/0.9) + 80", x: [-3, 3], y: [-2, 2], levels: "100", label: "height (m)", profile: { x1: "-2.9", y1: "ya", x2: "2.9", y2: "yb" } },
      readouts: [{ label: "total climb", value: "climb", digits: 0, unit: "m" }, { label: "relief along the line", value: "relief", digits: 0, unit: "m" }],
      tasks: [{ text: "Run the line over both summits", check: { of: "relief", op: ">", value: 880 } }],
      predict: { question: "If the line is moved up through the middle of the map (both ends at y = 0.2), what happens to the climb?", set: { ya: 0.2, yb: 0.2 }, observe: "climb", kind: "change" },
    },
  },
  {
    id: "day-length", part: "B", subject: "Geography", source: "Earth Motion · day length",
    spec: {
      version: 2, rig: "sun", title: "Day length through the year",
      prompt: "Pick a latitude and a day. The globe shows where the sun is overhead; the chart shows day length all year (thin lines: equator, tropic, polar circle).",
      params: [range("lat", "Latitude", -90, 90, 0.5, 40, "°"), range("day", "Day of the year", 1, 365, 1, 172)],
      config: { latitude: "lat", day: "day", compare: ["0", "23.4", "66.6"] },
      stage: { kind: "orbit" },
      play: { param: "day", to: 365, seconds: 6 },
      readouts: [{ label: "day length", value: "day_length", digits: 1, unit: "h" }, { label: "sun overhead at", value: "declination", digits: 1, unit: "°" }],
      tasks: [{ text: "Find a day with 12 hours of daylight (an equinox)", check: { of: "abs(day_length - 12)", op: "<", value: 0.1 } }],
      predict: { question: "On the June solstice, moving north from 40° to 60°, what happens to day length?", set: { lat: 60 }, observe: "day_length", kind: "change" },
    },
  },
  {
    id: "noon-sun", part: "B", subject: "Geography", source: "Earth Motion · noon solar altitude",
    spec: {
      version: 2, rig: "sun", title: "How high the sun gets at noon",
      prompt: "Noon altitude = 90° − |latitude − subsolar latitude|.",
      params: [range("lat", "Latitude", -90, 90, 0.5, 40, "°"), range("day", "Day of the year", 1, 365, 1, 355)],
      config: { latitude: "lat", day: "day" },
      stage: { kind: "orbit" },
      readouts: [{ label: "noon sun altitude", value: "noon_altitude", digits: 1, unit: "°" }, { label: "sun overhead at", value: "declination", digits: 1, unit: "°" }],
      tasks: [{ text: "Put the sun straight overhead at noon", check: { of: "noon_altitude", op: ">", value: 89.5 } }],
      predict: { question: "Moving from the December solstice to the June solstice (day 172), what happens to the noon sun at 40° N?", set: { day: 172 }, observe: "noon_altitude", kind: "change" },
    },
  },
  {
    id: "polar-day", part: "B", subject: "Geography", source: "Earth Motion · seasons",
    spec: {
      version: 2, rig: "sun", title: "Polar day and polar night",
      prompt: "North of the Arctic Circle the sun can stay up, or down, all day.",
      params: [range("lat", "Latitude", 50, 90, 0.5, 70, "°"), range("day", "Day of the year", 1, 365, 1, 80)],
      config: { latitude: "lat", day: "day", compare: ["66.6"] },
      stage: { kind: "orbit" },
      readouts: [{ label: "day length", value: "day_length", digits: 1, unit: "h" }, { label: "today", value: "daytype" }],
      predict: { question: "At 70° N, what happens on the June solstice (day 172)?", set: { day: 172 }, observe: "daytype", kind: "category" },
    },
  },
  {
    id: "sponge-city", part: "B", subject: "Geography", source: "WaterCycle · urbanisation and sponge cities",
    spec: {
      version: 2, rig: "stocks", title: "Where the rain goes in a city",
      prompt: "A storm falls on the city. Water on the surface either soaks in (share s) or runs off into the river.",
      params: [range("s", "Share that soaks in", 0.05, 0.9, 0.05, 0.2)],
      config: {
        stocks: [{ name: "W", label: "water on the surface", init: "0" }, { name: "G", label: "soaked into the ground", init: "0" }, { name: "R", label: "run off to the river", init: "0" }],
        flows: [{ to: "W", rate: "20*exp(-((t - 5)/1.5)^2)" }, { from: "W", to: "G", rate: "s*1.2*W" }, { from: "W", to: "R", rate: "(1 - s)*1.2*W" }],
        end: 24, dt: 0.02, y_label: "water (mm)", t_label: "hours",
      },
      readouts: [{ label: "run-off", value: "R_final", digits: 0, unit: "mm" }, { label: "soaked in", value: "G_final", digits: 0, unit: "mm" }],
      tasks: [{ text: "Keep run-off below 20 mm", check: { of: "R_final", op: "<", value: 20 } }],
      predict: { question: "If the city is rebuilt so that 70% soaks in, what happens to the run-off?", set: { s: 0.7 }, observe: "R_final", kind: "change" },
    },
  },

  /* ================================================================ history */
  {
    id: "lanchester", part: "B", subject: "History", source: "WarTable · why numbers matter (Lanchester's square law, a model)",
    spec: {
      version: 2, rig: "stocks", title: "Concentration of force",
      prompt: "Each side loses troops in proportion to the size of the other side (Lanchester's square law). A model, not the record of any battle.",
      params: [range("a0", "Red troops at the start", 10, 100, 1, 60, "k"), range("b0", "Blue troops at the start", 10, 100, 1, 40, "k"), range("eb", "Blue effectiveness", 0.02, 0.2, 0.01, 0.05)],
      config: {
        stocks: [{ name: "A", label: "red", init: "a0" }, { name: "B", label: "blue", init: "b0" }],
        flows: [{ from: "A", rate: "eb*B" }, { from: "B", rate: "0.05*A" }],
        end: 60, dt: 0.05, y_label: "troops (thousands)", t_label: "time",
      },
      readouts: [{ label: "red left", value: "A_final", digits: 1 }, { label: "blue left", value: "B_final", digits: 1 }],
      tasks: [{ text: "Let the smaller blue army win by fighting better", check: { of: "B_final - A_final", op: ">", value: 0 } }],
      predict: { question: "If blue brings 55 thousand instead of 40, what happens to the red troops left at the end?", set: { b0: 55 }, observe: "A_final", kind: "change" },
    },
  },
  {
    id: "population", part: "B", subject: "History", source: "World population (UN and HYDE estimates, rounded)",
    spec: {
      version: 2, rig: "timeline", title: "Three centuries of world population",
      prompt: "Move through the years. The readout shows how fast the population was growing at that moment.",
      params: [range("year", "Year", 1700, 2022, 1, 1800)],
      config: {
        series: [{ name: "pop", label: "people (billions)", points: [[1700, 0.6], [1750, 0.79], [1800, 0.98], [1850, 1.26], [1900, 1.65], [1927, 2], [1950, 2.53], [1960, 3.03], [1974, 4], [1987, 5], [1999, 6], [2011, 7], [2022, 8]] }],
        events: [{ t: 1769, label: "Watt's steam engine" }, { t: 1796, label: "smallpox vaccine" }, { t: 1928, label: "penicillin" }, { t: 1960, label: "Green Revolution" }],
        at: "year", y_label: "billions", source: "UN World Population Prospects; HYDE",
      },
      play: { param: "year", seconds: 6 },
      readouts: [{ label: "population", value: "pop", digits: 2, unit: "bn" }, { label: "growth", value: "pop_rate*1000", digits: 0, unit: "million / year" }],
      tasks: [{ text: "Find when growth first passed 50 million a year", check: { of: "pop_rate", op: ">", value: 0.05 } }],
      predict: { question: "Compared with 1800, how fast was the population growing in 1950?", set: { year: 1950 }, observe: "pop_rate", kind: "change" },
    },
  },
  {
    id: "malthus", part: "B", subject: "History", source: "Malthus, An Essay on the Principle of Population (1798)",
    spec: {
      version: 2, rig: "function", title: "Malthus: people against food",
      prompt: "Malthus argued population grows geometrically and food arithmetically. Where the curves cross, food runs short.",
      params: [range("r", "Population growth per year", 0.005, 0.04, 0.001, 0.02), range("d", "Food added per year", 0.005, 0.05, 0.001, 0.02)],
      config: {
        x: { min: 0, max: 150, label: "years" }, y: { min: 0, max: 8, label: "relative size" },
        curves: [{ expr: "(1 + r)^x", label: "population" }, { expr: "1.5 + d*x", label: "food supply" }],
        marks: [{ kind: "intersect", name: "crisis", curves: [0, 1] }],
      },
      readouts: [{ label: "food runs short after", value: "crisis_x", digits: 0, unit: "years" }],
      tasks: [{ text: "Hold off the crisis for 100 years", check: { of: "crisis_x", op: ">", value: 100 } }],
      predict: { question: "If population grows 3% a year instead of 2%, what happens to the year food runs short?", set: { r: 0.03 }, observe: "crisis_x", kind: "change" },
    },
  },

  /* ================================================================ economics */
  {
    id: "supply-demand", part: "B", subject: "Economics", source: "Markets · supply and demand",
    spec: {
      version: 2, rig: "function", title: "Supply, demand and equilibrium",
      prompt: "Demand p = a − Q, supply p = 2 + 0.5Q. They meet at the market price; the shaded area is consumer surplus.",
      params: [range("a", "Demand level a", 6, 16, 0.5, 10)],
      config: {
        x: { min: 0, max: 14, label: "quantity Q" }, y: { min: 0, max: 16, label: "price p" },
        curves: [{ expr: "max(0, a - x)", label: "demand" }, { expr: "2 + 0.5*x", label: "supply" }],
        marks: [{ kind: "band", name: "cs", curve: 0, level: "a - (a - 2)/1.5", a: "0", b: "(a - 2)/1.5" }, { kind: "intersect", name: "eq", curves: [0, 1] }],
      },
      readouts: [{ label: "price", value: "eq_y", digits: 2 }, { label: "quantity", value: "eq_x", digits: 2 }, { label: "consumer surplus", value: "cs", digits: 1 }],
      tasks: [{ text: "Make the market trade exactly 6 units", check: { of: "eq_x", op: "near", value: 6, tol: 0.05 } }],
      predict: { question: "If demand rises (a = 14), what happens to the market price?", set: { a: 14 }, observe: "eq_y", kind: "change" },
    },
  },
  {
    id: "tax", part: "B", subject: "Economics", source: "Markets · who pays a tax",
    spec: {
      version: 2, rig: "function", title: "Who pays a tax?",
      prompt: "A tax t per unit lifts the supply curve. Buyers pay the new price; sellers keep that price minus t.",
      params: [range("t", "Tax per unit t", 0, 5, 0.1, 1), range("e", "Steepness of demand", 0.3, 3, 0.1, 1)],
      config: {
        x: { min: 0, max: 14, label: "quantity Q" }, y: { min: 0, max: 16, label: "price p" },
        curves: [{ expr: "max(0, 12 - e*x)", label: "demand" }, { expr: "2 + 0.5*x", label: "supply" }, { expr: "2 + t + 0.5*x", label: "supply + tax" }],
        marks: [{ kind: "intersect", name: "eq", curves: [0, 2] }],
      },
      readouts: [{ label: "buyers pay", value: "eq_y", digits: 2 }, { label: "sellers keep", value: "eq_y - t", digits: 2 }, { label: "tax raised", value: "t*eq_x", digits: 1 }, { label: "buyers' share of the tax", value: "(eq_y - (2 + 0.5*10/(e + 0.5)))/t", digits: 2 }],
      predict: { question: "If the tax rises to 3, what happens to the quantity traded?", set: { t: 3 }, observe: "eq_x", kind: "change" },
    },
  },
  {
    id: "compound", part: "B", subject: "Economics", source: "Finance · compound interest",
    spec: {
      version: 2, rig: "function", title: "Compound against simple interest",
      prompt: "$1 at rate r: simple interest adds r each year; compound interest earns interest on interest.",
      params: [range("r", "Interest rate r", 0.01, 0.15, 0.005, 0.05)],
      config: { x: { min: 0, max: 40, label: "years" }, y_label: "value of $1", curves: [{ expr: "(1 + r)^x", label: "compound" }, { expr: "1 + r*x", label: "simple" }], marks: [{ kind: "point", name: "c10", at: "10" }, { kind: "point", name: "c30", at: "30" }] },
      readouts: [{ label: "after 10 years", value: "c10", digits: 2 }, { label: "after 30 years", value: "c30", digits: 2 }, { label: "rule of 72: years to double", value: "72/(100*r)", digits: 1 }],
      tasks: [{ text: "Double your money within 10 years", check: { of: "c10", op: ">", value: 2 } }],
      predict: { question: "At 8% instead of 5%, what happens to the value after 30 years?", set: { r: 0.08 }, observe: "c30", kind: "change" },
    },
  },
  {
    id: "break-even", part: "B", subject: "Economics", source: "Business · break-even",
    spec: {
      version: 2, rig: "function", title: "Break-even point",
      prompt: "Revenue = price × units; cost = fixed cost + unit cost × units. Profit starts where they cross.",
      params: [range("F", "Fixed cost", 1000, 8000, 250, 3000, "$"), range("p", "Price per unit", 20, 80, 1, 50, "$"), range("v", "Cost per unit", 5, 40, 1, 20, "$")],
      config: { x: { min: 0, max: 400, label: "units sold" }, y_label: "$", curves: [{ expr: "p*x", label: "revenue" }, { expr: "F + v*x", label: "cost" }], marks: [{ kind: "intersect", name: "be", curves: [0, 1] }] },
      readouts: [{ label: "break-even units", value: "be_x", digits: 0 }, { label: "F / (p − v)", value: "F/(p - v)", digits: 0 }],
      tasks: [{ text: "Break even before 50 units", check: { of: "be_x", op: "<", value: 50 } }],
      predict: { question: "If fixed costs rise to $6000, what happens to the break-even point?", set: { F: 6000 }, observe: "be_x", kind: "change" },
    },
  },
];
