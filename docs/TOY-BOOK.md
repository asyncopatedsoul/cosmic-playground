# Toy Book plan: gallery, large view and details for every toy

> A **Toy Book** that shows every hypertoy, the ones you can play today and the ones still in the plan,
> in a large modal that can go fullscreen. Each toy has a **short description** (one line, shown
> everywhere) and a **details view**: a live preview you can poke, the law it follows, how to play it,
> and its variants.

Status: plan · Oct 2026 · builds on [PLAN.md](PLAN.md) §2.2 (catalog), [HELP-SYSTEM.md](HELP-SYSTEM.md) (glyphs, tip cards) and [SAVE-LOAD.md](SAVE-LOAD.md) §6 (variants)

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| Where | A modal **sheet** over the world (the world keeps playing), with an expand button to true **fullscreen** (Fullscreen API; full-viewport overlay where element fullscreen isn't available, e.g. iPhone Safari). |
| Two views | **Gallery** (grid of every toy, with filters *Playable / Coming / Mine*) and **Details** (one toy, large). |
| Grouping | Three ways to group and filter the gallery, each a field on every toy: **Family** (PLAN's six Principle families, the default and the chest's grouping), **Type** (what it's like to play: organs, bells, strings…) and **Pack** (who made it: *Built in / [brand]*, *Community / [creator]*). §3.1 |
| Content source | An `about` block on every toy entry and `ToyConfig` (`blurb`, `summary`, `law`, `play`, `sound`, `looks`, `tryThis`, `status`, `credits`). Planned toys come from a `PLANNED` catalog that mirrors PLAN §2.2; a check keeps the two in sync. |
| Live preview | A second, lazily-created renderer draws the toy alone on a turntable. Its sound plays through a reserved **audition slot** in the engine, with the world ducked (focus, [AUDIO-MIX.md](AUDIO-MIX.md)). Local only, never saved or synced. |
| Planned toys | Shown with their icon animated, a "coming in Phase N" badge, the law and the idea. No fake preview. |

---

## 1. Goals

1. **See everything at once.** All 7 playable toys and the 11 planned ones, so players (and contributors) see where the playground is going.
2. **One line to know what a toy is.** The short description is used in the chest tooltip, the gallery card, help tip cards, and the multiplayer "X placed a Y" toast.
3. **Learn the law by playing.** The details view's preview responds to the same gestures as the world; the law panel explains what you just heard.
4. **Big and calm.** Fullscreen is good for classrooms on a projector and for the Quest's flat browser window.
5. **No text needed to enjoy it** (pillar 7): previews and animated icons carry the gallery; text is for those who want it.

---

## 2. What exists to build on

| Today | Where | Use |
|---|---|---|
| `ToyEntry` (`id`, `name`, `family`, `color`, inline SVG `icon`, `config`, `create`) | `toys/registry.ts` | Add `about` and `status` |
| `ToyConfig` JSON for data toys | `audio/config.ts`, `toys/configs/*.json` | Add an optional `about` block, so community toys bring their own descriptions |
| Toy classes need a `World` (to send audio commands to a slot) | `toys/toy.ts` | The preview uses a small `PreviewWorld` facade (§5) |
| Declared gestures on params (`stretch`, `twist`, `touch-node`) | `ParamDef.gesture` | The "How to play" list is generated, per device |
| Gesture glyph library (planned) | [HELP-SYSTEM.md](HELP-SYSTEM.md) §3.3 | Reused in "How to play" |
| Help `<aside id="help">` | `index.html` | Its "toys" section links into the Toy Book |

---

## 3. Content model

```ts
interface ToyAbout {
  /** ≤ 80 characters, no jargon. Used everywhere. */
  blurb: string;
  /** 2–4 sentences: what it is and why it's alien but lawful. */
  summary: string;
  law: { name: string; formula?: string; plain: string };
  /** Generated from gestures when omitted; written by hand for special parts. */
  play?: { part: string; gesture: string; does: string }[];
  sound: string;
  looks: string;
  /** Little experiments: "Halve the string. What happened?" */
  tryThis: string[];
  status: "playable" | "planned" | "community";
  /** For planned toys: the PLAN phase it's expected in. */
  phase?: string;
  credits?: { author: string; license: string; link?: string };
}
```

- Built-in toys: `about` in `toys/about.ts`, keyed by id (keeps `registry.ts` readable).
- Data toys: `about` inside the JSON config (`"about": { … }`), so a toy shipped as one file describes itself.
- Planned toys: `toys/planned.ts` exports `PLANNED: { id, name, family, color, icon, about }[]` with `status: "planned"`.
- **Sync check:** `npm test` runs a small script that reads the PLAN §2.2 table and fails if a toy name there has no entry in `about.ts`, `configs/*.json` or `planned.ts` (and vice versa). Docs and the game can't drift apart.
- Text is stored in plain strings for now. When localisation arrives, `about` fields become message keys.

### 3.1 Family, type and pack

Every toy (built-in entry, data config, planned entry) carries three grouping fields. They live on `ToyEntry` and in `ToyConfig`, not in `about`, because the chest uses them too.

```ts
type Family = "vibration" | "orbit" | "wave" | "growth" | "reaction" | "topology";
interface ToyGrouping {
  family: Family;              // PLAN §1.1's six Principle families; the chest groups by this
  type: ToyType;               // what it's like to play, e.g. "organ"; free to grow (list below)
  pack: { id: string; channel: "builtin" | "community" | "local"; creator: string };
}
```

**Family** is the law the toy follows. The labels the data toys introduced (Plate, Resonance, Oscillator, Recipe) and the planned Rhythm map back to the six; the old words survive as *types* or in the `law` text, never as families:

| Family | What unites it | Toys |
|---|---|---|
| **Vibration** | Things that ring: strings, plates and air cavities with natural modes | Monochord Spire, Chladni Drum, Singing Bowl *(was Plate)*, Bottle Organ *(was Resonance)*, Bubble Organ *(was Resonance)* |
| **Orbit** | Periodic motion: a period law turns size into tempo | Kepler Orrery, Pendulum Clock *(was Oscillator)*, Pendulum Wave *(was Oscillator)*, Euclid Wheel *(was Rhythm; beats spread round a cycle)* |
| **Wave** | How waves combine, travel and split | Lissajous Loom, Fourier Serpent, Doppler Comet, Prism of Partials, Spark Box *(was Recipe; a waveform + envelope recipe)* |
| **Growth** | Simple rules that grow structure | Crystal Seeder, Murmuration Choir |
| **Reaction** | Chemistry-like transformation | Reaction Kettle |
| **Topology** | Shape and dimension | Tesseract Bell |

- Config JSON accepts the old labels as **aliases** (`Plate`, `Resonance` → vibration; `Oscillator`, `Rhythm` → orbit; `Recipe` → wave), lower-cases on load and warns, so community configs written against the old labels keep loading. An unknown family shows under **Other** with a warning in the Forge and dev log.
- Family display names and colours come from one table (`toys/families.ts`), shared by the chest, the Toy Book and the help sheet.

**Type** is the everyday-object grouping PLAN deliberately keeps *out* of the chest ("not by instrument type"), offered in the Toy Book as a second lens. It's how Bottle Organ and Bubble Organ sit together while staying two toys (§4.2). Starter vocabulary (singular id, plural label):

| Type | Toys |
|---|---|
| `organ` (Organs) | Bottle Organ, Bubble Organ |
| `string` (Strings) | Monochord Spire |
| `bell` (Bells and bowls) | Singing Bowl, Tesseract Bell |
| `drum` (Drums) | Chladni Drum |
| `clock` (Clocks) | Kepler Orrery, Pendulum Clock, Pendulum Wave |
| `wheel` (Wheels) | Euclid Wheel |
| `box` (Boxes) | Spark Box |
| `loom` (Looms: you draw, it plays) | Lissajous Loom, Fourier Serpent |
| `garden` (Gardens: it grows by itself) | Reaction Kettle, Crystal Seeder, Murmuration Choir |
| `lens` (Lenses: they change other toys) | Prism of Partials |
| `flyer` (Flyers) | Doppler Comet |

A config may name a new type; it gets a generic glyph and its id as the label until the table adopts it.

**Pack** is who made it and where it came from, shown as *channel / creator*:

| Channel | Label | Source | Today |
|---|---|---|---|
| `builtin` | **Built in / [brand]** | Ships with the app; `creator` is the build's brand name (`BRAND_NAME` build variable, [DEV-MODE.md](DEV-MODE.md) §5.5) | All 7 playable + 11 planned toys, pack id `core` |
| `community` | **Community / [creator name]** | A shared registry with the Verified shelf rules (PLAN §5.5) | **Placeholder only**: one "Community packs: coming soon" card with a "Make a toy" link to the Forge; no network calls |
| `local` | **Mine** | Forge toys, imported config files, variants | Forge toys and variants already on this device |

- Built-in configs get `"pack": { "id": "core", "channel": "builtin" }`; the creator is filled in from the build variable, not written in JSON, so a rebrand is one setting.
- A config without `pack` is `local` with `creator: author ?? "You"`.
- The community shelf is built against a `PackSource` interface (`list(): Promise<PackSummary[]>`) with a single `PlaceholderPackSource` today, so the registry plugs in later without touching the gallery.

---

## 4. Short descriptions (draft content)

### 4.1 Playable now

| Toy | Family | Type | Short description | Law (for the details view) |
|---|---|---|---|---|
| **Monochord Spire** | Vibration | string | A glowing string you stretch, twist and pluck; touch a bead for a harmonic. | f = (1/2L)·√(T/μ); harmonics at L/n |
| **Kepler Orrery** | Orbit | clock | Fling planets around a sun; each one chimes as it crosses the line. | T ∝ r^1.5; orbit ratios become polyrhythms |
| **Reaction Kettle** | Reaction | garden | Pour two reagents and watch living patterns bubble and sing. | Gray-Scott reaction-diffusion; Minnaert bubbles f·r ≈ 3.26 m/s |
| **Singing Bowl** | Vibration | bell | A bowl that rings like a bell; a wider rim sings lower. | Plate modes: f ∝ thickness / radius² |
| **Bottle Organ** | Vibration | organ | Fill the bottle and blow across it: more water, higher note. | Helmholtz: f = (c/2π)·√(A / (V·L)) |
| **Spark Box** | Wave | box | A box of zaps, blips and chirps you can roll, mutate and share. | A ZzFX-style sound recipe; pitch is a plain frequency |
| **Pendulum Clock** | Orbit | clock | A pendulum that ticks a melody; longer swings tick slower and lower. | T = 2π·√(L/g) |

All seven are pack **Built in / [brand]**.

### 4.2 Planned (from PLAN §2.2)

| Toy | Family | Type | Short description | Law | Phase |
|---|---|---|---|---|---|
| **Chladni Drum** | Vibration | drum | Strike a plate and watch sand dance into the shape of its sound. | Plate vibration modes, nodal lines | 2 |
| **Pendulum Wave** | Orbit | clock | A row of pendulums that drift in and out of step, playing a slow arpeggio. | Coupled oscillators; phase drift | 2 |
| **Lissajous Loom** | Wave | loom | Two dials weave a glowing figure; simple ratios make steady shapes and sweet chords. | Superposition of two frequencies | 2 |
| **Euclid Wheel** | Orbit | wheel | Spin two rings to spread beats evenly and make rhythms from all over the world. | Euclidean rhythms (Bjorklund) | 2 |
| **Fourier Serpent** | Wave | loom | Draw any shape; spinning circles redraw it and turn it into a voice. | Fourier series and epicycles | 3 |
| **Crystal Seeder** | Growth | garden | Plant a seed and grow a crystal; every new branch plays a note. | Lattices and L-systems | 3 |
| **Bubble Organ** | Vibration | organ | Blow bubbles of different sizes; each rings once, then pops. | Helmholtz resonance: f ∝ 1/√V | 3 |
| **Doppler Comet** | Wave | flyer | Throw a comet past your ears and hear its pitch swoop. | Doppler shift: f′ = f·c/(c − v) | 2 (best in XR) |
| **Tesseract Bell** | Topology | bell | Turn a bell through the fourth dimension; its shadow and its chord change together. | 4D rotation and projection | 3 |
| **Murmuration Choir** | Growth | garden | Sprinkle a flock of birds; where they crowd, the choir swells. | Flocking (boids) | 3 |
| **Prism of Partials** | Wave | lens | Shine any toy's sound through the prism to split it into rainbow beams. | Spectral decomposition (FFT) | 3 |

Phases refer to the reprioritised roadmap in [PLAN.md](PLAN.md) §8.

**Bubble Organ and Bottle Organ stay two toys.** They share a law (Helmholtz) and the `organ` type, but play differently: the Bottle Organ is one held, tunable cavity you fill and blow; the Bubble Organ is many short-lived cavities you make and lose, each ringing once. The *Organs* type groups them side by side in the gallery, and each one's details view links the other ("Same law, different toy").

---

## 5. Live preview and the audition slot

- **Renderer.** A second `WebGLRenderer` on the modal's canvas, created on open and disposed (with `forceContextLoss`) on close. Small scene: the toy on its base, a soft rim light, slow turntable (paused under reduced motion), orbit by drag. Bloom off on phones, as on the stage.
- **PreviewWorld.** A facade implementing what `Toy` uses from `World` (`audio`, `stage`-like camera for pan, `fields` for the Kettle), so the same toy classes render in the preview with no special cases.
- **Audition slot.** The engine grows one extra slot, index `MAX_TOYS` (16), excluded from snapshots sent to the net, from saves and from `World.toys`. The preview toy lives there. On open, the world is **focused away** ([AUDIO-MIX.md](AUDIO-MIX.md) §3: everything else ducks); on close, the slot is cleared and the mix restored. In a room, the audition is heard only by you.
- **Interaction in the preview** reuses the intent layer: poke, stretch, twist, the heart (Pulse editor opens inside the modal).
- **Thumbnails.** Gallery cards for playable toys use a still rendered once by the preview renderer, cached in IndexedDB keyed by toy id + build; until then, the SVG icon.
- **Budget.** Only one preview at a time. On the Quest's flat browser, the preview renders at half resolution.

---

## 6. Layout

### 6.1 Gallery

```
┌──────────────────────────────────────────────────────────────────┐
│ Toy Book    Group: (Family) Type  Pack   [Playable] [Coming] [Mine]  ⤢  ✕ │
├──────────────────────────────────────────────────────────────────┤
│ Vibration                                                        │
│ [Spire ▶]  [Bowl ▶]  [Bottle ▶]  [Chladni ◌]  [Bubble ◌]         │
│ Orbit                                                            │
│ [Orrery ▶]  [Clock ▶]  …                                         │
│ …                                                                │
│ Community / …   [ Community packs: coming soon ]   (Pack view)   │
└──────────────────────────────────────────────────────────────────┘
 card: thumbnail or animated icon · name · blurb · status badge (▶ playable, ◌ coming, ★ variant count) · family glyph
```

- **Group by** is a three-way toggle: **Family** (default; the six families as rows, in PLAN order), **Type** (Organs, Strings, Bells…, rows sorted by toy count) or **Pack** (*Built in / [brand]* first, then *Mine*, then *Community / [creator]* rows; today only the placeholder card).
- Status chips (*Playable*, *Coming*, *Mine*) filter within any grouping, and a family/type/pack row heading is itself a filter: clicking it shows only that row. The chosen grouping and filters are remembered per device (`prefs.ts`) and in the URL (`?book=type:organ`).
- Each card shows a small family glyph so the family is visible in Type and Pack views.
- Cards are buttons; arrow keys move between them; `Enter` opens details.
- Dragging a playable card out of the Toy Book onto the world places the toy, just like the chest.

### 6.2 Details

```
┌──────────────────────────────────────────────────────────────────┐
│ ‹ Gallery   Monochord Spire · Vibration · Strings · Built in  ‹ › ⤢ ✕ │
├──────────────────────────────┬───────────────────────────────────┤
│                              │ A glowing string you stretch,     │
│        live preview          │ twist and pluck…                  │
│      (poke it, orbit it)     │                                   │
│                              │ The law   f = (1/2L)·√(T/μ)       │
│                              │   Half the string, twice the pitch │
│                              │ How to play  [glyph] stretch cap   │
│                              │              [glyph] turn peg      │
│                              │ Sound · Looks                      │
│                              │ Try this  ☐ halve it  ☐ harmonic 3 │
│                              │ Variants  [★ Third-harmonic] [+]   │
│ [ Place in world ]           │ Credits / license                  │
└──────────────────────────────┴───────────────────────────────────┘
```

- On narrow (portrait) screens the preview sits on top and the text scrolls below it.
- The family, type and pack in the title bar are links: each opens the gallery grouped and filtered by it.
- **Planned toys:** the preview area shows the animated icon over a slow starfield, the phase badge, and "Want to help build it?" linking to the contributing guide.
- **Try this** items tick themselves when the event bus ([HELP-SYSTEM.md](HELP-SYSTEM.md) §2) sees the matching param change; they double as gentle lessons.

---

## 7. Opening it

| From | How |
|---|---|
| HUD | A book glyph button |
| Chest | Long-press a card → "About" (alongside the variant fan, [SAVE-LOAD.md](SAVE-LOAD.md) §6.3); a book glyph at the end of the drawer opens the gallery |
| A toy in the world | Toy panel → ⓘ; or keyboard `I` on the targeted / last-touched toy |
| Help | The help sheet's "Toys" section |
| URL | `?toy=spire` opens its details (handy in docs and the guide page) |

Keys inside the Toy Book: `←`/`→` previous/next toy, `F` fullscreen on/off, `Esc` back to gallery, then close. Esc first leaves fullscreen when the browser is in fullscreen (browser behaviour), then closes.

In avatar mode ([AVATAR.md](AVATAR.md)), opening the Toy Book releases pointer lock; closing it offers to re-lock with one click (browsers require a gesture).

---

## 8. Phasing

| Step | Scope | Exit check |
|---|---|---|
| **B1. Content** | `ToyAbout`, `about.ts`, `planned.ts`, `about` in the 4 config JSONs, PLAN sync check; blurbs used in chest tooltips. Grouping fields (§3.1): `families.ts`, `type` and `pack` on every entry, family aliases for old config labels, chest grouped by the six families | The sync check fails if a PLAN toy is missing; every toy has a family among the six, a type and a pack |
| **B2. Gallery + static details** | Modal, fullscreen, gallery grid with Group by Family / Type / Pack and status filters, community placeholder card, details with icon (no live preview), keyboard and screen-reader navigation | All 18 toys reachable by keyboard in each grouping; fullscreen works on desktop, Android and the Quest browser; iPhone uses the overlay |
| **B3. Live preview** | Preview renderer, `PreviewWorld`, audition slot (engine `MAX_TOYS + 1` internal slots), focus ducking | Poking the preview Spire sounds while the world ducks; closing restores the mix; 60 fps on a mid phone |
| **B4. Try this + variants** | Event-driven checklist, variants list with rename/delete/export | A tester completes a "Try this" by playing, without reading instructions twice |

B1 and B2 are independent of everything else. B3 needs [AUDIO-MIX.md](AUDIO-MIX.md) A1 (monitor gain for ducking). B4 needs [SAVE-LOAD.md](SAVE-LOAD.md) S4.

---

## 9. Testing

- Sync check (B1) in `npm test`.
- Screenshot test of the gallery and one details view (Playwright) on desktop and a phone viewport.
- Audition slot: an engine test that the slot's audio never appears in `bus` taps of world toys unless explicitly coupled, and is absent from WorldDoc output.

---

## 10. Decisions (formerly open questions, resolved Oct 2026)

1. **Families.** Map back to PLAN's six; never widen. Plate and Resonance → Vibration, Oscillator and Rhythm → Orbit, Recipe → Wave (§3.1). Families are a grouping and filter option in the gallery, and the chest's only grouping.
2. **Bubble Organ vs Bottle Organ.** Keep both. A **toy type** field (`organ`, `bell`, `string`…) groups them, as a second grouping and filter option (§3.1, §4.2).
3. **Community toys.** Shown as **toy packs** by creator, *Built in / [brand]* and *Community / [creator name]*, as a third grouping and filter option. The community side is a **placeholder** card now; the shared registry (with PLAN §5.5's Verified shelf rules) plugs into `PackSource` later.

Implementation steps: [REVISIONS.md](REVISIONS.md) §1.
