// Measures a Voice Module's CPU cost off the main thread, with the same
// adapters the worklet uses (audio/vma.ts), before the Forge loads it.

import type { ModuleCost, ModuleSpec } from "../audio/protocol";
import { measureModule } from "../audio/vma";

export type MeasureResult = { id: number; ok: true; cost: ModuleCost } | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<{ id: number; spec: ModuleSpec; sampleRate: number }>) => {
  const { id, spec, sampleRate } = ev.data;
  let res: MeasureResult;
  try {
    res = { id, ok: true, cost: measureModule(spec, sampleRate) };
  } catch (e) {
    res = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(res);
};
