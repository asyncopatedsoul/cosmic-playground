import workletUrl from "./worklet.ts?worker&url";
import { wasmUrl, type Command, type FromWorklet } from "./protocol";

/**
 * Main-thread side of the audio engine. The world can send commands before
 * audio exists (browsers only allow audio after a gesture); they are held and
 * flushed once the worklet's WASM is ready.
 */
export class AudioHost {
  ctx: AudioContext | null = null;
  ready = false;
  /** Latest engine snapshot and when it arrived (performance.now()). */
  snapshot: Float32Array | null = null;
  snapTime = 0;
  onReady: (() => void) | null = null;

  private node: AudioWorkletNode | null = null;
  private pending: Command[] = [];

  /** Call from inside a user gesture. Safe to call repeatedly. */
  start() {
    if (this.ctx) {
      if (this.ctx.state !== "running") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;
    void ctx.resume();
    this.boot(ctx).catch((err) => console.error("audio boot failed", err));
  }

  private async boot(ctx: AudioContext) {
    const [bytes] = await Promise.all([
      fetch(wasmUrl()).then((r) => {
        if (!r.ok) throw new Error(`hypertoy.wasm: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      ctx.audioWorklet.addModule(workletUrl),
    ]);
    const node = new AudioWorkletNode(ctx, "hypertoy", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (ev: MessageEvent<FromWorklet>) => {
      const m = ev.data;
      if (m.t === "snap") {
        this.snapshot = m.data;
        this.snapTime = performance.now();
      } else if (m.t === "ready") {
        this.ready = true;
        for (const c of this.pending) node.port.postMessage(c);
        this.pending = [];
        this.onReady?.();
      } else {
        console.error("audio engine:", m.message);
      }
    };
    node.connect(ctx.destination);
    this.node = node;
    node.port.postMessage({ t: "wasm", bytes }, [bytes]);
  }

  send(c: Command) {
    if (this.node && this.ready) {
      this.node.port.postMessage(c);
      return;
    }
    // Before audio is up, keep only the latest value of each setting.
    if (c.t === "param" || c.t === "step" || c.t === "tempo" || c.t === "tuning" || c.t === "master") {
      const same = this.pending.findIndex((p) => sameKey(p, c));
      if (same >= 0) this.pending.splice(same, 1);
    }
    this.pending.push(c);
  }
}

function sameKey(a: Command, b: Command): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "param" && b.t === "param") return a.slot === b.slot && a.p === b.p;
  if (a.t === "step" && b.t === "step") return a.slot === b.slot && a.step === b.step;
  return a.t === "tempo" || a.t === "tuning" || a.t === "master";
}
