# Launch screen, main menu and settings plan

> A **launch screen** that doubles as the main menu: pick up the last world in one tap, open any
> saved world, start a new one, jump into puzzles or a room, or change settings. A **Home** button
> in the world leaves it (autosaved, never lost) and comes back here. One **Settings** sheet
> gathers the per-device options that are scattered today.

Status: **MM1 and MM2 built** (Oct 2026; see §8.1), MM3–MM4 to do · builds on [SAVE-LOAD.md](SAVE-LOAD.md) §5, §7 (store, autosave, Continue), [MODES.md](MODES.md) (puzzle shelf), [MULTIPLAYER.md](MULTIPLAYER.md) (rooms), [AUDIO-MIX.md](AUDIO-MIX.md) §3 (master, mute), [AVATAR.md](AVATAR.md) §13 (avatar settings), [DEV-MODE.md](DEV-MODE.md) §3 (dev and test starts)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| What the launch screen is | The **main menu**, drawn over a quiet, slowly turning starfield. It replaces the "tap anything to wake the cosmos" line: the first tap on the menu is the audio-unlock gesture. |
| What's on it | **Continue** (big card: the last world's thumbnail, name, "12 min ago"), **New world**, **Saved worlds** (a grid of every named save), **Puzzles**, **Play together**, **Open file**, **Settings**. Glyph-first, text second (pillar 7). |
| Last world | The **autosave** is the last world. A small `cosmic.last` pref says what it was (sandbox save, unnamed world, puzzle, room) so Continue can do the right thing. |
| Leaving a world | A **Home** button on the HUD (and gamepad *Start*/*Options*). Autosave now, fade the sound out, clear the world, show the menu. **No "save changes?" modal**: the autosave holds it and Continue brings it back (SAVE-LOAD §7, never block play). |
| Rooms and puzzles | Home in a room asks once ("Leave the room?"), because other people are there. Home in a puzzle leaves the puzzle; Continue on the menu reopens it. |
| Who skips the menu | Links that already say where to go (`#w=…`, `?puzzle=`, `?room=`), and `?test` runs. `?menu` forces it on. First run shows a cut-down menu with one big **Play**. |
| Settings | One **Settings sheet** (`ui/settings.ts`), opened from the menu and from the HUD. Sections: Sound, Player, Moving, Controls, Comfort, Saves, About. It reads and writes the prefs that already exist; it doesn't invent a second store. Dev settings stay in the dev panel. |

---

## 1. Goals

1. **Come back in one tap.** Opening the app with a world in progress puts *Continue* under your thumb, with a picture of where you were.
2. **See everything you've made.** All saved worlds, newest first, with thumbnails, without opening a sheet inside a world first.
3. **Leave without fear.** One obvious button leaves the world; nothing is lost and nothing asks "are you sure?" unless other players are involved.
4. **One place for settings.** Volume, name and colour, avatar size, aim ray, comfort options and storage are in one sheet, reachable from the menu and from inside a world.
5. **Don't slow down the people who are already somewhere.** Share links, room invites, puzzle links and CI scenarios open straight into their world.

### Non-goals (v1)

- Profiles or accounts (kid profiles are a later SAVE-LOAD item; the menu leaves room for a profile chip).
- Cloud saves (the menu lists whatever `WorldStore` returns, so Cosmic Cloud slots in later).
- Folders, tags or search in the saved-world grid.

---

## 2. What exists to build on

| Today | Where | Use |
|---|---|---|
| `WorldStore.list()` (named saves, newest first, with thumbnails), `get`, `remove`; `AUTOSAVE` row | `persist/store.ts` | The saved-worlds grid and the Continue card read it directly |
| Autosave every 30 s, on hide and on `pagehide`, with a thumbnail; `cosmic.autosaveOf` links it to its named save | `ui/constellations.ts` `autosave()` | "Last world"; Home calls it before clearing |
| Continue chip and "start fresh" on start | `Constellations.start()`, `offerContinue()` | Moves to the menu's Continue card; the chip goes away |
| `newWorld()`, `openSaved(id)`, `importFrom(file)`, `apply()` with the room/lock checks | `ui/constellations.ts` | Menu actions call these; no second load path |
| Starter toys (Spire + Orrery) added in `main.ts` at boot | `main.ts` | Become `starterWorld()`, used by *New world* and first-run *Play* |
| `#wake` line, hidden on `audio.onReady` | `index.html`, `main.ts` | Replaced by the menu |
| Puzzle shelf with `open(id)` / `leave()`, solved list in `puzzles.solved` | `ui/puzzles.ts`, `modes/puzzle.ts` | Menu *Puzzles* opens the shelf's list as a page |
| Room sheet with `leave()`; player name/colour in `cosmic.player` | `ui/room.ts`, `net/presence.ts` | *Play together*; the Player section of Settings |
| Per-device prefs: `prefs.ts` (`load`/`save` on localStorage). Mix (`master`, `muted`, `muteWhenHidden`), avatar (`size`, `frozenFly`, `third`), aim preview, hotbar | `audio/mix.ts`, `avatar/settings.ts`, `render/aim-preview.ts`, `ui/hotbar.ts` | Settings edits these through their owners' setters |
| Avatar ⚙ popover next to the view buttons | `ui/modes.ts` | Stays as a quick shortcut; it also gets a "More settings" link into the sheet |
| Dev mode decides `off/dev/test/feedback` before anything plays | `devmode.ts` | `test` skips the menu |

---

## 3. App states

A small state machine in a new `src/shell.ts`, owned by `main.ts`:

```
            ┌───────── link / ?puzzle / ?room / ?test ─────────┐
 boot ──► MENU ──Continue / New / Open / Puzzle / Room──► WORLD
            ▲                                               │
            └──────────── Home (autosave, fade, clear) ─────┘
```

- **`menu`**: the stage keeps rendering (backdrop, §4.1), the world is empty, the frame loop skips `input`, `gamepads`, `focus` and `world.update` toys (no Pulses running), the HUD, chest, hotbar and chips are hidden (`body.in-menu`).
- **`world`**: today's app. Entering it closes the menu and shows the HUD; leaving it runs §5.
- `Shell.enter(how)` takes `{ kind: "continue" } | { kind: "new" } | { kind: "saved", id } | { kind: "file", file } | { kind: "puzzle", id } | { kind: "room", code? }` and calls the existing `Constellations` / `PuzzleShelf` / `RoomSheet` methods. The menu never loads a world itself.
- **History:** entering a world does `history.pushState({ cosmic: "world" }, "")`; the browser/Android back button pops it and runs Home. The state lives in `history.state`, not the hash, so it doesn't fight `#w=` links.

---

## 4. The main menu

### 4.1 Look

- Full-screen layer over the canvas (`ui/menu.ts`, `#menu`), the same dark palette as the sheets. The stage shows a calm starfield with the orbit camera drifting; no toys, no sound. (Later: the Continue world's thumbnail scene, silent, behind the card.)
- The title "Cosmic Playground" small at the top; everything else is big touch targets (min 64 px), one column on phones, two on wide screens.
- Works with keyboard (arrow keys / Tab, Enter), gamepad (D-pad, A, B = back) and screen readers (a `nav` of real buttons; the grid is a `list`).

### 4.2 Contents

```
 ┌───────────────────────────────────────────────────────┐
 │  Cosmic Playground                         ⚙  ?       │
 │                                                       │
 │  ┌───────────────────────────────┐  ┌──────────────┐  │
 │  │ [thumbnail]                   │  │  ✦ New world │  │
 │  │ ▶ Continue                    │  ├──────────────┤  │
 │  │ Violet Orbit 3 · 12 min ago   │  │  ◎ Puzzles   │  │
 │  └───────────────────────────────┘  ├──────────────┤  │
 │                                     │ ⚇ Play       │  │
 │                                     │   together   │  │
 │                                     └──────────────┘  │
 │  Your worlds                              ⇪ Open file │
 │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                  │
 │  │ img  │ │ img  │ │ img  │ │ img  │  …               │
 │  │name  │ │name  │ │name  │ │name  │                  │
 │  └──────┘ └──────┘ └──────┘ └──────┘                  │
 └───────────────────────────────────────────────────────┘
```

| Item | Does | Notes |
|---|---|---|
| **Continue** | Opens the last world (§4.3) | Hidden when there's nothing to continue |
| **New world** | `starterWorld()`: clear, Spire + Orrery, fresh name | Same as today's boot world |
| **Your worlds** | Every named save from `store.list()`, newest first: thumbnail, name, relative time, toy count | Tap opens. Long-press / right-click / `⋯`: Rename, Export, Delete (delete has a 5 s **Undo** toast instead of a confirm) |
| **Puzzles** | The puzzle list as a page (✓ solved, locked ones dimmed) | Reuses `PuzzleShelf`'s list renderer |
| **Play together** | Host a room, or type/scan a join code | Reuses `RoomSheet`; a join goes straight into the world |
| **Open file** | File picker for `.constellation.json` (and toy files, which go to the library) | Dropping a file on the menu works too |
| **⚙ Settings** | The Settings sheet (§6) | |
| **? Help** | `guide.html` | |
| **Quit** | Desktop app only (Tauri) | Not shown in browsers |

Empty states: no saves → "Your worlds" is replaced by a one-line hint; storage blocked (private window) → "Saving is off in this window; Open file still works" (same text as the sheet).

### 4.3 The last world

`cosmic.last` (prefs) is written whenever a world is entered or autosaved:

```ts
type Last =
  | { kind: "world"; save: string | null }   // sandbox; `save` = named save id, or null if never named
  | { kind: "puzzle"; id: string }            // puzzles aren't autosaved; Continue reopens the puzzle
  | { kind: "room"; code: string };           // Continue offers "Rejoin room ABCD" (if it's still open) or the local copy
```

- **Card picture and name:** for `world`, the `AUTOSAVE` row's thumbnail and name; for `puzzle`, the puzzle's name and glyph; for `room`, the room code and the local autosave as the picture.
- **Unsaved changes:** if the autosave belongs to a named save (`cosmic.autosaveOf`) and is newer than it, that save's tile in the grid shows a small dot and opening the tile asks nothing: it opens the newer autosave (the same as Continue). Opening it from the grid is how you'd see "where I left it", which is what people mean.
- **Unnamed worlds:** never-saved worlds only live in the autosave, so Continue is their only door. A **Keep** button on the Continue card (☆) turns it into a named save without opening it.
- **Fresh starts drop the old autosave?** No: *New world* only replaces the autosave after the first real change, as today. Until then Continue still points at the old one.

### 4.4 First run

No autosave, no saves, no solved puzzles → the menu shows one big **▶ Play** (= New world), plus small Puzzles, Play together and ⚙. Kids' first tap is still one tap to sound, as the wake screen promised.

### 4.5 Who skips it

| Start | Goes to |
|---|---|
| `#w=…` share link | That world (as today), `cosmic.last` updated |
| `?puzzle=id` | That puzzle |
| `?room=CODE` (invite) | The room |
| `?test` (CI, Playwright) | `New world` immediately, so existing scenarios don't change; `?test&menu` keeps the menu for menu tests |
| `?dev` / dev server | The menu (dev config `menu: false` skips it, DEV-MODE §3.2) |
| `?menu` | The menu, even with a link (link becomes the Continue card instead) |

---

## 5. Leaving a world (the Home button)

- **Where:** a `⌂` button at the left end of the HUD, before the Constellation button; `aria-label="Main menu"`. Gamepad *Start* (Options/≡) on seat 1 opens a small pause card (Resume · Settings · Main menu); other seats' Start does nothing. Keyboard: Esc is already the "close sheet / clear selection / leave focus" chain, so **Esc when nothing is left to close** opens the same pause card, and Esc-Esc-Esc always ends somewhere useful (see open question 3).
- **Sequence:**
  1. If in a **room**: ask "Leave the room? The others keep playing." (the one confirm in this plan). Then `room.leave()`; the local autosave keeps a copy.
  2. If in a **puzzle**: `puzzles.leave()` after noting `cosmic.last = { kind: "puzzle", id }`.
  3. `constellations.autosave()` now (forced, even if the fingerprint check would skip it for the thumbnail).
  4. Fade master to 0 over 300 ms (`world.mix`), then `clearWorld(world)`, close every sheet (editor, chest, listen, focus, pulse), exit avatar mode and pointer lock, clear selection and undo stack.
  5. Restore master level (silent world anyway), `shell.state = "menu"`, render the menu with the fresh autosave on the Continue card.
- **History:** if the world was entered with `pushState`, Home calls `history.back()` and the `popstate` handler does the sequence, so the back button and Home are the same code path.
- **Dirty named save:** no modal. The Constellation button's dirty dot already tells you; the grid tile shows the same dot on the menu.

---

## 6. Settings

One sheet, `ui/settings.ts`, opened from the menu's ⚙, from the pause card, and from a "More settings…" link in the HUD's avatar ⚙ popover and the Listen sheet. Sections are collapsible on phones, tabs on wide screens.

| Section | Settings | Owner (already exists unless marked new) |
|---|---|---|
| **Sound** | Master volume, mute, mute when the tab is hidden | `world.mix` (`master`, `setMuted`, `muteWhenHidden`) |
| **Player** | Name and colour (shown to others in rooms and on the avatar) | `net/presence.ts` (`cosmic.player`) |
| **Moving** | Avatar size (S/M/L slider), first or third person by default, fly frame | `AvatarSettings` |
| **Controls** | Aim ray on by default (B), look sensitivity and invert Y (new), gamepad layout card (the `gamepad-map` table, read-only) | `render/aim-preview.ts`; new keys in `cosmic.controls` |
| **Comfort** | Reduce motion (no camera drift, no fly-to), reduce flashing (caps Pulse glow), bigger UI text, colour-blind-safe toy palette (new) | New `cosmic.comfort`; read by `stage.ts`, `style.css` (`body.big-ui`), toy materials |
| **Saves** | Space used, "Keep saves even when the device is low on space" (`persistStorage()`), Export all worlds (zip of `.constellation.json`), Delete all saves (typed confirm) | `persist/store.ts` |
| **About** | Version / build id, engine version, links to Help and the guide | `import.meta.env`, `doc.app` |

Rules:

- Settings are **per device** and never go into a `WorldDoc` or a room. World-level things (tempo, Tuning, toy volume) stay on the HUD because they're part of the music.
- Every control applies live, no Save button. The sheet's only state is which section is open (`cosmic.settings.tab`).
- New settings go through a tiny registry (`settings/registry.ts`: key, default, clamp, `apply()`), so the dev panel's Settings tab can show the same rows and tests can set them by key.

---

## 7. Code changes

| File | Change |
|---|---|
| `src/shell.ts` (new) | `Shell` state machine (§3): `enter(how)`, `home()`, `popstate`, `body.in-menu` |
| `src/ui/menu.ts` (new) | Menu layer: Continue card, actions, saved grid, first-run variant, keyboard/gamepad focus |
| `src/ui/settings.ts`, `src/settings/registry.ts` (new) | Settings sheet and registry (§6) |
| `src/ui/pause.ts` (new) | Pause card for gamepad Start / last Esc |
| `main.ts` | Build everything as now, but don't add starter toys or call `constellations.start()`; hand both to `Shell`. Frame loop checks `shell.state`. |
| `ui/constellations.ts` | `start()` returns what it found (link / autosave) instead of showing the Continue chip; expose `autosave(force)`, `lastWorld()` (autosave meta + `autosaveOf`), `rename(id)`, `exportSaved(id)`. Writes `cosmic.last`. |
| `ui/puzzles.ts` | Export the list renderer for the menu page; note `cosmic.last` on open |
| `ui/room.ts` | `join(code)` callable from the menu; note `cosmic.last` on join |
| `ui/hud.ts` | `⌂` Home button |
| `ui/modes.ts`, `ui/listen.ts` | "More settings…" links |
| `input.ts` | Esc chain ends in the pause card; ignore input in `menu` |
| `controllers/gamepad.ts` | Start → pause card (seat 1); menu navigation with D-pad/A/B |
| `index.html`, `style.css` | `#menu` replaces `#wake`; `body.in-menu` hides HUD/chest/hotbar; help text gets a "Main menu" line |
| `dev/config.ts` | `menu: boolean` (default true in dev, false in test) |

---

## 8. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **MM1. Shell and Home** | `Shell`, `#menu` with Continue / New world / Your worlds (open only) / Open file, Home button, §5 sequence, `cosmic.last`, link and `?test` skips | Play, press Home, the menu shows the world on Continue with a fresh thumbnail; Continue restores it exactly (same `roundTrip` JSON); a `#w=` link still opens straight in |
| **MM2. The rest of the menu** | Puzzles page, Play together, tile menu (rename/export/delete + Undo), first-run variant, Keep on Continue, history/back button, unsaved-changes dot | A first-time player reaches sound in one tap; deleting a world and pressing Undo brings it back; Android back from a world returns to the menu |
| **MM3. Settings** | Registry, sheet with Sound / Player / Moving / Saves / About; links from the menu, HUD ⚙ and Listen | Changing volume, name and avatar size in the sheet matches the old controls and survives a reload |
| **MM4. Comfort, controls, pads** | Comfort and Controls sections, pause card, gamepad and keyboard menu navigation, Tauri Quit | The whole menu, a world and Home can be driven with only a gamepad, and with only a keyboard |

MM1 is small and unblocks the rest; MM3 can run in parallel with MM2.

### 8.1 What's built

- **MM1:** `src/shell.ts` (`Shell`: `boot`, `enter`, `entered`, `home`, `requestHome`, the menu's camera drift, `cosmic.last`), `src/ui/menu.ts` (`Menu`: Continue card, actions, Your worlds grid), `src/ui/ask.ts` (the shared yes/no box; Constellations uses it too), the `⌂` HUD button, `Input.enabled` / `Input.reset()`. `Constellations` lost the Continue chip and gained `listSaved`, `lastWorld`, `continueLast`, `startFresh`, `keepLast`, `renameSaved`, `exportSaved`, `removeSaved`, `pickAndImport`; it never autosaves or takes shortcuts on the menu (`inWorld`). Exit check: `cosmic.test.enter({kind})` and `cosmic.test.home()`; open → change → Home → New → Home → Continue gives the same world (minus name/dates), and an untouched new world never replaces the autosave.
- **MM2:** the Puzzles page, Play together (new world + the room sheet), Rejoin room, the tile `⋯` menu (Rename inline, Export file, Delete with a 5 s Undo), the first-run Play screen, ☆ Keep on the Continue card, the unsaved-changes dot (and opening such a tile opens its newer autosave), Back/Home through `history.pushState`, "Leave the room?" before leaving a room.
- **Differences from the plan:** the menu backdrop is the empty orbit view drifting (no starfield yet); `?menu` only matters with `?test`; the dev-config `menu: false` switch and the pause card (Esc / gamepad Start) are left for MM4; a dropped world file on the menu opens it.

---

## 9. Testing

- `cosmic.test.menu()` / `cosmic.test.home()` hooks, and a `menu` scenario (DEV-MODE §6): new world → poke → Home → Continue → assert the WorldDoc matches.
- Playwright with `?test&menu`: first run shows Play; with a seeded autosave shows Continue; with three saves shows three tiles in modified order.
- Audio: Home fades to silence (onset log empty 400 ms after Home) and no Pulses run in the menu.
- Rooms: Home in a room as a guest leaves only that player; as admin, the room keeps running for the others (MULTIPLAYER rules).

---

## 10. Open questions

1. **Menu backdrop:** plain starfield (cheap, recommended for MM1) or the Continue world rendered silently behind the card (prettier, costs a load on every launch)?
2. **Unnamed worlds:** should leaving an unnamed world with toys quietly name and save it (so it appears in "Your worlds"), or keep it only on Continue until the player taps Keep? Recommended: name it automatically once it has been played for 2+ minutes, so the grid is the full history and Continue isn't the only door.
3. **Esc to the pause card:** good on desktop, but could surprise people who press Esc reflexively. Alternative: Esc never opens it, only Home and Start.
