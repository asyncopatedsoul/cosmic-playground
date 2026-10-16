// AudioWorklet: hosts the Rust engine. Every 128-frame quantum it applies
// queued commands, renders one block in WASM, and every few blocks posts a
// snapshot of toy state back so the visuals follow the audio clock.

import type { Command, EngineExports, ToWorklet } from "./protocol";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const BLOCK = 128;
const SNAP_EVERY = 3;

class HypertoyProcessor extends AudioWorkletProcessor {
  private x: EngineExports | null = null;
  private e = 0;
  private out: Float32Array | null = null;
  private snap: Float32Array | null = null;
  private queue: Command[] = [];
  private blocks = 0;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToWorklet>) => {
      const m = ev.data;
      if (m.t === "wasm") void this.init(m.bytes);
      else this.queue.push(m);
    };
  }

  private async init(bytes: ArrayBuffer) {
    try {
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const x = instance.exports as unknown as EngineExports;
      this.e = x.engine_new(sampleRate);
      this.x = x;
      this.views();
      this.port.postMessage({ t: "ready" });
    } catch (err) {
      this.port.postMessage({ t: "error", message: String(err) });
    }
  }

  /** (Re)create views into WASM memory; needed again if memory ever grows. */
  private views() {
    const x = this.x!;
    const buf = x.memory.buffer;
    this.out = new Float32Array(buf, x.engine_out_ptr(this.e), BLOCK * 2);
    this.snap = new Float32Array(buf, x.engine_snap_ptr(this.e), x.engine_snap_len());
  }

  private apply(c: Command) {
    const x = this.x!;
    const e = this.e;
    switch (c.t) {
      case "tempo": return x.engine_set_tempo(e, c.bpm);
      case "tuning": return x.engine_set_tuning(e, c.root, c.scale, c.wild ? 1 : 0);
      case "master": return x.engine_set_master(e, c.gain);
      case "add": return x.toy_add(e, c.slot, c.kind);
      case "remove": return x.toy_remove(e, c.slot);
      case "param": return x.toy_set_param(e, c.slot, c.p, c.v);
      case "step": return x.toy_set_step(e, c.slot, c.step, c.prob);
      case "poke": return x.toy_poke(e, c.slot, c.strength, c.aux);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const x = this.x;
    if (!x) return true;
    for (const c of this.queue) this.apply(c);
    this.queue.length = 0;

    x.engine_process(this.e, BLOCK);
    if (this.out!.buffer !== x.memory.buffer) this.views();

    const [l, r] = outputs[0];
    l.set(this.out!.subarray(0, BLOCK));
    r?.set(this.out!.subarray(BLOCK, BLOCK * 2));

    if (++this.blocks % SNAP_EVERY === 0) {
      const data = this.snap!.slice();
      this.port.postMessage({ t: "snap", data }, [data.buffer]);
    }
    return true;
  }
}

registerProcessor("hypertoy", HypertoyProcessor);
