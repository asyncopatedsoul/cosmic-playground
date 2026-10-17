# World save/load and toy templates plan

> Save a whole world as a **Constellation** (PLAN §1.1) and open it again later, on any device,
> in the desktop app, or into a multiplayer room. Save any single toy, exactly as you've tuned it,
> as a **variant** that lives under its toy type in the chest.

Status: plan · Oct 2026 · step S1 is a prerequisite of [MULTIPLAYER.md](MULTIPLAYER.md) step M1 · builds on [PLAN.md](PLAN.md) §1.1 (Constellations), §5.1 (Tier 0 remix) and [AUDIO-GEN.md](AUDIO-GEN.md) §3 (toys as data)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| One format for everything | **`WorldDoc`**: plain, versioned JSON. The same shape is the saved file, the autosave, the share link and the multiplayer room document. |
| Toy identity | Toys get a **stable id**; engine slots become a local detail. (Needed for multiplayer anyway.) |
| Where worlds live | **IndexedDB** in the browser (autosave + named saves), **files** everywhere (`.constellation.json` export/import), **native dialogs** on desktop, **URL hash** for small worlds. |
| Variants | **`ToyTemplate`**: a base toy id plus a preset (params, Pulse, pattern, recipe, optionally an edited config). Shown as a fan of cards behind the base toy in the chest. |
| Portability | A world **embeds** every template and custom config it uses, so a friend (or a room) can open it without your library. |
| Safety | Loading never runs code that wasn't already allowed: configs go through the same compile and guard path; worlds with custom WASM voice modules ask first. |

---

## 1. Goals

1. **Never lose a jam.** Autosave every 30 s and on tab hide; reopening the app offers "Continue where you left off".
2. **Save, open, share.** Named saves, a recent list with thumbnails, file export/import, and a link for small worlds.
3. **Same file everywhere.** A world saved in a phone browser opens in the desktop app and in a multiplayer room, and back.
4. **Variants feel like toys, not presets.** A variant is something you pull from the chest, with its own name and a tinted icon, not a row in a preset menu (pillar 1).
5. **Forward compatible.** Old files open in new builds via migrations; unknown toys are kept as placeholders, never dropped.

---

## 2. What exists to build on

| Today | Where | Use |
|---|---|---|
| Toy state is params + Pulse + pattern (+ zap recipe) | `toys/toy.ts`, `config-toy.ts` | Everything a toy save needs |
| `ToyConfig` JSON for data toys; Forge toys arrive as configs | `audio/config.ts`, `toys/configs/*.json`, `main.ts` BroadcastChannel | Embedded configs; variants of data toys |
| Registry with `registerToy` (add/replace by id) | `toys/registry.ts` | Templates and loaded configs register here |
| World: tempo, Tuning (preset, table, Scala) | `world.ts` | World-level fields. Custom tables are only sent to the engine today; the world must **keep** the cents/Scala text so they can be saved. |
| Recipe Box copy/paste | `ui/recipe-box.ts` | Same clipboard idea for whole toys |

Nothing persists today: no `localStorage`, no IndexedDB.

---

## 3. The `WorldDoc` format

```jsonc
{
  "format": "cosmic-world",
  "version": 1,
  "name": "Violet Orbit 3",
  "created": "2026-10-17T18:04:00Z",
  "modified": "2026-10-17T18:31:12Z",
  "app": { "build": "2500ee5", "engine": "hypertoy-wasm 0.1.0" },
  "seed": "4KZ7Q2MD",
  "tempo": { "bpm": 96 },
  "tuning": {
    "root": 60, "scale": 0, "wild": false,
    "custom": null            // or { "name": "31-EDO", "cents": [...], "period": 1200 } or { "name": "...", "scl": "..." }
  },
  "toys": [
    {
      "id": "t_9F3KQ2ZB",
      "kind": "spire",                       // registry id
      "template": "v_2HXQ8M1C",              // optional: the variant it came from (embedded below)
      "config": null,                        // embedded ToyConfig for data toys not in this build
      "pos": [-2.4, 0, 0.8],
      "quat": [0, 0, 0, 1],                  // orientation; matters on planets (AVATAR.md)
      "body": null,                          // gravity body it stands on, null = ground
      "params": { "length": 1.2, "tension": 0.55, "harmonic": 3 },
      "pulse": { "enabled": true, "steps": 8, "prob": [1,0,0,1,0,0,1,0], "stepsPerBeat": 2, "speed": 1 },
      "pattern": "",
      "recipe": null,
      "volume": 0.8                          // shared mix level (AUDIO-MIX.md §3)
    }
  ],
  "templates": { "v_2HXQ8M1C": { /* ToyTemplate, §6.1 */ } },
  "configs": { "my-faust-thing": { /* ToyConfig */ } },
  "modules": { "sha256:…": { "abi": "faust", "bytes": "<base64>", "json": "…" } },
  "bodies": [],                              // gravity bodies (AVATAR.md §4)
  "view": { "camera": { "azimuth": 0, "elevation": 0.6, "distance": 9.5 } },  // optional bookmark, never forced
  "thumbnail": "data:image/webp;base64,…"    // ≤ 24 KB, for the recent list
}
```

