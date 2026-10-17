# Audio controls plan: mute, solo, focus, volume

> Four small listening controls: **mute everything**, **mute a toy**, **solo or focus a toy**,
> and **set a toy's volume**. They should feel like listening, not like using a mixing desk (pillar 1).

Status: plan · Oct 2026 · builds on [PLAN.md](PLAN.md) §4.5 (audio, safety) · interacts with [MULTIPLAYER.md](MULTIPLAYER.md) §4.1 and [TOY-BOOK.md](TOY-BOOK.md) §5

---

## 0. TL;DR

| Control | What it does | Shared in multiplayer? | Saved in the world? |
|---|---|---|---|
| **Global mute** | Silences your speakers; the engine keeps running, so the beat stays locked | No, yours | No (remembered per device) |
| **Toy mute** | You stop hearing one toy; it keeps playing, glowing and feeding couplings | No, yours | No |
| **Solo** | You hear only the soloed toy(s) | No, yours | No |
| **Focus** | The focused toy stays full, everything else ducks to about −14 dB, reverb stays | No, yours | No |
| **Toy volume** | The toy's level in the music | **Yes**: it's part of the composition | **Yes** |

Engine: one new per-slot **monitor** gain (param slot 6, currently unused) next to the existing `Gain` (slot 1), both smoothed; master gain smoothed. Monitor gain applies **after** the toy's bus tap, so muting what *you* hear never changes what a listening toy hears.

---

## 1. Goals

1. **One tap to silence** everything, and one tap to bring it back at the same volume.
2. **"Just that one"**: isolate a toy by ear without stopping anything; essential when 8 toys are playing in a jam.
3. **No clicks.** Every change ramps over about 10 ms.
4. **Readable without text.** A muted toy *looks* muted; a soloed toy *looks* singled out.
5. **Multiplayer-safe.** Your listening choices never change anyone else's sound or the room's beat.

---

## 2. What exists to build on

| Today | Where | Use |
|---|---|---|
| Master volume slider in the HUD (`World.setMaster`, sent ×0.85 to the engine) | `ui/hud.ts`, `world.ts` | Global mute sits next to it |
| Per-slot `Param.Gain` (1), applied in the mix loop, never set by the UI | `audio/abi.ts`, `engine.rs` `process()` | Becomes the toy's **volume** |
| Free param slots 6 and 7 between `Speed` (5) and `A` (8) | `audio/abi.ts` | Slot 6 becomes `Monitor` |
| Per-slot `bus` (mono, post-gain) used as audio input by VMA modules | `engine.rs` | Must stay **pre-monitor** |
| Snapshot `env` / `flash` drive visuals | `engine.rs` `write_snapshot` | Stay pre-monitor so a muted toy still glows in time |
| Master limiter | `engine.rs` | Unchanged |
| Toy panel (Pulse editor), last-touched toy in `Input` | `ui/pulse-editor.ts`, `input.ts` | Where per-toy controls and shortcuts attach |

---

## 3. Model

```
per toy:   voice ─► × volume (shared, Param.Gain) ─► bus tap (couplings, listening toys, env/flash)
                                                  └► × monitor (local, Param.Monitor) ─► pan ─► mix + reverb send
master:    mix ─► × master (local) ─► × mute ramp (local) ─► limiter ─► out
```

`monitor` for each toy is computed on the main thread from local listening state:

```
monitor(toy) =
    muted(toy)                 ? 0
  : soloSet nonempty           ? (toy ∈ soloSet ? 1 : 0)
  : focused != null            ? (toy == focused ? 1 : FOCUS_DUCK)   // FOCUS_DUCK ≈ 0.2
  : 1
```

- **Solo** is additive: soloing a second toy adds it. Clearing solo restores whatever mute/focus state was there before.
- **Focus** is one toy at a time and also brightens that toy's visuals slightly and dims the rest (respecting reduced motion).
- The **audition slot** of the Toy Book ([TOY-BOOK.md](TOY-BOOK.md) §5) uses focus: opening a toy's details focuses the preview and ducks the world.
- Reverb send is post-monitor, so a soloed toy keeps its own reverb and nothing else's.

