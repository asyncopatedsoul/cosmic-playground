# Avatar and creator mode plan

> Walk into the world as a small **avatar**, Minecraft-creative style. Walk on the ground, on a
> custom **planetoid** or **prism**, or take off and **fly** relative to the last gravity you stood
> in. In avatar view, every creator action (poke, place, grab, stretch, twist, remove) targets what's
> under the **crosshair**, and a toggle draws the **ray and hit point** so players can see exactly
> what they're aiming at.

Status: **V0 and V1 implemented** (Oct 2026), V4 presence over the room relay; V2, V3, V5 planned (see §14) · builds on [PLAN.md](PLAN.md) §3 (intent layer, views) · interacts with [MULTIPLAYER.md](MULTIPLAYER.md) §4.1 (presence), [SAVE-LOAD.md](SAVE-LOAD.md) §3 (orientation, bodies) and [AUDIO-MIX.md](AUDIO-MIX.md) §3 (listener)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| Modes | **Orbit** (today's camera, stays the default), **Walk** (gravity-bound avatar), **Fly** (free movement in the frame of the last bound gravity). First- or third-person in Walk and Fly. |
| Switching | HUD segmented control (three glyphs), `C` toggles Orbit ↔ avatar, double-tap `Space` toggles Walk ↔ Fly (Minecraft muscle memory), `V` toggles first/third person. |
| Gravity | A small set of analytic **gravity bodies**: the ground **plane** (default), **planetoid** (sphere) and **prism** (rounded box / n-gon prism). "Up" is the gradient of each body's signed distance field, so walking over a prism's edge rolls you smoothly onto the next face. Bodies are world objects: placed, saved and synced like toys. |
| Fly frame | Fly keeps the **last bound body**; "up" is that body's up at your current position (constant for a plane, radial for a planetoid). A setting freezes it at take-off instead (§13). `G` rebinds to whatever surface you aim at. |
| Targeting | One **Aim** service replaces raw screen coordinates in the input layer: a ray from the pointer (Orbit) or the crosshair (avatar), returning toy part, surface point, normal, body and reach. Every creator action consumes an Aim hit. |
| Ray preview | `B` toggles drawing the aim ray from the avatar's hand, the hit point (dot + ring on the surface normal), the targeted part's outline (visible through occluders), and the placement ghost. Off by default; remembered per device. |
| Physics | A small **kinematic controller** in TS against analytic shapes. No physics engine for v1; Rapier stays an option if bodies become arbitrary meshes. |
| Order | V0 (the Aim refactor and ray preview, useful in Orbit too) is cheap and lands first; avatars follow multiplayer M2, so avatar poses ride on presence from day one. |

---

## 1. Goals and non-goals

**Goals**

1. **Be inside the world.** Walk up to a Spire and pluck it at eye height; fly over a jam and look down at it.
2. **Creative, not survival.** No damage, no hunger, no inventory scarcity. Falling off the edge brings you back gently.
3. **Small worlds with their own gravity.** Put toys on a planetoid and walk all the way around it; build on the faces of a prism.
4. **Aim is always clear.** A player always knows what a click will do, before clicking.
5. **Orbit stays first-class.** Young kids, touch screens and streams keep the simple orbit view; avatar mode is an option, never required.

**Non-goals (for now)**

- Arbitrary mesh gravity (terrain, imported models). The SDF approach leaves room for it.
- Avatar customisation beyond colour (and, later, a few shapes).
- XR locomotion (the XR phase reuses the Aim service and gravity bodies; see §10).

---

## 2. What exists to build on

| Today | Where | Change |
|---|---|---|
| Orbit camera (`azimuth`, `elevation`, `distance`, `target`), `pick`, `ray`, `planePoint(y)` | `render/stage.ts` | Stage gets **camera rigs**: `OrbitRig` (today's code) and `AvatarRig`; picking moves into Aim |
| Intent layer: tap = poke, base-drag = grab, handle drags, wheel = stretch, Q/E = twist, Space = poke last toy, Tab = chest | `input.ts` | Split into **devices → intents → Aim-targeted actions** (§5); avatar keys added |
| Toys stand on `y = 0`; grab clamps to a 12 m disc; `freeSpot()` searches the plane | `world.ts`, `input.ts` `grab()` | Toys get an orientation and an optional `body`; placement and dragging follow surfaces |
| `Toy.sendPan()` pans from the camera, only when a toy moves | `toys/toy.ts` | In avatar mode, pans update as you turn (throttled) and distance attenuates (§9) |
| Ground: a 16 m disc and polar grid | `stage.ts` `addGround()` | Becomes the default **plane body** |
| Pickable parts with names (`base`, `heart`, `cap`, `planet:i`, …) | `toys/*.ts` | Aim reports the part; the outline highlights it |

---

## 3. Modes

| Mode | Movement | Camera | Pointer |
|---|---|---|---|
| **Orbit** | none (camera only) | orbit around a target; double-click a gravity body to orbit it | free cursor; Aim ray from the cursor; unlimited reach |
| **Walk** | WASD on the bound body's surface, `Space` jump, `Shift` sneak (won't walk off edges, slower) | first person (eye 1.4 m) or third person (chase, 3.5 m behind, collides with bodies) | **pointer lock**; Aim ray from the crosshair; reach 8 m |
| **Fly** | WASD in the plane perpendicular to "up", `Space` up, `Shift` down, double-tap `W` boost | same | same |

- **Entering avatar mode** spawns the avatar on the surface under the orbit target, facing the orbit camera's direction, with a 0.6 s camera move (a cut under reduced motion). **Leaving** puts the orbit target at the avatar and keeps the heading.
- **Pointer lock** needs a click: entering avatar mode shows a centred "Click to look around" pill. `Esc` releases the lock (the browser owns that key); a second `Esc` closes panels as today. Opening the chest, a panel or the Toy Book releases the lock automatically and offers to re-lock on close.
- **Falling out of the world** (more than 20 m beyond any body) fades and returns you to the last body you stood on.
- **Avatar look:** a small glowing figure in the toy style (rounded capsule, visor, a "hand" light that is the ray origin), tinted with the player's colour. It's visible to yourself in third person and to others in multiplayer.

---

## 4. Gravity

### 4.1 Bodies

```ts
interface GravityBody {
  id: string;                         // "b_…", or "ground"
  kind: "plane" | "planetoid" | "prism";
  pos: Vec3; quat: Quat;
  /** plane: walkable radius; planetoid: radius; prism: half-extents + corner radius, or sides + radius + height */
  shape: Record<string, number>;
  /** How far from the surface the body captures a walker (planetoid default 2.5 × radius). */
  reach: number;
  color: string;
}
```

Each kind provides two pure functions:

- `sdf(p)`: signed distance from the surface (negative inside).
- `up(p) = normalize(∇sdf(p))`: analytic for plane and planetoid; for the rounded prism, the gradient of the rounded-box SDF, which equals the face normal on faces and turns smoothly across the rounded edges and corners. That smooth turn is what lets a walker roll over an edge onto the next face (Super Mario Galaxy style) instead of falling off.

Gravity strength is the same everywhere (a fixed "creative" acceleration); bodies differ in *direction*, not strength.

### 4.2 Binding rules

1. **Walk:** the avatar is bound to the body it stands on. While airborne (jumping, falling), it stays bound unless it enters another body's `reach` **and** that body's surface is closer; then it rebinds, and the avatar's up vector slerps to the new up over ~0.4 s.
2. **Fly:** no gravity. Movement axes come from the **last bound body's `up` at the current position**. Over the ground that's always world-up; around a planetoid it's radial, so flying "forward" curves around the planet, which feels like orbiting it.
3. **Landing:** double-tap `Space` back to Walk and you fall toward the last bound body.
4. **Rebind on purpose:** `G` binds to the body under the crosshair (its surface must be hit by the Aim ray). In Walk you then fall toward it, which is the fun way to "jump" from the ground to a planetoid floating overhead.
5. An option, **"keep my up while flying"**, freezes the fly frame at take-off instead (decided in §13: live is the default, both are playtested).

### 4.3 Toys on bodies

- Placing a toy on a surface sets its position to the hit point and its orientation so the toy's up matches the surface's up; `body` records which body it stands on.
- Dragging a placed toy (grab its base, or **carry** with `R` in avatar mode) slides it along the body's surface: the Aim ray is intersected with the body's SDF (sphere-traced), not with `y = 0`.
- Toy Forms are built in the toy's local frame, so the Spire, Orrery and Kettle work on a planet without changes. Two spots assume world-up and must use the toy's up instead: the Orrery's meridian line and the Kettle's pour plane.
- `World.freeSpot()` becomes `freeSpot(body)`: candidates on the body's surface (rings of points for a planetoid, a grid per face for a prism).
- Moving a gravity body moves the toys standing on it (they're parented to the body's group).

### 4.4 Making bodies

- A **"Worlds" shelf** at the end of the chest holds *Planetoid* and *Prism*. Drag one into the world (in Orbit or avatar mode) to place it floating where you aim, at least 2 m from other bodies.
- Bodies have a heart-like handle (a small ring) that opens a panel: size (stretch gesture), prism sides 3–8 and corner roundness (twist), colour, and *Put away* (only when no toys stand on it, or it offers to put them away too).
- Bodies are saved in WorldDoc `bodies` and shared in rooms ([MULTIPLAYER.md](MULTIPLAYER.md) §4.1).
- Limit: 8 bodies per world (draw-call budget on the Quest).

---

## 5. Aim: every creator action from one ray

### 5.1 The service

```ts
interface AimHit {
  kind: "part" | "surface" | "none";
  toy?: Toy; part?: string;
  body?: GravityBody;
  point?: Vec3; normal?: Vec3;
  distance: number;
  inReach: boolean;
}

class Aim {
  fromScreen(x: number, y: number): AimHit;   // Orbit: cursor; touch: tap point
  fromCrosshair(): AimHit;                    // avatar: screen centre
  current: AimHit;                            // updated each frame for previews
}
```

- Candidates: toy pickables (bounding-sphere prefilter, then the existing mesh raycast) and gravity bodies (sphere tracing their SDFs, which is cheap for ≤ 8 analytic bodies). The nearest hit wins; toy parts win ties so a toy on a surface is always targetable.
- **Reach**: unlimited in Orbit; 8 m in avatar mode (16 m while flying). Out-of-reach hits are still reported (for the preview) but actions ignore them.
- Input code stops calling `stage.pick` and `stage.planePoint` directly; it asks Aim. That's the refactor in V0, and it also gives the help system its "what is the player pointing at" signal.

### 5.2 Actions in avatar mode (Minecraft creative mapping)

| Action | Minecraft | Here |
|---|---|---|
| Use / play | right-click a block | **left-click**: poke the targeted part (playing is the main verb); on the heart, opens the Pulse panel |
| Manipulate a handle | — | **hold left** on a handle (cap, peg, planet, surface): mouse movement goes to that handle instead of the camera, through a **virtual cursor** that starts at the crosshair and accumulates `movementX/Y`, so existing `DragHandler`s work unchanged |
| Place | right-click | **right-click**: place the hotbar toy at the hit point, aligned to the surface; shows a ghost first (§6) |
| Pick block | middle-click | **middle-click** a toy: put its type (or its variant) in the current hotbar slot |
| Break | left-click | **Delete / Backspace** on the targeted toy: put it away to the chest (with undo). Kept off the mouse so a poke can never remove a toy |
| Move a block | — | **R**: carry the targeted toy (it floats in front of you, ghosted); `R` again or right-click drops it where you aim |
| Hotbar | wheel / 1–9 | **1–9** and **wheel** select hotbar slots; the hotbar fills from the chest (drag cards onto it) and from middle-click |
| Stretch / twist | — | `[` / `]` and `Shift+wheel` stretch; `Q` / `E` twist (as today) |

In **Orbit**, actions keep today's behaviour but go through Aim, so they gain surfaces and bodies: tap = poke, drag a base = grab along its surface, wheel over a toy = stretch.

---

## 6. Ray and target preview (`B`)

When on, each frame draws from `Aim.current`:

| Element | Look |
|---|---|
| **Ray** | a thin line from the avatar's hand light (offset right/down from the eye, so it's visible in first person) to the hit; from the cursor's near-plane point in Orbit (shown faint) |
| **Hit point** | a dot plus a ring lying on the surface (aligned to the normal) and a short normal tick |
| **Target outline** | the targeted toy part outlined in the toy's colour, drawn a second time without depth test at low opacity so it shows through other toys; a tiny glyph names the action (poke, drag, heart) |
| **Placement ghost** | the hotbar toy, translucent, at the hit point and orientation; **red** if it overlaps another toy's base, is out of reach, or the room is full |
| **Reach** | the ray turns dashed and red beyond reach |
| **Gravity** (debug sub-toggle, `Shift+B`) | the bound body's outline and an arrow for the current up |

