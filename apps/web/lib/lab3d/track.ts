// Track view of the particle rig: a cart on an aluminium track, pulled by a hanging mass over a pulley,
// dragging paper tape through a ticker timer that marks a dot every 0.02 s. The cart's x(t) comes from the
// rig's integration; the view only places things. World units are metres.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { run, type ParticleConfig } from "@seedots/rigs/particle.ts";
import type { Env } from "@seedots/rigs/spec.ts";
import { arrow, bench, floor, glowSprite, massStack, materials, pulley, ruler, shadowed, textSprite } from "./parts";
import { drop } from "./stage";
import type { View3D } from "./types";

type TrackStage = { kind: "track"; length: number; hanging?: string; cart?: string };
const TICK = 0.02;

/** State at time t by linear interpolation of an integrated run. */
export function stateAt(ts: number[], ss: number[][], t: number): number[] {
  if (t <= 0) return ss[0];
  const k = ts.findIndex((x) => x >= t);
  if (k < 0) return ss[ss.length - 1];
  if (k === 0) return ss[0];
  const f = (t - ts[k - 1]) / (ts[k] - ts[k - 1]);
  return ss[k - 1].map((v, i) => v + (ss[k][i] - v) * f);
}

export const trackView: View3D = {
  kind: "track",
  rig: "particle",
  label: "Track and ticker timer",

  build(ctx, spec, env0) {
    const { stage } = ctx;
    const m = materials(stage.dark);
    const c = spec.config as unknown as ParticleConfig;
    const st = spec.stage as unknown as TrackStage;
    const L = st.length;
    const timeParam = c.reveal!;
    const x0 = -L / 2 + 0.14; // the cart's start, world x
    const timerX = -L / 2 + 0.03;
    const pulleyX = L / 2 + 0.16;
    const g = new THREE.Group();
    stage.root.add(g);
    stage.frame([-0.25, 0.32, 1.45], [0.12, -0.12, 0]);
    stage.shadowBox(1.6);
    stage.sun.position.set(-1.5, 3.5, 2.5);
    stage.look({ aoRadius: 0.04, bloom: 0.5 });

    g.add(bench(m, -L / 2 - 0.15, pulleyX - 0.012, 0.55, -1.15), floor(-1.15, 12, stage.dark));

    // track with a ruler on its front face, and an end stop
    const rail = new THREE.Mesh(new THREE.BoxGeometry(L, 0.02, 0.08), m.aluminium);
    rail.position.y = 0.01;
    g.add(shadowed(rail));
    for (const z of [-0.025, 0.025]) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(L, 0.008, 0.006), m.aluminium);
      lip.position.set(0, 0.024, z);
      g.add(shadowed(lip));
    }
    g.add(ruler(m, x0, L / 2 - 0.02 - x0, 0.015, 0.0405));
    const stop = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.08), m.rubber);
    stop.position.set(L / 2 - 0.01, 0.04, 0);
    g.add(shadowed(stop));

    // ticker timer with a lamp that glows while it runs
    const box = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.06, 0.1, 3, 0.008), m.plastic("#2f5d4a"));
    box.position.set(timerX, 0.05, 0);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.005, 12, 8), m.glow("#ff5533", 0.4));
    lamp.position.set(timerX + 0.036, 0.065, 0.03);
    const halo = glowSprite("#ff5533", 0.04, 0);
    halo.position.copy(lamp.position);
    const tag = textSprite("50 Hz", "#f2f5ef", 0.012);
    tag.position.set(timerX + 0.036, 0.05, 0.035);
    g.add(shadowed(box), lamp, halo, tag);

    // cart, with weights on top showing its mass
    const cart = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.035, 0.075, 4, 0.008), m.plastic("#b5442e"));
    body.position.y = 0.045;
    cart.add(body);
    for (const [dx, dz] of [[-0.055, -0.042], [0.055, -0.042], [-0.055, 0.042], [0.055, 0.042]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.01, 24), m.rubber);
      w.rotation.x = Math.PI / 2;
      w.position.set(dx, 0.033, dz);
      cart.add(w);
    }
    const load = new THREE.Group();
    cart.add(load);
    g.add(shadowed(cart));
    const pull = arrow("#d8a31a", 0.004);
    g.add(pull.group);

    const wheel = pulley(m, 0.03);
    wheel.position.set(pulleyX, 0.06, 0);
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 0.05), m.darkMetal);
    clamp.position.set(pulleyX - 0.012, 0, 0);
    g.add(wheel, shadowed(clamp));

    const hanger = new THREE.Group();
    g.add(hanger);
    const string = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: stage.dark ? "#e6e2d8" : "#3a3a3a" }));
    g.add(string);

    // paper tape and its dots
    const tape = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.022), m.paper);
    tape.rotation.x = -Math.PI / 2;
    tape.receiveShadow = true;
    g.add(tape);
    const MAXDOTS = 400;
    const dots = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.0008, 12), new THREE.MeshBasicMaterial({ color: "#1a1a1a" }), MAXDOTS);
    dots.frustumCulled = false; // instances move every frame; a stale bounding sphere would hide them
    g.add(dots);

    let key = "";
    let traj: { ts: number[]; ss: number[][] } = { ts: [0], ss: [[0, 0, 0, 0]] };
    let massKey = "";
    let hangH = 0.1;

    function update(env: Env) {
      const k = spec.params.filter((p) => p.name !== timeParam).map((p) => env[p.name]).join(",");
      if (k !== key) {
        key = k;
        traj = run(c, env);
      }
      const mk = `${st.hanging ? env[st.hanging] : 0}|${st.cart ? env[st.cart] : 0}`;
      if (mk !== massKey) {
        massKey = mk;
        hanger.children.slice().forEach((o) => drop(o));
        const stack = massStack(m, st.hanging ? Math.min(12, Math.max(1, Math.round(env[st.hanging] / 0.01))) : 1);
        hanger.add(stack.group);
        hangH = stack.height;
        load.children.slice().forEach((o) => drop(o));
        const extra = st.cart ? Math.max(0, Math.round((env[st.cart] - 0.25) / 0.25)) : 0;
        for (let i = 0; i < extra; i++) {
          const b = new THREE.Mesh(new RoundedBoxGeometry(0.05, 0.016, 0.05, 2, 0.003), m.steel);
          b.position.set(-0.04 + (i % 3) * 0.04, 0.071 + Math.floor(i / 3) * 0.017, 0);
          load.add(shadowed(b));
        }
      }

      const t = env[timeParam];
      const s = stateAt(traj.ts, traj.ss, t);
      const dx = s[0] - traj.ss[0][0];
      const cartX = x0 + dx;
      cart.position.x = cartX;
      const running = t > 0 && t < traj.ts[traj.ts.length - 1];
      (lamp.material as THREE.MeshBasicMaterial).color.set("#ff5533").multiplyScalar(running ? 4 : 0.4);
      halo.material.opacity = running ? 0.8 : 0;

      // the pull on the cart while it runs, its length proportional to the acceleration
      const a = t > 0 ? (s[2] - traj.ss[0][2]) / t : 0;
      pull.set(new THREE.Vector3(cartX + 0.08, 0.075, 0), new THREE.Vector3(Math.min(0.25, Math.max(0, a) * 0.05), 0, 0));
      pull.group.visible = running;

      // the hanging mass drops as far as the cart moves
      const hookY = -0.06 - dx;
      hanger.position.set(pulleyX + 0.03, hookY - hangH, 0);
      const front = cartX + 0.08;
      string.geometry.dispose();
      string.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(front, 0.05, 0),
        new THREE.Vector3(pulleyX - 0.004, 0.09, 0),
        new THREE.Vector3(pulleyX + 0.03, 0.06, 0),
        new THREE.Vector3(pulleyX + 0.03, hookY, 0),
      ]);

      // tape runs from the timer to the cart's back; a dot was struck at the timer every 0.02 s
      const rear = cartX - 0.08;
      const len = Math.max(0.001, rear - timerX);
      tape.scale.x = len;
      tape.position.set(timerX + len / 2, 0.0285, 0);
      let n = 0;
      const M = new THREE.Matrix4();
      for (let tk = 0; tk <= t + 1e-9 && n < MAXDOTS; tk += TICK, n++) {
        M.makeTranslation(timerX + (s[0] - stateAt(traj.ts, traj.ss, tk)[0]), 0.029, 0);
        dots.setMatrixAt(n, M);
      }
      dots.count = n;
      dots.instanceMatrix.needsUpdate = true;
    }
    update(env0);

    return { update, dispose: () => drop(g) };
  },
};
