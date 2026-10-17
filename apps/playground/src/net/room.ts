import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/** Channels on the room socket; mirrors apps/relay/relay.mjs. */
const CH = { sync: 0, awareness: 1, events: 2, time: 3, control: 4 } as const;

export type RoomStatus = "connecting" | "online" | "offline" | "error";

/** A player-visible link and the socket it maps to. */
export interface RoomAddress {
  code: string;
  /** ws(s)://host, where the relay lives. */
  relay: string;
  /** The page link to share (https://host/?room=CODE). */
  link: string;
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE = /^[A-HJKMNP-Z2-9]{6}$/;

export function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
}

/** Whether this page was served by something that can also be a relay (dev/preview server, tunnel). */
export function servedByRelay(): boolean {
  const desktopAssets = location.hostname === "tauri.localhost" || location.protocol === "tauri:";
  return !desktopAssets && (location.protocol === "http:" || location.protocol === "https:");
}

/** A room address from a pasted link or a bare code (the code needs a page served by a relay). */
export function parseRoom(input: string): RoomAddress | null {
  const text = input.trim();
  if (CODE.test(text.toUpperCase())) {
    if (!servedByRelay()) return null;
    return address(new URL(location.href), text.toUpperCase());
  }
  try {
    const url = new URL(text);
    const code = url.searchParams.get("room")?.toUpperCase();
    return code && CODE.test(code) ? address(url, code) : null;
  } catch {
    return null;
  }
}

function address(base: URL, code: string): RoomAddress {
  const relay = `${base.protocol === "https:" ? "wss" : "ws"}://${base.host}`;
  const page = new URL(base.pathname.replace(/[^/]*$/, ""), base.origin);
  page.searchParams.set("room", code);
  return { code, relay, link: page.href };
}

/**
 * One player's connection to a room (docs/MULTIPLAYER.md §3.3): the shared
 * Y.Doc, presence (awareness), roles, and reconnect with backoff.
 */
export class RoomSession {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  status: RoomStatus = "connecting";
  error = "";
  /** Yjs client id of the admin (MULTIPLAYER.md §12). */
  admin: number | null = null;
  /** Round-trip of the last time ping, ms. */
  rtt = 0;
  onStatus: (() => void) | null = null;
  /** The first full sync of each connection. */
  onSynced: (() => void) | null = null;
  onEvent: ((e: unknown) => void) | null = null;
  /** The relay refused a change (a locked world): rejoin with a fresh doc. */
  onReset: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private pinger = 0;

  constructor(
    readonly address: RoomAddress,
    private name: string,
  ) {
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.sync);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });
    this.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      if (origin !== "local") return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.awareness);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
      this.send(encoding.toUint8Array(enc));
    });
    addEventListener("pagehide", () => this.leave());
    this.connect();
  }

  get isAdmin() {
    return this.admin === this.doc.clientID;
  }

  /** Hand the admin role to another player (admins only). */
  makeAdmin(clientId: number) {
    this.control({ t: "admin", to: clientId });
  }

  /** A short-lived event (a poke) for everyone else in the room. */
  emit(e: object) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, CH.events);
    encoding.writeVarString(enc, JSON.stringify(e));
    this.send(encoding.toUint8Array(enc));
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    clearInterval(this.pinger);
    this.ws?.close();
    this.setStatus("offline");
    this.awareness.destroy();
  }

  private connect() {
    this.setStatus("connecting");
    const ws = new WebSocket(`${this.address.relay}/room/${this.address.code}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let synced = false;
    ws.onopen = () => {
      this.retry = 0;
      this.control({ t: "hello", build: __BUILD_ID__, clientId: this.doc.clientID, name: this.name });
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, CH.sync);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.send(encoding.toUint8Array(enc));
      if (this.awareness.getLocalState()) {
        const a = encoding.createEncoder();
        encoding.writeVarUint(a, CH.awareness);
        encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
        this.send(encoding.toUint8Array(a));
      }
      clearInterval(this.pinger);
      this.pinger = window.setInterval(() => this.ping(), 5000);
      this.ping();
    };
    ws.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data));
      const ch = decoding.readVarUint(dec);
      if (ch === CH.sync) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, CH.sync);
        const type = syncProtocol.readSyncMessage(dec, enc, this.doc, this);
        if (encoding.length(enc) > 1) this.send(encoding.toUint8Array(enc));
        if (type === syncProtocol.messageYjsSyncStep2 && !synced) {
          synced = true;
          this.setStatus("online");
          this.onSynced?.();
        }
      } else if (ch === CH.awareness) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
      } else if (ch === CH.events) {
        this.onEvent?.(JSON.parse(decoding.readVarString(dec)));
      } else if (ch === CH.time) {
        this.rtt = performance.now() - decoding.readFloat64(dec);
      } else if (ch === CH.control) {
        const msg = JSON.parse(decoding.readVarString(dec));
        if (msg.t === "welcome" || msg.t === "roles") {
          this.admin = msg.admin;
          this.onStatus?.();
        } else if (msg.t === "error" && msg.code === "locked") {
          this.onReset?.();
        } else if (msg.t === "error") {
          this.error = msg.message;
          this.closed = true;
          this.setStatus("error");
        }
      }
    };
    ws.onclose = (ev) => {
      clearInterval(this.pinger);
      if (this.closed) return;
      // Remote players vanish while we're away; they come back with the next awareness sync.
      const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
      // 4xxx: the relay refused us (build mismatch, bad frame); only a rate limit is worth retrying.
      if (ev.code >= 4000 && ev.code !== 4008) {
        this.error ||= ev.reason || "The room refused the connection.";
        this.closed = true;
        this.setStatus("error");
        return;
      }
      this.setStatus("connecting");
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
  }

  private ping() {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, CH.time);
    encoding.writeFloat64(enc, performance.now());
    this.send(encoding.toUint8Array(enc));
  }

  private control(msg: object) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, CH.control);
    encoding.writeVarString(enc, JSON.stringify(msg));
    this.send(encoding.toUint8Array(enc));
  }

  private send(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  private setStatus(s: RoomStatus) {
    this.status = s;
    this.onStatus?.();
  }
}
