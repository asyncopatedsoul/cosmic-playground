import * as THREE from "three";
import type { Avatar } from "../avatar/avatar";
import type { OrbitState } from "../render/stage";
import type { Toy } from "../toys/toy";
import { announce, toast } from "../ui/announce";
import type { PulseEditor } from "../ui/pulse-editor";
import { toyName } from "../ui/sound";
import type { World } from "../world";
import { frameDistance, ringLayout, ringMax, ringRadius } from "./ring";
import { PitchTrace } from "./trace";

/** How the ring is heard (FOCUS-VIEW.md §4.4). */
export type ListenMode = "set" | "soloSet" | "soloLead";

/** Toys off the ring are pushed back along the camera ray by this much. */
const DRIFT = 4;
/** Off-ring toys fade to this brightness. */
const BACKDROP_OPACITY = 0.25;
/** Camera elevation while framing the ring (about 25°). */
const ELEVATION = 0.44;
/** Ring centre falls back to the origin when the orbit target is further than this. */
const FAR = 12;
/** How far toward the camera the view shifts (as a fraction of the ring's bound) while the Trace is open. */
const TRACE_LIFT = 0.55;

interface Faded {
  opacity: number;
  transparent: boolean;
}

/**
 * Focus view (docs/FOCUS-VIEW.md §3–§5): the chosen toys on a ring in the
 * middle of the screen, the rest of the world dimmed and pushed back. Every
 * toy gets a display pose (`Toy.home` keeps its real position), so nothing
 * moves for anyone else in a room and leaving puts everything back.
 */
export class FocusView {
  active = false;
  ring: Toy[] = [];
  lead = 0;
  listen: ListenMode = "set";
  readonly trace: PitchTrace;
  /** Called when entering, leaving, or the ring or lead change (the focus bar). */
  onChange: (() => void) | null = null;

  private leaving = false;
  private centre = new THREE.Vector3();
  private radius = 0;
  private azimuth = 0;
  private turn = 0;
  private turnTarget = 0;
  private savedOrbit: OrbitState | null = null;
  private orbitTo: OrbitState | null = null;
  private orbitFrom: OrbitState | null = null;
  private orbitT = 1;
  private wasAvatar = false;
  private faded = new Map<THREE.Material, Faded>();
  /** Where each off-ring toy is pushed to, relative to its home. */
  private drift = new Map<Toy, THREE.Vector3>();
  private prevNotes: ((n: Float32Array) => void) | null = null;

  constructor(
    private world: World,
    private avatar: Avatar,
    private editor: PulseEditor,
  ) {
    this.trace = new PitchTrace(world);
    document.body.append(this.trace.el);
    const prev = world.onChange;
    world.onChange = () => {
      prev?.();
      this.pruneGone();
    };
    // Rotating a phone or resizing the window re-frames the ring (and squashes it in portrait).
    addEventListener("resize", () => {
      if (this.active) this.layout();
    });
  }

  get leadToy(): Toy | null {
    return this.ring[this.lead] ?? null;
  }

  get max() {
    return ringMax();
  }

  /** `F`: the selection, else `fallback` (the aimed or last-touched toy). */
  toggle(fallback: Toy | null) {
    if (this.active) {
      this.leave();
      return;
    }
    const picked = this.world.toys.filter((t): t is Toy => !!t && this.world.selection.has(t.id));
    this.enter(picked.length ? picked : fallback ? [fallback] : []);
  }

  enter(toys: Toy[]) {
    if (!toys.length) {
      toast("Pick a toy first: Shift+click to select");
      return;
    }
    if (this.active) this.finishLeave();
    const max = this.max;
    if (toys.length > max) toast(`${max} at a time on the ring`);
    this.ring = toys.slice(0, max);
    this.lead = 0;
    this.active = true;
    this.leaving = false;

    this.wasAvatar = this.avatar.active;
    if (this.wasAvatar) this.avatar.exit();
    const stage = this.world.stage;
    this.savedOrbit = stage.getOrbit();
    this.azimuth = this.savedOrbit.azimuth;
    this.centre.copy(this.savedOrbit.target).setY(0);
    if (this.centre.length() > FAR) this.centre.set(0, 0, 0);

    for (const toy of this.world.toys) if (toy) toy.home ??= toy.group.position.clone();
    this.layout();
    this.turn = this.turnTarget = 0;
    this.fadeBackdrop(true);
    this.applyListen();
    this.subscribe();
    this.trace.reset();
    this.syncTrace();
    if (this.editor.toy) this.editor.open(this.leadToy!);
    announce(`Focus view: ${this.ring.length} ${this.ring.length === 1 ? "toy" : "toys"}. Lead: ${this.describeLead()}`);
    this.onChange?.();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.leaving = true;
    this.fadeBackdrop(false);
    this.world.mix.setFocusSet([], false);
    this.world.audio.send({ t: "notes", slots: [] });
    this.world.audio.onNotes = this.prevNotes;
    this.trace.toggle(false);
    if (this.savedOrbit) this.tweenCamera(this.savedOrbit);
    if (this.world.stage.reducedMotion) this.finishLeave();
    announce("Left focus view");
    this.onChange?.();
  }

