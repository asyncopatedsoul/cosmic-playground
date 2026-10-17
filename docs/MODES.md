# Modes and scenarios plan: puzzle mode and the Heart

> **Modes** change the rules of the world without changing the toys. The first mode beyond the sandbox is
> **Puzzle**: a pre-arranged world whose toys are partly locked, where each goal is a small piece of music
> theory. The solved puzzle *is* the music: when every goal holds, the toys you tuned keep playing and the
> scenario's finale layers join them, so the reward is a composition you made. Progress is shown without words
> by **the Heart**, a body in the middle of the world that fills, layer by layer, as each toy reaches its part.

Status: first cut implemented (P0–P4 in compact form: `src/modes/`, `render/heart.ts`, `ui/puzzles.ts`, `puzzles/*.json`; open with the HUD puzzle button or `?puzzle=first-light`). Not yet: hint steps 2–3, pinned-metal look for locked handles, finale duck, "Keep this world", rooms, scenario tests in the Rust harness. Nightfall's Voice B is a Pendulum Clock, not a Spire, because the built-in Spire ignores pattern degrees · Oct 2026 · builds on [SAVE-LOAD.md](SAVE-LOAD.md) §3 (WorldDoc), [HELP-SYSTEM.md](HELP-SYSTEM.md) §3.3 (gesture glyphs) and §9 (event bus), [AUDIO-MIX.md](AUDIO-MIX.md) (focus/duck), [AVATAR.md](AVATAR.md) §4 (gravity bodies)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| What a mode is | A `Mode` object the world consults: which edits are allowed (`constrain`), what is observed each frame (`observe`), and what to draw on top. **Sandbox** is the mode that allows everything; today's code is unchanged under it. |
| What a scenario is | A `ScenarioDoc` = a `WorldDoc` ([SAVE-LOAD.md](SAVE-LOAD.md) §3) **plus** `rules` (per-toy and world locks), `goals`, a `heart` layout and a `finale`. One JSON file, shippable and shareable like a world. |
| Constraints | Declarative and per param: `lock`, a narrower `range`, or a list of allowed `values`. Applied at the one seam every edit already passes through (`Toy.setParam` / `editable`). Locked handles are drawn as dull, pinned metal, not hidden. |
| Goals | Predicates over **what is sounding**, read from the engine snapshot (`Snap.freq`, `Snap.flash`, `planetPeriod`) and mapped through the world Tuning to scale degrees. Each goal returns a continuous **closeness 0..1** (for feedback) and `met` with a **hold time** (e.g. 2 bars) so a passing flicker doesn't count. Goals accept any valid answer (any octave, any rotation), never one exact state. |
| Feedback | **The Heart**: one shell per goal around a central body. Shape = kind of goal, colour = the toy feeding it, fill = closeness, wobble = how far out of tune (it literally beats at the detune rate). A thread runs from each toy to its shell. Locking a shell plays that shell's note of the finale chord, so progress is also heard. |
| Reward | All goals held → the Heart **blooms**, finale layers (pre-composed toys or patterns that fit every valid solution) fade in over 8 bars, then the rules lift and the world becomes a sandbox you can save. |
| First content | Three puzzles, one concept each, then one that combines them: **First Light** (pitch: octave and the harmonic series → a major triad), **Tide Clock** (time: pulse, 3:2 polyrhythm, tresillo), **Nightfall** (harmony over time: chord tones over a moving bass). |
| Engine changes | Small and opt-in. (1) **Note events** for subscribed slots: a polyphonic toy that feeds a chord goal reports every note (`EventKind.Note`, today produced only for VMA slots) to the main thread, beat-stamped (§3.3). (2) **Spire** snaps its fundamental before the harmonic multiply, so harmonics are exact ratios of a scale tone (§7.1). (3) A **per-toy `wild`** flag, used by First Light's bonus. Everything else reads the existing snapshot; the finale uses existing toys, patterns, tempo and volume. |

---

## 1. Goals

1. **Teach by ear, not by text.** Each puzzle isolates one idea (octave, fifth, polyrhythm, chord tone) and makes it the only thing the player can change. No notation, no note names needed to solve.
2. **No failure states.** Wrong answers still sound good (the Tuning still snaps); they just don't fill the Heart. There is no timer, score or "wrong" buzzer.
3. **The solution is the song.** Every goal corresponds to a musical layer, and the finale is composed against the goal *set*, so whichever valid answer the player found, the ending fits.
4. **One system, many modes.** The same `Mode` seam later serves a guided tutorial (HELP-SYSTEM §5.1), a classroom "teacher sets locks" mode, timed jams and community-made scenarios.
5. **Works on every device and in rooms.** Constraints are data on the world, goals are pure functions of shared state + local audio snapshot, so multiplayer players see the same Heart.