Notes:

- **Not saved:** master volume, mute/solo/focus, open panels, avatar mode, ray preview. Those are the listener's, not the world's ([AUDIO-MIX.md](AUDIO-MIX.md) §3, [MULTIPLAYER.md](MULTIPLAYER.md) §4.1).
- **Derived params** (`ParamDef.derived`, e.g. Kettle `coverage`, `activity`) are not saved; the toy recomputes them.
- **Kettle field.** v1 doesn't save the reaction-diffusion field; a reopened Kettle starts calm and refills from its Pulse. v2 option: a quantized 128×128 PNG of the field (a few KB).
- **Orrery** planets are its params (`p0`–`p3`), so they save as-is. Phases restart in step with the beat grid, as they do when launched.
- **Slots** are not saved. Loading fills slots in `toys` order.
- **Ids** are random 8-character base32 strings with a type prefix (`t_` toy, `v_` variant, `b_` body).
- A JSON Schema file (`docs/schema/world.v1.json`) is generated from the TS types and used in tests; at runtime a small hand-written validator (no new dependency) checks types and ranges and clamps params to their `range`.

### 3.1 Migrations

`migrate(doc)` steps `version` forward one at a time (`v1 → v2 → …`). A file with a **newer** version than the build opens read-only with a notice. A toy whose `kind` is unknown and has no embedded config becomes a **placeholder**: a grey sealed box that keeps its data, saves it back unchanged, and explains "This toy needs a newer Cosmic Playground".

---

## 4. Code changes

| Change | Where |
|---|---|
| `Toy.id` (stable) and `World.byId` | `toys/toy.ts`, `world.ts` |
| `Toy.toJSON()` / `Toy.applyState(state)` (params, Pulse, pattern, recipe, volume) | `toys/toy.ts`, `config-toy.ts` |
| `World.toDoc()` / `World.loadDoc(doc, { replace })` | `world.ts`, new `src/persist/doc.ts` |
| World keeps custom tuning data (`cents`, `period`, `scl` text) | `world.ts` (`setTuningTable`, `setTuningScala`) |
| `ParamDef.derived` | `toys/toy.ts`, Kettle |
| Storage adapters (§5) | new `src/persist/{idb,file,link,tauri}.ts` |
| Constellation sheet UI (§7) | new `ui/constellations.ts` |
| Variants in the chest (§6.3) | `ui/chest.ts`, `toys/registry.ts` |

`World.loadDoc` removes the current toys, applies tempo and Tuning, registers embedded configs and templates, then adds toys **with their state applied before the first Pulse** (via `init` taking an optional state), so a loaded toy never plays one wrong note with default params.

---

## 5. Where worlds live

| Store | Browser | Desktop (Tauri) |
|---|---|---|
| **Autosave** | IndexedDB `worlds/autosave`, every 30 s while dirty and on `visibilitychange → hidden` | same (the webview has IndexedDB) |
| **Named saves + recent list** | IndexedDB `worlds/<id>` with thumbnail | same, plus "Show in folder" for exported files |
| **File export / import** | Download `<name>.constellation.json`; import via file picker or drag-and-drop onto the canvas | Native Save/Open dialogs (`tauri-plugin-dialog` + `tauri-plugin-fs`), default folder `Documents/Cosmic Playground`, double-click to open (file association, later) |
| **Link** | Worlds that compress under ~6 KB go in the URL hash: `#w=` + base64url(deflate-raw(JSON)) via `CompressionStream`. Larger worlds: "too big for a link, share the file" (or a room, [MULTIPLAYER.md](MULTIPLAYER.md)). | Same link opens in the browser; desktop handles `cosmic://` later |
| **Room** | The relay snapshots WorldDoc JSON ([MULTIPLAYER.md](MULTIPLAYER.md) §7) | same |

Requests for persistent storage (`navigator.storage.persist()`) after the first named save, so the browser doesn't evict saves under storage pressure.

---

## 6. Toy templates (variants)

### 6.1 The `ToyTemplate` format

```jsonc
{
  "format": "cosmic-toy",
  "version": 1,
  "id": "v_2HXQ8M1C",
  "base": "spire",                 // registry id of the toy type
  "name": "Third-harmonic Spire",
  "tint": "#d7b8ff",               // optional colour shift, stays near the base colour
  "badge": "3",                    // optional 1–2 glyphs drawn on the base icon
  "author": null,                  // optional display name; no accounts
  "created": "2026-10-17T18:20:00Z",
  "state": { "params": {…}, "pulse": {…}, "pattern": "", "recipe": null, "volume": 0.8 },
  "config": null                   // for data toys whose *config* was edited (voice, law, form), the full ToyConfig with "extends": base
}
```

- A variant of a **built-in** toy (Spire, Orrery, Kettle) is state only.
- A variant of a **data toy** can also carry an edited `ToyConfig` (a new recipe, a changed patch). It registers as its own entry with `extends: base`, so it plays even where the base config differs.
- Variants of variants just copy: `base` always points to the root type, so the chest never grows deep trees.

