// AudioWorklet: hosts the Rust engine. Every 128-frame quantum it applies
// queued commands, renders external voice modules (VMA), renders one block in
// WASM, and every few blocks posts a snapshot of toy state back so the visuals
// follow the audio clock.

import { BLOCK, EVENT_STRIDE, EventKind, MAX_TOYS, NOTE_STRIDE } from "./abi";
import type { Command, EngineExports, FromWorklet, ToWorklet } from "./protocol";
import { VmaHost } from "./vma";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const SNAP_EVERY = 3;
/** Notes held for one snapshot at most; more are dropped (a runaway pattern). */
const MAX_NOTES = 512;

/** UTF-8 bytes of `s` (AudioWorkletGlobalScope has no TextEncoder). */
function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

class HypertoyProcessor extends AudioWorkletProcessor {
  private x: EngineExports | null = null;
  private e = 0;
  private out: Float32Array | null = null;
  private snap: Float32Array | null = null;
  private queue: Command[] = [];
  private blocks = 0;
  private vma = new VmaHost(sampleRate);
  /** Slots that forward every note, and the notes waiting for the next snapshot. */
  private noteSlots = new Set<number>();
  private notes: number[] = [];

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToWorklet>) => {
      const m = ev.data;
      if (m.t === "wasm") void this.init(m.bytes);
      else this.queue.push(m);
    };
  }

  private post(m: FromWorklet, transfer: Transferable[] = []) {
    this.port.postMessage(m, transfer);
  }

  private async init(bytes: ArrayBuffer) {
    try {
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const x = instance.exports as unknown as EngineExports;
      this.e = x.engine_new(sampleRate);
      this.x = x;
      this.views();
      this.post({ t: "ready" });
    } catch (err) {
      this.post({ t: "error", message: String(err) });
    }
  }

  /** (Re)create views into WASM memory; needed again if memory ever grows. */
  private views() {
    const x = this.x!;
    const buf = x.memory.buffer;
    this.out = new Float32Array(buf, x.engine_out_ptr(this.e), BLOCK * 2);
    this.snap = new Float32Array(buf, x.engine_snap_ptr(this.e), x.engine_snap_len());
  }

  private f32(ptr: number, len: number) {
    return new Float32Array(this.x!.memory.buffer, ptr, len);
  }

  /** Copy numbers into the engine's scratch buffer; returns the word count. */
  private words(w: ArrayLike<number>): number {
    const x = this.x!;
    const n = Math.min(w.length, x.engine_scratch_len());
    this.f32(x.engine_scratch_ptr(this.e), n).set(Array.from(w).slice(0, n));
    return w.length > n ? n + 1 : n; // one past the end makes the engine report "too long"
  }

  /** Copy UTF-8 text into scratch; returns the byte count. */
  private text(s: string): number {
    const x = this.x!;
    const bytes = utf8(s);
    const cap = x.engine_scratch_len() * 4;
    new Uint8Array(x.memory.buffer, x.engine_scratch_ptr(this.e), Math.min(bytes.length, cap)).set(bytes.subarray(0, cap));
    return bytes.length;
  }

  private check(slot: number, what: string, code: number, detail?: string) {
    if (code !== 0) this.post({ t: "loadError", slot, what, code, detail });
  }

  private apply(c: Command) {
    const x = this.x!;
    const e = this.e;
    switch (c.t) {
      case "tempo": return x.engine_set_tempo(e, c.bpm);
      case "tuning": return x.engine_set_tuning(e, c.root, c.scale, c.wild ? 1 : 0);
      case "tuningTable": return this.check(-1, "tuning", x.engine_set_tuning_table(e, this.words([c.period, ...c.cents])));
      case "scl": return this.check(-1, "scl", x.engine_set_tuning_scl(e, this.text(c.text)));
      case "master": return x.engine_set_master(e, c.gain);
      case "add":
        this.vma.remove(c.slot);
        // A new toy starts unsubscribed (the engine resets the slot); the host re-asks.
        this.noteSlots.delete(c.slot);
        return x.toy_add(e, c.slot, c.kind);
      case "remove":
        this.vma.remove(c.slot);
        return x.toy_remove(e, c.slot);
      case "param": return x.toy_set_param(e, c.slot, c.p, c.v);
      case "step": return x.toy_set_step(e, c.slot, c.step, c.prob);
      case "poke": return x.toy_poke(e, c.slot, c.strength, c.aux);
      case "wild": return x.toy_set_wild(e, c.slot, c.wild ? 1 : 0);
      case "notes": {
        const next = new Set(c.slots.filter((s) => s >= 0 && s < MAX_TOYS));
        for (const s of this.noteSlots) if (!next.has(s)) x.toy_set_report_notes(e, s, 0);
        for (const s of next) if (!this.noteSlots.has(s)) x.toy_set_report_notes(e, s, 1);
        this.noteSlots = next;
        if (!next.size) this.notes.length = 0;
        return;
      }
      case "pattern": return this.check(c.slot, "pattern", x.toy_set_pattern(e, c.slot, this.text(c.text)), c.text);
      case "law":
        this.words(c.args);
        return this.check(c.slot, "law", x.toy_set_law(e, c.slot, c.law, c.wild ? 1 : 0));
      case "patch":
        return this.check(c.slot, "patch", x.toy_load_patch(e, c.slot, this.words(c.words), c.voices, c.gate));
      case "zap": return this.check(c.slot, "zap", x.toy_load_zap(e, c.slot, this.words(c.words)));
      case "external":
        try {
          this.vma.load(c.slot, c.module);
          this.check(c.slot, "external", x.toy_load_external(e, c.slot));
        } catch (err) {
          this.post({ t: "loadError", slot: c.slot, what: "external", code: -5, detail: String(err) });
        }
        return;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    try {
      return this.render(inputs, outputs);
    } catch (err) {
      // Report once, then go quiet rather than die silently.
      this.post({ t: "error", message: `process: ${err instanceof Error ? err.stack ?? err.message : String(err)}` });
      this.x = null;
      return true;
    }
  }

  private render(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const x = this.x;
    if (!x) return true;
    for (const c of this.queue) this.apply(c);
    this.queue.length = 0;

    if (this.vma.size) {
      const ext = this.f32(x.engine_ext_ptr(this.e), MAX_TOYS * BLOCK * 2);
      const bus = this.f32(x.engine_bus_ptr(this.e), MAX_TOYS * BLOCK);
      this.vma.render(
        ext,
        (slot) => bus.subarray(slot * BLOCK, (slot + 1) * BLOCK),
        inputs[0]?.length ? inputs[0] : null,
        (slot, err) => this.post({ t: "loadError", slot, what: "external", code: -6, detail: String(err) }),
      );
    }

    x.engine_process(this.e, BLOCK);
    if (this.out!.buffer !== x.memory.buffer) this.views();

    const n = x.engine_events_len(this.e);
    if (n) {
      const events = this.f32(x.engine_events_ptr(this.e), n * EVENT_STRIDE);
      if (this.vma.size) this.vma.takeEvents(events, n);
      if (this.noteSlots.size) this.takeNotes(events, n);
      x.engine_events_clear(this.e);
    }

    const [l, r] = outputs[0];
    l.set(this.out!.subarray(0, BLOCK));
    r?.set(this.out!.subarray(BLOCK, BLOCK * 2));

    if (++this.blocks % SNAP_EVERY === 0) {
      const data = this.snap!.slice();
      if (this.notes.length) {
        const notes = Float32Array.from(this.notes);
        this.notes.length = 0;
        this.post({ t: "snap", data, notes }, [data.buffer, notes.buffer]);
      } else this.post({ t: "snap", data }, [data.buffer]);
    }
    return true;
  }

  /** Beat-stamp this block's notes from subscribed slots (sample-exact: block start + frame). */
  private takeNotes(events: Float32Array, n: number) {
    const snap = this.snap!;
    const dbeat = snap[1] / 60 / sampleRate;
    const start = snap[0] - BLOCK * dbeat; // the snapshot's beat is the end of the block
    for (let i = 0; i < n; i++) {
      const o = i * EVENT_STRIDE;
      const slot = events[o];
      if (events[o + 2] !== EventKind.Note || !this.noteSlots.has(slot)) continue;
      if (this.notes.length >= MAX_NOTES * NOTE_STRIDE) return;
      this.notes.push(slot, start + events[o + 1] * dbeat, events[o + 4], events[o + 3]);
    }
  }
}

registerProcessor("hypertoy", HypertoyProcessor);
