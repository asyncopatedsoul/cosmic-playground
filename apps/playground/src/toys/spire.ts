import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { Kind, Param, Snap } from "../audio/protocol";
import { Toy, glow, invisible, type DragHandler, type ParamDef, type PointerInfo, type SnapView } from "./toy";

const SEGMENTS = 64;
const BOTTOM = 0.22;
const HARMONICS = 8;

/**
 * Monochord Spire: a string you stretch (length), twist (tension) and touch at
 * its nodes (harmonic). Law: f = (1/2L)·sqrt(T/μ). The string draws its own
 * standing wave, so the shape you see is the mode you hear.
 */
export class Spire extends Toy {
  readonly kind = Kind.Spire;
  readonly color = 0xb18cff;
  readonly defs: Record<string, ParamDef> = {
    length: { id: Param.A, range: [0.2, 2.0], default: 1.0, gesture: "stretch" },
    tension: { id: Param.B, range: [0, 1], default: 0.5, gesture: "twist" },
    harmonic: { id: Param.C, range: [1, HARMONICS], default: 1, step: 1, gesture: "touch-node" },
  };

  private line!: Line2;
  private lineGeo = new LineGeometry();
  private lineMat!: LineMaterial;
  private points = new Float32Array((SEGMENTS + 1) * 3);
  private post!: THREE.Mesh;
  private arm!: THREE.Mesh;
  private cap!: THREE.Mesh;
  private peg!: THREE.Mesh;
  private hitbox!: THREE.Mesh;
  private beads: THREE.Mesh[] = [];
  private phase = 0;

  private height() {
    return 0.5 + this.params.length * 1.1;
  }

  protected build() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2546, metalness: 0.7, roughness: 0.3 });
    this.post = this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 1, 12), metal)) as THREE.Mesh;
    this.post.position.x = -0.26;
    this.arm = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 0.06), metal)) as THREE.Mesh;
    this.arm.position.x = -0.13;

    // Stretch handle: drag the cap up and down.
    this.cap = this.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), glow(this.color, 0.9)), "cap") as THREE.Mesh;
    this.cap.position.x = -0.26;
    const capTarget = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), invisible());
    this.cap.add(capTarget);
    capTarget.userData = { toy: this, part: "cap" };
    this.pickables.push(capTarget);

    // Twist handle: the tuning peg.
    this.peg = this.add(new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.025, 8, 20), glow(0xffd36e, 0.7)), "peg") as THREE.Mesh;
    this.peg.position.set(-0.12, 0, 0.07);

    const anchor = this.add(new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), metal)) as THREE.Mesh;
    anchor.position.y = BOTTOM;

    this.lineMat = new LineMaterial({ color: this.color, linewidth: 4, worldUnits: false });
    this.line = new Line2(this.lineGeo, this.lineMat);
    this.add(this.line);

    this.hitbox = this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1, 8), invisible()), "string") as THREE.Mesh;

    // Harmonic nodes: touching the string at L/n from the top gives harmonic n.
    for (let n = 1; n <= HARMONICS; n++) {
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), glow(this.color, 0.25));
      bead.position.x = 0.2;
      this.add(bead, `node:${n}`);
      const t = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), invisible());
      bead.add(t);
      t.userData = { toy: this, part: `node:${n}` };
      this.pickables.push(t);
      this.beads.push(bead);
    }
    this.layout();
    this.onParam("tension");
    this.onParam("harmonic");
  }

  private layout() {
    const h = this.height();
    const top = BOTTOM + h;
    this.post.scale.y = top;
    this.post.position.y = top / 2;
    this.arm.position.y = top;
    this.cap.position.y = top;
    this.peg.position.y = top;
    this.hitbox.scale.y = h;
    this.hitbox.position.y = BOTTOM + h / 2;
    this.beads.forEach((b, i) => (b.position.y = top - h / (i + 1)));
  }

  protected onParam(name: string) {
    if (name === "length") this.layout();
    if (name === "tension") this.peg.rotation.z = this.params.tension * Math.PI * 4;
    if (name === "harmonic") {
      this.beads.forEach((b, i) => {
        const on = i + 1 === this.params.harmonic;
        (b.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 1.6 : 0.25;
        b.scale.setScalar(on ? 1.4 : 1);
      });
    }
  }

  hint(part: string) {
    return part === "cap" ? "stretch" : part === "peg" ? "tune" : "pluck";
  }

  down(part: string, _p: PointerInfo): DragHandler | null {
    if (part === "cap") return { move: (q) => this.setParam("length", this.params.length - q.dy * 0.007) };
    if (part === "peg") return { move: (q) => this.nudge("twist", (q.dx - q.dy) * 0.004) };
    return null;
  }

  tap(part: string, _p: PointerInfo, strength: number) {
    if (part.startsWith("node:")) this.setParam("harmonic", Number(part.slice(5)));
    this.poke(strength);
  }

  update(dt: number, snap: SnapView | null, t: number) {
    super.update(dt, snap, t);
    const env = snap ? snap.get(Snap.env) : 0;
    const freq = snap ? snap.get(Snap.freq) : 200;
    // Show the vibration slowed down; higher notes shimmer faster.
    this.phase += dt * Math.PI * 2 * Math.min(2 + freq / 40, 14);
    const amp = Math.min(0.2, env * 0.55) * (this.world.stage.reducedMotion ? 0.4 : 1);
    const n = this.params.harmonic;
    const h = this.height();
    const swing = Math.cos(this.phase);
    for (let i = 0; i <= SEGMENTS; i++) {
      const s = i / SEGMENTS;
      this.points[i * 3] = amp * Math.sin(n * Math.PI * s) * swing;
      this.points[i * 3 + 1] = BOTTOM + s * h;
      this.points[i * 3 + 2] = 0;
    }
    this.lineGeo.setPositions(this.points);
    this.lineMat.resolution.copy(this.world.stage.resolution);
    this.lineMat.linewidth = 3 + this.params.tension * 2 + env * 6;
    (this.cap.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.7 + this.flash * 1.5;
  }
}
