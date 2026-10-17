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
| Two views | **Gallery** (grid of every toy, grouped by Principle family, with filters *Playable / Coming / My variants*) and **Details** (one toy, large). |
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

---

## 4. Short descriptions (draft content)

### 4.1 Playable now

| Toy | Family | Short description | Law (for the details view) |
|---|---|---|---|
| **Monochord Spire** | Vibration | A glowing string you stretch, twist and pluck; touch a bead for a harmonic. | f = (1/2L)·√(T/μ); harmonics at L/n |
| **Kepler Orrery** | Orbit | Fling planets around a sun; each one chimes as it crosses the line. | T ∝ r^1.5; orbit ratios become polyrhythms |
| **Reaction Kettle** | Reaction | Pour two reagents and watch living patterns bubble and sing. | Gray-Scott reaction-diffusion; Minnaert bubbles f·r ≈ 3.26 m/s |
| **Singing Bowl** | Plate | A bowl that rings like a bell; a wider rim sings lower. | Plate modes: f ∝ thickness / radius² |
| **Bottle Organ** | Resonance | Fill the bottle and blow across it: more water, higher note. | Helmholtz: f = (c/2π)·√(A / (V·L)) |
| **Spark Box** | Recipe | A box of zaps, blips and chirps you can roll, mutate and share. | A ZzFX-style sound recipe; pitch is a plain frequency |
| **Pendulum Clock** | Oscillator | A pendulum that ticks a melody; longer swings tick slower and lower. | T = 2π·√(L/g) |

### 4.2 Planned (from PLAN §2.2)

| Toy | Family | Short description | Law | Phase |
|---|---|---|---|---|
| **Chladni Drum** | Vibration | Strike a plate and watch sand dance into the shape of its sound. | Plate vibration modes, nodal lines | 2 |
| **Pendulum Wave** | Oscillator | A row of pendulums that drift in and out of step, playing a slow arpeggio. | Coupled oscillators; phase drift | 2 |
| **Lissajous Loom** | Wave | Two dials weave a glowing figure; simple ratios make steady shapes and sweet chords. | Superposition of two frequencies | 2 |
| **Euclid Wheel** | Rhythm | Spin two rings to spread beats evenly and make rhythms from all over the world. | Euclidean rhythms (Bjorklund) | 2 |
| **Fourier Serpent** | Wave | Draw any shape; spinning circles redraw it and turn it into a voice. | Fourier series and epicycles | 3 |
| **Crystal Seeder** | Growth | Plant a seed and grow a crystal; every new branch plays a note. | Lattices and L-systems | 3 |
| **Bubble Organ** | Resonance | Blow bubbles of different sizes; each rings once, then pops. | Helmholtz resonance: f ∝ 1/√V | 3 |
| **Doppler Comet** | Wave | Throw a comet past your ears and hear its pitch swoop. | Doppler shift: f′ = f·c/(c − v) | 2 (best in XR) |
| **Tesseract Bell** | Topology | Turn a bell through the fourth dimension; its shadow and its chord change together. | 4D rotation and projection | 3 |
| **Murmuration Choir** | Growth | Sprinkle a flock of birds; where they crowd, the choir swells. | Flocking (boids) | 3 |
| **Prism of Partials** | Wave | Shine any toy's sound through the prism to split it into rainbow beams. | Spectral decomposition (FFT) | 3 |

Phases refer to the reprioritised roadmap in [PLAN.md](PLAN.md) §8. Bubble Organ overlaps Bottle Organ and the Kettle's bubbles; it may become a Bottle Organ variant instead (open question §10).

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
│ Toy Book                       [Playable] [Coming] [Mine]   ⤢  ✕ │
├──────────────────────────────────────────────────────────────────┤
│ Vibration                                                        │
│ [Spire ▶]  [Chladni ◌]  …                                        │
│ Orbit                                                            │
│ [Orrery ▶]  …                                                    │
│ …                                                                │
└──────────────────────────────────────────────────────────────────┘
 card: thumbnail or animated icon · name · blurb · status badge (▶ playable, ◌ coming, ★ variant count)
```

- Families as rows (Vibration, Orbit, Wave, Growth, Reaction, Topology, Resonance, Plate, Oscillator, Rhythm, Recipe; to be consolidated against PLAN's six families, open question §10).
- Cards are buttons; arrow keys move between them; `Enter` opens details.
- Dragging a playable card out of the Toy Book onto the world places the toy, just like the chest.

### 6.2 Details

```
┌──────────────────────────────────────────────────────────────────┐
│ ‹ Gallery     Monochord Spire · Vibration          ‹ ›   ⤢  ✕   │
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
| **B1. Content** | `ToyAbout`, `about.ts`, `planned.ts`, `about` in the 4 config JSONs, PLAN sync check; blurbs used in chest tooltips | The sync check fails if a PLAN toy is missing |
| **B2. Gallery + static details** | Modal, fullscreen, gallery grid, details with icon (no live preview), keyboard and screen-reader navigation | All 18 toys reachable by keyboard; fullscreen works on desktop, Android and the Quest browser; iPhone uses the overlay |
| **B3. Live preview** | Preview renderer, `PreviewWorld`, audition slot (engine `MAX_TOYS + 1` internal slots), focus ducking | Poking the preview Spire sounds while the world ducks; closing restores the mix; 60 fps on a mid phone |
| **B4. Try this + variants** | Event-driven checklist, variants list with rename/delete/export | A tester completes a "Try this" by playing, without reading instructions twice |

B1 and B2 are independent of everything else. B3 needs [AUDIO-MIX.md](AUDIO-MIX.md) A1 (monitor gain for ducking). B4 needs [SAVE-LOAD.md](SAVE-LOAD.md) S4.

---

## 9. Testing

- Sync check (B1) in `npm test`.
- Screenshot test of the gallery and one details view (Playwright) on desktop and a phone viewport.
- Audition slot: an engine test that the slot's audio never appears in `bus` taps of world toys unless explicitly coupled, and is absent from WorldDoc output.

---

## 10. Open questions

1. **Families.** PLAN uses six Principle families (Vibration, Orbit, Wave, Growth, Reaction, Topology); the data toys introduced Plate, Resonance, Oscillator and Recipe. Map them back to the six, or widen the list?
2. **Bubble Organ vs Bottle Organ.** Merge into one toy with variants, or keep both?
3. Should the Toy Book show **community toys** from a shared registry later (with the Verified shelf rules from PLAN §5.5)?
