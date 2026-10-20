// The scene expression language — a line-for-line port of
// services/seedots/learning/scenes/expr.py and the simulation helpers in spec.py.
// Keep the two in step: the server computes the answers, the browser draws them.

type Node =
  | { k: "num"; v: number }
  | { k: "var"; name: string }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log, sqrt: Math.sqrt, abs: Math.abs,
  min: Math.min, max: Math.max, pow: Math.pow, tanh: Math.tanh, atan: Math.atan, sign: Math.sign, floor: Math.floor,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const TOKEN = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|(.))/y;

function tokens(src: string): [string, string][] {
  const out: [string, string][] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (TOKEN.lastIndex < src.length && (m = TOKEN.exec(src))) {
    if (m[1] !== undefined) out.push(["num", m[1]]);
    else if (m[2] !== undefined) out.push(["name", m[2]]);
    else if (m[3] !== undefined && m[3].trim()) {
      if (!"+-*/^(),".includes(m[3])) throw new Error(`unexpected ${m[3]}`);
      out.push(["op", m[3]]);
    }
  }
  out.push(["end", ""]);
  return out;
}

export function parse(src: string): Node {
  const t = tokens(src);
  let i = 0;
  const peek = () => t[i];
  const isOp = (v: string) => t[i][0] === "op" && t[i][1] === v;
  const take = () => t[i++];
  function sum(): Node {
    let n = prod();
    while (isOp("+") || isOp("-")) {
      const op = take()[1];
      n = { k: "bin", op, a: n, b: prod() };
    }
    return n;
  }
  function prod(): Node {
    let n = unary();
    while (isOp("*") || isOp("/")) {
      const op = take()[1];
      n = { k: "bin", op, a: n, b: unary() };
    }
    return n;
  }
  function unary(): Node {
    if (isOp("-")) {
      take();
      return { k: "neg", a: unary() };
    }
    if (isOp("+")) {
      take();
      return unary();
    }
    return power();
  }
  function power(): Node {
    const base = atom();
    if (isOp("^")) {
      take();
      return { k: "bin", op: "^", a: base, b: unary() };
    }
    return base;
  }
  function atom(): Node {
    const [kind, val] = peek();
    if (kind === "num") {
      take();
      return { k: "num", v: parseFloat(val) };
    }
    if (kind === "name") {
      take();
      if (isOp("(")) {
        if (!FUNCS[val]) throw new Error(`unknown function ${val}`);
        take();
        const args = [sum()];
        while (isOp(",")) {
          take();
          args.push(sum());
        }
        if (!isOp(")")) throw new Error("expected )");
        take();
        return { k: "call", fn: val, args };
      }
      return { k: "var", name: val };
    }
    if (isOp("(")) {
      take();
      const n = sum();
      if (!isOp(")")) throw new Error("expected )");
      take();
      return n;
    }
    throw new Error("unexpected end");
  }
  const n = sum();
  if (peek()[0] !== "end") throw new Error("unexpected input");
  return n;
}

export function evaluate(n: Node, env: Record<string, number>): number {
  switch (n.k) {
    case "num":
      return n.v;
    case "var":
      return n.name in env ? env[n.name] : n.name in CONSTS ? CONSTS[n.name] : NaN;
    case "neg":
      return -evaluate(n.a, env);
    case "call":
      return FUNCS[n.fn](...n.args.map((a) => evaluate(a, env)));
    case "bin": {
      const a = evaluate(n.a, env);
      const b = evaluate(n.b, env);
      if (n.op === "+") return a + b;
      if (n.op === "-") return a - b;
      if (n.op === "*") return a * b;
      if (n.op === "/") return b === 0 ? NaN : a / b;
      const r = Math.pow(a, b);
      return Number.isFinite(r) ? r : Math.abs(r) === Infinity ? NaN : NaN;
    }
  }
}

export function iterate(update: Node, start: number, steps: number, env: Record<string, number>): number[] {
  const xs = [start];
  for (let k = 0; k < steps; k++) {
    const nxt = evaluate(update, { ...env, x: xs[xs.length - 1], n: k });
    xs.push(nxt);
    if (!Number.isFinite(nxt) || Math.abs(nxt) > 1e9) break;
  }
  return xs;
}

export function behaviour(xs: number[]): "settles down" | "keeps bouncing" | "blows up" {
  if (xs.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e6)) return "blows up";
  const d = xs.slice(1).map((v, i) => v - xs[i]);
  const tail = d.slice(-8);
  const scale = 1 + Math.max(...xs.map(Math.abs));
  if (tail.slice(-3).every((v) => Math.abs(v) < 1e-3 * scale)) return "settles down";
  const first = d.length ? Math.abs(d[Math.floor(d.length / 2)]) : 0;
  const last = d.length ? Math.abs(d[d.length - 1]) : 0;
  let alternating = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i] * tail[i - 1] < 0) alternating++;
  if (last > first * 1.5 && last > 1e-2 * scale) return "blows up";
  if (alternating >= tail.length - 2 && last > 0.5 * first) return "keeps bouncing";
  return "settles down";
}

export function change(before: number, after: number): "goes up" | "goes down" | "stays about the same" {
  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return (Number.isFinite(after) ? after : Infinity) > before ? "goes up" : "goes down";
  }
  const tol = 0.02 * Math.max(1, Math.abs(before));
  return after - before > tol ? "goes up" : before - after > tol ? "goes down" : "stays about the same";
}
