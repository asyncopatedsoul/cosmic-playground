import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { CH, createRelay } from "../relay.mjs";

const relay = createRelay();
const server = createServer();
server.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head) || socket.destroy());
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
after(() => {
  relay.close();
  server.close();
});

/** A minimal client: a doc synced over the relay, plus received control messages. */
function client(code, build = "b1") {
  const doc = new Y.Doc();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/room/${code}`);
  ws.binaryType = "arraybuffer";
  const c = { doc, ws, control: [], closed: null, synced: false };
  const send = (ch, write) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, ch);
    write(enc);
    if (ws.readyState === 1) ws.send(encoding.toUint8Array(enc));
  };
  doc.on("update", (u, origin) => origin !== c && send(CH.sync, (e) => syncProtocol.writeUpdate(e, u)));
  ws.on("open", () => {
    send(CH.control, (e) => encoding.writeVarString(e, JSON.stringify({ t: "hello", build, clientId: doc.clientID, name: "t" })));
    send(CH.sync, (e) => syncProtocol.writeSyncStep1(e, doc));
  });
  ws.on("message", (data) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const ch = decoding.readVarUint(dec);
    if (ch === CH.control) c.control.push(JSON.parse(decoding.readVarString(dec)));
    if (ch === CH.sync) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.sync);
      const type = syncProtocol.readSyncMessage(dec, enc, doc, c);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (type === syncProtocol.messageYjsSyncStep2) c.synced = true;
    }
  });
  ws.on("close", (code) => (c.closed = code));
  ws.on("error", () => (c.closed ??= -1));
  return c;
}

const until = async (f, ms = 2000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("two clients share a doc; the first is admin, and the role passes on when it leaves", async () => {
  const a = client("ABCDEF");
  await until(() => a.synced);
  const b = client("ABCDEF");
  await until(() => b.synced);
  assert.equal(a.control.find((m) => m.t === "welcome").admin, a.doc.clientID);
  a.doc.getMap("toys").set("x", 1);
  await until(() => b.doc.getMap("toys").get("x") === 1);
  a.ws.close();
  await until(() => b.control.some((m) => m.t === "roles" && m.admin === b.doc.clientID));
  b.ws.close();
});

test("a locked world refuses guest changes but not a guest's sync", async () => {
  const a = client("QWRTYP");
  await until(() => a.synced);
  a.doc.getMap("world").set("locked", true);
  const b = client("QWRTYP");
  await until(() => b.synced && b.doc.getMap("world").get("locked") === true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.closed, null, "an empty sync reply must not be refused");
  b.doc.getMap("toys").set("y", 2);
  await until(() => b.closed === 4009);
  assert.equal(a.doc.getMap("toys").get("y"), undefined);
  a.ws.close();
});

test("a different build is refused", async () => {
  const a = client("BXDBXD", "one");
  await until(() => a.synced);
  const b = client("BXDBXD", "two");
  await until(() => b.closed === 4001);
  assert.equal(b.control.at(-1).code, "build");
  a.ws.close();
});

test("bad room codes are refused", async () => {
  const c = client("nope");
  await until(() => c.closed !== null);
});
