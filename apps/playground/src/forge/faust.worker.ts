// The Faust compiler (faustwasm, LGPL-3.0), in its own Worker so the ~8 MB
// compiler never touches the playground bundle or the audio thread. It turns
// Faust source into a WASM module plus its UI JSON; the worklet hosts the
// module (audio/vma.ts).

type Req = { id: number; name: string; code: string };
export type CompileResult =
  | { id: number; ok: true; wasm: ArrayBuffer; json: string; ms: number }
  | { id: number; ok: false; error: string };

let compiler: Promise<{
  compile(name: string, code: string): Promise<{ wasm: ArrayBuffer; json: string }>;
}> | null = null;

function boot() {
  compiler ??= (async () => {
    // The bundle embeds libfaust's wasm and its standard libraries.
    const fw = await import("@grame/faustwasm/dist/esm-bundle/index.js");
    const module = await fw.instantiateFaustModule();
    const faust = new fw.FaustCompiler(new fw.LibFaust(module));
    return {
      async compile(name: string, code: string) {
        const gen = new fw.FaustMonoDspGenerator();
        await gen.compile(faust, name, code, "-I libraries/ -ftz 2");
        const f = gen.factory;
        if (!f) throw new Error("no factory");
        const wasm = f.code.slice().buffer as ArrayBuffer;
        return { wasm, json: f.json };
      },
    };
  })();
  return compiler;
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const { id, name, code } = ev.data;
  const t0 = performance.now();
  try {
    const c = await boot();
    const { wasm, json } = await c.compile(name.replace(/[^A-Za-z0-9_]/g, "_") || "toy", code);
    const res: CompileResult = { id, ok: true, wasm, json, ms: Math.round(performance.now() - t0) };
    (self as unknown as Worker).postMessage(res, [wasm]);
  } catch (e) {
    const res: CompileResult = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
    (self as unknown as Worker).postMessage(res);
  }
};
