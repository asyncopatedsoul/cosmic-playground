import * as THREE from "three";
import { MAX_STEPS, Param, SNAP_HEADER, SNAP_STRIDE, Snap, type KindId } from "../audio/protocol";
import type { World } from "../world";

/** Declared gestures: every device maps its input onto these (see input.ts). */
export type Gesture = "stretch" | "twist" | "touch-node";

/** A param is the only state a toy has. `id` is its engine param slot. */
export interface ParamDef {
  id: number;
  range: [number, number];
  default: number;
  step?: number;
  gesture?: Gesture;
}

export interface PulseState {
  enabled: boolean;
  steps: number;
  prob: number[];
  /** 1 = quarters, 2 = eighths, 3 = triplets, 4 = sixteenths. */
  stepsPerBeat: number;
  /** Time scale for toys whose Pulse is continuous (the Orrery). */
  speed: number;
}

export interface PointerInfo {
  x: number;
  y: number;
  /** Movement since the previous event, in CSS pixels. */
  dx: number;
  dy: number;
  event: PointerEvent;
  hit: THREE.Intersection | null;
}

export interface DragHandler {
  move(p: PointerInfo): void;
  end?(p: PointerInfo): void;
}

/** Evenly spread `hits` over `steps` (matches hypertoy-core's `euclid`). */
export function euclid(hits: number, steps: number): number[] {
  return Array.from({ length: MAX_STEPS }, (_, i) => (i < steps && (i * hits) % steps < hits ? 1 : 0));
}

/** One toy slot of the engine snapshot, with the time elapsed since it was taken. */
export class SnapView {
  constructor(
    readonly data: Float32Array,
    readonly slot: number,
    /** Beats since the snapshot, so visuals can extrapolate between messages. */
    readonly dtBeats: number,
  ) {}

  get(i: number): number {
    return this.data[SNAP_HEADER + this.slot * SNAP_STRIDE + i];
  }
}

const tmp = new THREE.Vector3();

/**
 * Hypertoy = Form + Law + Voice + Pulse + Ports. In Phase 0 the Law and Voice
 * live in the Rust engine; this class is the Form plus the param/pulse state.
 */
export abstract class Toy {
  abstract readonly kind: KindId;
  abstract readonly color: number;
  abstract readonly defs: Record<string, ParamDef>;
  readonly group = new THREE.Group();
  readonly pickables: THREE.Object3D[] = [];
  params: Record<string, number> = {};
  pulse: PulseState = { enabled: false, steps: 8, prob: euclid(3, 8), stepsPerBeat: 2, speed: 1 };
  /** A scripted Pulse in mini-notation (e.g. "x . [x x] <x x*2>"); "" uses the ring. */
  pattern = "";
  /** Set when the engine rejects the pattern: where and why. */
  patternError: string | null = null;
  selected = false;

  protected baseRadius = 0.6;
  protected flash = 0;
  private heart!: THREE.Mesh;
  private ring!: THREE.Mesh;

  constructor(
    readonly world: World,
    readonly slot: number,
  ) {}

  /** Called once after construction, when subclass fields exist. */
  init(position: THREE.Vector3) {
    for (const [name, d] of Object.entries(this.defs)) this.params[name] = d.default;
    this.buildBase();
    this.build();
    this.group.position.copy(position);
    this.world.audio.send({ t: "add", slot: this.slot, kind: this.kind });
    this.afterAdd();
    for (const name of Object.keys(this.defs)) this.sendParam(name);
    this.sendPulse();
    if (this.pattern) this.setPattern(this.pattern);
    this.sendPan();
  }

  /** Hook for toys that load more into their slot (Law, Voice) before params. */
  protected afterAdd() {}

  protected abstract build(): void;

  /** The toy's colour as CSS. */
  get css() {
    return `#${this.color.toString(16).padStart(6, "0")}`;
  }

