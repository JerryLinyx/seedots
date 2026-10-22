// What a model needs to pick a rig and write its config: when to use it, what the config fields mean,
// what it can observe, and a spec that passes the gates (by case id). Served by the rig service as
// /v1/rigs; tests check that every rig has a card and that its examples pass.

export type RigCard = {
  version: string;
  summary: string;
  use_when: string[];
  not_for: string[];
  tags: string[];
  fields: Record<string, string>; // config field → what it is
  observables: Record<string, string>; // name (or pattern) → meaning
  examples: string[]; // case ids in cases*.ts
  stages?: string[]; // 3D presentations available for this rig
};

/** The grammar every formula field uses; sent once per card, not once per field. */
export const FORMULAS = "numbers, + - * / ^, parentheses, param names (and the rig's own variables, e.g. x), pi, e, and the functions sin cos tan exp log sqrt abs min max pow tanh atan sign floor";
const F = "formula";

export const CARDS: Record<string, RigCard> = {
  function: {
    version: "1.1.0",
    summary: "Curves y = f(x; params) with marks that measure them: a point, tangent, secant, Riemann sum, exact area, where two curves meet, the area between a curve and a level, a faint copy of the starting curve.",
    use_when: ["a quantity depends on one variable and a few parameters", "slopes, rates, areas, crossing points (equilibrium, break-even)", "how a parameter reshapes a curve (shift, stretch, sharpen)"],
    not_for: ["step-by-step processes (use iteration or stocks)", "several interacting quantities over time (use stocks)", "randomness (use sampling)"],
    tags: ["math", "machine learning", "economics", "physics", "chemistry", "one variable"],
    fields: {
      "x": "{min, max, label}: the horizontal axis",
      "y": "optional {min, max, label}: fixes the vertical axis; otherwise it fits the starting and predicted curves",
      "y_label": "label of the vertical axis when y is not given",
      "curves": `[{expr, label}]: expr is a ${F}, in x and the params`,
      "marks": "point {name, at, curve?, drag?: param} | tangent {name, at} | secant {name, a, b} | riemann {name, a, b, n, rule: left|right|mid} | area {name, a, b} | intersect {name, curves: [i, j]} | band {name, curve?, level, a, b} | ghost {curve?} | vline {at}; positions are formulas in the params",
    },
    observables: { "<point>": "y at the point", "<point>_x": "x of the point", "<tangent>": "slope", "<secant>": "slope", "<riemann>": "sum of rectangles", "<riemann>_exact": "exact area", "<riemann>_error": "|sum − exact|", "<area>": "area", "<band>": "area between curve and level", "<intersect>_x / _y": "where the curves meet (infinite if they do not on the chart)" },
    examples: ["secant", "supply-demand", "riemann"],
  },
  iteration: {
    version: "1.0.0",
    summary: "x(n+1) = update(x(n); params), drawn as dots walking down an objective curve, or as a time series.",
    use_when: ["an update rule applied again and again (gradient descent, fixed points, recurrences)", "whether a process settles, bounces or blows up", "step size, learning rate, damping of an update"],
    not_for: ["continuous change over time with several quantities (use stocks)", "two-variable optimisation (use field with descent)"],
    tags: ["machine learning", "math", "optimisation", "one variable"],
    fields: { "start": `${F} (params only)`, "update": `${F} in x, n and params`, "steps": "1..500", "objective": "optional formula in x: the curve the dots walk on", "x": "{min, max, label}", "target": "optional formula: the value it should approach (exposes gap)", "reveal": "optional param that limits how many steps are drawn (pair it with play)" },
    observables: { "final": "last x", "settle_step": "first step after which it stops moving", "gap": "|final − target|", "behaviour": "category: settles down | keeps bouncing | blows up" },
    examples: ["step-size", "guidance", "ddpm-noise"],
  },
  vectors: {
    version: "1.0.0",
    summary: "2D vectors from formulas, draggable by tip or by angle, an optional 2x2 matrix applied to the plane, dot products, cosines, angles and projections.",
    use_when: ["similarity of embeddings, cosine similarity, angles", "projection, components", "what a matrix does to space (determinant, flips)"],
    not_for: ["more than 2 dimensions", "anything over time"],
    tags: ["math", "machine learning", "linear algebra"],
    fields: { "extent": "half-width of the view", "vectors": `[{name, x, y, label?, drag?: {x: param, y: param} | {angle: param}}]; x and y are ${F}`, "matrix": "optional {a, b, c, d, apply_to: [vector names]}", "pairs": "[[v1, v2]]: measures between these", "project": "optional [v, onto]", "unit_circle": "true to draw the unit circle" },
    observables: { "<v>_x / _y / _len": "coordinates and length", "dot_<a>_<b>": "dot product", "cos_<a>_<b>": "cosine similarity", "angle_<a>_<b>": "angle in degrees", "proj": "length of the projection", "det": "determinant" },
    examples: ["cosine-angle", "matrix", "projection"],
  },
  distribution: {
    version: "1.0.0",
    summary: "Scores over a few categories turned into probabilities (softmax with a temperature, or normalising), shown as grouped bars; several series side by side.",
    use_when: ["softmax, temperature, logits, attention weights over a few options", "comparing two distributions (teacher vs student)"],
    not_for: ["continuous distributions (use function)", "random draws (use sampling)"],
    tags: ["machine learning", "probability"],
    fields: { "categories": "2..8 labels", "series": `[{name, label, scores: [${F}, one per category], temperature?: formula, transform?: softmax|normalize}]` },
    observables: { "<series>_p<i>": "probability of category i", "<series>_max": "largest probability", "<series>_entropy": "entropy in bits", "<series>_top": "category: the most likely label" },
    examples: ["infonce-temp", "distill-temp"],
  },
  sampling: {
    version: "1.0.0",
    summary: "Random draws with given probabilities (seeded: the same spec always gives the same draws): running mean against the expected value, counts against expected counts, and a chi-square test.",
    use_when: ["expected value, averages that converge (law of large numbers)", "does an observed ratio fit a hypothesis", "games of chance, bets"],
    not_for: ["deterministic curves", "processes with memory (use stocks)"],
    tags: ["probability", "statistics", "economics", "biology"],
    fields: { "outcomes": `[{label, p: ${F}, value?: formula, expect?: formula (hypothesis for chi-square)}]`, "draws": "formula, usually a param (how many draws)", "max_draws": "1..20000", "seed": "optional integer", "view": "optional [mean, counts]" },
    observables: { "n": "draws made", "mean": "running mean", "expected": "expected value", "gap": "|mean − expected|", "chi2": "chi-square against the hypothesis", "count<i> / freq<i>": "counts and shares", "fit": "category: fits / does not fit the expected ratio (5%)" },
    examples: ["bet-ev", "dice-lln", "mendel-chi2"],
  },
  field: {
    version: "1.0.0",
    summary: "A scalar field h(x, y) as a contour map, with a draggable probe (height, slope), a profile line, and a gradient-descent walk.",
    use_when: ["contour maps, terrain, slope", "two-variable functions, loss landscapes, potentials", "gradient descent in two dimensions"],
    not_for: ["one variable (use function)", "time series (use stocks)"],
    tags: ["geography", "math", "machine learning", "physics", "two variables"],
    fields: { "h": `${F} in x, y and params`, "x / y": "[min, max]", "levels": "formula: contour interval", "label": "what h is", "probe": "optional {x, y, drag?: {x: param, y: param}}", "profile": "optional {x1, y1, x2, y2}", "descent": "optional {x0, y0, rate, steps}" },
    observables: { "h_max / h_min": "extremes", "height / slope / probe_x / probe_y": "at the probe", "climb / drop / relief": "along the profile", "final_h / final_x / final_y": "end of the descent", "behaviour": "category of the descent" },
    examples: ["contours", "loss-3d"],
    stages: ["terrain"],
  },
  particle: {
    version: "1.1.0",
    summary: "One body moved by an acceleration written as formulas of its state (x, y, vx, vy, t), integrated with RK4; can stop on the ground or at the end of a track.",
    use_when: ["motion under forces: projectiles, falling with drag, springs, pendulums, carts on tracks", "period, range, terminal speed"],
    not_for: ["many bodies", "fields and circuits"],
    tags: ["physics", "mechanics"],
    fields: { "start": "{x, y, vx, vy}: formulas in the params", "ax / ay": `${F} in x, y, vx, vy, t and params`, "dt / duration": "seconds; at most 5000 steps", "stop_at_ground": "end when y < 0", "stop_x": "formula: end when x reaches it", "views": "[space | x-t | y-t | v-t]", "reveal": "optional time param for playing the motion", "period_of": "x | y: measure the period" },
    observables: { "range": "x travelled", "max_height": "highest y", "flight_time": "duration of the run", "final_speed / max_speed": "speeds", "x_final / y_final": "end position", "period / amplitude_end": "for oscillations" },
    examples: ["projectile", "pendulum", "track-3d"],
    stages: ["track", "pendulum", "spring", "launcher"],
  },
  optics: {
    version: "1.0.0",
    summary: "Two benches: a thin lens with the principal rays and the image; or a ray refracting between two media with total internal reflection.",
    use_when: ["lenses, image formation, magnification", "refraction, critical angle"],
    not_for: ["wave optics (interference: use function)"],
    tags: ["physics", "optics"],
    fields: { "bench": "lens | refraction", "lens: f / u / h": "focal length, object distance, object height (formulas)", "refraction: n1 / n2 / angle": "indices and incidence angle in degrees (formulas)" },
    observables: { "v / magnification / image_height / inv_u / inv_v": "lens", "image": "category: real/virtual, inverted/upright, size", "refracted_angle / critical_angle / deviation": "refraction", "ray": "category: refracts | totally reflected" },
    examples: ["lens", "tir"],
    stages: ["bench"],
  },
  stocks: {
    version: "1.0.0",
    summary: "Named quantities changed by flows written as formulas of the stocks, t and params (system dynamics, RK4); pulses add an amount at a moment.",
    use_when: ["reaction kinetics and equilibrium", "populations, epidemics, immune responses", "anything that accumulates and drains over time (water, money, troops, a queue)"],
    not_for: ["randomness", "spatial layouts"],
    tags: ["chemistry", "biology", "geography", "economics", "history", "dynamics"],
    fields: { "stocks": "[{name, label, init: formula}]", "flows": "[{from?: stock, to?: stock, rate: formula in stocks, t and params}]", "pulses": "optional [{stock, at, amount}]", "end / dt": "time span and step; at most 5000 steps", "show": "optional stocks to plot", "phase": "optional [stock, stock] for a phase plot", "reveal": "optional time param" },
    observables: { "<stock>_final / _max / _tmax": "end value, peak, time of peak", "<stock>_t90": "time to cover 90% of the way to the end value" },
    examples: ["equilibrium", "sir", "lanchester"],
  },
  cross: {
    version: "1.0.0",
    summary: "Mendelian crosses with one or two genes (complete or incomplete dominance): the Punnett square, offspring ratios, and seeded offspring counts.",
    use_when: ["genetics crosses, segregation, test crosses, dihybrid ratios"],
    not_for: ["population genetics over generations (use stocks)"],
    tags: ["biology", "genetics"],
    fields: { "genes": "[{letter, dominant, recessive, mode?: complete|incomplete, middle?}] (1 or 2)", "mother / father": "one seg param per gene, values 0 = homozygous dominant, 1 = heterozygous, 2 = homozygous recessive", "offspring": "optional formula: offspring raised", "seed": "optional" },
    observables: { "p<i> / count<i>": "phenotype probability and count", "n": "offspring", "chi2": "chi-square of the counts", "ratio": "category: 3 : 1, 1 : 1, 1 : 2 : 1, 9 : 3 : 3 : 1, ..." },
    examples: ["mono-cross", "di-cross"],
  },
  sun: {
    version: "1.0.0",
    summary: "Sun position by latitude and day of the year: subsolar latitude, day length, noon altitude, polar day and night.",
    use_when: ["seasons, day length, solar altitude, the tropics and polar circles"],
    not_for: ["climate or weather"],
    tags: ["geography", "astronomy"],
    fields: { "latitude / day": "formulas (usually params): degrees, day of year 1..365", "tilt": "optional axial tilt in degrees", "compare": "optional more latitudes for the year chart" },
    observables: { "declination": "subsolar latitude", "day_length / night_length": "hours", "noon_altitude": "degrees", "daytype": "category: ordinary | polar day | polar night" },
    examples: ["day-length", "polar-day"],
    stages: ["orbit"],
  },
  timeline: {
    version: "1.0.0",
    summary: "Data series over time (linear between given points) with marked events and a cursor year; reads values and rates at the cursor. Data must come from the video or a cited source.",
    use_when: ["history, demography, economics series with dated values given in the source"],
    not_for: ["made-up data: only use numbers the evidence states"],
    tags: ["history", "economics", "data"],
    fields: { "series": "[{name, label, points: [[t, value], ...]}]", "events": "optional [{t, label}]", "at": "formula: the cursor (usually a year param)", "source": "where the data comes from" },
    observables: { "<series>": "value at the cursor", "<series>_rate": "change per unit time", "<series>_x_start": "multiple of the first value", "<series>_trend": "category: rising | falling | flat" },
    examples: ["population"],
  },
};