  /** Make toy `i` (ring order) the lead; the ring turns to bring it to the front. */
  setLead(i: number) {
    const n = this.ring.length;
    if (!this.active || !n) return;
    this.lead = ((i % n) + n) % n;
    // Turn the short way round.
    let target = (-Math.PI * 2 * this.lead) / n;
    while (target - this.turn > Math.PI) target -= Math.PI * 2;
    while (target - this.turn < -Math.PI) target += Math.PI * 2;
    this.turnTarget = target;
    if (this.world.stage.reducedMotion) this.turn = target;
    if (this.listen === "soloLead") this.applyListen();
    if (this.editor.toy) this.editor.open(this.leadToy!);
    this.syncTrace();
    announce(`Lead: ${this.describeLead()}`);
    this.onChange?.();
  }

  cycle(d: number) {
    this.setLead(this.lead + d);
  }

  /** Add a toy from the world to the ring; when it's full, it replaces the lead. */
  add(toy: Toy) {
    if (!this.active || this.ring.includes(toy)) return;
    if (this.ring.length >= this.max) this.ring[this.lead] = toy;
    else this.ring.push(toy);
    this.reshape(this.ring.indexOf(toy));
  }

  remove(toy: Toy) {
    const i = this.ring.indexOf(toy);
    if (!this.active || i < 0) return;
    if (this.ring.length === 1) {
      this.leave();
      return;
    }
    this.ring.splice(i, 1);
    this.reshape(Math.min(this.lead, this.ring.length - 1));
  }

  setListen(mode: ListenMode) {
    this.listen = mode;
    this.applyListen();
    this.onChange?.();
  }

  /** Per frame: ease toys toward their poses, turn the ring, move the camera. */
  update(dt: number) {
    if (!this.active && !this.leaving) return;
    const stage = this.world.stage;
    const k = stage.reducedMotion ? 1 : 1 - Math.exp(-dt * 8);
    this.turn += (this.turnTarget - this.turn) * (stage.reducedMotion ? 1 : 1 - Math.exp(-dt * 10));

    if (this.orbitTo && this.orbitFrom && this.orbitT < 1) {
      this.orbitT = Math.min(1, this.orbitT + (stage.reducedMotion ? 1 : dt / 0.5));
      const e = this.orbitT * this.orbitT * (3 - 2 * this.orbitT);
      const a = this.orbitFrom;
      const b = this.orbitTo;
      stage.setOrbitState({
        target: a.target.clone().lerp(b.target, e),
        azimuth: a.azimuth + (b.azimuth - a.azimuth) * e,
        elevation: a.elevation + (b.elevation - a.elevation) * e,
        distance: a.distance + (b.distance - a.distance) * e,
      });
    }

    const poses = this.active ? ringLayout(this.ring.length, this.centre, this.radius, this.azimuth, this.turn, this.portrait) : [];
    let settled = this.orbitT >= 1;
    for (const toy of this.world.toys) {
      if (!toy?.home) continue;
      let want: THREE.Vector3;
      if (!this.active) want = toy.home;
      else {
        const i = this.ring.indexOf(toy);
        want = i >= 0 ? poses[i] : toy.home.clone().add(this.driftFor(toy));
      }
      const p = toy.group.position;
      const dist = p.distanceTo(want);
      if (dist > 1e-3) {
        p.lerp(want, k);
        toy.sendPan();
        settled = false;
      } else if (dist > 0) p.copy(want);
    }
    if (this.orbitT < 1) for (const toy of this.ring) toy.sendPan();
    if (this.leaving && settled) this.finishLeave();
    if (this.active) this.trace.update();
  }

  private get portrait() {
    return innerHeight > innerWidth;
  }

  private finishLeave() {
    this.leaving = false;
    for (const toy of this.world.toys) {
      if (!toy?.home) continue;
      toy.group.position.copy(toy.home);
      toy.home = null;
      toy.sendPan();
    }
    this.drift.clear();
    if (this.savedOrbit) this.world.stage.setOrbitState(this.savedOrbit);
    this.orbitT = 1;
    this.ring = [];
    this.savedOrbit = null;
    if (this.wasAvatar) this.avatar.enter();
    this.wasAvatar = false;
  }

  /** Open or close the Pitch Trace; the camera lifts the ring above it while it's open. */
  setTrace(open = !this.trace.open) {
    if (!this.active) return;
    this.trace.toggle(open);
    this.layout();
    this.onChange?.();
  }

