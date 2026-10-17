import * as THREE from "three";
import { Kind, NOTE_STRIDE, PLANETS, Snap } from "../audio/protocol";
import { Heart, type ShellSpec, type ShellState } from "../render/heart";
import { toyEntry } from "../toys/registry";
import { SnapView, type PulseState, type Toy } from "../toys/toy";
import { announce } from "../ui/announce";
import { load, save } from "../prefs";
import type { World } from "../world";
import { evaluate, type Eval, type Observation, type ToyObs } from "./goals";
import { Holes } from "./holes";
import { sandbox, type Mode } from "./mode";
import type { Goal, Rule, ScenarioDoc, Solution, ToyRules, ToySpec } from "./scenario";
import { place, scaleSize } from "./tuning";

const BEATS_PER_BAR = 4;
/** Beats of notes kept per toy (a Nightfall cycle is 16; the bass lookup needs a little more). */
const NOTE_MEMORY = 40;

interface GoalState extends Eval {
  goal: Goal;
  locked: boolean;
  /** Locked at least once: gates `after` goals and reveals, which never take back. */
  ever: boolean;
  metSince: number | null;
  missSince: number | null;
}

/** Puzzles solved on this device (MODES.md §8: progress is local, never in the world). */
export const solvedPuzzles = () => load<string[]>("puzzles.solved", []);

/**
 * Puzzle mode (MODES.md §3–§6): a pre-arranged world whose toys are partly
 * locked, goals read from what is sounding, the Heart showing progress, and a
 * finale that plays the solution back as a piece of music.
 */
export class PuzzleMode implements Mode {
  readonly id = "puzzle";
  readonly states: GoalState[];
  /** Rules lifted: the world is a sandbox again, the Heart stays. */
  free = false;
  solved = false;
  /** Called on every shell lock / unlock and once on bloom, for UI. */
  onProgress: (() => void) | null = null;

  private heart: Heart;
  private holes = new Map<string, Holes>();
  private notes = new Map<string, ToyObs["notes"]>();
  private allowed: number[];
  private beat = 0;
  private allSince: number | null = null;
  private finaleStart: number | null = null;
  private started = new Set<number>();
  private fades: { toy: Toy; from: number; to: number; at: number; bars: number }[] = [];
  private bpmFrom = 0;
  private lastGain = performance.now();
  private bestSum = 0;

  constructor(
    readonly world: World,
    readonly doc: ScenarioDoc,
  ) {
    this.states = doc.goals.map((goal) => ({ goal, closeness: 0, met: false, locked: false, ever: false, metSince: null, missSince: null }));
    this.allowed = doc.allowedPcs ?? [...new Set(doc.goals.flatMap((g) => (g.kind === "chord" ? g.pcs : [])))];
    const pos = new THREE.Vector3(...doc.heart.pos);
    this.heart = new Heart(world.stage.scene, pos, doc.heart.radius, doc.goals.map((g) => this.shellSpec(g)), () => world.stage.reducedMotion);
  }

  /** Clear the world and lay out the scenario's starting state. */
  start() {
    const { world, doc } = this;
    world.mode.dispose();
    world.reserve("heart", new THREE.Vector3(...doc.heart.pos), doc.heart.radius);
    this.applying(() => {
      for (const t of world.toys) if (t) world.remove(t);
      world.setTempo(doc.world.bpm);
      world.setTuning({ root: doc.world.tuning.root, scale: doc.world.tuning.scale, wild: false });
      for (const spec of doc.world.toys) if (!spec.reveal) this.place(spec);
    });
    world.mode = this;
    world.audio.onNotes = (n) => this.takeNotes(n);
    this.subscribe();
    world.onChange?.();
  }

  private applying(f: () => void) {
    const was = this.world.applying;
    this.world.applying = true;
    try {
      f();
    } finally {
      this.world.applying = was;
    }
  }

  private place(spec: ToySpec): Toy | null {
    const toy = this.world.add(spec.entry, spec.pos ? new THREE.Vector3(...spec.pos) : undefined, spec.id);
    if (!toy) return null;
    const pulse = spec.pulse ? { ...toy.pulse, ...spec.pulse, prob: [...(spec.pulse.prob ?? toy.pulse.prob)] } : undefined;
    this.world.applyState(toy, { params: spec.params, pulse, pattern: spec.pattern, volume: spec.volume });
    const rule = this.doc.rules.toys[spec.id]?.pattern;
    if (rule && typeof rule === "object") {
      const holes = new Holes(toy, rule.template, rule.holes, (text) => {
        toy.setPattern(text);
        // Old notes belong to the old pattern; judge only what plays from now on.
        this.notes.set(toy.id, []);
      });
      this.holes.set(toy.id, holes);
      toy.setPattern(holes.text());
    }
    return toy;
  }

