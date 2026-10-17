// Build the Rust engine to WASM and copy it where the playground serves it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Windows spells it "Path"; reuse whichever key exists so the real PATH isn't shadowed.
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const env = { ...process.env, [pathKey]: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env[pathKey]}` };

// The engine, plus example Voice Modules (docs/VMA.md) the Forge can load.
execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "hypertoy-wasm", "-p", "vma-ring"],
  { cwd: root, stdio: "inherit", env },
);

const out = join(root, "apps/playground/public");
const release = join(root, "target/wasm32-unknown-unknown/release");
mkdirSync(join(out, "modules"), { recursive: true });
copyFileSync(join(release, "hypertoy_wasm.wasm"), join(out, "hypertoy.wasm"));
copyFileSync(join(release, "vma_ring.wasm"), join(out, "modules/ring.wasm"));
console.log("wasm → apps/playground/public/hypertoy.wasm, modules/ring.wasm");
