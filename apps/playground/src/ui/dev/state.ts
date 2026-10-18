import type { DevContext } from "../../dev/boot";
import { stateTree } from "../../dev/state";
import type { PanelTab } from "./panel";

const REFRESH_MS = 250;

/** A live tree of the current state (docs/DEV-MODE.md §4.3), 4 Hz while open. */
export class StateTab implements PanelTab {
  readonly el = document.createElement("section");
  private readonly tree: HTMLElement;
  /** Paths of open branches, kept across refreshes. */
  private open = new Set(["app", "audio", "world", "toys", "net"]);
  private timer = 0;
  private current: Record<string, unknown> = {};

  constructor(private ctx: DevContext) {
    this.el.className = "devp-state";
    this.el.innerHTML = `
      <div class="devp-row"><button data-act="copy-all">Copy all</button><span class="devp-note">Click a branch's ⧉ to copy it.</span></div>
      <div class="devp-tree"></div>`;
    this.tree = this.el.querySelector(".devp-tree")!;
    this.tree.addEventListener("toggle", (e) => {
      const d = e.target as HTMLDetailsElement;
      if (d.open) this.open.add(d.dataset.path!);
      else this.open.delete(d.dataset.path!);
    }, true);
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-act=copy-all]")) void navigator.clipboard.writeText(JSON.stringify(this.current, null, 2));
      const path = t.closest<HTMLElement>("[data-copy]")?.dataset.copy;
      if (path !== undefined) {
        e.preventDefault();
        void navigator.clipboard.writeText(JSON.stringify(at(this.current, path), null, 2));
      }
    });
  }

  shown(on: boolean) {
    clearInterval(this.timer);
    if (!on) return;
    this.render();
    this.timer = window.setInterval(() => this.render(), REFRESH_MS);
  }

  private render() {
    this.current = stateTree(this.ctx);
    this.tree.innerHTML = Object.entries(this.current).map(([k, v]) => node(k, v, k, this.open)).join("");
  }
}

function node(key: string, value: unknown, path: string, open: Set<string>): string {
  if (value !== null && typeof value === "object" && !(Array.isArray(value) && value.every((v) => typeof v !== "object"))) {
    const entries = Object.entries(value as Record<string, unknown>);
    const summary = Array.isArray(value) ? `[${value.length}]` : `{${entries.length}}`;
    return (
      `<details data-path="${esc(path)}"${open.has(path) ? " open" : ""}><summary><b>${esc(key)}</b> <i>${summary}</i>` +
      `<button class="devp-copy" data-copy="${esc(path)}" title="Copy as JSON">⧉</button></summary>` +
      entries.map(([k, v]) => node(k, v, `${path}.${k}`, open)).join("") +
      `</details>`
    );
  }
  return `<div class="devp-leaf"><b>${esc(key)}</b> <span>${esc(JSON.stringify(value) ?? "undefined")}</span></div>`;
}

function at(root: unknown, path: string): unknown {
  let cur = root;
  for (const k of path.split(".")) cur = (cur as Record<string, unknown> | null)?.[k];
  return cur;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
