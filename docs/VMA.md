# Voice Modules (VMA)

> A Voice Module is a hypertoy's Voice compiled to WebAssembly by anything:
> Faust, Rust, C, Cmajor, Pure Data via hvcc, Max via RNBO. The playground runs
> it **inside its own AudioWorklet**, next to the engine. So a module plays on the
> same clock, follows the same Pulse and Tuning, and goes through the same
> panning, reverb and limiter as every other toy.

Status: implemented (Oct 2026) · see [AUDIO-GEN.md](AUDIO-GEN.md) §7 · code: `apps/playground/src/audio/vma.ts`, example: `crates/vma-ring`

---

## 1. How a module plays

```
            block N                                   block N+1
engine ──► events: NOTE(frame 37, vel, hz) ──┐
           PARAM(frame 0, id, v)             │
                                             ▼
worklet: module.set(freq), set(gate=1) at frame 37, process in segments
         ──► engine.ext[slot] (stereo) ──► engine mixes, pans, reverb, limiter
```

- A toy whose voice is a module is an ordinary custom toy (`kind::CUSTOM`). Its Law gives the frequency, and its Pulse (ring or pattern) gives notes.
- During block N the engine records a **NOTE** event for each note and a **PARAM** event for each param change, each with a sample offset. In block N+1 the worklet applies them at the same offsets and renders the module in segments around them. That's **one block (≈2.7 ms) of latency, with sample-exact relative timing**.
- A note sets the bound `freq` and `vel` inputs and raises `gate` for the toy's gate time (ToyConfig `gate`, in seconds). A note that arrives while the gate is still up drops the gate for one sample first, so envelopes retrigger.
- **Audio input** (decision 3): a module can listen to another toy's last block (the engine's per-slot bus) or to the microphone. The mic only turns on after the player grants permission.
- **Stereo out** (decision 3): a module with two outputs is balanced by the toy's pan instead of panned.
- **Isolation:** each module is its own `WebAssembly.Instance` with its own memory. Its only imports are `Math` functions. If a module's output goes NaN or infinite, the slot is muted and reported, and nothing else is affected. Every custom voice also passes through a DC blocker and a soft clip before the toy bus.
- **CPU budget:** the Forge renders each module for 10 s offline (`measureModule`) and records `cost` (µs per block, fraction of real time, peak) on its `ModuleSpec`. Above 15% it warns. Above 50% it refuses, and the worklet refuses too.

## 2. The native ABI (`abi: "vma"`)

Plain C exports over the module's own memory. Every number is `f32`/`u32`, and the handle is a pointer.

| Export | Meaning |
|---|---|
| `memory` | The module's memory (exported, not imported). |
| `vma_new(sample_rate: f32) -> h` | Create an instance. **The only call allowed to allocate or grow memory.** |
| `vma_inputs(h) -> u32` | Number of control inputs. They're addressed by id `0..n`. |
| `vma_audio_ins(h) -> u32` | Audio input channels (0–2). |
| `vma_audio_outs(h) -> u32` | Audio output channels (1–2). |
| `vma_in_ptr(h, ch) -> *f32` | Buffer of 128 floats the host fills before `vma_process`. |
| `vma_out_ptr(h, ch) -> *f32` | Buffer of 128 floats the host reads after `vma_process`. |
| `vma_set(h, id, value)` | Set control input `id`. |
| `vma_process(h, frames)` | Render `frames` (1..=128) samples, from index 0 of each buffer. |

Optional imports: only functions under `env`, named after `Math` (`_sinf`, `_powf`, `sin`, `pow`…; `fmod`, `remainder`, `exp10` and `rint` are provided too). A module importing anything else fails to load.

**Bindings.** A ToyConfig binds module inputs by id (as strings) to `"freq"`, `"gate"`, `"vel"` or a toy param name:

```jsonc
"voice": { "engine": "module", "module": {
  "abi": "vma", "bytes": "<ArrayBuffer>", "gate": 0.4, "input": "mic",
  "binds": { "0": "freq", "1": "gate", "2": "depth", "3": "echo" }
} }
```

`crates/vma-ring` is a complete example in about 150 lines of Rust: a ring modulator that listens to its input. `npm run build:wasm` builds it to `public/modules/ring.wasm`, and the Forge has a button that loads it.

## 3. Faust (`abi: "faust"`, first-class)

The Forge (`/forge.html`) compiles Faust in a Worker with `@grame/faustwasm` (LGPL-3.0, loaded only by the Forge). Faust's `wasm-i` output is hosted without any glue from Faust itself:

- The module exports `memory`, `init`, `compute`, `setParamValue`, and imports a few `env._*f` math functions.
- The host puts the DSP struct at address 0 and the channel-pointer arrays and 128-sample buffers after `json.size`, growing memory if needed.
- Inputs are found by the UI JSON's `shortname`/`label`/`address`, and set with `setParamValue(0, index, v)`.

Conventions the Forge uses:

| Faust | Becomes |
|---|---|
| `hslider("freq", …)` | Bound to the Law's frequency. A `pitch` param with the slider's range, gesture *stretch*. |
| `button("gate")` | Raised by notes (Pulse hits, pokes). |
| `hslider("gain"…)` (or `vel`) | Set to the note's velocity. |
| any other slider | A toy param with the slider's range. `[gesture:twist]` (or `stretch`) in its label sets the gesture. |
| `_, _ :> …` (inputs) | Hears the chosen audio input. |

## 4. Adapter recipes for other tools (step G)

These are untested sketches for the community to turn into template repos. The core never ships these compilers or runtimes; a mod brings its module, and its author takes on the tool's license.

### Cmajor

Cmajor can emit WebAssembly from its LLVM backend. Its own JS wrapper isn't needed. Wrap the generated C++ (from `cmaj generate --target=cpp`) in the VMA exports above, then build with `clang --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export-dynamic`. Map `vma_set` ids to the processor's input endpoints, and write outputs into two 128-float arrays.
License: Cmajor's tools are GPLv3 or commercial. C++ generated from your own Cmajor source is yours.

### Pure Data via hvcc

```bash
pip install hvcc
hvcc my_patch.pd -n mytoy -g c -o build/
```

Write a 40-line C shim:

- `vma_new` calls `hv_mytoy_new(sr)`.
- `vma_set(id, v)` calls `hv_sendFloatToReceiver(ctx, hash_of[id], v)`, using receivers named `freq`, `gate`, … in the patch (`[r freq @hv_param]`).
- `vma_process` calls `hv_processInline(ctx, ins, outs, frames)` with non-interleaved buffers.

Compile with clang or emcc (`-s STANDALONE_WASM`). Make sure the result imports nothing but math.
License: the hvcc compiler is GPLv3. The static runtime it emits is ISC. Pass `--copyright` so the generated files carry the author's name.

### RNBO (Max)

Export the patcher as **C++ source** (not the Web export, which brings its own AudioWorklet). Wrap `RNBO::CoreObject` in the VMA exports: `prepareToProcess(sr, 128)`, `setParameterValue` for each input, and `process(ins, nIn, outs, nOut, frames)`.
License: the generated code is under the Cycling '74 license for exported code (or GPLv3), and is free for commercial use under $200k revenue. The RNBO engine source is MIT.

### Anything else

If it compiles to WASM, takes controls by id, and renders up to 128 frames into its own buffers without allocating, it's a Voice Module.

## 5. Not (yet) supported

- Polyphonic modules: patch voices do round-robin polyphony, but a module is one instance. Faust's `-nvoices` poly mode isn't wired.
- MIDI-style note numbers: modules get Hz. A module that wants pitch classes can compute them.
- Sharing modules across a room: once multiplayer lands (PLAN Phase 2), modules travel as content-addressed blobs in `.htoy` packages, as PLAN §5.4 describes.
