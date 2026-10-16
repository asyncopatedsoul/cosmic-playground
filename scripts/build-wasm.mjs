// Build the Rust engine to WASM and copy it where the playground serves it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH}` };

execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "hypertoy-wasm"],
  { cwd: root, stdio: "inherit", env },
);

const out = join(root, "apps/playground/public");
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "target/wasm32-unknown-unknown/release/hypertoy_wasm.wasm"), join(out, "hypertoy.wasm"));
console.log("wasm → apps/playground/public/hypertoy.wasm");
