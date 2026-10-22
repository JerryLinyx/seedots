"use client";

import { useMemo, useState } from "react";
import { BROKEN, CASES, SUBJECTS, type Case } from "@seedots/rigs/cases.ts";
import { CASES_3D } from "@seedots/rigs/cases-3d.ts";
import { SUBJECT_CASES } from "@seedots/rigs/cases-subjects.ts";
import { gate, RIGS } from "@seedots/rigs";
import { RigScene } from "./RigScene";

const ALL: Case[] = [...CASES_3D, ...CASES, ...SUBJECT_CASES];

/** Every case through the gates, reuse by subject and by rig, and the cases themselves. */
export function RigGallery() {
  const reports = useMemo(() => ALL.map((c) => ({ c, r: gate(RIGS[c.spec.rig], c.spec), lines: JSON.stringify(c.spec, null, 1).split("\n").length })), []);
  const rejected = useMemo(() => BROKEN.map((b) => ({ ...b, r: gate(RIGS[b.spec.rig], b.spec) })), []);
  const [subject, setSubject] = useState<string>("All");
  const [open, setOpen] = useState(ALL[0].id);
  const shown = reports.filter((x) => subject === "All" || x.c.subject === subject);
  const pick = reports.find((x) => x.c.id === open)!;
  const rigsOf = (s: string) => [...new Set(reports.filter((x) => x.c.subject === s).map((x) => x.c.spec.rig))];

  return (
    <main className="rig-gallery">
      <header>
        <h1>Scene templates</h1>
        <p>
          {ALL.length} cases across {SUBJECTS.length} subjects, built from {Object.keys(RIGS).length} rigs with no case-specific code.{" "}
          {reports.filter((x) => x.r.ok).length}/{ALL.length} pass the gates; {rejected.filter((x) => !x.r.ok).length}/{rejected.length} broken specs are rejected.
        </p>
      </header>

      <section className="rig-summary">
        {SUBJECTS.map((s) => {
          const n = reports.filter((x) => x.c.subject === s);
          return (
            <button key={s} type="button" className={subject === s ? "on" : ""} onClick={() => setSubject(subject === s ? "All" : s)}>
              <b>{n.length}</b>
              <span>{s}</span>
              <small>{rigsOf(s).join(" · ")}</small>
            </button>
          );
        })}
      </section>

      <section className="rig-reuse">
        <h2>Rig reuse</h2>
        <table className="rig-table">
          <thead>
            <tr><th>Rig</th><th>Cases</th><th>Subjects using it</th></tr>
          </thead>
          <tbody>
            {Object.values(RIGS).map((rig) => {
              const used = reports.filter((x) => x.c.spec.rig === rig.id);
              return (
                <tr key={rig.id}>
                  <td>{rig.label}</td>
                  <td>{used.length}</td>
                  <td>{[...new Set(used.map((x) => x.c.subject))].join(", ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <table className="rig-table">
        <thead>
          <tr><th>Case</th><th>Subject</th><th>Rig</th><th>Source</th><th>Lines</th><th>Gates</th><th>Answer</th></tr>
        </thead>
        <tbody>
          {shown.map(({ c, r, lines }) => (
            <tr key={c.id} className={open === c.id ? "on" : ""} onClick={() => setOpen(c.id)}>
              <td>{c.spec.title}</td>
              <td>{c.subject}</td>
              <td>{c.spec.rig}{c.spec.stage ? <b className="rig-3d">3D</b> : null}</td>
              <td>{c.was ? `was: ${c.was}` : c.source}</td>
              <td>{lines}</td>
              <td className={r.ok ? "ok" : "bad"}>{r.ok ? "pass" : r.problems.join("; ")}</td>
              <td>{r.answer}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <RigScene key={pick.c.id} spec={pick.c.spec} />

      <section>
        <h2>Gate self-test</h2>
        <p>Each spec below is a passing case broken on purpose. The gates must reject all of them: {rejected.filter((x) => !x.r.ok).length}/{rejected.length} rejected.</p>
        <table className="rig-table">
          <thead>
            <tr><th>Broken how</th><th>Rejected</th><th>What the gates said</th></tr>
          </thead>
          <tbody>
            {rejected.map(({ why, r }) => (
              <tr key={why}>
                <td>{why}</td>
                <td className={r.ok ? "bad" : "ok"}>{r.ok ? "no — missed" : "yes"}</td>
                <td>{r.problems.join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
