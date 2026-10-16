# Desktop build and MIDI controllers plan

> A thin native desktop shell around the playground that turns knobs, pads, keys and DIY serial
> controllers into the same **intents** a mouse or a hand produces. Controllers are another way to
> play the toys, not a way to turn them into a DAW.

Status: plan · Oct 2026 · builds on [PLAN.md](PLAN.md) §3.1 (intent layer), §4.1 (native wrappers) and §4.5 (MIDI/OSC interop)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| Shell | **Tauri 2**, in this Cargo workspace (`apps/desktop/src-tauri`). It loads the same Vite build the web uses. No forked UI. |
| Why a native bridge at all | The system webviews Tauri uses are not equal: WebView2 (Windows) is Chromium, but **WKWebView (macOS) and WebKitGTK (Linux) have no Web MIDI and no Web Serial.** A Rust bridge gives every platform the same device access, plus things browsers can't do (serial at 31 250 baud, hot-plug, multi-client ports, MIDI clock in). |
| Device I/O | `midir` for MIDI ports (WinMM/WinRT, CoreMIDI, ALSA). `serialport` for USB-serial and DIN-MIDI adapters. Each device gets its own reader thread. |
| Parsing | A new pure crate, **`hypertoy-midi`**: byte-stream parser (running status, SysEx, realtime bytes mid-message), serial framing, controller profiles and the mapping model. No I/O, so it is unit-tested and also compiled to WASM for the browser path. |
| Bridge to the page | A Tauri **`Channel`** streams compact, timestamped events into the webview. Commands (`list`, `open`, `close`, `send`) are a small allow-listed command set. |
| Inside the app | A `ControllerSource` interface with three backends: **Tauri** (desktop), **Web MIDI** (Chrome/Edge in a browser), **Web Serial** (Chromium, optional). All feed one **mapper** that emits intents: `poke`, `stretch`, `twist`, `pulse-edit`, `open-chest`, `focus`. |
| Order of work | Parser crate → **Web MIDI in the browser first** (proves the mapping UX with zero native code) → Tauri shell → serial → MIDI learn and profiles → clock and MIDI out → signed installers. |

---

## 1. Goals and non-goals

**Goals**

1. **Plug in and play.** A class-compliant controller plugged in while the app runs lights up a toy within a second, with a sensible default mapping and no setup screen.
2. **Same toys, same intents.** Controllers emit intents, exactly like `input.ts` does for pointers (PLAN §3.1). Toys never see a MIDI byte. A community toy with declared `gesture`s gets controller support for free.
3. **Feels like an instrument.** A pad hit to sound under **10 ms** on a typical desktop (input → audible), with jitter under one audio block.
4. **DIY friendly.** An Arduino or ESP32 sending raw MIDI bytes or a simple framed protocol over USB-serial works without a "Hairless"-style middleman.
5. **The web stays first.** Everything above the bridge also runs in a browser with Web MIDI. The desktop build is an upgrade, not a fork.

**Non-goals (for now)**

- Moving the audio engine out of the webview. A native `cpal` engine is listed as a later option (§9), not part of this plan.
- MPE, MIDI 2.0/UMP, and arbitrary SysEx editors. The parser keeps room for them (§3.2).
- Mobile MIDI (Capacitor). Same `ControllerSource` interface, separate plan.

---

## 2. What exists to build on

