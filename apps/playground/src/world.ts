import * as THREE from "three";
import type { AudioHost } from "./audio/host";
import { MixState } from "./audio/mix";
import type { Fields } from "./audio/fields";
import { describeLoadError, MAX_TOYS, SCALE_CUSTOM } from "./audio/protocol";
import type { Stage } from "./render/stage";
import { planeBody, type GravityBody } from "./avatar/gravity";
import { toyEntry } from "./toys/registry";
import { SnapView, type PulseState, type Toy } from "./toys/toy";
import { sandbox, type Mode } from "./modes/mode";

/** What changed on a toy, for the multiplayer binding. */
export type ToyEdit = "pos" | "params" | "pulse" | "pattern" | "volume" | "wild";

/** Everything needed to make a toy again: put-away undo, and the shared room doc. */
export interface ToySnapshot {
  id: string;
  entry: string;
  pos: [number, number, number];
  params: Record<string, number>;
  pulse: PulseState;
  pattern: string;
  /** The toy's level in the music (shared, saved); missing in old snapshots. */
  volume?: number;
  /** Per-toy wild (MODES.md §7.1); omitted when false. */
  wild?: boolean;
}

export interface WorldTuning {
  root: number;
  /** A preset id, or SCALE_CUSTOM when a table or Scala file is loaded. */
  scale: number;
  wild: boolean;
  /** Name of the custom table, when `scale` is SCALE_CUSTOM. */
  custom?: string;
}

/** All toys in play plus the world's shared Tuning and tempo. */
export class World {
  readonly toys: (Toy | null)[] = new Array(MAX_TOYS).fill(null);
  tuning: WorldTuning = { root: 60, scale: 0, wild: false };
  bpm = 96;
  /** What this player hears: master, mute, solo, focus (local, never shared). */
  readonly mix: MixState;
  /** Gravity bodies (docs/AVATAR.md §4); V1 has only the ground. */
  readonly bodies: GravityBody[] = [planeBody()];
  /** Called after every tempo or Tuning change, local, remote or scripted (the HUD redraws). */
  onWorld: (() => void) | null = null;
  /** Called when toys are added or removed. */
  onChange: (() => void) | null = null;
  /** Local edits, for the room binding. Not called while `applying` remote changes. */
  readonly listeners: {
    add?(toy: Toy): void;
    remove?(toy: Toy): void;
    edit?(toy: Toy, what: ToyEdit): void;
    world?(what: "tempo" | "tuning"): void;
    poke?(toy: Toy, strength: number): void;
  }[] = [];
  /** Set while applying changes that came from the room, so they aren't echoed back. */
  applying = false;
  /** Whether this player may add, remove, move and retune toys (a locked room, MULTIPLAYER.md §12). */
  canEdit = () => true;
  /** The rules of play (MODES.md §3.1): sandbox allows everything; a puzzle locks some edits. */
  mode: Mode = sandbox;
  /** Spots toys must not be placed on (the Heart), by id. Local and derived, never shared. */
  private reserved = new Map<string, { pos: THREE.Vector3; radius: number }>();

  constructor(
    readonly stage: Stage,
    readonly audio: AudioHost,
    readonly fields: Fields,
  ) {
    this.mix = new MixState(this);
    this.setTempo(this.bpm);
    this.setTuning({});
    this.mix.apply();
    audio.onLoadError = (slot, what, code, detail) => {
      const msg = describeLoadError(code) + (detail && what === "external" ? `: ${detail}` : "");
      const toy = this.toys[slot];
      if (toy && what === "pattern") toy.patternError = msg;
      else console.warn(`toy ${slot} ${what}: ${msg}`);
      this.onLoadError?.(slot, what, msg);
    };
  }

  /** A toy's Law, Voice or pattern failed to load. */
  onLoadError: ((slot: number, what: string, message: string) => void) | null = null;

  /** Place a toy from the registry by id (see toys/registry.ts). */
  add(id: string, position?: THREE.Vector3, toyId?: string): Toy | null {
    if (!this.applying && (!this.canEdit() || !this.mode.allowAdd(id))) return null;
    const slot = this.toys.indexOf(null);
    const entry = toyEntry(id);
    if (slot < 0 || !entry) return null;
    const toy = entry.create(this, slot);
    toy.entryId = id;
    if (toyId) toy.id = toyId;
    toy.init(position ?? this.freeSpot());
    this.stage.scene.add(toy.group);
    this.toys[slot] = toy;
    this.mix.apply();
    this.onChange?.();
    if (!this.applying) for (const l of this.listeners) l.add?.(toy);
    return toy;
  }

  remove(toy: Toy) {
    if (!this.applying && (!this.canEdit() || !this.mode.allowRemove(toy))) return toy.refuse();
    this.audio.send({ t: "remove", slot: toy.slot });
    toy.dispose();
    this.toys[toy.slot] = null;
    this.mix.forget(toy);
    this.onChange?.();
    if (!this.applying) for (const l of this.listeners) l.remove?.(toy);
  }

  /** Called by toys after a local change (toys/toy.ts). */
  edited(toy: Toy, what: ToyEdit) {
    if (this.applying || this.toys[toy.slot] !== toy) return;
    for (const l of this.listeners) l.edit?.(toy, what);
  }