  /** Every toy a goal listens to reports its notes (MODES.md §3.3). */
  private subscribe() {
    const ids = new Set(this.doc.goals.flatMap(goalToys));
    const slots = this.world.toys.filter((t): t is Toy => !!t && ids.has(t.id)).map((t) => t.slot);
    this.world.audio.send({ t: "notes", slots });
  }

  private takeNotes(data: Float32Array) {
    const n = scaleSize(this.world.tuning.scale);
    for (let i = 0; i + NOTE_STRIDE <= data.length; i += NOTE_STRIDE) {
      const toy = this.world.toys[data[i]];
      if (!toy) continue;
      const p = place(data[i + 2], this.world.tuning.root, this.world.tuning.scale);
      if (!p) continue;
      const list = this.notes.get(toy.id) ?? [];
      list.push({ beat: data[i + 1], hz: data[i + 2], pc: ((p.pc % n) + n) % n });
      while (list.length && list[0].beat < data[i + 1] - NOTE_MEMORY) list.shift();
      this.notes.set(toy.id, list);
    }
  }

  // ---- Rules (MODES.md §3.1) ----

  private rules(toy: Toy): ToyRules | null {
    return this.free ? null : (this.doc.rules.toys[toy.id] ?? null);
  }

  private paramRule(toy: Toy, param: string): Rule {
    const r = this.rules(toy);
    if (!r) return "free";
    return r.params?.[param] ?? r.all ?? "free";
  }

  constrain(toy: Toy, param: string, v: number): number | null {
    const rule = this.paramRule(toy, param);
    if (rule === "free") return v;
    if (rule === "lock" || "lock" in rule) return null;
    if ("range" in rule) return THREE.MathUtils.clamp(v, rule.range[0], rule.range[1]);
    return rule.values.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
  }

  constrainPulse(toy: Toy, p: Partial<PulseState>): Partial<PulseState> | null {
    const r = this.rules(toy);
    const rule = r ? (r.pulse ?? r.all ?? "free") : "free";
    if (rule === "free") return p;
    if (rule === "lock" || !p.prob) return null;
    // "ring": only which steps fire may change, not the ring's length, rate or on/off.
    const changes = (Object.keys(p) as (keyof PulseState)[]).filter((k) => k !== "prob" && p[k] !== toy.pulse[k]);
    return changes.length ? null : { prob: p.prob };
  }

  constrainPattern(toy: Toy, text: string): string | null {
    const r = this.rules(toy);
    const rule = r ? (r.pattern ?? r.all ?? "free") : "free";
    if (rule === "free") return text;
    const holes = this.holes.get(toy.id);
    return holes && text.trim() === holes.text() ? text : null;
  }

  allowAdd(entryId: string): boolean {
    const chest = this.doc.rules.world?.chest ?? [];
    return this.free || chest === "free" || chest.includes(entryId);
  }

  allowRemove(toy: Toy): boolean {
    if (this.free) return true;
    const r = this.doc.rules.toys[toy.id];
    if (r) return r.remove ?? false;
    // Toys the scenario placed stay; anything the player added may go.
    return !this.doc.world.toys.some((s) => s.id === toy.id);
  }

  allowMove(toy: Toy): boolean {
    return this.rules(toy)?.move ?? true;
  }

  allowWorld(what: "tempo" | "tuning"): boolean {
    return this.free || this.doc.rules.world?.[what] === "free";
  }

  // ---- Observing and tracking (§3.3, §4.2) ----

  private observe(data: Float32Array, dtBeats: number): Observation {
    const { world } = this;
    const toys = new Map<string, ToyObs>();
    for (const toy of world.toys) {
      if (!toy) continue;
      const snap = new SnapView(data, toy.slot, dtBeats);
      const hz = snap.get(Snap.freq);
      const p = place(hz, world.tuning.root, world.tuning.scale);
      const periods = toy.kind === Kind.Orrery ? Array.from({ length: PLANETS }, (_, i) => (toy.params[`p${i}`] > 0 ? snap.get(Snap.planetPeriod + i) : 0)) : [];
      toys.set(toy.id, {
        id: toy.id,
        mono: toy.kind === Kind.Spire,
        hz,
        pc: p ? p.pc : null,
        cents: p ? p.cents : 0,
        notes: this.notes.get(toy.id) ?? [],
        periods,
        params: toy.params,
        pulse: toy.pulse,
        holes: this.holes.get(toy.id)?.values,
      });
    }
    return { beat: this.beat, n: scaleSize(world.tuning.scale), toys };
  }

