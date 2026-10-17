import { resolve } from "node:path";
import { roomRelay } from "@hypertoys/relay";
import { defineConfig } from "vite";
import { buildId } from "../../scripts/build-id.mjs";

// Tunnels (scripts/tunnel.mjs) serve the app from an ngrok hostname; Vite
// rejects unknown Host headers unless they are allowed here.
const allowedHosts = [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.dev", ".ngrok.io", ".trycloudflare.com"];

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
