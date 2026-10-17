// Voice Module host. Runs inside the AudioWorklet, next to the engine: each
// external voice is its own WebAssembly instance (own memory, imports limited
// to Math), rendered here and written into the engine's per-slot external
// buffer, so the engine still mixes, pans, sends to reverb and limits it.
//
// Engine events from block N (notes, param changes, with sample offsets) are
// applied in block N+1 at the same offsets: one block (~2.7 ms) of latency,
// exact relative timing. See docs/VMA.md for the ABI.

import { BLOCK, EVENT_STRIDE, EventKind, MODULE_LOAD_LIMIT as LOAD_LIMIT, Param } from "./abi";
import type { ModuleCost, ModuleSpec } from "./protocol";

/** One instantiated module, behind a common interface. */
interface Module {
  ins: Float32Array[];
  outs: Float32Array[];
  /** Input index by name (Faust labels/shortnames) or id string (VMA). */
  inputs: Map<string, number>;
  set(input: number, value: number): void;
  /** Render `frames` (≤ BLOCK) from `ins` into `outs`, both from index 0. */
  process(frames: number): void;
}

const MAX_OUT = 2;
const MAX_IN = 2;

/** Math imports for Faust's wasm (`env._sinf` and friends), built from what the module asks for. */
function mathImports(mod: WebAssembly.Module): WebAssembly.Imports {
  const special: Record<string, (...a: number[]) => number> = {
    fmod: (a, b) => a % b,
    remainder: (a, b) => a - Math.round(a / b) * b,
    exp10: (a) => 10 ** a,
    rint: (a) => Math.round(a),
    abs: (a) => Math.abs(a),
  };
  const env: Record<string, (...a: number[]) => number> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind !== "function") continue;
    const base = imp.name.replace(/^_+/, "").replace(/f$/, "");
    const m = Math as unknown as Record<string, (...a: number[]) => number>;
    const fn = special[base] ?? m[base];
    if (!fn) throw new Error(`module needs unknown import ${imp.module}.${imp.name}`);
    env[imp.name] = fn;
  }
  return { env };
}

interface FaustItem {
  type: string;
  label?: string;
  shortname?: string;
  address?: string;
  index?: number;
  init?: number;
  items?: FaustItem[];
}

function faustModule(bytes: ArrayBuffer, json: string, sr: number): Module {
  const meta = JSON.parse(json) as { size: number; inputs: number; outputs: number; ui: FaustItem[] };
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, mathImports(mod));
  const x = inst.exports as unknown as {
    memory: WebAssembly.Memory;
    init(dsp: number, sr: number): void;
    compute(dsp: number, count: number, ins: number, outs: number): void;
    setParamValue(dsp: number, index: number, v: number): void;
  };
  const nIn = Math.min(meta.inputs, MAX_IN);
  const nOut = Math.min(meta.outputs, MAX_OUT);
  if (meta.outputs < 1) throw new Error("Faust module has no outputs");
  // Layout after the DSP struct: input/output pointer arrays, then channel buffers.
  const align = (n: number) => (n + 15) & ~15;
  const ptrs = align(meta.size);
  const bufs = align(ptrs + 4 * (meta.inputs + meta.outputs));
  const need = bufs + 4 * BLOCK * (meta.inputs + meta.outputs);
  const grow = Math.ceil((need - x.memory.buffer.byteLength) / 65536);
  if (grow > 0) x.memory.grow(grow);
  const heap32 = new Int32Array(x.memory.buffer);
  const chans = meta.inputs + meta.outputs;
  for (let c = 0; c < chans; c++) heap32[ptrs / 4 + c] = bufs + 4 * BLOCK * c;
  const view = (c: number) => new Float32Array(x.memory.buffer, bufs + 4 * BLOCK * c, BLOCK);
  const ins = Array.from({ length: meta.inputs }, (_, c) => view(c));
  const outs = Array.from({ length: meta.outputs }, (_, c) => view(meta.inputs + c));
  x.init(0, sr);

  const inputs = new Map<string, number>();
  const walk = (items: FaustItem[]) => {
    for (const it of items) {
      if (it.items) walk(it.items);
      if (it.index === undefined) continue;
      for (const key of [it.shortname, it.label, it.address]) if (key) inputs.set(key, it.index);
    }
  };
  walk(meta.ui);
  return {
    ins: ins.slice(0, nIn),
    outs: outs.slice(0, nOut),
    inputs,
    set: (i, v) => x.setParamValue(0, i, v),
    process: (n) => x.compute(0, n, ptrs, ptrs + 4 * meta.inputs),
  };
}

