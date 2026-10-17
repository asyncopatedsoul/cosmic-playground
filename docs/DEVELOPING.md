# Developing Cosmic Playground

## Prerequisites

- **Node 20+** (`node -v`)
- **Rust** with the WebAssembly target:
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  rustup target add wasm32-unknown-unknown
  ```
  The npm scripts add `~/.cargo/bin` to `PATH` themselves, so they work before you open a new shell.
- **ngrok** (only for testing on other devices), see [Share over ngrok](#share-over-ngrok).

## Everyday commands

| Command | What it does |
|---|---|
| `npm run dev` | Builds the WASM engine, then starts Vite on http://localhost:5173 with hot reload |
| `npm test` | Rust tests (`cargo test`) and the TypeScript type-check |
| `npm run licenses` | Checks every dependency of `crates/*` against the allow-list in `deny.toml` (no copyleft in the embeddable crates) |
| `npm run build` | WASM plus a static production build in `apps/playground/dist` |
| `npm run tunnel` | Dev server plus a public HTTPS URL through ngrok |
| `npm run tunnel -- --build` | Same, but serves the production build (`vite preview` on :4173) |
| `npm run desktop` | The [desktop shell](#desktop-build-tauri): dev server inside a native window, with hot reload |
| `npm run desktop:build` | Release desktop app and installers in `target/release/bundle/` |

Rust changes need the WASM rebuilt: rerun `npm run build:wasm` (the dev server picks up the new `public/hypertoy.wasm` on reload). It also builds the example Voice Module (`crates/vma-ring`) to `public/modules/ring.wasm`.

**Windows without Visual Studio Build Tools:** the WASM build only needs `rust-lld`, but native `cargo test` needs a linker. Either install the Build Tools (see [Desktop build](#desktop-build-tauri)) or use the self-contained GNU toolchain:

```bash
rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal
cargo +stable-x86_64-pc-windows-gnu test
```

## Making toys and sounds

| Where | What |
|---|---|
| `apps/playground/src/toys/configs/*.json` | Toys described as data (ToyConfig): a built-in Law, a patch or zap voice, a Pulse pattern, a Form. Add one to `CONFIGS` in `toys/registry.ts`. Format: [AUDIO-GEN.md](AUDIO-GEN.md) §3–§6. |
| http://localhost:5173/forge.html | The Toy Forge: write a Voice in Faust, hear it, send it to the playground's chest (in another tab). |
| `crates/vma-ring` | A native Voice Module in Rust; the template for modules in any WASM language ([VMA.md](VMA.md)). |
| Pulse editor → `</>` | Script any toy's Pulse in mini-notation: `x . [x x] <x x*2>`, `0 2 <4 7>`, `x(3,8)`, `x?`. |
| HUD → `≋` | Tunings: named scales (Tonal), n-EDO, Scala `.scl` files. |

## Share over ngrok

Phones and the Quest 3 need **HTTPS**. AudioWorklet (the engine) and WebXR only run in a [secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts), and `localhost` only counts as secure on the machine itself. So `http://192.168.x.x:5173` on your LAN loads the page but **stays silent**. An ngrok tunnel gives you a real HTTPS URL that any device can open.

### One-time setup

1. Install: `brew install ngrok` (macOS), or download from https://ngrok.com/download.
2. Create a free account at https://dashboard.ngrok.com and copy your authtoken.
3. `ngrok config add-authtoken <your-token>`
4. Optional but recommended: claim your free static domain under **Domains** in the dashboard, so the URL (and the Quest bookmark) stays the same between runs.

### Run it

```bash
npm run tunnel
```

The script:

1. builds the WASM engine (and, with `--build`, the production bundle),
2. starts Vite on :5173 (or `vite preview` on :4173),
3. starts `ngrok http <port>` and reads the public URL from ngrok's log,
4. prints the URL for the **guide page** (`/guide.html`), the app URL, and a QR code of the guide URL to scan with a phone.

With a static domain:

```bash
NGROK_URL=your-name.ngrok-free.app npm run tunnel
```

Ctrl-C stops the server and the tunnel together. While it runs, http://127.0.0.1:4040 is ngrok's request inspector, which is handy for spotting a failed `hypertoy.wasm` or worklet request.

### Dev server or production build?

- **Dev (default):** hot reload works through the tunnel, so edits show up on the phone or headset as you save. It's slower to first load because Vite serves unbundled modules: expect a few hundred requests.
- **`--build`:** a single bundled app, close to what players will get. Use this for **performance checks**, especially audio dropouts on phones and frame rate on the Quest.

### Gotchas

- **ngrok's warning page.** On the free plan, browsers see a "You are about to visit…" page once per device. Tap **Visit Site**. The app's own `fetch` calls send `ngrok-skip-browser-warning` so the warning page can't replace the WASM binary.
- **Allowed hosts.** Vite rejects requests whose `Host` it doesn't know. `apps/playground/vite.config.ts` allows the ngrok domains (`*.ngrok-free.app`, `*.ngrok-free.dev`, `*.ngrok.app`, `*.ngrok.dev`, `*.ngrok.io`). If you use a custom domain, add it there.
- **The URL is public.** Anyone with the link can load your dev server while the tunnel is up. Don't leave it running unattended. For a private session, add `--basic-auth 'user:pass'` to the ngrok args in `scripts/tunnel.mjs` (it's not on by default because headsets make typing passwords painful).
- **Latency.** The tunnel only carries page loads and hot-reload messages. Audio is generated on the device, so the tunnel's network latency never affects timing.
- **Quest 3.** Type the guide URL into the Meta Quest Browser once and bookmark it. A static domain keeps it short and stops it changing between runs. Remote debugging: enable developer mode, connect over USB, and open `chrome://inspect` on the desktop.

## Desktop build (Tauri)

`apps/desktop` wraps the same Vite build in a [Tauri 2](https://v2.tauri.app) window. For now it only validates the shell; the MIDI/serial bridge comes next (see [DESKTOP-MIDI.md](DESKTOP-MIDI.md)).

### Extra prerequisites

- **Windows:** Rust's MSVC toolchain needs the *Visual Studio Build Tools* with the **Desktop development with C++** workload. WebView2 ships with Windows 11.
- **macOS:** Xcode Command Line Tools (`xcode-select --install`).
- **Linux:** `webkit2gtk-4.1`, `libayatana-appindicator3` and `librsvg2` dev packages (see Tauri's prerequisites page).
- Then `npm install` at the root, which installs the Tauri CLI into the workspace.

### Run it

```bash
npm run desktop
```

This runs `npm run dev` (WASM + Vite on :5173) and opens a native window pointed at it. To check the webview-to-Rust IPC path, open devtools in the window (right-click → Inspect, debug builds only) and run `await __TAURI_INTERNALS__.invoke("shell_info")`.

`npm run desktop:build` makes a release build: the WASM engine, the production bundle, the shell, and installers (NSIS/MSI on Windows, `.app`/`.dmg` on macOS, AppImage/`.deb` on Linux) in `target/release/bundle/`. Installers are unsigned for now.

Icons are generated from `apps/desktop/icon.svg` with `npm -w apps/desktop run icons`.

The desktop crate is a workspace member but not a default member, so `cargo test` and `npm test` don't build Tauri.

## Where things live

See the layout section of the [README](../README.md#layout). The engine's param ids and snapshot layout are mirrored between `crates/hypertoy-wasm/src/engine.rs` and `apps/playground/src/audio/protocol.ts`; change both together.
