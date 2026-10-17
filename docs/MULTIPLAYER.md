# Multiplayer plan (browser + desktop, over ngrok)

> Two to eight players in one world, on a browser tab or the desktop app, beat-locked and
> hearing the same music. The first goal is **a real jam between friends over a free ngrok
> tunnel**, with the least infrastructure that can work, and a path to the full Phase "Together"
> design in [PLAN.md](PLAN.md) §4.6.

Status: **in progress** (relay, shared world, presence, roles and lock implemented; see §13) · **priority 1** · Oct 2026 · builds on [PLAN.md](PLAN.md) §4.6 (multiplayer), [DEVELOPING.md](DEVELOPING.md#share-over-ngrok) (tunnel), [DESKTOP-MIDI.md](DESKTOP-MIDI.md) (Tauri shell) and [SAVE-LOAD.md](SAVE-LOAD.md) (the world document)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| Topology | **Star through one relay**, not peer-to-peer. A WebSocket relay runs **inside the same server that serves the page**, at `/room`. One port, one origin, one tunnel. No STUN/TURN, no NAT trouble. |
| Free networking | **ngrok** (already wired up in `npm run tunnel`). **Cloudflare quick tunnel** (`cloudflared tunnel --url`, no account, no interstitial) as the fallback, behind `npm run tunnel -- --cloudflare`. |
| Shared state | A **Yjs** document shaped like the saved world (`WorldDoc`, [SAVE-LOAD.md](SAVE-LOAD.md) §3), synced with the y-websocket protocol. Yjs **awareness** carries presence: names, colours, aim rays, avatar poses, "I'm holding this toy". This settles PLAN §11 open decision 2 *for v1* (Loro stays an option for a Rust relay later). |
| Sound | **Sync state, not audio** (PLAN §4.6). Every client renders its own audio from the shared doc, a shared beat clock and a shared seed. Pulses need no network traffic at all. |
| Live pokes | Ephemeral events on the same socket, stamped with a **target beat** a little in the future (lookahead ≈ 150 ms, beat-quantized when "jam quantize" is on). |
| Clock | The relay is the time authority. NTP-style offset estimate on join and every few seconds; each engine **slews** its beat clock to the room beat. |
| Desktop | The Tauri app joins by link like a browser. A later step lets the desktop app **host** (Rust relay + the ngrok Rust SDK) with no Node install. |
| Build lock | Clients must run the **same engine build** to stay deterministic. The handshake compares a build id and refuses mismatches with a clear message. |
| Why first | Every other plan here (avatars, save/load, audio controls, toy book) has a multiplayer consequence. Deciding the shared/local split now avoids reworking them. |

---

## 1. Goals and non-goals

**Goals**

1. **Jam over a free tunnel.** One person runs `npm run tunnel -- --build` (or presses *Host* in the desktop app, step M6). Friends open a link or scan a QR code and are in the same world within 10 seconds.
2. **Browser and desktop in the same room.** Chrome/Edge/Safari/Firefox tabs, the Quest browser, and the Tauri desktop app (dev and release) all join the same room.
3. **Beat-locked.** Pulses and pokes land on the same beat everywhere. Target: two clients on the same machine within **one audio block (≈3 ms)**; across the internet within **10 ms** of each other after the lookahead.
4. **Late join and reconnect just work.** A player who joins mid-jam, or whose Wi-Fi blips, gets the whole world and the current beat with no host action.
5. **Fine alone.** Single player stays exactly as it is today, with no server.

**Non-goals (for now)**

- Public matchmaking, accounts, voice or text chat (pillar 7: no open chat; emotes come later).
- Rooms of more than 8 players, and spectator fan-out (PLAN Phase "Together" scope, step M7).
- Authoritative anti-cheat. Players are friends with a link.

---

## 2. What exists to build on

| Today | Where | Use for multiplayer |
|---|---|---|
| Toys keep all state in **params, Pulse, pattern** (and a ZzFX recipe for zap toys) | `toys/toy.ts` (`params`, `pulse`, `pattern`), `config-toy.ts` (`setRecipe`) | Exactly what goes in the shared doc |
| A deterministic engine: beat clock advanced per sample; Pulse chance rolls keyed by `(seed, slot, onset)` | `crates/hypertoy-core/src/{clock,pulse,pattern}.rs`, `engine.rs` (`seed`, `toy_seed`) | Clients compute the same Pulse hits with no messages. The seed must become settable and **keyed by toy id, not slot** (§5.3). |
| One command protocol into the worklet | `audio/protocol.ts` (`Command`) | Add `sync`, `seed` and `pokeAt` (§5) |
| World-level settings: tempo, Tuning (incl. tables and Scala), master | `world.ts` | Tempo and Tuning are shared; master volume is **local** ([AUDIO-MIX.md](AUDIO-MIX.md)) |
| `npm run tunnel` (ngrok, QR, `--build`) | `scripts/tunnel.mjs` | Also prints the room link; gains `--cloudflare` |
| Vite dev and preview servers allow ngrok hosts | `vite.config.ts` | The relay plugs into both servers (§3.2) |
| Tauri 2 shell, CSP off | `apps/desktop/src-tauri` | Joins rooms; later hosts them |

**Gaps** this plan has to close: toys are addressed by **slot** (local engine detail), not by a stable id; the engine seed is a constant; there is no way to seek or slew the engine clock; pokes play "now"; the Kettle writes its derived params (`coverage`, `activity`) from a local field simulation; the Orrery's planet phases accumulate locally.

---

## 3. Architecture

### 3.1 Layers

```
 Browser tab / Quest browser / Tauri webview (one codebase)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ World (toys, tuning, tempo)  ◄──binds──►  RoomSession (src/net/)      │
 │   local-only: master, mute/solo, camera, avatar mode, ray preview    │
 │                                    │  Y.Doc  (shared WorldDoc)        │
 │                                    │  Awareness (presence)            │
 │                                    │  Events (pokes, pours)           │
 │                                    │  ClockSync (offset, beat)        │
 │ AudioHost ◄── sync / seed / pokeAt ┘                                  │
 └──────────────────────────────┬───────────────────────────────────────┘
                                │ one WebSocket: wss://<host>/room/<code>
 ┌──────────────────────────────▼───────────────────────────────────────┐
 │ Relay (Node, apps/relay) mounted on the Vite dev/preview server       │
 │   y-websocket sync + awareness fan-out · event fan-out · time pings   │
 │   room table (code → Y.Doc) · limits · snapshot to disk (WorldDoc)    │
 └──────────────────────────────▲───────────────────────────────────────┘
                                │ ngrok http :5173/:4173  (or cloudflared)
                         the public HTTPS URL
```

### 3.2 The relay

- **Where:** `apps/relay` (the folder PLAN §4.7 already reserves). Plain Node + `ws`, plus the Yjs server-side sync helpers (`y-protocols`, MIT). No framework.
- **How it's served:** a Vite plugin, `roomRelay()`, attaches the relay to the HTTP server's `upgrade` event in **both** `configureServer` (dev) and `configurePreviewServer` (`vite preview`, used by `tunnel --build`). The page and the socket share one origin, so:
  - one ngrok endpoint is enough (the free plan's endpoint count doesn't matter),
  - no CORS, and the ngrok "Visit Site" cookie already covers the socket,
  - the same plugin works for `npm run dev` on a LAN laptop.
- A standalone entry (`node apps/relay/server.mjs --port 8787 --static apps/playground/dist`) serves the built app plus the relay for anyone who wants a long-running host without Vite.
- **Per room:** a `Y.Doc`, an `Awareness`, a member list (≤ 8), and a time origin. A room is created on first join and dropped 10 minutes after the last member leaves, after writing a snapshot (§7).
- **Messages** (one binary socket, first byte = channel): `0` Yjs sync, `1` awareness, `2` events, `3` time ping/pong, `4` control (hello, build id, kick, errors). Small, versioned, msgpack-free (Yjs already encodes binary; events are a tiny fixed layout).
- **Limits** (the URL is public while the tunnel is up): max 8 members per room, max 20 rooms, 64 KB max message, per-client rate limit (events ≤ 60/s, doc updates ≤ 120/s), unknown channel → disconnect. Rooms need a 6-letter code from an unambiguous alphabet; there is no room list.

### 3.3 The client: `src/net/`

| Module | Job |
|---|---|
| `room.ts` | `RoomSession`: connect, hello/build check, reconnect with backoff, leave |
| `doc.ts` | WorldDoc ⇄ `Y.Doc` mapping, and the **binding** between the doc and `World` (§4.2) |
| `presence.ts` | Awareness fields, player list, colours, soft locks |
| `events.ts` | Pokes and pours with target beats |
| `clock.ts` | Offset estimation and the beat target fed to the engine (§5) |
| `ui/room.ts` | Host / Join / Leave sheet, room code, QR, player chips |

The world never imports `net/`; `net/` observes and drives the world through the same methods the input layer uses. This is the "Help comes from declarations" rule applied to networking: anything a player can do locally is something the binding can replay.

---

## 4. Shared state

### 4.1 What is shared, what is local

| Shared (in the doc) | Local only (never sent) | Ephemeral (events/awareness) |
|---|---|---|
| Toys: kind, embedded config/template, position, orientation, params, Pulse, pattern, recipe, **volume** | Master volume, **mute, solo, focus** ([AUDIO-MIX.md](AUDIO-MIX.md)) | Pokes, Kettle pours |
| Tempo (with its beat anchor), Tuning (incl. custom tables/Scala text), wild | Camera, view mode, avatar vs orbit ([AVATAR.md](AVATAR.md)) | Avatar pose, aim ray, hovered/held toy |
| Room seed, room name | Ray preview toggle, open panels, Toy Book | Player name and colour |
| Gravity bodies ([AVATAR.md](AVATAR.md) §4) | Derived params (e.g. Kettle `coverage`, `activity`) | |
| Couplings (when they exist) | The audition slot ([TOY-BOOK.md](TOY-BOOK.md) §5) | |

Rule of thumb: **anything that changes what the room's music *is* is shared; anything that changes how *I* listen or look is local.** The `derived` flag on `ParamDef` (new) marks params a toy computes itself; the binding skips them.

### 4.2 Document shape

The doc is the saved world ([SAVE-LOAD.md](SAVE-LOAD.md) §3) mapped onto Yjs types, so "save the room" and "load a world into a room" are one function each:

```
Y.Doc
├── world : Y.Map   { name, seed, tempo: {bpm, beat, time}, tuning: {...}, version }
├── toys  : Y.Map<toyId, Y.Map>
│     { kind, config?, template?, pos: [x,y,z], quat: [x,y,z,w], body?,
│       params: Y.Map<name, number>, pulse: Y.Map, pattern: string, recipe?: number[], volume }
└── bodies: Y.Map<bodyId, Y.Map>   (gravity bodies, AVATAR.md §4)
```

- **Toy ids** are random 64-bit ids (base32), created by whoever adds the toy. **Engine slots stay local**: each client keeps its own `toyId → slot` map, because slot order can differ between clients.
- **Params** are one Y.Map entry each, so two players stretching *different* params of the same toy don't conflict; the same param is last-writer-wins, which is fine for knobs.
- **Drags** write at most 30 times a second per param (and always on release), so the doc doesn't fill with intermediate values. The local toy updates every frame as now.
- **Toy limit.** The engine has 16 slots. The UI refuses to add a 17th; if two players add at once and the room reaches 17, the toy whose id sorts last stays **parked** (shown as a translucent ghost with a "room is full" hint) until a slot frees. Every client picks the same one.
- **Undo** uses `Y.UndoManager` scoped to the local client's origin, so Ctrl+Z only undoes your own changes.

### 4.3 Soft locks

Awareness carries `holding: toyId | null`. While someone holds a toy (grabbing its base or dragging a handle), other clients show a ring in that player's colour and ignore drags on it (pokes still work: anyone can play anyone's toy, PLAN §4.6 "Ownership"). Locks vanish with the awareness entry when a player disconnects, so nothing stays stuck.