  /** Called by toys when played; anyone may play any toy, even in a locked room. */
  poked(toy: Toy, strength: number) {
    if (this.applying) return;
    for (const l of this.listeners) l.poke?.(toy, strength);
  }

  byId(id: string): Toy | null {
    return this.toys.find((t) => t?.id === id) ?? null;
  }

  snapshot(toy: Toy): ToySnapshot {
    const p = toy.group.position;
    return {
      id: toy.id,
      entry: toy.entryId,
      pos: [p.x, p.y, p.z],
      params: { ...toy.params },
      pulse: { ...toy.pulse, prob: [...toy.pulse.prob] },
      pattern: toy.pattern,
      volume: toy.volume,
      ...(toy.wild ? { wild: true } : {}),
    };
  }

  /** Make a toy from a snapshot (undo a put-away, or a toy that arrived from the room). */
  restore(s: ToySnapshot): Toy | null {
    const toy = this.add(s.entry, new THREE.Vector3(...s.pos), s.id);
    if (!toy) return null;
    this.applyState(toy, s);
    return toy;
  }

  /** Bring an existing toy to a snapshot's params, Pulse and pattern. */
  applyState(toy: Toy, s: Partial<ToySnapshot>) {
    if (s.pos) toy.moveTo(new THREE.Vector3(...s.pos));
    for (const [k, v] of Object.entries(s.params ?? {})) toy.setParam(k, v);
    if (s.pulse) toy.setPulse({ ...s.pulse, prob: [...s.pulse.prob] });
    if (s.pattern !== undefined && s.pattern !== toy.pattern) toy.setPattern(s.pattern);
    if (typeof s.volume === "number" && s.volume !== toy.volume) toy.setVolume(s.volume);
    if (s.wild !== undefined) toy.setWild(s.wild);
  }

  get count() {
    return this.toys.filter(Boolean).length;
  }

  /** The free spot nearest the middle of the view. */
  freeSpot(): THREE.Vector3 {
    const taken = this.toys.filter((t): t is Toy => !!t).map((t) => t.group.position);
    const spots: THREE.Vector3[] = [];
    for (let x = -6; x <= 6; x += 1.5) for (let z = -7; z <= 5; z += 1.5) spots.push(new THREE.Vector3(x, 0, z));
    // On narrow (portrait) screens, sideways space is scarce; prefer the centre column.
    const squeeze = Math.min(1, this.stage.camera.aspect);
    const cost = (p: THREE.Vector3) => (p.x / squeeze) ** 2 + p.z ** 2;
    spots.sort((a, b) => cost(a) - cost(b));
    const clear = (p: THREE.Vector3) => [...this.reserved.values()].every((r) => r.pos.distanceTo(p) > r.radius + 1.5);
    const spot = spots.find((p) => clear(p) && taken.every((q) => q.distanceTo(p) > 3));
    if (spot) return spot;
    const fallback = new THREE.Vector3(0, 0, -5);
    while (!clear(fallback)) fallback.z -= 1;
    return fallback;
  }

  /** Keep toys from being placed within `radius` of `pos` (MODES.md §5.1). */
  reserve(id: string, pos: THREE.Vector3, radius: number) {
    this.reserved.set(id, { pos: pos.clone(), radius });
  }

  release(id: string) {
    this.reserved.delete(id);
  }

  pickables(): THREE.Object3D[] {
    return this.toys.flatMap((t) => (t ? t.pickables : []));
  }

  setTempo(bpm: number) {
    if (!this.applying && (!this.canEdit() || !this.mode.allowWorld("tempo"))) return;
    this.bpm = Math.round(THREE.MathUtils.clamp(bpm, 40, 180));
    this.audio.send({ t: "tempo", bpm: this.bpm });
    if (!this.applying) for (const l of this.listeners) l.world?.("tempo");
    this.onWorld?.();
  }

  setTuning(t: Partial<WorldTuning>) {
    if (!this.applying && (!this.canEdit() || !this.mode.allowWorld("tuning"))) return;
    Object.assign(this.tuning, t);
    if (this.tuning.scale !== SCALE_CUSTOM) this.tuning.custom = undefined;
    const { root, scale, wild } = this.tuning;
    this.audio.send({ t: "tuning", root, scale, wild });
    if (!this.applying) for (const l of this.listeners) l.world?.("tuning");
    this.onWorld?.();
  }

  /** Any tuning as cents within a period (n-EDO, a Tonal scale, ...). */
  setTuningTable(name: string, cents: number[], period = 1200) {
    this.audio.send({ t: "tuningTable", period, cents });
    this.setTuning({ scale: SCALE_CUSTOM, custom: name });
  }

  /** A Scala .scl file. */
  setTuningScala(name: string, text: string) {
    this.audio.send({ t: "scl", text });
    this.setTuning({ scale: SCALE_CUSTOM, custom: name });
  }

  get master() {
    return this.mix.master;
  }

  setMaster(gain: number) {
    this.mix.setMaster(gain);
  }

  update(dt: number, t: number) {
    const data = this.audio.snapshot;
    const dtBeats = data ? (((performance.now() - this.audio.snapTime) / 1000) * this.bpm) / 60 : 0;
    for (const toy of this.toys) {
      if (toy) toy.update(dt, data ? new SnapView(data, toy.slot, dtBeats) : null, t);
    }
    this.mode.update(dt);
  }
}
