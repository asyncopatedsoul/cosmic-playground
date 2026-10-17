// The room relay (docs/MULTIPLAYER.md §3.2): one WebSocket per player at
// /room/<code>, star topology. Each room holds a Y.Doc (the shared world) and
// an Awareness (presence). Binary frames, first byte = channel:
//
//   0 sync       y-protocols sync (step 1/2, updates)
//   1 awareness  y-protocols awareness updates
//   2 events     JSON pokes, fanned out to everyone else (target beats come with M3)
//   3 time       ping: f64 client time → reply: f64 client time, f64 server time
//   4 control    JSON: hello / welcome / roles / admin / error
//
// Roles: the first member is the admin; the admin can hand the role to anyone,
// and when the admin leaves it passes to the longest-connected member. While
// the world is locked (world.locked in the doc), a doc update from a non-admin
// is refused and that client rejoins fresh, so guests can play toys but not
// change them. (Clients don't send such updates; this guards against races.)

import { performance } from "node:perf_hooks";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocketServer } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export const CH = { sync: 0, awareness: 1, events: 2, time: 3, control: 4 };
export const LIMITS = { members: 8, rooms: 20, message: 64 * 1024, perSecond: 240, idleMs: 10 * 60 * 1000 };
/** Room codes: 6 characters without look-alikes (no I, L, O, 0, 1). */
export const CODE = /^[A-HJKMNP-Z2-9]{6}$/;

/** @typedef {{ ws: import("ws").WebSocket, clientId: number | null, name: string, joined: number, ids: Set<number>, count: number, window: number }} Member */

/** Whether a sync step 2 / update frame changes the doc (new content or new deletions). */
function changesDoc(doc, dec) {
  const d = decoding.clone(dec);
  decoding.readVarUint(d);
  const update = decoding.readVarUint8Array(d);
  const temp = new Y.Doc();
  Y.applyUpdate(temp, Y.encodeStateAsUpdate(doc));
  const before = Y.snapshot(temp);
  Y.applyUpdate(temp, update);
  const changed = !Y.equalSnapshots(before, Y.snapshot(temp));
  temp.destroy();
  return changed;
}

