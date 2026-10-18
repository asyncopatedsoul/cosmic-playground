# Focus view and conductor plan

> **Focus view** pulls one or more toys out of the world and onto a ring in the middle of the screen, so a new
> player can explore one toy in depth and an advanced player can see exactly what a group of toys is doing.
> It has four windows you can open or close: a **Pitch Trace** (pitch in Hz over time, one line per sounding
> voice, with beat and Pulse marks), **Record** (audio takes and replayable sequences), **Recording settings**
> (formats, locations, quick save) and **Presets** (one toy or the whole group). Outside focus view, the
> **Conductor** shelf holds everything you made there, so you can bring it back into a jam with one tap.

Status: plan · Oct 2026 · builds on [AUDIO-MIX.md](AUDIO-MIX.md) (mute/solo/focus), [SAVE-LOAD.md](SAVE-LOAD.md) §3 and §6 (WorldDoc, ToyTemplate), [MODES.md](MODES.md) §3.3 (note events), [MULTIPLAYER.md](MULTIPLAYER.md) §5 (beat-stamped events), [DEV-MODE.md](DEV-MODE.md) §6.4 (recorder) · interacts with [TOY-BOOK.md](TOY-BOOK.md) §5 and [DESKTOP-MIDI.md](DESKTOP-MIDI.md)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| What focus view is | A **local view**, not an edit. The selected toys get a *display pose* on a ring around the orbit target. Their saved and shared positions don't change, so nobody else in a room is affected, and leaving focus view puts them back. |
| Selecting | `Shift+click` adds or removes toys from the selection; `F` enters focus view with the selection, or with the targeted toy if nothing is selected. You can also enter from the toy panel, the Listen sheet, or the quick-select menu. |
| Layout | 1 toy sits in the centre. With n ≥ 2, toys sit evenly spaced on a circle of radius `r = max(R_MIN, n·SPACING / 2π)`, and the camera frames the whole ring. The rest of the world dims and drifts back; it keeps playing. |
| Cycling | `Tab` / `Shift+Tab`, the **‹ ›** arrows on the focus bar, and the **quick-select menu** (a strip of toy icons) all move the **lead** toy. The ring turns so the lead faces the camera; the lead gets the toy panel and is highlighted in every window. |
| Listening | Entering applies AUDIO-MIX focus to the **set**: selected toys full, everything else ducked about −14 dB. One tap switches to solo the set, or solo the lead. Pan follows the ring, so a chord spreads across the speakers. |
| Pitch Trace | A scrolling graph: x = beats, y = log Hz with the world Tuning's degrees as faint lines. One line per **emitter** (a voice, a planet, a bubble), coloured by toy. Toggles: beat/bar grid, Pulse **cadence** marks (auto-played vs hand-played), interval labels on chords, cents-off ticks. |
| Record | Two kinds of recording. A **Take** is audio (WAV by default, WebM/Opus optional; the mix, or one stem per selected toy). A **Sequence** is the beat-stamped list of what was played and changed (pokes, params, Pulse, pattern, volume). It replays through the engine, so it still follows a later tempo or Tuning change, and it exports to MIDI. |
| Settings | One window: format, bit depth, stems on/off, reverb in stems, "record what I hear" vs "record the music", count-in, length, naming pattern, default location. **Quick save** writes with the current settings to the default location in one click. |
| Presets | One toy → a **variant** (`ToyTemplate`, SAVE-LOAD §6). The whole group → an **Ensemble** (several templates, their relative layout, optionally tempo, Tuning and attached Sequences). Both appear in the chest and on the Conductor shelf. |
| Conductor | Outside focus view, a shelf (`O`) with three rows: Takes, Sequences, Presets. Tap a card to launch it **on the next bar**: a Take plays as audio, a Sequence plays its toys, an Ensemble places its toys. Cards can be grouped into **cues** that launch together. |
| Engine changes | (1) The note events that subscribed slots already forward (`{ t: "notes" }`, `[slot, beat, hz, vel]`) gain three fields: emitter, sounding time and source (Pulse or hand). (2) A **record tap**: the mix and per-slot stems, pre- or post-monitor, sent in chunks to a recorder Worker. (3) A second worklet input, a **tape bus**, so Takes play through the master gain and limiter. |
| First milestone | F1–F3 (selection, ring, cycling, Pitch Trace) work without any storage. Record and presets need SAVE-LOAD S1/S2 (WorldDoc and IndexedDB) first. |

---

## 1. Goals

1. **One toy, deeply.** A new player can take a single toy, see it large and alone, hear it on its own, and watch what each handle does to its pitch and rhythm.
2. **Several toys, precisely.** An advanced player can line up two to eight toys (twelve on desktop) and see their pitches, chords and rhythms against the beat, which shows where they agree, clash or drift.
3. **Keep what you find.** Anything that sounded good in focus view can be kept in two clicks, as a recording, a replayable sequence or a preset.
4. **Play it back in the jam.** What you kept is one tap away outside focus view, launched on the beat.
5. **Never disturb a room.** Entering, cycling, graphing and recording are yours alone. Only actions that change the music (launching a Sequence, placing an Ensemble) touch shared state, and they follow the room's edit rules.

### 1.1 Toys, not a DAW (pillar 1)

PLAN §1 says nothing should look like a mixer, piano roll or DAW. Focus view is where this plan stretches that rule, on purpose, for players who want it:

