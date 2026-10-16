# Tutorial and help system plan

> One help system for mouse, touch, Quest controllers and hands. It **anchors** small views to the
> toy parts and controls they explain, teaches by gesture rather than text, and stays out of the way of play.

Status: plan · Oct 2026 · builds on [PLAN.md](PLAN.md) §1 (pillars) and §3 (interaction)

---

## 1. Goals

1. **Teach at the point of use.** A hint sits on the thing it explains (the Spire's cap, a heart, the chest), not in a manual. The [guide page](../apps/playground/guide.html) covers getting *in*; this system covers everything after.
2. **No text needed** (pillar 7). Every hint leads with an animated gesture glyph. Words are a caption that young kids can ignore.
3. **One description, every device.** A hint says *what* to do ("stretch the cap"). The renderer decides *how* to show it for the current input: a drag glyph for a mouse, a pinch for touch, a trigger-drag for a controller, a pinch-drag for hands.
4. **Never block play.** Hints are non-modal by default: the world keeps running and stays clickable. A blocking modal is only allowed for consent or safety (e.g. a volume warning).
5. **Help comes from the toy's own declarations.** Toys already declare their params, gestures and handle parts; most hints should be generated from that, so a community toy gets help for free (the dogfooding rule, PLAN §4.7).

## 2. What exists to build on

| Today | Where | Use for help |
|---|---|---|
| Named, pickable **parts** on every toy (`base`, `heart`, `cap`, `peg`, `string`, `node:n`, `sun`, `planet:i`, `surface`, `rim`) | `toys/*.ts` via `Toy.add(obj, part)` | Anchor targets |
| **Declared gestures** on params (`stretch`, `twist`, `touch-node`) | `ParamDef.gesture` | Auto-generated hints |
| The **intent layer** (poke, grab, stretch, twist; tap vs drag; two-finger) | `input.ts` | Detecting that a lesson step was done, and which modality is in use |
| DOM controls: HUD, chest, Pulse editor | `ui/*.ts` | DOM anchor targets |
| Engine **snapshot** (env, flash, pulse step) | `audio/protocol.ts` | "It made a sound" and "the Pulse is playing" checks |
| Device detection and caveats | `src/guide/guide.ts` | Shared `detectDevice()` for the first-run lesson |

**Missing (prerequisite):** a typed **event bus**. Input, toys, UI and the engine need to emit events (`toy:poke`, `param:change`, `pulse:enable`, `chest:open`, `toy:add`, `toy:remove`, `audio:ready`). Lessons listen to these, and they double as the success metrics in PLAN §10 (time to first sound, share of sessions where a Pulse gets set).

## 3. Concepts

```
Anchor   where a hint attaches: a toy part, a whole toy, a DOM control, or a screen edge
Card     what is shown: glyph + optional caption + optional actions, in one of four forms
Hint     Card + Anchor + when to show it + when it's done
Lesson   an ordered set of Hints with completion conditions (the tutorial)
Layer    the renderer: DOM overlay on flat screens, world-space panels in XR
```

### 3.1 Anchors

```ts
type Anchor =
  | { kind: "part"; toy: ToyRef; part: string }        // e.g. the Spire's "cap"
  | { kind: "toy"; toy: ToyRef }                        // whole toy, attached above it
  | { kind: "dom"; el: string }                         // "#chest .toy-card[data-kind=3]", "#hud .hud-scale"
  | { kind: "screen"; edge: "top" | "bottom" | "left" | "right" | "center" };

type ToyRef = Toy | { kind: KindId } | "nearest" | "last-touched";
```

Each frame, the layer **resolves** an anchor into a placement:

- **part / toy:** the part's world-space bounding sphere (from the existing pick meshes) is projected to the screen. Then three questions: is it on screen; is it **occluded** (raycast camera → part against the other toys' pickables); and how big is it on screen. In XR it resolves to a world pose instead.
- **dom:** `getBoundingClientRect()`, re-read on resize and on the chest/Pulse transitions.
- **Off-screen or occluded** targets get an **edge pointer**: a small arrow at the screen edge pointing toward the target. On flat screens it also offers to "look there", nudging the orbit camera.