export function createRelay({ log = () => {} } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.message });
  /** @type {Map<string, ReturnType<typeof makeRoom>>} */
  const rooms = new Map();

  function makeRoom(code) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    /** @type {Map<import("ws").WebSocket, Member>} */
    const members = new Map();
    const room = { code, doc, awareness, members, admin: /** @type {Member | null} */ (null), build: /** @type {string | null} */ (null), idle: /** @type {NodeJS.Timeout | null} */ (null) };

    doc.on("update", (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.sync);
      syncProtocol.writeUpdate(enc, update);
      broadcast(room, encoding.toUint8Array(enc), origin);
    });
    awareness.on("update", ({ added, updated, removed }, origin) => {
      const m = origin && members.get(origin);
      if (m) {
        for (const id of added) m.ids.add(id);
        for (const id of removed) m.ids.delete(id);
      }
      const changed = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.awareness);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      broadcast(room, encoding.toUint8Array(enc), null);
    });
    return room;
  }

  function broadcast(room, data, except) {
    for (const ws of room.members.keys()) if (ws !== except && ws.readyState === 1) ws.send(data);
  }

  function control(ws, msg) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, CH.control);
    encoding.writeVarString(enc, JSON.stringify(msg));
    if (ws.readyState === 1) ws.send(encoding.toUint8Array(enc));
  }

  function sendRoles(room) {
    const msg = { t: "roles", admin: room.admin?.clientId ?? null };
    for (const ws of room.members.keys()) control(ws, msg);
  }

  const locked = (room) => room.doc.getMap("world").get("locked") === true;

  function join(room, ws, member, hello) {
    if (room.build === null || room.members.size === 0) room.build = hello.build;
    if (hello.build !== room.build) {
      control(ws, { t: "error", code: "build", build: room.build, message: `This room runs a different version of Cosmic Playground (${room.build}). Update in the itch app or reload the page.` });
      ws.close(4001, "build mismatch");
      return;
    }
    if (room.idle) clearTimeout(room.idle);
    room.idle = null;
    member.clientId = Number(hello.clientId);
    member.name = String(hello.name ?? "").slice(0, 32);
    room.members.set(ws, member);
    room.admin ??= member;
    control(ws, { t: "welcome", code: room.code, you: member.clientId, admin: room.admin.clientId, build: room.build });
    sendRoles(room);

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, CH.sync);
    syncProtocol.writeSyncStep1(enc, room.doc);
    ws.send(encoding.toUint8Array(enc));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, CH.awareness);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      ws.send(encoding.toUint8Array(a));
    }
    log(`room ${room.code}: ${member.name || member.clientId} joined (${room.members.size})`);
  }

  function drop(room) {
    if (room.idle) clearTimeout(room.idle);
    rooms.delete(room.code);
    room.awareness.destroy();
    room.doc.destroy();
  }

  function leave(room, ws) {
    const m = room.members.get(ws);
    if (!m) return;
    room.members.delete(ws);
    awarenessProtocol.removeAwarenessStates(room.awareness, [...m.ids], null);
    if (room.admin === m) {
      // The longest-connected member (Map keeps join order) takes over.
      room.admin = room.members.values().next().value ?? null;
      sendRoles(room);
    }
    log(`room ${room.code}: ${m.name || m.clientId} left (${room.members.size})`);
    if (room.members.size === 0) {
      room.idle = setTimeout(() => {
        drop(room);
        log(`room ${room.code}: closed`);
      }, LIMITS.idleMs);
    }
  }

  function message(room, ws, member, data) {
    const now = performance.now();
    if (now - member.window > 1000) {
      member.window = now;
      member.count = 0;
    }
    if (++member.count > LIMITS.perSecond) {
      ws.close(4008, "rate limit");
      return;
    }
    const dec = decoding.createDecoder(new Uint8Array(data));
    const ch = decoding.readVarUint(dec);
    if (ch === CH.control) {
      const msg = JSON.parse(decoding.readVarString(dec));
      if (msg.t === "hello" && member.clientId === null) return join(room, ws, member, msg);
      if (member.clientId === null) return;
      if (msg.t === "admin" && room.admin === member) {
        const to = [...room.members.values()].find((m) => m.clientId === msg.to);
        if (to) {
          room.admin = to;
          sendRoles(room);
        }
      }
      return;
    }
    if (member.clientId === null) return; // nothing before hello
    if (ch === CH.sync) {
      const type = decoding.peekVarUint(dec);
      // A locked world takes doc changes from admins only (step 1 is just a state request).
      // Later updates from that client build on the dropped one, so it must start over:
      // the client rejoins with a fresh doc and takes the room's world.
      if (type !== syncProtocol.messageYjsSyncStep1 && locked(room) && room.admin !== member && changesDoc(room.doc, dec)) {
        control(ws, { t: "error", code: "locked", message: "The world is locked." });
        ws.close(4009, "locked");
        return;
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.sync);
      syncProtocol.readSyncMessage(dec, enc, room.doc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    } else if (ch === CH.awareness) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
    } else if (ch === CH.time) {
      const t = decoding.readFloat64(dec);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.time);
      encoding.writeFloat64(enc, t);
      encoding.writeFloat64(enc, performance.now());
      ws.send(encoding.toUint8Array(enc));
    } else if (ch === CH.events) {
      broadcast(room, new Uint8Array(data), ws);
    } else {
      ws.close(4002, "unknown channel");
    }
  }

  /** Hand an HTTP upgrade for /room/<code> to the relay; returns false for other paths. */
  function handleUpgrade(req, socket, head) {
    const m = /^\/room\/([^/?#]+)/.exec(req.url ?? "");
    if (!m) return false;
    const code = decodeURIComponent(m[1]).toUpperCase();
    if (!CODE.test(code) || (!rooms.has(code) && rooms.size >= LIMITS.rooms) || (rooms.get(code)?.members.size ?? 0) >= LIMITS.members) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let room = rooms.get(code);
      if (!room) rooms.set(code, (room = makeRoom(code)));
      /** @type {Member} */
      const member = { ws, clientId: null, name: "", joined: Date.now(), ids: new Set(), count: 0, window: 0 };
      ws.binaryType = "arraybuffer";
      ws.on("message", (data) => {
        try {
          message(room, ws, member, data);
        } catch (err) {
          log(`room ${code}: bad frame (${err.message})`);
          ws.close(4003, "bad frame");
        }
      });
      ws.on("close", () => leave(room, ws));
    });
    return true;
  }

  function close() {
    for (const room of [...rooms.values()]) {
      for (const ws of room.members.keys()) ws.terminate();
      drop(room);
    }
    wss.close();
  }

  return { handleUpgrade, rooms, close };
}

/** Vite plugin: mount the relay on the dev server and on `vite preview` (one origin, one tunnel). */
export function roomRelay() {
  const relay = createRelay({ log: (s) => console.log(`[relay] ${s}`) });
  const attach = (server) => {
    server.httpServer?.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/room/")) relay.handleUpgrade(req, socket, head);
    });
  };
  return { name: "room-relay", configureServer: attach, configurePreviewServer: attach };
}
