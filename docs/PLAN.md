# Cosmic Playground: Hypertoys plan

> An all-ages, multiplayer, cross-device playground for sound and geometry.
> Players pull **hypertoys** out of a chest: impossible, alien toys that still follow
> real first principles of physics, acoustics, music and chemistry. Each one can be set to
> play on its own, and several toys playing together make a generative soundscape
> and a 2D/3D animation that players shape by improvising.

Status: planning draft · Oct 2026

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| Core idea | Each **hypertoy** is *Form + Law + Voice + Pulse + Ports*. One parameter drives both what you see and what you hear. |
| Platform strategy | **Web first.** One codebase serves desktop, touch, gamepad and WebXR (Quest 3 VR and mixed reality). Store builds are thin wrappers. |
| Engine | A **Rust core** (deterministic simulation, clock/scheduler, DSP) compiled to WASM. It runs in an AudioWorklet and a Worker. A **TypeScript shell** with a three.js renderer (WebGPU, falling back to WebGL2) handles input and XR. |
| Needle Engine | Use it as an **optional authoring and integration adapter**, not a dependency of the open core. It's built on three.js, so it fits well, but commercial use needs a paid Needle license. |
| Multiplayer | **Next priority** ([MULTIPLAYER.md](MULTIPLAYER.md)). Sync **state, not audio.** A shared CRDT world document (Yjs for v1) plus a shared beat clock. Each client renders audio locally and deterministically, and events are scheduled a little ahead of time so everyone hears the same thing. First target: browser and desktop players jamming over a free ngrok tunnel. |
| Modding | Four tiers: **remix in-world → node graph → TypeScript SDK → Rust/Faust DSP and WGSL/TSL shaders.** It has a browser IDE (the "Toy Forge") with hot reload straight into a headset. |
| Licensing | Core engine and SDK under **MIT/Apache-2.0**. The flagship app is open too, but the brand and official art are reserved. Toys made by the community use their creators' licenses (CC BY by default). |
| Go to market | Open-source launch around a **game jam** and a **streamed improv performance**. Revenue comes from hosted rooms, education, installations and creator-marketplace fees, not from license fees on the core. |

---

## 1. Experience pillars

1. **Toys, not instruments.** Nothing should look like a mixer, piano roll or DAW. A toy has an obvious "hold me / poke me / stretch me" affordance, and the music comes from playing with it.
2. **Alien but lawful.** Every toy is impossible, like a tesseract bell or a fluid that sings, but it follows a real principle you can discover. A string twice as long sounds an octave lower. Orbits in a 3:2 ratio make a 3-against-2 polyrhythm. Kids learn physics from how the toys feel, without reading anything.
3. **One parameter, two senses.** A single value drives the geometry and the sound together, so there's never a mismatch between what you see and what you hear. This is the main design rule and it's enforced by the SDK (see §5).
4. **No wrong notes by default.** The world has a shared **Tuning** (key, scale, tempo, temperament). Pitches that come from physics snap to it softly, and a "wild" switch turns snapping off for experts and microtonal play. A *Just Intonation* world, where the harmonic series is the scale, ties the music straight back to the physics.
5. **Set it and let it play.** Every toy has a **Pulse** (its automation heart). Once set, it keeps playing after you let go. Improvising means arranging toys that play themselves, which is the generative-music idea of Eno-style systems.
6. **Better together, fine alone.** Single player is a calm sandbox. Multiplayer is a jam where every player's toys share one clock and one tuning.
7. **Safe and accessible for all ages.** No text needed to play. Volume is limited, flashing is limited, controls work one-handed or seated, colour-blind-safe palettes are used, and there is no open chat with strangers by default.

### 1.1 Core loop

```
 open the chest ─► grab a hypertoy ─► place it in the world ─► poke and play it by hand
        ▲                                                         │
        │                                                         ▼
 save/share a "Constellation" ◄── couple toys (beams/cables) ◄── set its Pulse (auto-play)
```

- **The chest (library):** a physical object in the world. In VR it's a chest you open. On touch screens it's a drawer that slides up from the bottom edge. On desktop it's a hotbar plus the `Tab` key. Toys are grouped by **Principle families** (Vibration, Orbit, Wave, Growth, Reaction, Topology), not by instrument type. Every toy maps to exactly one of the six; instrument-like *types* (organs, bells…) and *packs* (built in, community) are extra lenses in the Toy Book only ([TOY-BOOK.md](TOY-BOOK.md) §3.1).
- **Placing:** toys sit on surfaces or float. In AR they sit on your real table, using mixed-reality plane and anchor detection.
- **Poking:** direct manipulation. Strike, pluck, stretch, twist, spin, pour or throw.
- **Pulse:** tap the toy's heart, a glowing core, and pick a pattern by *shape*, not by number (see §3.3).
- **Coupling:** drag a beam from one toy to another. Energy then flows between them: one toy's output triggers or modulates the other. You can also couple toys physically, for example by having a pendulum swing into a bell, Rube Goldberg style.
- **Constellation:** the saved state of a whole world. It's a link, an embeddable iframe, and a file.