---

## 5. Time: one beat for everyone

### 5.1 Clock sync

1. On connect and then every 5 s, the client sends 8 pings 50 ms apart; the relay answers with its `performance.now()`-based time. Keep the sample with the lowest round-trip; `offset = serverTime − (send + recv) / 2`. Smooth with a median of the last 5 estimates.
2. The room's tempo is stored as an **anchor**: `{ bpm, beat, time }` meaning "at server time `time` the beat was `beat`". A tempo change writes a new anchor at the current beat, so the beat never jumps.
3. The client computes the room beat for the moment its next audio block will be **heard**: `serverNow + outputLatency` (from `AudioContext.outputLatency`, falling back to `baseLatency`, plus a per-device trim the player can adjust in a hidden setting, measured with a clap test later).
4. The engine gets a `sync` command a few times a second: `{ beat, bpm, at }`. It **slews**: if the error is under 30 ms it bends its rate by up to ±0.5% until it catches up (inaudible); above that it jumps at the next bar line, or immediately when there's no Pulse playing.

### 5.2 Live pokes

- A poke on toy `id` becomes `{ t: "poke", id, strength, beat }` where `beat = roomBeat(now) + lookahead`.
  - **Jam quantize on** (default for kids' rooms): `beat` is rounded up to the next step of the toy's own Pulse grid (or 1/8 when no Pulse is set).
  - **Off** (experts): the lookahead is the network budget only, ~150 ms (adapted to the measured round-trip).
- The **sender hears its own poke immediately** (local-first feedback, PLAN §9) unless quantize is on, in which case everyone, including the sender, hears it on the grid. The sender's engine ignores its own echo.
- Pokes that arrive late (beat already past) still play at once, flagged in the dev overlay. A steady stream of late pokes raises that client's lookahead.
- Kettle **pours** use the same event channel: `{ t: "pour", id, u, v, r, beat }`.

### 5.3 Engine changes (Rust and worklet)

| Change | Why |
|---|---|
| `engine_set_seed(e, lo, hi)` + `Command { t: "seed" }` | The room seed replaces the constant `0xC05_A11C` |
| Per-toy seed from the **toy id**, not the slot index (`toy_set_id(e, slot, lo, hi)`) | Two clients may put the same toy in different slots |
| `engine_sync(e, beat, bpm)` with slew | §5.1 |
| `toy_poke_at(e, slot, strength, aux, beat)` and a small per-slot queue of future events (8 entries, drop oldest) | §5.2; sample-accurate start inside the block |
| `Snapshot` gains the engine's beat *and* the audio frame it belongs to | Lets the client map engine beat to `AudioContext` time precisely |
| Orrery: planet phase as a function of `(launch beat, radius, speed changes)` rather than an accumulator; until then, a `toy_set_state` to resync phases on join and every 8 bars | Continuous-state toys must agree after late join |
| Kettle field steps **per beat**, not per frame, and pours land on a beat | Same pours + same step count = same Gray-Scott field (WASM float is deterministic for these ops). Until done, `coverage` and `activity` are `derived` and local, so clients sound alike but not identical. |

Golden fingerprint tests ([AUDIO-GEN.md](AUDIO-GEN.md) §11) must still pass: with no `sync` and the default seed, the engine behaves as today.

---

## 6. Joining, hosting, and the two build types

### 6.1 Room links

- `https://<tunnel-host>/?room=K7QFZM` opens the app and joins. `guide.html?room=…` keeps the room code through the guide, so new players still get the device check first.
- **Names and colours** without typing: a generated name ("Cobalt Comet") and a colour from the colour-blind-safe palette, changeable in the room sheet, remembered in `localStorage`.
- The room sheet (HUD → people icon) shows: room code (big, for reading aloud), QR, copy link, player chips (colour + name + device glyph), *Leave*, and for the host, *Kick*.

### 6.2 Hosting with the browser build

```bash
npm run tunnel -- --build          # production bundle + relay + ngrok
npm run tunnel -- --build --cloudflare   # same, through a Cloudflare quick tunnel
```

`tunnel.mjs` prints the guide URL, the app URL, **a fresh room link** and a QR code for it. Use `--build` for jams: ngrok's free plan caps HTTP requests per month, and the dev server makes hundreds of module requests per page load; the built app makes about a dozen. The WebSocket is a single long-lived request.

### 6.3 Desktop app (Tauri)

| Situation | How it joins |
|---|---|
| `npm run desktop` (dev) | The window loads `http://localhost:5173`, which already has the relay. Join `?room=` locally, or paste a remote room link: the app connects to `wss://<remote>/room/<code>`. |
| Release build (local assets) | *Join* sheet: paste a link or scan nothing; the app extracts host + code and opens `wss://<host>/room/<code>`. CSP is already off (`tauri.conf.json`); a narrow `connect-src` for `wss:` replaces that before signing. |
| Desktop hosts (M6) | *Host* button: a Rust relay (axum + `tokio-tungstenite`, using `yrs` for the doc) starts on a local port and the **ngrok Rust SDK** (the `ngrok` crate) opens a tunnel from inside the app with the player's authtoken. No Node, no terminal. |

**The ngrok interstitial.** Browsers that load the page through ngrok click "Visit Site" once and get a cookie, so the same-origin socket passes. The desktop app connects cross-origin with no cookie, and a browser WebSocket can't add the `ngrok-skip-browser-warning` header. Fix: set a **custom user agent** on the Tauri window (`app.windows[].userAgent`, e.g. `CosmicPlayground/0.1`), which ngrok documents as a bypass. Verify in M0; the Cloudflare tunnel has no interstitial at all.

### 6.4 Build lock

The Vite build defines `__BUILD_ID__` (git short hash + WASM hash). `hello` carries it; the relay stores the first member's id per room and refuses others with "This room runs a different version of Cosmic Playground (abc123). Update or reload." The desktop **dev** build always matches a tunnel run from the same checkout; a desktop **release** build only matches a tunnel built from the same commit, which is why the test matrix (§9) pins commits.

---

## 7. Persistence

- The relay writes each room's doc as a **WorldDoc JSON** ([SAVE-LOAD.md](SAVE-LOAD.md)) to `apps/relay/rooms/<code>.json` every 60 s while dirty and when the room closes. Restarting the tunnel with `--room K7QFZM` reopens it.
- Any player can *Save a copy* (their own Constellation, local) and the host can *Load into room* (replaces the shared world after a confirm shown to everyone).

---

## 8. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **M0. Spike** (2–3 days) | `roomRelay()` Vite plugin with echo + time pings; `tunnel.mjs` prints a room link; desktop custom UA | A phone, a desktop browser and the Tauri app (dev and release) all connect through ngrok **and** cloudflared; round-trip times logged; interstitial behaviour confirmed |
| **M1. Ids and seeds** | Stable toy ids; `ParamDef.derived`; engine `seed`, per-toy id seed, `sync`, `pokeAt`; WorldDoc v1 shared with [SAVE-LOAD.md](SAVE-LOAD.md) step S1 | Golden tests pass; two engines with the same seed, ids and beat give identical event lists regardless of slot order |
| **M2. Shared world** | Yjs doc + binding: add, remove, move, params, Pulse, pattern, recipe, tempo, Tuning; late join; reconnect; soft locks | Two browsers edit the same world for 30 min with no divergence (a checksum of the doc-derived world compared every 10 s) |
| **M3. One beat** | Clock sync, slew, latency compensation, poke events, jam quantize, Orrery resync, Kettle derived params local | Two clients on one machine: onsets within 3 ms. Over ngrok: within 10 ms (measured with the onset log, §10) |
| **M4. Presence** | Names, colours, player chips, aim rays and held-toy rings for orbit view; avatar poses once [AVATAR.md](AVATAR.md) lands | Each player can tell who is touching what without text |
| **M5. Hosting UX** | Room sheet, QR, guide pass-through, build lock, relay limits, `--cloudflare`, persistence | A non-developer joins from a texted link on the first try |
| **M6. Desktop host** | Rust relay in the Tauri shell + ngrok Rust SDK; *Host* button | A desktop user hosts with no Node install |
| **M7. Together (PLAN)** | Spectator mode, bigger rooms via fan-out, Kettle beat-locked field, Loro bake-off for a Rust relay, Quest in the matrix | PLAN Phase "Together" exit: 4 players across Quest, desktop and phone stay beat-locked within one audio block |

M0–M3 are the critical path. M4 and M5 can overlap with M3.

---

## 9. Test matrix (ngrok first)

| # | Host | Guests | Tunnel |
|---|---|---|---|
| 1 | `npm run tunnel -- --build` (browser build) | desktop Chrome, phone Safari, phone Chrome | ngrok |
| 2 | same | Tauri **dev** window (`npm run desktop`) joining by link | ngrok |
| 3 | same commit | Tauri **release** build joining by link | ngrok, then cloudflared |
| 4 | `npm run desktop` (relay in its dev server) + `tunnel` pointed at :5173 | browser guests | ngrok |
| 5 | Tauri release with *Host* (M6) | browser guests | ngrok Rust SDK |

Each run records: time to join, RTT, clock offset jitter, onset spread (§10), CPU on the weakest device, and bytes sent per minute (to check against the free plan's monthly transfer cap: a 4-player hour is expected to be tens of MB).

---

## 10. Testing

- **Relay unit tests** (Node test runner): room lifecycle, limits, malformed frames, rate limits.
- **Two-engine determinism** (Rust): same seed and ids, different slot orders and different block boundaries → identical event lists and fingerprints.
- **Headless jam** (Playwright, CI): relay + two Chromium pages with fake audio output; script adds toys, drags, pokes; compares doc checksums and engine onset logs.
- **Onset log** (dev overlay, `?netdebug`): each client logs `(toyId, server time of onset)` for every note; a tool merges two logs and reports the spread. This is the M3 exit measurement.
- **Chaos**: drop and delay the socket (relay-side fault injection) to check reconnect, late pokes and the parked-toy rule.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| ngrok free-plan caps (requests, monthly transfer) run out mid-test | Jams use `--build`; events are tiny; the transfer counter is logged per session; cloudflared fallback |
| ngrok interstitial blocks the desktop socket | Custom Tauri user agent; cloudflared; desktop host (M6) avoids the issue for hosts |
| Audio output latency differs per device (Bluetooth!) | `outputLatency` compensation + a manual trim; Bluetooth warning in the room sheet |
| Continuous-state toys drift (Orrery, Kettle) | Phase-as-function or periodic resync; Kettle `derived` local until its field is beat-locked |
| Desktop release and tunnel run different builds | Build lock with a clear message; matrix pins commits |
| A public tunnel URL is found by strangers | Unguessable room codes, no room list, member cap, host kick, no chat; tunnels are short-lived |
| Yjs doc grows over a long jam | Throttled drag writes; periodic `Y.encodeStateAsUpdate` compaction on the relay; snapshots are plain WorldDoc |
| Two people add the 17th toy at once | Deterministic parking (§4.2) |

---

## 12. Decisions and open questions

**Decided (Oct 2026)**

1. **Toy volume is shared** (part of the composition, in the doc); **mute and solo are local** ([AUDIO-MIX.md](AUDIO-MIX.md) §3).
2. **An admin role can lock the world.** The **host is the admin by default** (the first member of a room; the relay hands the role to the longest-connected member if the admin leaves). The admin can assign the role to other players later. A **locked** world lets guests play toys (poke, pour) but not add, remove, move or retune them; admins can still edit. The lock is a field in the shared doc (`world.locked`), enforced by every client's binding and by the relay, which drops doc updates from non-admins while the world is locked.

**Still open**

3. Is a **mesh** (WebRTC data channels) worth adding later for LAN latency? Only if M3 measurements over a LAN relay miss the target.
4. Loro vs Yjs long-term: revisit at M7 if the relay moves to Rust (`yrs` keeps Yjs compatibility there, which may make the question moot).

## 13. Implementation status (Oct 2026)

Built far enough to test avatars together ([AVATAR.md](AVATAR.md) V4) in browser tabs and the desktop app:

| Piece | State | Where |
|---|---|---|
| Relay | `roomRelay()` Vite plugin on dev **and** preview servers at `/room/<code>`; y-protocols sync + awareness, event fan-out, time pings, roles, build lock, member/room/message/rate limits, 10-minute idle close; Node tests | `apps/relay/relay.mjs`, `apps/relay/test/` |
| Client session | Connect, hello with build id, reconnect with backoff, RTT, links/codes (`?room=CODE`, paste a link in the desktop app) | `src/net/room.ts` |
| Shared world (M2, partial) | Toys (add, remove, move, params, Pulse, pattern) with stable toy ids, tempo, preset Tuning, throttled drag writes, late join, the admin seeds an empty room | `src/net/doc.ts` |
| Roles and lock (§12) | Host = admin, hand-off ("make admin"), passes on when the admin leaves; *Lock the world* blocks guests' edits in the client and at the relay (a refused client rejoins fresh) | `apps/relay/relay.mjs`, `src/net/doc.ts`, `src/ui/room.ts` |
| Presence (M4, partial) | Names, colours, mode, avatar pose, aim dots, player list | `src/net/presence.ts`, `src/ui/room.ts` |
| Pokes | Sent as events and played on arrival (not yet beat-stamped) | `src/net/doc.ts` |
| Desktop | Dev window joins like a browser; release build joins by pasting a link or launching with `--room <link>`; custom user agent for the ngrok interstitial (not yet checked against ngrok) | `apps/desktop/src-tauri/` |

Not yet: clock sync and `pokeAt`/seed/slot-independent engine changes (M1, M3), so Pulses are not beat-locked across clients; custom tunings, zap recipes and Forge-only toys aren't shared; toy volume waits for the AUDIO-MIX controls; persistence (§7), `--cloudflare`, the desktop host (M6), held-toy rings.

---

## Sources (checked Oct 2026)

- ngrok free-plan limits (endpoints, requests, data transfer): https://ngrok.com/docs/pricing-limits/free-plan-limits.md · https://ngrok.com/docs/pricing-limits
- ngrok browser warning and its bypasses (header or custom user agent): https://ngrok.com/docs/errors/err_ngrok_6024
- Yjs: https://github.com/yjs/yjs · y-protocols (sync, awareness): https://github.com/yjs/y-protocols · y-websocket: https://github.com/yjs/y-websocket · yrs: https://github.com/y-crdt/y-crdt
- ngrok Rust SDK: https://github.com/ngrok/ngrok-rust
- Cloudflare quick tunnels: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