function vmaModule(bytes: ArrayBuffer, sr: number): Module {
  const mod = new WebAssembly.Module(bytes);
  const inst = new WebAssembly.Instance(mod, mathImports(mod));
  const x = inst.exports as unknown as {
    memory: WebAssembly.Memory;
    vma_new(sr: number): number;
    vma_inputs(h: number): number;
    vma_audio_ins(h: number): number;
    vma_audio_outs(h: number): number;
    vma_in_ptr(h: number, ch: number): number;
    vma_out_ptr(h: number, ch: number): number;
    vma_set(h: number, id: number, v: number): void;
    vma_process(h: number, frames: number): void;
  };
  const h = x.vma_new(sr);
  const nIn = Math.min(x.vma_audio_ins(h), MAX_IN);
  const nOut = Math.min(x.vma_audio_outs(h), MAX_OUT);
  if (nOut < 1) throw new Error("VMA module has no outputs");
  // Views are made after vma_new, which is the only place a module may allocate.
  const mem = x.memory.buffer;
  const inputs = new Map<string, number>();
  for (let i = 0; i < x.vma_inputs(h); i++) inputs.set(String(i), i);
  return {
    ins: Array.from({ length: nIn }, (_, c) => new Float32Array(mem, x.vma_in_ptr(h, c), BLOCK)),
    outs: Array.from({ length: nOut }, (_, c) => new Float32Array(mem, x.vma_out_ptr(h, c), BLOCK)),
    inputs,
    set: (i, v) => x.vma_set(h, i, v),
    process: (n) => x.vma_process(h, n),
  };
}

interface Pending {
  frame: number;
  kind: number;
  a: number;
  b: number;
}

/** One external voice: a module plus its bindings and pending events. */
class Hosted {
  private freq = -1;
  private gate = -1;
  private vel = -1;
  private params = new Map<number, number>();
  private gateFrames: number;
  private gateLeft = 0;
  private pending: Pending[] = [];
  private next: Pending[] = [];
  private muted = false;
  private restrike = false;

  constructor(
    readonly mod: Module,
    spec: ModuleSpec,
    sr: number,
  ) {
    this.gateFrames = Math.max(1, Math.round(spec.gate * sr));
    for (const [name, what] of Object.entries(spec.binds)) {
      const i = mod.inputs.get(name);
      if (i === undefined) continue;
      if (what === "freq") this.freq = i;
      else if (what === "gate") this.gate = i;
      else if (what === "vel") this.vel = i;
      else this.params.set(Param.A + what, i);
    }
    this.input = spec.input;
  }

  input: number | "mic" | undefined;

  push(e: Pending) {
    this.next.push(e);
  }

  private apply(e: Pending) {
    if (e.kind === EventKind.Note) {
      if (this.freq >= 0) this.mod.set(this.freq, e.b);
      if (this.vel >= 0) this.mod.set(this.vel, e.a);
      if (this.gate >= 0) {
        if (this.gateLeft > 0) {
          // Re-strike while held: one sample of gate-off first, so envelopes retrigger.
          this.mod.set(this.gate, 0);
          this.restrike = true;
        } else {
          this.mod.set(this.gate, 1);
        }
        this.gateLeft = this.gateFrames;
      }
    } else if (e.kind === EventKind.Param) {
      const i = this.params.get(e.a);
      if (i !== undefined) this.mod.set(i, e.b);
    }
  }

