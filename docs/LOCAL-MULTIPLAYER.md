# Local multiplayer plan (one screen, many players; a table of phones)

> Several people in the same physical room playing one world together. The default is **one
> desktop screen** (browser or desktop app) that hosts a mouse-and-keyboard player, any number of
> gamepads, and phones that join by scanning a QR code on that screen. The second topology is
> **a table of phones**: one phone hosts and plays, and every other player joins from their own
> phone. Both are built on the room relay from [MULTIPLAYER.md](MULTIPLAYER.md), so a local
> session can also have remote friends in it.

Status: plan · Oct 2026 · builds on [MULTIPLAYER.md](MULTIPLAYER.md) (relay, shared doc, presence, roles, clock sync), [AVATAR.md](AVATAR.md) §5 and §7 (Aim, touch and gamepad maps), [DESKTOP-MIDI.md](DESKTOP-MIDI.md) §5.1 (`intents.ts`, `ControllerSource`), [AUDIO-MIX.md](AUDIO-MIX.md) (local mute), [HELP-SYSTEM.md](HELP-SYSTEM.md) (per-device glyphs) and [PUBLISHING.md](PUBLISHING.md) §5.1 (mobile builds, revised for this plan)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| Core idea | Split "player" from "client". A **seat** is one person with one set of controls; a **client** (tab, desktop app, phone app) holds one or more seats. Today every client has exactly one seat; local play lets the host client hold up to 8. |
| Topology A (default) | **Desktop host + local seats.** Seat 1 is mouse + keyboard. Each gamepad that presses a button gets a seat. Phones scan the host's QR and become a **Pad** (a controller for a seat that lives on the host) or a **Screen** (their own view, a full room member). |
| Topology B | **Phone host + phone players.** The host phone is seat 1 (touch). Each other phone scans the host's QR and joins as a **Screen**. Audio follows a per-site **speaker policy**: host speaker first, then **ensemble** (each phone plays the toys its player placed). |
| Transport | Everything goes through the existing room relay. Pads open a **WebRTC data channel** straight to the host, using the relay for signalling (new channel `5`). If the channel fails (Wi-Fi client isolation, strict networks), pad traffic falls back to the relay's event channel. No new servers. |
| Where the relay runs | Dev: the Vite relay behind `npm run tunnel` (works today). Production: `rooms.<brand>` ([PUBLISHING.md](PUBLISHING.md) P4). Offline: the Rust relay embedded in the desktop app (MULTIPLAYER M6) or in the native mobile app (step L8). |
| Screen layout | Orbit view: **one shared camera** with a coloured cursor per seat. Avatar view: **split screen** for 2 to 4 local avatars; seats beyond 4 use Pads or Screens. |
| Audio | One engine per site that plays out loud. Host-screen seats need no clock sync at all. Screens in the same room are **muted by default** so phones don't echo the host. |
| Pads | A tiny `pad.html` page (no three.js, no WASM). Three faces: **Cursor pad** (trackpad for your cursor), **Stick pad** (twin sticks for avatar mode) and **Toy pad** (big controls for the toy your seat is aiming at). |
| Mobile apps | Switch the mobile wrapper from Capacitor to **Tauri 2 mobile** (shares the desktop shell, the Rust relay and the MIDI crate), gated by a one-week spike. Pre-release testing goes through **TestFlight** and **Play internal testing**, plus a **dev client** app that loads the dev machine's tunnel so a Windows machine can iterate on iOS without a Mac. Details in [PUBLISHING.md](PUBLISHING.md) §5.1. |

---

## 1. Goals and non-goals

**Goals**

1. **Couch play on one screen.** Two kids with gamepads and a parent on the mouse play the same world on a laptop or a TV-connected PC, with no accounts and no setup screen. A new gamepad joins by pressing any button.
2. **Phones as controllers in seconds.** Scan the QR on the host screen, and within **5 seconds** the phone is a controller with its own colour on the big screen. No app install needed.
3. **A table of phones.** Four people with only phones start a jam: one taps *Invite*, the others scan, and everyone has their own view of the same world.
4. **Same world rules.** Local seats use the same shared doc, roles, locks, presence and undo as remote players. A local session can take remote guests by link, and a remote room can include a host with three local seats.
5. **Fine alone and fine remote.** Single player and the remote jam in [MULTIPLAYER.md](MULTIPLAYER.md) are unchanged.

**Non-goals (for now)**

- Two keyboard players on one keyboard (WASD vs arrows). Possible later as a device adapter; it fights with the existing shortcut map ([AVATAR.md](AVATAR.md) §8).
- More than one mouse on one computer (the browser merges them into one pointer).
- Bluetooth or Wi-Fi Direct transports without any IP network. Phones need a shared Wi-Fi, a hotspot, or internet.
- Chromecast/AirPlay receiver apps. A TV is just the host's display.
- Voice or text chat (PLAN pillar 7).

---

## 2. What exists to build on