### Non-goals (v1)

- Free-form composition grading ("is this melody good?"). Goals are crisp predicates.
- A scenario editor UI. v1 scenarios are JSON written by hand; a "save as scenario" button that records locks comes later (§9, P4).
- Scoring, stars for speed, leaderboards.

---

## 2. What exists to build on

| Today | Where | Use |
|---|---|---|
| Every edit goes through `Toy.setParam`, `setPulse`, `setPattern`, `moveTo`, each gated by `editable` → `world.canEdit()` | `toys/toy.ts`, `world.ts` | The single place to apply constraints |
| `ParamDef` has `range`, `step`, `gesture` | `toys/toy.ts` | Scenario rules override them per toy instance |
| Locked rooms already make toys playable-but-not-changeable | `world.canEdit`, MULTIPLAYER.md §12 | Same visual language for locked handles |
| Snapshot per slot: `freq`, `flash`, `env`, `step`, planet angles/periods | `audio/protocol.ts` `Snap` | Goal observations, no engine change |
| Tuning: root + table, `degree(hz)`, `snap(hz)` | `crates/hypertoy-core/src/tuning.rs` | Mirror `nearestDegree` in TS (≈20 lines) to turn Hz into degrees and cents-off |
| Pattern mini-notation with scale degrees and `<a b>` alternation | `pattern.rs`; custom toys transpose by degree (`custom.rs`) | Finale layers, and "pattern holes" (§4.3) |
| Orrery periods snap to half beats (T = 4·r^1.5) | `toys/orrery.ts` | Rhythm goals are exact, not fuzzy |
| `WorldDoc` save format, toy snapshots, `applyState` | SAVE-LOAD.md §3, `world.ts` | A scenario's starting world |
| Gravity bodies | `avatar/gravity.ts`, AVATAR.md §4 | The Heart can be a body you walk on after it blooms |
| Gesture glyphs, event bus | HELP-SYSTEM.md §3.3, §9 | Hints point at the one control that matters |

---

## 3. Architecture

```
                    ┌───────────────────────── Mode ─────────────────────────┐
 Toy.setParam ─────►│ constrain(toy, param, v) → v' | null   (rules)          │
 Toy.setPulse ─────►│ constrainPulse / constrainPattern                       │
 World.add/remove ─►│ allowAdd(entry) / allowRemove(toy)                      │
                    │                                                         │
 world.update ─────►│ observe(snapshot, world) → Observation                  │
                    │   └► goals[i].evaluate(obs) → { closeness, met }        │
                    │        └► GoalTracker (hold time, hysteresis) ──► events│
                    └──────────────┬───────────────────────────┬──────────────┘
                                   ▼                           ▼
                           Heart (render/heart.ts)     Finale (mode/finale.ts)
```

### 3.1 `Mode`

```ts
interface Mode {
  id: "sandbox" | "puzzle" | string;
  /** Return the value to apply (clamped / snapped to allowed values), or null to refuse. */
  constrain(toy: Toy, param: string, v: number): number | null;
  constrainPulse(toy: Toy, p: Partial<PulseState>): Partial<PulseState> | null;
  constrainPattern(toy: Toy, text: string): string | null;
  allowAdd(entryId: string): boolean;
  allowRemove(toy: Toy): boolean;
  allowMove(toy: Toy): boolean;
  allowWorld(what: "tempo" | "tuning"): boolean;
  update(dt: number, obs: Observation): void;
  dispose(): void;
}
```

- `World` gets `mode: Mode = sandbox`. `Toy.setParam` becomes: clamp to `ParamDef`, then `world.mode.constrain(...)`; `null` → no-op plus a small "pinned" shake on the handle (§5.5). Sandbox returns its input, so nothing changes today.
- `world.applying` (remote edits, loading) bypasses the mode, like it bypasses `canEdit`, so loading a scenario can set locked values.
- **Effective defs.** `toy.effectiveDef(name)` merges the `ParamDef` with the rule, so the drag code, aim-preview hint and HUD sliders all see the narrowed range and the locked state. One function, used by input and UI.

### 3.2 `ScenarioDoc`