---

## 2. Hypertoys

### 2.1 Anatomy

```
Hypertoy
├── Form    geometry + materials, procedural, driven by params
├── Law     the first principle it follows (string, orbit, plate modes, diffusion…)
├── Voice   a DSP graph whose parameters come from the Law
├── Pulse   automation: rate, pattern, probability, modulators
└── Ports   inputs and outputs for coupling (trigger, energy, pitch, phase, spectrum)
```

### 2.2 Launch catalog (draft)

| Toy | Principle | What you do | What it sounds and looks like |
|---|---|---|---|
| **Monochord Spire** | String vibration, harmonic series | Stretch for length, twist for tension, touch nodes for harmonics | Plucked and bowed tones; the string shows its standing wave |
| **Chladni Drum** | Plate vibration modes | Strike it, slide the frequency ring | Sand gathers into nodal patterns; bell-like inharmonic partials |
| **Kepler Orrery** | Orbits, period ratios | Fling planets into orbit | Each conjunction plays a note; orbit ratios become polyrhythms |
| **Pendulum Wave** | Coupled oscillators, phase | Pull back, release | Pendulums drift in and out of phase, giving a slowly evolving arpeggio |
| **Lissajous Loom** | Superposition of frequencies | Set the X:Y ratio on two dials | A glowing figure traces the interval; pure ratios make stable shapes and stable consonances |
| **Fourier Serpent** | Fourier series, epicycles | Draw a shape | The drawing is redrawn by spinning circles and turned into a wavetable timbre |
| **Euclid Wheel** | Euclidean rhythms | Spin the outer and inner rings | Rhythm generator; spokes light up and emit particles |
| **Crystal Seeder** | Crystallography, L-systems | Plant a seed in a lattice | It grows fractal crystals, and each growth step is an arpeggio note |
| **Reaction Kettle** | Reaction-diffusion (Gray-Scott) | Pour in "reagents" A and B | Living Turing patterns drive filters and grains; a chemistry-like texture |
| **Bubble Organ** | Helmholtz resonance | Blow bubbles of different volumes | Each bubble resonates at f ∝ 1/√V and then pops |
| **Doppler Comet** | Doppler effect | Throw it past you | Pitch rises and falls as it passes; a glowing trail |
| **Tesseract Bell** | 4D rotation and projection | Rotate it through the 4th dimension | Faces become partials; the 3D shadow morphs as the chord shifts |
| **Murmuration Choir** | Flocking (boids) | Sprinkle birds, place attractors | Swarm density becomes a cloud of voices; spatial granular sound |
| **Prism of Partials** | Spectral decomposition | Shine any toy's sound through it | Splits sound into rainbow beams of partials that you can redirect into other toys |

The first prototype should cover three different families: **Monochord Spire, Kepler Orrery and Reaction Kettle**. That checks that the anatomy handles discrete triggers, continuous motion and emergent texture.

### 2.3 Coupling semantics

Ports are typed, and each type has a colour so it can be read at a glance:

