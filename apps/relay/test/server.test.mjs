import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { CH } from "../relay.mjs";
import { createRelayServer, originAllowed } from "../server.mjs";

const ITCH = "https://html-classic.itch.zone";
const { server, close } = createRelayServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `127.0.0.1:${server.address().port}`;
after(() => close());

/** Resolves with "open" or the HTTP status of a refused upgrade. */
function attempt(path, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}${path}`, origin ? { origin } : {});
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.on("error", () => resolve("error"));
  });
}

/** A minimal client: a doc synced over the relay. */
function client(code, origin = ITCH) {
  const doc = new Y.Doc();
  const ws = new WebSocket(`ws://${base}/room/${code}`, { origin });
  ws.binaryType = "arraybuffer";
  const c = { doc, ws, control: [], synced: false };
  const send = (ch, write) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, ch);
    write(enc);
    if (ws.readyState === 1) ws.send(encoding.toUint8Array(enc));
  };
  doc.on("update", (u, o) => o !== c && send(CH.sync, (e) => syncProtocol.writeUpdate(e, u)));
  ws.on("open", () => {
    send(CH.control, (e) => encoding.writeVarString(e, JSON.stringify({ t: "hello", build: "b1", clientId: doc.clientID, name: "t" })));
    send(CH.sync, (e) => syncProtocol.writeSyncStep1(e, doc));
  });
  ws.on("message", (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const ch = decoding.readVarUint(dec);
    if (ch === CH.control) c.control.push(JSON.parse(decoding.readVarString(dec)));
    if (ch === CH.sync) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.sync);
      if (syncProtocol.readSyncMessage(dec, enc, doc, c) === syncProtocol.messageYjsSyncStep2) c.synced = true;
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    }
  });
  return c;
}

const until = async (f, ms = 2000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("GET /healthz answers ok; other paths 404", async () => {
  const ok = await fetch(`http://${base}/healthz`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "ok");
  assert.equal((await fetch(`http://${base}/`)).status, 404);
});

test("the origin allowlist", () => {
  assert.ok(originAllowed(ITCH));
  assert.ok(originAllowed("tauri://localhost"));
  assert.ok(originAllowed("http://tauri.localhost"));
  assert.ok(!originAllowed("https://evil.example"));
  assert.ok(!originAllowed(""));
  assert.ok(!originAllowed("http://localhost:5173"));
  assert.ok(originAllowed("http://localhost:5173", { dev: true }));
  assert.ok(originAllowed("http://127.0.0.1:4173", { dev: true }));
  assert.ok(!originAllowed("http://localhost.evil.example", { dev: true }));
  assert.ok(originAllowed("https://x.test", { origins: ["https://x.test"] }));
  assert.ok(!originAllowed(ITCH, { origins: ["https://x.test"] }));
});

test("upgrades from allowed origins open; others get 403", async () => {
  assert.equal(await attempt("/room/ABCDEF", ITCH), "open");
  assert.equal(await attempt("/room/ABCDEF", "https://evil.example"), 403);
  assert.equal(await attempt("/room/ABCDEF", null), 403);
  assert.equal(await attempt("/room/ABCDEF", "http://localhost:5173"), 403);
  assert.equal(await attempt("/elsewhere", ITCH), 404);
});

test("two clients say hello and sync a doc through the standalone server", async () => {
  const a = client("K7QFZM");
  await until(() => a.synced);
  const b = client("K7QFZM", "tauri://localhost");
  await until(() => b.synced);
  assert.equal(a.control.find((m) => m.t === "welcome")?.code, "K7QFZM");
  a.doc.getMap("toys").set("x", 1);
  await until(() => b.doc.getMap("toys").get("x") === 1);
  b.doc.getMap("toys").set("y", 2);
  await until(() => a.doc.getMap("toys").get("y") === 2);
  a.ws.close();
  b.ws.close();
});

test("RELAY_DEV allows localhost pages", async () => {
  const dev = createRelayServer({ dev: true });
  await new Promise((r) => dev.server.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${dev.server.address().port}/room/ABCDEF`, { origin: "http://localhost:5173" });
  await new Promise((resolve, reject) => (ws.on("open", resolve), ws.on("error", reject)));
  ws.close();
  await dev.close();
});
