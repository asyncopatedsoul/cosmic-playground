# Developer mode plan: settings, logs, notes, scenarios and test hooks

> A **developer mode** for people building and playtesting Cosmic Playground: one settings panel
> and config file, structured **logs** of what the app, players, world, toys and network are doing,
> a **notes** box that saves feedback with enough context for a person or an LLM coding assistant
> to act on, and **scenarios** that save and load a known state and drive scripted tests in CI.

Status: plan · Oct 2026 · **D0 and D1 done** (config, muted start, panel, logs, devlog sessions) · builds on [SAVE-LOAD.md](SAVE-LOAD.md) (WorldDoc), [AUDIO-MIX.md](AUDIO-MIX.md) §3 (master and global mute), [MULTIPLAYER.md](MULTIPLAYER.md) §10 (headless jam, onset log), [HELP-SYSTEM.md](HELP-SYSTEM.md) §2 (event bus)

---

## 0. TL;DR

| Feature | Recommendation |
|---|---|
| Turning it on | Always on in `vite dev` and `npm run desktop`; in a production build with `?dev` (or `?test` for CI). Its code is a **lazy chunk**, so players never download it. |
| Config | **`dev.config.json`** (checked in) + **`dev.config.local.json`** (gitignored) + `localStorage` + URL params, merged in that order. One typed `DevConfig`. |
| Global volume | Master slider + mute in the panel, **muted by default** in dev mode and always in test mode. Uses the AUDIO-MIX master and mute ramp, never `AudioContext.suspend()`. |
| Logs | One structured log (`{ t, beat, ch, lvl, ev, data }`) with channels `app`, `player`, `world`, `toy`, `net`, `session`, `audio`, `perf`. Fed by the event bus and the existing `World.listeners`. Ring buffer, live viewer, state inspector, JSONL export. |
| Notes | `F8` opens a note box. A note saves as **Markdown with frontmatter** plus attached context (build, device, world, recent log, screenshot, scenario file). "Copy for assistant" puts a prompt-ready block on the clipboard. |
| Where files go | A dev-server endpoint writes into **`devlog/`** in the repo (gitignored), where a coding assistant can read them. Desktop writes to app data; the browser keeps them in IndexedDB with copy and download. |
| Scenarios | `*.scenario.json`: optional **app**, **world** and **toy** layers, plus optional **steps** and **expect**. Load, save, reset and record from the panel. |
| Test hooks | `window.cosmic.test`: `load`, `run`, `step`, `advance`, `waitFor`, `snapshot`, `logs`. Steps go through the same methods the input layer and the room binding use. |
| CI | `npm run test:scenarios` (Playwright + `vite preview` with the relay) runs every scenario that has `expect`, including two-player ones. A new GitHub Actions workflow runs it with `cargo test` and the type-check. |

---

## 1. Goals

1. **Quiet by default.** Reloading the dev server fifty times a day, or running CI, never makes a sound until you ask for one.
2. **See what happened.** When something sounds or looks wrong, the last minute of player actions, toy edits, engine errors and room traffic is already recorded and readable.
3. **Feedback becomes a task.** A playtester's note carries enough context (what was in the world, what they did, which build) that a developer, or an LLM coding assistant reading the repo, can reproduce it without asking.
4. **Known states on demand.** Jump to "12 toys playing", "Kettle at full coverage" or "two players, locked room" in one click instead of rebuilding it by hand.
5. **The same scenarios run in CI.** Anything you can set up and check by hand can become an automated test without writing new test code.
6. **Zero cost to players.** No extra download, no extra work per frame, and no extra network traffic when dev mode is off.

### Non-goals (v1)

