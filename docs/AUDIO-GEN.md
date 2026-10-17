# Scripted audio and custom toys plan

> Which code libraries for programmatic sound and music fit the hypertoy engine, and how to
> wire the best ones in, so a toy can be **described as data** (params, Law, Voice, Pulse)
> rather than hand-written into `engine.rs`.

Status: **implemented, steps A–G** (Oct 2026; see §14) · builds on [PLAN.md](PLAN.md) §2.1 (anatomy), §4.3 (Rust core), §4.5 (audio), §5 (modding)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| The real blocker | Today every toy is a `match kind` arm in `crates/hypertoy-wasm/src/engine.rs` and a TS class. A custom toy needs a **`Voice` trait** and a **`ToyConfig` document**. No library helps until those exist. |
| Patch voices (Tiers 1–2) | **fundsp** (Rust, MIT/Apache; `std` feature only, no fft or file I/O). A JSON patch from the Node Forge or the SDK is built into a fundsp `Net` inside the existing engine. One WASM, one clock, one limiter. |
| Pattern scripting | A **clean-room Rust mini-notation** (`"x . x [x x]"`, `<a b>`, `x?`, `x*2`, `{3,8}`) in `hypertoy-core`, compiled into `Pulse`. It is Tidal/Strudel-*compatible text*, not Strudel *code*: **Strudel is AGPL-3.0** and can't be linked into an MIT/MPL project. |
| Custom DSP (Tier 3) | **Faust** first-class. The `faustwasm` compiler runs in the Toy Forge (a Worker) and at publish time. Its WASM module is hosted **inside the same AudioWorklet** through a small **Voice Module ABI**, not as a separate `AudioWorkletNode`. |
| Same ABI, community adapters | **Cmajor** (GPLv3/commercial), **hvcc** for Pure Data (GPLv3 compiler, ISC runtime) and **RNBO** (Cycling '74 license). They're allowed in mods, but never shipped in the core. |
| Tiny sound recipes | Port **ZzFX** (MIT) to Rust as a `Zap` voice. A 20-number array is a kid-sized, shareable "sound recipe". |
| Music theory | **Tonal** (MIT, TS) in the Forge and UI only, for scale/chord names. It *authors* tuning tables. The Rust `Tuning` still does the snapping. Add **Scala `.scl`** import for microtonal scales. |
| Evaluate, don't adopt | **Glicol** (MIT, Rust, "highly experimental") and **Elementary** (MIT v4, its own engine). Borrow ideas: Glicol's nodes, Elementary's keyed graph reconciliation for the SDK. |
| Out of scope for the core | Tone.js, Csound, libpd/pd4web, SuperCollider, Sonic Pi (separate runtimes or clocks); **Magenta RealTime 2** (Apple Silicon/Python only, not deterministic). Bridge them over OSC/MIDI from the desktop build instead ([DESKTOP-MIDI.md](DESKTOP-MIDI.md)). |

---

## 1. What "compatible" means here

The engine already has opinions. A library has to fit all of them, or be fenced off behind an adapter:

1. **One engine, one clock.** The AudioWorklet runs a single WASM engine that owns the beat clock, `Pulse`, `Tuning`, the shared reverb and the master limiter (`worklet.ts`, `engine.rs`). Libraries that bring their **own transport or scheduler** (Tone.js, Strudel's scheduler, Csound's score) fight that design.
2. **Deterministic.** Multiplayer syncs *state, not audio* (PLAN §4.6). Every random choice comes from `rng::hash3(seed, toy, n)`. A generator has to be **seedable** and give the same output from the same inputs on every client. Neural audio models fail this.
3. **No allocation or JS at audio rate.** `hypertoy-dsp` allocates in `new` and never in `tick`. JS-per-sample engines are out. Graph building has to happen on `add` or in a Worker, never inside `process`.
4. **Licenses.** Crates and SDK are MIT OR Apache-2.0, and the playground app is MPL-2.0. A copyleft dependency in the core would leak into every embedder. Copyleft tools are fine **only as optional, separately-loaded mod adapters** where the mod author takes on the license.
5. **Small and portable.** It has to run on Quest Browser and mid-range phones. Every added KB of WASM is paid on first load.
6. **Data-describable.** Custom toys are shared as data (`.htoy` manifests, CRDT documents, Constellation links). The ideal library takes a *description* (graph, recipe, pattern string), not arbitrary code.

---

## 2. Survey

Checked October 2026. Versions are what the project pages showed.

| Library | Lang / runtime | License | Status | Fit | Verdict |
|---|---|---|---|---|---|
| **fundsp** | Rust; `no_std` with `alloc` | MIT OR Apache-2.0 | 0.23.0, Jan 2026 | Same license, same language, links into our WASM. Has a dynamic `Net` graph type for runtime-built patches and seedable noise. | **Adopt** (patch voices) |
| **Faust** / faustwasm | Faust DSL → WASM; the compiler itself runs in the browser | Compiler LGPL; generated code takes the DSP author's license (check faustwasm's `COPYING.txt`) | Active, Emscripten 6 build | The best language for physical models (PLAN already names it for Tier 3). Pure DSP with no clock of its own. Exports a plain `compute()`. | **Adopt** (Tier 3) |
| **ZzFX** | JS, under 1 KB | MIT | Stable (v1.4) | Parametric one-shot SFX. Trivial to port and fully deterministic. | **Port** to Rust |
| **Tonal** | TS | MIT | Active | Theory only, no audio. Ideal for the Forge UI and for authoring tunings. | **Adopt** (UI/SDK) |
| **Strudel** | JS (+ superdough worklets) | **AGPL-3.0** | Very active (daily commits; last release 1.2.x, Sep 2025) | It's the reference for pattern live-coding, but it has its own scheduler, and its license is incompatible. | **Interop by text only**: same mini-notation, clean-room parser |
| **Glicol** | Rust → WASM + AudioWorklet + SAB | MIT | 0.12.x, "highly experimental" | Proves the Rust/worklet approach works. It's a whole engine with its own language. | **Reference**; borrow nodes |
| **Elementary** | JS graph → C++/WASM renderer | MIT (v4) | v4.0.0 | A great declarative API, but it would mean a second engine and a second mixer. | **Reference** for SDK design |
| **Kabelsalat** | JS/C live modular | Unverified | Moved to Codeberg; active 2026 | A graph language with a compiler, close to the Node Forge idea. | Watch |
| **Cmajor** | DSL → WASM (JIT in browser) | GPLv3 / commercial | 1.0.x, active | Good DSL, but copyleft unless licensed. Generated code from your own source is yours. | **Mod adapter** only |
| **hvcc** (Pure Data → C/JS) | Python CLI | GPLv3 compiler; ISC static runtime | 0.17.x | Lets Pd patchers bring patches. It compiles offline, not in the browser. | **Mod adapter** (build service) |
| **RNBO** (Max) | Max → C++/JS/WASM | Dual Cycling '74 license / GPLv3; free commercial use under $200k revenue | Active | It's a popular authoring tool, but its export needs Max and an online export. | **Mod adapter** |
| **Tone.js** | JS, Web Audio nodes | MIT | 15.x | Its own `Transport` and main-thread node graph duplicate our clock. | No (guide demos at most) |
| **Csound** (`@csound/browser`) | C → WASM | LGPL | Active (Csound 7) | Very powerful, but it's a whole runtime with its own scheduler, and the WASM is large. | No (OSC bridge) |
| **libpd / pd4web / WebPd** | C → WASM | BSD-style / varies | Active | A whole runtime. hvcc is the better route for Pd. | No |
| **SuperCollider, Sonic Pi** | Native servers | GPL | Active | Desktop performers. | **OSC out** from desktop |
| **Magenta RealTime 2** | Python/JAX/MLX; real time needs Apple Silicon | Code Apache-2.0, weights CC BY 4.0 | Jun 2026 | No browser path, and its output isn't deterministic, so it breaks "sync state, not audio". | No (maybe a desktop-only experiment) |

