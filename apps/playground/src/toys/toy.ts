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
  /** Computed by the toy itself (Kettle coverage); never saved (SAVE-LOAD.md §3). */
  derived?: boolean;
}

/** Everything a saved toy carries besides where it stands (SAVE-LOAD.md §3). */
export interface ToyState {
  params?: Record<string, number>;
  pulse?: PulseState;
  pattern?: string;
  /** A zap voice's ZzFX recipe (config toys). */
  recipe?: number[] | null;
  volume?: number;
  wild?: boolean;
  /** A variant's colour (SAVE-LOAD.md §6.1), "#rrggbb"; applied once, before the toy is built. */
  tint?: string | null;
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
  /** The raw event; absent for gamepad seats, whose drags are synthesised (no toy reads it). */
  event?: PointerEvent;
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
  /**
   * The toy's real position while focus view shows it somewhere else (a display
   * pose, FOCUS-VIEW.md §4.2); null otherwise. `group.position` is then only
   * where it's drawn; saves, the room and `moveTo` use this.
   */
  home: THREE.Vector3 | null = null;
  /** Stable id shared across a room (docs/MULTIPLAYER.md §4.2); engine slots stay local. */
  id = randomId();
  /** The registry entry this toy was made from (toys/registry.ts). */
  entryId = "";
  /** The toy's level in the music, 0..1: shared in a room and saved (AUDIO-MIX.md §3.1). */
  volume = DEFAULT_VOLUME;
  /** This toy alone doesn't snap to the Tuning (MODES.md §7.1). Shared and saved; no UI yet. */
  wild = false;
  /** The variant this toy was placed from or kept as (SAVE-LOAD.md §6.2); saved, so worlds embed it. */
  template: string | null = null;

  protected baseRadius = 0.6;
  protected flash = 0;
  private heart!: THREE.Mesh;
  private ring!: THREE.Mesh;
  /** Shown instead of the ring while this player has the toy muted. */
  private dashes!: THREE.Group;
  /** A bright outer ring while soloed or focused. */
  private halo!: THREE.Mesh;

  constructor(
    readonly world: World,
    readonly slot: number,
  ) {}

  /**
   * Called once after construction, when subclass fields exist. A saved
   * `state` is applied before anything reaches the engine, so a loaded toy
   * never plays a note with default params.
   */
  init(position: THREE.Vector3, state?: ToyState) {
    for (const [name, d] of Object.entries(this.defs)) this.params[name] = d.default;
    if (state) this.loadState(state);
    // A variant looks like its base, recoloured (SAVE-LOAD.md §6.1): before anything uses the colour.
    if (state?.tint) (this as { color: number }).color = new THREE.Color(state.tint).getHex();
    this.buildBase();
    this.build();
    this.group.position.copy(position);
    this.world.audio.send({ t: "add", slot: this.slot, kind: this.kind });
    this.afterAdd();
    for (const name of Object.keys(this.defs)) this.sendParam(name);
    this.sendVolume();
    if (this.wild) this.world.audio.send({ t: "wild", slot: this.slot, wild: true });
    this.sendPulse();
    if (this.pattern) this.setPattern(this.pattern);
    this.sendPan();
  }

  /** Take a saved state before `init` builds and sends anything; params are clamped to their ranges. */
  protected loadState(s: ToyState) {
    for (const [name, v] of Object.entries(s.params ?? {})) {
      const d = this.defs[name];
      if (!d || d.derived || !Number.isFinite(v)) continue;
      let x = THREE.MathUtils.clamp(v, d.range[0], d.range[1]);
      if (d.step) x = Math.round(x / d.step) * d.step;
      this.params[name] = x;
    }
    if (s.pulse) this.pulse = { ...s.pulse, prob: [...s.pulse.prob] };
    if (typeof s.pattern === "string") this.pattern = s.pattern.trim();
    if (typeof s.volume === "number" && Number.isFinite(s.volume)) this.volume = THREE.MathUtils.clamp(s.volume, 0, 1);
    if (typeof s.wild === "boolean") this.wild = s.wild;
  }

