import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { roomRelay } from "@hypertoys/relay";
import { defineConfig } from "vite";

// Tunnels (scripts/tunnel.mjs) serve the app from an ngrok hostname; Vite
// rejects unknown Host headers unless they are allowed here.
const allowedHosts = [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev", ".ngrok.io", ".trycloudflare.com"];

/** Git commit + engine hash: clients in a room must run the same build (MULTIPLAYER.md §6.4). */
function buildId(): string {
  let commit = "nogit";
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: import.meta.dirname }).toString().trim();
  } catch {
    /* not a checkout */
  }
  const wasm = resolve(import.meta.dirname, "public/hypertoy.wasm");
  const engine = existsSync(wasm) ? createHash("sha256").update(readFileSync(wasm)).digest("hex").slice(0, 8) : "nowasm";
  return `${commit}-${engine}`;
}

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  server: { allowedHosts },
  preview: { allowedHosts },
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: [roomRelay()],
  build: {
    target: "es2022",
    rolldownOptions: {
      input: {
        app: resolve(import.meta.dirname, "index.html"),
        guide: resolve(import.meta.dirname, "guide.html"),
        forge: resolve(import.meta.dirname, "forge.html"),
      },
    },
  },
});
