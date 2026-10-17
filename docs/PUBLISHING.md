# CI and publishing plan (web, desktop, sites)

> How code becomes something people can open: continuous integration on every change, the web
> playground on its own domain, signed desktop installers with auto-update, and one site for the
> home page, player guides and contributor docs. The goal is **one tag, one commit, every
> surface**: a release tag ships the web build, the desktop installers and the docs together,
> so a browser player and a desktop player on the same version can always share a room.

Status: plan · Oct 2026 · builds on [DEVELOPING.md](DEVELOPING.md) (scripts, Tauri shell), [MULTIPLAYER.md](MULTIPLAYER.md) §6 (build lock, joining from desktop), [DESKTOP-MIDI.md](DESKTOP-MIDI.md) §D5 (signing, updater), [PLAN.md](PLAN.md) §7 (licensing, channels) and §11.5 (brand naming)

`<brand>` below stands for the domain we pick. The naming analysis (comparables, trademark conflicts, domain and handle availability) lives in the *Cosmic Playground: name and brand analysis* Google Sheet; §9 lists what this plan needs from that decision.

Until this plan's P1 and P4 land, remote multiplayer testing uses itch.io builds and a hosted Node relay: see [PUBLISHING-ITCH.md](PUBLISHING-ITCH.md).

---

## 0. TL;DR

| Decision | Recommendation |
|---|---|
| CI | **GitHub Actions**, in this repo. One `ci.yml` on every PR (Rust, WASM, web, site, license check, browser smoke test), path-filtered so a docs PR doesn't build Tauri. |
| Web hosting | **Cloudflare**: Pages (or Workers static assets) for every static site, **Workers + Durable Objects** for the multiplayer relay, **R2** for downloads. Free egress, global edge, per-path headers, PR previews, and the relay and the page on one provider. |
| Domains | Apex `<brand>` is the **site** (home, guides, developers, blog). The app lives on **`play.<brand>`**, because it needs cross-origin isolation headers that the marketing site must not have. Rooms on `rooms.<brand>`, downloads on `dl.<brand>`. |
| Site + CMS | One **Astro + Starlight** site in `apps/site`, content as **Markdown/MDX in the repo** (docs-as-code). A git-based CMS (**Keystatic**, Decap as fallback) on top for non-developer editors; it commits to the repo, so there's no database and no second source of truth. |
| Contributor docs | Narrative docs from `docs/*.md` rendered under `/developers`; Rust API on **docs.rs** once crates publish (rustdoc in CI before that); TypeScript SDK API via **TypeDoc**. Toy pages are **generated from the toy configs**, the same data as the [Toy Book](TOY-BOOK.md). |
| Desktop | **tauri-action** builds Windows, macOS (universal) and Linux on tag. Signing: **Azure Artifact Signing** (formerly Trusted Signing) on Windows, **Developer ID + notarization** on macOS. Tauri updater with signed `latest.json` on `dl.<brand>`. |
| Mobile | **Tauri 2 mobile** (Capacitor as fallback, decided by spike T0), needed by the phone-host topology in [LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md). App records registered early, builds shared **only with testers** through TestFlight and Play internal/closed testing. Android builds from the Windows dev machine; iOS builds on a GitHub macOS runner; a **dev client** loads the dev tunnel on both (§5.1). |
| Channels | `main` → **next** (`next.play.<brand>`, nightly desktop on GitHub pre-releases); tag `vX.Y.Z` → **stable** (`play.<brand>`, signed installers, updater). PRs → preview URLs. |
| Version lock | Every web release is also kept at an immutable path `play.<brand>/v/<build-id>/`. A room link carries the host's build id, so a guest on a different version loads the matching build instead of hitting the "different version" refusal ([MULTIPLAYER.md](MULTIPLAYER.md) §6.4). |
| Releases | **release-please** opens the release PR (version bump in `package.json` / `tauri.conf.json` / `Cargo.toml`, changelog); merging it tags. Crates and npm packages publish later (Phase 3) with **release-plz** and **npm trusted publishing**. |
| Cost to start | One domain (~$10–$70/yr depending on TLD), Cloudflare Workers Paid ($5/mo, needed for Durable Objects), Apple Developer ($99/yr), Azure Artifact Signing (~$10/mo), Google Play Console ($25 once). Everything else is free tier. |

---

## 1. Surfaces and who they're for

