// Expose the playground on a public HTTPS URL through ngrok, so phones and a
// Quest 3 can open it. HTTPS matters: AudioWorklet and WebXR only run in a
// secure context, and a LAN address like http://192.168.x.x is not one.
//
//   npm run tunnel              dev server (hot reload) on :5173
//   npm run tunnel -- --build   production build via `vite preview` on :4173
//
// Env: NGROK_URL=my-name.ngrok-free.app reserves a stable hostname.

import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = process.argv.includes("--build");
const port = build ? 4173 : 5173;
const env = { ...process.env, PATH: `${join(homedir(), ".cargo", "bin")}:${process.env.PATH}` };
const children = [];

function run(cmd, args) {
  const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`\n${cmd} exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const c of children) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

try {
  execFileSync("ngrok", ["version"], { stdio: "ignore" });
} catch {
  console.error("ngrok is not installed. See docs/DEVELOPING.md#share-over-ngrok");
  process.exit(1);
}

execFileSync("node", ["scripts/build-wasm.mjs"], { cwd: root, env, stdio: "inherit" });
if (build) execFileSync("npm", ["-w", "apps/playground", "run", "build"], { cwd: root, env, stdio: "inherit" });

const server = run("npm", ["-w", "apps/playground", "run", build ? "preview" : "dev", "--", "--port", String(port), "--strictPort"]);
server.stdout.pipe(process.stdout);

const ngrokArgs = ["http", String(port), "--log=stdout", "--log-format=json"];
if (process.env.NGROK_URL) ngrokArgs.push(`--url=${process.env.NGROK_URL}`);
const ngrok = run("ngrok", ngrokArgs);

createInterface({ input: ngrok.stdout }).on("line", async (line) => {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (entry.lvl === "eror" || entry.lvl === "crit") console.error(`ngrok: ${entry.err ?? entry.msg}`);
  if (entry.msg !== "started tunnel" || !entry.url) return;

  const guide = `${entry.url}/guide.html`;
  const qr = await QRCode.toString(guide, { type: "terminal", small: true });
  console.log(`
  Cosmic Playground is public (${build ? "production build" : "dev server"}):

    Start here:  ${guide}
    App:         ${entry.url}/
    Inspector:   http://127.0.0.1:4040

  Scan to open the guide on a phone (on a Quest 3, type the URL and bookmark it):
${qr}
  On ngrok's free plan, visitors see an ngrok warning page once; tap "Visit Site".
  Ctrl-C stops the server and the tunnel.
`);
});
