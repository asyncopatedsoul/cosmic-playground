# Playtest builds plan (remote on itch.io, local on Windows with two gamepads)

> The least we can build to run two kinds of playtest: **remote multiplayer** with friends in
> different places, playing the itch.io web or Windows build through one hosted relay, and
> **local multiplayer** on one Windows PC running the desktop app, with two players holding a
> gamepad each. Everything here is a subset of a bigger plan; this doc picks the subset, puts it
> in order and says when each piece is done.

Status: plan · Oct 2026 · picks from [PUBLISHING-ITCH.md](PUBLISHING-ITCH.md) (I0–I2), [LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md) (L0–L1, cut down), [MULTIPLAYER.md](MULTIPLAYER.md) (M1/M3, optional) · player-facing guides in [guides/](guides/README.md)

---

## 0. TL;DR

| | Remote playtest (R) | Local playtest (L) |
|---|---|---|
| Who | 2–6 testers in different homes | 2 players on one Windows PC, one gamepad each |
| Build | itch.io **html5** channel (browser) and **windows** channel (desktop app) | itch.io **windows** channel (same upload) |
| Network | One always-on relay on Render's free tier, `wss://` URL baked into the build; join by **6-letter code** | None needed: both players are **seats** on one client. Hosting a room still works, so remote friends can join a local session |
| New code | Standalone relay entry, `VITE_RELAY_URL` / `VITE_SHARE_URL`, code-only join, build id + relay status in the Room sheet, `--room CODE`, `npm run itch`, `itch.yml` | `SeatState` for gamepad seats, `GamepadSource`, an orbit-view gamepad map with aim assist, seat cursors, a place picker, a "wake the controllers" banner |
| Not in this cut | Beat-locked Pulses across clients (track B, §5), mac/linux channels, persistence, signing | Phones as pads, split screen, avatar mode on gamepads, per-seat roles, seats in presence |
| Effort | ~2 days (R1–R4) | ~4–5 days (L1–L4) |
| Cost | $0 (itch, Render free, GitHub Actions free minutes) | $0 |

Both tracks are independent: they touch different files (§6) and can be built in parallel.

---

## 1. What each playtest needs to answer

