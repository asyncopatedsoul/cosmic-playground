import type { PulseState } from "../toys/toy";
import { toyEntry } from "../toys/registry";

/**
 * A puzzle on disk (MODES.md §3.2): a starting world plus rules, goals, the
 * Heart and the finale. One JSON file under `apps/playground/puzzles/`.
 */
export interface ScenarioDoc {
  format: "cosmic-scenario";
  version: 1;
  /** `{mode}-{scenario}[-{variant}]`, e.g. `puzzle-first-light`. */
  id: string;
  series: string;
  order: number;
  icon: string;
  name: string;
  world: { bpm: number; tuning: { root: number; scale: number }; toys: ToySpec[] };
  rules: Rules;
  goals: Goal[];
  /** Pitch classes the finale is written in; chord goals tolerate extras from it (§4.1). */
  allowedPcs?: number[];
  heart: { pos: [number, number, number]; radius: number };
  finale: Finale;
  hints?: { after: number[] };
  /** Param sets that solve the puzzle, for tests and `cosmic.puzzle.solve()`. */
  solutions?: Solution[];
}

export interface ToySpec {
  id: string;
  entry: string;
  pos?: [number, number, number];
  params?: Record<string, number>;
  pulse?: Partial<PulseState>;
  pattern?: string;
  volume?: number;
  /** Placed only once this goal locks (staged reveals, §4.2). */
  reveal?: string;
}

/** `"lock"`, `"free"`, a narrower range, a list of allowed values, or pinned to a value. */
export type Rule = "lock" | "free" | { range: [number, number] } | { values: number[] } | { lock: number };

export interface HoleSpec {
  values: number[];
  start: number;
}

export interface ToyRules {
  /** Default for every param not listed in `params`. */
  all?: "lock" | "free";
  params?: Record<string, Rule>;
  /** `"ring"`: only the ring's steps may change (not its length, rate or on/off). */
  pulse?: "lock" | "free" | "ring";
  /** A template with holes (§4.3) is the only pattern the toy accepts. */
  pattern?: "lock" | "free" | { template: string; holes: Record<string, HoleSpec> };
  move?: boolean;
  remove?: boolean;
}

export interface Rules {
  world?: { tempo?: "lock" | "free"; tuning?: "lock" | "free"; chest?: string[] | "free" };
  toys: Record<string, ToyRules>;
}

interface GoalBase {
  id: string;
  /** Bonus shells: don't count toward completion (§4.1). */
  optional?: boolean;
  /** Only evaluated once this goal has locked (§4.2). */
  after?: string;
  /** Beats `met` must hold before the shell locks (default 8). */
  hold?: number;
  /** Beats a locked shell stays locked after `met` slips (default 4). */
  release?: number;
  /** For screen readers ("same note as the drone"); never needed to play. */
  label?: string;
  /** Checked only once the rules lift (the First Light moon). */
  afterBloom?: boolean;
}

export type Goal = GoalBase &
  (
    | { kind: "pitch"; toy: string; pc: number }
    | { kind: "interval"; toy: string; to: string; steps?: number[]; cents?: [number, number] }
    | { kind: "chord"; toys: string[]; pcs: number[] }
    | { kind: "chordTones"; toy: string; over: string; chords: Record<string, number[]>; differFrom?: string; cycle?: number }
    | { kind: "ratio"; toy: string; planets?: [number, number]; ratio?: [number, number]; planet?: number; beats?: number }
    | { kind: "rhythm"; toy: string; hits: number[]; steps: number }
    | { kind: "smooth"; toys: string[]; maxSteps: number }
  );

export type GoalKind = Goal["kind"];

export interface FinaleLayer {
  /** Bars after the bloom. */
  at: number;
  /** Bars to fade in (or out). */
  fade?: number;
  /** A new toy born on the Heart. */
  add?: Omit<ToySpec, "id" | "reveal"> & { id?: string };
  /** Bring an existing toy's volume somewhere (e.g. 0 to let the others carry on). */
  toy?: string;
  volume?: number;
  /** A world change (Nightfall darkens to Dorian). */
  tuning?: { scale?: number; root?: number };
}

export interface Finale {
  tempo?: { to: number; over: number };
  layers: FinaleLayer[];
  /** Bars after the bloom when the rules lift and the world becomes a sandbox. */
  freeAt?: number;
  then?: { toys?: Record<string, { wild?: boolean }> };
}

export interface Solution {
  params?: Record<string, Record<string, number>>;
  pulse?: Record<string, Partial<PulseState>>;
  holes?: Record<string, Record<string, number>>;
}

/** Check a scenario by hand, like SAVE-LOAD's validator: returns problems, [] when fine. */
export function validateScenario(doc: ScenarioDoc): string[] {
  const out: string[] = [];
  if (doc.format !== "cosmic-scenario") out.push("format must be cosmic-scenario");
  if (!/^[a-z]+(-[a-z0-9]+)+$/.test(doc.id)) out.push(`id "${doc.id}" isn't {mode}-{scenario}`);
  const ids = new Set(doc.world.toys.map((t) => t.id));
  const goalIds = new Set(doc.goals.map((g) => g.id));
  for (const t of doc.world.toys) {
    if (!toyEntry(t.entry)) out.push(`toy ${t.id}: unknown entry ${t.entry}`);
    if (t.reveal && !goalIds.has(t.reveal)) out.push(`toy ${t.id}: reveal on unknown goal ${t.reveal}`);
  }
  for (const id of Object.keys(doc.rules.toys)) if (!ids.has(id)) out.push(`rules: unknown toy ${id}`);
  const refs = (g: Goal): string[] =>
    "toys" in g ? g.toys : [g.toy, ...("to" in g ? [g.to] : []), ...("over" in g ? [g.over] : []), ...("differFrom" in g && g.differFrom ? [g.differFrom] : [])];
  for (const g of doc.goals) {
    for (const r of refs(g)) if (!ids.has(r)) out.push(`goal ${g.id}: unknown toy ${r}`);
    if (g.after && !goalIds.has(g.after)) out.push(`goal ${g.id}: after unknown goal ${g.after}`);
  }
  if (doc.allowedPcs) {
    for (const g of doc.goals) if (g.kind === "chord") for (const pc of g.pcs) if (!doc.allowedPcs.includes(pc)) out.push(`allowedPcs misses ${pc} from goal ${g.id}`);
  }
  return out;
}