| Today | Where | Use for controllers |
|---|---|---|
| Intent layer for mouse/touch/keys: `poke`, grab, `stretch`, `twist`, open chest | `apps/playground/src/input.ts` | Controllers call the same toy methods; first refactor this into a shared intent dispatcher (§5.1) |
| `Toy.poke(strength)`, `Toy.nudge(gesture, amount)`, declared `ParamDef.gesture` and `range` | `apps/playground/src/toys/toy.ts` | Velocity → `poke`; CC → `nudge` or absolute param set |
| "Last touched toy" focus | `Input.lastToy` | The default target for unbound knobs |
| Toy slots (`World.toys`, `MAX_TOYS = 16`) | `apps/playground/src/world.ts`, `audio/protocol.ts` | Stable targets for pinned bindings |
| Worklet command protocol (`poke`, `param`, `tempo`, …) | `apps/playground/src/audio/protocol.ts` | MIDI clock → `tempo`; no protocol change needed for v1 |
| Rust workspace with pure, testable crates | `crates/*` | Home for `hypertoy-midi` and the Tauri crate |
| Planned typed event bus (`toy:poke`, `param:change`, …) | [HELP-SYSTEM.md](HELP-SYSTEM.md) §2 | Lets MIDI learn listen for "which param did the player just touch" |

---

## 3. Architecture

### 3.1 Layers

```
┌──────────────────────────── Webview (same Vite build as web) ─────────────────────────────┐
│  toys / world / AudioHost ◄── intents ◄── Mapper (profiles, bindings, learn)             │
│                                              ▲                                            │
│                         ControllerSource  ───┴───────────────┬──────────────┐             │
│                         TauriSource            WebMidiSource │ WebSerialSrc │             │
└──────────────────────────────▲───────────────────────────────┴──────────────┴─────────────┘
                               │ tauri::ipc::Channel<Batch>  (events)   invoke() (commands)
┌──────────────────────────────┴─────────── Native shell (Rust, Tauri 2) ───────────────────┐
│  bridge: device registry · hot-plug poller · per-device reader threads · timestamping     │
│      midir (MIDI ports)                     serialport (USB-serial, DIN adapters)          │
│                           └──── hypertoy-midi (parse, frame, profiles) ────┘               │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The rule from PLAN §4 holds: **pure logic in Rust crates, device and UI glue at the edges.** The bridge does not know what a toy is. It turns bytes into `MidiEvent`s with timestamps and hands them over.

### 3.2 `crates/hypertoy-midi` (new, pure)

```
hypertoy-midi/src/
  event.rs     MidiEvent { t_us: u64, device: u16, msg: Msg }
               Msg = NoteOn{ch,note,vel} | NoteOff | Cc{ch,cc,val} | PitchBend{ch,val}
                   | Aftertouch | Program | Clock | Start | Stop | Continue | SysEx(range)
  parse.rs     streaming byte parser: running status, realtime (0xF8–0xFF) interleaved
               inside other messages, SysEx 0xF0…0xF7, NoteOn vel 0 → NoteOff, resync on garbage
  serial.rs    serial framings: RawMidi (bytes as-is), Slip (DIY sensors: id + f32 value)
  nrpn.rs      14-bit CC pairs (MSB/LSB) and NRPN assembly, opt-in per binding
  relative.rs  relative-encoder decoding: two's complement, sign-magnitude, binary offset
  profile.rs   controller profiles (serde): port-name match → default bindings, encoder modes
  clock.rs     MIDI clock → tempo estimate (24 ppqn, smoothed, with outlier rejection)
```

- `#![no_std]`-friendly core with an `alloc` feature, so it compiles to `wasm32-unknown-unknown` beside `hypertoy-wasm` for the browser sources. One parser, one set of tests.
- Fuzz the parser (`cargo fuzz`) — serial input from DIY hardware is untrusted, noisy and often mid-message when a port opens.
- MIDI 2.0 / UMP: keep `Msg` an enum so a UMP decoder can be added later without touching the mapper.

### 3.3 Native shell: `apps/desktop/src-tauri`

**Device registry and hot-plug.** `midir` has no hot-plug callback, so a poller lists MIDI input ports and serial ports every 1 s and diffs them by a stable id (port name + index, plus USB VID/PID/serial number for serial). New devices emit `device:added`; vanished ones close their reader and emit `device:removed`. Previously enabled devices reopen automatically when they reappear.

