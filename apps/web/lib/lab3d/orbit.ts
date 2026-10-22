// Orbit view of the sun rig: the sun at the centre (it is the only light, so night is truly dark), Earth on
// its orbit at the chosen day with its axis tilted toward a fixed direction in space, spinning; a ring marks
// the chosen latitude. The day and night split on that ring is the rig's day length.

import * as THREE from "three";
import { ev } from "@seedots/rigs/runtime.ts";
import type { Env } from "@seedots/rigs/spec.ts";
import { globeTexture, glowSprite, materials, polyline, textSprite } from "./parts";
import { drop, noAO } from "./stage";
import type { View3D } from "./types";

type SunConfig = { latitude: string; day: string; tilt?: string };
const R = 4; // orbit radius (not to scale)
const ER = 0.6; // Earth radius (not to scale)

export const orbitView: View3D = {
  kind: "orbit",
  rig: "sun",
  label: "Earth's orbit",

  build(ctx, spec, env0) {
    const { stage } = ctx;
    const m = materials(true);
    const c = spec.config as unknown as SunConfig;
    const g = new THREE.Group();
    stage.root.add(g);
    stage.frame([2.5, 4.6, 8.8], [0, -0.4, 0]);
    // space: the sun is the only light
    stage.look({ background: "#05070a", bloom: 0.6, exposure: 1.0, aoRadius: 0.2 });
    stage.scene.environmentIntensity = 0.02;
    stage.hemi.intensity = 0.04;
    stage.sun.intensity = 0;
    stage.scene.fog = null;

    // stars
    const starPos: number[] = [];
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1500; i++) {
      const th = rnd() * Math.PI * 2;
      const ph = Math.acos(2 * rnd() - 1);
      starPos.push(60 * Math.sin(ph) * Math.cos(th), 60 * Math.cos(ph), 60 * Math.sin(ph) * Math.sin(th));
    }
    const stars = new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(starPos, 3)), new THREE.PointsMaterial({ color: "#cfd8e6", size: 0.08, sizeAttenuation: true }));
    g.add(noAO(stars));

    const sunBall = new THREE.Mesh(new THREE.SphereGeometry(0.7, 48, 32), m.glow("#ffcf6b", 1.8));
    const corona = glowSprite("#ffb347", 2.4, 0.45);
    const light = new THREE.PointLight("#fff3dc", 60, 0, 1.2);
    g.add(sunBall, corona, light);

    const ring = polyline("#5b7fa6", 1.2, stage.resolution, 1.2, true);
    ring.set(Array.from({ length: 181 }, (_, i) => new THREE.Vector3(Math.cos((i / 180) * Math.PI * 2) * R, 0, Math.sin((i / 180) * Math.PI * 2) * R)));
    g.add(ring.line);
    for (const [day, name] of [[80, "Mar equinox"], [172, "Jun solstice"], [266, "Sep equinox"], [355, "Dec solstice"]] as const) {
      const th = (2 * Math.PI * (day - 172)) / 365;
      const s = textSprite(name, "#aab6c4", 0.26);
      s.position.set(-Math.cos(th) * (R + 0.75), 0.05, Math.sin(th) * (R + 0.75));
      g.add(s);
    }

    // Earth: a tilted frame (fixed in space) holding the spinning globe, the axis and the latitude ring
    const tilted = new THREE.Group();
    g.add(tilted);
    const tex = globeTexture();
    const globe = new THREE.Mesh(new THREE.SphereGeometry(ER, 64, 48), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
    tilted.add(globe);
    const axis = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, ER * 2.8, 8), new THREE.MeshBasicMaterial({ color: "#c9d2dc" }));
    tilted.add(axis);
    const north = textSprite("N", "#e6e2d8", 0.2);
    north.position.y = ER * 1.55;
    tilted.add(north);
    let latRing: THREE.Mesh | null = null;
    let latBuilt = NaN;

    const off = stage.onFrame((dt) => {
      globe.rotation.y += dt * 0.6;
    });

    function update(env: Env) {
      const tilt = c.tilt ? ev(c.tilt, env) : 23.44;
      const day = ev(c.day, env);
      const lat = ev(c.latitude, env);
      // June solstice (day 172): Earth on the −x side, so the sun is in +x, the way the axis leans
      const th = (2 * Math.PI * (day - 172)) / 365;
      tilted.position.set(-Math.cos(th) * R, 0, Math.sin(th) * R);
      tilted.rotation.set(0, 0, -(tilt * Math.PI) / 180);
      if (lat !== latBuilt) {
        latBuilt = lat;
        drop(latRing);
        const r = ER * Math.cos((lat * Math.PI) / 180);
        latRing = new THREE.Mesh(new THREE.TorusGeometry(r * 1.005, 0.007, 8, 96), m.glow("#ff7a59", 2.2));
        latRing.rotation.x = Math.PI / 2;
        latRing.position.y = ER * Math.sin((lat * Math.PI) / 180);
        tilted.add(latRing);
      }
    }
    update(env0);
    return {
      update,
      dispose() {
        off();
        tex.dispose();
        drop(g);
      },
    };
  },
};