### 3.1 Where state lives

- `World.mix`: `{ master, muted: boolean, toyMute: Set<toyId>, solo: Set<toyId>, focus: toyId | null }`, separate from the toys' shared state. A `MixState` class owns the `monitor()` formula and sends `param Monitor` only for toys whose value changed.
- Persisted in `localStorage` (`cosmic.mix`): master volume and global mute only. Per-toy mute/solo/focus reset when a world is loaded, since toy ids differ between worlds.
- **Volume** lives on the toy (`Toy.volume`, default 0.8, range 0–1) and travels with the toy in saves, variants and the room doc ([SAVE-LOAD.md](SAVE-LOAD.md) §3).

### 3.2 Engine changes

| Change | Detail |
|---|---|
| `param::MONITOR = 6` (Rust) / `Param.Monitor = 6` (TS) | Mirror `engine.rs` and `abi.ts` together |
| Per-slot smoothed gains | One-pole ramp, ~10 ms time constant, for `GAIN × MONITOR`; reset on `add` so a new toy doesn't fade in from the old value |
| Master smoothing and a **mute ramp** | `engine_set_master` sets a target; the tick ramps to it |
| Bus tap stays post-`GAIN`, pre-`MONITOR` | Move the `bus` write above the monitor multiply |
| Golden tests | Monitor defaults to 1, so fingerprints don't change |

Global mute is a gain ramp to 0, **not** `AudioContext.suspend()`: suspending would stop the engine clock and break beat lock in a room ([MULTIPLAYER.md](MULTIPLAYER.md) §5). The engine keeps rendering; CPU is unchanged.

---

## 4. UI

### 4.1 Global

- HUD speaker glyph (already beside the volume slider) becomes a **button**: tap = mute/unmute, with the glyph crossed out and the slider greyed. Dragging the slider while muted unmutes.
- When the tab is hidden, nothing changes (the jam goes on), but an optional setting "mute when hidden" exists for classrooms.

### 4.2 On the toy (in the world)