  /** The ring's radius and the camera that frames it. */
  private layout() {
    const footprint = Math.max(1.2, ...this.ring.map(footprintOf));
    this.radius = ringRadius(this.ring.length, footprint);
    const stage = this.world.stage;
    const bound = this.radius + footprint / 2 + 0.3;
    // orbitPose stands further back on portrait screens; undo that here.
    const aspect = stage.camera.aspect > 0 ? stage.camera.aspect : 1;
    const height = Math.max(1, ...this.ring.map(heightOf));
    // With the Trace docked along the bottom (or a sheet up on a phone), the ring
    // gets the upper part of the screen: frame it smaller and aim nearer the camera.
    const open = this.trace.open;
    const d = frameDistance(bound, height, stage.camera.fov, aspect, ELEVATION, open ? 0.6 : 0.75) * Math.min(1, aspect) ** 0.75;
    const lift = open ? bound * TRACE_LIFT : 0;
    const target = this.centre.clone().setY(0.5).add(new THREE.Vector3(Math.sin(this.azimuth), 0, Math.cos(this.azimuth)).multiplyScalar(lift));
    this.tweenCamera({ target, azimuth: this.azimuth, elevation: ELEVATION, distance: d });
  }

  /** The ring changed size: re-lay it out and keep `lead` in front. */
  private reshape(lead: number) {
    this.layout();
    this.drift.clear();
    this.fadeBackdrop(false);
    this.fadeBackdrop(true);
    this.applyListen();
    this.subscribe();
    this.turn = this.turnTarget = (-Math.PI * 2 * lead) / this.ring.length;
    this.lead = lead;
    this.syncTrace();
    this.onChange?.();
  }

  private tweenCamera(to: OrbitState) {
    this.orbitFrom = this.world.stage.getOrbit();
    this.orbitTo = to;
    this.orbitT = 0;
  }

  /** Off-ring toys move away from the ring, straight back from the camera. */
  private driftFor(toy: Toy): THREE.Vector3 {
    let v = this.drift.get(toy);
    if (!v) {
      const away = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
      v = away.multiplyScalar(this.world.stage.reducedMotion ? 0 : DRIFT);
      this.drift.set(toy, v);
    }
    return v;
  }

  private fadeBackdrop(on: boolean) {
    if (!on) {
      for (const [m, f] of this.faded) {
        m.opacity = f.opacity;
        m.transparent = f.transparent;
        m.needsUpdate = true;
      }
      this.faded.clear();
      return;
    }
    for (const toy of this.world.toys) {
      if (!toy || this.ring.includes(toy)) continue;
      toy.group.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        for (const m of mat ? (Array.isArray(mat) ? mat : [mat]) : []) {
          if (this.faded.has(m) || (m.transparent && m.opacity === 0)) continue;
          this.faded.set(m, { opacity: m.opacity, transparent: m.transparent });
          m.transparent = true;
          m.opacity *= BACKDROP_OPACITY;
          m.needsUpdate = true;
        }
      });
    }
  }

  private applyListen() {
    if (!this.active) return;
    const ids = this.listen === "soloLead" ? [this.leadToy!.id] : this.ring.map((t) => t.id);
    this.world.mix.setFocusSet(ids, this.listen !== "set");
  }

  /** Ask the engine for every note of the ring toys (the Trace's data). */
  private subscribe() {
    const { audio } = this.world;
    if (audio.onNotes !== this.onNotes) {
      this.prevNotes = audio.onNotes;
      audio.onNotes = this.onNotes;
    }
    audio.send({ t: "notes", slots: this.ring.map((t) => t.slot) });
  }

  private onNotes = (notes: Float32Array) => {
    this.prevNotes?.(notes);
    this.trace.notes.push(notes);
  };

  private syncTrace() {
    this.trace.ring = this.ring;
    this.trace.lead = this.leadToy;
  }

  /** A ring toy left the world (put away, or removed by the room). */
  private pruneGone() {
    if (!this.active) return;
    const kept = this.ring.filter((t) => this.world.toys.includes(t));
    if (kept.length === this.ring.length) return;
    if (!kept.length) {
      this.leave();
      return;
    }
    const lead = this.leadToy && kept.includes(this.leadToy) ? kept.indexOf(this.leadToy) : 0;
    this.ring = kept;
    this.reshape(lead);
  }

  private describeLead() {
    const t = this.leadToy;
    return t ? `${toyName(t)}, ${this.lead + 1} of ${this.ring.length}` : "none";
  }
}

/** How tall a toy stands. */
function heightOf(toy: Toy): number {
  const box = new THREE.Box3().setFromObject(toy.group);
  return box.isEmpty() ? 1 : box.max.y - box.min.y;
}

/** The widest a toy is on the ground. */
function footprintOf(toy: Toy): number {
  const box = new THREE.Box3().setFromObject(toy.group);
  if (box.isEmpty()) return 1.2;
  const size = box.getSize(new THREE.Vector3());
  return Math.max(size.x, size.z);
}