**Reader threads.** One thread per open device:
- MIDI: `midir` callback already runs on its own thread and delivers whole messages with a timestamp. Feed it through `hypertoy-midi::parse` anyway, for one code path and SysEx reassembly.
- Serial: blocking `read` with a short timeout, into the streaming parser. Port settings come from the device's profile or the device picker: baud (31 250 for DIN-MIDI adapters, 115 200 for Hairless-style Arduino sketches, anything for custom), framing (`RawMidi` | `Slip`).
- Every event is stamped with a single monotonic clock (`Instant` since shell start, in µs) **at read time**, before any queueing.

**Batching to the webview.** Reader threads push into one lock-free MPSC queue. A forwarder thread drains it and sends a `Batch` over a Tauri `Channel` whenever it has events, at most every 1 ms (and immediately for note-ons, which are latency-critical). The batch is a compact binary layout (packed `u32`s), not JSON per message, so a busy controller sending 14-bit CCs does not flood the IPC.

**Commands (invoke).** `midi_list`, `midi_open(id, opts)`, `midi_close(id)`, `midi_send(id, bytes)` (Phase D5), `serial_list`, `bridge_clock_sync()`. Declared in a Tauri **capability file** scoped to the main window only. No shell, filesystem or HTTP plugins are enabled for this feature.

**Platform notes.**
- **Windows:** classic WinMM ports are single-client: if a DAW has the controller open, we can't. Enable `midir`'s WinRT backend where available (also gives Bluetooth LE MIDI), and use **Windows MIDI Services** multi-client ports once its Rust bindings are stable. Show "in use by another app" instead of failing silently.
- **macOS:** CoreMIDI is multi-client and includes Bluetooth MIDI. Hardened runtime + notarization are needed; serial needs no entitlement outside the sandbox (we ship outside the Mac App Store first).
- **Linux:** ALSA sequencer via `midir`; serial needs the user in `dialout`/`uucp`. The device picker explains this when `open` returns a permission error.

### 3.4 Inside the webview

```
apps/playground/src/controllers/
  source.ts         interface ControllerSource { devices(); open(id, opts); onEvent(cb); onDevices(cb) }
  tauri-source.ts   Channel + invoke; only loaded when window.__TAURI_INTERNALS__ exists
  webmidi-source.ts navigator.requestMIDIAccess(), decoded with hypertoy-midi (WASM)
  webserial-source.ts  navigator.serial (Chromium only), same parser
  clock.ts          bridge µs ↔ AudioContext time offset (§4)
  mapper.ts         MidiEvent → Intent, using bindings + profiles
  bindings.ts       binding model, persistence, MIDI learn state machine
  profiles/         default profiles (JSON) for common controllers
  ui/devices.ts     device picker and status lights in the HUD
```

`main.ts` picks the source once at startup: Tauri if present, else Web MIDI if available, else none (the HUD hides the controller icon). The rest of the app never asks which one it got.

---

## 4. Latency and timing

Budget, pad hit → sound, on a mid-range Windows laptop:

| Stage | Target |
|---|---|
| USB / driver → `midir` callback | 1–2 ms (device-dependent, outside our control) |
| Reader → forwarder → `Channel` → webview main thread | ≤ 2 ms |
| Mapper → `AudioHost.post` → worklet | ≤ 1 ms |
| Worklet block quantization (128 frames @ 48 kHz) | ≤ 2.7 ms |
| Output buffer | ~3–5 ms (`latencyHint: "interactive"`) |

**Timestamps, not arrival time.** The page keeps an offset between the bridge clock and `AudioContext.currentTime`, refreshed every few seconds with `bridge_clock_sync()` (round-trip, take the fastest of N samples). The mapper can then schedule a poke at `stamp + fixed lookahead` instead of "whenever IPC arrived." This trades ~2 ms of constant delay for removing IPC jitter, which matters more for drum pads and for Pulse sync. It is a per-profile toggle: pads on, knobs off (knobs want lowest latency, jitter is inaudible).

This needs one protocol addition: an optional `at` (audio time) on the worklet `poke` command, so the engine can apply it at the right sample inside a block. Mirror the change in `crates/hypertoy-wasm/src/engine.rs` and `audio/protocol.ts` together, as that file asks.

