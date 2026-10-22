// Cross rig (Mendelian genetics): one or two genes, each parent's genotype chosen by a seg param
// (0 = homozygous dominant, 1 = heterozygous, 2 = homozygous recessive). Draws the Punnett square and,
// with a param for how many offspring to raise, the observed counts against the expected ones.

import { Plot } from "./plot.ts";
import { checkExpr, ev, type Rig } from "./runtime.ts";
import type { Env, Observed } from "./spec.ts";

type Gene = { letter: string; dominant: string; recessive: string; mode?: "complete" | "incomplete"; middle?: string };
export type CrossConfig = {
  genes: Gene[]; // 1 or 2
  mother: string[]; // one param per gene
  father: string[];
  offspring?: string; // formula for the number raised (seeded sampling)
  seed?: number;
};

const RATIOS = ["all one phenotype", "3 : 1", "1 : 1", "1 : 2 : 1", "9 : 3 : 3 : 1", "1 : 1 : 1 : 1", "3 : 3 : 1 : 1", "another ratio"];
const TONES = ["c0", "c2", "c3", "accent", "c1"] as const;

function alleles(g: Gene, code: number): [string, string] {
  const A = g.letter.toUpperCase();
  const a = g.letter.toLowerCase();
  return code <= 0 ? [A, A] : code >= 2 ? [a, a] : [A, a];
}

/** Gametes with probabilities, then every pairing; phenotype per offspring genotype. */
function cross(c: CrossConfig, env: Env) {
  const parent = (ps: string[]) => c.genes.map((g, i) => alleles(g, Math.round(env[ps[i]])));
  const gametes = (al: [string, string][]) => {
    let out: string[] = [""];
    for (const pair of al) out = out.flatMap((g) => pair.map((x) => g + x));
    return out;
  };
  const m = gametes(parent(c.mother));
  const f = gametes(parent(c.father));
  const pheno = (geno: string) =>
    c.genes
      .map((g, i) => {
        const pair = geno[i] + geno[i + c.genes.length];
        const dom = (pair.match(new RegExp(g.letter.toUpperCase(), "g")) ?? []).length;
        if ((g.mode ?? "complete") === "incomplete") return dom === 2 ? g.dominant : dom === 1 ? (g.middle ?? "intermediate") : g.recessive;
        return dom > 0 ? g.dominant : g.recessive;
      })
      .join(", ");
  const cells = m.map((x) => f.map((y) => ({ geno: x + y, pheno: pheno(x + y) })));
  // phenotype classes in a stable order: by how dominant they are
  const all = [...new Set(cells.flat().map((x) => x.pheno))];
  const order = phenotypes(c).filter((p) => all.includes(p));
  const prob = order.map((p) => cells.flat().filter((x) => x.pheno === p).length / cells.flat().length);
  return { m, f, cells, order, prob };
}

/** "ABab" (mother's gamete + father's) → "AaBb". */
const show = (geno: string, n: number) =>
  Array.from({ length: n }, (_, i) => [geno[i], geno[i + n]].sort((x, y) => (x === x.toUpperCase() ? -1 : 1) - (y === y.toUpperCase() ? -1 : 1)).join("")).join("");

function phenotypes(c: CrossConfig): string[] {
  let out: string[] = [""];
  for (const g of c.genes) {
    const opts = (g.mode ?? "complete") === "incomplete" ? [g.dominant, g.middle ?? "intermediate", g.recessive] : [g.dominant, g.recessive];
    out = out.flatMap((x) => opts.map((o) => (x ? `${x}, ${o}` : o)));
  }
  return out;
}

function ratio(prob: number[]): string {
  const p = [...prob].sort((a, b) => b - a);
  const is = (r: number[]) => r.length === p.length && r.every((x, i) => Math.abs(x / r.reduce((a, b) => a + b, 0) - p[i]) < 1e-9);
  if (p.length === 1) return RATIOS[0];
  if (is([3, 1])) return RATIOS[1];
  if (is([1, 1])) return RATIOS[2];
  if (is([2, 1, 1])) return RATIOS[3];
  if (is([9, 3, 3, 1])) return RATIOS[4];
  if (is([1, 1, 1, 1])) return RATIOS[5];
  if (is([3, 3, 1, 1])) return RATIOS[6];
  return RATIOS[7];
}

