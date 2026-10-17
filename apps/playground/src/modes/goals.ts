import { euclid, type PulseState } from "../toys/toy";
import type { Goal } from "./scenario";

/** One toy as the goals see it (MODES.md §3.3). */
export interface ToyObs {
  id: string;
  /** Monophonic toys: their pitch is `pc`, always current (the Spire). Others use `notes`. */
  mono: boolean;
  hz: number;
  pc: number | null;
  cents: number;
  /** Recent notes (subscribed slots), oldest first. */
  notes: { beat: number; hz: number; pc: number }[];
  /** Orrery planet periods in beats (0 = no planet). */
  periods: number[];
  params: Record<string, number>;
  pulse: PulseState;
  /** Pattern-hole values, when the toy has holes. */
  holes?: Record<string, number>;
}

export interface Observation {
  beat: number;
  /** Tones in the scale. */
  n: number;
  toys: Map<string, ToyObs>;
}

export interface Eval {
  closeness: number;
  met: boolean;
  /** Cents out of tune, for the Heart's wobble. */
  cents?: number;
}

const NONE: Eval = { closeness: 0, met: false };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Steps between two pitch classes around the scale. */
const pcDist = (a: number, b: number, n: number) => {
  const d = (((a - b) % n) + n) % n;
  return Math.min(d, n - d);
};

/** Pitch classes a toy sounded in the last `beats` (its current pitch for monophonic toys). */
function pcsOf(t: ToyObs, beat: number, beats: number): Set<number> {
  if (t.mono) return new Set(t.pc === null ? [] : [t.pc]);
  return new Set(t.notes.filter((x) => x.beat > beat - beats).map((x) => x.pc));
}

export function evaluate(g: Goal, obs: Observation, allowed: number[]): Eval {
  const { n } = obs;
  switch (g.kind) {
    case "pitch": {
      const t = obs.toys.get(g.toy);
      if (!t || t.pc === null) return NONE;
      const d = pcDist(t.pc, g.pc, n);
      const closeness = d === 0 ? 0.9 + 0.1 * clamp01(1 - Math.abs(t.cents) / 50) : 0.85 * (1 - d / (n / 2));
      return { closeness, met: d === 0, cents: d === 0 ? t.cents : 50 * d };
    }
    case "interval": {
      const a = obs.toys.get(g.toy);
      const b = obs.toys.get(g.to);
      if (!a || !b || a.pc === null || b.pc === null) return NONE;
      if (g.cents) {
        const c = (((1200 * Math.log2(a.hz / b.hz)) % 1200) + 1200) % 1200;
        const [lo, hi] = g.cents;
        const off = c < lo ? lo - c : c > hi ? c - hi : 0;
        return { closeness: clamp01(1 - off / 300), met: off === 0, cents: off };
      }
      const diff = (((a.pc - b.pc) % n) + n) % n;
      const d = Math.min(...(g.steps ?? [0]).map((s) => pcDist(diff, s, n)));
      return { closeness: d === 0 ? 1 : 0.85 * (1 - d / (n / 2)), met: d === 0, cents: d === 0 ? a.cents - b.cents : 50 * d };
    }
    case "chord": {
      const sounding = new Set<number>();
      for (const id of g.toys) {
        const t = obs.toys.get(id);
        if (t) for (const pc of pcsOf(t, obs.beat, 4)) sounding.add(pc);
      }
      if (!sounding.size) return NONE;
      const target = new Set(g.pcs);
      const hit = [...target].filter((pc) => sounding.has(pc)).length;
      const extra = [...sounding].filter((pc) => !allowed.includes(pc)).length;
      const closeness = (hit / target.size) * (1 - extra / sounding.size);
      return { closeness, met: hit === target.size && extra === 0 };
    }
    case "chordTones": {
      const t = obs.toys.get(g.toy);
      const bass = obs.toys.get(g.over);
      if (!t || !bass) return NONE;
      const cycle = g.cycle ?? 16;
      const other = g.differFrom ? obs.toys.get(g.differFrom) : undefined;
      const recent = t.notes.filter((x) => x.beat > obs.beat - cycle);
      let ok = 0;
      let total = 0;
      const seen = new Set<string>();
      for (const note of recent) {
        const under = [...bass.notes].reverse().find((b) => b.beat <= note.beat + 0.25);
        if (!under) continue;
        const key = String(under.pc);
        const chord = g.chords[key];
        if (!chord) continue;
        total++;
        seen.add(key);
        // The other voice's latest note (in the last few beats) sharing this one's pitch class.
        const prev = other && [...other.notes].reverse().find((o) => o.beat <= note.beat + 0.25);
        const clash = !!prev && note.beat - prev.beat < 4 && prev.pc === note.pc;
        if (chord.includes(note.pc) && !clash) ok++;
      }
      if (!total) return NONE;
      const all = Object.keys(g.chords).every((k) => seen.has(k));
      return { closeness: (ok / total) * (all ? 1 : 0.9), met: all && ok === total };
    }
    case "ratio": {
      const t = obs.toys.get(g.toy);
      if (!t) return NONE;
      if (g.planet !== undefined && g.beats) {
        const T = t.periods[g.planet];
        if (!T) return NONE;
        const off = Math.abs(Math.log2(T / g.beats));
        return { closeness: clamp01(1 - off), met: off < 0.01 };
      }
      if (g.planets && g.ratio) {
        const [a, b] = g.planets.map((i) => t.periods[i]);
        if (!a || !b) return NONE;
        const off = Math.abs(Math.log2(a / b / (g.ratio[0] / g.ratio[1])));
        return { closeness: clamp01(1 - off), met: off < 0.01 };
      }
      return NONE;
    }
    case "rhythm": {
      const t = obs.toys.get(g.toy);
      if (!t) return NONE;
      const steps = t.pulse.steps;
      const ring = t.pulse.prob.slice(0, steps).map((p) => (p > 0.5 ? 1 : 0));
      let best = Infinity;
      for (const hits of g.hits) {
        const target = euclid(hits, g.steps).slice(0, g.steps);
        for (let r = 0; r < g.steps; r++) {
          let d = Math.abs(steps - g.steps);
          for (let i = 0; i < g.steps; i++) d += (ring[i] ?? 0) !== target[(i + r) % g.steps] ? 1 : 0;
          best = Math.min(best, d);
        }
      }
      return { closeness: clamp01(1 - best / g.steps), met: best === 0 };
    }
    case "smooth": {
      let best = 0;
      for (const id of g.toys) {
        const h = obs.toys.get(id)?.holes;
        if (!h) continue;
        const v = Object.values(h);
        if (v.length < 2) continue;
        const d = Math.max(...v.slice(1).map((x, i) => pcDist(x, v[i], n)));
        best = Math.max(best, d <= g.maxSteps ? 1 : clamp01(1 - (d - g.maxSteps) / (n / 2)));
      }
      return { closeness: best, met: best === 1 };
    }
  }
}
