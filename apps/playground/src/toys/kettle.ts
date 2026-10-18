import * as THREE from "three";
import { FIELD_SIZE, Kind, Param, Snap } from "../audio/protocol";
import type { FieldFrame } from "../audio/field.worker";
import { Toy, euclid, type DragHandler, type ParamDef, type PointerInfo, type PulseState, type SnapView } from "./toy";

const SURFACE_Y = 0.6;
const BUBBLE_POOL = 10;

/**
 * Field metrics -> 0..1 params. Coverage is mean V (a full kettle is ~0.1);
 * activity is mean |dV| per step (~1.5e-5 settled, ~5e-5 right after pouring).
 */
const COVERAGE_GAIN = 6;
const ACTIVITY_GAIN = 20_000;

const surfaceShader = {
  vertex: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragment: /* glsl */ `
    uniform sampler2D field;
    uniform float flash;
    uniform vec3 colA;
    uniform vec3 colB;
    varying vec2 vUv;
    void main() {
      float v = texture2D(field, vUv).r;
      float body = smoothstep(0.05, 0.6, v);
      float edge = smoothstep(0.12, 0.3, v) - smoothstep(0.45, 0.85, v);
      vec3 c = mix(vec3(0.01, 0.025, 0.04), colA * 0.42, body);
      c += colB * edge * 0.55 + colA * flash * 0.15;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

/**
 * Reaction Kettle: pour reagents and watch Gray-Scott Turing patterns grow.
 * How much is alive (coverage) and how fast it changes (activity) drive a
 * resonant noise texture and a drone; its Pulse releases bubbles whose pitch
 * follows the Minnaert law.
 */
export class Kettle extends Toy {
  readonly kind = Kind.Kettle;
  readonly color = 0x3fe0c5;
  readonly defs: Record<string, ParamDef> = {
    coverage: { id: Param.A, range: [0, 1], default: 0, derived: true },
    activity: { id: Param.B, range: [0, 1], default: 0, derived: true },
    reagent: { id: Param.C, range: [0, 1], default: 0, gesture: "twist" },
  };
  pulse: PulseState = { enabled: false, steps: 16, prob: euclid(5, 16), stepsPerBeat: 4, speed: 1 };

  protected baseRadius = 1.05;
  private texture = new THREE.DataTexture(new Uint8Array(FIELD_SIZE * FIELD_SIZE), FIELD_SIZE, FIELD_SIZE, THREE.RedFormat);
  private surface!: THREE.Mesh;
  private uniforms = {
    field: { value: this.texture },
    flash: { value: 0 },
    colA: { value: new THREE.Color(0x3fe0c5) },
    colB: { value: new THREE.Color(0xfff2a8) },
  };
  private rim!: THREE.Mesh;
  private bubbles: { mesh: THREE.Mesh; life: number }[] = [];
  private nextBubble = 0;
  private lastFlash = 0;
  private lastBubblePoke = 0;

  protected build() {
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;

    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.86, 0.62, 0.5, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x163a3a, metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide }),
    );
    pot.position.y = 0.37;
    this.add(pot);

    this.rim = this.add(
      new THREE.Mesh(
        new THREE.TorusGeometry(0.86, 0.05, 10, 64),
        new THREE.MeshStandardMaterial({ color: 0x1a2a2a, emissive: this.color, emissiveIntensity: 0.4, metalness: 0.6 }),
      ),
      "rim",
    ) as THREE.Mesh;
    this.rim.rotation.x = Math.PI / 2;
    this.rim.position.y = SURFACE_Y + 0.02;

    this.surface = this.add(
      new THREE.Mesh(
        new THREE.CircleGeometry(0.83, 64),
        new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: surfaceShader.vertex, fragmentShader: surfaceShader.fragment }),
      ),
      "surface",
    ) as THREE.Mesh;
    this.surface.rotation.x = -Math.PI / 2;
    this.surface.position.y = SURFACE_Y;

    for (let i = 0; i < BUBBLE_POOL; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xc9fff4, transparent: true, opacity: 0 }),
      );
      mesh.visible = false;
      this.add(mesh);
      this.bubbles.push({ mesh, life: 0 });
    }

    this.world.fields.add(this.slot, 1 + this.slot * 977, (f) => this.onFrame(f));
  }

  private onFrame(f: FieldFrame) {
    (this.texture.image.data as Uint8Array).set(f.view);
    this.texture.needsUpdate = true;
    this.setParam("coverage", Math.round(Math.min(1, f.coverage * COVERAGE_GAIN) * 100) / 100);
    this.setParam("activity", Math.round(Math.min(1, f.activity * ACTIVITY_GAIN) * 100) / 100);
  }

  protected onParam(name: string) {
    if (name === "reagent") {
      this.world.fields.reagent(this.slot, this.params.reagent);
      this.uniforms.colA.value.setHSL(0.47 - this.params.reagent * 0.35, 0.75, 0.55);
    }
  }

  private pour(hit: THREE.Intersection | null, r: number) {
    if (!hit?.uv) return;
    this.world.fields.drop(this.slot, hit.uv.x, hit.uv.y, r);
  }

  hint(part: string) {
    return part === "rim" ? "turn" : part === "surface" ? "pour" : "poke";
  }

  down(part: string, _p: PointerInfo): DragHandler | null {
    if (part === "rim") return { move: (q) => this.nudge("twist", q.dx * 0.003) };
    if (part === "surface") {
      return {
        move: (q) => {
          this.pour(this.world.stage.pick(q.x, q.y, [this.surface]), 0.025);
          const now = performance.now();
          if (now - this.lastBubblePoke > 160) {
            this.lastBubblePoke = now;
            this.poke(0.35);
          }
        },
      };
    }
    return null;
  }

  tap(part: string, p: PointerInfo, strength: number) {
    if (part === "surface") this.pour(p.hit, 0.06);
    this.poke(strength);
  }

  update(dt: number, snap: SnapView | null, t: number) {
    super.update(dt, snap, t);
    const flash = snap ? snap.get(Snap.flash) : 0;
    this.uniforms.flash.value = this.flash;
    if (flash > this.lastFlash + 0.3) this.spawnBubble();
    this.lastFlash = flash;
    for (const b of this.bubbles) {
      if (b.life <= 0) continue;
      b.life -= dt;
      b.mesh.position.y += dt * 0.5;
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, b.life) * 0.8;
      b.mesh.visible = b.life > 0;
    }
  }

  private spawnBubble() {
    const b = this.bubbles[this.nextBubble];
    this.nextBubble = (this.nextBubble + 1) % BUBBLE_POOL;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 0.65;
    b.mesh.position.set(r * Math.cos(a), SURFACE_Y + 0.04, r * Math.sin(a));
    b.mesh.scale.setScalar(0.5 + Math.random());
    b.mesh.visible = true;
    b.life = 1;
  }

  dispose() {
    this.world.fields.remove(this.slot);
    this.texture.dispose();
    super.dispose();
  }
}