- **The ring is the default and needs no windows.** For a new player, focus view is just "my toy, big, alone, with arrows to the next one". Every window starts closed, except that the Trace opens by default for players who have used the Listen sheet.
- Windows are drawn as **instruments in the scene's style** (the Trace looks like a star chart or a seismograph, not a grid of rectangles) and they read without text.
- **Kid mode** gets focus view with the ring, the arrows and the Presets window (big "keep this toy" button). It does not get the Trace, the Record window or the settings.

### Non-goals (v1)

- Editing recorded audio (cutting, fades, effects). Takes are kept or deleted whole. Sequences can be trimmed (§6.5), nothing more.
- A timeline or arrangement view. The Conductor launches things; it does not lay them out along a song.
- Sharing audio Takes through a room (they are large; §9.2). Sequences and presets are small and can be shared.
- Video recording. It belongs with "Cosmic Cloud" recording/export (PLAN §8).

---

## 2. What exists to build on

| Today | Where | Use |
|---|---|---|
| Orbit rig with `target`, azimuth, elevation, `setOrbit`, `orbitPose` | `render/stage.ts` | Aim at the ring centre and frame it; tween in and out |
| `Toy.selected` (set by the toy panel only) | `toys/toy.ts`, `ui/pulse-editor.ts` | Becomes the multi-selection's highlight |
| Pan from the toy's on-screen position, re-sent as the camera moves | `Toy.sendPan` in `toys/toy.ts` | A display pose gives ring-based stereo with no new code |
| `MixState`: mute, solo set, one focused toy, `FOCUS_DUCK` | `audio/mix.ts` | Extend focus from one toy to a set |
| Listen sheet listing every toy in play | `ui/listen.ts` | Entry point and screen-reader route to the selection |
| Snapshot every 3 blocks (≈8 ms): `freq`, `env`, `flash`, `step`, `pulseOn`, planet angles, flashes and periods | `audio/protocol.ts` `Snap`, `audio/worklet.ts` | Continuous pitch for sustained voices, Pulse steps, planets as emitters |
| Note subscription: `{ t: "notes"; slots }` makes the engine report every note of those slots (Spire plucks, each Orrery planet, each Kettle bubble); the worklet beat-stamps them sample-exactly and attaches `[slot, beat, hz, vel]` to the next snapshot; `AudioHost.onNotes` receives them | `engine.rs` `set_report_notes`, `audio/worklet.ts`, `audio/host.ts`, `abi.ts` `NOTE_STRIDE` (REVISIONS R2.3) | The Trace's data source; it needs three more fields per note (§8.1) |
| `ToySnapshot` and `World.applyState` | `world.ts` | Sequence start states; Ensemble members |
| `ToyTemplate` and `WorldDoc` (planned; nothing persists yet besides `prefs.ts`) | SAVE-LOAD §3, §6 | Presets and storage depend on S1/S2 |
| Pokes sent as room events; beat-stamped pokes planned (`pokeAt`) | `net/doc.ts`, MULTIPLAYER §5.2 | Sequence playback schedules pokes on beats the same way |
| Scenario recorder that turns `player.*`/`toy.*` log events into steps | DEV-MODE §6.4 | Same idea for Sequences, with beat stamps instead of `wait` steps |
| Keys unused today: `F`, `T`, `K`, `P`, `O` | `input.ts` | Focus view and Conductor bindings (§10) |

---

## 3. Selection and entering

### 3.1 Selection

- `World.selection: Set<toyId>`, local, never saved or shared. A selected toy shows the bright ring that `Toy.selected` draws today.
- **Desktop:** `Shift+click` a toy to add or remove it; `Shift+drag` on empty ground draws a lasso; `Esc` clears.
- **Touch:** long-press a toy → "Select"; after that, taps add or remove until you tap empty ground.
- **Avatar mode:** `Shift+click` on the aimed toy, as on desktop.
- **Listen sheet:** each row gets a select checkbox, so the whole selection can be made by keyboard or screen reader.
- In a room, other players see nothing; selection is not presence.

### 3.2 Entering and leaving

| Way in | Selection used |
|---|---|
| `F` | The selection, or the targeted / last-touched toy if nothing is selected |
| Toy panel → **Focus** glyph | That toy, plus the selection if it is in it |
| Listen sheet → **Focus selected** | The checked rows |
| Conductor → long-press an Ensemble → **Focus** | The Ensemble's toys, after placing them |

`F` again, `Esc` (when no window has keyboard focus) or the **×** on the focus bar leaves. Leaving tweens each toy back to its world position, restores the camera's previous pose, and restores the mix to what it was before entering.

Entering exits avatar mode first (the orbit rig is the focus camera) and remembers it, so leaving goes back to the avatar where it was.

---

## 4. The ring

### 4.1 Layout

```
n = 1            n = 3                 n = 6
                   ●                   ●   ●
   ●            ●     ●              ●       ●
                                       ●   ●
```