  /** The toy's saved state (derived params left out). */
  state(): ToyState {
    const params: Record<string, number> = {};
    for (const [name, d] of Object.entries(this.defs)) if (!d.derived) params[name] = this.params[name];
    return { params, pulse: { ...this.pulse, prob: [...this.pulse.prob] }, pattern: this.pattern, recipe: null, volume: this.volume, wild: this.wild };
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

    // The ring's thickness follows the toy's volume.
    this.ring = new THREE.Mesh(
      ringGeometry(r, this.volume),
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.35 }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.12;
    this.group.add(this.ring);

    // Muted (for this player): the ring breaks into dashes.
    this.dashes = new THREE.Group();
    const dashMat = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.55 });
    const n = 16;
    for (let i = 0; i < n; i++) {
      const dash = new THREE.Mesh(new THREE.TorusGeometry(r * 1.03, 0.014, 6, 6, (Math.PI * 2) / n / 2), dashMat);
      dash.rotation.z = (i / n) * Math.PI * 2;
      this.dashes.add(dash);
    }
    this.dashes.rotation.x = Math.PI / 2;
    this.dashes.position.y = 0.12;
    this.dashes.visible = false;
    this.group.add(this.dashes);

    // Soloed or focused: a bright halo just outside the base.
    this.halo = new THREE.Mesh(
      new THREE.TorusGeometry(r * 1.22, 0.022, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.halo.rotation.x = Math.PI / 2;
    this.halo.position.y = 0.1;
    this.halo.visible = false;
    this.group.add(this.halo);

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

  /** False when the room is locked and this player isn't an admin: toys can be played, not changed. */
  protected get editable() {
    return this.world.applying || this.world.canEdit();
  }

  setParam(name: string, value: number) {
    const d = this.defs[name];
    if (!d || !this.editable) return;
    let v: number | null = THREE.MathUtils.clamp(value, d.range[0], d.range[1]);
    if (d.step) v = Math.round(v / d.step) * d.step;
    if (!this.world.applying) v = this.world.mode.constrain(this, name, v);
    if (v === null) return this.refuse();
    if (v === this.params[name]) return;
    this.params[name] = v;
    this.sendParam(name);
    this.onParam(name);
    this.world.edited(this, "params");
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

  /** Seconds left of the "pinned" shake after the mode refused an edit (MODES.md §5.5). */
  private shake = 0;

  /** The mode refused an edit: a short resistive shake, no error text. */
  refuse() {
    this.shake = 0.25;
  }

  /** Set the toy's level in the music (shared, like a param). */
  setVolume(value: number) {
    if (!this.editable) return;
    const v = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 100) / 100;
    if (v === this.volume) return;
    this.volume = v;
    this.sendVolume();
    this.world.edited(this, "volume");
    this.world.mix.volumeChanged();
  }

  /** Turn snapping off (or on) for this toy only. */
  setWild(on: boolean) {
    if (!this.editable || on === this.wild) return;
    this.wild = on;
    this.world.audio.send({ t: "wild", slot: this.slot, wild: on });
    this.world.edited(this, "wild");
  }

  private sendVolume() {
    this.world.audio.send({ t: "param", slot: this.slot, p: Param.Gain, v: this.volume });
    if (this.ring) {
      this.ring.geometry.dispose();
      this.ring.geometry = ringGeometry(this.baseRadius, this.volume);
    }
  }

  private sendParam(name: string) {
    this.world.audio.send({ t: "param", slot: this.slot, p: this.defs[name].id, v: this.params[name] });
  }

  poke(strength: number) {
    this.world.audio.send({ t: "poke", slot: this.slot, strength, aux: 0 });
    this.world.poked(this, strength);
  }

  setPulse(p: Partial<PulseState>) {
    if (!this.editable) return;
    const q = this.world.applying ? p : this.world.mode.constrainPulse(this, p);
    if (!q) return this.refuse();
    Object.assign(this.pulse, q);
    this.sendPulse();
    this.world.edited(this, "pulse");
  }

  /** Script the Pulse with mini-notation, or clear it ("") to go back to the ring. */
  setPattern(text: string) {
    if (!this.editable) return;
    const t = this.world.applying ? text : this.world.mode.constrainPattern(this, text);
    if (t === null) return this.refuse();
    this.pattern = t.trim();
    this.patternError = null;
    this.world.audio.send({ t: "pattern", slot: this.slot, text: this.pattern });
    this.world.edited(this, "pattern");
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

  /** Where the toy really is (its home while focus view shows it on the ring). */
  get worldPos(): THREE.Vector3 {
    return this.home ?? this.group.position;
  }

  moveTo(pos: THREE.Vector3) {
    if (!this.editable) return;
    if (!this.world.applying && !this.world.mode.allowMove(this)) return this.refuse();
    if (this.home) this.home.copy(pos);
    else {
      this.group.position.copy(pos);
      this.sendPan();
    }
    this.world.edited(this, "pos");
  }

  /** Re-pan from the current camera (the avatar's head turns, AVATAR.md §9). */
  sendPan() {
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

  /** What a click on `part` does, for the aim preview's label. */
  hint(_part: string): string {
    return "poke";
  }

  /** A tap (no drag) on one of this toy's parts. */
  tap(_part: string, _p: PointerInfo, strength: number) {
    this.poke(strength);
  }

  update(dt: number, snap: SnapView | null, t: number) {
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      this.group.rotation.y = this.world.stage.reducedMotion ? 0 : Math.sin(this.shake * 90) * this.shake * 0.25;
    }
    const f = snap ? snap.get(Snap.flash) : 0;
    this.flash = this.world.stage.reducedMotion ? f * 0.3 : f;
    const beat = this.pulse.enabled ? 0.5 + 0.5 * Math.sin(t * 2.4) : 0;
    // How this player hears the toy (AUDIO-MIX.md §4.2). A muted toy keeps moving
    // with the music: it's playing, you just aren't hearing it.
    const listening = this.world.mix.listening(this);
    const dim = listening === "muted" ? 0.3 : listening === "dimmed" ? 0.45 : 1;
    const hm = this.heart.material as THREE.MeshStandardMaterial;
    hm.emissiveIntensity = (0.5 + beat * 0.6 + this.flash * 2.5) * dim;
    this.heart.scale.setScalar(1 + this.flash * 0.5);
    const rm = this.ring.material as THREE.MeshBasicMaterial;
    rm.opacity = (this.selected || this.world.selection.has(this.id) ? 0.95 : 0.3 + this.flash * 0.4) * (listening === "dimmed" ? 0.5 : 1);
    this.ring.visible = listening !== "muted";
    this.dashes.visible = listening === "muted";
    this.halo.visible = listening === "solo" || listening === "focus";
    if (this.halo.visible) {
      const m = this.halo.material as THREE.MeshBasicMaterial;
      m.color.set(listening === "solo" ? 0xffffff : this.color);
      m.opacity = (listening === "solo" ? 0.75 : 0.5) + this.flash * 0.25;
    }
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

/** A new toy's volume; the dial has a soft detent here. */
export const DEFAULT_VOLUME = 0.8;

/** The base ring, thicker for louder toys. */
function ringGeometry(r: number, volume: number) {
  return new THREE.TorusGeometry(r * 1.03, 0.008 + 0.022 * volume, 8, 64);
}

/** A random 65-bit id in base32. */
export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(13));
  return Array.from(b, (x) => "abcdefghijklmnopqrstuvwxyz234567"[x & 31]).join("");
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