- A general remote telemetry or analytics pipeline. Logs stay on the device unless you export them. (The help system's metrics, [HELP-SYSTEM.md](HELP-SYSTEM.md) §9, may later read the same event bus.)
- A visual test editor. Scenarios are JSON, recorded from play or written by hand.
- Puzzle content. Puzzle `ScenarioDoc`s ([MODES.md](MODES.md) §3.2) are a different format; a test scenario can *load* one (§6.1).

---

## 2. What exists to build on

| Today | Where | Use |
|---|---|---|
| `World.master` (0.7) sent ×0.85 to the engine; HUD volume slider | `world.ts`, `ui/hud.ts` | The panel's volume; the mute ramp from [AUDIO-MIX.md](AUDIO-MIX.md) §3.2 |
| `World.listeners`: `add`, `remove`, `edit(toy, what)`, `world(tempo/tuning)`, `poke` | `world.ts` | `world` and `toy` log channels with no new hooks in toys |
| `World.snapshot(toy)` / `restore` / `applyState` (`ToySnapshot`) | `world.ts` | World layer of a scenario before WorldDoc lands (§6.1) |
| `RoomSession`: status, `rtt`, admin, `onEvent`, control messages | `net/room.ts` | `net` and `session` channels |
| `Presence` (players, names, colours) | `net/presence.ts` | `session` channel: join, leave, admin changes |
| `audio.onLoadError`, engine `console.error`s | `world.ts`, `audio/host.ts` | `audio` channel instead of bare console calls |
| `prefs.ts` (`load`/`save` in `localStorage`) | `prefs.ts` | The `localStorage` layer of the config |
| `window.cosmic` debug handle in dev | `main.ts` | Becomes `window.cosmic.test` (§7) |
| `roomRelay()` Vite plugin, `__BUILD_ID__` | `vite.config.ts`, `apps/relay` | Pattern for the dev-files plugin; build id in every note and log |
| Native golden tests (`golden.rs`) | `crates/` | Audio fingerprints of a scenario's world without a browser (§8.3) |

Missing: the typed **event bus** (`src/events.ts`, [HELP-SYSTEM.md](HELP-SYSTEM.md) §2), any persistence, WorldDoc ([SAVE-LOAD.md](SAVE-LOAD.md) S1), and any CI workflow (there is no `.github/` yet).

---

## 3. Turning it on, and the config

### 3.1 Modes

| Mode | When | What you get |
|---|---|---|
| **off** | Production build, no flag | Nothing loaded. `log.on(ch)` is a constant `false`. |
| **dev** | `import.meta.env.DEV` (dev server, `npm run desktop`), or `?dev` on any build | Panel (hidden until `` ` ``), logs, notes, scenarios, muted start |
| **test** | `?test` (CI, Playwright) | Everything in dev, plus `window.cosmic.test`, always muted, no panel unless `?test&panel`, no autosave, no "Continue" prompt, fixed random seed |
| **feedback** | `?feedback` on a production build | Notes only: a small note button in the HUD for playtesters. Logs run so notes have context; no panel. |

`main.ts` does `if (devMode()) import("./dev/boot").then((m) => m.boot(ctx))`, so the whole `src/dev/` and `src/ui/dev/` tree is a separate chunk.

### 3.2 Config files and precedence

```
built-in defaults  <  dev.config.json  <  dev.config.local.json  <  localStorage "cosmic.dev"  <  URL params
   (dev/config.ts)    (checked in)         (gitignored, per dev)     (panel changes)            (?dev.log.net=debug)
```

- The two JSON files sit in `apps/playground/` and reach the page through a virtual module (`virtual:dev-config`) from the dev-files plugin (§5.3). In a production build they are **not** bundled; `?dev` on a production build starts from defaults + `localStorage` + URL.
- Panel changes write only the keys that differ from the files into `localStorage`, and the panel has **Reset to file** and **Copy as JSON** (to paste into `dev.config.local.json`).
- URL params use dotted paths: `?dev&dev.audio.muted=false&dev.log.channels.net=debug`. CI and shared repro links use these.
- Validated by the same hand-written validator style as WorldDoc ([SAVE-LOAD.md](SAVE-LOAD.md) §3); unknown keys warn, bad values fall back to the default.

```jsonc
// apps/playground/dev.config.json
{
  "format": "cosmic-dev-config",
  "version": 1,
  "audio": { "master": 0.7, "muted": true },
  "log": {
    "ring": 5000,                    // events kept in memory
    "console": false,                // mirror to devtools console
    "sink": "devlog",                // "devlog" | "none"; where sessions are written (§5)
    "channels": {
      "app": "info", "player": "info", "world": "info", "toy": "info",
      "net": "info", "session": "info", "audio": "warn", "perf": "off"
    },
    "throttle": { "toy.param": 100 } // ms: coalesce continuous drags into one event per window
  },
  "notes": { "hotkey": "F8", "attach": { "world": true, "log": 200, "screenshot": true } },
  "scenarios": { "autoload": null },  // a scenario path to load on start, e.g. "scenarios/sandbox-twelve-toys-perf.scenario.json"
  "panel": { "hotkey": "Backquote", "dock": "right", "open": false },
  "flags": { "fps": false, "netdebug": false, "reducedMotion": null, "seed": null }
}
```

### 3.3 Global volume

- The panel's **Audio** row is the master slider and a mute button, bound to `World.master` and the AUDIO-MIX global mute. The HUD speaker glyph shows the same state.
- **Muted by default** in dev and test modes (`audio.muted: true`). Unmuting in the panel is remembered in `localStorage` for that device, so a developer who wants sound turns it on once.
- Mute is the engine's gain ramp to 0, **not** `AudioContext.suspend()`: the engine keeps running, so the beat, snapshots, visuals and room clock behave exactly as when audible, and tests measure the real thing.
- The dev panel also shows the engine's peak level (from the snapshot), so you can tell a muted world from a silent one.
- Players (mode off) **stay unmuted**: the first touch makes sound (PLAN §1), and browsers already need a gesture before audio starts. Revisit only if classroom testing (AUDIO-MIX "mute when hidden") asks for it (§11.1).

---

## 4. Logs

### 4.1 Event shape

```ts
interface LogEvent {
  t: number;        // ms since page load (performance.now())
  beat?: number;    // engine beat when the event happened, if audio is running
  ch: Channel;      // "app" | "player" | "world" | "toy" | "net" | "session" | "audio" | "perf"
  lvl: "debug" | "info" | "warn" | "error";
  ev: string;       // stable dotted name, e.g. "toy.param", "net.status"
  toy?: string;     // stable toy id, when about a toy
  data?: Record<string, unknown>;
}
```

`log(ch, lvl, ev, data)` checks the channel's level first and returns before building anything, so a disabled channel costs one comparison. Events are stable names (like the help system's events), so tests and the recorder (§6.4) can match on them.

### 4.2 Channels and sources

| Channel | Events (examples) | Source |
|---|---|---|
| `app` | `app.boot` (build, UA, viewport, devicePixelRatio), `app.config`, `app.visibility`, `app.error` (window `error`/`unhandledrejection`), `app.mode` | `dev/boot.ts` |
| `player` | `player.poke`, `player.grab`, `player.drop`, `player.stretch`, `player.twist`, `player.chest`, `player.pulseEdit`, `player.avatarMode` | Intent layer (`input.ts`) via the event bus |
| `world` | `world.add`, `world.remove`, `world.tempo`, `world.tuning`, `world.load`, `world.locked`, periodic `world.checksum` | `World.listeners`, `World.onChange` |
| `toy` | `toy.param` (throttled, first/last value kept), `toy.pulse`, `toy.pattern`, `toy.patternError`, `toy.loadError`, `toy.move` | `World.listeners.edit`, `onLoadError` |
| `net` | `net.status`, `net.rtt` (every ping at debug, every 10 s at info), `net.bytes` per minute, `net.reconnect`, `net.error`, `net.buildMismatch` | `RoomSession` |
| `session` | `session.join`, `session.leave`, `session.player` (join/leave/rename), `session.admin`, `session.synced`, `session.remoteEdit` (debug) | `RoomSession`, `Presence`, `WorldBinding` |
| `audio` | `audio.ready`, `audio.engineError`, `audio.crash`, `audio.master`, `audio.mute`, `audio.underrun` (if the worklet reports one) | `AudioHost` |
| `perf` | `perf.frame` (1 s summaries: fps, worst frame, toy count), `perf.long` (frames over 50 ms) | render loop in `main.ts` |

Remote edits applied while `world.applying` are logged as `session.remoteEdit` with the author's client id, not as `world`/`toy` events, so you can tell your actions from other players'.

### 4.3 Viewing

- **Logs tab:** a live, virtualized list with channel chips, a level filter, text search, "follow" toggle and **pause**. Clicking a toy id highlights the toy in the world.
- **State tab:** a live tree of the current state, refreshed at 4 Hz while open: app (mode, build, config), world (tempo, tuning, locked, toy count), each toy (id, kind, slot, params, Pulse, pattern, error), net (status, rtt, admin, players), audio (running, master, muted, peak). "Copy" on any node copies its JSON. This is the "state" half of the request: logs say what changed, the tree says what is.
- **Export:** "Save log" writes the ring as JSONL (§5); "Copy last 200" copies a compact text form for pasting into an issue or a chat.

### 4.4 Sessions on disk

With `log.sink: "devlog"`, events are batched every 2 s to the dev-files endpoint (§5.3) and appended to `devlog/sessions/<date>-<time>-<build>.jsonl`. One file per page load; the first line is the `app.boot` event. Old session files beyond the newest 50 are deleted by the plugin.

---

## 5. Notes and feedback

### 5.1 Writing a note

- `F8` (or the note button in feedback mode) opens a small box over the canvas. The world keeps playing; the box takes keyboard focus so typing doesn't trigger toy shortcuts.
- Fields: the text, a **kind** (bug · idea · feel · sound · perf), and checkboxes for attachments: world state, last *N* log events, screenshot, "save as scenario". Defaults from `notes.attach`.
- `Ctrl+Enter` saves; the box closes and a toast says where the note went.
- The screenshot is taken from the canvas on the next rendered frame (a one-off `renderer.render` + `toDataURL` in the same task), so the renderer doesn't need `preserveDrawingBuffer`.

### 5.2 Note format

One Markdown file per note, with YAML frontmatter. Markdown is readable by people, diffs well, and pastes cleanly into an issue or an LLM prompt.

````markdown
---
id: n_7QK2M4XD
kind: sound
status: open            # open | done | wontfix; edited by hand or by an assistant
created: 2026-10-17T18:32:05Z
build: e8ea3ed-1a2b3c4d
device: "Chrome 141 · Windows · 2560×1440@1.5"
mode: dev
room: null              # or { code, players, admin } — code redacted on copy
scenario: devlog/notes/n_7QK2M4XD.scenario.json
screenshot: devlog/notes/n_7QK2M4XD.webp
---

The spire clicks when I drag tension fast while the orrery is playing.

## Context
- Toys: spire t_9F3KQ2ZB (length 1.2, tension 0.55→0.92), orrery t_2HXQ8M1C
- Tempo 96, tuning Bright, not wild

## Recent log (last 200)
```jsonl
{"t":81234,"beat":129.5,"ch":"player","lvl":"info","ev":"player.stretch","toy":"t_9F3KQ2ZB","data":{"param":"tension"}}
…
```
````

- **Save as scenario** writes the current world (and app layer) as `n_<id>.scenario.json` next to the note, and the note links it, so "load the note's scenario" reproduces the setup in one click (§6.3).
- **How much world goes where.** The note's Markdown carries only a **summary** (the *Context* list: toys with ids, kinds and the params that changed, tempo, tuning, room). The full world goes in the side `.scenario.json`, with embedded configs and templates, but **WASM voice modules are dropped**: each `modules` entry is replaced by `{ "abi", "bytes": null, "size", "dropped": true }` under its `sha256:` key, so the toy that used it is reported as a sealed placeholder with the hash that identifies the module. The reporter's Forge build or a later upload can supply it. Keeps notes small and never ships untrusted code in a feedback file.
- Room codes and other players' names are kept in the file (it's your own disk) but **redacted** in "Copy for assistant" and in anything shared.

### 5.3 Where notes go

| Where | Browser (dev server) | Desktop (`npm run desktop`) | Desktop release / production `?feedback` |
|---|---|---|---|
| Notes | `POST /__dev/notes` → `devlog/notes/<date>-<slug>.md` (+ `.webp`, `.scenario.json`) | same (the window loads the dev server) | Stay **on the device** (§5.5): desktop writes `<app data>/notes/` (`tauri-plugin-fs`); the browser keeps them in IndexedDB `notes` |
| Logs | `POST /__dev/log` → `devlog/sessions/*.jsonl` | same | IndexedDB ring of the last 5 sessions; "Save log" downloads JSONL |
| Index | `devlog/notes/INDEX.md`, one line per note (date, kind, status, first line), regenerated by the plugin | same | Notes tab list |

The **dev-files plugin** (`apps/playground/dev-files.ts`, a Vite plugin like `roomRelay()`, `configureServer` only):

- Serves `virtual:dev-config` (§3.2) and the scenario list (§6.3), and accepts `POST /__dev/{log,notes,scenarios}`.
- **Loopback only.** `npm run tunnel` exposes the dev server publicly, and ngrok and cloudflared connect from localhost, so the remote address alone proves nothing. The plugin also requires the `Host` header to be `localhost`/`127.0.0.1`/`[::1]` and rejects any request carrying `X-Forwarded-For`, `X-Forwarded-Host` or ngrok/cloudflare headers. A tunnelled guest can't write files on the host.
- The server chooses every file name (from the id and a slugged first line); request bodies never become paths. Bodies are capped (notes 2 MB with screenshot, log batches 256 KB).
- `devlog/` is added to `.gitignore`.

### 5.4 Handing notes to a coding assistant

- **Copy for assistant** (in the box after saving, and on each note in the Notes tab) copies one block: the note text, the context summary, the paths of the scenario and screenshot files, the last 50 log lines, and a one-line instruction ("Reproduce with `npm run dev` then open `/?dev&scenario=devlog/notes/n_7QK2M4XD.scenario.json`").
- Because notes live in `devlog/notes/` with an `INDEX.md`, an assistant working in the repo can be pointed at the folder ("read the open notes in devlog/notes and fix the sound ones"). A line in the README's developing section says so. When an assistant fixes one it sets `status: done` in the frontmatter, and the index shows it.
- `npm run notes` prints the open notes (kind, age, first line) in the terminal.

### 5.5 Feedback in release builds

`?feedback` notes **stay on the device**; nothing is sent anywhere. To make sharing easy without an upload endpoint, saving a note ends on a **"Where's my note?"** card (also on the note button's menu):

| Where | The card shows | Quick link |
|---|---|---|
| Desktop release | The folder path, e.g. `C:\Users\<you>\AppData\Roaming\<app id>\notes\` (from Tauri's `appDataDir`), with a copy button | **Show in folder** (`tauri-plugin-opener` `revealItemInDir`) |
| Browser | "Saved in this browser." Notes live in IndexedDB, which has no file path | **Download notes** saves one `cosmic-feedback-<date>.zip` (each note's `.md`, `.webp` and `.scenario.json`; a small store-only zip writer, no new dependency) to the browser's downloads folder, and the card then names that file |

Under it, a three-step **guide**: 1. open the folder (or download), 2. attach the note files to an email, 3. send to **{supportEmail}**. A **mailto** link pre-fills the subject (`Cosmic Playground feedback · <build> · <note id>`) and the note text; attachments are added by hand (mail links can't attach files), which is why the guide exists.

The address and app name are **build configuration variables**, not strings in code:

| Variable | Default (checked in, `apps/playground/.env`) | Used for |
|---|---|---|
| `VITE_BRAND_NAME` | `Cosmic Playground` | Toy Book pack label *Built in / [brand]* ([TOY-BOOK.md](TOY-BOOK.md) §3.1), titles, the mailto subject |
| `VITE_SUPPORT_EMAIL` | empty (TBD) | `{supportEmail}` in the guide and the mailto link |

`src/brand.ts` reads them once (`import.meta.env`) and exports `brand.name` / `brand.supportEmail`; UI strings use `{brandName}` / `{supportEmail}` template slots filled by a tiny `fill(template, brand)` helper. While `VITE_SUPPORT_EMAIL` is empty the guide's step 3 reads "send to the team that gave you this build" and the mailto link is hidden, so a release can ship before the address is decided. Release builds set it in CI or `.env.production.local`; [PUBLISHING.md](PUBLISHING.md) §9 lists it among the brand decisions.

---

## 6. Scenarios

### 6.1 Format

A scenario is a known state with three optional layers, plus optional steps and checks. Any layer left out is left as it is when the scenario loads.

```jsonc
{
  "format": "cosmic-test-scenario",
  "version": 1,
  "name": "Spire tension sweep with orrery",
  "tags": ["smoke", "audio"],
  "app": {                                  // the listener's and the developer's side
    "viewport": [1280, 800],                // test mode only: Playwright sets it
    "camera": { "azimuth": 0, "elevation": 0.6, "distance": 9.5 },
    "avatar": "orbit",                      // orbit | walk | fly
    "panels": { "chest": false, "pulseEditor": null },
    "dev": { "log": { "channels": { "toy": "debug" } } },   // DevConfig overrides while loaded
    "seed": "TESTSEED"
  },
  "world": { /* a WorldDoc (SAVE-LOAD §3); or { "puzzle": "puzzle-first-light" } to load a MODES scenario */ },
  "toys": {                                 // per-toy overrides applied after the world
    "t_9F3KQ2ZB": { "params": { "tension": 0.2 }, "pulse": { "enabled": false } }
  },
  "players": 1,                             // 2+ = a room with that many pages (§8.2)
  "steps": [ /* §7.2 */ ],
  "expect": [ /* §7.3 */ ]
}
```

- **Naming.** Scenario ids and file names follow `{mode}-{scenario}-{variant/descriptor}`, lower-case kebab: `puzzle-dawn-test`, `puzzle-first-light-solved`, `sandbox-twelve-toys-perf`, `room-two-players-converge`. *mode* is the world's mode or setup (`sandbox`, `puzzle`, `room`, `app` for app-only), *scenario* is the puzzle, series or subject, the last part says what this file is for. The file is `<id>.scenario.json`; the `name` field holds a human title.
- **Two formats, on purpose.** MODES's puzzle `ScenarioDoc` (`"format": "cosmic-scenario"`, in `apps/playground/puzzles/`) is shipped content; this test scenario (`"format": "cosmic-test-scenario"`, in `apps/playground/scenarios/`) is a developer fixture that can *load* a puzzle by id (`{ "puzzle": "puzzle-first-light" }`). They share the naming convention, never a folder, and loaders dispatch on `format`, refusing the other one with a pointer to the right loader.
- **Until WorldDoc lands**, `world` accepts a v0 shape built from what exists today: `{ "bpm", "tuning", "toys": ToySnapshot[] }` (`world.snapshot`/`restore`). The loader upgrades v0 to WorldDoc once [SAVE-LOAD.md](SAVE-LOAD.md) S1 ships; checked-in scenarios are migrated by a script then.
- A **toy-only** scenario (no `world`, one entry in `toys` with a `kind`) adds that toy, set up as given, to the current world. It is a dev cousin of a variant ([SAVE-LOAD.md](SAVE-LOAD.md) §6) and can be promoted to one.
- An **app-only** scenario is a saved developer setup (camera, panels, log levels) with no world change.

### 6.2 Loading

`loadScenario(s)`: apply `app.dev` overrides → (if `world`) `World.loadDoc(world, { replace: true })` with `world.applying = true` so a puzzle mode's locks don't block it → apply `toys` overrides → apply camera, avatar and panels → log `world.load` with the scenario name. Loading never runs code: configs and modules go through the same guard path as any loaded world ([SAVE-LOAD.md](SAVE-LOAD.md) §8).

In a room, loading a scenario with a `world` layer replaces the room's world only for an admin, through the same path as "Load into room" ([SAVE-LOAD.md](SAVE-LOAD.md) S5); otherwise only the `app` layer applies.

### 6.3 The Scenarios tab

- **List:** checked-in scenarios (`apps/playground/scenarios/**/*.scenario.json`), local ones (`devlog/scenarios/`, plus IndexedDB on production builds), and note scenarios (`devlog/notes/*.scenario.json`), grouped and filterable by tag.
- **Load** (also `?scenario=<path>` on the URL, and `scenarios.autoload` in the config), **Reload** (back to the scenario's start), **Reset** (the default starting world from `main.ts`).
- **Save current…**: choose layers (app, world, selected toys only), name, tags; writes to `devlog/scenarios/` through the dev-files plugin (or downloads the file). **Promote** moves a local scenario into `apps/playground/scenarios/` so it gets checked in and runs in CI.
- **Record**: from Record to Stop, `player`, `toy` and `world` events are turned into `steps` (§6.4) and appended to the saved scenario, with `wait` steps measured in beats.

### 6.4 Recording

The recorder subscribes to the log, not to input: each `player.*`/`toy.*`/`world.*` event maps to one step (`toy.param` → `{ "do": "param", … }` using the final value of the throttled drag). Raw pointer paths are not recorded. That keeps recordings short, readable and stable across camera and viewport changes, at the cost of not replaying exact drag curves (acceptable: toys see intents, not pixels, PLAN §3.1).

---

## 7. Test hooks

### 7.1 `window.cosmic.test`

Present in test mode (and in dev mode for the console). All methods are async and return plain JSON.

| Method | Does |
|---|---|
| `load(scenario \| path)` | §6.2; resolves when toys are placed and audio is ready (or immediately if audio is unavailable) |
| `run(scenario?)` | Runs the scenario's `steps` then `expect`; returns `{ passed, failures[], logs, durationMs }` |
| `step(step)` | One step (§7.2) |
| `advance({ beats } \| { ms })` | Waits that long on the engine clock; with `clock: "manual"` (below) steps the render loop instead |
| `waitFor({ log } \| { path, … }, timeoutMs)` | Resolves on a matching log event or state condition |
| `snapshot()` | `{ world: WorldDoc, state: <State tab tree>, observations? }` (observations once MODES P1 exists) |
| `logs({ ch?, ev?, since? })` | Events from the ring |
| `screenshot(name)` | PNG data URL of the canvas; the runner saves it as an artifact |
| `setClock("audio" \| "manual")` | `manual` stops `setAnimationLoop` and lets `advance` tick `world.update` with a fixed `dt`, for frame-exact visual checks |

`main.ts`'s current `window.cosmic` debug handle stays, with `test` added to it.

### 7.2 Steps

Steps call the same methods the input layer and the room binding call (`World.add/remove`, `toy.setParam`, `toy.poke`, …), so a scenario exercises the real code paths and respects `canEdit` and the mode's `constrain`.

```jsonc
{ "do": "add", "kind": "kettle", "id": "t_kettle01", "at": [0, 0, 1] }
{ "do": "poke", "toy": "t_9F3KQ2ZB", "strength": 0.85 }
{ "do": "param", "toy": "t_9F3KQ2ZB", "name": "tension", "value": 0.92, "over": { "beats": 2 } }   // ramped like a drag
{ "do": "pulse", "toy": "t_2HXQ8M1C", "set": { "enabled": true, "steps": 8 } }
{ "do": "pattern", "toy": "t_2HXQ8M1C", "text": "x . [x x] <x x*2>" }
{ "do": "tempo", "bpm": 120 }
{ "do": "tuning", "set": { "scale": 2, "wild": false } }
{ "do": "remove", "toy": "t_kettle01" }
{ "do": "wait", "beats": 4 }
{ "do": "screenshot", "name": "after-sweep" }
{ "do": "as", "player": 2, "steps": [ … ] }      // multi-player scenarios: run on page 2
{ "do": "net", "action": "drop", "ms": 3000 }    // fault injection via the relay (MULTIPLAYER.md §10 chaos)
```

### 7.3 Expectations

```jsonc
{ "path": "world.toys.length", "eq": 3 }
{ "path": "toys.t_9F3KQ2ZB.params.tension", "near": 0.92, "tol": 0.001 }
{ "log": { "ev": "toy.loadError" }, "count": 0 }                     // no load errors
{ "log": { "ch": "app", "lvl": "error" }, "count": 0 }               // no uncaught errors
{ "log": { "ev": "perf.long" }, "max": 2 }
{ "audio": { "toy": "t_9F3KQ2ZB", "sounding": true, "within": { "beats": 1 } } }
{ "rooms": "converged" }                                             // all pages' world checksums equal
{ "onsets": { "spreadMs": { "max": 10 } } }                          // MULTIPLAYER.md M3 measurement
```

Every scenario run also checks two implicit expectations unless it opts out: no `app.error` and no `audio.crash`.

---

## 8. CI

### 8.1 Runner

`npm run test:scenarios [-- --tag smoke] [--grep name] [--headed]` runs `scripts/test-scenarios.mjs`:

1. Builds once (`npm run build`), starts `vite preview` with the relay on a free port.
2. Launches Playwright Chromium with `--autoplay-policy=no-user-gesture-required` so the AudioWorklet starts without a click (audio is muted in test mode, so the run is silent; the engine still renders).
3. For each scenario with `steps` or `expect`: opens `players` pages at `/?test&scenario=<path>` (two or more join the same room code), calls `cosmic.test.run()`, collects the result.
4. Writes `test-results/scenarios/junit.xml`, and per scenario its JSONL log, `snapshot()` JSON and screenshots. Failures print the last 30 log lines of each page.

Playwright (`@playwright/test` or plain `playwright`) is a new root devDependency, Apache-2.0, dev-only, so it doesn't touch `deny.toml`'s rules for the embeddable crates.

### 8.2 Multiplayer scenarios

`players: 2` scenarios are the [MULTIPLAYER.md](MULTIPLAYER.md) §10 **headless jam**: two pages, one relay, steps routed with `as`, convergence and onset-spread checks from the logs. The `net` step's fault injection uses a test-only relay control message, accepted only when the relay was started by the runner (`roomRelay({ test: true })`).

### 8.3 Workflow

New `.github/workflows/ci.yml`, on push and pull request:

| Job | Steps |
|---|---|
| `rust` | `cargo test` (incl. `golden.rs`), `npm run licenses` |
| `web` | `npm ci`, `npm run build:wasm`, `npm -w apps/playground run typecheck`, `npm run build` |
| `scenarios` | needs `web`; `npx playwright install --with-deps chromium`; `npm run test:scenarios -- --tag ci`; upload `test-results/` as an artifact on failure |

Later: a native step that feeds each scenario's `world` to the Rust golden harness for audio fingerprints with no browser (the same idea as MODES §10 "Solutions").

### 8.4 Starter scenarios

`apps/playground/scenarios/`: `sandbox-boot-smoke.scenario.json` (default world, no errors, sounding within 2 beats), `sandbox-all-toys-smoke.scenario.json` (one of each registered toy and config), `sandbox-twelve-toys-perf.scenario.json` (perf: `perf.long` ≤ 2 over 16 beats), `sandbox-custom-tuning-roundtrip.scenario.json` (Scala tuning round trip), `room-two-players-converge.scenario.json` (add, move, retune on page 1; converged on page 2), `room-locked-guest.scenario.json` (guest edits refused, pokes allowed). Once MODES P1 lands: `puzzle-first-light-solved.scenario.json` and `puzzle-dawn-test.scenario.json` (the whole Dawn series, each puzzle loaded and solved).

---

## 9. Code changes

| Change | Where |
|---|---|
| Event bus (shared with the help system) | new `src/events.ts`; emits from `input.ts`, `world.ts`, `audio/host.ts`, `net/*` |
| Dev mode detection, lazy boot | `main.ts`, new `src/dev/boot.ts` |
| `DevConfig` types, defaults, merge, validator | new `src/dev/config.ts` |
| Log core, channels, ring, throttle, sinks | new `src/dev/log.ts`, `src/dev/sink.ts` |
| Global mute (AUDIO-MIX A1 master ramp) + muted start | `world.ts`, `ui/hud.ts`, engine master smoothing |
| Notes | new `src/dev/notes.ts`, `src/ui/dev/notes.ts` |
| Scenario format, loader, saver, recorder | new `src/dev/scenario.ts`, `src/dev/recorder.ts` |
| Test API, steps, expectations | new `src/dev/hooks.ts`, `src/dev/steps.ts`, `src/dev/expect.ts` |
| Panel (tabs: Settings, Logs, State, Notes, Scenarios) | new `src/ui/dev/panel.ts` + one file per tab, `style.css` (dev section) |
| Dev-files plugin | new `apps/playground/dev-files.ts`, `vite.config.ts` |
| Config files, starter scenarios | `apps/playground/dev.config.json`, `apps/playground/scenarios/` |
| Runner, scripts | new `scripts/test-scenarios.mjs`, `scripts/notes.mjs`; `package.json` (`test:scenarios`, `notes`) |
| Relay test hooks | `apps/relay/relay.mjs` (`test` option: fault injection) |
| CI | new `.github/workflows/ci.yml` |
| Ignore | `.gitignore`: `devlog/`, `test-results/`, `apps/playground/dev.config.local.json` |

The panel is plain DOM with text labels: it is for developers, so pillar 1's "no text needed" doesn't apply, but it stays keyboard-navigable and respects reduced motion.

---

## 10. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **D0. Config + mute** | `DevConfig` + files + precedence, lazy dev chunk, panel shell with Settings tab, master + global mute (muted by default in dev/test) | Production bundle has no `src/dev` code (checked in the build output); a fresh dev load is silent; unmute is remembered |
| **D1. Logs** | Event bus, all channels in §4.2, ring, Logs and State tabs, dev-files plugin with loopback guard, JSONL sessions | A 10-minute two-player jam produces a readable session file; a request to `/__dev/log` through the tunnel is refused |
| **D2. Notes** | Note box, attachments, Markdown files, INDEX, Copy for assistant, `npm run notes`, feedback mode | A tester's note leads to a fix by someone (or an assistant) who wasn't there, with no follow-up questions |
| **D3. Scenarios** | v0/WorldDoc loader, Scenarios tab (list, load, save, promote, reset), `?scenario=`, note scenarios | Load "twelve toys" in one click; a note's scenario reproduces its world |
| **D4. Test hooks** | `cosmic.test`, steps, expectations, manual clock, recorder | A recorded session replays and passes its own expectations |
| **D5. CI** | Runner, starter scenarios, multiplayer scenarios, relay fault injection, GitHub workflow | Every pull request runs the scenarios; a deliberately broken toy fails `all-toys` |

D0–D1 are small and can land now; the log is most useful during multiplayer M2–M3. D3 is easiest right after [SAVE-LOAD.md](SAVE-LOAD.md) S1 but doesn't wait for it (v0 world shape). D5's two-player scenarios are the MULTIPLAYER §10 headless jam, so building them here saves doing it twice.

---

## 11. Decisions (formerly open questions, resolved Oct 2026)

1. **Players start unmuted.** Muted start applies to dev and test modes only; revisit if classroom testing (AUDIO-MIX "mute when hidden") asks for it (§3.3).
2. **Feedback in release builds.** Notes stay on the device. The app shows where they are (folder path or downloaded zip), a quick link (Show in folder / Download notes) and a short guide to email them to `{supportEmail}`, a build configuration variable that is still TBD (§5.5). Uploading (form, issue, Cosmic Cloud) stays out of scope until a playtest program needs it.
3. **World in a note.** The full world goes in the side `.scenario.json`, only a summary in the note, and WASM modules are dropped, keeping their hashes (§5.2).
4. **Scenario naming.** `{mode}-{scenario}-{variant/descriptor}`, e.g. `puzzle-dawn-test`. The puzzle `ScenarioDoc` (`cosmic-scenario`) and the test scenario (`cosmic-test-scenario`) stay separate formats on purpose, in separate folders, with one shared naming convention (§6.1). No "fixtures" rename.

Implementation steps: [REVISIONS.md](REVISIONS.md) §4.
