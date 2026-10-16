import { wasmUrl } from "./protocol";
import type { FieldFrame, ToField } from "./field.worker";

/** Main-thread handle on the reaction-diffusion Worker. */
export class Fields {
  private worker = new Worker(new URL("./field.worker.ts", import.meta.url), { type: "module" });
  private listeners = new Map<number, (f: FieldFrame) => void>();

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<FieldFrame>) => this.listeners.get(ev.data.id)?.(ev.data);
    this.post({ t: "init", url: wasmUrl() });
  }

  add(id: number, seed: number, onFrame: (f: FieldFrame) => void) {
    this.listeners.set(id, onFrame);
    this.post({ t: "add", id, seed });
  }

  remove(id: number) {
    this.listeners.delete(id);
    this.post({ t: "remove", id });
  }

  drop(id: number, x: number, y: number, r: number) {
    this.post({ t: "drop", id, x, y, r });
  }

  reagent(id: number, value: number) {
    this.post({ t: "reagent", id, value });
  }

  private post(m: ToField) {
    this.worker.postMessage(m);
  }
}
