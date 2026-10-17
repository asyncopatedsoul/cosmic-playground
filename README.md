# Cosmic Playground

An all-ages, multiplayer playground for sound and geometry. You play with **hypertoys**: impossible, alien toys that follow real first principles of physics, music and chemistry. Set them to play on their own, couple them together, and improvise generative soundscapes and 2D/3D animation together. It runs on touch, desktop, gamepad, and VR/AR (WebXR on Quest 3).

- 📐 **Plan:** [docs/PLAN.md](docs/PLAN.md) covers the experience, toy catalog, Rust + TypeScript architecture, multiplayer, modding SDK, prior art, go-to-market and roadmap.
- 🛠 **Developing:** [docs/DEVELOPING.md](docs/DEVELOPING.md) covers setup, scripts, and sharing over ngrok for phones and Quest 3.
- 🧭 **Help system plan:** [docs/HELP-SYSTEM.md](docs/HELP-SYSTEM.md) covers the cross-platform tutorial and anchored hints.
- 🚀 **Publishing:** [docs/PUBLISHING.md](docs/PUBLISHING.md) covers CI, web and desktop releases, domains and the site/CMS.
- 🗺 **Feature plans, in priority order** ([PLAN.md §8.1](docs/PLAN.md#81-feature-plans-in-priority-order)):
  1. [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md): browser and desktop jams over ngrok (next up)
  2. [docs/SAVE-LOAD.md](docs/SAVE-LOAD.md): Constellation save/load, toy variants in the chest
  3. [docs/AUDIO-MIX.md](docs/AUDIO-MIX.md): global mute, toy mute/solo/focus, toy volume
  4. [docs/TOY-BOOK.md](docs/TOY-BOOK.md): fullscreen gallery and details for every toy, playable and planned
  5. [docs/AVATAR.md](docs/AVATAR.md): Minecraft-creative avatar, gravity bodies, crosshair aiming and ray preview
  - [docs/REVISIONS.md](docs/REVISIONS.md): code changes for the Oct 2026 decisions in the Toy Book, Modes, Save/Load and Dev Mode plans

Status: **Phase 0 toy prototype** (single player, desktop and touch).

## Run it

Needs Node 20+ and Rust with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`).

```bash
npm install
npm run dev
```

Then open http://localhost:5173 and tap anything. New players can start at http://localhost:5173/guide.html, which detects their device and explains how to get in.

To try it on a phone or Quest 3, run `npm run tunnel`. It serves the app on a public HTTPS URL through ngrok (see [docs/DEVELOPING.md](docs/DEVELOPING.md#share-over-ngrok)). `npm test` runs the Rust tests and the TypeScript type-check; `npm run build` makes a static build in `apps/playground/dist`.

## What's in Phase 0

Three toys from three Principle families, picked to stress the toy anatomy in three different ways:

| Toy | Law | Play it |
|---|---|---|
| **Monochord Spire** | f = (1/2L)·√(T/μ), harmonics at L/n | Tap the string. Drag the cap to stretch, turn the gold peg to tighten, tap a bead for a harmonic. |
| **Kepler Orrery** | T ∝ r^1.5; each meridian transit chimes | Drag planets in and out. Drag out of the sun to launch one, into the sun to remove it. |
| **Reaction Kettle** | Gray-Scott reaction-diffusion; Minnaert bubbles (f·r ≈ 3.26 m/s) | Drag across the surface to pour, turn the rim to change the reagents. |

Every toy has a **Pulse**: tap its pink heart for a ring of steps (tap a dot on or off, long-press for "sometimes"), a rate chosen by shape, and play/pause. The world's **Tuning** (top bar) snaps physical pitches to a scale; ✺ *wild* turns snapping off. Move toys by their base and drop them on the chest to put them away.

## Layout

```
crates/
  hypertoy-core/   Tuning, Clock, Pulse patterns, deterministic RNG
  hypertoy-dsp/    Karplus-Strong pluck, FM bell, bubbles, SVF, reverb, limiter (no allocation in tick)
  hypertoy-laws/   string, Kepler, Minnaert, Gray-Scott
  hypertoy-wasm/   the engine + plain C-ABI exports (no wasm-bindgen: it must run in an AudioWorklet)
apps/playground/   Vite + three.js app
  src/audio/       worklet host, field Worker, the protocol shared with the engine
  src/toys/        Form for each toy; params and gestures are declared, not coded
  src/input.ts     the intent layer: poke / grab / stretch / twist
  src/ui/          chest, Pulse editor, HUD
```

The engine runs in the AudioWorklet and renders every 128-frame block in WASM. It posts a state snapshot back about every 8 ms, and the visuals follow that snapshot, so what you see is what you hear. The Kettle's field runs in its own Worker from the same WASM binary.