| Today | Where | Use for local play |
|---|---|---|
| Room relay: y-protocols sync, awareness, events, time pings, roles, build lock, limits | `apps/relay/relay.mjs` | Same relay; add the `signal` channel (§6.3) and count seats, not sockets, toward the 8-player cap |
| Room session, `?room=CODE` links, reconnect | `src/net/room.ts` | Screens join exactly like remote players |
| Shared world binding with stable toy ids, throttled drags, admin lock | `src/net/doc.ts` | Every edit gains a seat origin (§3.3) |
| Presence: one `PresenceState` per client (name, colour, mode, pose, aim) | `src/net/presence.ts` | Becomes a list of seats per client (§3.2) |
| Pointer, wheel and key handling in one class | `src/input.ts` | Split into device adapters and the shared intent dispatcher already planned in [DESKTOP-MIDI.md](DESKTOP-MIDI.md) §5.1; intents gain a `seat` |
| Aim service (one ray, every creator action) | `src/aim.ts`, [AVATAR.md](AVATAR.md) §5 | One Aim per seat |
| Touch and gamepad maps for avatar mode (planned, V3) | [AVATAR.md](AVATAR.md) §7 | The gamepad map is reused per seat; the touch map becomes the Stick pad |
| QR printing for tunnel links | `scripts/tunnel.mjs` | Prints the local-session QR and the dev-client QR (§9.3) |
| Room sheet with QR and player chips | `src/ui/room.ts` | Gains the seat strip and the *Invite* sheet (§5) |
| Player colours (Okabe–Ito + sky blue), generated names | `src/net/presence.ts` | Seats draw from the same palette, never repeating within a room |

**Gaps:** the client assumes one player everywhere (one Aim, one focus, one hotbar, one `holding`, one undo stack, one awareness entry); there's no gamepad input yet; the relay forwards events to everyone, not to one member; phones can't host a relay from a browser.

---

## 3. Seats

### 3.1 The model

```ts
interface Seat {
  id: string;               // "<clientId>.<n>", stable while the client stays connected
  name: string;             // generated ("Amber Nova"), editable
  color: string;            // from PLAYER_COLORS, unique in the room
  device: "mouse" | "touch" | "gamepad" | "pad";
  deviceKey: string;        // gamepad index+id, pad peer id, "pointer"
  view: number | "shared";  // split-screen viewport, or the shared camera
  mode: "orbit" | "walk" | "fly";
  role: "admin" | "guest";
}
```

Per-seat state that today is global moves into a `SeatState` owned by the seat: Aim and its ray preview, cursor position (for gamepad and Cursor pad seats), focus ([AUDIO-MIX.md](AUDIO-MIX.md) focus is a *listening* setting and stays per client; *aim focus* is per seat), hotbar selection, `holding`, the avatar rig in avatar mode, and the undo stack.

Seat 1 is always the device the host is using (mouse + keyboard on desktop, touch on a phone). Seats are numbered in join order, and their colour is shown everywhere the seat acts: cursor, aim ray, held-toy ring, split-screen border, pad header.

### 3.2 Presence

`PresenceState` becomes `{ seats: SeatPresence[] }`, where `SeatPresence` is today's fields (name, colour, mode, pose, aim) plus `id`, `device` and `holding`. One awareness entry per client keeps the relay unchanged. Older clients read `seats[0]` only, so the change can ship before every client supports seats (the build lock makes mixed builds rare anyway).

The relay's member cap becomes a **seat cap**: the `hello` message carries the seat count, and a client asks the relay before adding a seat (`control: seat+`, answered `ok` or `full`). The cap stays 8 per room.

### 3.3 Edits, undo, roles and locks

- Every doc transaction from the binding uses the **seat object as its origin**. `Y.UndoManager` takes a `trackedOrigins` set, so each seat gets its own undo stack. Undo is bound per device: `Ctrl+Z` for seat 1, `Back`+`B` on a gamepad, an undo button on the Pad.
- **Roles are per seat.** Seat 1 on the host is the admin (MULTIPLAYER §12). Other local seats start as guests, so a locked world stops a toddler on seat 3 from deleting things while the parent on seat 1 can still edit. The admin can promote any seat, local or remote. The relay still enforces the lock per socket; the binding enforces it per seat for seats that share a socket.
- **Soft locks** (`holding`) are per seat, so two local players can't drag the same toy either.

### 3.4 Joining and leaving

| Device | Joins by | Leaves by |
|---|---|---|
| Mouse + keyboard | Always seat 1 on desktop | — |
| Gamepad | Pressing any button while unassigned (browsers expose a gamepad only after its first button press). A "Press any button to join" chip shows when the host sees an unassigned pad. | Holding `Start`/`Menu` for 2 s → *Leave*; or disconnecting for 30 s |
| Phone as Pad | Scanning the QR (§5.2), then tapping *Use as controller* | Closing the page or *Leave*; 30 s without a heartbeat |
| Phone as Screen | Scanning the QR, then *Play on this phone* | Same as a remote player |

