// Launcher view of the particle rig: a launcher on a field, the ball's flight up to the time param, a glowing
// trail, a marker for the highest point and one where it lands, and distance boards every 10 m.
// Drawn at 1 : 10 (one world unit is 10 m) so a 90 m throw fits on screen.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { run, type ParticleConfig } from "@seedots/rigs/particle.ts";
import type { Env } from "@seedots/rigs/spec.ts";
import { glowSprite, materials, polyline, shadowed, textSprite } from "./parts";
import { drop } from "./stage";
import { stateAt } from "./track";
import type { View3D } from "./types";

type LauncherStage = { kind: "launcher"; angle: string };
const S = 0.1;

export const launcherView: View3D = {
  kind: "launcher",
  rig: "particle",
  label: "Launcher on a field",

  build(ctx, spec, env0) {
    const { stage } = ctx;
    const m = materials(stage.dark);
    const c = spec.config as unknown as ParticleConfig;
    const st = spec.stage as unknown as LauncherStage;
    const timeParam = c.reveal!;
    const g = new THREE.Group();
    stage.root.add(g);
    stage.frame([-2.2, 2.6, 8.5], [4, 0.6, 0]);
    stage.shadowBox(7);
    stage.sun.position.set(-3, 9, 5);
    stage.look({ aoRadius: 0.3, bloom: 0.7 });

    // the field: a mown lawn with stripes, and boards every 10 m
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 512;
    const cg = cv.getContext("2d")!;
    for (let i = 0; i < 16; i++) {
      cg.fillStyle = i % 2 ? (stage.dark ? "#2f4a32" : "#7fa86a") : stage.dark ? "#355238" : "#8ab474";
      cg.fillRect(i * 32, 0, 32, 512);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    const field = new THREE.Mesh(new THREE.PlaneGeometry(14, 8), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    field.rotation.x = -Math.PI / 2;
    field.position.set(4.5, 0, 0);
    field.receiveShadow = true;
    g.add(field);
    for (let d = 10; d <= 100; d += 10) {
      const board = new THREE.Mesh(new RoundedBoxGeometry(0.02, 0.12, 0.3, 2, 0.005), m.plastic("#f2f5ef"));
      board.position.set(d * S, 0.06, -0.9);
      const tag = textSprite(`${d} m`, "#20251f", 0.09);
      tag.position.set(d * S, 0.07, -0.88);
      g.add(shadowed(board), tag);
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.008, 1.6), new THREE.MeshBasicMaterial({ color: "#f2f5ef", transparent: true, opacity: 0.55 }));
      line.rotation.x = -Math.PI / 2;
      line.position.set(d * S, 0.002, -0.1);
      g.add(line);
    }

    // the launcher: a base and a barrel that tilts to the launch angle
    const base = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.08, 0.24, 3, 0.02), m.darkMetal);
    base.position.y = 0.04;
    const pivot = new THREE.Group();
    pivot.position.y = 0.1;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.32, 24), m.plastic("#2f5d4a"));
    barrel.position.y = 0.16;
    pivot.add(barrel);
    const yoke = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 8, 24, Math.PI), m.steel);
    yoke.position.y = 0.1;
    g.add(shadowed(base), shadowed(pivot), shadowed(yoke));

    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.045, 24, 16), m.plastic("#b5442e"));
    ball.castShadow = true;
    const trail = polyline("#ffb347", 3, stage.resolution, 2.5);
    const peakLine = polyline(stage.dark ? "#c9d2cc" : "#4a5a51", 1.2, stage.resolution, 1, true);
    const peakTag = textSprite("", m.ink, 0.1);
    const landing = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.11, 32), m.glow("#d8a31a", 2.5));
    landing.rotation.x = -Math.PI / 2;
    const landGlow = glowSprite("#d8a31a", 0.5, 0.6);
    g.add(ball, trail.line, peakLine.line, peakTag, landing, landGlow);
    let landTag = textSprite("", m.ink, 0.1);
    g.add(landTag);

    let key = "";
    let traj = { ts: [0], ss: [[0, 0, 0, 0]] };
    function update(env: Env) {
      const k = spec.params.filter((p) => p.name !== timeParam).map((p) => env[p.name]).join(",");
      if (k !== key) {
        key = k;
        traj = run(c, env);
        pivot.rotation.z = -((90 - env[st.angle]) * Math.PI) / 180;
        landTag.removeFromParent();
        drop(landTag);
        const T = traj.ss[traj.ss.length - 1];
        landTag = textSprite(`${T[0].toFixed(1)} m`, m.ink, 0.12);
        g.add(landTag);
      }
      const t = env[timeParam];
      const n = Math.max(1, traj.ts.filter((x) => x <= t + 1e-9).length);
      const s = stateAt(traj.ts, traj.ss, t);
      const P = (q: number[]) => new THREE.Vector3(q[0] * S, q[1] * S + 0.1, 0);
      ball.position.copy(P(s));
      trail.set([...traj.ss.slice(0, n).map(P), P(s)]);
      // highest point so far, and the landing spot once it has landed
      let top = traj.ss[0];
      for (const q of traj.ss.slice(0, n)) if (q[1] > top[1]) top = q;
      const peak = P(top);
      peakLine.set([new THREE.Vector3(peak.x, 0.003, 0), peak]);
      peakTag.position.set(peak.x, peak.y + 0.12, 0);
      (peakTag.material.map as THREE.Texture).dispose();
      const fresh = textSprite(`${top[1].toFixed(1)} m high`, m.ink, 0.1);
      peakTag.material.map = fresh.material.map;
      peakTag.scale.copy(fresh.scale);
      fresh.material.dispose();
      const landed = t >= traj.ts[traj.ts.length - 1] - 1e-6;
      const end = P(traj.ss[traj.ss.length - 1]);
      landing.visible = landGlow.visible = landTag.visible = landed;
      landing.position.set(end.x, 0.004, 0);
      landGlow.position.set(end.x, 0.05, 0);
      landTag.position.set(end.x, 0.25, 0.2);
    }
    update(env0);
    return { update, dispose: () => drop(g) };
  },
};
