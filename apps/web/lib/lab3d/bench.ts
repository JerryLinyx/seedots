// Optical bench view of the optics rig (lens bench): a candle, a lens and a screen on a rail. The three
// principal rays from the flame tip glow (bloom); a real image appears on the screen, upside down and scaled
// by the magnification; a virtual image is drawn as a faint flame behind the candle with dashed rays.
// Distances are true metres along the rail.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { ev } from "@seedots/rigs/runtime.ts";
import type { Env } from "@seedots/rigs/spec.ts";
import { bench, candle, carriage, floor, glowSprite, lens, materials, polyline, ruler, shadowed, textSprite } from "./parts";
import { drop } from "./stage";
import type { View3D } from "./types";

type LensConfig = { bench: "lens"; f: string; u: string; h: string };
const AXIS = 0.16; // height of the optical axis above the rail

export const benchView: View3D = {
  kind: "bench",
  rig: "optics",
  label: "Optical bench",

  build(ctx, spec, env0) {
    const { stage } = ctx;
    const m = materials(stage.dark);
    const c = spec.config as unknown as LensConfig;
    const g = new THREE.Group();
    stage.root.add(g);
    stage.frame([-0.1, 0.38, 1.55], [-0.05, 0.12, 0]);
    stage.shadowBox(1.4);
    stage.sun.position.set(-1, 3, 2);
    stage.sun.intensity *= 0.6; // a dim room, so the flame and the rays read
    stage.look({ aoRadius: 0.03, bloom: 0.45, exposure: 0.95 });

    const X0 = -1.1;
    const X1 = 1.5;
    g.add(bench(m, X0 - 0.1, X1 + 0.1, 0.45, -0.95), floor(-0.95, 10, stage.dark));
    const rail = new THREE.Mesh(new RoundedBoxGeometry(X1 - X0, 0.025, 0.06, 2, 0.005), m.aluminium);
    rail.position.set((X0 + X1) / 2, 0.0125, 0);
    g.add(shadowed(rail), ruler(m, X0 + 0.05, X1 - X0 - 0.1, 0.012, 0.031, 20));

    const FLAME = AXIS + ev(c.h, env0); // the flame tip is the object's top: h above the axis
    const lensObj = new THREE.Group();
    g.add(lensObj);
    const flame = candle(m, FLAME);
    const candleOn = new THREE.Group();
    candleOn.add(carriage(m), flame.group);
    g.add(candleOn);

    // the screen: a white board on a stand, with the image drawn on it
    const screen = new THREE.Group();
    const board = new THREE.Mesh(new RoundedBoxGeometry(0.01, 0.24, 0.2, 2, 0.004), new THREE.MeshStandardMaterial({ color: "#f6f4ee", roughness: 0.9 }));
    board.position.y = AXIS;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, AXIS - 0.12, 12), m.steel);
    post.position.y = (AXIS - 0.12) / 2;
    screen.add(shadowed(board), shadowed(post), carriage(m));
    const image = glowSprite("#ffb347", 0.05, 0.95);
    screen.add(image);
    g.add(screen);
    const ghost = glowSprite("#ffb347", 0.05, 0.45);
    g.add(ghost);

    const rays = [0, 1, 2].map(() => polyline("#ffd27a", 1.6, stage.resolution, 1.5));
    const back = [0, 1].map(() => polyline("#ffd27a", 1.2, stage.resolution, 1, true));
    rays.forEach((r) => g.add(r.line));
    back.forEach((r) => g.add(r.line));
    const fMarks = new THREE.Group();
    g.add(fMarks);
    let caption = textSprite("", m.ink, 0.03);
    g.add(caption);

    let fBuilt = NaN;
    const off = stage.onFrame((dt) => flame.tick(dt));

    function update(env: Env) {
      const f = ev(c.f, env);
      const u = ev(c.u, env);
      const v = Math.abs(u - f) < 1e-6 ? Infinity : (u * f) / (u - f);
      const mag = -v / u;
      if (f !== fBuilt) {
        fBuilt = f;
        lensObj.children.slice().forEach((o) => drop(o));
        lensObj.add(lens(m, 0.06, 0.012, AXIS, f < 0));
        fMarks.children.slice().forEach((o) => drop(o));
        for (const [x, t] of [[-f, "F"], [f, "F′"], [-2 * f, "2F"], [2 * f, "2F′"]] as const) {
          const dot = new THREE.Mesh(new THREE.SphereGeometry(0.004, 12, 8), m.glow("#5b7fa6", 1.5));
          dot.position.set(x, AXIS, 0);
          const s = textSprite(t, m.ink, 0.022);
          s.position.set(x, AXIS - 0.025, 0.02);
          fMarks.add(dot, s);
        }
      }
      candleOn.position.x = -u;
      const tip = new THREE.Vector3(-u, FLAME, 0);
      const h = tip.y - AXIS; // flame tip above the axis
      const real = Number.isFinite(v) && v > 0;
      const screenX = real ? Math.min(v, X1 - 0.05) : Math.min(X1 - 0.05, 2 * Math.abs(f) + 0.3);
      screen.position.x = screenX;
      const onScreen = real && v <= X1 - 0.05;
      image.visible = onScreen;
      image.position.set(-0.008, AXIS + h * mag, 0);
      image.scale.set(0.05 * Math.min(4, Math.abs(mag)), 0.08 * Math.min(4, Math.abs(mag)), 1);

      // principal rays: parallel then through F′; through the centre; through F then parallel
      const end = screenX - 0.006;
      const lensTop = new THREE.Vector3(0, AXIS + h, 0);
      const slope1 = -h / f;
      rays[0].set([tip, lensTop, new THREE.Vector3(end, AXIS + h + slope1 * end, 0)]);
      rays[1].set([tip, new THREE.Vector3(end, AXIS + (-h / u) * end, 0)]);
      const hitY = AXIS + (u > f && f > 0 ? h * (1 - u / (u - f)) : NaN);
      if (Number.isFinite(hitY) && Math.abs(hitY - AXIS) < 0.12) rays[2].set([tip, new THREE.Vector3(0, hitY, 0), new THREE.Vector3(end, hitY, 0)]);
      else rays[2].set([]);

      // a virtual image sits on the candle's side; trace the refracted rays back to it
      const virtual = Number.isFinite(v) && v < 0;
      ghost.visible = virtual;
      back.forEach((b) => b.set([]));
      if (virtual) {
        const vi = new THREE.Vector3(v, AXIS + h * mag, 0);
        ghost.position.copy(vi);
        ghost.scale.set(0.05 * Math.min(5, Math.abs(mag)), 0.08 * Math.min(5, Math.abs(mag)), 1);
        back[0].set([lensTop, vi]);
        back[1].set([new THREE.Vector3(0, AXIS, 0), vi]);
      }
      drop(caption);
      const kind = !Number.isFinite(v) ? "no image: the rays leave parallel" : real ? (onScreen ? `real image on the screen, ${Math.abs(mag).toFixed(2)}× , upside down` : "real image beyond the end of the rail") : `virtual image, ${Math.abs(mag).toFixed(2)}× , upright`;
      caption = textSprite(kind, m.ink, 0.04);
      caption.position.set(0.1, 0.4, 0);
      g.add(caption);
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
