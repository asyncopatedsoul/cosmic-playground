// The build id clients compare when they join a room (docs/MULTIPLAYER.md §6.4):
// git commit + a hash of the engine. One source for vite.config.ts and
// scripts/itch.mjs, so the id baked into a bundle is the one itch shows.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `BUILD_ID` in the environment wins, so CI jobs on different OSes share one id. */
export function buildId() {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  let commit = "nogit";
  try {
    commit = execSync("git rev-parse --short=7 HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* not a checkout */
  }
  const wasm = join(root, "apps/playground/public/hypertoy.wasm");
  const engine = existsSync(wasm) ? createHash("sha256").update(readFileSync(wasm)).digest("hex").slice(0, 8) : "nowasm";
  return `${commit}-${engine}`;
}
