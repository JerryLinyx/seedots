// Oscillator views of the particle rig. Both replay the rig's integrated run on a loop, in real time,
// so the motion on screen is exactly the motion the readouts measure.
//   pendulum: x is the angle (rad); a bob on a string from a retort stand, a protractor, a fading trail.
//   spring:   x is the displacement (m); a block on a low rail tied to a wall by a coil spring.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { run, type ParticleConfig } from "@seedots/rigs/particle.ts";
import type { Env } from "@seedots/rigs/spec.ts";
import { floor, materials, polyline, retortStand, shadowed, spring, textSprite } from "./parts";
import { drop } from "./stage";
import { stateAt } from "./track";
import type { View3D } from "./types";

/** Loop a run in real time; returns the current state. */
function player(c: ParticleConfig) {
  let traj = { ts: [0], ss: [[0, 0, 0, 0]] };
  let key = "";
  let t = 0;
  return {
    load(env: Env, params: string[]) {
      const k = params.map((p) => env[p]).join(",");
      if (k !== key) {
        key = k;
        traj = run(c, env);
        t = 0;
      }
    },
    step(dt: number) {
      t += dt;
      const T = traj.ts[traj.ts.length - 1];
      if (t > T) t = 0;
      return { t, s: stateAt(traj.ts, traj.ss, t) };
    },
    get traj() {
      return traj;
    },
  };
}

export const pendulumView: View3D = {
  kind: "pendulum",
  rig: "particle",
  label: "Pendulum on a stand",

  build(ctx, spec, env0) {
    const { stage } = ctx;
    const m = materials(stage.dark);
    const c = spec.config as unknown as ParticleConfig;
    const lenParam = (spec.stage as unknown as { length: string }).length;
    const g = new THREE.Group();
    stage.root.add(g);
    stage.look({ aoRadius: 0.05, bloom: 0.6 });
    stage.sun.position.set(-1.2, 4, 2.5);
    g.add(floor(0, 10, stage.dark));

    const rig = new THREE.Group();
    g.add(rig);
    const bob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 32, 24), m.brass);
    bob.castShadow = true;
    const string = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: stage.dark ? "#e6e2d8" : "#333" }));
    const trail = polyline("#d8a31a", 2.5, stage.resolution, 2.2);
    const release = polyline(stage.dark ? "#9aa59e" : "#7a857e", 1.2, stage.resolution, 1, true);
    g.add(bob, string, trail.line, release.line);

    const p = player(c);
    let pivot = new THREE.Vector3();
    let L = 1;
    let built = -1;
    const history: THREE.Vector3[] = [];

    function rebuild(env: Env) {
      L = env[lenParam];
      if (L === built) return;
      built = L;
      rig.children.slice().forEach((o) => drop(o));
      const H = L + 0.28;
      pivot = new THREE.Vector3(0, H - 0.02, 0);
      const stand = retortStand(m, H + 0.06, H - 0.02, 0.1);
      stand.position.x = 0.03 - 0.03;
      rig.add(stand);
      // protractor behind the pivot
      const prot = new THREE.Group();
      const arc = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.13, 48, 1, Math.PI, Math.PI), new THREE.MeshStandardMaterial({ color: stage.dark ? "#d9d4c7" : "#f4f1e8", side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
      prot.add(arc);
      for (let d = -80; d <= 80; d += 10) {
        const a = ((d - 90) * Math.PI) / 180;
        const tick = new THREE.Mesh(new THREE.BoxGeometry(0.0015, d % 30 === 0 ? 0.02 : 0.01, 0.001), new THREE.MeshBasicMaterial({ color: "#222" }));
        tick.position.set(Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0.001);
        tick.rotation.z = a + Math.PI / 2;
        prot.add(tick);
        if (d % 30 === 0) {
          const s = textSprite(`${Math.abs(d)}°`, m.ink, 0.014);
          s.position.set(Math.cos(a) * 0.145, Math.sin(a) * 0.145, 0.002);
          prot.add(s);
        }
      }
      prot.position.copy(pivot).add(new THREE.Vector3(0, 0, -0.01));
      rig.add(prot);
      stage.frame([0.25, H * 0.65, H * 1.45 + 0.4], [0, H * 0.55, 0]);
      stage.shadowBox(Math.max(1, H));
      history.length = 0;
    }

    const at = (angle: number) => new THREE.Vector3(Math.sin(angle) * L, pivot.y - Math.cos(angle) * L, 0);

    const off = stage.onFrame((dt) => {
      const { s } = p.step(dt);
      const pos = at(s[0]);
      bob.position.copy(pos);
      string.geometry.dispose();
      string.geometry = new THREE.BufferGeometry().setFromPoints([pivot, pos]);
      history.push(pos.clone());
      if (history.length > 90) history.shift();
      trail.set(history);
    });

    function update(env: Env) {
      rebuild(env);
      p.load(env, spec.params.map((x) => x.name));
      const a0 = p.traj.ss[0][0];
      release.set([pivot, at(a0)]);
      history.length = 0;
    }
    update(env0);
    return {
      update,
      dispose() {
        off();
        drop(g);
      },
    };
  },
};