**Main-thread risk.** IPC lands on the webview main thread, which also renders. A long frame (Kettle field upload, GC) delays MIDI. Mitigations, in order: keep render work bounded (already a goal), move the mapper to the existing Worker if profiling shows > 4 ms stalls, and only then consider a `SharedArrayBuffer` ring straight into the worklet (Tauri can set COOP/COEP on its custom protocol, which avoids the embed problem from PLAN §9).

**MIDI clock in.** `0xF8` at 24 ppqn → `hypertoy-midi::clock` → smoothed BPM → the existing `tempo` command. `Start`/`Stop` toggle all Pulses. The world follows the external clock only when the player turns on "follow clock" in the device panel; otherwise clock bytes are ignored. Phase alignment (not just tempo) with the world's beat clock is a D5 item.

---

## 5. Mapping: MIDI → intents

### 5.1 Prerequisite refactor

Split `input.ts` into **device adapters** and a shared **intent dispatcher** (`intents.ts`): `poke(toy, strength)`, `nudge(toy, gesture, amount)`, `setParam(toy, param, value01)`, `focus(toy)`, `togglePulse(toy)`, `openChest()`. Pointer input and controllers both call the dispatcher, and the dispatcher emits the event-bus events planned in HELP-SYSTEM §2. That keeps one place where "the player did X" is decided, and MIDI learn gets its "what did they just touch" signal for free.

### 5.2 Default mapping (no setup)

| Control | Intent | Target |
|---|---|---|
| Note on (keys or pads) | `poke(velocity / 127)`; the note picks the harmonic for toys with a `touch-node` gesture (Spire), otherwise just strikes | Focused toy |
| Pads 1–8 (profile-defined) | `focus(slot n)` when held with the profile's shift pad; otherwise poke slot n directly | Toy in slot n |
| Absolute knob / fader (CC) | `setParam`, scaled into the param's declared `range`, with **soft takeover** (pickup) so a knob doesn't jump the value | Focused toy's params in declaration order: first `stretch` param, then `twist`, then the rest |
| Relative encoder | `nudge(gesture, delta × step)` | Same as above |
| Mod wheel | `nudge("twist")` | Focused toy |
| Pitch bend | Temporary detune, springs back on release | Focused toy |
| Sustain pedal (CC 64) | Hold: toy keeps ringing; tap: `togglePulse` | Focused toy |
| Transport play/stop | Start/stop all Pulses | World |
| Profile "chest" button | `openChest()` | — |

Focus follows the last toy touched by any device, as `lastToy` does today, and shows as a soft halo so it is obvious which toy the knobs drive.

### 5.3 MIDI learn and bindings

- **Learn:** long-press (or right-click) a toy part or a Pulse editor control → "Listen for a control" → move a knob or hit a pad → bound. Pure gesture-first; the text is a caption, per pillar 7.
- A binding is `{ device match, msg match (ch, type, number), target (slot | focused), param or intent, curve, range, mode (absolute | relative | toggle | momentary) }`.
- Bindings are stored **per controller** (by profile id or port name) in local storage, and optionally inside a **Constellation**, so a performer's rig travels with their saved world. Bindings referencing a slot survive a reload because slots are stable.
- **Multiplayer (Phase 2):** controllers only drive the local player's own toys or the toy they focus; intents go through the same path as pointer intents, so the CRDT layer needs nothing special.

### 5.4 Profiles

JSON files in `controllers/profiles/` matched by port name regex (and USB VID/PID for serial devices). Each lists encoder modes, pad note numbers, the shift and chest buttons, and default bindings. Ship a small set of popular, cheap controllers first (a 25-key keyboard with pads and knobs, a fader/knob box, an 8-pad drum controller) plus a **generic** profile used when nothing matches. Community profiles are plain JSON, so they fit the Tier 1–2 modding ladder in PLAN §5.1.

