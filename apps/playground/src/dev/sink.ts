import type { Log, LogEvent } from "./log";

const EVERY_MS = 2000;
const MAX_BATCH = 500;

/**
 * Writes this page load's events to devlog/sessions/ through the dev server
 * (dev-files.ts, docs/DEV-MODE.md §4.4): batched every 2 s, the rest on
 * pagehide. Only on the dev server; it stops for good if the server refuses
 * (another device on the LAN, a tunnel).
 */
export class DevlogSink {
  private queue: LogEvent[] = [];
  private timer = 0;
  private stopped = false;
  private readonly session = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("");
  private readonly url = new URL("__dev/log", new URL(import.meta.env.BASE_URL, location.href)).href;

  constructor(private log: Log) {
    // Everything logged before the sink started (app.boot first) goes in the first batch.
    this.queue.push(...log.entries());
    log.listeners.push((e) => {
      if (this.stopped) return;
      this.queue.push(e);
      if (this.queue.length > MAX_BATCH * 4) this.queue.splice(0, this.queue.length - MAX_BATCH * 4);
    });
    this.timer = window.setInterval(() => void this.flush(), EVERY_MS);
    addEventListener("pagehide", () => {
      this.log.flushPending();
      this.flush(true);
    });
  }

  private async flush(beacon = false) {
    if (this.stopped || !this.queue.length) return;
    const events = this.queue.splice(0, MAX_BATCH);
    const body = JSON.stringify({ session: this.session, build: __BUILD_ID__, events });
    if (beacon) {
      navigator.sendBeacon(this.url, new Blob([body], { type: "text/plain" }));
      return;
    }
    try {
      const res = await fetch(this.url, { method: "POST", body, headers: { "content-type": "application/json" } });
      if (res.status >= 400 && res.status < 500) this.stop(res.status);
    } catch {
      // Dev server restarting: keep the events for the next try.
      this.queue.unshift(...events);
    }
  }

  private stop(status: number) {
    this.stopped = true;
    this.queue = [];
    clearInterval(this.timer);
    const reason = status === 403 ? "the dev server only writes logs for this machine" : `the dev server answered ${status}`;
    this.log.log("app", status === 403 ? "info" : "warn", "app.sink", { written: false, reason });
  }
}
