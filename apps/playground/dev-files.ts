import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Developer files (docs/DEV-MODE.md §5.3):
 *
 *   - `virtual:dev-config`: dev.config.json and dev.config.local.json for the page
 *     (empty in production builds, which don't bundle them)
 *   - `POST /__dev/log`: appends log batches to devlog/sessions/<date>-<time>-<build>-<id>.jsonl
 *
 * Endpoints exist only on the dev server, and only for this machine: `npm run
 * tunnel` exposes the dev server, and tunnels connect from localhost, so the
 * Host header and forwarding headers are checked too. File names are always
 * chosen here; nothing in a request becomes a path.
 */
const VIRTUAL = "virtual:dev-config";
const RESOLVED = "\0" + VIRTUAL;
const LOG_LIMIT = 256 * 1024;
const KEEP_SESSIONS = 50;

export function devFiles(): Plugin {
  let root = "";
  let build = false;
  const configFiles = () => [join(root, "dev.config.json"), join(root, "dev.config.local.json")];

  return {
    name: "cosmic-dev-files",
    configResolved(c) {
      root = c.root;
      build = c.command === "build";
    },
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      if (build) return "export default { file: null, local: null };";
      const [file, local] = configFiles();
      const out: { file: unknown; local: unknown; error?: string } = { file: null, local: null };
      try {
        out.file = readJson(file);
        out.local = readJson(local);
      } catch (e) {
        out.error = (e as Error).message;
      }
      return `export default ${JSON.stringify(out)};`;
    },
    configureServer(server) {
      // Editing either config file reloads the page with the new settings.
      server.watcher.add(configFiles());
      server.watcher.on("all", (_event, path) => {
        if (!configFiles().includes(resolve(path))) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      });

      const sessions = new Map<string, string>();
      const dir = resolve(root, "../../devlog/sessions");
      server.middlewares.use("/__dev", (req, res) => {
        if (!fromThisMachine(req)) return reply(res, 403, "dev endpoints only answer this machine");
        if (req.method !== "POST" || req.url?.split("?")[0] !== "/log") return reply(res, 404, "not found");
        readBody(req, LOG_LIMIT)
          .then((text) => {
            const body = JSON.parse(text) as { session?: unknown; build?: unknown; events?: unknown };
            const token = typeof body.session === "string" && /^[a-z0-9]{8,16}$/.test(body.session) ? body.session : null;
            if (!token || !Array.isArray(body.events)) return reply(res, 400, "expected { session, build, events[] }");
            let file = sessions.get(token);
            if (!file) {
              mkdirSync(dir, { recursive: true });
              const b = typeof body.build === "string" ? body.build.replace(/[^\w.-]/g, "").slice(0, 40) : "nobuild";
              file = join(dir, `${stamp(new Date())}-${b || "nobuild"}-${token.slice(0, 4)}.jsonl`);
              sessions.set(token, file);
              prune(dir);
            }
            if (body.events.length) appendFileSync(file, body.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
            reply(res, 204);
          })
          .catch((e: Error) => reply(res, e.message === "too large" ? 413 : 400, e.message));
      });
    },
  };
}

const LOOPBACK_ADDR = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORWARDED = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "cf-connecting-ip", "cf-ray", "ngrok-skip-browser-warning"];

/** A request from a browser on this machine, not a tunnel, a LAN device or another site. */
export function fromThisMachine(req: IncomingMessage): boolean {
  if (!LOOPBACK_ADDR.has(req.socket.remoteAddress ?? "")) return false;
  if (!LOOPBACK_HOST.has(hostname(req.headers.host))) return false;
  if (FORWARDED.some((h) => h in req.headers)) return false;
  if (Object.keys(req.headers).some((h) => h.startsWith("ngrok-"))) return false;
  // Browsers send Origin on POST; another site in the same browser mustn't write here.
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      if (!LOOPBACK_HOST.has(new URL(origin).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function hostname(host: string | undefined): string {
  if (!host) return "";
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0];
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path.split(/[\\/]/).pop()}: ${(e as Error).message}`);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        // Keep draining so the 413 reaches the client; the body is dropped.
        chunks.length = 0;
        fail(new Error("too large"));
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

function reply(res: ServerResponse, status: number, message?: string) {
  res.statusCode = status;
  if (message) res.setHeader("content-type", "text/plain");
  res.end(message);
}

/** 2026-10-17-183205 in local time. */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Keep only the newest sessions. */
function prune(dir: string) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP_SESSIONS)) unlinkSync(join(dir, f));
}