  update(dt: number) {
    const { world } = this;
    const data = world.audio.snapshot;
    if (!data) return;
    const dtBeats = ((performance.now() - world.audio.snapTime) / 1000) * (world.bpm / 60);
    this.beat = data[0] + dtBeats;
    const obs = this.observe(data, dtBeats);
    const byId = new Map(this.states.map((s) => [s.goal.id, s]));
    let sum = 0;
    for (const s of this.states) {
      const g = s.goal;
      const active = (!g.after || !!byId.get(g.after)?.ever) && (!g.afterBloom || this.free);
      if (!active) {
        Object.assign(s, { closeness: 0, met: false, metSince: null });
        continue;
      }
      Object.assign(s, evaluate(g, obs, this.allowed));
      if (!s.locked) sum += s.closeness;
      if (s.met) {
        s.missSince = null;
        s.metSince ??= this.beat;
        if (!s.locked && this.beat - s.metSince >= (g.hold ?? 8)) this.lock(s);
      } else {
        s.metSince = null;
        if (s.locked) {
          s.missSince ??= this.beat;
          if (this.beat - s.missSince >= (g.release ?? 4)) {
            s.locked = false;
            this.onProgress?.();
          }
        }
      }
    }
    // Hints (§5.6): nothing gained for a while → the most-progressed open thread pulses.
    if (sum > this.bestSum + 0.02) this.lastGain = performance.now();
    this.bestSum = Math.max(this.bestSum * 0.999, sum);

    const required = this.states.filter((s) => !s.goal.optional);
    if (!this.solved && required.every((s) => s.locked)) {
      this.allSince ??= this.beat;
      // Held together for one more bar: bloom.
      if (this.beat - this.allSince >= BEATS_PER_BAR) this.bloom();
    } else this.allSince = null;

    if (this.finaleStart !== null) this.finale();
    this.draw(dt);
  }

  private lock(s: GoalState) {
    s.locked = true;
    const first = !s.ever;
    s.ever = true;
    this.lastGain = performance.now();
    this.bestSum = 0;
    // The lock chime: the shell's toy sounds its note once.
    const toy = this.world.byId(goalToys(s.goal)[0]);
    toy?.poke(0.7);
    const req = this.states.filter((x) => !x.goal.optional);
    const n = req.filter((x) => x.locked).length;
    announce(s.goal.optional ? "A hidden layer found" : `Layer ${n} of ${req.length} found`);
    if (first) {
      const reveal = this.doc.world.toys.filter((t) => t.reveal === s.goal.id && !this.world.byId(t.id));
      if (reveal.length) {
        this.applying(() => reveal.forEach((t) => this.place(t)));
        this.subscribe();
        this.world.onChange?.();
      }
    }
    this.onProgress?.();
  }

  private bloom() {
    this.solved = true;
    this.heart.startBloom();
    this.finaleStart = this.beat;
    this.bpmFrom = this.world.bpm;
    const done = solvedPuzzles();
    if (!done.includes(this.doc.id)) save("puzzles.solved", [...done, this.doc.id]);
    announce("Every layer found. The Heart blooms.");
    this.onProgress?.();
  }

  // ---- Finale (§6) ----

  private finale() {
    const f = this.doc.finale;
    const bars = (this.beat - this.finaleStart!) / BEATS_PER_BAR;
    const heart = new THREE.Vector3(...this.doc.heart.pos);
    f.layers.forEach((layer, i) => {
      if (this.started.has(i) || bars < layer.at) return;
      this.started.add(i);
      this.applying(() => {
        if (layer.add) {
          const a = (i / Math.max(1, f.layers.length)) * Math.PI * 2 + 0.6;
          const r = this.doc.heart.radius + 1.6;
          const pos = layer.add.pos ?? [heart.x + Math.cos(a) * r, 0, heart.z + Math.sin(a) * r];
          const toy = this.place({ ...layer.add, id: layer.add.id ?? `finale-${i}`, pos, volume: 0 });
          if (toy) this.fades.push({ toy, from: 0, to: layer.add.volume ?? 0.75, at: layer.at, bars: layer.fade ?? 4 });
        }
        if (layer.toy) {
          const toy = this.world.byId(layer.toy);
          if (toy) this.fades.push({ toy, from: toy.volume, to: layer.volume ?? 0, at: layer.at, bars: layer.fade ?? 4 });
        }
        if (layer.tuning) this.world.setTuning(layer.tuning);
      });
    });
    this.applying(() => {
      for (const fade of this.fades) {
        const k = THREE.MathUtils.clamp((bars - fade.at) / fade.bars, 0, 1);
        fade.toy.setVolume(fade.from + (fade.to - fade.from) * k);
      }
      this.fades = this.fades.filter((x) => bars < x.at + x.bars);
      if (f.tempo) {
        const k = Math.min(1, bars / f.tempo.over);
        const bpm = Math.round(this.bpmFrom + (f.tempo.to - this.bpmFrom) * k);
        if (bpm !== this.world.bpm) this.world.setTempo(bpm);
      }
    });
    if (!this.free && bars >= (f.freeAt ?? 8)) this.lift();
  }

