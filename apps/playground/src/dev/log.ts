import { CHANNELS, type Channel, type DevConfig, type Level } from "./config";

/** One structured event (docs/DEV-MODE.md §4.1). */
export interface LogEvent {
  /** Increases by one per event, for the viewer and the sink. */
  seq: number;
  /** ms since page load. */
  t: number;
  /** Engine beat, if audio is running. */
  beat?: number;
  ch: Channel;
  lvl: Exclude<Level, "off">;
  /** Stable dotted name, e.g. "toy.param", "net.status". */
  ev: string;
  /** Stable toy id, when the event is about a toy. */
  toy?: string;
  data?: Record<string, unknown>;
}

const RANK: Record<Level, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };

interface Pending {
  timer: number;
  ch: Channel;
  lvl: LogEvent["lvl"];
  ev: string;
  toy?: string;
  /** First and latest value of each key in the window. */
  values: Map<string, [unknown, unknown]>;
  n: number;
}

/**
 * The developer log: a ring of events, per-channel levels, and coalescing for
 * continuous changes (a drag is one `toy.param` event per window with the
 * first and last value, not sixty).
 */
export class Log {
  readonly listeners: ((e: LogEvent) => void)[] = [];
  private ring: LogEvent[] = [];
  private seq = 0;
  private levels: Record<Channel, number>;
  private pending = new Map<string, Pending>();

  constructor(
    private config: DevConfig["log"],
    /** The engine beat now, if known. */
    private beat: () => number | undefined,
  ) {
    this.levels = this.rank(config.channels);
  }

  get capacity() {
    return this.config.ring;
  }

  /** Whether `ch` records events at `lvl`. Check before building expensive data. */
  on(ch: Channel, lvl: LogEvent["lvl"] = "info"): boolean {
    return this.levels[ch] >= RANK[lvl];
  }

  setLevel(ch: Channel, lvl: Level) {
    this.config.channels[ch] = lvl;
    this.levels = this.rank(this.config.channels);
  }

  setConsole(on: boolean) {
    this.config.console = on;
  }

  /** `at`: when it happened, for events logged late (replayed from before the log existed). */
  log(ch: Channel, lvl: LogEvent["lvl"], ev: string, data?: Record<string, unknown>, toy?: string, at?: number) {
    if (this.levels[ch] < RANK[lvl]) return;
    const e: LogEvent = { seq: ++this.seq, t: Math.round((at ?? performance.now()) * 10) / 10, ch, lvl, ev };
    const beat = at === undefined ? this.beat() : undefined;
    if (beat !== undefined) e.beat = Math.round(beat * 100) / 100;
    if (toy) e.toy = toy;
    if (data) e.data = data;
    this.ring.push(e);
    // Trim in chunks, not on every push.
    if (this.ring.length > this.config.ring * 1.25) this.ring = this.ring.slice(-this.config.ring);
    if (this.config.console) consoleLine(e);
    for (const l of this.listeners) l(e);
  }

  /**
   * Coalesce changes under `key` for the event's throttle window (log.throttle,
   * by event name): one event per window with `{ key: [first, last] }` and `n`.
   */
  change(ch: Channel, lvl: LogEvent["lvl"], ev: string, toy: string | undefined, values: Record<string, [unknown, unknown]>) {
    if (this.levels[ch] < RANK[lvl]) return;
    const ms = this.config.throttle[ev] ?? 0;
    if (ms <= 0) {
      this.log(ch, lvl, ev, { ...values }, toy);
      return;
    }
    const key = `${ev}:${toy ?? ""}`;
    let p = this.pending.get(key);
    if (!p) {
      p = { timer: window.setTimeout(() => this.settle(key), ms), ch, lvl, ev, toy, values: new Map(), n: 0 };
      this.pending.set(key, p);
    }
    p.n++;
    for (const [k, [from, to]] of Object.entries(values)) {
      const had = p.values.get(k);
      p.values.set(k, [had ? had[0] : from, to]);
    }
  }

  /** Write out every coalescing window now (before export or unload). */
  flushPending() {
    for (const key of [...this.pending.keys()]) this.settle(key);
  }

  /** Events in order, oldest first. */
  entries(): readonly LogEvent[] {
    if (this.ring.length > this.config.ring) this.ring = this.ring.slice(-this.config.ring);
    return this.ring;
  }

  clear() {
    this.ring = [];
  }

  toJSONL(events: readonly LogEvent[] = this.entries()): string {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  private settle(key: string) {
    const p = this.pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    // A window that ended where it started (a drag that didn't move) isn't a change.
    const data: Record<string, unknown> = {};
    for (const [k, v] of p.values) if (JSON.stringify(v[0]) !== JSON.stringify(v[1])) data[k] = v;
    if (!Object.keys(data).length) return;
    if (p.n > 1) data.n = p.n;
    this.log(p.ch, p.lvl, p.ev, data, p.toy);
  }

  private rank(channels: Record<Channel, Level>): Record<Channel, number> {
    return Object.fromEntries(CHANNELS.map((c) => [c, RANK[channels[c]] ?? RANK.info])) as Record<Channel, number>;
  }
}

/** One readable line: `81.23s b129.50 player info player.grab t_9F3KQ2ZB {"seat":1}`. */
export function formatLine(e: LogEvent): string {
  const parts = [`${(e.t / 1000).toFixed(2)}s`];
  if (e.beat !== undefined) parts.push(`b${e.beat.toFixed(2)}`);
  parts.push(e.ch, e.lvl, e.ev);
  if (e.toy) parts.push(e.toy);
  if (e.data) parts.push(JSON.stringify(e.data));
  return parts.join(" ");
}

function consoleLine(e: LogEvent) {
  const fn = e.lvl === "error" ? console.error : e.lvl === "warn" ? console.warn : e.lvl === "debug" ? console.debug : console.info;
  fn(`[${e.ch}] ${e.ev}`, e.toy ?? "", e.data ?? "");
}