| Playtest | Questions | Measured by |
|---|---|---|
| **Remote** | Can a non-developer get from an email to a shared room in under 2 minutes? Does the world stay in sync for 30 minutes? Is the sleeping relay confusing? Do web and desktop testers share rooms without version trouble? | Time to join (tester notes), the build id each tester reports, RTT from the Room sheet, desync reports, the post-session questionnaire ([guides/PLAYTEST-REMOTE.md](guides/PLAYTEST-REMOTE.md#after-the-session)) |
| **Local** | Can a second player join by pressing a button, with no explanation? Can two gamepad players add, play, move and put away toys without fighting over the camera or each other's toys? Is the gamepad map learnable in 5 minutes? | Facilitator observation sheet ([guides/PLAYTEST-LOCAL.md](guides/PLAYTEST-LOCAL.md#for-the-facilitator)), frame time, a count of "how do I…?" questions |

---

## 2. Remote track (R): itch.io + hosted relay

This is [PUBLISHING-ITCH.md](PUBLISHING-ITCH.md) I0–I2, unchanged in design; this section fixes the order and the exact files.

### R1. Relay online (≈½ day)

| Change | Where |
|---|---|
| `server.mjs`: `http.createServer`, `ws` `WebSocketServer({ noServer: true })`; upgrades on `/room/<code>` go to the existing `createRelay()`; `GET /healthz` → `ok`; port from `$PORT`; log the `Origin` of every upgrade | `apps/relay/server.mjs` |
| Origin allowlist from `RELAY_ORIGINS` (default `https://html-classic.itch.zone,http://tauri.localhost,https://tauri.localhost,tauri://localhost`); `http://localhost:*` allowed when `RELAY_DEV=1`; anything else gets 403 on upgrade | same |
| `"start": "node server.mjs"` | `apps/relay/package.json` |
| Tests: healthz, allowlist accepts/refuses, a full hello + sync through the standalone server | `apps/relay/test/server.test.mjs` |
| Render Web Service: root `apps/relay`, build `npm ci`, start `npm start`, health check `/healthz`, env `RELAY_ORIGINS` | Render dashboard (owner: you, §7) |

**Exit:** two `npm run dev` tabs built with `VITE_RELAY_URL=wss://<name>.onrender.com` share a room through Render.

### R2. Client changes (≈½ day)

| Change | Where |
|---|---|
| `VITE_RELAY_URL`: when set, `parseRoom()` accepts a bare code even when `servedByRelay()` is false, and `address()` uses it as the relay. `canHost()` becomes `servedByRelay() || !!RELAY_URL`, so the itch page and the desktop app can **host** too | `apps/playground/src/net/room.ts` |
| `VITE_SHARE_URL`: the Room sheet shows "Go to `<share url>` and enter code **K7QFZM**" with a *Copy invite* button for that sentence, instead of a `?room=` link and QR (the QR encodes the share URL) | `apps/playground/src/ui/room.ts` |
| Build id (`__BUILD_ID__`) and relay status in the Room sheet: *Waking up the room server…* while the first connect retries, *Online · 84 ms*, *Can't reach the room server* after 90 s | same |
| *Network details* toggle in the Room sheet (replaces `?netdebug`, which can't reach the iframe): RTT, reconnect count, last error, doc size | same |
| `env.d.ts` types for the two variables | `apps/playground/src/env.d.ts` |

Unset variables keep today's behaviour exactly (relay = page origin), so `npm run dev` and `npm run tunnel` don't change.

### R3. Web on itch (≈½ day)

| Change | Where |
|---|---|
| `npm run itch -- [--web] [--windows] [--dry-run]`: reads `.env.itch` (git-ignored); builds the web bundle with the itch env vars; counts files (fails above 900); stages `build/itch/html5`; runs `butler push build/itch/html5 $ITCH_TARGET:html5 --userversion 0.1.0+<build id>` | `scripts/itch.mjs`, root `package.json` |
| `.env.itch.example` with `ITCH_TARGET`, `VITE_RELAY_URL`, `VITE_SHARE_URL`; `.env.itch` and `build/` in `.gitignore` | repo root |
| Read the build id from one place: export `buildId()` from a small `scripts/build-id.mjs` used by both `vite.config.ts` and `itch.mjs` | `scripts/`, `apps/playground/vite.config.ts` |

**Exit:** two testers on different networks join by code on the restricted itch page; pointer lock, audio start and gamepad behaviour inside the iframe are written down in [PUBLISHING-ITCH.md](PUBLISHING-ITCH.md) §3.2.

### R4. Windows on itch, built in CI (≈½ day)

Windows Smart App Control can block local release builds ([DEVELOPING.md](DEVELOPING.md#desktop-build-tauri)), so the Windows build comes from CI first and the local `--windows` path is a convenience.

| Change | Where |
|---|---|
| `--room` accepts a bare code as well as a link: the shell appends `?join=CODE`, and the page treats a bare code as a code when `VITE_RELAY_URL` is set | `apps/desktop/src-tauri/src/main.rs`, `apps/playground/src/ui/room.ts` |
| `.itch.toml` for the windows channel (`[[actions]] name = "play" path = "Cosmic Playground.exe"`) | `apps/desktop/itch/windows.itch.toml` |
| `itch.yml` (`workflow_dispatch`): job `web` (ubuntu) builds `dist/` with the env vars from repository variables and computes the build id; job `windows` (windows-latest) runs `tauri build --no-bundle` with the same vars and commit, stages `Cosmic Playground.exe` + `.itch.toml`; job `push` installs butler and pushes both channels with one `--userversion`. Secret: `BUTLER_API_KEY`; variables: `ITCH_TARGET`, `VITE_RELAY_URL`, `VITE_SHARE_URL` | `.github/workflows/itch.yml` |
| `scripts/itch.mjs --windows` does the same locally when the machine can build | `scripts/itch.mjs` |

**Exit:** the itch app installs the Windows build, joins a web tester's room by code, and updates itself after the next workflow run. mac and linux channels (PUBLISHING-ITCH I3) are a matrix addition to the same workflow later; Mac and Linux testers use the web build until then.

---

## 3. Local track (L): one Windows PC, two gamepads

A cut-down [LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md) L0 + L1: just enough seat model for gamepad seats on the host client, in orbit view, with one shared camera. No pads, no split screen, no seat presence.

### 3.1 Scope decisions for this cut

| Decision | Choice here | Full plan |
|---|---|---|
| Seat 1 | Mouse + keyboard, always present (it may sit idle) | same |
| Gamepad seats | Seats 2 and 3 (up to 4 pads), joined by pressing any button | same |
| Camera | **Shared orbit camera.** Right stick over empty space turns it (left/right) and zooms it (up/down); the mouse still drives it as today. Whoever moved it last has it | LOCAL §4.2 proposes hand-over only plus auto camera; this playtest tells us whether stick-to-camera causes fights |
| Avatar mode | Seat 1 only; gamepads stay in orbit view | Split screen in L3 |
| Roles and locks | Gamepad seats share the client's role | Per-seat roles in L0 |
| Presence | Remote players see seat 1 only | `seats[]` in awareness |
| Soft locks | Two seats can't drag the same toy (per-seat `holding`, checked locally) | same |
| Undo | Per seat: each seat's own put-away stack | Y.UndoManager per seat origin |
| Adding toys | A **place picker** at the seat's cursor (no per-seat chest) | Per-seat chest |
| Pulse editing | Play/pause from a gamepad; editing steps stays with the mouse | Pulse ring on the Toy pad |

### 3.2 Gamepad map (orbit view)

Standard mapping (Xbox names; PlayStation in brackets). This table is the source for the guides.

| Control | Action |
|---|---|
| Any button | Join as the next player (a numbered ring in your colour appears) |
| Left stick | Move your cursor; it snaps to toys and handles within 24 px |
| `A` [✕] | Poke what your cursor is on |
| Hold `A` on a toy's base | Grab it; the left stick slides it along the ground |
| Hold `A` on a handle | Drag the handle with the left stick |
| `RT` / `LT` [R2 / L2] | Stretch the toy under your cursor up / down |
| Right stick left/right on a toy | Twist it |
| Right stick over empty space | Turn the camera (left/right) and zoom (up/down) |
| `X` [□] | Start or stop the toy's Pulse |
| `Y` [△] | Open the place picker: `LB` / `RB` choose a toy, `A` places it at your cursor, `B` closes |
| Hold `B` [○] on a toy for 1 s | Put it away |
| `View` [Create/Share] | Undo your last put-away |
| D-pad up / down | Focus / mute the toy under your cursor |
| D-pad left / right | That toy's volume down / up |
| Hold `Menu` [Options] 2 s | Leave (your toys stay) |

### L1. Seats on one client (≈1½ days)

| Change | Where |
|---|---|
| `Seat` and `SeatState` (id, number, colour, device key, cursor x/y, current `AimHit`, `holding`, active drag handler, put-away stack); `seats.ts` owns the list and colour assignment (unique among local seats; seat 1 keeps the player's colour) | `apps/playground/src/seats/seats.ts` (new) |
| Move the put-away stack and `grab()` out of `Input` into helpers that take a `SeatState`, so the mouse path (seat 1) and gamepad seats share them | `apps/playground/src/input.ts`, `apps/playground/src/seats/actions.ts` (new) |
| `Aim.fromScreen(x, y)` must not touch `aim.current` or `aim.ignore` for non-mouse seats: add `aim.probe(x, y, ignore?)` returning an `AimHit` without side effects | `apps/playground/src/aim.ts` |
| Synthesised `PointerInfo` for seat drags: toys' `down()` and drag handlers receive `{x, y, dx, dy, hit, event}`; `event` becomes optional (check every toy's use of it first: `toys/*.ts`) | `apps/playground/src/toys/toy.ts`, toys |
| Per-seat soft lock: a toy held by one seat refuses `grab` and handle drags from another | `apps/playground/src/seats/actions.ts` |
| Seat cursors: a ring in the seat's colour with its number, clamped to the canvas; a held-toy ring in the same colour | `apps/playground/src/render/seat-cursors.ts` (new) |

**Exit:** a dev-mode scenario (`FakeGamepadSource`, [DEV-MODE.md](DEV-MODE.md)) drives two seats on one client: separate put-away undo, seat 2 can't grab a toy seat 3 holds, the mouse keeps working unchanged.

### L2. Gamepads (≈1½ days)

| Change | Where |
|---|---|
| `GamepadSource`: polls `navigator.getGamepads()` once per frame from the main loop; radial dead zone 0.15; cursor speed curve `x²·sign(x)` with hold acceleration; button edges; hold timers (`A` grab, `B` put away, `Menu` leave) | `apps/playground/src/controllers/gamepad.ts` (new) |
| Join by any button on an unassigned pad; leave by hold `Menu` or 30 s disconnected; a toast "Player 2 joined" with the seat colour | same + `apps/playground/src/ui/announce.ts` |
| The map in §3.2 as one table of bindings, so the guide and the code can't drift (the help overlay reads it) | `apps/playground/src/controllers/gamepad-map.ts` (new) |
| Shared camera from the right stick (`stage.orbit`, `stage.zoom`) | `apps/playground/src/controllers/gamepad.ts` |
| Place picker: a small strip of toy icons at the seat's cursor, `LB`/`RB` cycle the registry kinds, `A` adds through `world.add` at the cursor's surface hit (same `canPlace` rules as avatar placing) | `apps/playground/src/ui/place-picker.ts` (new) |
| Non-standard mappings: log `Gamepad.id` and `mapping` in the Room sheet's *Network details* panel (renamed *Details*) so testers can report them; profiles wait for L-full | `apps/playground/src/ui/room.ts` |
| Rumble: a short tick on poke via `vibrationActuator.playEffect("dual-rumble")` where supported | `apps/playground/src/controllers/gamepad.ts` |

### L3. Desktop app check and focus (≈½ day)

| Change | Where |
|---|---|
| Verify Gamepad API in WebView2 (release build from R4's workflow): connect, two pads, focus loss/regain, sleep/wake | manual, results in §8 |
| Focus banner: when the window loses focus with gamepad seats present, show "Click here to wake the controllers" over the canvas | `apps/playground/src/controllers/gamepad.ts`, `style.css` |
| Fallback only if WebView2 falls short: a `gilrs` backend in the Tauri shell forwarding events over a Channel ([LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md) §4.1). Not planned unless L3 fails | `apps/desktop/src-tauri` |

### L4. Help and polish (≈½ day)

| Change | Where |
|---|---|
| Per-seat hint next to a new gamepad cursor: "`A` poke · `Y` add a toy · hold `B` put away", fading after the seat's first three actions | `apps/playground/src/ui/announce.ts` or the help overlay ([HELP-SYSTEM.md](HELP-SYSTEM.md)) |
| A *Controllers* card in the guide page (`guide.html`) generated from `gamepad-map.ts` | `apps/playground/src/guide/guide.ts` |

**Exit (L2–L4):** on the itch Windows build, two players with an Xbox pad and a PS5 pad (or two of either) build a six-toy jam together in 15 minutes without asking how to join; frame time stays under 16.7 ms on the test PC.

---

## 4. Build and release flow

```
 git push main ─► GitHub Actions: itch.yml (manual, Run workflow)
                    ├─ web      → dist/ (VITE_RELAY_URL, VITE_SHARE_URL) ─┐
                    ├─ windows  → Cosmic Playground.exe + .itch.toml  ───┤ same commit, same build id
                    └─ push     → butler push html5 + windows --userversion 0.1.0+<build id>
                                       │
                 itch.io restricted page ◄┘  (web plays in the page; the itch app updates Windows installs)
                                       │
                 wss://cosmic-relay.onrender.com/room/<CODE>  (deployed from apps/relay on push)
```

- **One build id per playtest.** Freeze the build the day before a session: run the workflow once, and put the build id in the invitation email ([guides/email-remote.txt](guides/email-remote.txt)). Don't push during a session; the build lock would split the room.
- **Local shortcut:** `npm run itch -- --web` from any dev machine pushes only the html5 channel (fine when the Windows build is unchanged, but then the two channels have different build ids, so web and desktop can't share a room until the next full run). The script warns about this.
- **Relay deploys** are independent of game builds (the relay is version-agnostic, [PUBLISHING-ITCH.md](PUBLISHING-ITCH.md) §1). Render redeploys `apps/relay` on push to the default branch; a redeploy drops open rooms, so avoid merging relay changes during a session.

---

## 5. Track B (optional): beat lock across clients

Today Pulses are not beat-locked between clients ([MULTIPLAYER.md](MULTIPLAYER.md) §13): every tester hears the shared world at the same tempo, but each client's Pulses start at its own phase, and pokes play on arrival. For the first remote playtest that's acceptable (it tests joining, the shared world, presence and the relay), and the remote guide says so.

Before the second remote session, the smallest useful slice of M1 + M3 is:

1. Room seed and per-toy seed from the toy id (`engine_set_seed`, `toy_set_id`), so Pulse "sometimes" steps roll the same everywhere.
2. Relay time pings → clock offset; the tempo anchor `{bpm, beat, time}` in the doc; `engine_sync` with slew.
3. Pokes stamped with a target beat (lookahead ≈ 150 ms).

That is Rust engine work plus golden-test updates, roughly 3–4 days, and it touches `crates/hypertoy-wasm` and `src/audio/`, which neither R nor L touch.

---

## 6. Files touched, by track

| Track | Files |
|---|---|
| R | `apps/relay/{server.mjs,package.json,test/server.test.mjs}`, `apps/playground/src/net/room.ts`, `apps/playground/src/ui/room.ts`, `apps/playground/src/env.d.ts`, `apps/playground/vite.config.ts`, `apps/desktop/src-tauri/src/main.rs`, `apps/desktop/itch/`, `scripts/{itch.mjs,build-id.mjs}`, `.github/workflows/itch.yml`, `package.json`, `.gitignore`, `.env.itch.example` |
| L | `apps/playground/src/{seats/,controllers/,render/seat-cursors.ts,ui/place-picker.ts}`, `input.ts`, `aim.ts`, `toys/toy.ts` (+ toys if `event` is used), `main.ts`, `ui/announce.ts`, `guide/guide.ts`, `style.css` |
| Shared | `ui/room.ts` gets one *Details* line from L2 (gamepad ids); do it after R2 lands, or leave it to R |

---

## 7. What only you can do (accounts and secrets)

| Step | When |
|---|---|
| Create the itch.io project (Draft → Restricted with a password), HTML kind, settings from [PUBLISHING-ITCH.md](PUBLISHING-ITCH.md) §3.1 | Before R3 |
| Generate an itch API key; add it as the `BUTLER_API_KEY` repository secret; add `ITCH_TARGET`, `VITE_RELAY_URL`, `VITE_SHARE_URL` as repository variables | Before R4 |
| Create the Render Web Service from this repo (free plan) | R1 |
| Tick *This file will be played in the browser* on the first html5 upload | After the first push |
| Fill the itch page with [guides/itch-page.html](guides/itch-page.html) | Before inviting testers |
| Send [guides/email-remote.txt](guides/email-remote.txt) / [guides/email-local.txt](guides/email-local.txt) | A few days before each session |

---

## 8. Test checklist

| # | Scenario | Pass when |
|---|---|---|
| T1 | Two web testers, different networks, itch page | Join by code in < 2 min from the email; 30 min, no desync |
| T2 | Web ↔ itch-app Windows | Same build id; both see each other's toys and aim dots |
| T3 | Relay asleep at session start | Room sheet says *Waking up…*, joins within ~60 s, no error |
| T4 | Tester on an older build | Clear "different version" message with "Update in the itch app or reload the page" |
| T5 | Windows app, two pads (Xbox + PS5) | Both join by button; all of §3.2 works; focus banner after alt-tab |
| T6 | Same, while hosting a room with one remote web tester | Remote sees seat 1's aim and every toy the pads add |
| T7 | Gamepad on the itch web build | A remote tester's pad joins as seat 2 in the browser (free win from L2) |

---

## 9. Order of work

1. **R1 → R2 → R3** (one session, ~1½ days): unblocks the first remote playtest with the web build.
2. **L1 → L2** in parallel with R (a second session; no shared files except §6's note).
3. **R4** once R2 lands (needs the env vars and `--room CODE`).
4. **L3 → L4** on the R4 Windows build.
5. Remote playtest #1 (web + Windows) and local playtest #1, using [guides/](guides/README.md).
6. Track B before remote playtest #2.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| itch iframe blocks gamepads or pointer lock | Record in R3; gamepads need only the Gamepad API, which iframes allow by default unless a permissions policy forbids it (check `allow` on itch's iframe) |
| WebView2 drops gamepads on focus changes | Focus banner (L3); `gilrs` fallback |
| Two gamepad players fight over the shared camera | It's a question this playtest answers (§3.1); the observation sheet counts camera grabs |
| Seat refactor breaks mouse/touch input | L1 keeps seat 1 on the existing path and only extracts helpers; the existing manual checks plus the L1 scenario |
| Render free tier sleeps mid-session | Activity keeps it awake; the host opens the page 5 minutes early; $7/mo removes sleep if it hurts |
| Pushing during a session splits the room | §4 freeze rule; the build id in the email |
