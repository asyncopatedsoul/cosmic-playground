// Reaction-diffusion Worker: steps each Kettle's Gray-Scott field in WASM
// and posts the V channel (as bytes) plus coverage/activity metrics.

import { FIELD_SIZE, type FieldExports } from "./protocol";

const ITERATIONS = 10;
const FRAME_MS = 33;

export type ToField =
  | { t: "init"; url: string }
  | { t: "add"; id: number; seed: number }
  | { t: "remove"; id: number }
  | { t: "drop"; id: number; x: number; y: number; r: number }
  | { t: "reagent"; id: number; value: number };

export type FieldFrame = { t: "frame"; id: number; view: Uint8Array; coverage: number; activity: number };

let x: FieldExports | null = null;
const fields = new Map<number, number>();
const queue: ToField[] = [];

function apply(m: ToField) {
  if (!x) return;
  switch (m.t) {
    case "add": {
      const old = fields.get(m.id);
      if (old) x.gs_free(old);
      fields.set(m.id, x.gs_new(FIELD_SIZE, FIELD_SIZE, m.seed));
      break;
    }
    case "remove": {
      const f = fields.get(m.id);
      if (f) x.gs_free(f);
      fields.delete(m.id);
      break;
    }
    case "drop": {
      const f = fields.get(m.id);
      if (f) x.gs_drop(f, m.x, m.y, m.r);
      break;
    }
    case "reagent": {
      const f = fields.get(m.id);
      if (f) x.gs_set_reagent(f, m.value);
      break;
    }
  }
}

function frame() {
  if (!x) return;
  for (const [id, f] of fields) {
    x.gs_step(f, ITERATIONS);
    const view = new Uint8Array(x.memory.buffer, x.gs_view_ptr(f), FIELD_SIZE * FIELD_SIZE).slice();
    const msg: FieldFrame = { t: "frame", id, view, coverage: x.gs_coverage(f), activity: x.gs_activity(f) };
    postMessage(msg, { transfer: [view.buffer] });
  }
}

onmessage = async (ev: MessageEvent<ToField>) => {
  const m = ev.data;
  if (m.t !== "init") {
    if (x) apply(m);
    else queue.push(m);
    return;
  }
  const bytes = await fetch(m.url).then((r) => r.arrayBuffer());
  const { instance } = await WebAssembly.instantiate(bytes, {});
  x = instance.exports as unknown as FieldExports;
  for (const q of queue) apply(q);
  queue.length = 0;
  setInterval(frame, FRAME_MS);
};
