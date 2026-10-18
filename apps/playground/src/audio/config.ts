// ToyConfig: a hypertoy described as data (docs/AUDIO-GEN.md §3). This file
// defines the format and compiles it into the engine's load commands.
//
// Law ids, patch op ids and the patch word layout mirror
// crates/hypertoy-laws (law::*) and crates/hypertoy-dsp/src/patch.rs.

import type { Gesture } from "../toys/toy";
import { MAX_CUSTOM_PARAMS, type Command, type ModuleSpec } from "./protocol";

// ---- the format -----------------------------------------------------------

export interface ConfigParam {
  range: [number, number];
  default: number;
  step?: number;
  unit?: string;
  gesture?: Gesture;
}

/** A Law argument: a constant, a param by name, or `param * mul + add`. */
export type LawArg = number | string | { param: string; mul?: number; add?: number };

export type LawName = keyof typeof LAWS;

export interface ConfigLaw {
  fn: LawName;
  args?: Record<string, LawArg>;
  /** Skip the Tuning snap (microtonal). */
  wild?: boolean;
}

/**
 * A patch input: a constant, a reference, a scaled reference, or a sum of these.
 * References: `$freq`, `$gate`, `$trig`, `$<param>`, `<node>` or `<node>.<port>`.
 */
export type PatchInput = number | string | { ref: string; mul?: number } | PatchInput[];

export interface PatchNode {
  op: OpName;
  args?: number[];
  /** By port name (see OPS) or in port order. */
  in?: Record<string, PatchInput> | PatchInput[];
}

export type ConfigVoice =
  | {
      engine: "patch";
      nodes: Record<string, PatchNode>;
      /** The mono output, or `{ l, r }` for stereo. */
      out: PatchInput | { l: PatchInput; r: PatchInput };
      /** Polyphony: notes round-robin over this many copies (default 1). */
      voices?: number;
      /** Seconds a note holds `$gate` (default 0.15). */
      gate?: number;
    }
  | {
      engine: "zap";
      /** A ZzFX recipe (21 numbers, trailing ones optional). */
      recipe: (number | null)[];
      /** Recipe slot name (ZZFX_SLOTS) ← param name. */
      bind?: Record<string, string>;
    }
  | {
      engine: "module";
      /** Filled in at runtime (e.g. by the Forge): not JSON. */
      module: Omit<ModuleSpec, "binds"> & { binds: Record<string, "freq" | "gate" | "vel" | string> };
    };

export type FormKind = "bowl" | "bottle" | "box" | "pendulum" | "totem";

export interface ToyConfig {
  id: string;
  name: string;
  family: string;
  color: string;
  /** Inline SVG for the chest card. */
  icon?: string;
  params: Record<string, ConfigParam>;
  law: ConfigLaw;
  voice: ConfigVoice;
  pulse?: { pattern?: string; enabled?: boolean; stepsPerBeat?: number; steps?: number };
  form: { kind: FormKind; size?: string; fill?: string; twist?: string };
  /** A variant's edited config (SAVE-LOAD.md §6.1): the root toy it is a variant of. */
  extends?: string;
}

// ---- laws -----------------------------------------------------------------

/** Law ids (hypertoy_laws::law) and their argument names with defaults. */
export const LAWS = {
  fixed: { id: 0, args: { freq: 220 } },
  string: { id: 1, args: { length: 1, tension: 100, density: 0.001, harmonic: 1 } },
  plate: { id: 2, args: { radius: 0.12, thickness: 0.002, stiffness: 1 } },
  helmholtz: { id: 3, args: { volume: 0.75, area: 3.14, neck: 8 } },
  bubble: { id: 4, args: { radius: 2 } },
  pendulum: { id: 5, args: { length: 1, octaves: 9 } },
} as const;

// ---- patch ops ------------------------------------------------------------

/** Op ids (hypertoy_dsp::patch::op), arg counts, input port names and output count. */
export const OPS = {
  sine: { id: 1, args: 0, ins: ["freq"], outs: 1 },
  saw: { id: 2, args: 0, ins: ["freq"], outs: 1 },
  square: { id: 3, args: 0, ins: ["freq"], outs: 1 },
  triangle: { id: 4, args: 0, ins: ["freq"], outs: 1 },
  noise: { id: 5, args: 0, ins: [], outs: 1 },
  pink: { id: 6, args: 0, ins: [], outs: 1 },
  adsr: { id: 7, args: 4, ins: ["gate"], outs: 1 },
  lowpass: { id: 8, args: 0, ins: ["x", "freq", "q"], outs: 1 },
  highpass: { id: 9, args: 0, ins: ["x", "freq", "q"], outs: 1 },
  bandpass: { id: 10, args: 0, ins: ["x", "freq", "q"], outs: 1 },
  resonator: { id: 11, args: 0, ins: ["x", "freq", "bw"], outs: 1 },
  moog: { id: 12, args: 0, ins: ["x", "freq", "q"], outs: 1 },
  pluck: { id: 13, args: 0, ins: ["trig", "freq", "bright"], outs: 1 },
  bell: { id: 14, args: 0, ins: ["trig", "freq", "decay"], outs: 1 },
  bubble: { id: 15, args: 0, ins: ["trig", "freq"], outs: 1 },
  band: { id: 16, args: 0, ins: ["x", "freq", "q"], outs: 1 },
  echo: { id: 17, args: 0, ins: ["x", "time", "feedback"], outs: 1 },
  tanh: { id: 18, args: 1, ins: ["x"], outs: 1 },
  mul: { id: 19, args: 0, ins: ["a", "b"], outs: 1 },
  mix: { id: 20, args: 0, ins: ["x"], outs: 1 },
  pan: { id: 21, args: 0, ins: ["x", "pan"], outs: 2 },
  dcblock: { id: 22, args: 0, ins: ["x"], outs: 1 },
  crush: { id: 23, args: 1, ins: ["x"], outs: 1 },
  follow: { id: 24, args: 1, ins: ["x"], outs: 1 },
} as const;

