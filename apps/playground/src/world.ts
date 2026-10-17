import * as THREE from "three";
import type { AudioHost } from "./audio/host";
import type { Fields } from "./audio/fields";
import { describeLoadError, MAX_TOYS, SCALE_CUSTOM } from "./audio/protocol";
import type { Stage } from "./render/stage";
import { toyEntry } from "./toys/registry";
import { SnapView, type Toy } from "./toys/toy";

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
  master = 0.7;
  /** Called when toys are added or removed. */
  onChange: (() => void) | null = null;

  constructor(
    readonly stage: Stage,
    readonly audio: AudioHost,
    readonly fields: Fields,
  ) {
    this.setTempo(this.bpm);
    this.setTuning({});
    this.setMaster(this.master);
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
  add(id: string, position?: THREE.Vector3): Toy | null {
    const slot = this.toys.indexOf(null);
    const entry = toyEntry(id);
    if (slot < 0 || !entry) return null;
    const toy = entry.create(this, slot);
    toy.init(position ?? this.freeSpot());
    this.stage.scene.add(toy.group);
    this.toys[slot] = toy;
    this.onChange?.();
    return toy;
  }

  remove(toy: Toy) {
    this.audio.send({ t: "remove", slot: toy.slot });
    toy.dispose();
    this.toys[toy.slot] = null;
    this.onChange?.();
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
    return spots.find((p) => taken.every((q) => q.distanceTo(p) > 3)) ?? new THREE.Vector3(0, 0, -5);
  }

  pickables(): THREE.Object3D[] {
    return this.toys.flatMap((t) => (t ? t.pickables : []));
  }

  setTempo(bpm: number) {
    this.bpm = Math.round(THREE.MathUtils.clamp(bpm, 40, 180));
    this.audio.send({ t: "tempo", bpm: this.bpm });
  }

  setTuning(t: Partial<WorldTuning>) {
    Object.assign(this.tuning, t);
    if (this.tuning.scale !== SCALE_CUSTOM) this.tuning.custom = undefined;
    const { root, scale, wild } = this.tuning;
    this.audio.send({ t: "tuning", root, scale, wild });
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

  setMaster(gain: number) {
    this.master = THREE.MathUtils.clamp(gain, 0, 1);
    this.audio.send({ t: "master", gain: this.master * 0.85 });
  }

  update(dt: number, t: number) {
    const data = this.audio.snapshot;
    const dtBeats = data ? (((performance.now() - this.audio.snapTime) / 1000) * this.bpm) / 60 : 0;
    for (const toy of this.toys) {
      if (toy) toy.update(dt, data ? new SnapView(data, toy.slot, dtBeats) : null, t);
    }
  }
}