---

## 6. Serial devices

Most modern controllers, including Teensy / Pro Micro / RP2040 boards running USB-MIDI firmware, are **class-compliant MIDI** and show up as MIDI ports, not serial. Serial is for:

1. **DIN-MIDI via a USB-serial adapter** (or a board's UART bridge): 31 250 baud, `RawMidi` framing.
2. **Arduino sketches that print MIDI bytes** at 115 200 baud (the old Hairless MIDI setup): `RawMidi` framing, baud configurable.
3. **DIY sensors** (distance, light, accelerometers, capacitive touch) that aren't musical at all: `Slip` framing, each packet `{ sensor id: u8, value: f32 }`. The mapper treats a sensor like a high-resolution CC, so it binds through MIDI learn just like a knob. A tiny reference sketch ships in `hardware/arduino/hypertoy-sensor/`.

Safety rules for serial:
- **Never auto-open** a serial port. Lots of unrelated devices are serial (3D printers, GPS, modems). Ports show in the picker; the player enables one once and it is remembered by VID/PID/serial number.
- Opening a port does not toggle DTR by default (many Arduinos reset on DTR); it is an option for boards that need it.
- Bad bytes resync the parser; a port that produces only garbage for 2 s shows "wrong speed?" with the common baud rates as one-tap choices.

---

## 7. UX

- **HUD:** a small controller glyph appears when any device is connected; it pulses on input, so the player can see the controller is alive even before anything is mapped.
- **Device panel** (from the glyph): each device with an on/off switch, its profile, "follow clock," and for serial the baud/framing. No more than this on the first screen; advanced binding edits live behind "Edit bindings."
- **Hot-plug toast:** "Keyboard connected — the focused toy is listening." with the focus halo flashing once.
- Accessibility (PLAN pillar 7): a foot pedal or a single big pad can drive the whole game through focus-cycling + poke, which makes MIDI a real accessibility input, not just a pro feature. Include a "switch access" profile (two buttons: next toy, poke).
- The volume limiter and flash-rate limiter apply unchanged; velocity curves cap at the same loudness as a hard mouse poke.

---

## 8. Build, packaging and repo layout

```
apps/desktop/
  package.json          scripts: dev (tauri dev against the playground's Vite server), build
  src-tauri/
    Cargo.toml          workspace member; deps: tauri 2, midir, serialport, hypertoy-midi
    tauri.conf.json     frontendDist → ../../playground/dist; devUrl → playground dev server
    capabilities/main.json   only the bridge commands
    src/main.rs, bridge/{mod,registry,midi,serial,forward,clock}.rs
crates/hypertoy-midi/   (§3.2)
apps/playground/src/controllers/  (§3.4)
hardware/arduino/hypertoy-sensor/ (§6)
```

- Root scripts: `npm run desktop` (dev) and `npm run desktop:build`. Add both to `.claude/launch.json` and [DEVELOPING.md](DEVELOPING.md).
- `hypertoy-midi` joins the existing `cargo test`; `apps/desktop` builds in CI on Windows, macOS and Linux runners.
- Installers: NSIS/MSI on Windows (code signing certificate needed to avoid SmartScreen warnings), notarized `.dmg` on macOS, AppImage/`.deb` on Linux. The Tauri updater plugin with signed update manifests in D5.
- License: the shell and `hypertoy-midi` follow the core's MIT/Apache-2.0; the bundled app follows the flagship app license (PLAN §11.3).

---

## 9. Phasing

| Phase | Scope | Exit criteria |
|---|---|---|
| **D0 — Parser** | `hypertoy-midi`: parser, relative/14-bit decoding, clock estimator, profiles model; WASM build; fuzzing | Parser passes a corpus of real controller captures and 1 h of fuzzing with no panics |
| **D1 — Web MIDI first** | `intents.ts` refactor; `ControllerSource` + `WebMidiSource`; mapper with the default mapping (§5.2); focus halo; HUD glyph | In Chrome/Edge, plugging in a keyboard plays the focused toy with zero setup |
| **D2 — Desktop shell** | `apps/desktop` Tauri app loading the playground; bridge with `midir`, hot-plug, Channel batching, clock sync; `TauriSource` | Same experience as D1 on Windows **and macOS**; pad → sound under 10 ms measured with a loopback test |
| **D3 — Serial** | `serialport` reader, RawMidi + Slip framings, device picker settings, reference Arduino sketch | A DIN keyboard through a USB-serial adapter and the sensor sketch both work and survive unplug/replug |
| **D4 — Learn and profiles** | MIDI learn, bindings persistence (local + Constellation), soft takeover, 3 shipped profiles + generic + switch access | A tester maps an unknown controller to 4 params in under 1 minute without reading anything |
| **D5 — Clock, out, ship** | Clock follow with phase alignment, MIDI out (toy triggers → notes, per PLAN §4.5), scheduled-poke `at` field, signed installers, auto-update | A DAW and the playground stay beat-locked for 10 minutes; installers pass signing/notarization |
| *Later* | Native audio engine via `cpal` running `hypertoy-dsp` directly (webview only renders); OSC + Ableton Link in the same bridge | Decide after D2 latency numbers |

D1 can run in parallel with D0 by using a minimal TypeScript parser first and swapping in the WASM one at the end of D0.

---

## 10. Testing

- **Unit (Rust):** parser against recorded byte captures (running status, SysEx split across reads, realtime bytes inside a note-on, garbage resync); relative encoder modes; clock estimator against jittered synthetic clocks.
- **Unit (TS):** mapper and binding resolution with fake sources; soft takeover; learn state machine.
- **Bridge integration:** a virtual MIDI port (loopMIDI on Windows, IAC on macOS, `snd-virmidi` on Linux in CI) driven by a test script; assert events arrive in order with monotonic timestamps; unplug simulation by closing the virtual port.
- **Latency harness:** send a note on a virtual port, detect the onset in the app's audio output via loopback, report p50/p95. Run it on every D2+ release candidate.
- **Hardware playtests:** the three profiled controllers, one cheap no-name keyboard, one DIN adapter, one Arduino. Include a kid with a pad controller (pillar 7: no reading needed).

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Webview main-thread stalls add jitter | Timestamped scheduling (§4); move the mapper to the Worker; SAB ring as a last step |
| Windows single-client MIDI ports conflict with DAWs | WinRT / Windows MIDI Services backends; clear "in use" status |
| Serial auto-detection grabs the wrong device | Never auto-open serial; explicit enable, remembered by VID/PID |
| Controllers push the game toward "DAW" | Default mapping is intents only; bindings editor stays behind a second click; pillar review per PLAN §9 |
| Two desktop stacks to maintain | The shell is ~1 kLOC of Rust glue; all logic is in `hypertoy-midi` and the shared TS layer, and the web path exercises it daily |
| Code-signing cost and friction | Budget certificates in D5; unsigned dev builds for testers until then |

---

## 12. Open questions

1. **Tauri vs Electron.** Electron would give Web MIDI and Web Serial on every OS with no native bridge, at ~10× the download size and a second runtime (Node) beside the Rust core. This plan picks Tauri because the bridge is small and also unlocks things Chromium can't do (31 250-baud serial, multi-client ports, a path to native audio). Revisit if the bridge grows past its budget.
2. Should notes on a keyboard play the focused toy **in pitch** (snapped to the world Tuning, overriding the toy's own Law for that strike), or only choose among its lawful pitches (e.g. the Spire's harmonics)? The second keeps pillar 2 ("alien but lawful"); the first is what players with keyboards will expect.
3. Do bindings belong to the **player** (follows their rig across worlds) or to the **Constellation** (follows the world)? Proposal: player by default, with an opt-in "save my mapping with this world."
4. Do we ship a desktop build before roadmap Phase 3 (Creators), or keep it a tester/performer build until the open launch?