A seat that leaves keeps its toys in the world (they belong to the room). Its colour is held for 2 minutes so a pad that reconnects gets the same seat back (matched by a seat token kept in the pad's `sessionStorage`).

---

## 4. Topology A: desktop host

```
                     ┌──────────────────────────────────── host screen ─┐
 mouse + keyboard ──►│ seat 1  ┐                                         │
 gamepad 0 ─────────►│ seat 2  │ intents ─► World ─► one AudioEngine ─► speakers
 gamepad 1 ─────────►│ seat 3  │  (per seat)  ▲                          │
 phone Pad (WebRTC) ►│ seat 4  ┘              │ Y.Doc binding            │
                     └────────────────────────┼─────────────────────────┘
                                              │ wss://…/room/<code>
 phone Screen (own view, muted) ◄─────────────┤ relay (Vite on the dev
 remote friend (own view, audio on) ◄─────────┘  machine, rooms.<brand>, or the desktop app)
```

### 4.1 Gamepads

- **Source.** A `GamepadSource` in `src/controllers/`, next to the MIDI sources from [DESKTOP-MIDI.md](DESKTOP-MIDI.md) §3.4, polls `navigator.getGamepads()` once per animation frame and turns button edges and stick values into intents for the pad's seat. Dead zone 0.15 (radial), response curve `x²·sign(x)` for cursor speed.
- **Mapping.** Use the browser's `standard` mapping. Pads that report a non-standard mapping (some Switch Pro and generic USB pads on Firefox/Linux) go through small profile JSONs keyed by `Gamepad.id`, the same way MIDI profiles work. Unknown pads get a two-step "press the button you want to poke with" calibration.
- **Desktop app.** WebView2 (Windows), WKWebView (macOS) and WebKitGTK (Linux) all expose the Gamepad API, but only while the window has focus, and the WebKitGTK support depends on how the distro built it. Step L1 tests all three. If any fall short, add a **native backend** in the Tauri shell using the `gilrs` crate (Apache-2.0/MIT) that sends the same events over a Tauri `Channel`, like the MIDI forwarder. It also brings rumble and more than four XInput pads.
- **How many.** Chrome reports four gamepad slots, and Windows XInput caps Xbox-style pads at four. With mouse + keyboard that's five on-screen seats from gamepads alone; phones fill the rest up to 8. The `gilrs` backend can lift this on desktop.
- **Rumble.** `GamepadHapticActuator.playEffect("dual-rumble")` where supported: a short tick when the seat's poke lands on the beat, a soft buzz when a grab is refused by a lock.

**Orbit view mapping** (shared camera; [AVATAR.md](AVATAR.md) §7 covers avatar view):

| Control | Action |
|---|---|
| Left stick | Move this seat's cursor (accelerates with hold; **aim assist** snaps to toys and handles within 24 px) |
| `A` | Poke what the cursor is on (analogue strength from how fast the stick was moving, or full) |
| Hold `A` on a base | Grab and move the toy; left stick moves it on the ground plane |
| Hold `A` on a handle | Stretch along the handle with the left stick |
| `RT` / `LT` | Stretch the aimed toy's main param up / down (analogue) |
| Right stick X | Twist |
| `X` | Toggle the aimed toy's Pulse |
| `Y` | Chest (opens a per-seat chest on that seat's side of the screen) |
| `RB` / `LB` | Hotbar next / previous; `LT` + `A` places the hotbar toy at the cursor |
| `B` | Cancel / close |
| `View` / `Back` + `B` | Undo (this seat only) |
| Hold `Start` / `Menu` | Seat menu: name, colour, Avatar mode, Leave |
| D-pad | Audio ([AUDIO-MIX.md](AUDIO-MIX.md) §4.5); mute/solo are per client, so any seat can use them |

### 4.2 One screen, several players

**Orbit view (default).** One camera. Seat 1 (mouse) drives it as today. Gamepad seats get the camera only if seat 1 hands it over (*Camera: me / auto / seat N* in the seat menu). **Auto camera** frames the union of every seat's cursor and focused toy, easing slowly so nobody gets dragged off-screen. Each cursor is a ring in the seat's colour with the seat's number in it; cursors are clamped to the visible area.

**Avatar view: split screen.** When two to four local seats are in avatar mode, the canvas splits: 2 → side by side (top/bottom on portrait screens), 3 → one wide on top and two below, 4 → quadrants. Each viewport renders with its own camera through three.js `setViewport`/`setScissor` in one WebGL context, and gets its own crosshair, hotbar and hints in the seat's colour. Seats still in orbit view share the largest viewport. Seats 5 and up can't get an avatar on the host screen; their seat menu offers *Continue on your phone* (a QR that moves the seat to a Screen).

**Render budget.** Split screen multiplies draw calls. Each extra viewport drops shadow resolution and particle counts one quality step, and the frame-time guard from the renderer drops to the next layout (4 → 3 → 2) before audio can starve. The audio worklet is unaffected by render load, which is why audio stays on one engine either way.

**Help.** Hints anchor to the seat that needs them and show that seat's device glyphs ([HELP-SYSTEM.md](HELP-SYSTEM.md) §3.3): "press `A`" next to the gamepad seat's cursor, "drag" near the mouse cursor.

**Listening.** One pair of speakers means one listener. In orbit view it's the camera; in split screen it's the centroid of the local avatars, with distance attenuation softened so no player's toys disappear because another player walked away ([AVATAR.md](AVATAR.md) §9).

### 4.3 Phones in Topology A

A phone that scans the host's QR picks a role (§5.2):

- **Pad** (the default when the host is a desktop): the phone is a controller for a seat that lives on the host. It renders nothing 3D and plays no sound. Latency budget: input to host under **30 ms** on the same Wi-Fi over the data channel, under **120 ms** through the relay fallback. Pokes from a Pad are played on the host, so they need no clock sync.
- **Screen**: the phone is a full room member with its own camera and its own seat, like a remote player, except that it is in the host's **site** (§7.1) and therefore muted by default. Good for tablets, for kids who want to walk around the world while the host screen shows the overview, and for seats beyond 4 in avatar mode.

---

## 5. Pads

### 5.1 The page

`pad.html` is a separate Vite entry with its own small bundle: no three.js, no WASM, no AudioWorklet. Target under **80 KB** gzipped so it opens fast on a weak phone over a tunnel. It uses the relay only to sign in and signal, then talks to the host over a data channel (§6.3).

On open it asks for nothing: no name (it gets one), no permission prompts. It requests a **screen wake lock** while connected (`navigator.wakeLock`, needs a secure context, which all our join URLs are) and locks to portrait where `screen.orientation.lock` is allowed.

### 5.2 The join flow

1. The host shows a QR. On desktop it sits in the **seat strip** at the bottom of the screen (a `+` tile that expands to a QR), and in the room sheet. It encodes `https://<origin>/j/<code>?t=<token>&s=<site>` (§6.2).
2. The phone's camera app opens the link. If the native app is installed, the universal link / app link opens it instead (§9).
3. The page shows the host's world name and the colours already taken, and two big buttons with pictures, no reading needed: a gamepad (**Use as controller**) and a phone with a planet on it (**Play on this phone**). The host's topology picks the highlighted default: Pad for a desktop host, Screen for a phone host.
4. A Pad gets a seat and the phone's header turns that seat's colour, while a matching cursor pops onto the host screen with a small chime. Screens load the full app with `?room=` and the site id.

### 5.3 Faces

The pad switches face automatically from the seat's mode and what it's aiming at; a swipe along the bottom edge switches manually.

| Face | When | Layout |
|---|---|---|
| **Cursor pad** | Orbit view | The whole top area is a trackpad that moves this seat's cursor on the host screen (relative, with acceleration). Tap = poke at the cursor; press-and-hold then drag = grab or handle-drag; two-finger vertical drag = stretch; two-finger rotate = twist. A hotbar strip and a chest button along the bottom. |
| **Stick pad** | Avatar view | The touch map from [AVATAR.md](AVATAR.md) §7: left thumb virtual stick, right side drag to look, buttons for jump/fly, place, poke, hotbar. |
| **Toy pad** | Any time the seat focuses a toy (aim rests on it for 400 ms, or a double-tap on the Cursor pad) | The focused toy's icon and name, a big **poke pad** (strength from tap velocity and contact area), its non-`derived` params as big sliders or an XY pad (using each param's declared `gesture`), the Pulse ring from PLAN §3.3, and a *Back to cursor* button. This puts fine control on the phone so nobody fights for the host screen. |

**Haptics.** `navigator.vibrate` on Android: a tick when this seat's poke sounds, and an optional "feel the beat" pulse on each onset of the focused toy. iOS Safari has no vibration API, so web pads on iOS are silent to the touch; the native app adds haptics through Tauri's haptics plugin (§9).

### 5.4 Pad protocol

Over the data channel (or the relay fallback), JSON for v1 and a fixed binary layout for `input` once it's stable:

| Direction | Message | Channel | Rate |
|---|---|---|---|
| pad → host | `input {seq, move:[x,y], look:[x,y], buttons, touch?}` | unreliable, unordered | 60 Hz while touched, 0 otherwise |
| pad → host | `intent {poke | setParam | pulse | hotbar | place | chest | undo | mode | leave, …}` | reliable | on action |
| host → pad | `view {seat, mode, face, focus: {toyId, name, icon, params, pulse}, hotbar, locked}` | reliable | on change, max 10 Hz |
| host → pad | `fx {haptic | flash, pattern}` | unreliable | on onset |
| both | `ping` / `pong` | reliable | every 2 s (latency shown in the seat menu) |

`setParam` carries normalised values (0–1) like MIDI mapping does, so the host applies them through the same intent path and its throttled doc writes. The host never trusts a pad with anything a guest seat couldn't do.

---

## 6. Networking

### 6.1 Sites

A **site** is one physical room. The host creates a random `siteId` when it opens a local session, and every device that joins through its QR carries it. Remote guests who join by a texted link have no site id (or their own). The doc stores per-site settings under `sites: Y.Map<siteId, {host: seatId, speaker: "host" | "everyone" | "ensemble"}>`.

The site decides audio defaults (§7) and nothing else; it's not a security boundary.

### 6.2 What the QR encodes

```
https://play.<brand>/j/K7QFZM?t=4ZQ8M2&s=b31k
        └ origin of the relay ┘  │       │      └ site id
                                 │       └ join token (rotates every 5 min; the QR refreshes)
                                 └ room code
```

- During development the origin is the tunnel (`https://<x>.ngrok-free.app/j/…`), printed by `npm run tunnel` and shown in the app.
- The **join token** proves the phone saw the screen. A room link without a token can still join the room as a remote player if the room is open (MULTIPLAYER behaviour), but it can't claim a **Pad** seat, which drives the host's screen. Tokens are checked by the host, not the relay.
- `/j/<code>` is a tiny route on the app origin that decides between Pad, Screen and "open in app", so the QR stays short (version 3–4 QR, readable across a living room at about 1 m per 10 cm of QR).

### 6.3 Pad transport: WebRTC with a relay fallback

1. The pad connects to the relay as a **pad member** (`hello {kind: "pad", site, token}`). Pad members get no doc sync and no awareness, so they're cheap.
2. New relay channel `5` **signal**: forwards an opaque payload from one member to one other member by id. Pad and host exchange SDP and ICE through it.
3. Host and pad open an `RTCPeerConnection` with two data channels: `input` (`ordered: false, maxRetransmits: 0`) and `ctl` (reliable). STUN: one public server for server-reflexive candidates; **no TURN**.
4. If the connection isn't up within 3 s, or drops, pad messages go over the relay's event channel addressed to the host (`to: hostMemberId`, new optional field) and the pad shows a small "slow link" dot. Most homes connect directly over host or mDNS candidates; hotel, school and café Wi-Fi often isolate clients, which is exactly when the fallback matters.

Why not a WebSocket straight from the pad to the host? A desktop browser can't listen on a port, and an `https` pad page can't open `ws://` to a LAN address (mixed content; Chrome's Local Network Access prompt also applies). WebRTC is the one browser-to-browser LAN path that works from a secure page.

### 6.4 Where the relay runs, per situation

| Situation | Relay | Works offline? |
|---|---|---|
| Developer testing (today) | Vite relay on the dev machine, reached through `npm run tunnel` | No (tunnel needs internet) |
| Desktop host in a browser, production | `rooms.<brand>` (Durable Objects, PUBLISHING P4) | No |
| Desktop app host | Embedded Rust relay (MULTIPLAYER M6), reachable on the LAN; tunnel or `rooms.<brand>` for remote guests and for pads that load the pad page from `https://play.<brand>` | Pads and Screens in the **native app** only (§8.3) |
| Phone browser host | `rooms.<brand>` (or the dev tunnel) | No |
| Native mobile app host | `rooms.<brand>` when online; embedded relay on the LAN when offline (L8) | Native-app guests only |

Rule: **use the cloud relay whenever there's internet**, even when an embedded one is available. A cloud room survives the host's laptop sleeping or the host phone taking a call (the admin role passes on, MULTIPLAYER §12); an embedded relay dies with its app.

---

## 7. Audio

### 7.1 Who plays sound

- **Topology A.** The host plays everything. Pads have no audio. Screens in the host's site start **muted** (master off, a speaker-with-a-line icon they can tap; headphones are fine). Remote guests play their own audio as in MULTIPLAYER.
- **Topology B.** The site's `speaker` policy decides:

| Policy | Who sounds | Needs | Good for |
|---|---|---|---|
| `host` | Only the host phone | Nothing new (works before clock sync) | First version; quiet rooms |
| `everyone` | Every phone plays the whole mix | Clock sync (MULTIPLAYER M3) | Louder, but identical signals a few ms apart comb-filter; off by default |
| `ensemble` | Each phone plays only the toys **its own seats placed**; toys from departed players or Pads fall to the site host | Clock sync, a `placedBy` field on toys | **Default once M3 lands.** Each phone is an instrument; sound comes from where the player sits; no comb filtering because no two phones play the same voice |

`ensemble` needs no new engine feature: it's an automatic **local mute mask** using the per-client mute from [AUDIO-MIX.md](AUDIO-MIX.md) §3, recomputed when toys or seats change. The new doc field is `placedBy: seatId` on each toy, written on add (and on adopt, when the placer leaves).

### 7.2 Muted engines and battery

A Screen that isn't sounding still runs the engine, because snapshots drive the toys' animation. Add an engine flag **`render_audio = false`** that keeps clocks, Pulse, pattern and event generation running but skips voice DSP and the output buffer. Visuals stay beat-correct, and a muted phone saves most of the audio CPU. When the player unmutes, voices start at the next onset.

### 7.3 Latency in a shared room

People in one room hear the same speaker, so pokes from the host's seats and Pads need no lookahead at all: they play on arrival. Screens in the same site that *do* sound (`everyone`, `ensemble`) use MULTIPLAYER §5's beat-stamped pokes and output-latency compensation; their per-device latency trim matters more here because players hear each other's phones directly. The room sheet warns when a sounding phone uses Bluetooth output.

---

## 8. Topology B: phone host, phone players

### 8.1 Flow

1. The host opens the app on a phone (browser or native) and taps **Invite**. A full-screen sheet shows the QR, the room code in big letters, and a *Share link* button (system share sheet).
2. Each guest scans the QR with their phone camera and lands on *Play on this phone* (highlighted, since the host is a phone). The world loads; they're a seat with their own camera and touch controls.
3. Everyone's own screen shows their own view. Presence (avatars, aim dots, held-toy rings) shows who is doing what.
4. Audio follows the site's speaker policy (§7.1), set by the host in the Invite sheet with three pictures.

The host phone is seat 1 and the site host. If the host leaves, the next phone in the site becomes the site host (it starts playing unowned toys in `ensemble`), and the admin role passes on as in MULTIPLAYER §12.

### 8.2 Phone-specific work

| Concern | Plan |
|---|---|
| Screen sleep | Wake lock while in a room, on every device |
| App in background (a call, a notification tap) | Browser and native: the socket drops after a few seconds on iOS; on return the session reconnects and resyncs (already built). With the cloud relay nothing is lost. An embedded relay (offline) must stay foreground; the host sees a banner saying so. |
| Thermals | Phones in a room run at **reduced render quality** by default (lower DPR cap, fewer particles) and `render_audio = false` when muted. A 20-minute 4-phone session must not throttle the host phone into audio dropouts (L6 exit check). |
| Small screens | The room sheet and seat strip collapse to chips; the QR is a separate full-screen sheet so it's big enough to scan from across a table |
| Gamepads on phones | A Bluetooth pad paired to a phone works through the same `GamepadSource` (iOS Safari and Android Chrome both expose it), as an extra seat on that phone with split screen off |
| Orientation | Landscape for avatar mode, either for orbit; the Pad is portrait |

### 8.3 Offline and hotspot play (native app only)

With no internet, browser guests can't join a full Screen session: an `http://192.168.x.x` page isn't a secure context, so it has no AudioWorklet, no wake lock and no service worker. The native app avoids this because it bundles the app and talks to the host directly.

- The native host starts the **embedded Rust relay** (the same crate as the desktop host, MULTIPLAYER M6: axum + `tokio-tungstenite` + `yrs`) on a LAN port and advertises it with **mDNS/Bonjour** (`_cosmicplay._tcp`).
- The QR then carries a LAN hint: `…/j/K7QFZM?t=…&s=…&lan=192.168.43.1:47800`. The native guest app tries the LAN address first and the cloud second.
- Works on a phone's own hotspot (the host is the gateway).
- iOS needs `NSLocalNetworkUsageDescription` and `NSBonjourServices` in `Info.plist`, and shows the Local Network permission prompt the first time; Android needs a `WifiManager.MulticastLock` for mDNS discovery. Both are in the mobile spike checklist (PUBLISHING §5.1).
- Browser guests in offline mode get a **Pad only**, served over plain `http` by the host app with the controller page degraded (no wake lock). Better than nothing for the one friend without the app.

---

## 9. Mobile builds for this topology

The phone host topology raises the priority of the native wrapper from "later" (PLAN §4.1, Phase 5) to a supporting step for local play: it's what makes iOS haptics, background resilience, offline play, in-app QR scanning and universal links possible. The web build stays the zero-install path for every guest.

Summary of the revision to [PUBLISHING.md](PUBLISHING.md) §5.1 (details there):

1. **Wrapper:** Tauri 2 mobile instead of Capacitor, decided by a one-week spike (T0) with explicit pass/fail checks (AudioWorklet + WASM in WKWebView and Android WebView, cross-origin isolation headers through Tauri's asset protocol, Gamepad API, wake lock, local network, QR scanning). Capacitor is the fallback if T0 fails.
2. **App records now, release later:** register the bundle id on Apple and Google, create the App Store Connect and Play Console app records, and ship only to testers (TestFlight internal/external, Play internal testing, Play closed testing).
3. **Building from the Windows dev machine:** Android builds, installs and uploads locally; iOS builds in CI on a GitHub macOS runner, started from the dev machine with one command, and lands in TestFlight.
4. **A dev client** (an internal-only app flavour that loads a URL from a scanned QR) so the dev machine's tunnel serves fresh web code to installed apps on both platforms without rebuilding native code.

### 9.1 Linking into the app

- Production: universal links (`/.well-known/apple-app-site-association`) and Android App Links (`/.well-known/assetlinks.json`) on `play.<brand>`, for the `/j/*` path. The phone camera then opens the app directly when installed.
- Before the domain exists, and on tunnel URLs (where we can't host those files stably), `/j/` shows an *Open in app* button using a custom scheme (`cosmicplay://j/K7QFZM?...`), and the app has its own **Scan** button (Tauri barcode-scanner plugin).

### 9.2 Build lock on mobile

A bundled app can't load another web build the way a browser can (PUBLISHING §4.4). Testers on TestFlight and Play internal testing update automatically, so the "different version" message tells them to update. The **dev client** sidesteps the lock entirely because it loads whatever the host's tunnel serves.

### 9.3 Developer loop for a table-of-phones test

```bash
npm run tunnel -- --build
```

prints, besides today's links: the **local-session QR** (open on the host phone to start), and a **dev-client QR** (`cosmicplay-dev://open?url=<tunnel>`) that the dev client scans to load this build. Every phone, browser or app, then shares one relay on the dev machine and one build id.

---

## 10. Phasing

| Step | Scope | Depends on | Exit check |
|---|---|---|---|
| **L0. Seats** | `Seat`/`SeatState`; intents carry a seat (on top of the `intents.ts` split from DESKTOP-MIDI D1); per-seat Aim, cursor, hotbar, holding, undo origin, role; presence as a seat list; relay seat cap | DESKTOP-MIDI D1 refactor (or do that split here) | A scripted scenario drives two seats on one client: separate undo, a locked world blocks seat 2 but not seat 1, two clients see four cursors |
| **L1. Gamepads** | `GamepadSource`, join by button, orbit map with aim assist, shared and auto camera, per-seat chest, rumble; test WebView2, WKWebView, WebKitGTK; `gilrs` backend only if needed | L0 | Two gamepads and a mouse build a 6-toy jam on one screen in Chrome, Safari, Firefox and the desktop app; a 4-year-old can join by pressing a button |
| **L2. Pads** | `pad.html` (Cursor and Toy faces), `/j/` route, join tokens, site ids, relay `signal` channel and pad members, WebRTC with relay fallback, seat strip with QR, Android haptics | L0; relay | Topology A complete: a phone becomes a controller within 5 s of scanning; input-to-sound under 30 ms (data channel) and 120 ms (fallback) measured by the onset log; works on a client-isolated Wi-Fi via the fallback |
| **L3. Split screen** | 2–4 avatar viewports, per-viewport HUD, render budget fallback, Stick pad face, *Continue on your phone* | L1, AVATAR V1–V3 | Two avatar players on one screen at 60 fps on the reference laptop; a third and fourth hold 45 fps or step down cleanly |
| **L4. Screens in a site** | Join as Screen from the QR, muted by default, site settings, `render_audio = false` | L2; MULTIPLAYER M2 | A tablet joins a desktop host as its own view with no echo; muted phone CPU drops by at least half |
| **L5. Phone host (web)** | Invite sheet, Topology B defaults, phone quality profile, site-host hand-off, `host` speaker policy | L4 | Four phones in browsers, one hosting through the dev tunnel, play for 20 minutes; host phone survives a 30 s backgrounding without anyone losing work |
| **L6. Ensemble** | `placedBy`, `ensemble` and `everyone` policies via local mute masks, Bluetooth warning | MULTIPLAYER M3, AUDIO-MIX A1 | Four phones in `ensemble`: onsets within 10 ms of each other (onset log), each phone plays only its player's toys; no thermal throttling on the host in 20 minutes |
| **L7. Native shells** | PUBLISHING §5.1 steps T0–T3: Tauri mobile spike, app records, internal builds, dev client, haptics, Scan button, custom scheme | T0 decision | A tester installs from TestFlight and from Play internal testing, scans a QR and joins; the dev client loads a tunnel build on both platforms |
| **L8. Offline native host** | Embedded Rust relay on mobile (shared with MULTIPLAYER M6), mDNS, LAN hint in the QR, `http` pad fallback | L7, MULTIPLAYER M6 | Two phones on a phone hotspot with no internet play together in the native app |

L0–L2 are the critical path for the default topology. L5 can start as soon as L4 lands and needs nothing native. L7's spike (T0) can run any time in parallel, since it only needs the current web build.

---

## 11. Test matrix

| # | Host | Local players | Relay | Measures |
|---|---|---|---|---|
| A1 | Desktop Chrome (Windows) | mouse + 2 Xbox pads | Vite dev | join by button, per-seat undo, frame time |
| A2 | Desktop app release (Windows, WebView2) | mouse + Xbox pad + PS5 pad | embedded (M6) or tunnel | Gamepad API in WebView2 with focus changes |
| A3 | Desktop Safari / desktop app (macOS) | mouse + Switch Pro pad | tunnel | non-standard mapping, WKWebView gamepads |
| A4 | Desktop Chrome | mouse + 2 Pads (iPhone Safari, Android Chrome) | tunnel | QR-to-cursor time, pad latency, Android haptics |
| A5 | Desktop Chrome on a client-isolated Wi-Fi (guest network) | 2 Pads | tunnel | relay fallback engages, latency stays under 120 ms |
| A6 | Desktop Chrome, avatar mode | 4 gamepads | Vite dev | split-screen fps and step-down |
| A7 | Desktop Chrome | mouse + Pad + iPad Screen + one remote friend | tunnel | site muting, mixed local/remote presence |
| B1 | iPhone Safari | 3 phones in browsers (mixed iOS/Android) | tunnel | `host` policy, backgrounding the host, thermals |
| B2 | Android app (dev client) | 3 phones, mixed app and browser | tunnel | `ensemble` onset spread, Bluetooth warning |
| B3 | iPhone app (TestFlight) | 2 phones with the app, phone hotspot, no internet | embedded | offline LAN join, Local Network prompt |

Each run records: QR-to-playing time, input-to-sound latency per device (onset log, MULTIPLAYER §10), host frame time, host CPU and temperature after 20 minutes on phones, and relay bytes per minute.

---

## 12. Testing

- **Seat unit tests:** origin-scoped undo, per-seat locks and roles, seat cap at the relay, colour uniqueness, seat token reclaim after reconnect.
- **Synthetic devices:** a `FakeGamepadSource` and a headless pad client let [DEV-MODE.md](DEV-MODE.md) scenarios declare `"seats": [...]` and script stick moves and button presses, so local play runs in the same CI job as the two-player scenarios.
- **Pad transport:** Playwright with two pages (host and pad) on one relay; force the data channel to fail and check the fallback; check `input` messages are dropped, not queued, under load.
- **Protocol fuzzing:** malformed `signal` and pad `intent` messages at the relay and host; a pad can never act beyond a guest seat.
- **Device playtests:** the matrix above, plus one session led by a child with no instructions (pillar 7: joining must need no reading).

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| The browser only reads gamepads while the host window has focus; a parent alt-tabs and the kids' pads die | Show "Click here to wake the controllers" when focus is lost with pad seats present; `gilrs` backend in the desktop app reads pads regardless of focus |
| Four-XInput limit and odd mappings | Profiles by `Gamepad.id`; calibration fallback; `gilrs` on desktop |
| Wi-Fi client isolation blocks WebRTC between pad and host | Relay fallback on the event channel, measured in A5 |
| Phones in one room echo each other | Screens in a site start muted; `ensemble` instead of `everyone` |
| Phone host overheats or gets throttled | Phone quality profile, `render_audio = false` on muted guests, cloud relay so the host can drop out without ending the jam |
| A leaked room link lets a stranger drive the host screen | Pads need a rotating join token from the on-screen QR; remote joins follow the room's existing rules (no list, member cap, kick, lock) |
| Split screen halves frame rate on modest laptops | Per-viewport quality steps and automatic layout fallback; seats beyond 4 move to phones |
| Seat model leaks into every system (Aim, chest, hotbar, undo, help) | L0 does the refactor once with a scenario test per system before gamepads exist |
| iOS web pads have no haptics | Visual flash on the pad; native app adds haptics |
| Tauri mobile is younger than Capacitor | The T0 spike has hard exit checks; Capacitor fallback keeps the web build unchanged either way |

---

## 14. Decisions and open questions

**Proposed (to confirm)**

1. Seats over sockets: one client may hold up to 8 seats, the room cap counts seats.
2. Pads are input devices of the host, not room members; Screens are room members.
3. WebRTC data channel for Pads with relay fallback, no TURN.
4. Same-site Screens start muted; `ensemble` becomes the phone-host default once clock sync lands.
5. Tauri 2 mobile replaces Capacitor in the plan, subject to the T0 spike.

**Open**

1. Should gamepad seats be able to take the shared camera with a stick click, or only when seat 1 hands it over? (Proposed: hand-over only, plus auto camera; revisit after the first couch playtest.)
2. Does a Pad seat get an avatar in split screen, or is the Pad always orbit-only? (Proposed: a Pad can be one of the four avatar viewports; the Stick pad drives it.)
3. Should a site have a "quiet" policy for classrooms (only the teacher's screen sounds, Screens can't unmute)?
4. Is NFC tap-to-join worth adding to the native app later (Android reads NDEF easily; iOS needs a tag)?

---

## Sources (check before building)

- Gamepad API and standard mapping: https://w3c.github.io/gamepad/ · haptics: https://w3c.github.io/gamepad/extensions.html
- WebRTC data channels and ICE (mDNS host candidates): https://developer.mozilla.org/docs/Web/API/RTCDataChannel · https://datatracker.ietf.org/doc/html/draft-ietf-mmusic-mdns-ice-candidates
- Screen Wake Lock: https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API
- Chrome Local Network Access: https://developer.chrome.com/blog/local-network-access
- `gilrs`: https://gitlab.com/gilrs-project/gilrs
- Yjs `UndoManager` tracked origins: https://docs.yjs.dev/api/undo-manager
- Apple Local Network privacy: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- Tauri 2 mobile, barcode scanner, haptics, deep links: https://v2.tauri.app/start/prerequisites/ · https://v2.tauri.app/plugin/barcode-scanner/ · https://v2.tauri.app/plugin/haptics/ · https://v2.tauri.app/plugin/deep-linking/