function sample(c: CrossConfig, env: Env, prob: number[]) {
  const n = c.offspring ? Math.max(0, Math.round(ev(c.offspring, env))) : 0;
  let s = (c.seed ?? 5) >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const counts = prob.map(() => 0);
  for (let k = 0; k < n; k++) {
    const u = r();
    let i = 0;
    for (let acc = prob[0]; u > acc && i < prob.length - 1; acc += prob[++i]);
    counts[i]++;
  }
  let chi2 = 0;
  prob.forEach((x, i) => n && x > 0 && (chi2 += (counts[i] - n * x) ** 2 / (n * x)));
  return { n, counts, chi2 };
}

export const crossRig: Rig<CrossConfig> = {
  id: "cross",
  label: "Genetic cross",

  check(c, params) {
    const out: string[] = [];
    if (!(c.genes?.length >= 1 && c.genes.length <= 2)) out.push("1 or 2 genes");
    if (c.mother?.length !== c.genes?.length || c.father?.length !== c.genes?.length) out.push("one mother and one father param per gene");
    for (const p of [...(c.mother ?? []), ...(c.father ?? [])]) if (!params.has(p)) out.push(`no param ${p}`);
    if (c.offspring) out.push(...checkExpr(c.offspring, params, "offspring"));
    return out;
  },

  observables(c) {
    const k = phenotypes(c).length;
    return { numeric: [...Array.from({ length: k }, (_, i) => [`p${i}`, `count${i}`]).flat(), "n", "chi2"], categories: { ratio: RATIOS } };
  },

  observe(c, env) {
    const X = cross(c, env);
    const all = phenotypes(c);
    const full = all.map((p) => X.prob[X.order.indexOf(p)] ?? 0);
    const S = sample(c, env, full);
    const out: Observed = { n: S.n, chi2: S.chi2, ratio: ratio(X.prob) };
    full.forEach((x, i) => Object.assign(out, { [`p${i}`]: x, [`count${i}`]: S.counts[i] }));
    return out;
  },

  draw(c, env) {
    const X = cross(c, env);
    const all = phenotypes(c);
    const k = X.m.length;
    const g = new Plot([0, k + 1], [0, k + 1], { h: 360, equal: true });
    const tone = (ph: string) => TONES[all.indexOf(ph) % TONES.length];
    // header row (father's gametes) and column (mother's gametes)
    X.f.forEach((x, j) => g.label(x, [j + 1.5, k + 0.5], "ink", { anchor: "middle", dx: 0, dy: 5, size: 15 }));
    X.m.forEach((x, i) => g.label(x, [0.5, k - i - 0.5], "ink", { anchor: "middle", dx: 0, dy: 5, size: 15 }));
    g.label("♀ \\ ♂", [0.5, k + 0.5], "muted", { anchor: "middle", dx: 0, dy: 5, size: 12 });
    X.cells.forEach((row, i) =>
      row.forEach((cell, j) => {
        g.rect(j + 1.04, k - i - 0.96, j + 1.96, k - i - 0.04, tone(cell.pheno), 0.35);
        g.label(show(cell.geno, c.genes.length), [j + 1.5, k - i - 0.5], "ink", { anchor: "middle", dx: 0, dy: 5, size: k > 2 ? 11 : 15 });
      }),
    );
    const out = [g];
    const S = sample(c, env, all.map((p) => X.prob[X.order.indexOf(p)] ?? 0));
    if (c.offspring) {
      const top = Math.max(1, ...S.counts) * 1.2;
      const b = new Plot([-0.6, all.length - 0.4], [0, top], { h: 260 }).axes("", "offspring", { xTicks: false });
      all.forEach((ph, i) => {
        const pr = X.prob[X.order.indexOf(ph)] ?? 0;
        b.rect(i - 0.3, 0, i + 0.3, S.counts[i], tone(ph), 0.7);
        b.seg([i - 0.38, pr * S.n], [i + 0.38, pr * S.n], "ink", { width: 2, dash: true });
        b.label(ph, [i, 0], "ink", { anchor: "middle", dx: 0, dy: 28, size: 11 });
        b.label(String(S.counts[i]), [i, S.counts[i]], "ink", { anchor: "middle", dx: 0, size: 11 });
      });
      out.push(b);
    }
    return out;
  },
};
