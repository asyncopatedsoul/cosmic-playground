import * as THREE from "three";
import { Kind, PLANETS, Param, Snap } from "../audio/protocol";
import { Toy, glow, invisible, type DragHandler, type ParamDef, type PointerInfo, type PulseState, type SnapView } from "./toy";

const SUN_Y = 0.55;
const MIN_R = 0.4;
const MAX_R = 2.0;
const PLANET_COLORS = [0xffb347, 0xff6f91, 0x5ad1ff, 0x9dff7a];

/** Orbit radius param -> distance from the sun in world units. */
const ringRadius = (r: number) => 0.3 + r * 0.55;
const radiusFromDistance = (d: number) => (d - 0.3) / 0.55;
/** Kepler's third law, snapped to half beats (mirrors the engine). */
const period = (r: number, wild: boolean) => {
  const t = 4 * r ** 1.5;
  return wild ? t : Math.max(0.5, Math.round(t / 0.5) * 0.5);
};

/**
 * Kepler Orrery: fling planets into orbit. Period follows T ∝ r^1.5, and a
 * planet chimes each time it crosses the meridian, so orbit ratios become
 * polyrhythms you can see.
 */
export class Orrery extends Toy {
  readonly kind = Kind.Orrery;
  readonly color = 0xffb347;
  readonly defs: Record<string, ParamDef> = {
    p0: { id: Param.A, range: [0, MAX_R], default: 0.83 },
    p1: { id: Param.A + 1, range: [0, MAX_R], default: 1.0 },
    p2: { id: Param.A + 2, range: [0, MAX_R], default: 1.31 },
    p3: { id: Param.A + 3, range: [0, MAX_R], default: 0 },
    speed: { id: Param.Speed, range: [0.25, 2], default: 1, gesture: "twist" },
  };
  pulse: PulseState = { enabled: true, steps: 8, prob: [], stepsPerBeat: 2, speed: 1 };

  protected baseRadius = 1.55;
  private sun!: THREE.Mesh;
  private planets: THREE.Mesh[] = [];
  private rings: THREE.LineLoop[] = [];
  private localAngle = new Array(PLANETS).fill(0);

  protected build() {
    this.sun = this.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 20), glow(0xffc46b, 1.2)), "sun") as THREE.Mesh;
    this.sun.position.y = SUN_Y;
    const sunTarget = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), invisible());
    sunTarget.position.y = SUN_Y;
    this.add(sunTarget, "sun");

    // The meridian: planets ring as they cross this line.
    const meridian = new THREE.Mesh(
      new THREE.BoxGeometry(1.25, 0.008, 0.02),
      new THREE.MeshBasicMaterial({ color: 0xfff1c9, transparent: true, opacity: 0.35 }),
    );
    meridian.position.set(0.3 + 1.25 / 2, SUN_Y, 0);
    this.add(meridian);

    const circle = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 96 }, (_, i) => {
        const a = (i / 96) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      }),
    );
    for (let i = 0; i < PLANETS; i++) {
      const ring = new THREE.LineLoop(
        circle,
        new THREE.LineBasicMaterial({ color: PLANET_COLORS[i], transparent: true, opacity: 0.35 }),
      );
      ring.position.y = SUN_Y;
      this.rings.push(this.add(ring) as THREE.LineLoop);
      const planet = this.add(new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 14), glow(PLANET_COLORS[i], 1)), `planet:${i}`) as THREE.Mesh;
      const target = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), invisible());
      planet.add(target);
      target.userData = { toy: this, part: `planet:${i}` };
      this.pickables.push(target);
      this.planets.push(planet);
    }
  }

  private radius(i: number) {
    return this.params[`p${i}`];
  }

  private setRadius(i: number, r: number) {
    this.setParam(`p${i}`, r < MIN_R * 0.75 ? 0 : THREE.MathUtils.clamp(r, MIN_R, MAX_R));
  }

  /** Distance from the sun, in world units, of the pointer on the orbital plane. */
  private distance(p: PointerInfo): number | null {
    const g = this.world.stage.planePoint(p.x, p.y, this.group.position.y + SUN_Y);
    if (!g) return null;
    return Math.hypot(g.x - this.group.position.x, g.z - this.group.position.z);
  }

  hint(part: string) {
    return part === "sun" ? "new planet" : part.startsWith("planet:") ? "drag orbit" : "poke";
  }

  down(part: string, _p: PointerInfo): DragHandler | null {
    if (part.startsWith("planet:")) {
      const i = Number(part.slice(7));
      return {
        move: (q) => {
          const d = this.distance(q);
          if (d !== null) this.setRadius(i, radiusFromDistance(d));
        },
      };
    }
    if (part === "sun") {
      // Drag out of the sun to launch a new planet.
      let launched = -1;
      return {
        move: (q) => {
          const d = this.distance(q);
          if (d === null) return;
          if (launched < 0) {
            if (d < 0.45) return;
            launched = [0, 1, 2, 3].find((i) => this.radius(i) <= 0) ?? -1;
            if (launched < 0) return;
          }
          this.setRadius(launched, Math.max(MIN_R, radiusFromDistance(d)));
        },
      };
    }
    return null;
  }

  update(dt: number, snap: SnapView | null, t: number) {
    super.update(dt, snap, t);
    const wild = this.world.tuning.wild || this.wild;
    const bps = this.world.bpm / 60;
    for (let i = 0; i < PLANETS; i++) {
      const r = this.radius(i);
      const on = r > 0;
      this.planets[i].visible = on;
      this.rings[i].visible = on;
      if (!on) continue;
      const R = ringRadius(r);
      this.rings[i].scale.set(R, 1, R);
      let angle: number;
      let flash = 0;
      if (snap) {
        const T = snap.get(Snap.planetPeriod + i) || period(r, wild);
        angle = snap.get(Snap.planetAngle + i) + (snap.dtBeats * this.pulse.speed * Math.PI * 2) / T;
        flash = snap.get(Snap.planetFlash + i);
      } else {
        // Before audio starts, keep orbiting on local time.
        this.localAngle[i] += (dt * bps * this.pulse.speed * Math.PI * 2) / period(r, wild);
        angle = this.localAngle[i];
      }
      this.planets[i].position.set(R * Math.cos(angle), SUN_Y, -R * Math.sin(angle));
      this.planets[i].scale.setScalar(1 + flash * 0.8);
      (this.planets[i].material as THREE.MeshStandardMaterial).emissiveIntensity = 0.8 + flash * 2.5;
      (this.rings[i].material as THREE.LineBasicMaterial).opacity = 0.25 + flash * 0.5;
    }
    (this.sun.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1 + this.flash * 1.5;
    this.sun.rotation.y = t * 0.3;
  }
}