export const springView: View3D = {
  kind: "spring",
  rig: "particle",
  label: "Mass on a spring",

  build(ctx, spec, env0) {
    const { stage } = ctx;
    const m = materials(stage.dark);
    const c = spec.config as unknown as ParticleConfig;
    const g = new THREE.Group();
    stage.root.add(g);
    stage.frame([0.1, 0.95, 3.2], [0.1, 0.02, 0]);
    stage.shadowBox(1.8);
    stage.look({ aoRadius: 0.05, bloom: 0.5 });
    stage.sun.position.set(-1.5, 3.5, 2.5);

    const REST = 1.25; // spring length at equilibrium; the block's centre sits at x = WALL + REST + half block
    const WALL = -1.1;
    const HALF = 0.08;
    const base = new THREE.Mesh(new RoundedBoxGeometry(2.9, 0.04, 0.3, 3, 0.01), m.wood(3));
    base.position.set(0.25, -0.02, 0);
    const wall = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.32, 0.3, 3, 0.01), m.darkMetal);
    wall.position.set(WALL - 0.03, 0.16, 0);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.006, 0.12), m.aluminium);
    rail.position.set(0.3, 0.003, 0);
    g.add(shadowed(base), shadowed(wall), shadowed(rail), floor(-0.04, 10, stage.dark));

    const eqX = WALL + REST + HALF;
    const mark = polyline("#d8a31a", 1.5, stage.resolution, 1.6, true);
    mark.set([new THREE.Vector3(eqX, 0.006, 0.07), new THREE.Vector3(eqX, 0.25, 0.07)]);
    const eqLabel = textSprite("equilibrium", m.ink, 0.045);
    eqLabel.position.set(eqX, 0.28, 0.07);
    g.add(mark.line, eqLabel);

    const coil = spring(m, 14, 0.035, 0.004);
    coil.mesh.position.set(WALL, 0.07, 0);
    g.add(coil.mesh);
    const block = new THREE.Mesh(new RoundedBoxGeometry(HALF * 2, 0.14, 0.14, 4, 0.012), m.plastic("#b5442e"));
    block.position.y = 0.073;
    g.add(shadowed(block));
    const label = textSprite("m", "#f2f5ef", 0.05);
    g.add(label);

    const p = player(c);
    const off = stage.onFrame((dt) => {
      const { s } = p.step(dt);
      const x = s[0]; // true scale: 1 m of displacement is 1 m on the bench
      block.position.x = eqX + x;
      label.position.set(eqX + x, 0.073, 0.072);
      coil.setLength(REST + x);
    });

    const update = (env: Env) => p.load(env, spec.params.map((x) => x.name));
    update(env0);
    return {
      update,
      dispose() {
        off();
        drop(g);
      },
    };
  },
};
