# Revisions plan: code changes for the Oct 2026 doc decisions

> The open questions in [TOY-BOOK.md](TOY-BOOK.md), [MODES.md](MODES.md), [SAVE-LOAD.md](SAVE-LOAD.md) and
> [DEV-MODE.md](DEV-MODE.md) were resolved on 2026-10-17 (each doc's last section now lists the decisions).
> This plan turns those decisions into code changes: which can land **now** on today's code, and which are
> **amendments** to steps those plans already schedule.

Status: plan · Oct 2026

---

## 0. Summary

| # | Decision | Kind | Lands with | Size |
|---|---|---|---|---|
| R1.1 | Six families only; old labels become aliases | Now | standalone (before TOY-BOOK B1) | S |
| R1.2 | `type` field (organs, bells…) | Now | standalone | S |
| R1.3 | `pack` field + brand variable; community placeholder | Now (data) + amend B2 (UI) | standalone / B2 | S |
| R1.4 | Gallery Group by Family / Type / Pack | Amend | TOY-BOOK B2 | M |
| R2.1 | Spire `snap(snap(f0)·h)` | Now | standalone (engine) | S |
| R2.2 | Per-toy `wild` | Now (engine + protocol) | standalone; WorldDoc field with S1 | S |
| R2.3 | Note events for subscribed polyphonic slots | Now (engine + worklet) | standalone; consumed by MODES P1 | M |
| R2.4 | `world.reserve` + `freeSpot()` avoids reservations | Now | standalone; Heart uses it in P2 | S |
| R2.5 | Chord rule with `allowedPcs` | Amend | MODES P1 | S |
| R2.6 | Scenario id naming, `puzzles/` folder | Amend | MODES P1, DEV-MODE D3 | S |
| R2.7 | Teacher mode deferred | Docs only | after MODES P5 | — |
| R3.1 | `view` bookmark offered via an "eye" chip | Amend | SAVE-LOAD S1 (format), S2 (chip) | S |
| R3.2 | Cloud reuses WorldDoc | Constraint | SAVE-LOAD S1 review | — |
| R3.3 | Variants: tint + badge only, `form` locked, unknown fields kept | Amend | SAVE-LOAD S4 | S |
| R4.1 | Players stay unmuted | No change | — | — |
| R4.2 | Release feedback: file location, quick link, guide, `{supportEmail}` | Now (brand vars) + amend D2 | D2 | M |
| R4.3 | Note = summary; world in side file; modules dropped, hashes kept | Amend | DEV-MODE D2 | S |
| R4.4 | `{mode}-{scenario}-{variant}` naming; formats stay separate | Amend | DEV-MODE D3, D5 | S |

"Now" items touch only code that exists today and can be merged independently, in any order. The suggested order is R2.1 → R2.2 → R2.3 (one engine PR series, one golden refresh), then R1.1–R1.3 and R2.4 (TS only), then the brand variables from R4.2.

---

## 1. Toy Book

### R1.1 Families: map back to the six

| File | Change |
|---|---|
| new `apps/playground/src/toys/families.ts` | `type Family = "vibration" \| "orbit" \| "wave" \| "growth" \| "reaction" \| "topology"`; `FAMILIES: { id, label, color, glyph }[]` in PLAN order; `FAMILY_ALIASES = { plate: "vibration", resonance: "vibration", oscillator: "orbit", rhythm: "orbit", recipe: "wave", forged: "wave" }`; `toFamily(s: string): { family: Family \| "other"; alias?: string }` (case-insensitive) |
| `src/audio/config.ts` | `ToyConfig.family: string` stays a string on disk (old files keep loading); `validate()` warns (doesn't fail) on an alias or unknown family |
| `src/toys/registry.ts` | `ToyEntry.family: Family \| "other"`; built-ins use `"vibration"`, `"orbit"`, `"reaction"`; `configEntry()` resolves through `toFamily()` |
| `src/toys/configs/*.json` | `singing-bowl` and `bottle-organ` → `"vibration"`, `pendulum-clock` → `"orbit"`, `spark-box` → `"wave"` |
| `src/forge/forge.ts` | Replace `family: "Forged"` (2 places) with a family picker defaulting to `"wave"` |
| `src/ui/chest.ts` | Tooltip shows the family *label* (`FAMILIES`), not the raw string. Optional in the same PR: replace the single "made from configs" divider with one divider per family, in PLAN order |

Check: `npm test` (typecheck) passes; a config with `"family": "Plate"` still loads and appears under Vibration with a console/dev-log warning.

### R1.2 Toy type

| File | Change |
|---|---|
| `families.ts` (or new `toys/types.ts`) | `TOY_TYPES: { id, label, glyph }[]` with the starter vocabulary (TOY-BOOK §3.1); unknown ids fall back to a generic glyph and the id as label |
| `audio/config.ts` | Optional `type?: string` on `ToyConfig` |
| `registry.ts` | `ToyEntry.type: string`; built-ins: spire `string`, orrery `clock`, kettle `garden`; configs read `config.type ?? "box"` |
| `configs/*.json` | bowl `bell`, bottle `organ`, pendulum `clock`, spark-box `box` |

### R1.3 Pack and brand

| File | Change |
|---|---|
| new `apps/playground/.env` | `VITE_BRAND_NAME=Cosmic Playground`, `VITE_SUPPORT_EMAIL=` (shared with R4.2); `.gitignore` already ignoring `.env*.local` or add it |
| new `src/brand.ts` | `export const brand = { name, supportEmail }` from `import.meta.env`; `fill(template, values)` replaces `{brandName}` / `{supportEmail}` |
| `src/env.d.ts` | `ImportMetaEnv` typing for the two variables |
| `audio/config.ts` | Optional `pack?: { id: string; channel: "builtin" \| "community" \| "local"; creator?: string }` and `author?: string` |
| `registry.ts` | `ToyEntry.pack`; built-ins and the 4 shipped configs get `{ id: "core", channel: "builtin", creator: brand.name }` (creator filled at runtime, not stored in JSON); configs without `pack` (Forge, imports) become `{ id: "local", channel: "local", creator: author ?? "You" }` |
| new `src/toys/packs.ts` | `interface PackSource { list(): Promise<PackSummary[]> }`, `PlaceholderPackSource` returning one "Community packs: coming soon" summary. No network code |

### R1.4 Gallery grouping (amends TOY-BOOK B2)

Built inside the B2 work, not before it. `ui/toy-book/gallery.ts` gets a `groupBy: "family" | "type" | "pack"` state and a `filters: { status, row? }` state, persisted with `prefs.save("toyBook", …)` and mirrored to `?book=<group>:<row>`. The `planned.ts` entries need `type` and `pack` too, so the B1 sync check also asserts every entry (built-in, config, planned) has a known family, a type and a pack.

---

## 2. Modes

### R2.1 Spire: snap the fundamental, then the harmonic

`crates/hypertoy-wasm/src/builtin.rs`, `Spire::configure`:

```rust
let base = cx.tuning.snap(f0);
let f = (base * harmonic).min(6000.0);
self.freq = if cx.wild { f } else { cx.tuning.snap(f) };   // cx.wild from R2.2
```

- With world `wild`, `snap` is identity, so the wild behaviour is unchanged.
- Add a test next to the existing Spire tests: in just pentatonic on C, for a raw f0 up to ±80 ¢ off the root, harmonics 2, 3, 4, 5, 6, 8 land exactly on `degree()` values, and harmonic 7 lands on degree 4 (A).
- Refresh `golden.rs` fingerprints that include a Spire, in the same commit, with a note in the message that the change is intended.
- `toys/spire.ts` reads pitch from `Snap.freq`, so the TS side needs no change.

### R2.2 Per-toy `wild`

| Layer | Change |
|---|---|
| `engine.rs` | `Slot.wild: bool`; `Ctx` gains `wild: bool` (slot's flag); `pub fn set_wild(slot, on)` |
| `voice.rs` | `Ctx::snap(hz)` helper = `if self.wild { hz } else { self.tuning.snap(hz) }`; voices that snap (Kettle bubbles, Orrery period quantize, Spire) use it or check `cx.wild \|\| cx.tuning.wild` |
| `custom.rs` | Effective wild = `self.wild \|\| cx.wild` (the law's own flag still works) |
| `lib.rs` | `toy_set_wild(e, slot, wild)` export |
| `audio/protocol.ts`, `worklet.ts` | `{ t: "wild"; slot; wild }` command → `toy_set_wild` |
| `toys/toy.ts` | `Toy.wild` (default false) + `setWild(on)`; included in `ToySnapshot` / `restore` so rooms and today's snapshot path carry it |
| `net/doc.ts` | Toy map field `wild` (omitted when false) |

No UI yet: only scenarios set it (MODES §7.1 finale `then`). WorldDoc's `wild` toy field (SAVE-LOAD §3) is written by S1's `toJSON`.

### R2.3 Note events for subscribed slots

| Layer | Change |
|---|---|
| `engine.rs` | `Slot.report_notes: bool`; `push_event(… NOTE …)` when `external() \|\| report_notes` (both call sites: `poke` and the block loop); `set_report_notes(slot, on)`; keep the per-block event cap, dropping oldest |
| `builtin.rs` | Check that Kettle (each bubble) and Orrery (each planet chime) set `fx.note`; add it where missing |
| `lib.rs` | `toy_set_report_notes` export |
| `worklet.ts` | `{ t: "notes"; slots: number[] }` sets the flags; while any slot is subscribed, collect that block's NOTE events for subscribed slots into a small `Float32Array` of `[slot, beat, hz, vel]` (beat = block start beat + frame / samples-per-beat) and attach it to the next `snap` message as `notes` (transferred). VMA consumption is unchanged |
| `audio/protocol.ts`, `host.ts` | `FromWorklet` snap gains optional `notes`; `AudioHost.onNotes` callback (no buffering when nobody listens) |

Consumers come with MODES P1 (`ToyObs.notes`). Test: a native Rust test that a subscribed Kettle slot yields one NOTE per bubble, and an unsubscribed one yields none.

### R2.4 Reservations and `freeSpot()`

`world.ts`:

```ts
private reserved = new Map<string, { pos: THREE.Vector3; radius: number }>();
reserve(id: string, pos: THREE.Vector3, radius: number) { … }
release(id: string) { … }
```

`freeSpot()` adds `[...this.reserved.values()].every((r) => r.pos.distanceTo(p) > r.radius + 1.5)` to its filter. The fallback `(0, 0, -5)` is also checked and pushed outward if reserved. Reservations are local and derived (the Heart re-reserves when a scenario loads), so they're not in snapshots or the room doc.

### R2.5 Chord strictness (amends MODES P1)

In the goal module: `chord.evaluate` uses `allowed = scenario.allowedPcs ?? union(goal pcs)`; `met = T ⊆ S && (S \ T) ⊆ allowed`; closeness = `|S ∩ T| / |T| × (1 − |S \ allowed| / |S|)`. Unit tests: strict default refuses an extra; an allowed extra passes; closeness is monotone as the missing tone approaches. The validator checks `allowedPcs` ⊇ every goal's target pcs. The finale-fit test (MODES §10) reads the same field.

### R2.6 Scenario naming (amends MODES P1, DEV-MODE D3)

- Puzzle content lives in `apps/playground/puzzles/<id>.json`, ids `puzzle-first-light`, `puzzle-tide-clock`, `puzzle-nightfall`, series `puzzle-dawn`.
- The ScenarioDoc validator enforces `^[a-z]+(-[a-z0-9]+)+$` for `id` and `series`, and refuses `format: "cosmic-test-scenario"` with "this is a dev test scenario; load it from the dev panel".

### R2.7 Teacher mode

No code. A `docs/TEACHER-MODE.md` is written after MODES P5. Until then, P0–P5 keep rules as room data, editable only through the scenario loader, and add no admin-authoring UI.

---

## 3. Save / load

### R3.1 View bookmark (amends S1 and S2)

- S1: `World.toDoc()` writes `view.camera` from `Stage` (`azimuth`, `elevation`, `distance`, `target`); `loadDoc` never applies it, and returns it to the caller.
- S2: `ui/constellations.ts` shows the "eye" chip for 8 s after an open when the saved view is more than ~15° or 20% distance away from the current one; tap → `stage.flyTo(view, 600)` (instant under reduced motion). The sheet gets *Save view*. Avatar modes and rooms skip the chip. Needs `Stage.flyTo` (small tween in `render/stage.ts`).

### R3.2 Cloud

No code. S1 review checklist item: nothing in `WorldDoc` may reference a local store (no IndexedDB keys, no file paths, no device ids). `persist/` adapters share one `WorldStore` interface (`list`, `get`, `put`, `remove`), so a `cloud.ts` adapter can be added later.

### R3.3 Variant Form locked (amends S4)

- `ToyTemplate` validator: for data-toy variants with `config`, `deepEqual(config.form, base.form)` or reject with "Variants can change sound and colour, not shape (yet)".
- The template and WorldDoc parsers **keep unknown keys** (store the raw object, overlay known fields), and `toJSON` writes them back. A fixture with an unknown `form` key round-trips unchanged (added to the S1 round-trip test).

---

## 4. Dev mode

### R4.1 Players stay unmuted

No change. D0's muted start is gated on `devMode() !== "off"`; a test asserts a production build without flags starts unmuted.

### R4.2 Release feedback (brand variables now, the rest amends D2)

- Now: `.env`, `brand.ts`, `env.d.ts` (shared with R1.3). `PUBLISHING.md` §9 lists the variables.
- D2 adds `src/ui/dev/where-notes.ts`, the "Where's my note?" card:
  - desktop: path from Tauri `appDataDir()` + `notes/`, copy button, **Show in folder** (add `tauri-plugin-opener` to `apps/desktop/src-tauri` with a capability for `revealItemInDir` on that folder only);
  - browser: **Download notes** builds `cosmic-feedback-<date>.zip` from IndexedDB with a store-only zip writer (`src/dev/zip.ts`, ~80 lines: local headers, CRC-32, central directory);
  - the three-step guide, with `fill()` for `{supportEmail}`; step 3 falls back to "send to the team that gave you this build" and the mailto link is hidden while `brand.supportEmail` is empty.
- Desktop note writing to `<app data>/notes/` uses `tauri-plugin-fs` scoped to that folder.
- Test: in a `?feedback` production build, saving a note shows the card; with an empty support email no `mailto:` link is in the DOM.

### R4.3 Note contents (amends D2)

`src/dev/notes.ts`: `summarize(doc)` builds the Markdown *Context* list; `stripModules(doc)` replaces each `modules[hash]` with `{ abi, bytes: null, size, dropped: true }`. The loader treats a dropped module like a missing config: the toy becomes a sealed placeholder naming the hash. Test: a world with a Faust module produces a note under 50 KB without a screenshot, and its scenario loads with one placeholder.

### R4.4 Test scenario naming (amends D3 and D5)

- Starter scenarios use the new names (DEV-MODE §8.4).
- The dev-files plugin's *Save current…* and *Promote* suggest `{mode}-{subject}-{descriptor}` from the current state (mode from `world.mode.id`, subject from the scenario id or "sandbox"), and reject names that don't match the pattern.
- `scripts/test-scenarios.mjs` refuses files whose `format` isn't `cosmic-test-scenario`, and accepts `{ "puzzle": "<id>" }` in `world` only for ids found in `apps/playground/puzzles/`.

---

## 5. Order and dependencies

```
now ─┬─ R2.1 Spire snap ─► R2.2 per-toy wild ─► R2.3 note events      (engine series, one golden refresh)
     ├─ R1.1 families ─► R1.2 type ─► R1.3 pack + brand.ts/.env         (TS + JSON)
     └─ R2.4 reserve/freeSpot                                          (TS)

with planned steps:
  TOY-BOOK B1/B2 ◄── R1.1–R1.3   (R1.4 is part of B2)
  MODES P1       ◄── R2.1, R2.3; includes R2.5, R2.6
  MODES P2       ◄── R2.4
  MODES P3       ◄── R2.2
  SAVE-LOAD S1   includes R3.1 (format), R3.2 (review), R3.3 (unknown keys), WorldDoc `wild`
  SAVE-LOAD S2   includes R3.1 (chip);   S4 includes R3.3 (form check)
  DEV-MODE D2    ◄── R1.3/R4.2 brand vars; includes R4.2 UI, R4.3
  DEV-MODE D3/D5 include R4.4
```

The engine series (R2.1–R2.3) and the TS series (R1.1–R1.3, R2.4) touch disjoint files and can run in parallel.

---

## 6. Testing summary

| Item | Test |
|---|---|
| R1.1–R1.3 | Typecheck; the B1 sync check (when it lands) asserts family ∈ six, type and pack present for all 18 toys; an old-label config loads with a warning |
| R2.1 | Rust unit test for exact harmonics under ±80 ¢ drift; refreshed goldens |
| R2.2 | Rust test: a wild Spire on harmonic 7 sounds 7/4 × the snapped root (± 0.5 ¢); a non-wild one sounds 5/3 |
| R2.3 | Rust test: NOTE events per bubble for a subscribed Kettle, none unsubscribed; worklet message includes `notes` only while subscribed |
| R2.4 | A small node check (or a D4 scenario later) that 16 `freeSpot()` calls with a reservation at the origin never return a spot inside `radius + 1.5` |
| R2.5 | Goal unit tests (MODES §10) |
| R3.x | S1 round-trip with an unknown key and a `view`; S4 form-change rejection |
| R4.x | Feedback-card scenario; note size check; scenario naming lint in the runner |

There is no JS unit-test runner today (`npm test` is cargo + typecheck + relay). Pure-TS checks above start as `node` scripts under `scripts/` and move to vitest when SAVE-LOAD S1 or MODES P1 adds it.
