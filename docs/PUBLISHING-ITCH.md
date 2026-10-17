# itch.io test builds (web + desktop, remote multiplayer)

> The shortest path from "it works on my machine" to "five friends in different cities are in
> one room": push the web build and the desktop builds to one **restricted itch.io page**, point
> them all at **one always-on relay**, and join by typing a six-letter room code. No domain, no
> signing, no Cloudflare Pages, and nobody has to keep a laptop and a tunnel running for a test.

Status: plan · Oct 2026 · a stopgap ahead of [PUBLISHING.md](PUBLISHING.md) (which stays the long-term plan) · builds on [MULTIPLAYER.md](MULTIPLAYER.md) §3.2 (relay), §6 (joining, build lock), [DEVELOPING.md](DEVELOPING.md) (scripts, Tauri shell)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| Why itch.io | Free, no domain needed, hosts **HTML5 and desktop downloads on one page**, a **password-restricted** page for testers, and the **itch app** auto-updates desktop builds via butler patches, so we don't need the Tauri updater or code signing yet. |
| What itch can't do | Run a server. itch serves static files only, so the WebSocket relay lives elsewhere. |
| Relay | The existing Node relay (`createRelay()` from `apps/relay/relay.mjs`) behind a ~40-line standalone `apps/relay/server.mjs`, deployed to a **free Node host with WebSockets** (Render free web service recommended). One fixed `wss://` URL, baked into every itch build. |
| Joining | **By room code.** The itch web build runs in an iframe on `*.itch.zone`, and query strings on the itch page URL never reach it, so `?room=` links don't work there. The Room sheet's *Join* field takes the code; the desktop app also takes `--room CODE`. |
| Uploads | **butler** with four channels: `html5`, `windows`, `mac`, `linux`. Every channel in one push run gets the same `--userversion` (the build id), so web and desktop testers on the latest upload always pass the build lock. |
| Automation | Manual `npm run itch` from a dev machine first (Windows + web), then a GitHub Actions workflow that builds all three desktop OSes and pushes on demand. |
| Cost | $0. Render's free tier sleeps after idle (first join takes up to about a minute to wake it); a $7/mo instance or the Cloudflare relay from PUBLISHING P4 removes that. |

---

## 1. Shape

```
 itch.io page  <user>.itch.io/cosmic-playground   (Restricted, password)
 ├── html5 channel   → played in the page, iframe on html-classic.itch.zone
 ├── windows channel → zip with the portable .exe   ┐
 ├── mac channel     → zip with the .app             ├─ downloads, or the itch app (auto-update)
 └── linux channel   → AppImage                      ┘
                │ every build has VITE_RELAY_URL baked in
                ▼
 wss://cosmic-relay.onrender.com/room/<CODE>    one Node process, apps/relay/server.mjs
```

The relay is version-agnostic: it compares build ids per room ([MULTIPLAYER.md](MULTIPLAYER.md) §6.4) but doesn't care which build it serves, so one deployment serves every itch upload.

---

## 2. Code changes

Small, and all of them carry over to the PUBLISHING plan unchanged.

| Change | Where | Why |
|---|---|---|
| **`VITE_RELAY_URL`** build variable (e.g. `wss://cosmic-relay.onrender.com`). When set, `parseRoom()` accepts a bare code even when `servedByRelay()` is false, and `address()` uses it as the relay instead of the page host. Unset keeps today's behaviour (relay = page origin). | `apps/playground/src/net/room.ts` | itch.zone and `tauri.localhost` pages can't be relays; a bare code must still work |
| **`VITE_SHARE_URL`** (the itch page URL). When set, the Room sheet shows "Go to `<share url>` and enter code **K7QFZM**" plus a copy button for that sentence, instead of a `?room=` link. | `apps/playground/src/ui/room.ts` | Links with `?room=` don't reach the iframe (§3.2) |
| `--room` accepts a bare code as well as a link | `apps/desktop/src-tauri/src/main.rs` | Same reason, for the desktop app |
| **`apps/relay/server.mjs`**: `http.createServer` + `ws` `WebSocketServer({ noServer: true })`, upgrades on `/room/<code>` go to `createRelay()`, `GET /healthz` returns `ok`, port from `$PORT`. Already promised in MULTIPLAYER §3.2 as the standalone entry. Add `"start": "node server.mjs"`. | `apps/relay/` | The relay is only a Vite plugin today |
| **Origin allowlist** in the standalone server: `RELAY_ORIGINS` env, comma-separated, default `https://html-classic.itch.zone,http://tauri.localhost,https://tauri.localhost,tauri://localhost`. Other origins get a 403 on upgrade. | `apps/relay/server.mjs` | The URL is public and long-lived, unlike a tunnel |
| **`npm run itch`** (`scripts/itch.mjs`): build web with the itch env vars, zip `apps/playground/dist`, build the desktop app, stage per-channel folders, run `butler push` for each with the same `--userversion` | `scripts/`, root `package.json` | One command, one build id |
| Show the build id and relay status (asleep / waking / online) in the Room sheet | `apps/playground/src/ui/room.ts` | Testers can report which build they're on; a sleeping relay shouldn't look like a bug |