- **Hover/target a toy** (mouse, or the crosshair in avatar mode, [AVATAR.md](AVATAR.md)) shows a small **sound badge** above it for 2 s: a speaker glyph with its state. Tapping the badge cycles *on → muted → on*; long-press opens the toy's Sound row (§4.3).
- **Visual states:**
  - muted: the base ring turns dashed and the heart dims; the Form still moves with the music (the toy is playing, you just aren't hearing it);
  - soloed: a bright halo ring; non-soloed toys desaturate by ~40%;
  - focused: gentle spotlight on the toy, others dimmed ~25%;
  - volume: the base ring's thickness follows the volume.

### 4.3 In the toy's panel

The panel that opens from the heart (today's Pulse editor) gains a **Sound** row:

```
[ volume dial ]   [ mute ]   [ solo ]   [ focus ]
```

- The volume dial is a shape, not a number: a ring that fills, with a soft detent at the default.
- Mute/solo/focus are glyph toggles with clear on/off states and `aria-pressed`.

### 4.4 "Listen" sheet (advanced, hidden by default)

HUD → long-press the speaker (or `L`) opens a compact list of toys in play: icon, name, volume dial, mute, solo. This is the one mixer-like view; it stays a sheet, closed by default, and is the keyboard/screen-reader route to every control.

### 4.5 Keyboard and other inputs

| Action | Keyboard | Touch | Gamepad | MIDI (defaults, [DESKTOP-MIDI.md](DESKTOP-MIDI.md)) |
|---|---|---|---|---|
| Global mute | `M` | HUD speaker | View/Select button | — |
| Mute targeted / last-touched toy | `N` | sound badge tap | `D-pad ↓` | learnable |
| Solo targeted toy | `Shift+N` | badge long-press → solo | `D-pad ↓` hold | learnable |
| Focus targeted toy (toggle; hold = momentary) | `H` | badge long-press → focus | `D-pad ↑` | learnable |
| Clear all mute/solo/focus | `Shift+M` | Listen sheet | — | — |
| Toy volume ± | `-` / `=` | panel dial | — | CC on focused toy |

"Targeted" means the toy under the pointer or crosshair; otherwise the last-touched toy (`Input.lastToy`). Keys are ignored while typing in a text field, as today. The full shortcut table across plans lives in [AVATAR.md](AVATAR.md) §8.

---

## 5. Multiplayer

- Mute, solo and focus are **never sent**; each player has their own monitor mix.
- Volume is shared and written to the doc like any param (throttled while dragging).
- Presence can show a small "🎧" glyph on toys *someone* has soloed, so a player knows a friend is listening closely, without changing anyone's sound. Optional, M4.

---

## 6. Accessibility and safety

- All controls reachable by keyboard and labelled for screen readers; state changes announced politely ("Spire muted").
- The master limiter and loudness target (PLAN §4.5) still apply after all of this. Solo and focus never *raise* a toy above its normal level, so isolating a toy can't produce a loudness jump.
- Kid mode: no Listen sheet; mute and focus only.

---

## 7. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **A1. Engine** | `Monitor` param, smoothing for gain/monitor/master, bus tap pre-monitor | Golden tests unchanged; toggling monitor at audio rate has no clicks (spectral check for broadband energy at the switch) |
| **A2. Global mute** | HUD button, `M`, persisted | Mute → unmute returns to the same level; beat continues |
| **A3. Toy mute/solo/focus** | `MixState`, keyboard, badge, visual states | A muted Orrery keeps its planets moving in time; a soloed Spire is the only thing audible |
| **A4. Volume** | `Toy.volume`, panel dial, saved in WorldDoc | Volume survives save/load and syncs in a room |
| **A5. Listen sheet** | Advanced list, screen-reader route | Every control reachable without a pointer |

A1–A3 are small (about 2–3 days) and can be done any time; they're most useful just before multiplayer playtests.

### 7.1 Status (Oct 2026)

A1–A5 are implemented:

| Step | Where |
|---|---|
| A1 | `engine.rs`: `param::MONITOR`, per-slot smoothed `gain`/`monitor` and a smoothed master (10 ms one-pole), bus tap and `env` pre-monitor, reverb send post-monitor; tests `monitor_mutes_what_you_hear_but_not_the_bus_or_the_visuals` and `gain_and_master_ramp_without_clicks`; golden fingerprints unchanged |
| A2 | `audio/mix.ts` (`MixState`, persisted as `cosmic.mix`), HUD speaker button (tap mute, long-press Listen), `M`; global mute sends master 0 and the engine ramps it |
| A3 | `MixState` mute/solo/focus → `Monitor`; `N`, `Shift+N`, `H` (hold = momentary), `Shift+M`; toy visuals (dashed ring when muted, halo when soloed/focused, ring and heart dimmed on the others); sound badge over the aimed toy (`ui/sound-badge.ts`) |
| A4 | `Toy.volume` (default 0.8) → `Param.Gain`, ring thickness follows it, `-`/`=`, Sound row in the toy panel (`ui/sound.ts`), shared through the room doc (`net/doc.ts`) and in `ToySnapshot` |
| A5 | Listen sheet (`ui/listen.ts`, `L`): every toy's volume dial, mute, solo, focus; "Clear all"; "Mute when hidden"; screen-reader announcements (`ui/announce.ts`) |

Not done yet: gamepad and MIDI bindings (no gamepad or MIDI input exists yet), kid mode's reduced controls (no kid mode yet), the presence "🎧" glyph (M4), the Toy Book's audition focus (TOY-BOOK B3), and full-toy desaturation for non-soloed toys (only the ring and heart dim). On phones the HUD keeps the speaker and drops the slider.