export type OpName = keyof typeof OPS;

/** Patch inputs (hypertoy_dsp::patch::INPUT_*). */
const INPUTS = { freq: 0, gate: 1, trig: 2 } as const;
const PARAM0 = 3;
const PATCH_PARAMS = 8;
const MAX_NODES = 64;

/** ZzFX recipe slot names, in order (hypertoy_dsp::zap). */
export const ZZFX_SLOTS = [
  "volume", "randomness", "frequency", "attack", "sustain", "release", "shape", "shapeCurve",
  "slide", "deltaSlide", "pitchJump", "pitchJumpTime", "repeatTime", "noise", "modulation",
  "bitCrush", "delay", "sustainVolume", "decay", "tremolo", "filter",
] as const;
export const ZZFX_DEFAULTS = [1, 0.05, 220, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];

export class ConfigError extends Error {}

// ---- compile --------------------------------------------------------------

/** Param names in declaration order: param i is engine param `Param.A + i`. */
export function paramIndex(cfg: ToyConfig): Map<string, number> {
  const names = Object.keys(cfg.params);
  if (names.length > MAX_CUSTOM_PARAMS) throw new ConfigError(`at most ${MAX_CUSTOM_PARAMS} params`);
  return new Map(names.map((n, i) => [n, i]));
}

export function compileLaw(cfg: ToyConfig, slot: number): Command {
  const law = LAWS[cfg.law.fn];
  if (!law) throw new ConfigError(`unknown law "${cfg.law.fn}"`);
  const params = paramIndex(cfg);
  const given = cfg.law.args ?? {};
  for (const k of Object.keys(given)) {
    if (!(k in law.args)) throw new ConfigError(`law ${cfg.law.fn} has no argument "${k}"`);
  }
  const args: number[] = [];
  const defaults = Object.entries(law.args) as [string, number][];
  for (let i = 0; i < 4; i++) {
    const [name, def] = defaults[i] ?? ["", 0];
    const a: LawArg = name ? (given[name] ?? def) : 0;
    if (typeof a === "number") args.push(-1, 0, a);
    else {
      const ref = typeof a === "string" ? { param: a } : a;
      const p = params.get(ref.param);
      if (p === undefined) throw new ConfigError(`law argument ${name}: no param "${ref.param}"`);
      args.push(p, ref.mul ?? 1, ref.add ?? 0);
    }
  }
  return { t: "law", slot, law: law.id, wild: !!cfg.law.wild, args };
}

type Term = [kind: number, a: number, b: number, mul: number];

