/**
 * App-wide events (docs/HELP-SYSTEM.md §2, docs/DEV-MODE.md §4.2). Input,
 * seats, UI, audio and networking emit here; the dev log, and later lessons
 * and metrics, listen. Toy edits, adds and pokes already reach listeners
 * through `World.listeners`, so they aren't repeated here.
 *
 * With no listeners, `emit` returns after one check, so players pay nothing.
 */
export interface EventMap {
  "player.grab": { toy: string; seat: number; part: string };
  "player.drop": { toy: string; seat: number };
  "player.putAway": { toy: string; seat: number };
  "player.undo": { toy: string; seat: number };
  "player.chest": { open: boolean };
  "player.pulseEdit": { toy: string | null };
  "player.avatarMode": { mode: string };
  "net.status": { code: string; status: string };
  "net.rtt": { ms: number };
  "net.close": { code: number; reason: string };
  "net.reconnect": { attempt: number; delayMs: number };
  "net.error": { message: string };
  "session.join": { code: string; name: string };
  "session.leave": { code: string };
  "session.synced": { code: string };
  "session.admin": { admin: number | null; me: boolean };
  "session.players": { added: number[]; removed: number[] };
  /** Another player changed these toys, or these world settings (tempo, tuning, lock). */
  "session.remoteEdit": { toys?: string[]; world?: string[] };
  "session.locked": { locked: boolean };
  "audio.ready": { sampleRate: number };
  "audio.bootFailed": { message: string };
  "audio.engineError": { message: string };
  "audio.crash": { message: string };
}

export type EventName = keyof EventMap;
/** `t` is when the event happened (performance.now()), earlier than now for replayed events. */
type AnyHandler = (ev: EventName, data: EventMap[EventName], t: number) => void;

const any: AnyHandler[] = [];
/** Events from before anyone listened, kept while dev tools load (`keepEarly`). */
let early: [EventName, EventMap[EventName], number][] | null = null;
const EARLY_MAX = 500;

export function emit<K extends EventName>(ev: K, data: EventMap[K]) {
  if (!any.length) {
    if (early && early.length < EARLY_MAX) early.push([ev, data, performance.now()]);
    return;
  }
  const t = performance.now();
  for (const h of any) h(ev, data, t);
}

/** Keep events until the first listener arrives (dev modes: the log loads as a lazy chunk). */
export function keepEarly() {
  early ??= [];
}

/** Listen to every event; returns an unsubscribe function. The first listener also gets the early events. */
export function onAny(h: AnyHandler): () => void {
  any.push(h);
  if (early) {
    for (const [ev, data, t] of early) h(ev, data, t);
    early = null;
  }
  return () => {
    const i = any.indexOf(h);
    if (i >= 0) any.splice(i, 1);
  };
}