- Centre `C` = the current orbit target projected to the ground (or the world origin if the target is far away). The ring is always flat on the ground plane, facing the camera's starting azimuth.
- Radius `r = 0` for n = 1, else `max(R_MIN, n·SPACING / 2π)` with `SPACING` ≈ 1.6× the largest toy footprint in the set and `R_MIN` ≈ 2.2 world units. Toy `i` sits at angle `θ_i = θ_lead + 2πi/n`.
- Up to `RING_MAX` toys: **8** on phones and touch screens, **12** on desktop (§15.1). Selecting more shows a gentle "N at a time" note and keeps the first N; the quick-select menu still lists the rest (§5) so you can swap one in.
- Camera: elevation ≈ 25°, distance chosen so the ring (seen as an ellipse from that height, plus the toys' height) fills about 70% of the screen's width and 75% of its height, or 60% of the height above the Trace while the Trace is open; with the Trace open the camera also aims nearer, so the ring sits above it. On a phone in portrait, the ring is squashed into an ellipse (x radius 1, z radius 0.7) so it fits. Resizing or rotating re-frames it.

### 4.2 Display pose, not a move

Each toy gets `Toy.view: { pos, t } | null`. When set, the render loop places `group.position` at the display pose instead of the toy's world position; `moveTo`, `ToyEdit "pos"` and the room doc keep using the world position (`Toy.home`). This keeps three things right:

- **Rooms:** your focus view never moves anyone else's toys. If another player moves a toy that is on your ring, its home changes and it stays on your ring.
- **Saves:** a world saved during focus view has the real positions.
- **Pan:** `sendPan` already projects `group.position`, so each toy pans by where it sits on the ring. Turning the ring (§5) moves the stereo image with it.

Dragging a toy in focus view does nothing to its position (handles still work). A **Pin to world** action on the focus bar writes the ring layout as real positions, for a player who wants the arrangement to stay; it is an ordinary edit, gated by `canEdit`.

### 4.3 The rest of the world

- Non-selected toys fade to 25% brightness, desaturate, and are pushed back along the camera ray by a few units so the ring reads as foreground. They keep playing and keep their visuals in time.
- Couplings between two ring toys are drawn bright; couplings from a ring toy to an outside toy are drawn faint, leading off the ring.
- The ground gets a soft disc under the ring so it feels like a stage.
- Reduced motion: no drift and no tween; the change is a cross-fade.

### 4.4 Listening

`MixState` grows `focusSet: Set<toyId>` alongside today's single `focus`; `monitor()` treats the set like the single focus (in set → 1, else `FOCUS_DUCK`). The focus bar has a three-way listen switch:

| Setting | Monitor |
|---|---|
| **Set** (default) | Ring toys full, others ducked |
| **Solo set** | Only ring toys |
| **Solo lead** | Only the lead |

Leaving restores the previous `MixState` exactly. Mute on a ring toy still works as usual.

---

## 5. Cycling: the lead toy

One ring toy is the **lead**. It is the one facing the camera, the one whose toy panel is open, and the one drawn boldest in every window.

| Control | Next | Previous | Pick |
|---|---|---|---|
| Keyboard | `Tab` | `Shift+Tab` | `1`–`8` (by ring order; on desktop `9` and `Shift+1`–`Shift+3` for 9–12) |
| Focus bar | **›** | **‹** | Quick-select menu |
| Touch | Swipe left on the focus bar | Swipe right | Quick-select menu |
| Gamepad | `RB` | `LB` | Hold `Y` + D-pad |
| MIDI | learnable | learnable | learnable |

- Changing the lead turns the ring (about 300 ms, eased) so the new lead comes to the front; with n = 1 nothing moves.
- The **quick-select menu** is a strip of toy icons along the focus bar, in ring order, with the lead raised. Tapping one makes it the lead. A **+** at the end lists toys in the world that aren't on the ring; picking one adds it (or swaps it for the selected icon when the ring is full). Dragging an icon out of the strip removes that toy from the ring.
- `Tab` normally opens the chest (`input.ts`). In focus view `Tab` cycles instead, and the chest stays on its HUD button. This is the only key whose meaning changes, and the focus bar shows a small `Tab ›` hint the first three times.
- Digits `1`–`8` are free outside avatar mode, and focus view always leaves avatar mode, so they don't collide with the hotbar.

---

## 6. Windows

Four windows, each opened by a glyph on the focus bar or a key. They dock around the ring: the Trace along the bottom, Record and Presets on the right, Settings over Record. On a phone, one window at a time slides up as a sheet over the lower half and the ring moves up. Window layout and which windows are open are remembered per device (`cosmic.focus.windows`).

| Window | Key | Glyph |
|---|---|---|
| Pitch Trace | `T` | a wave over a horizon |
| Record | `K` (`Shift+K` starts or stops recording without opening it) | a red dot |
| Recording settings | from the Record window's gear | a gear |
| Presets | `P` | a fan of cards |

### 6.1 Pitch Trace

```
 Hz
 880 ┤· · · · · · · · · · · · · · · · · · · · · · · · · ·  ← scale degrees (faint)
 660 ┤        ●━━━━━━━━━━       ●━━━━━━━━━         ●━━━━━    Bowl voice 2
 523 ┤ ●━━━━━━━━━━━━━  ●━━━━━━━━━━━━━  ●━━━━━━━━━━━━━━━      Bowl voice 1      ┐ 5:4
 440 ┤ ○──────○──────○──────○──────○──────○──────○──────     Spire (Pulse)     ┘
 330 ┤   ◆      ◆           ◆      ◆           ◆      ◆     Orrery planet 2
     └┴──────┼──────┼──────┼──────┴──────┼──────┼──────┼──── beats
      bar 1                       bar 2                        now ▸
```

**Data**

- **Notes** come from engine note events (§8.1): onset beat, Hz, velocity, emitter, expected sounding time. Each note draws as a dot at its onset and a line that holds its Hz for the sounding time, fading with the velocity envelope.
- **Continuous pitch** for voices that glide or sustain (a bowed Spire, a Kettle drone) comes from the snapshot's `freq`, sampled at the snapshot rate and drawn as a line that follows it.
- **Emitters.** One line per emitter, so a chord shows as stacked lines and a melody as one line that moves. An emitter is a voice index within a toy: a patch voice, an Orrery planet, a Kettle bubble voice, a Spire harmonic. Colour = the toy's colour; each emitter gets its own shade and, if the toy has more than 4, a dash pattern.
- A ring buffer of the last 4096 notes and 60 s of continuous samples per toy. Only ring toys are subscribed, so there is no cost when focus view is closed.

**Axes**

- **y:** log₂ Hz, auto-ranged to the ring's pitches with an octave of headroom, pinch or scroll to zoom. Labels in Hz; a **Names** toggle adds scale degree numbers or note names from the world Tuning. Faint horizontal lines at every scale degree of the Tuning, brighter at the root.
- **x:** beats, scrolling right to left with "now" at the right edge. Window of 2, 4, 8 or 16 bars.

**Toggles**

| Toggle | Default | What it draws |
|---|---|---|
| **Beat grid** | on | A line per beat, stronger per bar, with the BPM in the corner. Follows tempo changes (the grid spacing changes at the beat where the tempo changed). |
| **Cadence** | on | Each toy's Pulse steps as small ticks along its lane, from `step` / `pulseOn` in the snapshot. Notes played by the Pulse are **hollow** (○); notes from a hand poke, a coupling or another player are **filled** (●). Probability shows as tick opacity. |
| **Intervals** | off | When two or more emitters sound at once, a bracket on the right edge with the ratio to the lowest note (3:2, 5:4, 7:4…) or the interval in steps of the Tuning. |
| **Cents** | off | A small tick beside each note showing how far it is from the nearest scale degree (useful in wild mode and with custom tunings). |
| **Lead only** | off | Greys out every toy except the lead. |

**Interaction**

- Hover or tap a note: Hz, scale degree, cents off, velocity, which emitter, auto or hand.
- **Freeze** (`Space` while the Trace has focus, or the pause glyph) stops the scroll without stopping the music; drag to scrub back through the buffer; unfreeze jumps to now.
- **Export**: PNG of the current view, CSV of the buffer (beat, seconds, toy, emitter, Hz, velocity, source).
- Screen readers: a "Notes" table view of the last 4 bars, same columns as the CSV, and polite announcements of chord changes when the Intervals toggle is on.

**Cost.** One 2D canvas, redrawn only while it scrolls (frozen = no redraw). Target under 1 ms per frame at 8 toys on a mid phone.

### 6.2 Inspector strip (advanced, inside the Trace)

A thin row under the graph, one cell per ring toy, for players comparing toys:

- notes per bar, pitch range (low–high Hz and in octaves), most common interval;
- loudness (from `env`, as a small meter);
- engine cost for custom and external voices, from the measured `ModuleCost` (AUDIO-GEN, VMA) where one exists;
- Pulse summary: steps, steps per beat, swing, average probability.

It is off by default and lives behind a **More** toggle on the Trace.

### 6.3 Record

```
 ┌ Record ──────────────────────────────────────────┐
 │ What:  (● Take)  (○ Sequence)  (○ Both)          │
 │ Toys:  [Lead] [Ring ✓] [Everything]              │
 │ Start: next bar · count-in 1 · length free       │
 │                                                  │
 │        ( ● REC )          00:00 · bar 0          │
 │                                                  │
 │ This session                                     │
 │  ▸ Bowl + Spire 3   Take 0:42  ▶ ⟳  ★  ⋯         │
 │  ▸ Bowl riff        Seq 8 bars ▶ ⟳  ★  ⋯         │
 │                       [ Quick save ] [ Save as… ] │
 └──────────────────────────────────────────────────┘
```

- **What:** a Take (audio), a Sequence (what was played), or both from the same pass. Both is the default for advanced players, Take for everyone else.
- **Toys:** the lead, the ring (default), or everything you hear. For a Take with stems on, one stem per toy in the choice plus the mix.
- **Start:** now, next beat, next bar (default), with an optional count-in of 1 or 2 bars (a soft tick through your speakers only, never recorded). **Length:** free, or 1/2/4/8/16 bars (stops on the bar line, which makes a clean loop).
- **REC** toggles. While recording, the ring's stage disc shows a slow red pulse, and in a room your presence shows a small "● recording" mark to the other players (§9.3).
- **This session** lists what you recorded since entering focus view: play (through the tape bus, §8.3, or as a Sequence replay), loop, star to keep, and a menu for rename, trim, export, delete.
- Unstarred recordings from a session are kept in a temporary list (IndexedDB) until you close the app or record 20 more, so a forgotten star doesn't lose a good take.
- **Overdub** (Sequences only): with a Sequence playing, recording adds new events to it on the same bars instead of starting a new one.

### 6.4 Recording settings

| Setting | Options | Default |
|---|---|---|
| Take format | WAV (16-bit, 24-bit, 32-bit float), WebM/Opus (96–256 kbps) | WAV 24-bit |
| Sample rate | The audio context's (usually 48 kHz); shown, not chosen | — |
| Stems | Off · per toy | Off (on when Toys = Ring and the ring has 2+ toys) |
| Reverb in stems | Dry · wet | Dry (the mix always has reverb) |
| What is recorded | **The music** (toy volumes, no mute/solo/focus) · **What I hear** (after mute/solo/focus) | The music |
| Normalise on save | Off · to −1 dBFS peak | Off |
| Sequence export | `.cosmic-seq.json` · also write a MIDI file | JSON only |
| MIDI pitch | Nearest note + pitch bend per channel (MPE-style, one emitter per channel) · nearest note only | Pitch bend |
| Naming | Pattern with `{world}`, `{toys}`, `{lead}`, `{date}`, `{time}`, `{bpm}`, `{n}` | `{toys}-{date}-{n}` |
| Default location | Browser: the in-app **Library** (also download a file: on/off). Desktop: a folder, default `Music/Cosmic Playground/`, chosen with the native dialog. Phone: the in-app Library, with Share for files. | Library |
| Max length | 1–30 min | 10 min |

- **Quick save** saves the selected recording (or the last one) with the current settings, to the default location, under the naming pattern. No dialog. On desktop, a toast offers **Show in folder**.
- **Save as…** opens the same settings for this one save only, plus a name and a location.
- Presets of settings: **Quick** (WebM, mix only), **Studio** (WAV 24, stems, dry), **Share** (WebM, normalised). Picking one fills the window; editing a field switches to "Custom".
- Storage left is shown under the location (`navigator.storage.estimate()`), with a warning when a Take at the max length wouldn't fit.

### 6.5 Sequences in detail

A Sequence is the replayable record of a performance on some toys, in beats, not samples:

- **Recorded:** pokes (strength, aux, which part), param changes (the final value of each throttled drag step, as DEV-MODE §6.4 does), Pulse and pattern edits, volume. Each event has a beat offset from the Sequence start and the player who made it.
- **Not recorded:** what the Pulse plays on its own. The Pulse is deterministic (seeded per toy), so replaying the start state and the edits reproduces it. This keeps Sequences small.
- **Start state:** the `ToySnapshot` of each toy at the start, so a Sequence can bring its toys along when they aren't in the world.
- **Replay** schedules each event at `startBeat + offset` with the same beat-stamped path as room pokes (`pokeAt`, MULTIPLAYER §5.2). Until `pokeAt` exists, the main thread schedules with a 100 ms lookahead on the snapshot clock, which is good to about one block.
- Because it replays through the engine, a Sequence follows the world's **current** tempo and Tuning. A Sequence recorded at 96 BPM in C major plays at 120 BPM in D dorian if the world has changed. A **Keep original tempo and Tuning** option on the card restores them for the length of the replay (asking first in a room).
- **Trim:** drag the start and end on a small strip of the Sequence's notes, snapping to beats.
- **Quantise on replay** (off, 1/4, 1/8, 1/16, with strength): applied when scheduling, never written into the file.

---

## 7. Presets

The Presets window shows two tabs, **This toy** (the lead) and **The group** (the ring).

### 7.1 One toy: variants

A preset of one toy is a **variant**, exactly as SAVE-LOAD §6 defines it (`ToyTemplate`: base toy id plus params, Pulse, pattern, recipe and optionally an edited config). Focus view adds:

- **Keep this toy**: one big button, quick-saving the lead as a variant with an automatic name ("Singing Bowl 3") and a tint taken from its current params. Rename and re-tint later.
- A list of this toy type's variants, each with **Try** (applies to the lead, with an undo chip for 10 s) and **A/B** (hold to hear the variant, release to go back, like a momentary focus).
- **Morph** (advanced): pick two variants and a slider blends every numeric param between them. Letting go leaves the toy at the blend; **Keep** saves the blend as a new variant.

### 7.2 The group: Ensembles

```jsonc
{
  "format": "cosmic-ensemble",
  "version": 1,
  "name": "Dusk Trio",
  "members": [
    { "template": { /* ToyTemplate, embedded */ }, "pos": [0, 0, 2.2], "volume": 0.8 },
    { "template": { /* … */ }, "pos": [1.9, 0, -1.1], "volume": 0.6 },
    { "template": { /* … */ }, "pos": [-1.9, 0, -1.1], "volume": 0.7 }
  ],
  "couplings": [ { "from": 0, "port": "trigger", "to": 2, "in": "poke" } ],
  "world": { "bpm": 84, "tuning": { "root": 57, "scale": 3 } },   // optional
  "sequences": [ "seq_8f2c…" ],                                    // optional, by id
  "icon": "auto"
}
```

- Positions are relative to the ring centre. **Layout:** keep the ring, or keep the toys' world arrangement (relative to their centroid).
- **Tempo and Tuning** are saved only when ticked; placing an Ensemble that carries them asks first ("Change the world to 84 BPM, A minor?").
- **Attached Sequences** play when the Ensemble is launched from the Conductor (§9), so an Ensemble can be a complete little piece.
- **Keep this group**: one-click quick save, like Keep this toy.
- Ensembles appear in the chest under a new **Ensembles** drawer, as a fan of the member icons. Pulling one out places all of its toys around the aim point, as one undoable action.

### 7.3 Storage

IndexedDB stores `templates/<id>` (SAVE-LOAD §6.4), `ensembles/<id>`, `sequences/<id>`, `takes/<id>` (metadata) with the audio in the Origin Private File System (`takes/<id>.wav`), which handles large files without loading them into memory. Files on export: `.cosmic-preset.json` (a template or an ensemble), `.cosmic-seq.json`, `.wav` / `.webm`, `.mid`. A saved world embeds the templates, ensembles and sequences it refers to, as it already embeds templates; it never embeds Takes.

---

## 8. Engine and audio changes

### 8.1 Richer note events

Note subscription is built (REVISIONS R2.3): `{ t: "notes"; slots }` turns on `report_notes` for those slots, and each snapshot carries `[slot, beat, hz, vel]` per note. Focus view subscribes the ring toys on entering and restores the previous list (puzzle goals may be subscribed too) on leaving. The Trace needs three more fields, so `NOTE_STRIDE` goes from 4 to 7: `[slot, beat, hz, vel, voice, dur, src]`.

- `voice`: the emitter index. The per-sample note list in `Fx` gains it; single-emitter voices report 0, the Orrery its planet, the Kettle its bubble voice, patch voices their allocator index.
- `dur`: the voice's estimate of how long the note sounds (gate plus release, or decay to −40 dB). The Trace uses it for the held line; nothing else depends on it.
- `src`: 0 = Pulse, 1 = poke, 2 = coupling, 3 = external input. The Cadence toggle needs this to tell auto-played from hand-played notes. The engine knows it at the point the voice is triggered.

`NOTE_STRIDE` changes in `abi.ts`, the worklet and `engine.rs` together; MODES goal code reads only the first four fields, so it is unaffected. Golden audio fingerprints don't change, because events don't touch audio.

### 8.2 Record tap

- `Command` `{ t: "record"; on: boolean; stems: number /* slot mask */; post: boolean /* after monitor */; wet: boolean }`.
- In `process()`, when recording: copy the stereo mix (after the limiter, before the master mute ramp, so a global mute while recording doesn't silence the take), and for each slot in `stems` the slot's stereo output after pan, before (default) or after its monitor gain, and before or after the reverb send per `wet`.
- The worklet batches about 100 ms of frames and transfers them (`postMessage` with transferables) to a **recorder Worker**. The Worker writes WAV directly to OPFS (`createSyncAccessHandle`), or encodes WebM/Opus with WebCodecs `AudioEncoder` where available (falling back to `MediaRecorder` on a `MediaStreamAudioDestinationNode` for the mix only). The main thread never holds the audio.
- If `crossOriginIsolated` is true (the desktop app can set the headers), use a `SharedArrayBuffer` ring instead of messages. Not required.
- Cost when not recording: one branch per block. When recording 8 stems: about 8 stereo copies per block, well under 1% of the budget.

### 8.3 Tape bus (playing Takes)

- `AudioWorkletNode` gets a **second input**: Takes play from an `AudioBufferSourceNode` (or a streamed `MediaElementAudioSourceNode` for long files) into that input.
- The engine mixes the tape input into the master **before** the master gain and limiter, so Takes obey the volume slider, global mute and the loudness limit like everything else.
- The tape input can also be chosen as a listening toy's input (`input: "tape"`, beside `"mic"`), so a Take can drive a listening toy.
- Takes start on a beat: the main thread computes the context time of the target beat from the snapshot clock and calls `start(when)`.

---

## 9. Conductor

### 9.1 The shelf

Outside focus view, `O` (or the HUD's baton glyph) opens the **Conductor**: a shelf along the bottom of the screen, three rows of cards.

```
 Takes      [~~∿~~ Dusk 0:42] [~∿∿~ Bowl+Spire 1:10] [ + ]
 Sequences  [·•·• Bowl riff 8b] [•··• Orrery fill 4b] [ + ]
 Presets    [❖ Dusk Trio] [◈ Singing Bowl 3] [◈ Spire glass] [ + ]
 Cues       [ 1 Dusk Trio + Bowl riff ] [ 2 Orrery fill + Dusk 0:42 ]      ▶ next cue
```

- Each card shows a glyph-style thumbnail: a Take's waveform, a Sequence's note dots, a preset's toy icons.
- **Tap** launches on the next bar (the default launch quantum; can be set to beat, 2 bars, 4 bars or immediate). A launching card shows a ring that fills until the bar line. Tap a playing card to stop it at the next bar; double-tap stops at once.
  - **Take:** plays through the tape bus (§8.3). Loops if it was saved with a bar length.
  - **Sequence:** plays on its toys. If the toys (by id) are in the world, it plays on them; otherwise it offers **Bring the toys** (places them from the start state) or **Play on…** (map it onto toys of the same types you pick).
  - **Variant / Ensemble:** places it at the aim point (or the free spot nearest the middle of the view), plus its attached Sequences.
- **Long-press** a card: rename, loop on/off, launch quantum, focus (opens focus view on its toys), export, delete.
- **Cues** group cards that launch together. Drag cards onto the Cues row to make one; `Space` in the Conductor (or the **▶ next cue** button) launches the next cue; `1`–`9` launch cue 1–9 directly. Cues are saved in the world (they are part of the composition).
- **Stop all** at the next bar, and **Fade out** over 2 or 4 bars, sit at the end of the shelf.
- MIDI pads map to cards and cues with MIDI learn (DESKTOP-MIDI §5.3); a launchpad-style controller can light a pad per card.

The shelf shows the whole Library (everything kept, across worlds), with a filter **This world** (default) / **All** and a search box.

- **Phones:** the shelf stacks directly above the chest drawer instead of replacing it (§15.3).
- **Puzzle finales:** a solved puzzle adds a sealed cue with **Reveal solution**; it becomes a normal cue only after a confirmation (§15.4).

### 9.2 What is saved where

| Thing | In the Library | In a saved world | In a room |
|---|---|---|---|
| Take | Yes (audio in OPFS) | A reference only (name, length); missing on another device | No: only you hear it |
| Sequence | Yes | Embedded if a cue uses it | Shared when launched or put on the room shelf |
| Variant / Ensemble | Yes | Embedded if placed or in a cue | Shared when placed or put on the room shelf |
| Cues | — | Yes | Shared (part of the world) |

### 9.3 Rooms

- **Recording is local** and allowed for everyone. Starting a recording shows "● recording" next to your name in everyone's player list, so nobody is recorded without seeing it. A room setting (admin only) can turn recording off for guests.
- **Launching a Sequence** in a room is an edit: it needs `canEdit`, and its events are scheduled on the room beat and written to the doc like any player's, under a presence entry for the Sequence ("▶ Bowl riff", in the launching player's colour) so others can see what is playing their toys.
- **Placing a preset** in a room is the same as placing a toy.
- **Takes** are heard only by the player who launched them; the card says so with a headphones glyph. Sharing audio through the relay is out of scope (non-goals).
- **The room shelf:** an admin, or anyone if the room allows it, can put Sequences, variants and Ensembles on a shared shelf (in the room doc, size-limited to 256 KB in total) so every player's Conductor shows them.

---

## 10. Inputs

| Action | Keyboard | Touch | Gamepad | MIDI |
|---|---|---|---|---|
| Select / deselect toy | `Shift+click`, `Shift+drag` lasso | long-press → Select | `X` on targeted toy | — |
| Enter / leave focus view | `F` / `F` or `Esc` | focus glyph in the toy panel | `View` hold | learnable |
| Next / previous lead | `Tab` / `Shift+Tab` | **› ‹**, swipe the bar | `RB` / `LB` | learnable |
| Pick lead | `1`–`8` | quick-select menu | `Y` + D-pad | learnable |
| Pitch Trace | `T` | Trace glyph | — | — |
| Record window / start-stop | `K` / `Shift+K` | red dot glyph | `Start` hold (start/stop) | learnable |
| Quick save last recording | `Ctrl+Alt+S` (`Ctrl+S` stays "save world", SAVE-LOAD §7) | Quick save | — | — |
| Presets | `P` | fan glyph | — | — |
| Keep this toy (variant) | `Ctrl+Shift+K` (as SAVE-LOAD §6.2) | Keep this toy | — | — |
| Conductor | `O` | baton glyph | — | — |
| Launch cue 1–9 / next cue | `1`–`9` / `Space` (Conductor open) | tap / ▶ | `A` (next cue) | pads |

Keys are ignored while typing in a text field, as today. The shortcut table in [AVATAR.md](AVATAR.md) §8 gets these rows.

---

## 11. Accessibility and safety

- Every window works by keyboard and screen reader: the ring is a list (the quick-select menu is a `listbox`), the Trace has its table view, Record and Presets are ordinary forms. Lead changes are announced ("Lead: Singing Bowl, 2 of 3").
- Colour is never the only code: emitters also differ in dash pattern; Pulse vs hand notes differ in fill.
- Takes play through the master limiter (§8.3), so a loud Take can't jump above the loudness target. Normalising on save never pushes above −1 dBFS.
- Reduced motion: no ring turn animation, no world drift, no scroll on the Trace (it steps one bar at a time instead).
- Kid mode: ring, arrows, quick-select, Keep this toy / Keep this group, and the Conductor with presets only. No Trace, no Record, no files.

---

## 12. Code changes

| Area | Files |
|---|---|
| Selection, display pose, ring layout, camera tween | `world.ts` (`selection`), `toys/toy.ts` (`view`, `home`), new `src/focus/focus.ts`, `src/focus/ring.ts`, `render/stage.ts` (framing helper) |
| Focus bar, quick-select menu, windows host | new `src/ui/focus-bar.ts`, `src/ui/windows.ts` |
| Mix | `audio/mix.ts` (`focusSet`, listen switch, save/restore) |
| Pitch Trace and inspector | new `src/focus/trace.ts`, `src/focus/notes.ts` (ring buffer, emitter registry) |
| Note event fields, record tap, tape bus | `crates/hypertoy-wasm/src/engine.rs`, `voice.rs` (`Fx` notes with voice, dur, src), `audio/abi.ts`, `audio/protocol.ts`, `audio/worklet.ts`, `audio/host.ts` |
| Recorder Worker, WAV/WebM writers, MIDI writer | new `src/record/recorder.worker.ts`, `src/record/wav.ts`, `src/record/midi.ts` |
| Sequences: recorder, player, scheduler | new `src/record/sequence.ts` (reuses the event names of DEV-MODE §6.4) |
| Library storage | new `src/library/` (IndexedDB stores, OPFS takes), on top of SAVE-LOAD S2 |
| Presets window, Ensembles | new `src/ui/presets.ts`, `src/library/ensemble.ts`, chest drawer in `ui/chest.ts` |
| Conductor | new `src/ui/conductor.ts`, cues in the WorldDoc |
| Desktop default folder | `apps/desktop/src-tauri` (fs + dialog permissions in `capabilities/main.json`) |
| Rooms | `net/doc.ts` (cues, room shelf, Sequence presence), `net/presence.ts` (recording mark), relay size limit for the shelf |

---

## 13. Phasing

| Step | Scope | Depends on | Exit check |
|---|---|---|---|
| **F1. Selection + ring** | `World.selection`, Shift+click, lasso, Listen sheet checkboxes, `F`, display pose, ring layout, camera framing, dim/drift of the rest, `focusSet` in `MixState`, listen switch | — | Enter with 1, 3 and 8 toys on desktop and a phone: the ring fits, pans follow the ring, leaving restores positions, camera and mix exactly; in a room, the other player sees no movement |
| **F2. Cycling** | Lead, ring turn, `Tab`/`Shift+Tab`, `1`–`8`, arrows, quick-select menu with add/swap/remove, toy panel follows the lead | F1 | Every lead change is reachable by keyboard, touch and screen reader; `Tab` opens the chest again after leaving |
| **F3. Pitch Trace** | Subscribe ring toys, `voice`/`dur`/`src` note fields, notes buffer, Trace canvas, beat grid, cadence, freeze/scrub | F1; note subscription (done) | A Kettle chord shows as stacked lines; a Spire on its Pulse shows hollow dots on the grid, a poke a filled one; tempo change bends the grid at the right beat; golden fingerprints unchanged |
| **F4. Trace extras** | Intervals, cents, names, lead only, hover, CSV/PNG export, table view, inspector strip | F3 | A 3:2 Orrery shows "3:2"; the CSV of 8 bars matches the notes in the engine's event log |
| **F5. Takes** | Record tap, recorder Worker, WAV to OPFS, WebM/Opus, stems, count-in, bar lengths, session list, Record window, settings window, quick save, desktop folder | SAVE-LOAD S2 (IndexedDB) | An 8-bar take with 3 stems: stems sum to the dry mix within −60 dB; no dropouts recording 10 min at 8 toys on a mid laptop; quick save writes to the default folder on desktop |
| **F6. Sequences** | Sequence recorder, start states, scheduler (lookahead now, `pokeAt` once M3 lands), trim, quantise on replay, overdub, JSON and MIDI export | F5's window; MULTIPLAYER M3 for room replay | Record 8 bars of pokes and param drags, replay: the audio fingerprint matches the original pass; at a new tempo it follows the new tempo |
| **F7. Presets** | Presets window, Keep this toy/group, Try with undo, A/B, Ensembles format, chest drawer, morph | SAVE-LOAD S3–S4 (templates) | An Ensemble with tempo, Tuning and a Sequence round-trips through a file and places as one undoable action |
| **F8. Conductor** | Shelf, launch on the bar, tape bus, Bring the toys / Play on…, cues, stop all, fade, MIDI learn for cards | F5–F7 | A three-cue set plays through on the bar with no audible gap; Takes obey master volume and the limiter |
| **F9. Rooms** | Recording mark, guest recording setting, Sequence presence, room shelf, cues in the doc | F8, MULTIPLAYER M3–M4 | Two players: one launches a Sequence, both hear it beat-locked and see who is playing it; a Take is heard only by its player |

F1–F4 need no storage and can start now; they are also the most useful part for new players. F5 onward waits on SAVE-LOAD S1/S2. The note subscription F3 needs is already built; only the three extra fields are new.

---

## 14. Testing

- **Unit:** ring layout (radius, angles, ellipse on portrait, 8-toy cap); `monitor()` with `focusSet` and each listen setting; notes buffer (wrap, emitter registry); WAV header and chunked writing; MIDI writer (pitch bend per channel for a 7-limit chord within 1 cent); Sequence scheduling (offset → beat, quantise on replay).
- **Engine (Rust):** `voice`/`src` correct for Pulse hits vs pokes vs couplings; record tap stems sum to the mix; golden fingerprints unchanged.
- **Round trips:** Ensemble and Sequence through file export/import; a world with cues opens on another device with Takes marked missing, everything else intact.
- **Replay fidelity:** record a Sequence through the dev-mode manual clock (DEV-MODE §6), replay, compare audio fingerprints.
- **Performance:** Trace at 8 toys under 1 ms/frame on a mid phone; 10-minute 8-stem recording without dropouts (no `process()` overruns reported by the worklet).
- **Rooms:** focus view in one client moves nothing in the other; recording mark shows within a second; Sequence launch lands on the same bar on both clients once M3 is in.

---

## 15. Decisions

**Decided here**

- Focus view is a local display pose, not a move (§4.2). Pinning the ring to the world is a separate, explicit edit.
- Takes record "the music" (pre-monitor) by default, so soloing while recording doesn't produce a take with missing toys by accident. "What I hear" is one setting away.
- Sequences store edits and the start state, not Pulse output, because the Pulse is deterministic. They follow the current tempo and Tuning unless told otherwise.
- Takes play through the engine's master and limiter (tape bus), not straight to the destination.
- Takes are never shared through a room in v1.

**Resolved (Oct 2026)**

1. **Ring size cap: desktop allows more than 8.** Phones and touch-first screens keep 8. Desktop (a fine pointer, `pointer: fine`, and a window at least 1024 px wide) allows **12**. The "N at a time" note, the quick-select swap and the `1`–`8` digit picks follow the cap: on desktop `9` picks lead 9 and `Shift+1`–`Shift+3` pick 10–12 (`-` and `=` stay toy volume). §4.1 and §5 use `RING_MAX` for the cap.
2. **Emitter identity for stolen voices: group by pitch.** When a toy's voices can be stolen (patch toys, and any toy that doesn't report a stable `voice`), the Trace draws one line per **pitch lane**, not per allocator index: notes within ±35 cents of a lane's running pitch join that lane, and a lane that has been silent for 2 bars is retired. Toys with fixed emitters (an Orrery planet, a Kettle bubble voice) keep one line per emitter once `voice` lands (§8.1); until then every toy uses pitch lanes, which reads the same for them.
3. **Conductor on phones: stack it above the chest.** On phones, the Conductor shelf and the chest drawer share the bottom edge as a stack: the chest stays where it is, and the open Conductor sits directly above it (shelf rows scroll sideways, at most two rows tall; the rest scroll). Neither replaces the other, so a card can still be dragged from the chest while the Conductor is open. When the focus view's sheet (§6) is up, the stack slides down to just the chest handle and the Conductor's ▶ next cue button.
4. **Puzzle finales as cues: yes, behind a reveal.** When a puzzle (MODES §6) is solved, its finale is offered on the Conductor as a ready-made cue, but hidden: the Cues row shows a sealed card with a **Reveal solution** button. Tapping it asks for confirmation ("Reveal the solution? This shows the toys and settings that solve the puzzle.") and only then turns it into an ordinary cue (the solving toys as an Ensemble plus the finale as a Sequence). A puzzle that is not solved yet never offers its finale. In kid mode the confirmation uses the big two-button sheet.