The one kind of AI generation that *does* fit is an LLM writing a **`ToyConfig`** (PLAN §5.4's "describe a toy" helper). It produces data that the deterministic engine plays, and that stays editable.

---

## 3. The prerequisite: toys as data

### 3.1 `ToyConfig`

One JSON document describes a custom toy. It's what the Node Forge saves, what `defineToy()` compiles to, what goes in `.htoy/manifest.json`, and what the room CRDT stores (by content hash, plus live params).

```jsonc
{
  "id": "community/glass-harmonica",
  "name": "Glass Harmonica",
  "family": "vibration",
  "params": {
    "rim":   { "range": [0.05, 0.3], "default": 0.12, "unit": "m", "gesture": "stretch" },
    "water": { "range": [0, 1],      "default": 0.3,               "gesture": "twist" }
  },
  // Law: one built-in law function, its arguments bound to params or constants (§13.1).
  "law": { "fn": "plate", "args": { "size": "rim", "thickness": 0.002 } },
  // Pulse: mini-notation compiled in Rust (§4).
  "pulse": { "pattern": "x . [x x]? . <x x*2>", "rate": "1/8" },
  // Voice: one of several engines (§5–§7). Bindings map law/pulse outputs to voice inputs.
  "voice": {
    "engine": "patch",
    "graph": { "nodes": { /* §5.2 */ }, "out": "mix" },
    "bind": { "freq": "law.freq", "gate": "pulse", "bright": "water" }
  },
  // Form: a built-in procedural form plus colours. Custom Forms are an SDK concern.
  "form": { "kind": "bowl", "color": "#7fd4ff", "drive": { "wobble": "voice.env" } },
  "ports": { "in": { "strike": "trigger" }, "out": { "ring": "energy" } }
}
```

What's checked when a config loads:
- A JSON Schema, and a limit on how many nodes the patch can have.
- Every `gesture` is one of the declared `Gesture`s.
- Every `bind` target exists on the chosen voice.
- `law` names one built-in law function (§13 decision 1). Nothing in a config is ever `eval`ed.

### 3.2 Engine refactor (Rust)

- Add `trait Voice { configure, param_set, poke, tick -> (l, r), stereo, freq, snapshot, external }` in `hypertoy-wasm/src/voice.rs`. It lives in the engine crate rather than `hypertoy-dsp` because Voices read the Tuning, the Pulse's hits and the laws.
- Port Spire, Orrery and Kettle onto it, which removes the giant `Slot`. That's the dogfooding rule in PLAN §4.7: built-in toys go through the same path as custom ones.
- Give `Slot` a `voice: Option<Box<dyn Voice>>`. Allocation only happens in `toy_add` and `toy_configure`, which run between blocks in the worklet's command phase, never in `engine_process`. Each patch has a byte budget.
- Add `kind::CUSTOM` and load commands that read a shared scratch buffer (numbers as f32 words, text as UTF-8): `toy_set_law`, `toy_load_patch`, `toy_load_zap`, `toy_load_external`, `toy_set_pattern`, `engine_set_tuning_table`, `engine_set_tuning_scl`. TypeScript compiles the ToyConfig (`audio/config.ts`), so the engine needs no JSON or serde. Each command returns 0 or a negative error code.
- Keep param slots `A..` as they are. Custom params get `A + i` in declaration order, and `PARAMS` goes from 16 to 32.
- Mirror everything in `protocol.ts` (the comment on both files already asks for this).

### 3.3 TS side

- Add a generic `ConfigToy extends Toy` that reads `defs` from the config and builds its Form from a small library of procedural forms (bowl, rod, ring, totem). The help-system hints generated from declarations ([HELP-SYSTEM.md](HELP-SYSTEM.md) §4) and the MIDI intents work with no extra code, because both already key off `ParamDef.gesture`.
- `registry.ts` gets entries from loaded configs as well as the three built-ins. The chest shows a "Made by players" shelf, gated as PLAN §5.5 says.

---

## 4. Patterns: Rust mini-notation

**Goal:** live-coders can type Tidal/Strudel-style patterns into a Pulse. Kids never see them, because the ring editor stays the default.

- **Where:** `hypertoy-core::pattern`, written from the published grammar and our own tests. **No Strudel source is read or ported**, which keeps us clear of the AGPL. Pattern *strings* are plain data, so they're portable both ways.
- **Subset for v1:** sequence `a b c`, rest `.`/`~`, groups `[a b]`, alternation `<a b>`, repeat `a*2`, slow `a/2`, chance `a?` / `a?0.3`, euclid `x(3,8)`, polymeter `{a b c}%4`, and per-step velocity `x:0.5`.
- **Compilation:** a pattern compiles to a cycle-indexed event list. `Pulse` grows from a fixed 16-step probability ring into "ring **or** compiled pattern". Chance and alternation use `rng::hash3(seed, toy, cycle)`, so every client rolls the same result.
- **Values, not only triggers:** `"0 2 <4 7> 9"` can drive a `pitch` port as scale degrees through `Tuning::degree`. That covers the Orrery-to-Spire coupling idea in PLAN §2.3.
- **Round trip with the ring editor:** a pattern that is a simple ring (≤16 steps, only `x`, `.` and `?`) round-trips into the ring UI. Anything richer shows as a "scripted" badge, and the ring becomes read-only.

---

## 5. Patch voices with fundsp

### 5.1 Why fundsp

It's MIT/Apache and pure Rust, so it compiles into the same `hypertoy.wasm` with no second runtime. A `Net` is built and `allocate()`d at load time, so ticking it doesn't allocate. And `Net` lets us build graphs at runtime from data, which the Node Forge needs.

Setup: `default-features = false, features = ["std"]`, so there's no `fft` and no file I/O. 0.23's `no_std` build doesn't compile (`resample.rs` lacks `vec!`). wasm32-unknown-unknown has std anyway, and the engine still imports nothing. fundsp 0.23 uses edition 2024. That only raises our minimum rustc (1.85+), and our crates stay on edition 2021.

### 5.2 Graph format

```jsonc
"voice": {
  "engine": "patch", "voices": 3, "gate": 0.05,
  "nodes": {
    "strike":  { "op": "bell",      "in": { "trig": "$trig", "freq": "$freq", "decay": 4 } },
    "env":     { "op": "adsr",      "args": [0.004, 1.2, 0, 1.5], "in": { "gate": "$gate" } },
    "air":     { "op": "noise" },
    "ring":    { "op": "resonator", "in": { "x": { "ref": "air", "mul": 0.6 }, "freq": { "ref": "$freq", "mul": 2.76 }, "bw": 6 } },
    "shimmer": { "op": "mul",       "in": { "a": "ring", "b": "env" } },
    "mix":     { "op": "mix",       "in": { "x": ["strike", { "ref": "shimmer", "mul": 0.5 }] } }
  },
  "out": "mix"            // or { "l": ..., "r": ... } for stereo
}
```

An input is a constant, a reference (`$freq`, `$gate`, `$trig`, `$<param>`, `<node>`, `<node>.<port>`), `{ ref, mul }`, or an array of those, which are summed. There's no expression syntax, in line with §13 decision 1. Nodes may be listed in any order; the compiler sorts them and rejects cycles. The full op list is `OPS` in `apps/playground/src/audio/config.ts`.

- **Allow-listed ops**, mapped one-to-one to fundsp nodes or to our `hypertoy-dsp` nodes (`pluck`, `bell`, `bubble` and `band` are thin fundsp wrappers, §13 decision 2): `sine saw square triangle noise pink adsr lowpass highpass bandpass resonator moog echo tanh crush follow mul mix pan dcblock`. Noise and oscillator phases are seeded from the toy seed.
- **No feedback loops** except through `echo` (at most 2 s), which is the only node with internal feedback.
- **Budget:** at most 64 nodes and 2 echoes per toy. A static cost estimate per op is checked against a per-device voice budget. That plugs into the audio LOD system (PLAN §4.5).
- **Safety on every custom voice:** a DC blocker, NaN/inf → 0 with a flag, and a soft clip before the toy bus. The master limiter stays last.
- **Polyphony:** `"voices": 4` clones the `Net` at load time. Triggers use oldest-voice stealing.

### 5.3 How each tier reaches it

- **Tier 1 Node Forge:** the graph editor *is* this JSON.
- **Tier 2 SDK:** `voice.patch(...)` builders in `@hypertoys/sdk` emit the same JSON. The API is borrowed from Elementary: graphs are plain functions of props, and keyed nodes keep their state when the patch is edited, so hot reload doesn't click.
- **Tier 0 Remix:** players only see the bound params, as gestures.

---

## 6. Sound recipes with ZzFX

ZzFX describes a whole sound in about 20 numbers (volume, frequency, attack, sustain, release, shape, slide, noise, bit-crush, delay…). It's MIT and fits in under 1 KB.

- Port the generator to Rust as `hypertoy-dsp::Zap`, with attribution in the file header. Unlike the JS original, it renders per sample from triggers instead of into an `AudioBuffer`, so it follows the engine clock.
- `"voice": { "engine": "zap", "recipe": [1, .05, 220, 0, .02, .3, 2, 1.5] }`, where the frequency slot is overridden by `bind.freq` so recipes still snap to the Tuning.
- **Kid-facing "Recipe Box":** randomize, mutate (a seeded jitter of each number) and share a recipe as a short string. That's the cheapest possible Tier 0.5, and it's useful for UI sounds too.
- Recipes made with the existing ZzFX sound designer page paste straight in.

---

## 7. Custom DSP with Faust (and friends)

### 7.1 Voice Module ABI (VMA)

Running each external module as its own `AudioWorkletNode` would bypass our clock, our Pulse, our per-toy bus and our snapshot path. Instead, **external modules run inside the same worklet** behind one small contract:

```
module exports:  memory, vma_new(sr) → h, vma_inputs(h), vma_audio_ins(h), vma_audio_outs(h),
                 vma_in_ptr(h, ch), vma_out_ptr(h, ch), vma_set(h, id, value), vma_process(h, frames)
```

The gate is an ordinary input bound to `"gate"`, and stereo out and audio in are part of the ABI (§13 decision 3). The full spec is in [VMA.md](VMA.md).

- The engine treats a VMA slot as a `Voice` whose `tick` reads from a per-slot input bus. Each block, `worklet.ts` asks the engine which VMA slots it owns and what changed (`gate`/`set` events, with sample offsets). It calls the module's `vma_process`, copies the samples into the engine's `ext_in[slot]` buffer, and then calls `engine_process`. The engine mixes, pans, sends to reverb and limits as usual.
- Triggers from `Pulse` arrive one block late (2.9 ms at 44.1 kHz), but with exact sample offsets. That's fine, and much better than separate nodes.
- **Isolation:** every module is its own `WebAssembly.Instance` with its own memory and no imports besides `Math`. The CPU cost is measured in the Forge by rendering 10 s offline in a Worker, then checked against the budget at load time. At run time, a slot whose output goes NaN, or that keeps hitting the clipper, gets muted and flagged (PLAN §5.5).

### 7.2 Faust (first-class)

- **Forge:** `@grame/faustwasm` runs in a dedicated Worker, never in the worklet. Edit `.dsp`, compile, hot-swap the module into the slot. Its UI JSON (`hslider`, `button "gate"`) maps automatically onto VMA inputs, and `[gesture:twist]` metadata in the Faust source maps an input to a gesture.
- **Publish:** `hypertoy publish` compiles to WASM once and ships `voice.wasm` in the `.htoy`. Players download the small module, never the about 10 MB compiler.
- **Determinism:** Faust's `no.noise` is a deterministic LCG. The adapter reseeds it from the toy seed through an extra input.
- **Licensing:** a toy's DSP keeps its author's license (CC BY by default). The Faust compiler is never bundled into the playground app. It's only loaded by the Forge.

### 7.3 Community adapters (the same VMA)

| Tool | Path to a VMA module | Notes |
|---|---|---|
| **Cmajor** | Its WASM generator plus a shim | GPLv3 unless the author holds a Cmajor license. Code generated from your own source is yours. |
| **hvcc** (Pure Data) | `hvcc -g c` + our Emscripten/clang wasm32 shim | Offline build (CLI or CI action). The static runtime is ISC. Set `--copyright` to the author's name. |
| **RNBO** | C++ export + wasm32 shim | Under the Cycling '74 license. Free for commercial use under $200k revenue. |

These are documented recipes and template repos, maintained by the community (PLAN §11 decision 4). The core only ever sees `voice.wasm` plus a manifest.

---

## 8. Tunings and theory

- Add `engine_set_tuning_table(e, ptr, len)` taking up to 24 cents values per period plus a period ratio. `Tuning::snap` and `degree` already work through degrees, so the change stays inside `tuning.rs`.
- **Scala `.scl`** parser in Rust: the world's huge free microtonal library becomes droppable. It fits PLAN's "wild" tuning mode.
- **Tonal** in the Forge and settings UI: pick "D dorian", "Hirajoshi" or "C maj7 arpeggio" by name. Tonal produces the pitch classes, and we send the table. Nothing from Tonal runs in the audio path.

---

## 9. Bridges, not dependencies

From the Tauri desktop build ([DESKTOP-MIDI.md](DESKTOP-MIDI.md)), MIDI out and **OSC out** (`rosc` crate) let a room drive **SuperCollider, Sonic Pi, Csound, Pd or a DAW** with the same beat-quantized events the engine plays. Ableton Link keeps tempo. That serves performers who already have those tools, without pulling their runtimes into the toy.

Neural generators like Magenta RT2 could live here later as a **desktop-only, local-only "Dream" voice**. Its output would stream into a VMA-like input bus, be marked non-deterministic, and be disabled in multiplayer rooms. That's not planned yet.

---

## 10. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **A. Voice trait** | §3.2 refactor; the three toys ported; `kind::CUSTOM`; `toy_load` | Snapshot audio of the three toys matches before and after (spectral fingerprint within tolerance) |
| **B. Mini-notation** | §4 parser + `Pulse` patterns + pattern text field behind a "scripted" toggle | Property tests: same seed gives the same events; ring patterns round-trip |
| **C. ToyConfig + patch voices** | §3.1 schema, `ConfigToy`, fundsp patch engine §5, two procedural Forms | A new toy ships as one JSON file with no TS or Rust change; WASM growth measured and recorded (target ≤ 150 KB gzip) |
| **D. Zap + Recipe Box** | §6 | A 7-year-old makes and shares a sound in under a minute |
| **E. Tunings** | §8 table export, `.scl`, Tonal picker | 31-EDO and a Scala file play correctly across all toys |
| **F. VMA + Faust** | §7.1–7.2, Forge Worker compile, `.htoy` `voice.wasm` | A Faust physical model plays on Quest at 12 toys without dropouts; bad modules are muted, not crashes |
| **G. Adapter recipes** | §7.3 templates, CI action for hvcc | An outside dev ports a Pd patch in under a day |
| **H. OSC out** | §9 in the desktop shell | Sonic Pi follows a room's beat within one block |

A–C belong at the start of PLAN Phase 3 (Creators), or late in Phase 1 if the coupling work needs `Voice` sooner. D and E are small enough to fill gaps in any phase.

---

## 11. Testing

- **Golden audio:** `cargo test` renders each built-in toy and each example `ToyConfig` for 4 s at a fixed seed. It compares a spectral fingerprint (band energies + onset times), not raw samples, so harmless float drift across targets doesn't fail tests.
- **Determinism:** the same config and seed on native and on wasm32 (via wasmtime in CI) give the same event list and a fingerprint match.
- **Fuzzing:** random graphs within the allow-list (`cargo fuzz`) must never panic, allocate in `tick` (checked with a counting allocator in tests), or emit NaN.
- **Budget regression:** a CI step records `hypertoy.wasm` size and a per-op cost table.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| fundsp `Net` allocation or size hurts the worklet | Build only on load; cap nodes; measure the gzip size in step C. Fall back to our own nodes behind the same JSON if it's too big. |
| Copyleft creeps in | The core links only MIT/Apache crates (`cargo deny` with a license allow-list). Copyleft tools only appear in Forge Workers and in mod builds. |
| Worklet CPU spikes from external modules | Offline cost measurement, load-time budget, runtime mute-and-flag, audio LOD |
| Mini-notation seen as "Strudel-lite" and judged on parity | Document it as a subset. Pattern text is portable, so people can take a pattern to Strudel and back. |
| Custom toys break the "no wrong notes" promise | Every `freq` binding goes through `tuning.snap` unless the toy declares `"wild": true` |
| Kids hit harsh sounds from community recipes | Per-toy soft clip, a loudness cap for unverified toys, and a verified shelf for kid profiles |

---

## 13. Decisions (Oct 2026)

1. **Laws are built-in law functions only for v1.** A config names a law (`fixed`, `string`, `plate`, `helmholtz`, `bubble`, `pendulum`; ids in `hypertoy_laws::law`) and gives each argument as a constant, a param, or `param * mul + add`. The Law's output is the toy's frequency (`$freq` in patches), snapped to the Tuning unless `wild`. There is no expression language yet. Kepler stays with the Orrery, because its output is a period, not a pitch.
2. **fundsp wraps `hypertoy-dsp` nodes.** Pluck, Bell, Bubble and Svf stay ours (they're tuned), and they appear inside patches as fundsp nodes next to fundsp's own.
3. **VMA modules get stereo out and audio input.** The ABI has `in_ptr`/`out_ptr` for two channels. The input carries a toy's port feed (another toy's bus, or the microphone for listening toys, behind a permission). That serves the Prism of Partials.
4. **Faust ships in the Forge in step F.** A minimal Forge page (`forge.html`) compiles Faust in a Worker and hot-loads the module into a slot. It comes before the full SDK v0. Its source is only served on that page: faustwasm is LGPL-3.0, so it stays out of the playground bundle.
5. **A Strudel bridge only if the flagship goes AGPL.** The playground stays MPL-2.0 for now, so there's no bridge. Pattern text stays portable both ways.

---

## 14. Implementation status (Oct 2026)

| Step | State | Where |
|---|---|---|
| **A. Voice trait** | Done. Spire, Orrery and Kettle are Voices. Golden spectral fingerprints recorded from the pre-refactor engine still match. | `crates/hypertoy-wasm/src/{voice,builtin,custom,engine}.rs`, `golden.rs` |
| **B. Mini-notation** | Done: sequences, rests, `[ ]`, `< >`, `*`, `/`, `?`, `(k,n,r)`, `{ }%n`, `!n`, `:vel`, `X`, numbers as scale degrees. Chance rolls are keyed by onset, so every client agrees. | `crates/hypertoy-core/src/pattern.rs`, `pulse.rs`; script field in the Pulse editor |
| **C. ToyConfig + patch voices** | Done. Four example toys ship as JSON: Singing Bowl (plate law, patch), Bottle Organ (Helmholtz, patch, degree patterns), Spark Box (zap), Pendulum Clock (pendulum, pluck and echo). WASM grew from 33 KB to 165 KB gzipped (+132 KB, under the 150 KB target). | `crates/hypertoy-dsp/src/{patch,units}.rs`, `apps/playground/src/audio/config.ts`, `toys/config-toy.ts`, `toys/configs/*.json` |
| **D. Zap + Recipe Box** | Done: an independent ZzFX-compatible synth, plus roll, mutate, copy and paste in the Pulse editor. | `crates/hypertoy-dsp/src/zap.rs`, `ui/recipe-box.ts` |
| **E. Tunings** | Done: tables of up to 64 tones with any period (n-EDO, Bohlen–Pierce…), Scala `.scl`, and Tonal scale names (loaded lazily). | `crates/hypertoy-core/src/{tuning,scala}.rs`, `ui/tunings.ts` |
| **F. VMA + Faust** | Done: in-worklet host with sample-offset events, stereo out, audio input from a toy or the mic, and mute-on-NaN. A minimal Forge (`/forge.html`) compiles Faust in a Worker (about 1 s), hot-loads it, and sends toys to the playground over a BroadcastChannel. | `audio/vma.ts`, `audio/worklet.ts`, `src/forge/*`, `crates/vma-ring` |
| **G. Adapter recipes** | Written, untested: recipes for Cmajor, hvcc and RNBO, plus a tested Rust example module. A CI action for hvcc isn't done. | [VMA.md](VMA.md) |
| **H. OSC out** | Not started: it needs the Tauri shell from [DESKTOP-MIDI.md](DESKTOP-MIDI.md), which doesn't exist in the repo yet. | |

**Hardening (done, Oct 17):**
- Every custom voice passes through a guard before the toy bus: NaN → 0, a DC blocker, and a soft clip that's transparent below 0.7 and never passes 1 (`Guard` in `custom.rs`). Built-in toys are untouched, and their golden fingerprints still match.
- The Forge measures every module before loading it. It renders 10 s offline in a Worker through the same adapter and segmenting as the worklet (`measureModule` in `audio/vma.ts`), with notes and noise input. It reports the cost, warns above 15% of a block, and refuses above 50%. The worklet also refuses a module whose recorded cost is over the limit. Measured here: FM bell 1.4%, Ring Listener 0.8%, 400 filtered oscillators 72% (refused).
- `Patch::build` is fuzzed with 4000 seeded programs (random words and mostly valid graphs with corruptions). None panics, and every built patch stays finite under extreme inputs.
- License gate: `deny.toml` for cargo-deny in CI, plus `npm run licenses` (`scripts/check-licenses.mjs`), which enforces the same allow-list through `cargo metadata` with nothing to install. It covers the 42 crates the embeddable `crates/*` pull in; the MPL-2.0 desktop shell is excluded.

Still deferred: a JSON Schema file for ToyConfig, and a CPU budget across *all* toys (each module is checked alone).

---

## Sources (checked Oct 2026)

- fundsp: [crates.io](https://crates.io/crates/fundsp), [GitHub](https://github.com/SamiPerttu/fundsp)
- Faust: [faustwasm](https://github.com/grame-cncm/faustwasm), [2022 Faust web paper](https://science.ulysseus.eu/records/qvyvn-mmb27)
- Strudel: [Codeberg](https://codeberg.org/uzu/strudel), [FAQ (license)](https://live.strudel.cc/learn/faq/)
- Glicol: [GitHub](https://github.com/chaosprint/glicol)
- Elementary: [GitHub](https://github.com/elemaudio/elementary), [v2 open-source announcement](https://buttondown.com/elemaudio/archive/elementary-audio-now-open-source)
- Kabelsalat: [GitHub (archived)](https://github.com/felixroos/kabelsalat), [Codeberg](https://codeberg.org/froos/kabelsalat)
- Cmajor: [GitHub](https://github.com/cmajor-lang/cmajor)
- hvcc: [GitHub](https://github.com/Wasted-Audio/hvcc)
- RNBO: [Cycling '74 export license](https://support.cycling74.com/hc/en-us/articles/10730031661587-Cycling-74-License-for-Max-Generated-Code-for-Export), [updated terms](https://cycling74.com/forums/updated-license-terms-for-max-generated-code-for-export)
- Tonal: [GitHub](https://github.com/tonaljs/tonal)
- ZzFX: [GitHub](https://github.com/KilledByAPixel/ZzFX)
- Tone.js: [GitHub](https://github.com/Tonejs/Tone.js)
- Csound WASM: [docs](https://www.mintlify.com/csound/csound/platforms/web-assembly)
- pd4web: [PyPI](https://pypi.org/project/pd4web/1.2.2)
- Magenta RealTime: [GitHub](https://github.com/magenta/magenta-realtime), [Simon Willison on v1](https://simonwillison.net/2025/Jun/20/magenta-realtime), [MRT2 overview](https://mcp.directory/blog/magenta-realtime-2-open-live-music-model-2026)