- `trigger` (white sparks): a discrete event, like striking or pulsing a toy.
- `energy` (amber): a continuous 0–1 value that modulates amplitude, brightness or speed.
- `pitch` (violet): sends a frequency or scale degree, for example the orrery choosing the spire's harmonic.
- `phase` (cyan): locks oscillators together (sync and entrainment, like Huygens' clocks).
- `spectrum` (rainbow): rich data between spectral toys, such as the prism.

Coupling is always **physical-looking**: beams, tubes or light rays. Couplings also work when they really are physical, like collisions or particles landing on a toy.

---

## 3. Interaction across devices

### 3.1 The intent layer

Every device maps to a small set of **intents**. Toys only ever see intents, never raw device input:
`point`, `grab`, `release`, `poke(strength)`, `stretch(axis, amount)`, `twist(angle)`, `throw(velocity)`, `open-chest`, `pulse-edit`.

| Intent | VR (hands / controllers) | AR (passthrough) | Touch | Mouse + keyboard | Gamepad |
|---|---|---|---|---|---|
| point | ray / finger | same as VR | — | cursor | reticle (left stick) |
| grab | pinch / grip | pinch | long-press | click-drag | `A` hold |
| poke | finger tap, speed = strength | same as VR | tap (pressure / speed) | click (shift = soft) | `X` |
| stretch | two-hand pull | same as VR | pinch | scroll / drag on handle | triggers |
| twist | wrist roll | same as VR | two-finger rotate | `Q`/`E` or alt-drag | right stick |
| throw | release while moving | same as VR | flick | drag-release fast | `RB` + stick |
| open chest | look down at the chest / palm-up menu | same | swipe up | `Tab` | `Y` |

### 3.2 Views

- **VR:** room scale, toys at hand height, the chest at your hip.
- **AR / MR (Quest 3):** passthrough, toys anchored to real surfaces, and the room's mesh used for physical couplings (sound bounces off your real wall).
- **3D flat:** orbit camera on desktop and tablet.
- **2D diorama:** an orthographic, drawing-like view for phones and young kids, with the same toys flattened. It's also handy for streaming overlays.

### 3.3 Pulse editing without numbers

- **Rate:** a dial that clicks between musical divisions (1/1 … 1/32, plus triplet and dotted). It turns smoothly with a "free Hz" modifier.
- **Pattern:** a ring of dots. Tap to toggle them (a Euclidean preset is just a gesture), and long-press a dot to set its probability, shown as a fading dot.
- **Modulators:** "wobblers" are small orbiting moons you attach to any parameter. The orbit speed is the LFO rate and the orbit size is the depth.
- **Advanced panel** (desktop/expert): exact values, polymeter, ratchets and seeded randomness.

---

## 4. Technical architecture

### 4.1 Why web first

- One build reaches Quest 3 (Meta Quest Browser, plus installable PWAs on Quest), desktop, Android and iOS (non-XR modes), and links on Discord and streams.
- Sharing is a URL, and so are jams. That matters a lot for community growth.
- Native wrappers (Tauri for desktop and, pending a spike, Tauri 2 mobile instead of Capacitor; a PWA for the Quest store) can be added later without a rewrite. Phone-hosted local play ([LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md)) pulls the mobile wrapper forward ([PUBLISHING.md](PUBLISHING.md) §5.1).

### 4.2 Layers

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ App shell (TypeScript)                                                        │
│   UI, chest, onboarding, accounts, room lobby, Toy Forge IDE                  │
├───────────────────────────────────────────────────────────────────────────────┤
│ Presentation (TypeScript)                                                     │
│   three.js renderer (WebGPU → WebGL2), TSL/WGSL shaders, WebXR session,       │
│   hands/controllers, spatial audio panning, intent layer                      │
│   └─ optional: @hypertoys/needle adapter (scenes authored in Unity/Blender)   │
├────────────────────────────────┬──────────────────────────────────────────────┤
│ Sim Worker (Rust → WASM)       │ AudioWorklet (Rust → WASM)                   │
│   toy state, Laws (physics),   │   DSP graph per toy, voice pool,             │
│   Pulse scheduler, couplings,  │   sample-accurate event queue,               │
│   deterministic seeded RNG     │   limiter, metering → visual feedback        │
├────────────────────────────────┴──────────────────────────────────────────────┤
│ hypertoy-core (Rust crate, no_std-friendly where possible)                    │
│   Toy model · Tuning · Clock · Pattern engine · DSP nodes · Serialization    │
├───────────────────────────────────────────────────────────────────────────────┤
│ Net (TypeScript)                                                              │
│   CRDT world doc (Loro or Yjs) · clock sync · WebRTC data / WebTransport ·    │
│   thin relay server                                                           │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Data flow:** input → intents → the Sim Worker updates toy params and schedules events → events go to the AudioWorklet queue, timestamped against the audio clock, and the param snapshot goes to the renderer. Shared memory is used where cross-origin isolation is available (a SharedArrayBuffer ring buffer), with a `postMessage` fallback for embeds that can't send COOP/COEP headers.

### 4.3 Rust core: why, and what's in it

- **Determinism and portability.** The same simulation runs in the browser, a headless test runner, a dedicated server (for spectator and recording services), and possible native builds later (e.g. Bevy or a Godot GDExtension).
- **Real-time audio safety.** No garbage collection and no allocation in the audio callback.
- **Crate layout:**
  - `hypertoy-core`: the model, Tuning, Clock, Pulse patterns, the Law trait and serialization (serde plus a compact binary format).
  - `hypertoy-dsp`: oscillators, physical models (Karplus-Strong, modal banks, waveguides), filters, grains, reverb and a limiter. Use ideas and code from **fundsp** and **Glicol** where their licenses allow. Glicol already runs a Rust DSP engine in the browser through WASM, AudioWorklet and SharedArrayBuffer, which proves the approach works, though it is still pre-1.0 and was last active in 2025.
  - `hypertoy-laws`: string, membrane/plate modes, orbit integrator, pendulum, Gray-Scott diffusion (GPU compute variant in TS/WGSL for visuals), boids and L-systems.
  - `hypertoy-wasm`: wasm-bindgen glue for the Worker and Worklet builds.

### 4.4 Rendering and XR

- **three.js** is the open, MIT-licensed base renderer. It has a WebGPU renderer, TSL node materials and solid WebXR support. Visuals that are compute-heavy (reaction-diffusion fields, particle swarms) run as GPU compute where WebGPU is available, with simpler fallbacks otherwise.
- **Needle Engine** has strong WebXR features (hands, MR/passthrough, anchors, iOS AR through App Clips, built-in networking) plus a Unity/Blender authoring workflow. Its 6.0 line (alpha in mid-2026) turns on WebXR anchors by default. **Licensing caveat:** Needle is free for non-commercial use, and commercial use needs a paid Pro license. So:
  - The **open core must not depend on Needle**, or every commercial embedder would inherit a license requirement.
  - Ship `@hypertoys/needle` as an adapter. It lets Needle projects host hypertoys, and lets studios author worlds and art in Unity/Blender. Unity and Blender artists are a big creator pool.
  - Before committing, prototype XR on both plain three.js and Needle, then decide which one the *flagship app* uses. Needle's MR features could save months, and the flagship can take a commercial license.
- **Performance budget (Quest 3):** 72–90 fps, at most about 150 draw calls, instancing for particles, foveation on, and the sim at 60 Hz with fixed-step Laws. Audio is the priority: the visuals drop quality before the audio ever glitches.

### 4.5 Audio details

- AudioWorklet with a 128-frame quantum, rendered by WASM. Sample-accurate scheduling from timestamped events.
- **Voice budget and audio LOD:** cap the number of voices, steal the quietest or oldest, and give distant toys simpler patches.
- **Spatialization:** v1 uses a submix per toy bus and a Web Audio `PannerNode` (HRTF) per bus. Moving spatialization into WASM is a later option.
- **Safety:** a master true-peak limiter, a loudness target (about −16 LUFS), and a "quiet hours" kid mode.
- **Interop:** MIDI-out (Web MIDI) and OSC through a companion bridge, so performers can drive DAWs. Also clock sync with Ableton Link through a bridge.

### 4.6 Multiplayer

The detailed, prioritised plan is [MULTIPLAYER.md](MULTIPLAYER.md): a WebSocket relay mounted on the same server as the page (one origin, one tunnel), a Yjs document shaped like the saved world, clock slewing in the engine, and a test matrix of browser and desktop builds over ngrok and Cloudflare quick tunnels. This section is the long-term shape.

- **Topology:** a room is a **CRDT document** (with Loro or Yjs) holding the toys, their parameters, couplings, Tuning and Pulse settings. Transport is WebRTC data channels in a mesh for small rooms (≤6), with a relay or SFU-style fan-out (WebSocket/WebTransport) for bigger rooms and spectators.
- **Clock:** an NTP-style offset estimate against the room host or server. All musical events are scheduled at **beat-quantized future times** (a lookahead of about 100–250 ms), so every client plays the same event at the same musical moment. Live pokes are quantized optionally (on for kids, off for experts).
- **Determinism:** toys with randomness use seeded RNG keyed by (room seed, toy id, beat), so clients don't need to send audio or per-event data. They just compute it.
- **Ownership:** whoever grabs a toy gets a soft lock on it. Placed toys belong to the room, and others can play them unless they're locked.
- **Bandwidth:** only param deltas and pose updates. Hand poses are throttled and compressed.
- **Persistence:** rooms can be saved as Constellations (a CRDT snapshot) in object storage.
- **Safety:** private rooms with invite codes by default. For under-13s there's no free text or voice chat, only emotes and toy gestures. Public rooms are moderated, hosts have kick/mute, and there are reporting tools. The design follows COPPA and GDPR-K.

### 4.7 Monorepo layout

```
cosmic-playground/
├── crates/
│   ├── hypertoy-core/       # model, clock, tuning, pulse
│   ├── hypertoy-dsp/        # audio nodes
│   ├── hypertoy-laws/       # physics/chemistry/math laws
│   └── hypertoy-wasm/       # bindings (worker + worklet targets)
├── packages/
│   ├── engine/              # TS runtime: renderer, intents, XR, audio host
│   ├── net/                 # CRDT room, clock sync, transport
│   ├── sdk/                 # @hypertoys/sdk – public mod API (defineToy…)
│   ├── forge/               # Toy Forge web IDE (Monaco + live preview)
│   ├── cli/                 # create-hypertoy, hypertoy dev/build/publish
│   ├── needle-adapter/      # @hypertoys/needle
│   └── embed/               # <hypertoy-world> web component / iframe API
├── apps/
│   ├── playground/          # flagship app
│   └── relay/               # room relay + persistence service
├── toys/                    # official toys (each is a mod, dogfooding the SDK)
└── docs/
```

**Dogfooding rule:** every official toy is built with the public SDK. If the official toys need a private API, the SDK isn't good enough yet.

---

## 5. Modding and developer experience

### 5.1 The ladder of expressivity

| Tier | Who | Tool | Expressivity |
|---|---|---|---|
| **0. Remix** | Everyone, including kids | In-world: tweak, recolor, combine and save presets and Constellations | Medium. It already counts as composing. |
| **1. Node Forge** | Teens, artists, teachers | A visual node graph (in VR and on the web) that wires Laws, Voices, Forms and Pulses | High, with no code |
| **2. TypeScript SDK** | Creative coders | `defineToy()` in the Toy Forge or VS Code, with hot reload | Very high |
| **3. Native extensions** | DSP and graphics nerds | Rust or **Faust** → WASM DSP nodes; TSL/WGSL shaders for Forms | Unlimited, sandboxed |

Each tier **compiles into the one below it**. A node graph saves as readable TS, and you can "eject" to code at any time. That gives a natural learning path, in the spirit of Scratch → JS.

### 5.2 Why TypeScript for scripting

The alternatives considered were Lua/Luau (Roblox familiarity, tiny VM), Python (it's what schools teach), and a custom DSL (like Strudel or Tidal).

TS wins for these reasons:
- It's the largest creative-coding pool (p5.js, three.js, Strudel).
- The type system works as documentation, with autocomplete inside the Forge.
- It runs in the browser with no toolchain.
- It's the same language as the engine shell.

A **pattern mini-notation** (Tidal/Strudel-style strings such as `"x . x x . [x x]"`) is still available *inside* TS for Pulse patterns, so live-coders feel at home.

### 5.3 SDK sketch

```ts
import { defineToy, form, law, voice, pulse, tuning } from "@hypertoys/sdk";

export default defineToy({
  id: "community/monochord-spire",
  name: "Monochord Spire",
  family: "vibration",

  // Params are the ONLY state. Each declares how a hand can change it.
  params: {
    length:  { range: [0.2, 2.0], unit: "m", default: 1.0, gesture: "stretch" },
    tension: { range: [0, 1], default: 0.5, gesture: "twist" },
    harmonic:{ range: [1, 8], step: 1, default: 1, gesture: "touch-node" },
  },

  // Law: the first principle. Pure function of params (+ time) → derived quantities.
  law: law.string(({ length, tension, harmonic }) => ({
    fundamental: law.string.frequency({ length, tension, density: 0.01 }),
    harmonic,
  })),

  // Voice and Form both read the SAME derived values: "one parameter, two senses".
  voice: ({ fundamental, harmonic }, hit) =>
    voice.pluck({ freq: tuning.snap(fundamental * harmonic), energy: hit.energy, decay: 2.5 }),

  form: ({ length, harmonic }, t, hit) =>
    form.string({ length, mode: harmonic, amplitude: hit.envelope(t), glow: "violet" }),

  pulse: pulse.euclid({ hits: 3, steps: 8, rate: "1/16" }),

  ports: {
    in:  { strike: "trigger", harmonic: "pitch" },
    out: { ring: "energy" },
  },
});
```

The design rules the SDK enforces:
- **Params are the only state**, which makes them serializable, syncable and undoable for free.
- `law`, `voice` and `form` are **pure functions**. The runtime decides where they run: Voice graphs are compiled into the Rust DSP graph, so no JS runs at audio rate. Forms run on the render thread.
- **Gestures are declared, not coded.** That's how every toy works on every device without extra code.
- **The runtime compiles a Voice description to a DSP graph.** Custom sample-level code needs Tier 3 (Faust or Rust).

### 5.4 Tooling

- **Toy Forge** (web): a Monaco editor next to a live 3D preview, param sliders, an oscilloscope/spectrum view, and a "send to headset" QR code that hot-reloads into a Quest over the room connection. It's the Shadertoy/Strudel-REPL experience for toys.
- **CLI:** `npm create hypertoy@latest`, `hypertoy dev` (Vite with HMR and LAN headset pairing), `hypertoy test` (headless deterministic sim, plus **audio snapshot tests** that render N seconds and compare spectrum fingerprints), and `hypertoy publish`.
- **VS Code extension:** types, snippets, and a preview webview.
- **Package format `.htoy`:** a zip containing `manifest.json` (id, version, license, permissions, ports), compiled JS, optional WASM, glTF assets and a thumbnail or GIF.
- **AI helper (optional):** "describe a toy" → a Node Forge graph. The output must be editable, never a black box.
- **Docs as toys:** every concept page embeds a live toy you can edit, like the explorable explanations of Bret Victor or Nicky Case.

### 5.5 Sandboxing and safety

- Mod logic runs in a **Worker with no DOM and no network**. Capabilities are passed in explicitly, and SES/Compartment-style hardening is applied.
- WASM DSP nodes get memory and CPU budgets measured per audio block. Nodes that go over budget get bypassed and flagged.
- The manifest declares permissions (for example, microphone input for a "listening" toy). The user approves them for each toy.
- Curated **"Verified" shelf** in the chest for kid profiles; unreviewed mods only load in creator/explicit modes.

---

## 6. Prior art and positioning

| Project | What it nails | Lesson for us |
|---|---|---|
| **Electroplankton** (Toshio Iwai, DS) | Each "toy" is a different alien music organism | Toys > instruments; each toy's identity is its own rule |
| **Tenori-on** (Iwai / Yamaha) | Light and sound as one gesture | One parameter, two senses |
| **Chrome Music Lab** | Zero-onboarding browser experiments, used in schools | Web distribution plus education reach; open-source experiments |
| **Patatap**, **Blob Opera**, **Incredibox** | Instant delight; "no wrong notes" | Snap to tuning; reward the first touch |
| **Rez / Tetris Effect** | Synesthesia, with play quantized to the beat | Quantize player actions to the musical grid |
| **Fantasia: Music Evolved** | Gesture-driven remix for all ages | Big readable gestures; works seated |
| **PatchWorld** (PatchXR) | Modular VR music worlds, multiplayer jams, hand tracking, OSC/Link | Closest competitor in VR. But it's native-store, patch-cable heavy and leans "Max-like". We differ by being web-first, toy-first, open-source and cross-device. |
| **SoundStage VR, Electronauts, LyraVR, Moog Sound Lab** | VR music making | VR players clearly want this; most of these are solo-only and have stalled |
| **Strudel / TidalCycles, Sonic Pi, Orca, Glicol** | Live-coded generative patterns; algorave culture | Pattern mini-notation; performances as community; a Rust/WASM audio engine is feasible |
| **VCV Rack, Bespoke Synth** | Open modular ecosystems with large module libraries | Open core plus a third-party module ecosystem grows the platform |
| **Hydra, cables.gl, Shadertoy** | Shareable live visuals by URL | A URL-shareable state is a growth engine |
| **Dreams, Rec Room, Resonite/ProtoFlux, Roblox** | UGC creation tools with a visual-to-code ladder | Tiered creation; creators need ownership and payment |
| **Townscaper, Universe Sandbox** | Toy-like systems with emergent beauty from simple rules | Let simple rules carry the experience |

**The gap:** no product combines **(a)** an all-ages "toy" feel, **(b)** generative auto-playing systems, **(c)** grounding in real physics and chemistry, **(d)** cross-device web plus WebXR, **(e)** real-time multiplayer, and **(f)** an open, embeddable, moddable core. Cosmic Playground aims for all six.

---

## 7. Go-to-market

### 7.1 Open-core model

| Layer | License | Why |
|---|---|---|
| `crates/*`, `packages/engine`, `net`, `sdk`, `cli`, `embed` | **MIT OR Apache-2.0** | Rust ecosystem norm; makes commercial embedding easy for brands, museums, games and educators |
| `apps/playground` (flagship) | **MPL-2.0** (or AGPL if hosted forks become a problem) | Improvements to the app flow back; embedding is still allowed |
| Name, logo, official art and audio packs | Trademark plus **CC BY-NC** for art | Protects the brand and avoids confusing forks |
| Community toys | Creator's choice, defaulting to **CC BY 4.0** (assets) + MIT (code) | Remix culture with attribution |

### 7.2 Revenue (none of it blocks free and open play)

1. **Hosted rooms ("Cosmic Cloud"):** persistent worlds, big spectator rooms, recording/export (stems, video, Constellation archives), and stream overlays. Freemium, with a creator plan and a performer plan.
2. **Education:** a classroom edition with teacher controls, roster privacy, and lesson packs that map toys to physics, music and chemistry standards. Sold per school or district. This is where all-ages design and first-principles grounding pay off.
3. **Installations and experiences:** museum, science-centre, festival and brand activations, built on the open core. Revenue is service work plus a support SLA.
4. **Marketplace (later):** premium toy packs from creators, with a creator-friendly split (e.g. 80/20). Free toys always stay first-class.
5. **Sponsorships and grants:** GitHub Sponsors / Open Collective, arts and science-communication grants, and XR platform developer funds.

### 7.3 Community flywheel

```
open-source core ─► jams create toys ─► performances showcase toys ─► viewers try links
       ▲                                                                  │
       └──────── contributors & creators ◄── creator support & revenue ◄──┘
```

- **Toy Jams** (monthly, 72 h): each theme is a **first principle** ("Resonance", "Entropy", "Orbits", "Catalysis"), with categories for Youngest Delight, Most Lawful, Most Alien and Best Coupling. Hosted on itch.io with a Constellation link as the entry. Partners: Global Game Jam sites, Ludum Dare community, school STEAM programs.
- **Hyperjam performances** (bi-weekly streams): 2–4 performers improvise in one room, streamed in **spectator mode**. Spectators get a free camera and can push "audience energy" through a crowd toy that the performers can plug in. The performance archive doubles as marketing.
- **Algorave / TOPLAP crossover:** Strudel-style mini-notation and OSC bridges make performers from the live-coding scene welcome.
- **Toy of the Week**, a curated shelf in the chest that credits the creator in the world.
- **Creator support:** a `good-first-toy` issue label, office hours, a mod showcase, and revenue share. Small grants for educational toy packs.
- **Channels:** Discord (with a kids-safe-only policy for official spaces), GitHub Discussions, YouTube, Twitch, TikTok/Shorts clips (the 2D diorama view is made for vertical video), and Quest Browser / Meta Horizon store listing as a PWA.
- **Embed everywhere:** a `<hypertoy-world src="…">` web component lets a blog post, course or portfolio host a live, playable Constellation. Every embed links back.

### 7.4 Launch sequence

1. **Closed alpha** with about 50 creators (live-coders, XR devs, music teachers).
2. **Open-source launch day:** repo public, a web demo, and a 20-minute streamed Hyperjam with the alpha creators.
3. **Jam #1** two weeks later, with SDK docs tuned from the alpha.
4. **Education pilot** with 3–5 classrooms in the following term.
5. **First installation partner** (a science museum or festival) as a showcase.

---

## 8. Roadmap

**Reprioritised Oct 17, 2026:** multiplayer ("Together") moves ahead of XR. Playing together over a link is the core of the pitch (pillar 6, the Hyperjam go-to-market), it can be tested today on the browser and desktop builds over a free tunnel, and every other feature plan has a shared-vs-local decision that is cheaper to make before those features exist. XR follows, and inherits rooms for free.

| Phase | Duration | Scope | Exit criteria |
|---|---|---|---|
| **0. Toy prototype** | 6 wks | Rust core + DSP in an AudioWorklet; 3 toys (Spire, Orrery, Kettle); desktop and touch; single player; Pulse v1. *Largely done, plus data toys, Faust/VMA and tunings ([AUDIO-GEN.md](AUDIO-GEN.md) §14) and a minimal Tauri shell.* | Testers keep playing for 10+ minutes; audio has no dropouts on a mid-range phone |
| **1. Together** ← next | 8 wks | [MULTIPLAYER.md](MULTIPLAYER.md) M0–M5: relay on the page's own server, Yjs rooms, clock sync, pokes on a shared beat, presence, Host/Join over ngrok or cloudflared, browser + desktop. Alongside: [SAVE-LOAD.md](SAVE-LOAD.md) S1–S3 (WorldDoc is the room document), [AUDIO-MIX.md](AUDIO-MIX.md) A1–A4 (local mute/solo/focus, shared volume). | Browser and desktop players on different networks jam through a free tunnel, beat-locked within 10 ms; late join and reconnect work |
| **2. XR** | 8 wks | WebXR on Quest 3: hands and controllers, chest, MR passthrough and anchors; the three.js vs Needle bake-off; 8 toys; coupling v1; Quest joins rooms. [AVATAR.md](AVATAR.md) V1–V3 (avatar, gravity bodies) lands before or alongside, since XR locomotion reuses it. | 90 fps holds with 12 toys auto-playing; a 6-year-old and a 60-year-old can both use it without instructions |
| **2b. Together, full** | 4 wks | [MULTIPLAYER.md](MULTIPLAYER.md) M6–M7: desktop-native host, spectator mode, larger rooms, embed component | 4 players across Quest, desktop and phone stay beat-locked within one audio block |
| **3. Creators** | 10 wks | SDK v0, Toy Forge, CLI, `.htoy`, sandbox, docs-as-toys; port the official toys to the SDK; [TOY-BOOK.md](TOY-BOOK.md) community entries | An outside dev ships a new toy in under 1 day |
| **4. Open launch** | 4 wks | License, contribution guide, governance, launch Hyperjam, Jam #1 | 100 community toys within 3 months |
| **5. Sustain** | ongoing | Cosmic Cloud, education edition, installations, marketplace, native wrappers | Sustainable revenue covering the core team |

### 8.1 Feature plans, in priority order

| # | Plan | Why this position | Can run in parallel |
|---|---|---|---|
| 1 | [MULTIPLAYER.md](MULTIPLAYER.md) | The pitch; decides shared vs local for everything below | — (critical path: M0 → M1 → M2 → M3) |
| 2 | [SAVE-LOAD.md](SAVE-LOAD.md) | S1 (WorldDoc, stable toy ids) is multiplayer M1's prerequisite | S2–S4 alongside M2–M3 |
| 3 | [AUDIO-MIX.md](AUDIO-MIX.md) | Small; jams with 8 toys need mute/solo; engine changes are best made with M1's | Any time; ideally before the first multiplayer playtest |
| 4 | [TOY-BOOK.md](TOY-BOOK.md) | B1–B2 are pure UI and content; B3 needs AUDIO-MIX A1 | B1–B2 any time |
| 5 | [AVATAR.md](AVATAR.md) | V0 (Aim service, ray preview) is small and useful now; V1+ after M2 so poses, orientation and bodies go straight into the room doc | V0 any time |
| 6 | [MODES.md](MODES.md) | Puzzle mode and the Heart; P0 (the `Mode` edit seam) is small and best landed before the room binding is written against it | P0–P1 alongside M1–M2; content (P3–P4) any time after |
| 7 | [DEV-MODE.md](DEV-MODE.md) | Settings, logs, playtest notes, scenarios and CI; D0–D1 (muted dev start, logs) help debug multiplayer M2–M3, and D5 is MULTIPLAYER's headless jam | D0–D2 any time; D3 after SAVE-LOAD S1 is easiest |
| 8 | [LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md) | Couch play (mouse, gamepads, phone pads on one screen) and phone-hosted tables; seats (L0) touch Aim, undo and presence, so best after MULTIPLAYER M2 and the `intents.ts` split | L0–L2 alongside M3; L5 needs no native work; the mobile spike (PUBLISHING T0) any time |
| 9 | [FOCUS-VIEW.md](FOCUS-VIEW.md) | Focus view (selected toys on a ring, Pitch Trace, recording, presets) and the Conductor shelf; F3 shares note events with MODES P1, recording and presets sit on SAVE-LOAD S2 | F1–F4 any time; F5+ after SAVE-LOAD S2; room replay after M3 |
| 10 | [PLAYTESTS.md](PLAYTESTS.md) | The minimum for the first playtests: itch.io web + Windows builds on a hosted relay (PUBLISHING-ITCH I0–I2) and two gamepad seats on one Windows client (a cut of LOCAL-MULTIPLAYER L0–L1); guides in [guides/](guides/README.md) | R and L tracks in parallel now; beat lock (M1/M3 slice) before the second remote session |
| — | [HELP-SYSTEM.md](HELP-SYSTEM.md), [DESKTOP-MIDI.md](DESKTOP-MIDI.md) | Unchanged; the help system's event bus also serves the Toy Book's "Try this" and multiplayer presence | — |

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Quest browser CPU and thermals cause audio dropouts | Audio-first scheduling, voice limits and audio LOD, profile from week 1, and a Worker/Worklet split so rendering never blocks audio |
| SharedArrayBuffer needs COOP/COEP, which breaks some embeds | A `postMessage` transport fallback; the embed component negotiates which to use |
| No WebXR on iOS Safari | Non-XR 3D/2D modes on iOS; AR through Needle's App Clip route in the flagship, if adopted |
| Needle's license conflicts with an open core | Keep it strictly in an adapter; the core stays three.js-only |
| "Toy" turns into "DAW", and complexity creeps in | Pillar review on every feature; advanced panels stay hidden; playtest with kids every sprint |
| Network jitter breaks the feeling of playing together | Lookahead scheduling, beat-quantized events, local-first feedback with server confirmation |
| Child safety in multiplayer and UGC | Private rooms by default, no text chat for kids, a verified toy shelf, moderation tools, and a privacy-by-design legal review |
| Malicious mods | Worker sandbox, capability permissions, WASM budgets, review for the verified shelf |
| Hearing and photosensitivity | Limiter and loudness target; flash-rate limiter (WCAG 2.3); reduced-motion mode |
| Open-source maintainer burnout | Clear governance, paid core maintainers funded by Cloud and Education, and community stewards for the toy registry |

---

## 10. Success metrics

- **Delight:** time to first sound under 5 seconds; median session over 12 minutes; share of sessions where a Pulse gets set (the main sign the hypertoy idea is understood).
- **Togetherness:** share of sessions that are multiplayer; average number of players per room; jam retention.
- **Creation:** number of toys published, how many players move from Tier 0 to Tier 1 and Tier 1 to Tier 2, and the median time to a creator's first toy.
- **Reach:** number of embeds, number of Constellation link opens, stream viewers per Hyperjam.
- **Sustainability:** Cloud MRR, education seats, installation pipeline.

---

## 11. Open decisions

1. Which renderer the flagship uses: **plain three.js vs Needle Engine.** Settle it with the Phase 1 bake-off on MR quality, iOS AR, and the cost of the commercial license.
2. **Loro vs Yjs** for the room CRDT. *Provisionally Yjs for v1* ([MULTIPLAYER.md](MULTIPLAYER.md) §0): the relay is Node, awareness covers presence, and `yrs` keeps a Rust relay possible. Revisit at multiplayer step M7 with the toy param workload benchmark (Loro is Rust-native and could share code with the core).
3. Whether the flagship app is **MPL-2.0 or AGPL-3.0**. It depends on how much we worry about hosted forks.
4. Whether **Faust** gets first-class support at Tier 3 or stays community-supported.
5. Brand naming: keep "Cosmic Playground" as the product name and use "hypertoys" for the toy format and SDK (`@hypertoys/*`)?

---

## Sources (checked Oct 2026)

- Needle pricing (free for non-commercial use; Pro for commercial use; WebXR and networking on every tier): https://needle.tools/pricing
- Needle FAQ (commercial use requires a license): https://engine.needle.tools/docs/faq.html
- Needle Engine changelog (6.0.0-alpha, WebXR anchors on by default): https://engine.needle.tools/docs/reference/changelogs/needle-engine
- Needle iOS WebXR via App Clip: https://engine.needle.tools/docs/ios-webxr-app-clip.html
- Glicol (Rust DSP in the browser via WASM, AudioWorklet and SharedArrayBuffer): https://github.com/chaosprint/glicol · https://docs.rs/crate/glicol/latest
- Rust WASM AudioWorklet pattern: https://github.com/PaulBatchelor/rust-wasm-audioworklet
- PatchWorld (multiplayer VR music, OSC/Ableton Link, hand tracking): https://www.uploadvr.com/patchworld-headed-to-quest-next-week/ · https://gamespress.com/Hand-Tracking-in-PatchWorld-frees-your-hands-to-explore-rewire-tweak-a
