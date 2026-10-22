// node --test services/rigs/server.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { CARDS } from "../../packages/rigs/src/cards.ts";
import { BROKEN, CASES } from "../../packages/rigs/src/cases.ts";
import { CASES_3D } from "../../packages/rigs/src/cases-3d.ts";
import { SUBJECT_CASES } from "../../packages/rigs/src/cases-subjects.ts";
import { RIGS } from "../../packages/rigs/src/index.ts";
import { handle, serve } from "./server.ts";

const ALL = [...CASES, ...SUBJECT_CASES, ...CASES_3D];
const post = (path: string, body: unknown) => handle("POST", path, new URLSearchParams(), body);

test("every rig has a card, and every card's examples exist and pass the gates", () => {
  for (const id of Object.keys(RIGS)) {
    const card = CARDS[id];
    assert.ok(card, `no card for ${id}`);
    assert.ok(card.examples.length > 0, `${id}: no examples`);
    for (const ex of card.examples) {
      const c = ALL.find((x) => x.id === ex);
      assert.ok(c, `${id}: example ${ex} is not a case`);
      assert.equal(c.spec.rig, id, `${id}: example ${ex} uses ${c.spec.rig}`);
      const [, r] = post("/v1/check", { spec: c.spec }) as [number, { ok: boolean; problems: string[] }];
      assert.ok(r.ok, `${id}: example ${ex} fails: ${r.problems}`);
    }
  }
});

test("all cases pass /v1/check and return an answer among the options", () => {
  for (const c of ALL) {
    const [status, r] = post("/v1/check", { spec: c.spec }) as [number, { ok: boolean; answer: string; options: string[]; problems: string[] }];
    assert.equal(status, 200);
    assert.ok(r.ok, `${c.id}: ${r.problems}`);
    assert.ok(r.options.includes(r.answer), `${c.id}: answer ${r.answer} not in options`);
  }
});

test("broken specs are rejected with reasons", () => {
  for (const b of BROKEN) {
    const [, r] = post("/v1/check", { spec: b.spec }) as [number, { ok: boolean; problems: string[] }];
    assert.equal(r.ok, false, b.why);
    assert.ok(r.problems.length > 0, b.why);
  }
});

test("observe clamps settings and refuses unknown params", () => {
  const spec = ALL.find((c) => c.id === "infonce-temp")!.spec;
  const [, r] = post("/v1/observe", { spec, set: { tau: 99 } }) as [number, { set: Record<string, number>; observed: Record<string, number> }];
  assert.equal(r.set.tau, 2); // clamped to the control's max
  assert.ok(r.observed.q_p0 > 0 && r.observed.q_p0 < 1);
  assert.throws(() => post("/v1/observe", { spec, set: { nope: 1 } }), /no param nope/);
});

test("sweep returns at most 25 points and only the observables asked for", () => {
  const spec = ALL.find((c) => c.id === "step-size")!.spec;
  const [, r] = post("/v1/sweep", { spec, param: "h", n: 99, observe: ["behaviour"] }) as [number, { points: { value: number; observed: Record<string, unknown> }[] }];
  assert.equal(r.points.length, 25);
  assert.deepEqual(Object.keys(r.points[0].observed), ["behaviour"]);
  assert.equal(r.points.at(-1)!.observed.behaviour, "blows up");
});

test("catalog ranks by tags and words, and the HTTP server answers", async () => {
  const [, r] = handle("GET", "/v1/rigs", new URLSearchParams({ q: "softmax temperature over classes", limit: "3" }), undefined) as [number, { rigs: { id: string }[] }];
  assert.equal(r.rigs[0].id, "distribution");
  const server = serve(0);
  await new Promise((ok) => server.once("listening", ok));
  const port = (server.address() as { port: number }).port;
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(h.ok, true);
  const bad = await fetch(`http://127.0.0.1:${port}/v1/check`, { method: "POST", body: "{not json" });
  assert.equal(bad.status, 400);
  server.close();
});
