// The rig service: one implementation of lab facts for every caller. Pure computation over
// packages/rigs: no model calls, no network, no state. Runs on Node 22.18+ (TypeScript type stripping).
//
//   GET  /healthz                 liveness, rig count, catalog hash
//   GET  /v1/rigs?q=&tags=&limit= catalog cards, best matches first
//   GET  /v1/rigs/{id}            one card with its example specs
//   GET  /v1/stages               3D presentations and the rig each presents
//   POST /v1/check   {spec}                        gates: {ok, problems, answer, options}
//   POST /v1/observe {spec, set?}                  observables at the defaults (+ set)
//   POST /v1/sweep   {spec, param, from?, to?, n?, observe?}   observables across one param

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CARDS, FORMULAS } from "../../packages/rigs/src/cards.ts";
import { CASES } from "../../packages/rigs/src/cases.ts";
import { CASES_3D } from "../../packages/rigs/src/cases-3d.ts";
import { SUBJECT_CASES } from "../../packages/rigs/src/cases-subjects.ts";
import { clampParam, defaults, gate, predictOptions, RIGS } from "../../packages/rigs/src/index.ts";
import type { Env, SceneSpecV2 } from "../../packages/rigs/src/spec.ts";
import { STAGES } from "../../packages/rigs/src/stages.ts";

const MAX_BODY = 256 * 1024;
const EXAMPLES = new Map([...CASES, ...SUBJECT_CASES, ...CASES_3D].map((c) => [c.id, c.spec]));
export const CATALOG = createHash("sha256").update(JSON.stringify(CARDS)).digest("hex").slice(0, 12);

class Bad extends Error {}

function card(id: string, withExamples: boolean) {
  const c = CARDS[id];
  if (!withExamples) return { id, label: RIGS[id].label, ...c };
  return { id, label: RIGS[id].label, ...c, formulas: FORMULAS, example_specs: c.examples.slice(0, 2).map((e) => EXAMPLES.get(e)).filter(Boolean) };
}

/** Rank rigs for a request: tags first, then words that appear in what the card says. */
export function rank(q: string, tags: string[]): string[] {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const score = (id: string) => {
    const c = CARDS[id];
    const text = [c.summary, ...c.use_when, id].join(" ").toLowerCase();
    return tags.filter((t) => c.tags.includes(t)).length * 3 + words.filter((w) => text.includes(w)).length - words.filter((w) => c.not_for.join(" ").toLowerCase().includes(w)).length * 0.5;
  };
  return Object.keys(CARDS).sort((a, b) => score(b) - score(a));
}

function specOf(body: unknown): SceneSpecV2 {
  const spec = (body as { spec?: unknown })?.spec as SceneSpecV2 | undefined;
  if (!spec || typeof spec !== "object") throw new Bad("body must be {spec: {...}}");
  if (spec.version !== 2) throw new Bad("spec.version must be 2");
  if (!Array.isArray(spec.params) || typeof spec.config !== "object" || !spec.predict) throw new Bad("spec needs params, config and predict");
  return spec;
}

/** Defaults plus the requested settings, clamped to each control's range (unknown names are refused). */
function envOf(spec: SceneSpecV2, set: unknown): Env {
  const env = defaults(spec);
  for (const [k, v] of Object.entries((set ?? {}) as Record<string, unknown>)) {
    const p = spec.params.find((x) => x.name === k);
    if (!p) throw new Bad(`no param ${k}; params are ${spec.params.map((x) => x.name).join(", ")}`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Bad(`${k} must be a number`);
    env[k] = clampParam(p, v);
  }
  return env;
}

export function handle(method: string, path: string, query: URLSearchParams, body: unknown): [number, unknown] {
  if (method === "GET" && path === "/healthz") return [200, { ok: true, rigs: Object.keys(RIGS).length, catalog: CATALOG }];
  if (method === "GET" && path === "/v1/rigs") {
    const tags = (query.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(20, Number(query.get("limit") ?? 20)));
    return [200, { catalog: CATALOG, rigs: rank(query.get("q") ?? "", tags).slice(0, limit).map((id) => card(id, false)) }];
  }
  const one = path.match(/^\/v1\/rigs\/([a-z0-9-]+)$/);
  if (method === "GET" && one) {
    if (!CARDS[one[1]]) return [404, { error: `no rig ${one[1]}; rigs are ${Object.keys(CARDS).join(", ")}` }];
    return [200, { catalog: CATALOG, ...card(one[1], true) }];
  }
  if (method === "GET" && path === "/v1/stages") return [200, Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, { rig: v.rig }]))];

  if (method === "POST" && path === "/v1/check") {
    const spec = specOf(body);
    const rig = RIGS[spec.rig];
    const r = gate(rig, spec);
    return [200, { ok: r.ok, problems: r.problems, answer: r.answer ?? null, options: r.ok ? predictOptions(rig, spec) : [], rig_version: CARDS[spec.rig]?.version ?? null, catalog: CATALOG }];
  }
  if (method === "POST" && path === "/v1/observe") {
    const spec = specOf(body);
    const rig = RIGS[spec.rig];
    if (!rig) throw new Bad(`unknown rig ${spec.rig}`);
    const env = envOf(spec, (body as { set?: unknown }).set);
    return [200, { set: env, observed: rig.observe(spec.config, env) }];
  }
  if (method === "POST" && path === "/v1/sweep") {
    const spec = specOf(body);
    const rig = RIGS[spec.rig];
    if (!rig) throw new Bad(`unknown rig ${spec.rig}`);
    const b = body as { param?: string; from?: number; to?: number; n?: number; observe?: string[] };
    const p = spec.params.find((x) => x.name === b.param);
    if (!p) throw new Bad(`param must be one of ${spec.params.map((x) => x.name).join(", ")}`);
    const lo = b.from ?? p.min ?? 0;
    const hi = b.to ?? p.max ?? 1;
    const n = Math.max(2, Math.min(25, Math.round(b.n ?? 11)));
    const base = defaults(spec);
    const points = Array.from({ length: n }, (_, i) => {
      const v = clampParam(p, lo + ((hi - lo) * i) / (n - 1));
      const obs = rig.observe(spec.config, { ...base, [p.name]: v });
      return { value: v, observed: b.observe?.length ? Object.fromEntries(b.observe.map((k) => [k, obs[k] ?? null])) : obs };
    });
    return [200, { param: p.name, points }];
  }
  return [404, { error: `no route ${method} ${path}` }];
}

function read(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Bad("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Bad("body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function serve(port: number, host = "127.0.0.1") {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    let status = 500;
    let out: unknown;
    try {
      [status, out] = handle(req.method ?? "GET", url.pathname, url.searchParams, req.method === "POST" ? await read(req) : undefined);
    } catch (e) {
      [status, out] = e instanceof Bad ? [400, { error: e.message }] : [500, { error: `rig failed: ${(e as Error).message}` }];
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  server.listen(port, host);
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.SEEDOTS_RIGS_PORT ?? 8002);
  serve(port);
  console.log(`rig service on http://127.0.0.1:${port} (catalog ${CATALOG})`);
}
