// Mirrors crates/hypertoy-wasm/src/engine.rs. Change both together.

export const Kind = { None: 0, Spire: 1, Orrery: 2, Kettle: 3 } as const;
export type KindId = typeof Kind.Spire | typeof Kind.Orrery | typeof Kind.Kettle;

export const Param = {
  Pan: 0,
  Gain: 1,
  PulseOn: 2,
  StepsPerBeat: 3,
  Steps: 4,
  Speed: 5,
  A: 8,
  B: 9,
  C: 10,
  D: 11,
} as const;

export const MAX_TOYS = 16;
export const MAX_STEPS = 16;
export const PLANETS = 4;
export const SNAP_HEADER = 8;
export const SNAP_STRIDE = 24;
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

export type Command =
  | { t: "tempo"; bpm: number }
  | { t: "tuning"; root: number; scale: number; wild: boolean }
  | { t: "master"; gain: number }
  | { t: "add"; slot: number; kind: number }
  | { t: "remove"; slot: number }
  | { t: "param"; slot: number; p: number; v: number }
  | { t: "step"; slot: number; step: number; prob: number }
  | { t: "poke"; slot: number; strength: number; aux: number };

export type ToWorklet = Command | { t: "wasm"; bytes: ArrayBuffer };
export type FromWorklet = { t: "ready" } | { t: "snap"; data: Float32Array } | { t: "error"; message: string };

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
  toy_add(e: number, slot: number, kind: number): void;
  toy_remove(e: number, slot: number): void;
  toy_set_param(e: number, slot: number, p: number, v: number): void;
  toy_set_step(e: number, slot: number, step: number, prob: number): void;
  toy_poke(e: number, slot: number, strength: number, aux: number): void;
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
