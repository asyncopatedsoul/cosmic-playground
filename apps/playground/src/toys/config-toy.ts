import * as THREE from "three";
import { compileVoice, compileZap, paramIndex, ZZFX_DEFAULTS, type ToyConfig } from "../audio/config";
import { Kind, Param, Snap } from "../audio/protocol";
import type { World } from "../world";
import { Toy, glow, invisible, type DragHandler, type ParamDef, type PointerInfo, type SnapView, type ToyState } from "./toy";

/**
 * A toy described as data (ToyConfig). Its Law and Voice load into the
 * engine's custom slot; its Form is one of a few procedural shapes whose
 * proportions follow the params named in `form`.
 *
 * Drag the body: up/down is the "stretch" gesture, sideways is "twist", so any
 * config that declares gestures plays with mouse, touch, wheel and MIDI.
 */
export class ConfigToy extends Toy {
  readonly kind = Kind.Custom;
  readonly color: number;
  readonly defs: Record<string, ParamDef>;

  private body!: THREE.Object3D;
  private glowMat!: THREE.MeshStandardMaterial;
  private liquid: THREE.Mesh | null = null;
  private bob: THREE.Object3D | null = null;
  private lid: THREE.Mesh | null = null;
  private rings: THREE.Mesh[] = [];
  private swing = 0;

  constructor(
    world: World,
    slot: number,
    public config: ToyConfig,
  ) {
    super(world, slot);
    this.color = new THREE.Color(config.color).getHex();
    const index = paramIndex(config);
    this.defs = Object.fromEntries(
      Object.entries(config.params).map(([name, p]) => [
        name,
        { id: Param.A + index.get(name)!, range: p.range, default: p.default, step: p.step, gesture: p.gesture },
      ]),
    );
    const pulse = config.pulse;
    if (pulse) {
      this.pulse.enabled = pulse.enabled ?? this.pulse.enabled;
      this.pulse.stepsPerBeat = pulse.stepsPerBeat ?? this.pulse.stepsPerBeat;
      this.pulse.steps = pulse.steps ?? this.pulse.steps;
      this.pattern = pulse.pattern ?? "";
    }
  }

  /** Right after `add`: the Law and Voice, before params and Pulse arrive. */
  protected afterAdd() {
    for (const c of compileVoice(this.config, this.slot)) this.world.audio.send(c);
  }

  protected loadState(s: ToyState) {
    super.loadState(s);
    const v = this.config.voice;
    if (v.engine === "zap" && Array.isArray(s.recipe)) this.config = { ...this.config, voice: { ...v, recipe: s.recipe } };
  }

  state(): ToyState {
    const v = this.config.voice;
    return { ...super.state(), recipe: v.engine === "zap" ? this.recipe() : null };
  }

  /** The current ZzFX recipe (zap voices), with defaults filled in. */
  recipe(): number[] {
    const v = this.config.voice;
    return v.engine === "zap" ? ZZFX_DEFAULTS.map((d, i) => v.recipe[i] ?? d) : [];
  }

  /** Swap in a new recipe; it is data, so it can be shared and saved like params. */
  setRecipe(recipe: number[]) {
    const v = this.config.voice;
    if (v.engine !== "zap") return;
    this.config = { ...this.config, voice: { ...v, recipe } };
    this.world.audio.send(compileZap(this.config, this.slot));
  }

  /** 0..1 position of a param in its range (for Form proportions). */
  private norm(name: string | undefined, fallback = 0.5) {
    const d = name ? this.defs[name] : undefined;
    if (!d) return fallback;
    return (this.params[name!] - d.range[0]) / (d.range[1] - d.range[0]);
  }