`vite.config.ts` already builds with `base: "./"`, which is what itch's subfolder hosting needs, and the multi-page build (`index.html`, `guide.html`, `forge.html`) keeps working because itch serves the whole zip with relative links intact.

---

## 3. Web build on itch

### 3.1 Page settings

| Setting | Value | Note |
|---|---|---|
| Kind of project | HTML | |
| Visibility | **Restricted**, password protected | Testers get the URL and the password; the page stays out of search and browse |
| Viewport | 1280 × 800, *Mobile friendly* on, *Fullscreen button* on | Matches the desktop window size in `tauri.conf.json` |
| *Click to launch in fullscreen* | Off on desktop | Pointer lock and the HUD work in the embed; testers can still press the fullscreen button |
| **SharedArrayBuffer support** | **Off for now** | Nothing in `apps/playground/src` uses `SharedArrayBuffer` today. itch's option sets cross-origin isolation headers and is marked experimental. Turn it on (and recheck §3.3) when the engine adopts SAB ([PLAN.md](PLAN.md) §4.2). |

### 3.2 Things the iframe changes

- **No room links.** The page URL is `<user>.itch.io/cosmic-playground`; the game is an iframe on `html-classic.itch.zone/html/<upload-id>/index.html`. Query strings on the outer URL aren't forwarded, and the inner URL changes on every upload, so code entry is the flow (§2).
- **Storage** is per origin: saves made on itch (IndexedDB on `html-classic.itch.zone`) are separate from saves on `localhost` or a tunnel, and shared with every other itch HTML5 game's origin. Fine for testing; tell testers saves there are throwaway.
- **Audio** still needs a first tap; the existing start overlay handles it.
- **Pointer lock and MIDI** inside the iframe: to verify in I1. If pointer lock is refused, avatar mode falls back to drag-to-look ([AVATAR.md](AVATAR.md)), which is acceptable for a test build.

### 3.3 Limits

itch HTML5 uploads allow up to **1,000 files** (staff and forum posts say directories count too), **200 MB per file** and **500 MB extracted** in total. Our `dist/` is a few dozen files plus `hypertoy.wasm` and the Faust/VMA modules, so we're far inside; `scripts/itch.mjs` counts entries and fails above 900 so a future asset dump doesn't break the page silently.

---

## 4. Desktop builds on itch

### 4.1 What to upload

The itch app installs archives and patches them between versions, so upload **portable builds, not installers**.