`ToyRef` lets a lesson say "the nearest Spire" without holding a specific instance, so it survives toys being added, removed or re-slotted.

### 3.2 Card forms

| Form | Looks like | Use |
|---|---|---|
| **Pulse dot** | A softly breathing ring on the part, no text | "Something to try here." Lowest weight; the default for discovery |
| **Coach mark** | Gesture glyph looping on the part, plus a one-line caption with a leader line | A lesson step: "drag the cap up" |
| **Tip card** | Small anchored panel: glyph, caption, optional "show me" / "got it" | Explaining a law ("half the string = an octave up"), or a control |
| **Sheet** | Larger panel docked to the screen edge (in XR, a wrist panel) | The help index, lesson list, settings. The only form allowed to take focus |

At most **one coach mark or tip card** is visible at a time. Pulse dots can stack, up to three.

### 3.3 Gesture glyphs

A small library of looping animations, one per intent × modality:

| Intent | Mouse | Touch | Controller | Hands | Keyboard |
|---|---|---|---|---|---|
| poke | click | tap | trigger | pinch | Space |
| stretch (handle) | drag | drag | trigger-drag | pinch-drag | — |
| stretch (free) | wheel | pinch | thumbstick ↕ | two-hand pull | — |
| twist | alt-drag | two-finger rotate | wrist roll / grip+stick | wrist roll | Q / E |
| grab | drag base | drag base | grip | grab | — |
| open chest | click chest | tap chest | Y / look down | palm up | Tab |

Glyphs are SVG with CSS animation (no runtime dependency). For XR they're rasterised to sprite-sheet textures once. With reduced motion, each glyph becomes a static frame with an arrow.

**Current modality** is tracked live: the last `PointerEvent.pointerType`, a `keydown`, or the active XR input source's profile and hand. Visible cards swap glyphs immediately, so if a mouse user starts touching, the hint becomes a pinch.

## 4. Hints generated from declarations

Extend the toy declarations a little, and most hints write themselves:

```ts
// toys/toy.ts (additive)
interface ParamDef {
  // ...existing fields
  handle?: string;              // part that drags this param, e.g. "cap"
  help?: { caption?: string; law?: string };
}

abstract class Toy {
  // ...existing fields
  readonly help?: {
    poke?: string;              // part to poke first, e.g. "string"
    law: string;                // one-sentence first principle
    discover?: string[];        // "try" prompts, unlocked after basic use
  };
}
```

From those declarations the system derives, for any toy:

1. **Poke it:** coach mark on `help.poke` (or the toy) with the poke glyph.
2. **One hint per param that has a gesture:** coach mark on `handle` (if present) with the handle-drag glyph; otherwise anchored to the toy with the free stretch or twist glyph. The caption comes from `help.caption`, or else "Stretch to change {param}".
3. **The heart:** "Make it play by itself" (shared by every toy).
4. **The law:** a tip card unlocked once the param has been changed a few times, e.g. "The Spire follows f = (1/2L)√(T/μ): half the length, an octave up."