### 6.2 Making one

- In the toy's panel (the Pulse editor today), a **"Keep this one"** button (a star glyph) saves the current toy as a variant: auto-named from what changed ("Fast Orrery", "Moody Bottle"), editable later.
- Keyboard: `Ctrl+Shift+K` on the last-touched / targeted toy.
- Saving a variant doesn't change the toy in the world; the toy just remembers `template` so the world file can embed it.

### 6.3 In the chest

- The base toy's card gets a small stack edge when it has variants. **Long-press / right-click / hover-pause** fans the variants out above the card; each is a normal toy card (tinted icon, badge, name). Tap or drag to place, exactly like the base.
- The Toy Book ([TOY-BOOK.md](TOY-BOOK.md)) lists variants in each toy's details view with rename, delete, duplicate and export.
- Export a variant as `<name>.cosmic-toy.json`; import by file picker or by dropping it on the chest. Imported variants whose base isn't in this build carry their config or show as a sealed placeholder.
- Copy a toy to the clipboard as a template JSON (`Ctrl+C` on a targeted toy) and paste into another world or tab (`Ctrl+V` places it at the aim point). Same format, no new code path.

### 6.4 Storage

IndexedDB store `templates/<id>`. Worlds embed the templates they use, so deleting a variant from the library never breaks a saved world; opening that world offers "Add the 2 variants in this world to your chest?".

---

## 7. UI

- **HUD → Constellation button** (a small star-map glyph) opens the Constellation sheet: *New*, *Save*, *Save as*, *Open* (recent list with thumbnails and relative times), *Import file*, *Export file*, *Share link*. Large touch targets; names optional (auto-generated, kid-safe, from colour + celestial word).
- **Keyboard:** `Ctrl+S` save, `Ctrl+Shift+S` save as, `Ctrl+O` open sheet, `Ctrl+E` export file. (`Ctrl+N` is reserved by browsers; *New* stays a button.)
- **On start:** if an autosave exists and is newer than 5 min ago, the wake screen says "Continue" (one tap) with a small "start fresh" link. Kids' first run never sees this.
- **Dirty indicator:** a dot on the Constellation button; leaving with unsaved named changes keeps the autosave, so there's never a "lose your work?" modal (pillar: never block play).
- **Multiplayer:** in a room, *Save* saves a local copy; *Open* becomes *Load into room* (host only, confirm shown to everyone).

---

## 8. Safety

- Embedded `ToyConfig`s compile through the same path as the Forge and built-in configs, including the custom-voice guard (NaN, DC, soft clip) and pattern/patch validation.
- Embedded **WASM voice modules** (`modules`) are untrusted code. A world that contains them opens with a one-time notice listing them ("This world has 1 custom sound made in the Forge. Play it?"). Each still passes the measured-cost check before loading ([AUDIO-GEN.md](AUDIO-GEN.md) §14). Kid profiles skip them and show sealed placeholders.
- Size limits on import: 2 MB per world file, 512 KB per module, 16 toys, 64 templates.
- Nothing personal is saved: no device ids, no locations; `author` is optional free text and absent in kid mode.

---

## 9. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **S1. WorldDoc core** | Toy ids, `toJSON`/`applyState`, `toDoc`/`loadDoc`, validator, migrations scaffold, world keeps custom tuning data, `derived` params | Round trip: build a world with all 7 toys and a Scala tuning, save, load, save → byte-identical JSON; audio fingerprint of 8 bars matches before/after |
| **S2. Local saves** | IndexedDB autosave + named saves, Constellation sheet, recent list with thumbnails, Continue on start | Kill the tab mid-jam; reopening restores it |
| **S3. Files and links** | Export/import, drag-and-drop, URL hash links, Tauri dialogs | A world made on a phone opens in the desktop app from a file and from a link |
| **S4. Variants** | `ToyTemplate`, "Keep this one", chest fan, export/import, clipboard copy/paste | A 7-year-old saves a variant and finds it again in the chest without help |
| **S5. Rooms** | WorldDoc ⇄ Y.Doc, relay snapshots, Load into room | A saved world loaded into a room appears identically for every player |

S1 is on the multiplayer critical path ([MULTIPLAYER.md](MULTIPLAYER.md) M1). S2–S4 can run in parallel with multiplayer M2–M3.

---

## 10. Testing

- **Round trip** (vitest or a node script): every example toy and config, every Tuning kind, variants with and without configs.
- **Migrations:** fixture files for each version in `apps/playground/test/fixtures/worlds/`, loaded by every new build.
- **Fuzz:** random and truncated JSON never throws out of `loadDoc`; it either loads (with clamps) or reports a readable error.
- **Golden audio:** a saved world rendered headless for 8 bars has the same fingerprint as the live world it came from.

---

## 11. Open questions

1. Should a world remember the **camera view**? This plan saves it as an optional bookmark that's offered, not forced.
2. Cloud saves (Cosmic Cloud, PLAN §7.2) reuse WorldDoc unchanged; when and with what account model is out of scope here.
3. Should variants be able to change the **Form** (a re-coloured, re-proportioned shape)? Tint and badge only for v1.