| Channel | Contents | Built on |
|---|---|---|
| `windows` | `Cosmic Playground.exe` from `target/release` (Tauri's main binary; WebView2 is built into Windows 11 and nearly all Windows 10 machines) | Windows (local first) |
| `mac` | `Cosmic Playground.app` (universal, `--target universal-apple-darwin`) | macOS runner |
| `linux` | `.AppImage`, made executable | `ubuntu-22.04` runner |

A `.itch.toml` at the root of each channel tells the itch app what to launch:

```toml
[[actions]]
name = "play"
path = "Cosmic Playground.exe"   # per channel: the .app, or the AppImage
```

### 4.2 Unsigned, on purpose

These builds aren't signed. That's acceptable for invited testers and keeps this plan free, but testers need one line each:

- **Windows:** a browser download shows SmartScreen's "Windows protected your PC" (*More info → Run anyway*). Installing through the itch app usually avoids it. Smart App Control, if on, may block the exe outright ([DEVELOPING.md](DEVELOPING.md#desktop-build-tauri)); those testers use the web build.
- **macOS:** Gatekeeper refuses an unsigned, quarantined app ("damaged" or "can't be opened"). Right-click → *Open* once, or `xattr -dr com.apple.quarantine "/Applications/Cosmic Playground.app"`.
- **Linux:** `chmod +x` the AppImage if a browser download loses the bit.

Signing arrives with PUBLISHING §5; the same signed artifacts can be pushed to itch then.

### 4.3 Updates and the build lock

All four channels from one run share a `--userversion`: `0.1.0+<build-id>` (the `__BUILD_ID__` the relay compares). Testers on the itch app get the new desktop build on next launch; web testers get it on reload. A tester who skipped an update and joins a room hosted on the new build sees the existing "different version" message, now with "Update in the itch app or reload the page."

The Tauri updater stays off for itch builds: itch owns updates there.

---

## 5. The relay host

### 5.1 Recommended: Render free web service

- New **Web Service** from this GitHub repo, root `apps/relay`, build `npm ci`, start `npm start`, health check `/healthz`, env `RELAY_ORIGINS` as §2.
- Free instances support WebSockets and get a fixed `https://<name>.onrender.com` URL with TLS, so `wss://<name>.onrender.com/room/<code>` works from itch's HTTPS page with no mixed-content problems.
- They **sleep after about 15 minutes with no traffic** and wake on the next request in up to about a minute. The client already reconnects with backoff; the Room sheet says "Waking up the room server…" while it retries (§2). For a scheduled session, the host opens the page five minutes early.
- A sleeping or redeployed instance loses its rooms (in memory). For test sessions that's fine: the host's world reseeds an empty room when they rejoin ([MULTIPLAYER.md](MULTIPLAYER.md) §13). Disk snapshots (MULTIPLAYER §7) wait for a host with a persistent disk.

### 5.2 Alternatives

| Option | Cost | Trade-off |
|---|---|---|
| Render paid instance | ~$7/mo | No sleep; otherwise identical |
| **Cloudflare Worker + Durable Object** (PUBLISHING P4) | Free plan now includes SQLite-backed Durable Objects (100k requests/day; WebSocket messages count) | Needs the relay ported to the DO WebSocket hibernation API; the right long-term home, more work than this plan wants. A busy 8-player jam may burn through the free request quota, so watch it. |
| Fly.io, a small VPS | a few $/mo | Always on, persistent disk for snapshots; more setup |
| Host's laptop + ngrok static domain | $0 | Fixed URL, but the laptop must be on, and ngrok's browser warning likely blocks a cross-origin WebSocket from the itch iframe (no cookie, can't set the skip header). Only worth trying if the others fail. |
| Host's laptop + Cloudflare quick tunnel | $0 | No warning page, but the URL changes every run, so it can't be baked into a build |

---

## 6. Push workflow

### 6.1 First time (manual, one dev machine)

1. Create the itch project (Draft), set §3.1, then **Restricted** with a password.
2. Install butler (the itch app bundles it, or download it from itch's docs) and run `butler login`.
3. Deploy the relay (§5.1) and note its URL.
4. Put the itch settings in `.env.itch` (git-ignored): `ITCH_TARGET=<user>/cosmic-playground`, `VITE_RELAY_URL=wss://…`, `VITE_SHARE_URL=https://<user>.itch.io/cosmic-playground`.
5. `npm run itch` pushes `html5` and `windows` from a Windows machine. `butler status <user>/cosmic-playground` shows the processed builds; tick *This file will be played in the browser* on the HTML5 upload the first time only (butler keeps it on later pushes to the same channel).

### 6.2 Then: GitHub Actions (`itch.yml`)

Triggered by `workflow_dispatch` (and later, optionally, on push to `main`):

1. `web` job: `npm ci`, `npm run build` with the itch env vars, upload `dist/` as an artifact; compute the build id once and pass it on.
2. `desktop` matrix (windows-latest, macos-latest, ubuntu-22.04): `tauri build` (no bundles needed except the AppImage on Linux), stage the channel folder with `.itch.toml`, upload as an artifact.
3. `push` job (needs both): install butler, `butler push <dir> $ITCH_TARGET:<channel> --userversion <version>` for all four channels. Secret: `BUTLER_API_KEY` from itch's API keys page. Relay URL and share URL are plain repository variables.

Because the desktop builds compile the same web bundle the `web` job built (Tauri's `beforeBuildCommand` runs `web:build`), every job must use the same env vars and commit; the workflow sets them once at the top.

---

## 7. Running a remote test

1. Host opens the itch page (or the itch app) a few minutes early, *Host a room*, reads out or pastes the code.
2. Guests open the itch page with the password, or launch the desktop app, *Join*, type the code.
3. Everyone checks the build id in the Room sheet matches.
4. After the session: the host notes RTT and any desync from the dev overlay (`?netdebug` isn't reachable through the iframe, so it becomes a toggle in the Room sheet for itch builds) and files issues with the build id.

The [MULTIPLAYER.md](MULTIPLAYER.md) §9 matrix gains two rows: itch web ↔ itch web across two cities, and itch web ↔ itch desktop (each OS).

---

## 8. Milestones

| Step | Scope | Exit check |
|---|---|---|
| **I0. Relay online** | `server.mjs`, origin allowlist, `/healthz`, Render deploy | Two `npm run dev` tabs with `VITE_RELAY_URL` set share a room through Render |
| **I1. Web on itch** | `VITE_RELAY_URL`, `VITE_SHARE_URL`, code-only join, relay status, `scripts/itch.mjs` (html5 channel) | Two testers on different networks join by code on the restricted page; pointer lock and audio behaviour recorded |
| **I2. Windows on itch** | `windows` channel, `.itch.toml`, `--room CODE` | An itch app install joins a web tester's room and auto-updates to the next push |
| **I3. All OSes from CI** | `itch.yml` with mac and linux | One manual workflow run updates all four channels with one `--userversion` |
| **I4. Hand-off** | When PUBLISHING P1/P4 land (`play.<brand>`, Cloudflare relay), point `VITE_RELAY_URL` at `rooms.<brand>` and keep itch as a mirror or retire it | Testers move without losing a session |

I0–I1 are about a day of work and unblock remote testing; I2 adds desktop.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Render free tier changes or is too sleepy | Relay is a plain Node process; move to a paid instance, Fly.io or a VPS by changing one env var and pushing |
| itch serves HTML5 from a different origin than `html-classic.itch.zone` | Check the Origin header the relay logs during I1; make the allowlist match what's observed |
| A tester's itch app or browser build is older than the room's | Same `--userversion` across channels, build id in the Room sheet, update hint in the refusal |
| Unsigned desktop builds get blocked (Smart App Control, Gatekeeper) | Documented workaround per OS; the web build is the fallback for everyone |
| The public relay URL attracts strangers | Origin allowlist, unguessable codes, no room list, member and room caps already in the relay |
| Turning on itch's SharedArrayBuffer option breaks something | Off until the engine needs SAB; test on a separate Draft page first |

---

## Sources (checked Oct 2026)

- itch.io HTML5 upload limits (1,000 files, 200 MB per file, 500 MB extracted; butler doesn't lift them): https://itch.io/t/5327199/too-many-files-in-zip-to-load-game · https://forum.babylonjs.com/t/there-is-a-file-limit-on-itch-io/58502
- itch.io SharedArrayBuffer embed option: https://bugnet.io/blog/fix-godot-export-html5-game-fails-load-shared-array-buffer (second-hand; confirm in the project's Embed options)
- butler (push, channels, `--userversion`, `.itch.toml`): https://itch.io/docs/butler/
- Cloudflare Durable Objects on the Workers Free plan: https://developers.cloudflare.com/durable-objects/platform/pricing · https://developers.cloudflare.com/durable-objects/platform/limits
- ngrok browser warning: https://ngrok.com/docs/errors/err_ngrok_6024