Example for the existing Spire: `length` gains `handle: "cap"`, `tension` gains `handle: "peg"`, and `harmonic` gains `handle: "node:*"` (a wildcard anchors to the beads' group). That's three lines of new declaration, and it gives full help for the toy.

Community toys built on the SDK (Phase 3) get the same treatment. The Toy Forge previews the generated hints, and `hypertoy test` warns when a gesture param has no handle or caption.

## 5. When hints appear

### 5.1 First-run lesson ("Wake the cosmos")

| Step | Anchor | Done when |
|---|---|---|
| 1. Make a sound | The Spire's `string` | `toy:poke` and `audio:ready` |
| 2. Change it | The Spire's `cap` | `param:change` on `length` (any amount) |
| 3. Let it play | The Spire's `heart` → then the play button in the Pulse editor | `pulse:enable` |
| 4. Listen to the orbits | Orrery `planet:*` | One planet dragged to a new radius |
| 5. Open the chest | DOM: the chest handle or drawer | `toy:add` |

Rules: each step waits for the previous one, but **doing a later step early completes it** (skipping ahead is always fine). Two seconds of idle before a step's coach mark appears, so players who are already exploring never see it. The lesson can be dismissed at any time from a small "×" pill, and resumed from the help sheet.

### 5.2 Contextual nudges (after the lesson)

| Trigger | Hint |
|---|---|
| A toy is placed for the first time | Pulse dot on its `help.poke` part, then auto-generated hints on hover/focus |
| A pointer down on a handle with no drag, 3 times | Coach mark with that handle's drag glyph ("drag, don't tap") |
| 20 s with no input and no Pulse running anywhere | Pulse dot on the nearest heart |
| First time the Pulse editor opens | Tip card on the ring: tap = on/off, hold = sometimes |
| First wild-mode toggle | Tip card on the HUD wild button explaining microtonal play |
| Quest: aiming at a part too small to hit, 3 misses | Tip: "Move closer, or use a controller for small handles" |

Every nudge shows **at most once per device**, unless it's reset from the help sheet.

### 5.3 Help on demand

- **The `?` button** (HUD) opens the **help sheet**: lessons (replay), "show all labels", per-toy law cards, controls for the current modality, and "reset hints".
- **X-ray / show all labels:** hold `H`, press the `?` long, or in XR, turn the left palm up and pinch. This shows a pulse dot plus a short caption on **every** interactive part in view at once. It's the fastest way to learn a new toy, and it's driven entirely by the declarations.
- **Hover or focus help** (flat screens): resting the pointer on a part for 600 ms shows its auto-generated tip card. Keyboard: `Tab` moves focus through toys and parts (see §7), and the focused part shows its card.

## 6. Rendering per platform

### 6.1 Flat screens (desktop, mobile)

- A single `#help-layer` DOM overlay above the canvas. `pointer-events: none` by default; cards turn it on for themselves only. The world stays fully interactive underneath.
- Placement: a preferred side, then flip, then shift (Floating UI-style), plus **collision avoidance** with the HUD, the chest, the open Pulse editor and other cards. The leader line runs from the card to the projected anchor.
- Movement is smoothed (a critically damped spring on screen position) so cards don't jitter as the camera orbits or planets move. Cards anchored to a moving part, like a planet, follow the **orbit ring** rather than the planet itself.
- While the anchored toy is being dragged, its cards fade out and come back when it's dropped.
- On phones the caption goes into a bottom **toast** above the chest, with only the glyph staying on the anchor. This keeps small screens uncluttered and leaves thumbs clear.

### 6.2 Quest 3: flat window (today)

Same DOM layer. Larger hit targets and text (detect `OculusBrowser`), controller/hand glyphs, and no hover cards (a ray hover is too twitchy to rely on).

### 6.3 Quest 3: immersive VR / MR (Phase 1)

- Cards become **world-space panels**: a canvas-texture quad (or three-mesh-ui) placed beside the part, billboarded **on the yaw axis only**, scaled to keep a constant angular size within limits, and never closer than 0.5 m to the eyes.
- **Never head-locked.** Hints that aren't anchored to anything sit on a lazy-follow panel that drifts back into view after 2 s outside a 30° cone.
- The help sheet lives on a **wrist panel** (palm-up menu, PLAN §3.1). In MR, cards respect the real-world occlusion mesh where it's available.
- Gaze or ray **dwell** (800 ms) opens a pulse dot's tip card, so hands-only players never need to click on help.
- Edge pointers become a **peripheral chevron** at the edge of the field of view, plus a soft spatial audio "ping" from the target's direction. Help can use sound too: the target toy plays a quiet preview note.

## 7. Accessibility

- An `aria-live="polite"` region mirrors each card's caption, so screen readers hear lesson steps.
- **Keyboard traversal:** `Tab` cycles toys, then `]`/`[` cycle that toy's parts. The focused part gets a visible focus ring drawn in 3D (an outline pass), and Enter/Space pokes it. This also makes every toy playable without a pointer, which is a goal of its own.
- Reduced motion → static glyphs, no breathing pulse dots, no camera nudges.
- Captions meet WCAG AA contrast against the card, follow a text-size setting (S/M/L), and have **no time limits** that require the player to read quickly.
- **Kid mode:** captions hidden, glyphs and audio pings only. A parent can still open the help sheet (long-press `?`).
- All strings go through one table (`help/strings.ts`) for future i18n. Glyphs carry the meaning; strings are secondary.

## 8. Persistence and multiplayer

- Progress (lessons completed, nudges seen, dismissed) is stored in `localStorage` under a versioned key, wrapped in try/catch so a private window simply sees hints again. It moves to the player profile when accounts arrive (Cosmic Cloud).
- In multiplayer (Phase 2), help is **local to each player** and never synced. Two additions come later: a host can **"show"** a part to everyone (a temporary pulse dot on all clients, sent as a CRDT ephemeral message), and spectators get an "explain" overlay mode for streams.

## 9. Architecture

```
src/events.ts        typed event bus (emit/on); input, toys, UI, engine emit into it
src/help/
  anchors.ts         Anchor types, resolve() → placement | pose | offscreen
  modality.ts        current input modality; emits "modality:change"
  glyphs.ts          SVG glyph library keyed by (intent, modality)
  derive.ts          declarations → Hint[] for a toy (§4)
  lessons.ts         lesson definitions + a small state machine (§5.1)
  nudges.ts          contextual triggers (§5.2)
  store.ts           persistence (§8)
  layer-dom.ts       flat-screen renderer (§6.1, §6.2)
  layer-xr.ts        world-space renderer (Phase 1, §6.3)
  sheet.ts           help sheet + x-ray mode (§5.3)
```

```ts
// The whole public surface toys and UI need.
help.show(hint: Hint): HintHandle;          // returns .dismiss()
help.lesson(id: string): void;               // start or resume
help.xray(on: boolean): void;
help.register(toy: Toy): void;               // derive hints from declarations
events.emit({ type: "param:change", toy, param, value });
```

The layer is updated once per frame from the existing `setAnimationLoop` in `main.ts`, after `world.update()`, so anchors read final positions. Budget: under 0.3 ms per frame with 10 cards. Projection is cheap; occlusion raycasts run at 10 Hz, not every frame.

## 10. Phasing

| Phase | Fits with | Scope |
|---|---|---|
| **H0** | End of roadmap Phase 0 | Event bus; part/toy/DOM anchors; DOM layer; glyphs for mouse and touch; the "Wake the cosmos" lesson; the declaration extensions on the 3 toys; persistence |
| **H1** | Roadmap Phase 1 (XR) | Controller and hand glyphs; XR layer (world panels, wrist sheet, dwell, peripheral chevrons); x-ray mode; keyboard traversal |
| **H2** | Roadmap Phase 2 (Together) | Host "show" pings; spectator explain overlay; per-room lesson for shared jams |
| **H3** | Roadmap Phase 3 (Creators) | `help` in the public SDK; Forge preview of generated hints; `hypertoy test` lint for missing handles/captions; docs-as-toys reuse the same cards |

## 11. Testing

- **Unit:** anchor resolution (projection, off-screen, occlusion) against a fixed camera; hint derivation snapshots per toy; the lesson state machine, including steps done out of order.
- **E2E (Playwright):** run the first-run lesson in desktop, mobile (touch emulation) and tablet viewports. Check that each card appears, never overlaps the HUD or chest, and completes when the real gesture is done.
- **Playtests** (PLAN §9 says "playtest with kids every sprint"): watch for whether players **read** captions. The goal is that they don't need to.
- **Metrics** (from the event bus): time to first sound, lesson completion and drop-off per step, the share of players who set a Pulse, the share of hints dismissed without the action being done (this signals a confusing hint).

## 12. Open questions

1. Should the first-run lesson run **automatically**, or wait for the first idle moment? The current proposal is automatic, but each step only after 2 s of idle.
2. XR card rendering: **three-mesh-ui** (an MIT dependency with good text) vs our own canvas textures (no dependency, more work). Decide in the Phase 1 bake-off alongside three.js vs Needle.
3. Should hints use **sound** on flat screens too (a soft cue from the target toy), or only in XR, where looking around is harder?
4. How far should **kid mode** go: icons only, or also simplified toys (fewer params exposed)?
