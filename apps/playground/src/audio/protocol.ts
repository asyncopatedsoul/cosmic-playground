// Mirrors crates/hypertoy-wasm/src/engine.rs. Change both together.

export const Kind = { None: 0, Spire: 1, Orrery: 2, Kettle: 3, Custom: 4 } as const;
export type KindId = typeof Kind.Spire | typeof Kind.Orrery | typeof Kind.Kettle | typeof Kind.Custom;

export { BLOCK, EVENT_STRIDE, EventKind, MAX_TOYS, MODULE_LOAD_LIMIT, MODULE_LOAD_WARN, Param } from "./abi";
import { Param } from "./abi";
export const MAX_STEPS = 16;
/** Params per slot; custom toys get `Param.A + i` for their i-th param. */
export const PARAMS = 32;
export const MAX_CUSTOM_PARAMS = PARAMS - Param.A;
export const PLANETS = 4;
export const SNAP_HEADER = 8;
export const SNAP_STRIDE = 24;
/** `tuning` with this scale id keeps the custom table set by `tuningTable` / `scl`. */
export const SCALE_CUSTOM = 99;
/** Side of the Kettle's reaction-diffusion grid. */
export const FIELD_SIZE = 128;

/** Offsets inside one slot of the engine snapshot. */
export const Snap = {
  kind: 0,
  env: 1,
  freq: 2,
  step: 3,
  flash: 4,
  pulseOn: 5,
  planetAngle: 6,
  planetFlash: 10,
  planetPeriod: 14,
} as const;


/** A Voice Module (VMA) for an external voice: see docs/VMA.md. */
export interface ModuleSpec {
  /** "vma": a module exporting the VMA ABI. "faust": a faustwasm (wasm-i) module plus its JSON. */
  abi: "vma" | "faust";
  bytes: ArrayBuffer;
  /** Faust's UI JSON (abi "faust"). */
  json?: string;
  /** Module input (by name, or VMA input id as a string) ← "freq" | "gate" | "vel" | a toy param index. */
  binds: Record<string, "freq" | "gate" | "vel" | number>;
  /** Seconds a note holds the gate. */
  gate: number;
  /** Audio fed to the module's inputs: another toy's slot, "mic", or nothing. */
  input?: number | "mic";
  /** Measured by the Forge before loading (audio/vma.ts `measureModule`). */
  cost?: ModuleCost;
}

/** What a module costs, from rendering it offline with notes and noise input. */
export interface ModuleCost {
  /** Mean microseconds to render one 128-frame block on the measuring machine. */
  usPerBlock: number;
  /** Fraction of real time one block takes (1 = the whole audio budget). */
  load: number;
  /** Loudest sample seen. */
  peak: number;
}


export type Command =
  | { t: "tempo"; bpm: number }
  | { t: "tuning"; root: number; scale: number; wild: boolean }
  | { t: "tuningTable"; period: number; cents: number[] }
  | { t: "scl"; text: string }
  | { t: "master"; gain: number }
  | { t: "add"; slot: number; kind: number }
  | { t: "remove"; slot: number }
  | { t: "wild"; slot: number; wild: boolean }
  | { t: "param"; slot: number; p: number; v: number }
  | { t: "step"; slot: number; step: number; prob: number }
  | { t: "poke"; slot: number; strength: number; aux: number }
  | { t: "pattern"; slot: number; text: string }
  | { t: "law"; slot: number; law: number; wild: boolean; args: number[] }
  | { t: "patch"; slot: number; words: number[]; voices: number; gate: number }
  | { t: "zap"; slot: number; words: number[] }
  | { t: "external"; slot: number; module: ModuleSpec };

export type ToWorklet = Command | { t: "wasm"; bytes: ArrayBuffer };
export type FromWorklet =
  | { t: "ready" }
  | { t: "snap"; data: Float32Array }
  | { t: "error"; message: string }
  /** A load command failed: `code` is the engine's LoadError code. */
  | { t: "loadError"; slot: number; what: string; code: number; detail?: string };

/** The engine's C-ABI exports (see crates/hypertoy-wasm/src/lib.rs). */
export interface EngineExports {
  memory: WebAssembly.Memory;
  engine_new(sampleRate: number): number;
  engine_out_ptr(e: number): number;
  engine_snap_ptr(e: number): number;
  engine_snap_len(): number;
  engine_process(e: number, frames: number): void;
  engine_set_tempo(e: number, bpm: number): void;
  engine_set_tuning(e: number, root: number, scale: number, wild: number): void;
  engine_set_master(e: number, gain: number): void;
  engine_scratch_ptr(e: number): number;
  engine_scratch_len(): number;
  engine_ext_ptr(e: number): number;
  engine_bus_ptr(e: number): number;
  engine_events_ptr(e: number): number;
  engine_events_len(e: number): number;
  engine_events_clear(e: number): void;
  engine_set_tuning_table(e: number, len: number): number;
  engine_set_tuning_scl(e: number, len: number): number;
  toy_add(e: number, slot: number, kind: number): void;
  toy_remove(e: number, slot: number): void;
  toy_set_param(e: number, slot: number, p: number, v: number): void;
  toy_set_step(e: number, slot: number, step: number, prob: number): void;
  toy_poke(e: number, slot: number, strength: number, aux: number): void;
  toy_set_wild(e: number, slot: number, wild: number): void;
  toy_set_pattern(e: number, slot: number, len: number): number;
  toy_set_law(e: number, slot: number, law: number, wild: number): number;
  toy_load_patch(e: number, slot: number, len: number, voices: number, gate: number): number;
  toy_load_zap(e: number, slot: number, len: number): number;
  toy_load_external(e: number, slot: number): number;
}

/** Human-readable text for a LoadError code (engine::LoadError::code). */
export function describeLoadError(code: number): string {
  if (code <= -1000) return `pattern error at character ${-1000 - code + 1}`;
  if (code <= -100) return `patch error near word ${-100 - code}`;
  return { [-1]: "no such slot", [-2]: "not a custom toy", [-3]: "too long", [-4]: "bad tuning table" }[code] ?? `error ${code}`;
}

export interface FieldExports {
  memory: WebAssembly.Memory;
  gs_new(w: number, h: number, seed: number): number;
  gs_free(f: number): void;
  gs_step(f: number, iterations: number): void;
  gs_drop(f: number, x: number, y: number, r: number): void;
  gs_set_reagent(f: number, x: number): void;
  gs_view_ptr(f: number): number;
  gs_coverage(f: number): number;
  gs_activity(f: number): number;
}

/** Fetch the engine binary. The header stops ngrok's free-plan warning page replacing it. */
export const fetchWasm = () =>
  fetch(wasmUrl(), { headers: { "ngrok-skip-browser-warning": "1" } }).then((r) => {
    if (!r.ok) throw new Error(`hypertoy.wasm: HTTP ${r.status}`);
    return r.arrayBuffer();
  });

export const wasmUrl = () => new URL(`${import.meta.env.BASE_URL}hypertoy.wasm`, location.href).href;