```jsonc
{
  "format": "cosmic-scenario",
  "version": 1,
  "id": "puzzle-first-light",       // {mode}-{scenario}[-{variant}]
  "series": "puzzle-dawn",          // puzzles in a series unlock in order
  "order": 1,
  "icon": "<svg …>",                // shown on the scenario shelf; no title needed to choose
  "name": "First Light",            // for screen readers, saves and the Toy Book; never required to play
  "world": { /* a WorldDoc, SAVE-LOAD §3: tempo, tuning, toys with ids */ },
  "rules": {
    "world": { "tempo": "lock", "tuning": "lock", "chest": [] },   // chest: entry ids allowed, [] = closed
    "toys": {
      "t_drone": { "all": "lock" },
      "t_echo":  { "params": { "length": { "range": [0.4, 2.0] }, "tension": "lock", "harmonic": "lock" },
                   "pulse": "lock", "move": true, "remove": false }
    }
  },
  "goals": [ /* §4 */ ],
  "heart": { "pos": [0, 0, 0], "radius": 0.9, "style": "seed" },
  "finale": { /* §6 */ },
  "hints": { "after": [45, 90, 150] }   // seconds without progress before each hint step (§5.6)
}
```

- A rule value is `"lock"`, `{ "range": [a, b] }`, `{ "values": [..] }` or `{ "lock": v }` (pinned to a value that differs from the world doc, e.g. for the Heart's reveal).
- `"allowedPcs": [0, 2, 3, 4]` (top level, optional) is the scenario's **allowed pitch-class set**: the notes the finale is composed in. Chord goals tolerate extras from it (§4.1), and the finale-fit test checks against it (§10). Defaults to the union of every goal's target pcs.
- **Naming.** Scenario ids follow `{mode}-{scenario}[-{variant}]`, lower-case kebab: `puzzle-first-light`, and for a series `puzzle-dawn`. Files are `<id>.json` under `apps/playground/puzzles/`. Dev-mode test scenarios use the same convention with a descriptor (`puzzle-first-light-solved`, `puzzle-dawn-test`) but are a separate format ([DEV-MODE.md](DEV-MODE.md) §6.1).
- Unlisted toys and params are free. Unlisted world settings are locked in puzzles (the default flips: puzzle worlds are locked-by-default, `"free"` opens things).
- Validation reuses SAVE-LOAD's hand-written validator; goal and rule references to toy ids are checked at load.

### 3.3 Observations

Each frame the mode builds an `Observation` from the snapshot and the shared state:

```ts
interface ToyObs {
  id: string;
  sounding: boolean;        // env above a floor, or a flash within the last beat
  hz: number;               // Snap.freq
  degree: number;           // nearest scale degree (signed, wraps octaves)
  pc: number;               // degree mod table length (pitch class within the scale)
  octave: number;
  cents: number;            // signed distance from that degree, for "wobble"
  onsets: number[];         // beat times of recent flashes (ring buffer, ~4 bars)
  notes?: { beat: number; hz: number; pc: number }[];  // every note, for subscribed (polyphonic) toys, ~4 bars
  periods?: number[];       // Orrery planets, in beats
  params: Record<string, number>;
  pulse: PulseState;
}
interface Observation { beat: number; bar: number; toys: Map<string, ToyObs>; tuning: WorldTuning }
```

- **Why audio, not params.** Pitch comes from the toy's Law (string, Helmholtz, plate) in the engine, so the snapshot is the truth and every toy, including community data toys, works with no per-toy mirror code. Params are still available for goals that are about the control itself (e.g. Pulse shape).
- **Onsets** come from `Snap.flash` rising edges stamped with the beat clock. Good enough at 60 fps for beat-level rhythm goals (quarter/eighth).
- **Note events for polyphonic toys.** `Snap.freq` is the last note per toy, so a toy with several voices sounding at once (Kettle bubbles, Orrery planets, a config toy with `voices > 1`) would under-report a chord. When a scenario loads, the mode marks every toy that is **polyphonic and referenced by a `chord` or `chordTones` goal** and sends `{ t: "notes", slots }` to the worklet. The engine then pushes `EventKind.Note` for those slots as well as for VMA slots, and the worklet adds them to the snap message as `[slot, beat, hz, vel]` (beat = block start beat + frame offset, so they're sample-exact). The Observation builder turns them into `ToyObs.notes`, and chord goals use them instead of `freq` for those toys. Monophonic toys and sandbox mode send nothing extra. The same events give sixteenth-exact onsets if a rhythm goal ever needs them.

---

## 4. Goals

### 4.1 Kinds

Each kind has a pure `evaluate(obs) → { closeness: 0..1, met: boolean }`. Closeness is what makes "warmer/colder" feedback possible without words.

| Kind | Fields | Met when | Closeness |
|---|---|---|---|
| `pitch` | `toy`, `pc` (scale pitch class), `octave?` | toy sounding that pitch class (any octave unless given) | 1 − scale-steps away / half the table, then cents-off refines the last 10% |
| `interval` | `toy`, `to` (toy), `steps` (allowed intervals in scale steps or cents) | the interval between the two toys' pitches is in the set | by distance to the nearest allowed interval |
| `chord` | `toys[]`, `pcs` (set), `over?` (bass toy) | over one bar, **every target pc sounds**, and every other sounding pc is in the scenario's `allowedPcs` | share of target pcs present, scaled down by the share of sounding pcs outside `allowedPcs` |
| `chordTones` | `toy`, `over` (a toy whose pattern changes chord), `chords` (pc sets per bass degree) | on every bass change in the last cycle, the toy's note was in that chord | fraction of bars where it was |
| `ratio` | `toy`, `planets`, `ratio` (`[3, 2]`), `beats?` (absolute period of one planet) | planet periods in that ratio (exact; periods are snapped) | by log-distance of the ratio |
| `rhythm` | `toy`, `hits`, `steps`, `rotate?: "any"` | pulse ring equals `euclid(hits, steps)` up to rotation | 1 − Hamming distance / steps, at the best rotation |
| `together` | `goals[]` | all sub-goals met in the same bar | min of the sub-closenesses |

**Chord strictness (for now).** "Target pcs present, extras allowed only if in the scenario's allowed set." Because `allowedPcs` defaults to the goals' own pcs, a scenario that doesn't set it is strict; one that sets it to the finale's palette lets a player add a colour note the ending will also use. Closeness = `|S ∩ T| / |T| × (1 − |S \ A| / |S|)` for sounding set S, target T, allowed A. Revisit after P2 playtests.

Goals carry `optional: true` for "bonus" shells (a fourth petal, a constellation star) that change nothing about completion but are there for players who want more.

### 4.2 Tracking

- **Hold.** `met` must stay true for `hold` beats (default 8 = 2 bars at 4/4) before the shell locks. Locking is sticky for `release` beats (default 4) so a brief slip while dragging doesn't unlock it; after that it unlocks visibly but gently.
- **Order.** `after: "goalId"` gates a goal on another (used for staged reveals: a control unlocks when the previous shell locks). Ungated goals can be solved in any order.
- **Events.** The tracker emits `goal:near` (closeness crosses 0.7), `goal:lock`, `goal:unlock`, `scenario:solved` on the HELP-SYSTEM event bus, so hints, sound cues and the Heart all subscribe to one stream.

### 4.3 Pattern holes (for Nightfall and later)

Some goals are about *which note when*, which no single knob expresses. A rule can turn a toy's pattern into a template with holes:

```jsonc
"pattern": { "template": "<{a} {b}>", "holes": { "a": { "values": [0,1,2,3,4,5,6], "start": 1 },
                                                 "b": { "values": [0,1,2,3,4,5,6], "start": 1 } } }
```

The toy shows one **bead per hole** on its ring (reusing the Pulse ring's look). Dragging a bead up or down moves it a scale degree and auditions it; the bead's height is the pitch, its position around the ring is when. The TS fills the template and calls `setPattern`; no engine change and no text. `constrainPattern` refuses any other pattern text for that toy.

---

## 5. The Heart (progress and feedback)

### 5.1 Form

A body at the centre of the world, sized so it's visible from the default orbit camera and in every avatar mode. It **reserves its space**: the Heart registers `world.reserve("heart", pos, radius)`, and `World.freeSpot()` skips any grid spot closer than `radius + 1.5` (a toy's footprint) to a reservation. Scenarios place toys explicitly, so this matters once the rules lift (sandbox after solve) and for finale toys added without a `pos`. The reservation stays after the bloom, since the Heart is then a gravity body you can walk on. It starts as a dim, closed **seed**: a small core with a faint **silhouette of every shell it will have**, so the player sees from the first second that there are *N* things to fill, and roughly what kind.

```
            ╭──────── petal shell (rhythm)  ── ticks = hits, spins at the period
         ╭──┼──────── ring shell (interval) ── two arcs that meet when in tune
       ╭─┼──┼──────── facet shell (chord)   ── one facet per chord tone
       │ │  ●  core (pitch / root)          ── fills like liquid from below
       ╰─┴──┴────────
         ↑ threads to each contributing toy, in the toy's colour
```

### 5.2 Encoding (consistent across all scenarios)

| Channel | Means | Why |
|---|---|---|
| **Shape** of a shell | The kind of goal: sphere = a pitch, two arcs = an interval, facets = a chord, petals/ticks = a rhythm | Learnable once, then every puzzle reads at a glance. Never relies on colour alone. |
| **Colour** of fill | The toy (or toys, banded) feeding it, from `toy.color` | Answers "which toy is this about?" |
| **Thread** | A filament from the toy's heart to its shell; brightens when that toy sounds, flows inward on each note | Links cause and effect in space, works in VR at a distance |
| **Fill level** | Closeness | "Warmer/colder" while dragging, without words |
| **Wobble** | The shell's surface ripples at the *beat frequency* of the detune (`|cents|` → Hz, clamped to 0.5–6 Hz) and calms to still when in tune | The visual of acoustic beating: the physics of "out of tune" is what you see |
| **Pulse** | Locked shells throb on their toy's `flash` | The Heart plays along; shows the toy is part of the music |
| **Alignment** (rhythm shells) | Each planet/rhythm is a ring of ticks spinning at its period; at the shared cycle (LCM) all ticks line up at the top and flash | Makes a polyrhythm visible: 3 against 2 meets every 6 beats |

### 5.3 States per shell

1. **Dormant**: dashed silhouette, 15% opacity.
2. **Warming** (closeness > 0): fill rises, wobble visible, thread shimmers.
3. **Near** (> 0.7): a soft glow and a quiet shimmer sound on the toy's note.
4. **Locked**: fill snaps to full with an ease-out "click", the shell turns solid and starts throbbing; **the shell's finale note sounds once** (a chime tuned to the goal's target, mixed under the toys). Since shells are the finale chord's tones, locking them one by one *builds the ending's chord audibly*.
5. **Slipping** (unlocked after release): fill drains slowly, no sound, never a negative cue.

### 5.4 Bloom

When every non-optional shell is locked and held together for one more cycle: the shells rotate into alignment, the seed opens (petals unfold / the core becomes a small star), the finale starts (§6), and the Heart becomes a **gravity body** (AVATAR.md §4) the avatar can walk on. Optional shells that were found add visible extras to the bloomed form (an extra ring of light, a moon), so replays show what you discovered.

### 5.5 Locked controls

Locked handles are drawn **pinned**: matte metal, a small bolt glyph, no glow. Dragging one gives a short resistive shake and a muted "thunk" (no error text). Narrowed ranges show as a bright track segment on the handle's travel, with the rest dim. This tells players *where to look* before any hint.

### 5.6 Hints (escalating, all non-verbal)

After `hints.after[i]` seconds with no closeness gain on any open shell:

1. The thread of the most-progressed open shell pulses toward its toy.
2. That toy's one free handle glows with its gesture glyph (HELP-SYSTEM §3.3).
3. A ghost hand (reusing `render/ghost.ts` material) shows the drag direction toward "warmer", once.

Hints never solve the puzzle and switch off once a shell locks. A settings toggle disables them.

### 5.7 Accessibility

- Shape carries the meaning; colour is redundant. Fill patterns (stripes, dots) per toy for colour-blind palettes.
- `prefers-reduced-motion`: wobble becomes a ring of dashes whose gaps close as it tunes; no throbbing, bloom is a fade.
- Screen readers: an `aria-live` region announces "Layer 2 of 3 found" on lock, and the toy panel lists "needs: same note as the drone" from the goal's optional `label`. Text is there for those who want it, never required.
- Hearing: every audio cue (near shimmer, lock chime) has its visual twin; every visual has its audio twin.

---

## 6. Finale

```jsonc
"finale": {
  "bars": 32,
  "tempo": { "to": 72, "over": 8 },             // optional tempo glide
  "duck": 0.6,                                   // player toys sit under the swell briefly
  "layers": [
    { "at": 0,  "add": { "entry": "singing-bowl", "pos": [0, 0.8, 0], "pattern": "0 . . 4 . . 2 .", "params": { "rim": 0.18 } }, "fade": 8 },
    { "at": 8,  "add": { "entry": "spire", "params": { "length": 2.0, "harmonic": 1 }, "pulse": { "enabled": true, "prob": [1,0,0,0,0,0,0,0] } }, "fade": 4 },
    { "at": 24, "world": { "master": "swell" } }
  ],
  "then": "free"                                 // lift all rules; the world becomes a sandbox
                                                 // or { "free": true, "toys": { id: { "wild": true } } } (§7.1)
}
```

- Finale toys are ordinary toys added with `applying = true`, placed **on** the bloomed Heart, so they're visibly "born" from it.
- **Composed against the goal set.** Because goals pin pitch classes and periods (not exact params), the finale only uses those pitch classes and cycle lengths, so any valid solution fits.
- `then: "free"` lifts the rules, keeps every toy, and offers **Keep this world** (SAVE-LOAD: a normal WorldDoc with `from: "puzzle-first-light"`). The player's solution becomes the start of their own piece.

---

## 7. The three puzzles

All three use only toys that exist today. A series ("Dawn → Tide → Night") unlocks in order; each later puzzle can be replayed at any time.

### 7.1 Puzzle 1, **First Light**: the octave and the harmonic series

**Idea.** A string half as long sounds an octave higher; a string's overtones *are* the major chord (harmonics 4:5:6).

| | |
|---|---|
| Tuning / tempo | Just pentatonic (scale 2: 1, 9/8, 5/4, 3/2, 5/3) on C, locked. 72 bpm, locked. Chest closed. |
| **Drone** (Spire) | Fully locked: length 1.6, harmonic 1, Pulse on, a slow "x . . . . . . ." The root. |
| **Echo** (Spire) | Only `length` free (stretch the cap), starts at 1.3 (a scale tone that isn't the root). Tension, harmonic, Pulse locked. |
| **Glint** (Spire) | Only `harmonic` free (touch the nodes), length pinned equal to the Drone. Starts on harmonic 2. Hidden until shell 1 locks (`after`). |
| **Halo** (Spire) | Only `harmonic` free, starts on 7. Hidden until shell 2 locks. |

| Shell | Goal | Valid answers | What the player learns |
|---|---|---|---|
| Core (sphere) | `pitch` Echo pc 0 | length 0.8 (octave up) or 1.6 (unison) | Halving length = octave; the same note "an octave apart" is the same colour/fill |
| Ring (two arcs) | `interval` Glint → Drone, a fifth (pc 3) | harmonic 3 or 6 | The 3rd harmonic is the fifth; arcs stop wobbling exactly (just tuning) |
| Facets | `chord` {Drone, Glint, Halo} = pcs {0, 2, 3} (C, E, G) | Halo harmonic 5 | The 5th harmonic is the major third; three voices from one string family make a triad |
| *Optional* moon | `interval` Halo → Drone, `cents: [954, 984]` (7/4 = 969 ¢, any octave), checked after the bloom when rules lift and Halo turns `wild` | Halo harmonic 7 | The "blue" 7th harmonic: a note *between* the scale's notes that the string makes by itself |

`allowedPcs` is `[0, 2, 3]`: First Light is strict, so Halo's starting harmonic 7 (snapped to A, pc 4) keeps the facets open until it moves to 5.

**Spire pitch (checked in `crates/hypertoy-wasm/src/builtin.rs`).** Today the Spire computes `snap(f0 × harmonic)`: the snap happens **after** the multiply, and the fundamental is never snapped on its own. Two consequences, and the decisions:

1. Harmonic 7 snaps. In just pentatonic, 7/4 (969 ¢) is nearest 5/3 (884 ¢), so Halo on 7 sounds a plain A, not a blue seventh. Fine for the main puzzle (it's the "wrong" starting note). The bonus needs the real 7/4, so it needs **`wild` for that toy**: a new per-toy flag (engine `Slot.wild`, WorldDoc toy field `wild`), set on Halo by the finale's `then` step. Under a per-toy wild the Spire keeps its fundamental snapped and leaves only the harmonic unsnapped, so the 7th is exactly 7/4 above the Drone's root and rings without beating against it.
2. Harmonics are exact only while the raw fundamental is near a scale tone (within about ±90 ¢ in just pentatonic). To make "the harmonic multiplies its snapped fundamental exactly" true by construction, the Spire changes to `snap(snap(f0) × harmonic)` (with world `wild`, both snaps are identity, so nothing changes there). Golden fingerprints that include the Spire are refreshed in the same change.

The per-toy `wild` reaches the scenario as `"then": { "free": true, "toys": { "t_halo": { "wild": true } } }` in the finale.

**Finale: "Dawn".** The three Spires keep playing; a Singing Bowl born on the Heart plays `0 . . 2 . . 3 .` (the triad, slowly, 2 steps per beat) with long decay; at bar 8 a Bottle Organ breathes the root an octave down on `x . . . . . . . . . . . . . . .`; tempo glides 72 → 64. A warm, open-fifth ambient pad.

### 7.2 Puzzle 2, **Tide Clock**: pulse, ratio and polyrhythm

**Idea.** Rhythm is time ratios. Orbits that take 2 and 3 beats make 3-against-2; spreading 3 hits evenly over 8 steps makes the tresillo found in music everywhere.

| | |
|---|---|
| Tuning / tempo | Minor pentatonic on A, locked. 90 bpm, locked. |
| **Tide** (Pendulum Clock) | Locked; ticks every beat. The reference pulse. |
| **Moons** (Orrery) | Planets 0 and 1 free (drag radius), planets 2–3 off and locked, `speed` locked at 1. Start: p0 = 1.30 (period 6), p1 = 0.45 (period 1). |
| **Shell** (Singing Bowl) | Only its Pulse ring free (8 steps, eighths), starts with hits on every step. Pitch and pattern locked. Revealed after the ratio shell locks. |

| Shell | Goal | Valid answers | What the player learns |
|---|---|---|---|
| Inner tick-ring | `ratio` planet 0 period = 2 beats (`beats: 2`) | p0 ≈ 0.63 (snaps to 2) | Bigger orbit = slower; a half-note against the Tide |
| Outer tick-ring | `ratio` planets [1, 0] = 3:2 | p1 ≈ 0.83 (period 3) | 3 against 2: the rings' ticks meet every 6 beats, with a flash on the Heart |
| Petals (3 petals on an 8-notch ring) | `rhythm` Shell `euclid(3, 8)`, any rotation | x..x..x. and its rotations | Evenly spread hits; the petals turn when the pattern's shape is right |
| *Optional* | `rhythm` Shell `euclid(5, 8)` *instead* (cinquillo) also locks the petals, with 5 petals | x.xx.xx. rotations | A second, related groove |

Note: if a player sets p0 to period 4 and p1 to 6, the ratio shell still locks (3:2), but the inner shell doesn't; the two shells teach *ratio* and *absolute period* separately.

**Finale: "Tide".** Tempo holds; a Spark Box born on the Heart plays a bass figure that repeats every 6 beats (the shared cycle), `0 . . 3 . . 4 . . 2 . .` at two steps per beat; the Orrery's chimes are joined by a Kettle that starts bubbling on the cycle's downbeat; at bar 16 the Tide (pendulum) fades out so the polyrhythm carries itself. A slow, rolling, tidal groove.

### 7.3 Puzzle 3, **Nightfall**: chord tones over a moving bass

**Idea.** Harmony is what fits *now*. A note that sounds settled over one bass note can sound restless over the next; a chorus that follows the bass moves from chord to chord. First puzzle in a 7-tone scale, so half-step rubs are possible (snapped, never harsh, but audibly "leaning").

| | |
|---|---|
| Tuning / tempo | Major on F, locked. 66 bpm, locked. |
| **Ground** (Bottle Organ) | Locked; pattern `<0 3>` at one note per 2 bars: I (F) then IV (B♭), repeating. The Heart's core changes tint with it, so the chord change is *visible*. |
| **Voice A** (Singing Bowl) | Pattern holes `<{a} {b}>`, aligned to the bass changes (§4.3). Both holes start on degree 1 (G, not in either chord). |
| **Voice B** (Spire, length locked) | Pattern holes `<{a} {b}>`, both start on degree 6 (E, a rub over B♭). Revealed after Voice A's shell locks. |
| **Lanterns** (Orrery) | Planet 0 free, others locked. Revealed last. |

| Shell | Goal | Valid answers | What the player learns |
|---|---|---|---|
| Two-tone facets (one face per chord) | `chordTones` Voice A over Ground, chords I = {0,2,4}, IV = {3,5,0} | e.g. a=0,b=0 (common tone F), a=2,b=3, a=4,b=5… | A chord tone feels "home" over its bass; a common tone (F) fits both |
| Second facet layer | `chordTones` Voice B, same chords, **and** `interval` ≠ unison with Voice A in each chord | Voice B takes a different chord tone than Voice A | Two voices that *split* the chord sound fuller than two on the same note |
| *Optional* glow on the seam | Voice A or B moves by ≤ 1 scale step between the two chords (smooth voice leading) | a=2→b=3, a=4→b=5, a=0→b=0 | Smooth motion between chords; the seam between facets glows |
| Halo of lanterns | `ratio` Lanterns planet 0 period = 4 beats (one chord's length is 8 beats → 2 chimes per chord) | p0 ≈ 1.0 | The rhythm of the harmony: the chord changes every 8 beats |

**Finale: "Nightfall".** A Spire drone an octave below the Ground fades in; a Singing Bowl plays a slow arpeggio pattern written over the *same* two chords (`<[0 2 4] [3 5 0]>`); tempo eases 66 → 60; at bar 16 the scale switches to Dorian for the last 8 bars (the only world change the finale makes). Every toy follows the same Tuning, so nothing clashes; A becomes A♭, which turns the home chord minor: the piece darkens into night on purpose. The Heart blooms into a small moon with lanterns orbiting it.

### 7.4 Why this order

| | Concept | Control it uses | New in this puzzle |
|---|---|---|---|
| 1 | Pitch (vertical, one moment) | stretch, touch-node | Shells, threads, wobble; staged reveals |
| 2 | Time (horizontal, one voice) | orbit radius, Pulse ring | Rhythm shells, alignment flash; absolute vs relative |
| 3 | Pitch × time (harmony that moves) | pattern holes | 7-tone scale (rubs possible), goals that span bars, voice interplay |

Each puzzle introduces exactly one new control and one new shell shape; the third combines the first two.

---

## 8. Multiplayer and save

- **Rooms.** The scenario id, the rules and the goal lock state are in the room document; anyone in the room can solve any shell (shared puzzles are a co-op jam). Closeness and wobble are computed locally from each client's snapshot; lock events are written by the first client to see `met` held, with the room's beat as the timestamp, and accepted idempotently.
- **Rules are room state**, applied through the same `constrain` path as local edits, so a locked param can't be changed by a remote client either (the receiver re-checks).
- **Progress** (which scenarios were solved, optional shells found) is local, in `prefs` (`prefs.ts`), never in the world doc.
- **Saving mid-puzzle** saves a WorldDoc with `scenario: { id, locks }`; reopening resumes with the rules.

---

## 9. Phasing

| Step | Scope | Exit |
|---|---|---|
| **P0. Seam** | `Mode` interface, `sandbox` mode, `world.mode`, `toy.effectiveDef`, constrain calls in `setParam`/`setPulse`/`setPattern`/`moveTo`/`add`/`remove`. Pinned-handle look. | All existing behaviour unchanged (tests); a hand-made rule can lock a param |
| **P1. Goals** | `ScenarioDoc` loader + validator (incl. `allowedPcs`, id naming), `Observation` builder, TS `nearestDegree` mirror, goal kinds `pitch`, `interval` (steps or cents), `chord` (allowed-extras rule), `ratio`, `rhythm`; tracker with hold/release; events. Engine: Spire `snap(snap(f0)·h)`; note-event subscription for polyphonic slots | Unit tests for each kind against recorded snapshots; a Kettle chord is seen in full, not as its last bubble; First Light solvable with a debug overlay |
| **P2. Heart** | `render/heart.ts`: seed, shells per kind, threads, fill, wobble, lock click, lock chime, bloom; reduced-motion variant; `world.reserve` + `freeSpot()` avoiding the Heart | First Light playtested with no text: testers find shell 1 unaided in under 2 min; a toy added after the bloom never lands inside the Heart |
| **P3. Finale + content** | Finale timeline, rules lift (`then` with per-toy `wild`), "keep this world"; puzzles 1–2; scenario shelf in the chest (icons only) | Testers finish Tide Clock and choose to keep playing afterwards; the First Light moon is reachable |
| **P4. Holes + Nightfall** | Pattern holes (beads on the ring), `chordTones`, Nightfall; hints ladder | Nightfall solved by ≥ 60% of testers who finished 1 and 2 |
| **P5. Rooms + authoring** | Rules/locks in the room doc; "save as scenario" (records current locks and the current sounding state as goals, which the author then trims) | Two players co-solve a puzzle over a tunnel |

P0–P1 are small and can land alongside multiplayer M1–M2, since they touch the same edit seam; landing the seam first means the room binding is written once against `constrain`.

---

## 10. Testing

- **Goal kinds:** pure functions over `Observation` fixtures; property tests for "any octave", "any rotation" and hysteresis.
- **Solutions:** each puzzle JSON ships a `solutions` array (param sets); a test loads the scenario headlessly into the engine (native Rust test harness already used by `golden.rs`), applies each solution, runs N blocks and asserts `scenario:solved`. A second test asserts the starting state is *not* solved and that locked params can't move.
- **Finale fit:** for every listed solution, render the finale offline and check the sounding pitch-class set stays within the scenario's allowed set (no unintended rubs).
- **Heart:** screenshot tests of each shell state; a reduced-motion snapshot.

---

## 11. Decisions (formerly open questions, resolved Oct 2026)

1. **Snapshot timing for chords.** Polyphonic toys that feed a `chord` or `chordTones` goal report note events (opt-in per slot, beat-stamped in the snap message); monophonic toys keep using `Snap.freq` accumulated over the bar (§3.3).
2. **Spire pitch accuracy.** Confirmed in `builtin.rs`: the snap is **after** the harmonic multiply (`snap(f0 × h)`), and the fundamental isn't snapped first. Harmonic 7 therefore snaps to A; the "blue seventh" bonus uses a new **per-toy `wild`** set on Halo when the rules lift. The Spire also moves to `snap(snap(f0) × h)` so harmonics are exact by construction (§7.1).
3. **Heart placement vs toys.** `freeSpot()` avoids the Heart's radius through `world.reserve` (§5.1).
4. **Chord strictness.** For now: target pcs present, extras allowed only if in the scenario's `allowedPcs` (default = the goals' pcs, i.e. strict) (§4.1). Revisit after playtests.
5. **Teacher mode.** Same seam, rules authored live by a room admin. Deferred to its own plan (`docs/TEACHER-MODE.md`), written once P5 shows how authoring feels; nothing in P0–P5 should assume it.

Implementation steps: [REVISIONS.md](REVISIONS.md) §2.