  protected build() {
    this.glowMat = glow(this.color, 0.6);
    const glass = new THREE.MeshStandardMaterial({
      color: this.color,
      transparent: true,
      opacity: 0.35,
      roughness: 0.1,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    const group = new THREE.Group();
    group.position.y = 0.12;
    switch (this.config.form.kind) {
      case "bowl": {
        const pts = Array.from({ length: 12 }, (_, i) => {
          const a = (i / 11) * Math.PI * 0.5;
          return new THREE.Vector2(0.05 + 0.4 * Math.sin(a), 0.35 - 0.35 * Math.cos(a) + 0.02);
        });
        group.add(new THREE.Mesh(new THREE.LatheGeometry(pts, 40), glass));
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.02, 8, 48), this.glowMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.y = 0.37;
        group.add(rim);
        break;
      }
      case "bottle": {
        const profile = [
          [0.0, 0], [0.3, 0], [0.32, 0.05], [0.32, 0.6], [0.26, 0.75], [0.1, 0.85], [0.08, 1.1], [0.1, 1.14],
        ].map(([x, y]) => new THREE.Vector2(x, y));
        group.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 32), glass));
        this.liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 1, 32), glow(this.color, 0.4));
        group.add(this.liquid);
        break;
      }
      case "box": {
        group.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.6), glass));
        this.lid = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.06, 0.64), this.glowMat);
        this.lid.position.y = 0.43;
        group.add(this.lid);
        break;
      }
      case "pendulum": {
        const metal = new THREE.MeshStandardMaterial({ color: 0x2b2546, metalness: 0.7, roughness: 0.3 });
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.05), metal);
        post.position.set(-0.35, 0.8, 0);
        const beam = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.05), metal);
        beam.position.set(-0.17, 1.6, 0);
        group.add(post, beam);
        const pivot = new THREE.Group();
        pivot.position.set(0, 1.6, 0);
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1, 6), metal);
        rod.position.y = -0.5;
        const bob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), this.glowMat);
        bob.position.y = -1;
        rod.name = "rod";
        pivot.add(rod, bob);
        group.add(pivot);
        this.bob = pivot;
        break;
      }
      case "totem":
      default: {
        for (let i = 0; i < 4; i++) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32 - i * 0.05, 0.05, 10, 40), this.glowMat.clone());
          ring.rotation.x = Math.PI / 2;
          ring.position.y = 0.1 + i * 0.22;
          group.add(ring);
          this.rings.push(ring);
        }
      }
    }
    this.body = group;
    this.add(group);
    // Starts above the base so the heart (at the base's front edge) stays tappable.
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 1.3, 10), invisible());
    hit.position.y = 0.9;
    this.add(hit, "body");
    this.layout();
  }

  private layout() {
    const f = this.config.form;
    const size = 0.7 + 0.6 * this.norm(f.size);
    if (this.config.form.kind === "pendulum" && this.bob) {
      const len = 0.4 + 1.1 * this.norm(f.size);
      const rod = this.bob.getObjectByName("rod")!;
      rod.scale.y = len;
      rod.position.y = -len / 2;
      this.bob.children[1].position.y = -len;
    } else {
      this.body.scale.set(size, this.config.form.kind === "bowl" ? 1 : size, size);
    }
    if (this.liquid) {
      const h = 0.05 + 0.55 * this.norm(f.fill, 0.3);
      this.liquid.scale.y = h;
      this.liquid.position.y = 0.02 + h / 2;
    }
    if (f.twist) this.body.rotation.y = this.norm(f.twist) * Math.PI * 2;
  }

  protected onParam(_name: string) {
    this.layout();
  }

  hint(part: string) {
    return part === "body" ? "poke · drag" : "poke";
  }

  down(part: string, _p: PointerInfo): DragHandler | null {
    if (part !== "body") return null;
    return {
      move: (q) => {
        if (Math.abs(q.dy) >= Math.abs(q.dx)) this.nudge("stretch", -q.dy * 0.004);
        else this.nudge("twist", q.dx * 0.004);
      },
    };
  }

  tap(_part: string, _p: PointerInfo, strength: number) {
    this.poke(strength);
  }

  update(dt: number, snap: SnapView | null, t: number) {
    super.update(dt, snap, t);
    const env = snap ? snap.get(Snap.env) : 0;
    const calm = this.world.stage.reducedMotion ? 0.3 : 1;
    this.glowMat.emissiveIntensity = 0.5 + env * 4 + this.flash * 1.5;
    if (this.lid) this.lid.position.y = 0.43 + this.flash * 0.12 * calm;
    if (this.bob) {
      // Swing at the pendulum's true period (T = 2 pi sqrt(L / g)) for the length param.
      const d = this.defs[this.config.form.size ?? ""];
      const len = d ? this.params[this.config.form.size!] : 1;
      this.swing += dt * Math.sqrt(9.81 / Math.max(0.05, len));
      this.bob.rotation.z = Math.sin(this.swing) * 0.35 * calm;
    }
    this.rings.forEach((ring, i) => {
      const m = ring.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.4 + env * 5 * (1 - i * 0.18) + this.flash;
      ring.scale.setScalar(1 + env * 0.6 * calm * (i + 1) * 0.25);
    });
    if (this.config.form.kind === "bowl") this.body.rotation.y += dt * (0.1 + env * 2) * calm;
  }
}
