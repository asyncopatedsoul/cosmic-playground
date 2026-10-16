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

execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "hypertoy-wasm"],
  { cwd: root, stdio: "inherit", env },
);

const out = join(root, "apps/playground/public");
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "target/wasm32-unknown-unknown/release/hypertoy_wasm.wasm"), join(out, "hypertoy.wasm"));
console.log("wasm → apps/playground/public/hypertoy.wasm");
