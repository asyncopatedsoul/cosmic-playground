// Engine constants shared with the AudioWorklet. Kept free of imports (and of
// `import.meta.env`) so the worklet bundle pulls in nothing that needs a
// window. Mirrors crates/hypertoy-wasm/src/engine.rs.

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
export const BLOCK = 128;

/** Per-block engine events: `[slot, frame, kind, a, b]`. */
export const EVENT_STRIDE = 5;
export const EventKind = { Note: 1, Param: 2 } as const;

/** Above this measured load (fraction of real time) the worklet refuses a module. */
export const MODULE_LOAD_LIMIT = 0.5;
/** Above this the Forge warns: the module may glitch on phones and the Quest. */
export const MODULE_LOAD_WARN = 0.15;
