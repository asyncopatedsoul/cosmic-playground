import { onAny, type EventMap, type EventName } from "../events";
import type { Toy } from "../toys/toy";
import type { DevContext } from "./boot";
import type { Channel } from "./config";
import type { Log, LogEvent } from "./log";

/** Events that are problems, or chatter, rather than info. */
const LEVEL: Partial<Record<EventName, LogEvent["lvl"]>> = {
  "audio.bootFailed": "error",
  "audio.crash": "error",
  "audio.engineError": "error",
  "net.error": "error",
  "net.close": "warn",
  "net.reconnect": "warn",
  "session.remoteEdit": "debug",
};
const RTT_INFO_MS = 10_000;
const CHECKSUM_MS = 10_000;
const LONG_FRAME_MS = 50;

/**
 * Wires every source in docs/DEV-MODE.md §4.2 into the log. Returns the
 * per-frame hook for the `perf` channel.
 */
export function connectSources(log: Log, ctx: DevContext): (dt: number) => void {
  const { world } = ctx;

  // ---- app ----
  addEventListener("error", (e) => log.log("app", "error", "app.error", { message: e.message, at: `${e.filename}:${e.lineno}:${e.colno}` }));
  addEventListener("unhandledrejection", (e) => log.log("app", "error", "app.error", { message: String(e.reason?.stack ?? e.reason) }));
  document.addEventListener("visibilitychange", () => log.log("app", "info", "app.visibility", { state: document.visibilityState }));

  // ---- the event bus: player, net, session, audio ----
  let lastRttInfo = -Infinity;
  onAny((ev, data, t) => {
    const ch = ev.slice(0, ev.indexOf(".")) as Channel;
    let lvl = LEVEL[ev] ?? "info";
    if (ev === "net.rtt") {
      if (t - lastRttInfo >= RTT_INFO_MS) lastRttInfo = t;
      else lvl = "debug";
    }
    // Moves and drags settle first, so the log reads grab → move → drop.
    if (ev === "player.drop" || ev === "player.putAway") log.flushPending();
    const toy = "toy" in data && typeof data.toy === "string" ? data.toy : undefined;
    const late = performance.now() - t > 5;
    log.log(ch, lvl, ev, toyless(data as EventMap[EventName]), toy, late ? t : undefined);
  });

  // ---- world and toys: this player's edits (remote ones arrive as session.remoteEdit) ----
  const params = new Map<string, Record<string, number>>();
  const where = new Map<string, number[]>();
  const volumes = new Map<string, number>();
  const pos = (t: Toy) => t.group.position.toArray().map((v) => Math.round(v * 100) / 100);
  const remember = (t: Toy) => {
    params.set(t.id, { ...t.params });
    where.set(t.id, pos(t));
    volumes.set(t.id, round(t.volume));
  };
  const present = world.toys.filter((t): t is Toy => !!t);
  for (const t of present) remember(t);
  log.log("world", "info", "world.present", { bpm: world.bpm, toys: present.map((t) => ({ id: t.id, kind: t.entryId, pos: pos(t) })) });

  world.listeners.push({
    add: (t) => {
      remember(t);
      log.log("world", "info", "world.add", { kind: t.entryId, slot: t.slot, pos: pos(t) }, t.id);
    },
    remove: (t) => {
      params.delete(t.id);
      where.delete(t.id);
      volumes.delete(t.id);
      log.log("world", "info", "world.remove", { kind: t.entryId }, t.id);
    },
    edit: (t, what) => {
      if (what === "params") {
        const before = params.get(t.id) ?? {};
        const changed: Record<string, [unknown, unknown]> = {};
        const derived: Record<string, [unknown, unknown]> = {};
        for (const [k, v] of Object.entries(t.params)) if (before[k] !== v) (t.defs[k]?.derived ? derived : changed)[k] = [before[k], round(v)];
        params.set(t.id, { ...t.params });
        if (Object.keys(changed).length) log.change("toy", "info", "toy.param", t.id, changed);
        // Values the toy computes itself (Kettle coverage) are chatter, not edits.
        if (Object.keys(derived).length) log.change("toy", "debug", "toy.derived", t.id, derived);
      } else if (what === "pos") {
        const now = pos(t);
        log.change("toy", "info", "toy.move", t.id, { pos: [where.get(t.id), now] });
        where.set(t.id, now);
      } else if (what === "pulse") {
        log.log("toy", "info", "toy.pulse", { ...t.pulse }, t.id);
      } else if (what === "pattern") {
        log.log("toy", "info", "toy.pattern", { text: t.pattern }, t.id);
      } else if (what === "volume") {
        log.change("toy", "info", "toy.volume", t.id, { volume: [volumes.get(t.id), round(t.volume)] });
        volumes.set(t.id, round(t.volume));
      } else {
        log.log("toy", "info", "toy.wild", { wild: t.wild }, t.id);
      }
    },
    world: (what) => {
      if (what === "tempo") log.log("world", "info", "world.tempo", { bpm: world.bpm });
      else log.log("world", "info", "world.tuning", { ...world.tuning });
    },
    poke: (t, strength) => log.log("player", "info", "player.poke", { strength: round(strength) }, t.id),
  });

  const loadError = world.onLoadError;
  world.onLoadError = (slot, what, message) => {
    const t = world.toys[slot];
    log.log("toy", "warn", what === "pattern" ? "toy.patternError" : "toy.loadError", { slot, what, message }, t?.id);
    loadError?.(slot, what, message);
  };

  // ---- audio: this player's listening ----
  let heard = { master: world.mix.master, muted: world.mix.muted };
  world.mix.listeners.push(() => {
    const { master, muted } = world.mix;
    if (muted !== heard.muted) log.log("audio", "info", "audio.mute", { muted });
    if (master !== heard.master) log.change("audio", "info", "audio.master", undefined, { master: [heard.master, round(master)] });
    heard = { master, muted };
  });

  // ---- periodic world checksum (compare across clients in a room) ----
  window.setInterval(() => {
    if (!log.on("world", "debug")) return;
    const snaps = world.toys.filter((t): t is Toy => !!t).map((t) => world.snapshot(t));
    snaps.sort((a, b) => (a.id < b.id ? -1 : 1));
    const text = JSON.stringify({ bpm: world.bpm, tuning: world.tuning, toys: snaps });
    log.log("world", "debug", "world.checksum", { hash: fnv1a(text), toys: snaps.length });
  }, CHECKSUM_MS);

  // ---- perf: 1 s summaries and long frames ----
  let frames = 0;
  let worst = 0;
  let since = performance.now();
  return (dt) => {
    if (!log.on("perf", "warn")) return;
    const ms = dt * 1000;
    if (ms > LONG_FRAME_MS) log.log("perf", "warn", "perf.long", { ms: Math.round(ms) });
    frames++;
    worst = Math.max(worst, ms);
    const now = performance.now();
    if (now - since >= 1000) {
      log.log("perf", "info", "perf.frame", { fps: Math.round((frames * 1000) / (now - since)), worstMs: Math.round(worst), toys: world.count });
      frames = 0;
      worst = 0;
      since = now;
    }
  };
}

function toyless(data: object): Record<string, unknown> | undefined {
  const { toy: _toy, ...rest } = data as Record<string, unknown>;
  return Object.keys(rest).length ? rest : undefined;
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}

/** 32-bit FNV-1a, hex. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