  /** The rules lift: every toy stays, and the world is a sandbox you can keep playing. */
  lift() {
    this.free = true;
    this.applying(() => {
      for (const [id, t] of Object.entries(this.doc.finale.then?.toys ?? {})) if (t.wild !== undefined) this.world.byId(id)?.setWild(t.wild);
    });
    this.world.onChange?.();
    this.onProgress?.();
  }

  // ---- Drawing ----

  private shellSpec(g: Goal): ShellSpec {
    const color = this.toyColor(goalToys(g)[0]);
    const optional = !!g.optional;
    switch (g.kind) {
      case "chord":
        return { kind: g.kind, color, optional, count: g.pcs.length };
      case "chordTones":
        return { kind: g.kind, color, optional, count: Object.values(g.chords).reduce((a, c) => a + c.length, 0) };
      case "ratio":
        return { kind: g.kind, color, optional, count: g.ratio ? g.ratio[0] : 2, period: g.beats ?? 6 };
      case "rhythm":
        return { kind: g.kind, color, optional, count: g.hits[0], period: 8 };
      default:
        return { kind: g.kind, color, optional, count: 1 };
    }
  }

  private toyColor(id: string): number {
    const entry = toyEntry(this.doc.world.toys.find((t) => t.id === id)?.entry ?? "");
    return new THREE.Color(entry?.color ?? "#ffffff").getHex();
  }

  private draw(dt: number) {
    const { world } = this;
    const data = world.audio.snapshot;
    const quiet = (performance.now() - this.lastGain) / 1000;
    const hintAt = this.doc.hints?.after[0] ?? 45;
    const open = this.states.filter((s) => !s.locked && !s.goal.optional && s.closeness > 0);
    const hinted = quiet > hintAt && open.length ? open.reduce((a, b) => (b.closeness > a.closeness ? b : a)) : null;
    const states: ShellState[] = this.states.map((s) => {
      const g = s.goal;
      const dormant = (!!g.after && !this.states.find((x) => x.goal.id === g.after)?.ever) || (!!g.afterBloom && !this.free);
      const feeds = goalToys(g)
        .map((id) => world.byId(id))
        .filter((t): t is Toy => !!t)
        .map((t) => ({ pos: t.group.position, flash: data ? new SnapView(data, t.slot, 0).get(Snap.flash) : 0 }));
      return { closeness: s.closeness, locked: s.locked, dormant, cents: s.cents ?? 0, feeds, hint: s === hinted };
    });
    this.heart.update(dt, performance.now() / 1000, this.beat, states);
    for (const [id, h] of this.holes) {
      const t = world.byId(id);
      h.update(t && data ? new SnapView(data, t.slot, 0).get(Snap.flash) : 0);
    }
  }

  // ---- Dev ----

  /** Apply one of the scenario's listed solutions, bypassing the rules (tests and `cosmic.puzzle.solve()`). */
  solve(which = 0) {
    const sol: Solution | undefined = this.doc.solutions?.[which];
    if (!sol) return false;
    this.applying(() => {
      for (const [id, params] of Object.entries(sol.params ?? {})) {
        const t = this.world.byId(id);
        if (t) for (const [k, v] of Object.entries(params)) t.setParam(k, v);
      }
      for (const [id, p] of Object.entries(sol.pulse ?? {})) this.world.byId(id)?.setPulse(p);
      for (const [id, values] of Object.entries(sol.holes ?? {})) {
        const h = this.holes.get(id);
        if (h) {
          h.toy.setPattern(h.set(values));
          this.notes.set(id, []);
        }
      }
    });
    return true;
  }

  dispose() {
    for (const h of this.holes.values()) h.dispose();
    this.holes.clear();
    this.heart.dispose();
    this.world.release("heart");
    this.world.audio.send({ t: "notes", slots: [] });
    if (this.world.audio.onNotes) this.world.audio.onNotes = null;
    if (this.world.mode === this) this.world.mode = sandbox;
    this.world.onChange?.();
  }
}

/** Toys a goal listens to, the main one first. */
export function goalToys(g: Goal): string[] {
  switch (g.kind) {
    case "chord":
    case "smooth":
      return g.toys;
    case "interval":
      return [g.toy, g.to];
    case "chordTones":
      return [g.toy, g.over, ...(g.differFrom ? [g.differFrom] : [])];
    default:
      return [g.toy];
  }
}