| Surface | Audience | What it is | Host |
|---|---|---|---|
| **Home** `<brand>/` | Everyone, parents, press | What it is, a playable hero (an embedded Constellation), "Play now" and "Download" | Site |
| **Guides** `<brand>/learn/` | Players, all ages | Getting started per device (phone, desktop, Quest 3, MIDI rig), every toy, Pulse, coupling, hosting a jam | Site |
| **Teach** `<brand>/teach/` | Educators | Lesson ideas mapping toys to physics, music and chemistry; classroom setup; privacy notes | Site |
| **Toys** `<brand>/toys/` | Players and creators | A web Toy Book: one page per toy, generated from the configs, with a live embed | Site |
| **Developers** `<brand>/developers/` | Toy makers, contributors | Making toys (ToyConfig, Faust, VMA), the Rust core, architecture, contributing, release process | Site |
| **Blog** `<brand>/blog/` | Community | Jam announcements, devlogs, release notes | Site |
| **Download** `<brand>/download/` | Desktop players | Detects the OS, links the right installer from `dl.<brand>` | Site |
| **Play** `play.<brand>` | Everyone | The app: `index.html`, `guide.html`, `forge.html`, with isolation headers | Static app |
| **Rooms** `rooms.<brand>` | (machines) | Multiplayer relay WebSocket, `wss://rooms.<brand>/room/<code>` | Worker + Durable Objects |
| **Downloads** `dl.<brand>` | (machines, Download page) | Installers, `latest.json` for the updater, checksums | R2 bucket |

Later, when they exist: `api.<brand>` (Cosmic Cloud), `status.<brand>` (uptime page), `edu.<brand>` (classroom edition login).

### 1.1 Why the app is on a subdomain, and nothing else is

The site wants to live on one origin for SEO and simplicity: guides, toys and developer docs on paths (`/learn`, `/toys`, `/developers`) build up one domain's search reputation, share one nav and search index, and need one deploy. Subdomains for docs (`docs.`, `dev.`) would split that for no technical gain.

The app is the exception, for three reasons:

1. **Cross-origin isolation.** The engine wants `SharedArrayBuffer` ([PLAN.md](PLAN.md) §4.2), which needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy` on the page. Those headers break YouTube embeds, third-party images and OAuth popups on a marketing site. One origin per header policy keeps both sides simple.
2. **Release cadence.** The app ships on tags and keeps old builds at `/v/<id>/`; the site redeploys on every docs merge.
3. **Storage.** Saves live in IndexedDB per origin ([SAVE-LOAD.md](SAVE-LOAD.md)). A stable `play.` origin that never moves means players never lose a save because the marketing site changed hosts.

Embeds on the site (the hero, toy pages) are iframes of `play.<brand>/embed?...`. The `/embed` path is served **without** COEP so it can be framed anywhere and uses the `postMessage` transport fallback (PLAN §9).

---

## 2. Repository layout additions

```
.github/
  workflows/
    ci.yml            every PR and push: test, build, smoke
    preview.yml       PR previews for play + site (same-repo PRs; forks via label)
    deploy-next.yml   push to main: next.play.<brand>, site, nightly desktop
    release.yml       tag v*: stable web, signed desktop, updater manifest, GitHub Release
    release-please.yml
    mobile.yml        manual / push to main: Android → Play internal, iOS → TestFlight (§5.1)
  dependabot.yml      cargo, npm, github-actions (grouped weekly)
apps/
  site/               Astro + Starlight: home, learn, teach, toys, developers, blog
    src/content/
      learn/  teach/  blog/       Markdown/MDX, edited directly or through the CMS
    keystatic.config.ts           CMS collections (learn, teach, blog, home sections)
  relay/              Cloudflare Worker + Durable Object for rooms (MULTIPLAYER M5+)
    wrangler.toml
  playground/public/_headers      per-path headers for play.<brand>
scripts/
  stage-release.mjs   assemble dist/, /v/<build-id>/ copy, build manifest
  smoke.mjs           Playwright: load, start audio, first snapshot, no console errors