  /** Render one block into (l, r), applying last block's events at their frames. */
  render(l: Float32Array, r: Float32Array, inL: Float32Array | null, inR: Float32Array | null) {
    [this.pending, this.next] = [this.next, this.pending];
    this.next.length = 0;
    if (this.muted) {
      l.fill(0);
      r.fill(0);
      return;
    }
    const events = this.pending.sort((a, b) => a.frame - b.frame);
    let ei = 0;
    let at = 0;
    const { ins, outs } = this.mod;
    while (at < BLOCK) {
      while (ei < events.length && events[ei].frame <= at) this.apply(events[ei++]);
      let end = ei < events.length ? Math.min(BLOCK, events[ei].frame) : BLOCK;
      if (this.gateLeft > 0) end = Math.min(end, at + this.gateLeft);
      if (this.restrike) end = at + 1;
      const n = end - at;
      if (inL) {
        ins[0]?.set(inL.subarray(at, end));
        ins[1]?.set((inR ?? inL).subarray(at, end));
      }
      this.mod.process(n);
      const o0 = outs[0].subarray(0, n);
      const o1 = (outs[1] ?? outs[0]).subarray(0, n);
      l.set(o0, at);
      r.set(o1, at);
      if (this.restrike) {
        this.restrike = false;
        this.mod.set(this.gate, 1);
      } else if (this.gateLeft > 0) {
        this.gateLeft -= n;
        if (this.gateLeft <= 0 && this.gate >= 0) this.mod.set(this.gate, 0);
      }
      at = end;
    }
    // A module that goes non-finite is muted and reported, never crashes the world.
    for (let i = 0; i < BLOCK; i++) {
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) {
        this.muted = true;
        l.fill(0);
        r.fill(0);
        throw new Error("module produced non-finite audio; muted");
      }
    }
  }
}

function instantiate(spec: ModuleSpec, sr: number): Module {
  return spec.abi === "faust" ? faustModule(spec.bytes, spec.json ?? "{}", sr) : vmaModule(spec.bytes, sr);
}

/**
 * Render a module offline for `seconds` (notes every ~0.17 s, noise on its
 * audio inputs) through the same adapter and segmenting the worklet uses, and
 * time it. Throws if the module fails to load or produces non-finite audio.
 * Run it in a Worker: it blocks for as long as the rendering takes.
 */
export function measureModule(spec: ModuleSpec, sr: number, seconds = 10): ModuleCost {
  const h = new Hosted(instantiate(spec, sr), { ...spec, cost: undefined }, sr);
  const blocks = Math.ceil((seconds * sr) / BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  const noise = Float32Array.from({ length: BLOCK }, (_, i) => Math.sin(i * 12.9898) * 0.5);
  let peak = 0;
  // Warm up (JIT tiers, first-touch memory) before timing.
  for (let b = 0; b < 32; b++) h.render(l, r, noise, noise);
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    if (b % 64 === 0) h.push({ frame: b % BLOCK, kind: EventKind.Note, a: 0.8, b: 110 * (1 + (b % 7)) });
    h.render(l, r, noise, noise);
    for (let i = 0; i < BLOCK; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  }
  const usPerBlock = ((performance.now() - t0) * 1000) / blocks;
  return { usPerBlock, load: usPerBlock / ((BLOCK / sr) * 1e6), peak };
}

export class VmaHost {
  private slots = new Map<number, Hosted>();

  constructor(private sr: number) {}

  load(slot: number, spec: ModuleSpec) {
    if (spec.cost && spec.cost.load > LOAD_LIMIT) {
      throw new Error(`module needs ${Math.round(spec.cost.load * 100)}% of the audio budget (limit ${LOAD_LIMIT * 100}%)`);
    }
    this.slots.set(slot, new Hosted(instantiate(spec, this.sr), spec, this.sr));
  }

  remove(slot: number) {
    this.slots.delete(slot);
  }

  get size() {
    return this.slots.size;
  }

  /** Queue this block's engine events for the slots that host modules. */
  takeEvents(events: Float32Array, count: number) {
    for (let i = 0; i < count; i++) {
      const o = i * EVENT_STRIDE;
      const h = this.slots.get(events[o]);
      h?.push({ frame: events[o + 1], kind: events[o + 2], a: events[o + 3], b: events[o + 4] });
    }
  }

  /**
   * Render every hosted slot into the engine's external buffer. `bus(slot)`
   * gives another toy's last block; `mic` is the worklet's live input.
   */
  render(ext: Float32Array, bus: (slot: number) => Float32Array, mic: Float32Array[] | null, onError: (slot: number, e: unknown) => void) {
    for (const [slot, h] of this.slots) {
      const o = slot * BLOCK * 2;
      let inL: Float32Array | null = null;
      let inR: Float32Array | null = null;
      if (h.input === "mic" && mic?.length) {
        inL = mic[0];
        inR = mic[1] ?? mic[0];
      } else if (typeof h.input === "number") {
        inL = bus(h.input);
      }
      try {
        h.render(ext.subarray(o, o + BLOCK), ext.subarray(o + BLOCK, o + 2 * BLOCK), inL, inR);
      } catch (e) {
        onError(slot, e);
      }
    }
  }
}