  private buildBase() {
    const r = this.baseRadius;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r * 1.06, 0.12, 48),
      new THREE.MeshStandardMaterial({ color: 0x14162c, roughness: 0.6, metalness: 0.4 }),
    );
    base.position.y = 0.06;
    this.add(base, "base");

    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.03, 0.018, 8, 64),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.35 }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.12;
    this.group.add(this.ring);

    // The heart: tap it to edit the toy's Pulse.
    this.heart = new THREE.Mesh(
      new THREE.SphereGeometry(0.085, 20, 14),
      new THREE.MeshStandardMaterial({ color: 0x220a18, emissive: 0xff5c8a, emissiveIntensity: 0.8 }),
    );
    this.heart.position.set(0, 0.17, r * 0.82);
    this.add(this.heart, "heart");
    // A larger invisible target so the heart is easy to hit on touch screens.
    const target = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), invisible());
    target.position.copy(this.heart.position);
    this.add(target, "heart");
  }

  /** Add a mesh to the toy; if `part` is given it can be picked by input. */
  protected add(obj: THREE.Object3D, part?: string) {
    this.group.add(obj);
    if (part) {
      obj.userData.toy = this;
      obj.userData.part = part;
      this.pickables.push(obj);
    }
    return obj;
  }

  setParam(name: string, value: number) {
    const d = this.defs[name];
    if (!d) return;
    let v = THREE.MathUtils.clamp(value, d.range[0], d.range[1]);
    if (d.step) v = Math.round(v / d.step) * d.step;
    if (v === this.params[name]) return;
    this.params[name] = v;
    this.sendParam(name);
    this.onParam(name);
  }

  /** Apply a gesture to whichever param declared it. Returns false if none did. */
  nudge(g: Gesture, amount: number): boolean {
    const entry = Object.entries(this.defs).find(([, d]) => d.gesture === g);
    if (!entry) return false;
    const [name, d] = entry;
    this.setParam(name, this.params[name] + amount * (d.range[1] - d.range[0]));
    return true;
  }

  protected onParam(_name: string) {}

  private sendParam(name: string) {
    this.world.audio.send({ t: "param", slot: this.slot, p: this.defs[name].id, v: this.params[name] });
  }

  poke(strength: number) {
    this.world.audio.send({ t: "poke", slot: this.slot, strength, aux: 0 });
  }

  setPulse(p: Partial<PulseState>) {
    Object.assign(this.pulse, p);
    this.sendPulse();
  }

  /** Script the Pulse with mini-notation, or clear it ("") to go back to the ring. */
  setPattern(text: string) {
    this.pattern = text.trim();
    this.patternError = null;
    this.world.audio.send({ t: "pattern", slot: this.slot, text: this.pattern });
  }

  private sendPulse() {
    const { audio } = this.world;
    const p = this.pulse;
    const slot = this.slot;
    audio.send({ t: "param", slot, p: Param.PulseOn, v: p.enabled ? 1 : 0 });
    audio.send({ t: "param", slot, p: Param.StepsPerBeat, v: p.stepsPerBeat });
    audio.send({ t: "param", slot, p: Param.Steps, v: p.steps });
    audio.send({ t: "param", slot, p: Param.Speed, v: p.speed });
    p.prob.forEach((prob, step) => audio.send({ t: "step", slot, step, prob }));
  }

  moveTo(pos: THREE.Vector3) {
    this.group.position.copy(pos);
    this.sendPan();
  }

  private sendPan() {
    // Pan from where the toy sits relative to the camera's left-right axis.
    const camera = this.world.stage.camera;
    camera.updateMatrixWorld();
    tmp.copy(this.group.position).project(camera);
    const pan = Number.isFinite(tmp.x) ? THREE.MathUtils.clamp(tmp.x * 0.8, -0.9, 0.9) : 0;
    this.world.audio.send({ t: "param", slot: this.slot, p: Param.Pan, v: pan });
  }

  /** Pointer went down on one of this toy's parts. Return a handler to own the drag. */
  down(_part: string, _p: PointerInfo): DragHandler | null {
    return null;
  }

  /** A tap (no drag) on one of this toy's parts. */
  tap(_part: string, _p: PointerInfo, strength: number) {
    this.poke(strength);
  }

  update(_dt: number, snap: SnapView | null, t: number) {
    const f = snap ? snap.get(Snap.flash) : 0;
    this.flash = this.world.stage.reducedMotion ? f * 0.3 : f;
    const beat = this.pulse.enabled ? 0.5 + 0.5 * Math.sin(t * 2.4) : 0;
    const hm = this.heart.material as THREE.MeshStandardMaterial;
    hm.emissiveIntensity = 0.5 + beat * 0.6 + this.flash * 2.5;
    this.heart.scale.setScalar(1 + this.flash * 0.5);
    const rm = this.ring.material as THREE.MeshBasicMaterial;
    rm.opacity = this.selected ? 0.95 : 0.3 + this.flash * 0.4;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
      }
    });
  }
}

/** Material for pick targets: raycastable but never drawn. */
export function invisible() {
  return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
}

export function glow(color: number, intensity = 0.8) {
  return new THREE.MeshStandardMaterial({
    color: 0x14112a,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0.2,
  });
}