- Colours follow the colour-blind-safe palette; red/green states also differ in dash pattern.
- The setting is remembered in `localStorage`. Kid profiles get a simpler version on by default: the hit dot and target outline only.
- In multiplayer, other players' aim dots are shown faintly in their colour (presence, [MULTIPLAYER.md](MULTIPLAYER.md) M4), so you can see where a friend is pointing.

---

## 7. Other inputs

| Input | Avatar mode |
|---|---|
| **Touch** | left half: virtual stick (appears where the thumb lands); right half: drag to look; **tap acts on what you tap** (Aim from the tap point, not the crosshair; a "crosshair mode" setting switches to Minecraft Bedrock's style); on-screen buttons: jump/fly, up/down (fly), place, hotbar strip, mode switch |
| **Gamepad** | left stick move, right stick look, `A` jump (double = fly), `B` down/sneak, `RT` poke / hold to drag, `LT` place, `RB`/`LB` hotbar, `X` carry, `Y` chest, `D-pad` audio ([AUDIO-MIX.md](AUDIO-MIX.md) §4.5), `View` mode switch |
| **XR** (XR phase) | the controller or hand ray *is* the Aim ray; locomotion is teleport + smooth with comfort vignette; gravity changes in VR use a short fade and **snap** to the new up instead of slerping, to avoid nausea |

---

## 8. Keyboard map (all plans together)

| Key | Orbit | Walk / Fly |
|---|---|---|
| `C` | enter avatar mode | back to Orbit |
| `W A S D` | — | move |
| `Space` | poke last toy (today) | jump; double-tap = Walk ↔ Fly; in Fly, up |
| `Shift` | soft poke modifier (today) | sneak; in Fly, down |
| double-tap `W` | — | sprint / boost |
| `V` | — | first ↔ third person |
| `B` / `Shift+B` | ray preview / gravity debug | same |
| `G` | — | bind gravity to the aimed surface |
| `R` | — | carry / drop the targeted toy |
| `Delete`, `Backspace` | put away the targeted toy | same |
| `1`–`9`, wheel | wheel = stretch over a toy, else zoom (today) | hotbar |
| `[` `]`, `Shift+wheel` | stretch | stretch |
| `Q` `E` | twist (today) | twist |
| `Tab` | chest (today) | chest (releases pointer lock) |
| `Esc` | close panel (today) | release pointer lock, then close panel |
| `I` | Toy Book details for the targeted toy ([TOY-BOOK.md](TOY-BOOK.md)) | same |
| `M`, `N`, `Shift+N`, `H`, `Shift+M`, `-`/`=`, `L` | audio ([AUDIO-MIX.md](AUDIO-MIX.md) §4.5) | same |
| `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+O`, `Ctrl+E` | save, save as, open, export ([SAVE-LOAD.md](SAVE-LOAD.md) §7) | same |
| `Ctrl+C` / `Ctrl+V`, `Ctrl+Shift+K` | copy / paste toy, keep as variant | same |

Deliberately unused: `Ctrl` as a sprint key (`Ctrl+W` closes the tab and can't be blocked outside fullscreen keyboard lock) and `F5` for perspective (reload). In fullscreen on Chromium, `navigator.keyboard.lock()` could free those keys later.

A cheat-sheet overlay (hold `?` or `F1`) shows the table for the current mode.

---

## 9. Listening from the avatar

- In avatar mode, **the listener is the avatar's head**: pans update as you turn (all toys, throttled to 20 Hz, from the avatar camera), and toys farther than ~6 m fade by distance (inverse-distance with a floor, so the whole jam stays audible). Distance attenuation multiplies into the local **monitor** gain ([AUDIO-MIX.md](AUDIO-MIX.md) §3), so it's per-listener and never shared.
- Orbit mode keeps today's behaviour (pan from the camera, no distance fade).
- A later step can move to per-toy HRTF panners (PLAN §4.5); this plan doesn't need it.

---

## 10. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **V0. Aim + preview** | `Aim` service; `input.ts` uses it; ray/hit/outline preview with `B` in Orbit; virtual cursor for drags | Everything works as today in Orbit; with `B` on, the hit point always matches what a tap will do |
| **V1. Avatar on the ground** | `AvatarRig`, kinematic controller, pointer lock, Walk/Fly, first/third person, HUD mode switch, hotbar, place / poke / pick / carry / put away, placement ghost | A Minecraft player builds a 6-toy jam in avatar mode without a tutorial |
| **V2. Gravity bodies** | Planetoid and prism, "Worlds" shelf, binding rules, toys on bodies (orientation, `body`), body panel, WorldDoc `bodies` | Walk around a planetoid and over every prism edge without falling off; toys placed on both play normally; save/load round-trips |
| **V3. Touch and gamepad** | Virtual stick, tap-to-act, on-screen buttons; gamepad map | Avatar mode playable on a phone and with a controller |
| **V4. Together** | Avatar poses, mode and aim dots in presence; interpolation; bodies in the room doc | Two players walk on the same planetoid and see each other's aim |
| **V5. XR** | Aim from controllers/hands, locomotion, comfort rules | Part of PLAN's XR phase |

V0 is independent and small; it's a good first task. V1–V2 come after multiplayer M2 so that toy ids, orientation and bodies go straight into the shared doc.

---

## 11. Testing

- **Gravity fields** (unit): `up(p)` has unit length and is continuous across prism edges and corners; a walker integrated around a planetoid stays at constant altitude; binding switches only under §4.2's rules.
- **Controller** (unit): no tunnelling through bodies at max fly speed; landing on edges; sneak never walks off.
- **Aim** (unit): parts beat surfaces at equal distance; reach respected; occluded parts reported as occluded.
- **Input** (Playwright): pointer lock can't be granted headless, so the avatar rig takes injected look deltas in tests; scripted place / poke / carry / remove sequences check world state.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Pointer lock quirks (Safari, embeds, iframes need `allow="pointer-lock"`) | Fall back to "drag to look" with a free cursor; the embed component requests the permission |
| Motion sickness on rebinding and around planetoids | Slerped up vector, optional frozen fly frame, snap + fade in XR, reduced motion turns slerps into cuts |
| Creator controls collide with play controls (a poke that removes a toy) | Removal is only on `Delete`/`Backspace`, with undo; placement shows a ghost first |
| Avatar mode feels empty with only 16 toys | Third person by default for the first session, small avatar scale so toys feel big, bodies to build on |
| Raycast cost with many parts each frame | Bounding-sphere prefilter; Aim updates at 30 Hz when the ray preview is off |
| Toys that assume world-up (Orrery meridian, Kettle pour plane) misbehave on planets | Audit in V2; toys use their own up via a `Toy.up` helper |

---

## 13. Decisions (Oct 2026)

The open questions are settled; the defaults below are what V0/V1 ship.

1. **Fly frame: live up from the last bound body** is the default. A toggle in the avatar settings (gear next to the mode switch, *"Keep my up while flying"*) freezes the frame at take-off instead. Both stay in the build so they can be playtested side by side; the setting is remembered per device.
2. **Avatar scale: child-sized by default** (1.2 m tall, eye at 1.1 m), with a **size slider** in the avatar settings that snaps to three set points, **S** (0.3×, "be tiny and walk on the Orrery's rings"), **M** (1×) and **L** (1.6×). Eye height, step height, walk speed, jump and reach all scale with size.
3. **Toy Forms are passable** ("toys are made of light"); the walker only steps up onto toy bases. A `solidToys` option makes Forms solid to the avatar (walk *around* a Spire) using each toy's bounding cylinder. It exists in code (`AvatarSettings.solidToys`) but has **no UI or key yet**.
4. **Gravity bodies can make sound**: a planetoid hum tied to its size, built with the same toy features (a Voice with a frequency derived from the body's size). It is implemented as data (`GravityBody.sound`, `bodyHum()`), but **inactive and not player-accessible** for now (`BODY_SOUND = false`).

## 14. Implementation status (Oct 2026)

| Step | State | Where |
|---|---|---|
| V0 | Done. `Aim` (pointer in Orbit, crosshair in avatar mode; parts win ties; reach), `B` preview (ray, hit dot + ring + normal tick, part outline through occluders, action label, dashed red out of reach), `Shift+B` up arrow, virtual cursor for handle drags | `src/aim.ts`, `src/render/aim-preview.ts`, `src/input.ts` |
| V1 | Done on the ground plane. Walk/Fly, double-tap Space, double-tap W boost, sneak (won't walk off the disc), step onto toy bases, fall-out respawn, first/third person (`V`, over-the-shoulder chase), pointer lock with "Click to look around" and a drag-to-look fallback when lock is refused, HUD mode switch + settings (size slider with S/M/L, fly frame, ray preview), hotbar (1–9, wheel, chest drop, middle-click pick), place with ghost, put away (`Delete`) with `Ctrl+Z`, carry (`R`), `[ ]` stretch, pans follow the avatar's head at 20 Hz | `src/avatar/`, `src/ui/hotbar.ts`, `src/ui/modes.ts`, `src/render/ghost.ts` |
| V2 | Interfaces only: `GravityBody` with `sdf`/`up`/`raycast`/`covers`, the ground as a plane body, `G` rebinding, `bodyHum()` (inactive) | `src/avatar/gravity.ts` |
| V4 | Avatar pose, mode, size and aim dot in presence, interpolated, with name tags; bodies in the room doc wait for V2 | `src/net/presence.ts` |

Not done yet: distance attenuation per listener (needs the engine's `Monitor` param from [AUDIO-MIX.md](AUDIO-MIX.md)), the `?`/`F1` cheat sheet, Toy Book `I`, touch/gamepad (V3), kid-profile preview defaults.