/** Compile a patch voice to the engine's word layout. */
export function compilePatch(cfg: ToyConfig, slot: number): Command {
  const v = cfg.voice;
  if (v.engine !== "patch") throw new ConfigError("not a patch voice");
  const params = paramIndex(cfg);
  const names = Object.keys(v.nodes);
  if (names.length > MAX_NODES) throw new ConfigError(`at most ${MAX_NODES} nodes`);

  // Dependencies, for a topological order (the engine only allows backward references).
  const refsOf = (x: PatchInput | undefined, out: string[] = []): string[] => {
    if (x === undefined || typeof x === "number") return out;
    if (Array.isArray(x)) x.forEach((y) => refsOf(y, out));
    else {
      const r = typeof x === "string" ? x : x.ref;
      if (!r.startsWith("$")) out.push(r.split(".")[0]);
    }
    return out;
  };
  const portInputs = (name: string): PatchInput[] => {
    const n = v.nodes[name];
    const op = OPS[n.op];
    if (!op) throw new ConfigError(`node ${name}: unknown op "${n.op}"`);
    if (Array.isArray(n.in)) return op.ins.map((_, i) => (n.in as PatchInput[])[i] ?? []);
    const named = n.in ?? {};
    for (const k of Object.keys(named)) {
      if (!(op.ins as readonly string[]).includes(k)) throw new ConfigError(`node ${name}: ${n.op} has no input "${k}"`);
    }
    return op.ins.map((p) => named[p] ?? []);
  };
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, from: string) => {
    if (!(name in v.nodes)) throw new ConfigError(`${from}: no node "${name}"`);
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new ConfigError(`node ${name} feeds back into itself (use an echo node for loops)`);
    state.set(name, "visiting");
    for (const dep of portInputs(name).flatMap((x) => refsOf(x))) visit(dep, `node ${name}`);
    state.set(name, "done");
    order.push(name);
  };
  names.forEach((n) => visit(n, "patch"));
  const index = new Map(order.map((n, i) => [n, i]));

  const terms = (x: PatchInput, where: string, mul = 1, out: Term[] = []): Term[] => {
    if (typeof x === "number") out.push([0, x * mul, 0, 1]);
    else if (Array.isArray(x)) x.forEach((y) => terms(y, where, mul, out));
    else {
      const ref = typeof x === "string" ? x : x.ref;
      const m = mul * (typeof x === "string" ? 1 : (x.mul ?? 1));
      if (ref.startsWith("$")) {
        const name = ref.slice(1);
        const fixed = INPUTS[name as keyof typeof INPUTS];
        const p = params.get(name);
        if (fixed !== undefined) out.push([1, fixed, 0, m]);
        else if (p !== undefined && p < PATCH_PARAMS) out.push([1, PARAM0 + p, 0, m]);
        else throw new ConfigError(`${where}: "${ref}" is not $freq, $gate, $trig or one of the first ${PATCH_PARAMS} params`);
      } else {
        const [node, portStr] = ref.split(".");
        const port = portStr === undefined ? 0 : portStr === "l" ? 0 : portStr === "r" ? 1 : Number(portStr);
        const i = index.get(node);
        if (i === undefined) throw new ConfigError(`${where}: no node "${node}"`);
        if (!(port >= 0 && port < OPS[v.nodes[node].op].outs)) throw new ConfigError(`${where}: ${node} has no output ${portStr}`);
        out.push([2, i, port, m]);
      }
    }
    if (out.length > 16) throw new ConfigError(`${where}: at most 16 terms`);
    return out;
  };
  const emit = (w: number[], ts: Term[]) => {
    w.push(ts.length);
    for (const t of ts) w.push(...t);
  };

  const outs = typeof v.out === "object" && !Array.isArray(v.out) && "l" in v.out ? [v.out.l, v.out.r] : [v.out as PatchInput];
  const words: number[] = [1, outs.length, order.length];
  for (const name of order) {
    const n = v.nodes[name];
    const op = OPS[n.op];
    const args = n.args ?? [];
    if (args.length !== op.args) throw new ConfigError(`node ${name}: ${n.op} takes ${op.args} args`);
    words.push(op.id, args.length, ...args);
    portInputs(name).forEach((x, i) => emit(words, terms(x, `node ${name}.${op.ins[i]}`)));
  }
  outs.forEach((o, i) => emit(words, terms(o, `out ${i}`)));
  return { t: "patch", slot, words, voices: Math.max(1, Math.min(8, v.voices ?? 1)), gate: v.gate ?? 0.15 };
}

export function compileZap(cfg: ToyConfig, slot: number): Command {
  const v = cfg.voice;
  if (v.engine !== "zap") throw new ConfigError("not a zap voice");
  const params = paramIndex(cfg);
  const words = ZZFX_DEFAULTS.map((d, i) => v.recipe[i] ?? d);
  for (const [slotName, param] of Object.entries(v.bind ?? {})) {
    const s = (ZZFX_SLOTS as readonly string[]).indexOf(slotName);
    const p = params.get(param);
    if (s < 0) throw new ConfigError(`zap: no recipe slot "${slotName}"`);
    if (p === undefined) throw new ConfigError(`zap: no param "${param}"`);
    words.push(s, p);
  }
  return { t: "zap", slot, words };
}

export function compileModule(cfg: ToyConfig, slot: number): Command {
  const v = cfg.voice;
  if (v.engine !== "module") throw new ConfigError("not a module voice");
  const params = paramIndex(cfg);
  const binds: ModuleSpec["binds"] = {};
  for (const [input, what] of Object.entries(v.module.binds)) {
    if (what === "freq" || what === "gate" || what === "vel") binds[input] = what;
    else {
      const p = params.get(what);
      if (p === undefined) throw new ConfigError(`module input ${input}: no param "${what}"`);
      binds[input] = p;
    }
  }
  return { t: "external", slot, module: { ...v.module, binds } };
}

/** Every command that loads a config's Law and Voice into `slot` (after `add`). */
export function compileVoice(cfg: ToyConfig, slot: number): Command[] {
  const law = compileLaw(cfg, slot);
  const v = cfg.voice.engine;
  const voice = v === "patch" ? compilePatch(cfg, slot) : v === "zap" ? compileZap(cfg, slot) : compileModule(cfg, slot);
  return [law, voice];
}

/** Check a config without loading it; returns the first problem or null. */
export function validate(cfg: ToyConfig): string | null {
  try {
    for (const [name, p] of Object.entries(cfg.params)) {
      if (!(p.range[0] < p.range[1]) || p.default < p.range[0] || p.default > p.range[1]) {
        throw new ConfigError(`param ${name}: default outside its range`);
      }
    }
    compileVoice(cfg, 0);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
