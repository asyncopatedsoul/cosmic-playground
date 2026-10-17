// Standalone relay (docs/PUBLISHING-ITCH.md §2, §5): the same createRelay() the
// Vite plugin mounts, behind a plain HTTP server, for an always-on host (Render).
//
//   GET /healthz        → 200 ok (Render's health check; also wakes a sleeping instance)
//   upgrade /room/CODE  → the relay, if the Origin is allowed; 403 otherwise
//
// Env: PORT (default 8787), RELAY_ORIGINS (comma-separated allowlist),
// RELAY_DEV=1 or --dev (also allow http://localhost:* and http://127.0.0.1:*).

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createRelay } from "./relay.mjs";

export const DEFAULT_ORIGINS = ["https://html-classic.itch.zone", "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

/** Whether a browser Origin may open a room socket. */
export function originAllowed(origin, { origins = DEFAULT_ORIGINS, dev = false } = {}) {
  if (!origin) return false;
  if (origins.includes(origin)) return true;
  return dev && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

export function createRelayServer({ origins = DEFAULT_ORIGINS, dev = false, log = () => {} } = {}) {
  const relay = createRelay({ log });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin ?? "";
    const allowed = originAllowed(origin, { origins, dev });
    log(`upgrade ${req.url} from ${origin || "(no origin)"}${allowed ? "" : " refused"}`);
    if (!allowed) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (!relay.handleUpgrade(req, socket, head)) socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
  /** Close every room, then stop listening. */
  const close = () => new Promise((r) => (relay.close(), server.close(() => r())));
  return { server, relay, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env.RELAY_ORIGINS;
  const origins = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  const dev = process.env.RELAY_DEV === "1" || process.argv.includes("--dev");
  const port = Number(process.env.PORT) || 8787;
  const { server, close } = createRelayServer({ origins, dev, log: (s) => console.log(`[relay] ${s}`) });
  server.listen(port, () => console.log(`[relay] listening on :${port} · origins ${origins.join(", ")}${dev ? " + localhost" : ""}`));
  const stop = () => close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