release-please-config.json
```

The site keeps **`docs/` as the source** for developer pages: a small Astro content loader reads `docs/*.md` (the plans and DEVELOPING) and renders them under `/developers/`, rewriting relative links. Contributors keep editing files next to the code, and a docs change lands in the same PR as the code it describes.

---

## 3. Continuous integration (`ci.yml`)

Runs on `pull_request` and `push` to `main`. A `changes` job (dorny/paths-filter) decides which jobs run.

| Job | Runs when | Steps | Runner |
|---|---|---|---|
| **rust** | `crates/**`, `Cargo.*` | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (default members, no Tauri), `cargo deny check` (replaces `npm run licenses` in CI) | ubuntu |
| **wasm** | `crates/**`, `scripts/build-wasm.mjs` | `npm run build:wasm`; **size budget**: fail if `hypertoy.wasm` grows > 10% over the size recorded in `main` (posted as a PR comment) | ubuntu |
| **web** | `apps/playground/**`, `crates/**` | `npm ci`, typecheck, `vite build`; upload `dist/` artifact | ubuntu |
| **smoke** | after `web` | Playwright (Chromium, headless, `--autoplay-policy=no-user-gesture-required`): open `/`, tap, assert the worklet posts a snapshot within 2 s, no console errors; open `/guide.html` and `/forge.html` | ubuntu |
| **site** | `apps/site/**`, `docs/**`, toy configs | `astro build`, link check (internal links and anchors, including the rewritten `docs/` links) | ubuntu |
| **desktop-check** | `apps/desktop/**` | `cargo check -p <desktop crate>` on ubuntu (with webkit2gtk deps); full bundles only in release | ubuntu |

Caching: `Swatinem/rust-cache` keyed on `Cargo.lock` and the `wasm32-unknown-unknown` target; `actions/setup-node` npm cache. A cold run should stay under ~8 minutes, a warm one under ~3.

Branch protection on `main`: `ci` required, linear history, no direct pushes. CODEOWNERS for `crates/` (core reviewers) and `apps/site/src/content/` (docs reviewers) so content PRs from the CMS route to the right people.

**Fork PRs.** Secrets aren't available to `pull_request` from forks, so CI never needs them. Previews for fork PRs run only after a maintainer adds a `preview` label (`pull_request_target` with a checkout of the PR head *and no secrets passed to build steps*; the deploy step alone gets the token).

---

## 4. Web deployment

### 4.1 Build once, deploy many

`scripts/stage-release.mjs` takes the `vite build` output and produces:

```
out/play/
  index.html  guide.html  forge.html  embed.html     → current build, no-cache HTML
  assets/…                                          → hashed, immutable
  hypertoy.wasm  modules/…                          → content-hashed names
  v/<build-id>/…                                     → full copy, immutable forever
  build.json      { buildId, version, commit, date }
  _headers
```

`<build-id>` is the `__BUILD_ID__` the multiplayer handshake already uses (git short hash + WASM hash, [MULTIPLAYER.md](MULTIPLAYER.md) §6.4). The `/v/` tree accumulates across releases (kept in R2 behind the Pages project, or re-uploaded from the last N release artifacts; Pages has a per-deploy file limit, so prune to the last ~20 stable builds).

The WASM file currently has a fixed name (`public/hypertoy.wasm`). For long-cache safety it should get a content hash or a `?v=<build-id>` query in the loader; that's a small change in `scripts/build-wasm.mjs` and the audio host.

### 4.2 Headers (`apps/playground/public/_headers`)

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-site
  Permissions-Policy: xr-spatial-tracking=(self), midi=(self), microphone=()
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
/embed*
  ! Cross-Origin-Embedder-Policy
  ! Cross-Origin-Opener-Policy
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/v/*
  Cache-Control: public, max-age=31536000, immutable
/*.html
  Cache-Control: no-cache
```

`require-corp` vs `credentialless`: start with `require-corp` (all our assets are same-site). Switch to `credentialless` if we ever load third-party assets into the app (e.g. community toy packs on another host). A Content-Security-Policy follows once the Faust compiler's needs (`wasm-unsafe-eval`, workers from blob URLs) are pinned down.

### 4.3 Environments

| Env | URL | Trigger | Notes |
|---|---|---|---|
| Preview | `<pr>.<project>.pages.dev` (play and site) | PR | Bot comments both URLs plus a QR code for testing on a phone or Quest |
| Next | `next.play.<brand>`, `next.<brand>` (site, `noindex`) | push to `main` | What testers and Hyperjam rehearsals use |
| Stable | `play.<brand>`, `<brand>` | tag `v*` (app); site also on every `main` merge that touches only content | The site deploys content continuously; app-version-specific docs are gated by a `since:` frontmatter field |

The relay deploys with the app: `wrangler deploy` for `apps/relay` runs in `deploy-next.yml` (to a `next` environment) and `release.yml` (production). The relay itself is version-agnostic (it relays bytes and enforces the build lock by comparing ids), so one relay serves every `/v/<id>/` build.

### 4.4 Room links and old builds

A room link looks like `https://play.<brand>/?room=<code>` (the format from [MULTIPLAYER.md](MULTIPLAYER.md) §6.1). The relay knows the room's build id. When a guest opens the link:

1. The current build loads, asks `rooms.<brand>` for the room's build id.
2. If it differs, it redirects to `/v/<room-build-id>/?room=<code>` (same origin, so saves and settings still apply).
3. The desktop app does the same check; if its build differs it offers "Open this room in your browser" (it can't hot-swap its bundled build) or "Update now" if the updater has the room's version.

This turns the build lock from a refusal into a redirect for browsers, which matters on jam night when the host updated and half the guests didn't.

---

## 5. Desktop releases (`release.yml`)

Triggered by the tag release-please creates. Uses `tauri-apps/tauri-action`.

| Platform | Runner | Artifacts | Signing |
|---|---|---|---|
| Windows | `windows-latest` | NSIS `.exe` (default), `.msi` | **Azure Artifact Signing** via `signCommand` in `tauri.conf.json`; OIDC login (no secret file). Building in CI also avoids the Smart App Control problem in [DEVELOPING.md](DEVELOPING.md#desktop-build-tauri). |
| macOS | `macos-latest` | universal `.dmg` and `.app.tar.gz` (updater) | Developer ID Application cert (base64 `.p12` in secrets), hardened runtime, `notarytool` with an App Store Connect API key |
| Linux | `ubuntu-22.04` | AppImage, `.deb` (`.rpm` optional) | Updater signature only; publish checksums |

Steps after the matrix:

1. tauri-action uploads to a **draft** GitHub Release with the release-please changelog.
2. A `publish` job (needs all three) generates `latest.json` (the Tauri updater manifest, signed with the **updater key** `TAURI_SIGNING_PRIVATE_KEY`, which is separate from OS code signing), uploads installers and `latest.json` to R2 at `dl.<brand>/desktop/<version>/` and `dl.<brand>/desktop/latest.json`, and publishes the release.
3. The web release job deploys the **same commit's** `dist/` to `play.<brand>`, so the stable desktop build and the stable web build share a build id.

Nightly desktop builds from `main` go to a rolling `nightly` GitHub pre-release, unsigned on Windows to save signing quota if needed, with a separate updater channel (`dl.<brand>/desktop/nightly.json`) that testers opt into in settings.

**Before the first signed release, freeze the identity.** The bundle identifier (`app.cosmicplayground.desktop` today in `tauri.conf.json`), the product name, and the updater public key are hard to change after people install: the identifier keys macOS permissions and app data paths, and the updater refuses manifests signed with a different key. These wait on the naming decision (§9).

Later wrapper, same pipeline: a **PWA manifest** for the Quest Browser and a Meta Horizon store listing (PLAN §7.3). Mobile apps moved up to §5.1 because the phone-host topology in [LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md) depends on them.

### 5.1 Mobile builds and pre-release testing (revised Oct 2026)

*Revised for [LOCAL-MULTIPLAYER.md](LOCAL-MULTIPLAYER.md) §8–9: one phone hosts and every player brings a phone. The goal of this section is to **test native iOS and Android builds from the Windows dev machine, shared with testers through the stores, before anything is released publicly**.*

#### What changed from the earlier plan

| Before | Now | Why |
|---|---|---|
| Capacitor wrappers, Phase 5 | **Tauri 2 mobile**, as soon as local multiplayer L5 lands (spike T0 any time) | Same shell, config and plugins as the desktop app; the embedded **Rust relay** (MULTIPLAYER M6) and `hypertoy-midi` run on the phone, which offline phone hosting needs; one Rust toolchain |
| Store builds at public launch | **App records registered now, testers only** (TestFlight, Play internal/closed testing) | Testers get one-tap installs and automatic updates; the slow store steps (Play's closed-test requirement, Apple's first beta review) start early and stop blocking launch |
| No mobile dev loop | **Android from Windows directly; iOS through CI; a dev client for both** | The dev machine is Windows, and iOS builds need macOS |

Capacitor stays the fallback if spike T0 fails. Nothing in the web build depends on which wrapper wins.

#### Spike T0: does Tauri mobile carry the app? (≈1 week)

`tauri android init` and `tauri ios init` in a new `apps/mobile` (a separate Tauri app from `apps/desktop`, so desktop-only plugins such as the updater and `midir` stay out; shared Rust code moves to a `crates/hypertoy-host` crate). Pass/fail checks, on one mid-range Android phone and one iPhone:

| Check | Pass |
|---|---|
| AudioWorklet + WASM engine | 12-toy scenario plays 10 minutes with no underruns |
| Cross-origin isolation | `crossOriginIsolated === true` in both webviews (COOP/COEP set through Tauri's `app.security.headers` on the asset protocol; verify per platform) or a measured, acceptable fallback without `SharedArrayBuffer` |
| Gamepad API | A Bluetooth pad works in both webviews |
| Wake lock, orientation | Screen stays on in a room; landscape lock in avatar mode |
| QR scan, deep links | Official barcode-scanner and deep-link plugins open `cosmicplay://j/...` and scanned `https://…/j/…` links |
| Haptics | Official haptics plugin ticks on a poke |
| Local network | The embedded relay accepts a connection from a second phone on the same Wi-Fi (iOS Local Network prompt shown, Android multicast lock held) |
| Size and start | Install under 30 MB; cold start to first sound under 3 s |

If WKWebView or Android WebView fails the audio check, Capacitor won't fix it (same webviews); the fallback then is the web build plus a lighter native shell, and the plan records that finding.

#### Identity and accounts (do once, early)

| Item | Action | Notes |
|---|---|---|
| Bundle id / package name | Pick one id for both stores now, e.g. `app.cosmicplayground.mobile` (desktop uses `app.cosmicplayground.desktop`) | **Permanent per store record.** Users never see the iOS bundle id; the Android package name shows in the Play URL. The display name can follow the brand decision (§9) right up to public release. |
| Apple Developer Program | Already budgeted ($99/yr, §8) | Individual is fine for testing; an organization account (needs a D-U-N-S number) shows the company as seller at launch, and transferring an app later is possible but slow |
| App Store Connect app record | Create with the bundle id and a working name; **never submit for App Review** until launch | Reserves nothing about the public name (names are only reserved at submission); enables TestFlight |
| Google Play Console | $25 one-time; create the app as a draft | **Personal accounts created after Nov 2023 must run a closed test with at least 12 opted-in testers for 14 days** before production access. Start this the week internal builds work, so it never blocks launch. An organization account (D-U-N-S) skips it. |
| Play App Signing | Enroll; keep only the **upload key** locally and in CI | Google holds the app signing key; a lost upload key can be reset |
| Android developer verification | Register the package name to the verified developer account | Google is rolling out verification for apps installed outside Play (some countries from late 2026, wider in 2027). Sideloaded tester APKs (below) need it where enforced; check current status before relying on sideloading. |
| Kids audience | Decide whether to declare a children's audience before closed testing | Triggers Google Play Families policy and Apple Kids category rules (no third-party analytics or ads, parental gates). Our cookieless, tracker-free stance (§6.1) already fits; the declarations and content ratings are forms to fill, not code. |

#### Channels for unreleased builds

| Channel | iOS | Android | Who | Review | Update |
|---|---|---|---|---|---|
| **Cable / Wi-Fi debug** | `tauri ios dev` (needs a Mac) | `tauri android dev` from Windows over USB or wireless ADB | Developer | None | HMR from the Vite dev server |
| **Dev client** (internal flavour) | TestFlight **internal** only | Play **internal testing** or a sideloaded APK | Core team | None | Loads the tunnel URL it scans, so web changes need no rebuild |
| **Internal** | TestFlight internal: up to 100 App Store Connect users | Play internal testing: up to 100 testers by email, available in minutes | Team and close testers | None | Automatic through TestFlight / Play |
| **External / closed** | TestFlight external: up to 10,000 testers, **public link** possible | Play closed testing (email lists or Google Groups) | Playtest families, Hyperjam rehearsals, the Play 12-tester requirement | Apple Beta App Review for the first build of each version (usually about a day); Play review for closed tracks | Automatic |
| **Ad hoc / sideload** (fallback) | Ad hoc profile, up to 100 registered devices per type per year, built in CI, install via an OTA link | Signed release APK from the dev machine or a GitHub pre-release | Someone without a Google or Apple test invite | None | Manual |

TestFlight builds expire after 90 days; the nightly-style `mobile.yml` keeps a fresh one up. App Review never sees the dev client: it loads remote code by design, which is fine for internal testing but not for external TestFlight or the store (App Review Guideline 2.5.2), so **external testers always get bundled builds**.

#### The dev client

A build flavour (`--config tauri.devclient.conf.json`) with a different bundle id suffix (`.dev`), its own icon, and a start screen with a **Scan** button. It scans the dev-client QR that `npm run tunnel` prints (`cosmicplay-dev://open?url=https://<x>.ngrok-free.app`), then loads that URL in the webview with the custom user agent that passes the ngrok interstitial (MULTIPLAYER §6.3). The web code, the relay and the build id all come from the dev machine, so a Windows developer can change TS or Rust-to-WASM code and see it on an iPhone after a reload. Native changes (plugins, Rust in the shell, `Info.plist`) still need a new dev-client build, which is rare.

#### Building and sharing from the Windows dev machine

```bash
npm run mobile:android          # tauri android dev: USB or wireless ADB, HMR from the dev server
npm run mobile:android:build    # signed AAB + APK with the local upload key
npm run mobile:android:upload   # AAB to Play internal testing (Play Developer API, service account)
npm run mobile:ios:ci           # gh workflow run mobile.yml -f platform=ios -f ref=<current branch>
```

- **Android, fully local.** Prerequisites: Android Studio (SDK, NDK, an emulator image), JDK 17, Rust targets `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android`. `mobile:android:upload` is a small `scripts/mobile-upload.mjs` using the Play Developer API (or `fastlane supply`); it releases to the internal track with the commit as release notes. For a tester in the same room, `npm run tunnel -- --apk` also serves the latest APK at `/dl/app.apk` and prints a QR for it.
- **iOS, through CI.** Windows can't build iOS. `mobile:ios:ci` starts `mobile.yml` on a GitHub macOS runner for the current branch (push first), which builds, signs and uploads to TestFlight; testers get it in about 20–30 minutes. For a faster loop, the dev client covers most changes; a Mac on the LAN (or a rented cloud Mac) running `tauri ios dev` is the option if native iOS work gets heavy.
- **Signing on the macOS runner.** Use the App Store Connect API key already planned for notarization (§8) with Xcode's automatic signing (`-allowProvisioningUpdates` + `-authenticationKeyPath`), so no certificates or profiles live in the repo. A distribution certificate in secrets (or fastlane `match`) is the fallback if automatic signing misbehaves on CI.

#### `mobile.yml`

| Trigger | Jobs | Output |
|---|---|---|
| `workflow_dispatch` (platform, ref, flavour) | `android` (ubuntu: SDK/NDK, Rust Android targets, `tauri android build --aab --apk`, sign with the upload key) and/or `ios` (macos: Rust iOS targets, `tauri ios build --export-method app-store-connect`) | AAB → Play internal; IPA → TestFlight; APK on a rolling `mobile-nightly` GitHub pre-release |
| push to `main` (paths: `apps/mobile/**`, `apps/playground/**`, `crates/**`) | Same, `internal` flavour, both platforms | A fresh internal build every day there are changes; keeps TestFlight's 90-day expiry away |
| tag `v*` (later, at launch) | Same plus store metadata | Production tracks, after the launch decision |

Version codes: `versionName` from `tauri.conf.json`, `versionCode` / `CFBundleVersion` = the GitHub run number, so every upload is unique without manual bumps.

#### Phasing

| Step | Scope | Exit check |
|---|---|---|
| **T0. Spike** | `apps/mobile`, the checks above, decision recorded | Table above passes on both platforms, or the fallback is chosen with reasons |
| **T1. Records and internal builds** | Bundle id, App Store Connect and Play app records, Play App Signing, `mobile.yml`, `mobile:android:*` scripts, internal testers invited | A tester installs from TestFlight internal and Play internal testing, then gets the next build automatically |
| **T2. Dev client** | Dev-client flavour, Scan button, `tunnel` dev-client QR and `--apk` | A Windows-only change to a toy shows on an iPhone and an Android phone within a minute of saving |
| **T3. External testing** | TestFlight external with a public link, Play closed test with 12+ testers for 14 days, kids-audience forms, privacy declarations, universal links / App Links once the domain exists (P2) | A playtest family installs from a link and joins a phone-host session by scanning a QR with the system camera |

T0 can start now. T1 needs the Apple and Google accounts. T3's universal links wait on the domain (§9).

---

## 6. Site and content

### 6.1 Stack

- **Astro + Starlight**: static output, MDX, built-in search (Pagefind), i18n routing for when guides get translated, and islands for embedding live toys. Starlight handles `/learn`, `/teach` and `/developers`; plain Astro pages handle home, toys, download and blog.
- **Design**: shares tokens (colours, type) with the app's UI so the jump from site to `play.` feels like one product.
- **Analytics**: cookieless only (Cloudflare Web Analytics), no ad trackers, since the audience includes children (PLAN §1 pillar 7, COPPA/GDPR-K). No cookie banner needed if we keep it that way.

### 6.2 Where each kind of content comes from

| Content | Source of truth | Edited by | How it reaches the site |
|---|---|---|---|
| Home sections, blog, Teach | `apps/site/src/content/**` (MDX) | Anyone via PR, or non-developers via the CMS | Built directly |
| Player guides (`/learn`) | `apps/site/src/content/learn/` | Same | Built directly; the in-app help ([HELP-SYSTEM.md](HELP-SYSTEM.md)) links to these pages by stable slug |
| Toy pages (`/toys/<id>`) | `apps/playground/src/toys/configs/*.json` + their `about` fields ([TOY-BOOK.md](TOY-BOOK.md) §3) | Toy authors, in the same PR as the toy | A content loader reads the configs at build time; each page embeds `play.<brand>/embed?toy=<id>` |
| Developer docs | `docs/*.md` in the repo root | Contributors | Loader renders them under `/developers/`, rewriting relative links |
| Rust API | doc comments in `crates/*` | Contributors | rustdoc artifact in CI now, `docs.rs/hypertoy-*` once crates publish; `/developers/api/rust` links out |
| TS SDK API | TSDoc in the SDK package (Phase 3) | Contributors | TypeDoc output under `/developers/api/sdk` |
| Release notes | release-please changelog | Generated | Blog post per minor release, pulled from the GitHub Release |

### 6.3 CMS

Because everything above is files in git, the CMS only needs to be a friendly editor that commits:

- **Keystatic** (recommended): Astro-native, GitHub mode (edits become branches and PRs via a GitHub App), typed collections, MDX with custom components (`<ToyEmbed>`, `<DeviceTabs>`). The editor UI is served at `<brand>/keystatic` and only works for signed-in GitHub users with write access to the content.
- **Decap CMS** as a fallback if Keystatic's GitHub App model doesn't suit: same idea, older, wider adoption, needs an OAuth proxy (a tiny Worker).
- **Not** a hosted headless CMS (Contentful, Sanity, Storyblok) for now: a second source of truth, per-seat costs, and contributors couldn't change docs in the same PR as the code. Revisit if a marketing team without GitHub accounts appears.

CMS edits open PRs; the `site` CI job and a preview deploy run on them like any other PR, and CODEOWNERS routes them to a docs reviewer.

---

## 7. Packages for contributors (Phase 3)

When the SDK ships ([PLAN.md](PLAN.md) §8, phase 3):

| Package | Registry | Tooling | Notes |
|---|---|---|---|
| `hypertoy-core`, `-dsp`, `-laws` | crates.io | **release-plz** (version bumps from conventional commits, `cargo publish` in order) | Reserve the crate names early with `0.0.0` placeholders once the name is final |
| `@hypertoys/sdk`, `@hypertoys/cli`, `@hypertoys/embed` | npm | **changesets** + **npm trusted publishing** (OIDC from Actions, provenance attestations, no long-lived token) | Create the `@hypertoys` npm org now; the scope looked unclaimed on Oct 17, 2026 |
| `create-hypertoy` template | npm | same | `npm create hypertoy` scaffolds a toy repo with its own CI that runs the toy against the published engine |

Community toy repos get a **reusable workflow** (`asyncopatedsoul/cosmic-playground/.github/workflows/toy-check.yml@vX`) that validates a ToyConfig, builds Faust/VMA modules, and runs the toy headless for 10 s checking for NaNs and loudness, so the verified shelf (PLAN §5.5) has a mechanical first gate.

---

## 8. Secrets, accounts and costs

| Secret / account | Used by | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | preview, deploy-next, release | Token scoped to Pages, Workers, R2 for this account only |
| Azure Artifact Signing account + federated credential | release (Windows) | OIDC from GitHub, no stored secret; identity validation for an individual or org is a one-time step |
| `APPLE_CERTIFICATE` (+ password), `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID` | release (macOS) | Developer ID cert and App Store Connect API key for notarization |
| `TAURI_SIGNING_PRIVATE_KEY` (+ password) | release | Updater key. Back it up offline: losing it strands every installed copy on its current version |
| `ANDROID_UPLOAD_KEYSTORE` (base64) + passwords | mobile | Play upload key only; Google holds the app signing key (Play App Signing). Also kept locally for `mobile:android:build` |
| `PLAY_SERVICE_ACCOUNT_JSON` | mobile | Service account with release rights on the internal and closed tracks only |
| `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID` | mobile (iOS) | The same App Store Connect API key as macOS notarization; drives automatic signing and the TestFlight upload |
| `RELEASE_PLEASE_TOKEN` | release-please | A GitHub App token so the tag it creates triggers `release.yml` (the default token doesn't trigger workflows) |
| npm trusted publisher, crates.io token | Phase 3 | |

| Item | Cost (approx., verify at purchase) |
|---|---|
| Primary domain | ~$10–$20/yr for `.com`/`.org`/`.app`/`.dev`; `.io`/`.gg`/`.games`/`.toys` are more, often $30–$70/yr |
| Defensive domains (2–3) | ~$30–$100/yr total |
| Cloudflare Workers Paid | $5/mo (Durable Objects for rooms; Pages and R2 egress are free) |
| Apple Developer Program | $99/yr (covers macOS notarization and iOS TestFlight) |
| Google Play Console | $25 one-time |
| Azure Artifact Signing | ~$10/mo basic tier (check current eligibility for individuals in your country) |
| GitHub Actions | Free for public repos (macOS minutes included) |

---

## 9. What this plan needs from the naming decision

1. **The apex domain.** Everything in §1 hangs off it. Register the primary plus the `.com` (or the closest available) and one or two defensive TLDs at the same registrar as DNS (Cloudflare Registrar sells at cost).
2. **Product name and bundle identifier** for the desktop app, frozen before the first signed release (§5).
3. **Handles** to claim on the same day: GitHub org, npm org, crates names, YouTube, Bluesky, Discord vanity URL, itch.io, TikTok, Instagram, X, Twitch, Reddit. The sheet tracks which are free.
4. **Whether "hypertoys" stays the developer-facing name** (`@hypertoys/*`, `hypertoy-*` crates) under a different consumer brand. The sheet's research suggests that split; it costs nothing to keep.
5. **Build variables `VITE_BRAND_NAME` and `VITE_SUPPORT_EMAIL`** ([DEV-MODE.md](DEV-MODE.md) §5.5): the app's display name (also the Toy Book's *Built in / [brand]* pack label) and the support address the feedback guide points to. Defaults are checked in; release workflows set the real values once chosen.

---

## 10. Milestones

| Step | Scope | Exit criteria |
|---|---|---|
| **P0. CI** | `ci.yml` (rust, wasm + size budget, web, smoke, license check), dependabot, branch protection | Every PR gets a green/red check in under 8 min cold; a deliberately broken worklet fails `smoke` |
| **P1. Next on the web** | Cloudflare account, `_headers`, `stage-release.mjs` with `/v/<id>/`, `deploy-next.yml`, PR previews with QR | `next.play.<brand>` (or a `pages.dev` URL until the domain exists) opens on a phone and a Quest 3 with `crossOriginIsolated === true` |
| **P2. Domain and site** | Name decision, domain, DNS, `apps/site` with home, `/learn` (getting started per device), `/developers` from `docs/`, `/toys` from configs, Keystatic | A non-developer edits a guide in the CMS and it's live after one PR review |
| **P3. Desktop release** | release-please, `release.yml` matrix, Windows and macOS signing, updater manifest on R2, Download page | A signed installer on each OS installs without a SmartScreen/Gatekeeper warning and updates itself from v0.x.0 to v0.x.1 |
| **P4. Rooms in production** | `apps/relay` on Workers + Durable Objects (MULTIPLAYER M5), room links with build-id redirect | A browser guest on an older build follows a room link and lands in the right `/v/<id>/` build |
| **P5. Packages** | release-plz, changesets, trusted publishing, `create-hypertoy`, reusable `toy-check` workflow | An outside dev scaffolds, checks and publishes a toy without asking for help |

Mobile has its own steps, **T0–T3** (§5.1), which run alongside P1–P3: T0 can start now, T1 needs the store accounts, and T3's universal links wait on P2's domain.

P0 can start now and has no dependencies. P1 can use `*.pages.dev` until the domain exists, so the naming decision only blocks P2 and the signed parts of P3.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Durable Objects pricing or limits don't fit long jam sessions (WebSocket hibernation, message volume) | The relay stays a small protocol adapter; the Node relay from M0 can run on Fly.io or a VPS behind `rooms.<brand>` unchanged |
| Pages per-deploy file limit as `/v/` grows | Serve `/v/*` from R2 via a Worker route; keep only the last N stable builds; older room links fall back to "update and rejoin" |
| Losing the updater key | Store it in a password manager and offline; document key rotation (ship one release signed by both keys' trust before switching) |
| Signing eligibility or cost changes (Azure for individuals, Apple) | Fall back to an OV certificate in a cloud HSM for Windows; unsigned nightlies for testers either way |
| Docs drift from code | Developer docs live next to code and change in the same PR; toy pages are generated; the site's link check fails CI on broken anchors |
| CMS adds a second way to break the site | CMS edits are PRs through the same CI and preview; no direct writes to `main` |

---

## Sources (checked Oct 2026)

- Tauri GitHub Action and pipeline guide: https://v2.tauri.app/distribute/pipelines/github/ · https://github.com/tauri-apps/tauri-action
- Tauri updater and signing: https://v2.tauri.app/plugin/updater/ · https://v2.tauri.app/distribute/sign/windows/ · https://v2.tauri.app/distribute/sign/macos/
- Azure Artifact Signing: https://learn.microsoft.com/azure/artifact-signing/
- Cloudflare Pages headers and previews: https://developers.cloudflare.com/pages/configuration/headers/ · https://developers.cloudflare.com/pages/configuration/preview-deployments/
- Durable Objects WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Cross-origin isolation: https://web.dev/articles/coop-coep
- Starlight: https://starlight.astro.build · Keystatic: https://keystatic.com · Decap CMS: https://decapcms.org
- release-please: https://github.com/googleapis/release-please · release-plz: https://release-plz.dev · npm trusted publishing: https://docs.npmjs.com/trusted-publishers
- Tauri 2 mobile: https://v2.tauri.app/start/prerequisites/ · https://v2.tauri.app/distribute/app-store/ · https://v2.tauri.app/distribute/google-play/ · security headers: https://v2.tauri.app/security/http-headers/
- TestFlight (internal/external limits, 90-day expiry): https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview · App Review Guideline 2.5.2: https://developer.apple.com/app-store/review/guidelines/#software-requirements
- Play testing tracks and the 12-tester closed-test requirement for new personal accounts: https://support.google.com/googleplay/android-developer/answer/9845334 · https://support.google.com/googleplay/android-developer/answer/14151465 · Android developer verification: https://developer.android.com/developer-verification
