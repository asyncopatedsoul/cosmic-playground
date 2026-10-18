import type { DevContext } from "../../dev/boot";
import { CHANNELS, type Channel } from "../../dev/config";
import { formatLine, type Log, type LogEvent } from "../../dev/log";
import type { PanelTab } from "./panel";

const ROW = 18;
const RANK = { debug: 4, info: 3, warn: 2, error: 1 } as const;

/**
 * The live log (docs/DEV-MODE.md §4.3): channel chips, a level floor, text
 * search, follow and pause. Only the visible rows are in the DOM.
 */
export class LogsTab implements PanelTab {
  readonly el = document.createElement("section");
  private readonly list: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly count: HTMLElement;
  private hidden = new Set<Channel>();
  private floor: keyof typeof RANK = "debug";
  private search = "";
  private follow = true;
  private paused: readonly LogEvent[] | null = null;
  private view: LogEvent[] = [];
  private visible = false;
  private dirty = true;
  private raf = 0;

  constructor(
    private ctx: DevContext,
    private log: Log,
  ) {
    this.el.className = "devp-logs";
    this.el.innerHTML = `
      <div class="devp-chips">${CHANNELS.map((c) => `<button class="devp-chip on" data-ch="${c}" aria-pressed="true">${c}</button>`).join("")}</div>
      <div class="devp-row">
        <select data-set="floor" aria-label="Lowest level shown"><option value="debug">debug+</option><option value="info">info+</option><option value="warn">warn+</option><option value="error">error</option></select>
        <input type="search" placeholder="Search" aria-label="Search the log">
        <label class="devp-check"><input type="checkbox" data-set="follow" checked> Follow</label>
        <button data-act="pause" aria-pressed="false">Pause</button>
      </div>
      <div class="devp-list" tabindex="0"><div class="devp-rows"></div></div>
      <div class="devp-row">
        <span class="devp-count"></span>
        <button data-act="copy" title="The last 200 shown events as text, for an issue or a chat">Copy last 200</button>
        <button data-act="save" title="Every event in memory as JSONL">Save log</button>
        <button data-act="clear">Clear</button>
      </div>`;
    this.list = this.el.querySelector(".devp-list")!;
    this.rows = this.el.querySelector(".devp-rows")!;
    this.count = this.el.querySelector(".devp-count")!;

    log.listeners.push(() => {
      this.dirty = true;
      this.schedule();
    });
    this.list.addEventListener("scroll", () => {
      const atEnd = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - ROW;
      if (!atEnd && this.follow) this.setFollow(false);
      this.schedule();
    });
    this.el.addEventListener("input", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.type === "search") {
        this.search = t.value.toLowerCase();
        this.refilter();
      }
    });
    this.el.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement & HTMLSelectElement;
      if (t.dataset.set === "floor") {
        this.floor = t.value as keyof typeof RANK;
        this.refilter();
      } else if (t.dataset.set === "follow") this.setFollow(t.checked);
    });
    this.el.addEventListener("click", (e) => this.click(e));
  }

  shown(on: boolean) {
    this.visible = on;
    if (on) this.schedule();
  }

  private click(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const ch = target.closest<HTMLElement>("[data-ch]")?.dataset.ch as Channel | undefined;
    if (ch) {
      const on = this.hidden.has(ch);
      if (on) this.hidden.delete(ch);
      else this.hidden.add(ch);
      target.classList.toggle("on", on);
      target.setAttribute("aria-pressed", String(on));
      this.refilter();
      return;
    }
    const toyId = target.closest<HTMLElement>("[data-toy]")?.dataset.toy;
    if (toyId) {
      const toy = this.ctx.world.byId(toyId);
      if (toy) this.ctx.editor.open(toy);
      return;
    }
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "pause") {
      this.paused = this.paused ? null : [...this.log.entries()];
      target.setAttribute("aria-pressed", String(!!this.paused));
      target.textContent = this.paused ? "Resume" : "Pause";
      this.refilter();
    } else if (act === "copy") {
      void navigator.clipboard.writeText(this.view.slice(-200).map(formatLine).join("\n"));
    } else if (act === "save") {
      this.log.flushPending();
      const blob = new Blob([this.log.toJSONL()], { type: "application/x-ndjson" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cosmic-log-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (act === "clear") {
      this.log.clear();
      this.paused = this.paused ? [] : null;
      this.refilter();
    }
  }

  private setFollow(on: boolean) {
    this.follow = on;
    this.el.querySelector<HTMLInputElement>('[data-set="follow"]')!.checked = on;
    if (on) this.schedule();
  }

  private refilter() {
    this.dirty = true;
    this.schedule();
  }

  /** Render on the next frame, at most once per frame, only while visible. */
  private schedule() {
    if (!this.visible || this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render() {
    if (this.dirty) {
      this.dirty = false;
      const src = this.paused ?? this.log.entries();
      const floor = RANK[this.floor];
      this.view = src.filter(
        (e) => !this.hidden.has(e.ch) && RANK[e.lvl] <= floor && (!this.search || formatLine(e).toLowerCase().includes(this.search)),
      );
      this.rows.style.height = `${this.view.length * ROW}px`;
      this.count.textContent = `${this.view.length} shown${this.paused ? " (paused)" : ""}`;
      if (this.follow) this.list.scrollTop = this.list.scrollHeight;
    }
    const first = Math.max(0, Math.floor(this.list.scrollTop / ROW) - 5);
    const last = Math.min(this.view.length, first + Math.ceil(this.list.clientHeight / ROW) + 10);
    const html: string[] = [];
    for (let i = first; i < last; i++) html.push(row(this.view[i], i));
    this.rows.innerHTML = html.join("");
  }
}

function row(e: LogEvent, i: number): string {
  const data = e.data ? esc(JSON.stringify(e.data)) : "";
  const toy = e.toy ? `<a data-toy="${esc(e.toy)}" title="Open this toy">${esc(e.toy)}</a>` : "";
  return (
    `<div class="devp-ev lvl-${e.lvl} ch-${e.ch}" style="top:${i * ROW}px" title="${esc(formatLine(e))}">` +
    `<span class="t">${(e.t / 1000).toFixed(2)}</span><span class="b">${e.beat !== undefined ? e.beat.toFixed(1) : ""}</span>` +
    `<span class="ch">${e.ch}</span><span class="ev">${esc(e.ev)}</span>${toy}<span class="d">${data}</span></div>`
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
