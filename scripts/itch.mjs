// Build and push itch.io channels (docs/PUBLISHING-ITCH.md §6, docs/PLAYTESTS.md R3/R4).
//
//   npm run itch -- [--web] [--windows] [--dry-run]
//
// Settings come from .env.itch (git-ignored; see .env.itch.example) or the
// environment: ITCH_TARGET (user/game), VITE_RELAY_URL, VITE_SHARE_URL.
// Builds with those baked in, stages build/itch/<channel>, and runs
// `butler push <dir> $ITCH_TARGET:<channel> --userversion 0.1.0+<build id>`.
// --dry-run builds and stages but doesn't push (CI uses it to stage).
// With neither --web nor --windows: web, plus windows on a Windows machine.
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildId } from "./build-id.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dry = args.has("--dry-run");
let web = args.has("--web");
let windows = args.has("--windows");
if (!web && !windows) {
  web = true;
  windows = process.platform === "win32";
}
const MAX_FILES = 900; // itch allows 1,000 files per HTML5 upload, directories included (§3.3)

function fail(msg) {
  console.error(`itch: ${msg}`);
  process.exit(1);
}

/** KEY=value lines; # comments; optional quotes. The environment wins over the file. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function run(cmd, cmdArgs, env) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(" ")}`);
  // npm is npm.cmd on Windows, which needs a shell; butler is an .exe and gets its args unquoted.
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", env, shell: cmd === "npm" && process.platform === "win32" });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs[0] ?? ""} failed (${r.status ?? r.error?.message})`);
}

/** Files and directories under dir, the way itch counts them. */
function countEntries(dir) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    n++;
    if (e.isDirectory()) n += countEntries(join(dir, e.name));
  }
  return n;
}

function stage(channel) {
  const dir = join(root, "build/itch", channel);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const fileEnv = readEnvFile(join(root, ".env.itch"));
const settings = { ...fileEnv };
for (const k of ["ITCH_TARGET", "VITE_RELAY_URL", "VITE_SHARE_URL"]) if (process.env[k]) settings[k] = process.env[k];
const target = settings.ITCH_TARGET ?? "";
if (!settings.VITE_RELAY_URL) console.warn("itch: VITE_RELAY_URL is not set: this build can't host or join by code on itch.");
if (!settings.VITE_SHARE_URL) console.warn("itch: VITE_SHARE_URL is not set: invites will show a link instead of the itch page.");
if (!dry && !/^[^/\s]+\/[^/\s]+$/.test(target)) fail("set ITCH_TARGET=<user>/<game> in .env.itch (or pass --dry-run)");
if (!dry && spawnSync("butler", ["--version"]).status !== 0) fail("butler isn't on PATH (https://itch.io/docs/butler/), or pass --dry-run");

// Build the engine first so the id (commit + engine hash) is known, then pin it
// for every later step: vite and the desktop build both read BUILD_ID.
const env = { ...process.env, ...settings };
if (!process.env.BUILD_ID) run("npm", ["run", "build:wasm"], env);
const id = buildId();
env.BUILD_ID = id;
const version = `${JSON.parse(readFileSync(join(root, "apps/playground/package.json"), "utf8")).version}+${id}`;
console.log(`\nitch: build ${id} → --userversion ${version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build_id=${id}\nversion=${version}\n`);

const pushes = [];
if (windows) {
  // tauri build runs the web build first (beforeBuildCommand), with the same env.
  run("npm", ["-w", "apps/desktop", "run", "build", "--", "--no-bundle"], env);
  const exe = join(root, "target/release/cosmic-playground-desktop.exe");
  if (!existsSync(exe)) fail(`no ${exe} (the windows channel needs a Windows build machine)`);
  const dir = stage("windows");
  cpSync(exe, join(dir, "Cosmic Playground.exe"));
  cpSync(join(root, "apps/desktop/itch/windows.itch.toml"), join(dir, ".itch.toml"));
  pushes.push([dir, "windows"]);
}
if (web) {
  if (!windows) run("npm", ["run", "build"], env);
  const dist = join(root, "apps/playground/dist");
  const n = countEntries(dist);
  console.log(`itch: html5 has ${n} files and folders (limit ${MAX_FILES})`);
  if (n > MAX_FILES) fail(`apps/playground/dist has ${n} entries; itch refuses HTML5 uploads near 1,000`);
  const dir = stage("html5");
  cpSync(dist, dir, { recursive: true });
  pushes.push([dir, "html5"]);
}
if (web && !windows) {
  console.warn("itch: pushing html5 only. The windows channel keeps its older build id, so web and desktop testers can't share a room until the next full run.");
}

for (const [dir, channel] of pushes) {
  const cmd = ["push", dir, `${target || "<ITCH_TARGET>"}:${channel}`, "--userversion", version];
  if (dry) console.log(`\nitch: staged ${dir}\n(dry run) butler ${cmd.join(" ")}`);
  else run("butler", cmd, env);
}
