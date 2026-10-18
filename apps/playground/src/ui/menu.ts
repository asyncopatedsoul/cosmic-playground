import { solvedPuzzles } from "../modes/puzzle";
import { SCENARIOS } from "../modes/scenarios";
import type { WorldMeta } from "../persist/store";
import { load } from "../prefs";
import { ago, esc, type Constellations, type LastWorld } from "./constellations";
import type { PuzzleShelf } from "./puzzles";

const STAR = `<svg viewBox="0 0 20 20"><path d="M10 2.5l2.2 5.1 5.3.4-4 3.6 1.2 5.3L10 14.1l-4.7 2.8 1.2-5.3-4-3.6 5.3-.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const NEW = `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".5"/><path d="M10 6v8M6 10h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const RINGS = `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6" fill="currentColor"/><circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 1.6"/><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".6"/></svg>`;
const PEOPLE = `<svg viewBox="0 0 20 20"><circle cx="7" cy="7" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="14" cy="8" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M1.5 17c.5-3.5 3-5 5.5-5s5 1.5 5.5 5M12 12.4c3 0 5.6 1.3 6 4.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const FILE = `<svg viewBox="0 0 20 20"><path d="M5 2.5h6.5L15.5 6.5v11h-10.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10.5 15V9m-2.5 2.5 2.5-2.5 2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const PLAY = `<svg viewBox="0 0 20 20"><path d="M6 3.5v13l11-6.5z" fill="currentColor"/></svg>`;
const WORLD = `<svg viewBox="0 0 20 20"><path d="M3.5 13.5 8 6.5l5 4 3.5-6" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".6"/><circle cx="3.5" cy="13.5" r="1.7" fill="currentColor"/><circle cx="8" cy="6.5" r="1.7" fill="currentColor"/><circle cx="13" cy="10.5" r="1.7" fill="currentColor"/><circle cx="16.5" cy="4.5" r="1.7" fill="currentColor"/></svg>`;

/** How long a deleted world can be brought back (MAIN-MENU.md §4.2). */
const UNDO_MS = 5_000;

/** What the player was last doing, written by the shell (MAIN-MENU.md §4.3). */
export type Last = { kind: "world" } | { kind: "puzzle"; id: string } | { kind: "room"; code: string };
export const LAST_KEY = "cosmic.last";

/** Every way into a world from the menu; the shell does the entering. */
export type Entry =
  | { kind: "continue" }
  | { kind: "new" }
  | { kind: "saved"; id: string }
  | { kind: "file" }
  | { kind: "puzzle"; id: string }
  | { kind: "together" }
  | { kind: "rejoin"; code: string };

/**
 * The main menu (docs/MAIN-MENU.md §4): Continue, New world, Puzzles, Play
 * together, Open file and every saved world. It reads saves through
 * Constellations and hands every way in to `onEnter`.
 */
export class Menu {
  onEnter: ((e: Entry) => void) | null = null;
  readonly el = document.createElement("main");
  private page: "home" | "puzzles" = "home";
  private undoTimer = 0;
  private renaming: string | null = null;

  constructor(
    private saves: Constellations,
    private puzzles: PuzzleShelf,
    /** Whether `?room=` codes can be rejoined from here (a relay-served page). */
    private canRejoin: (code: string) => boolean,
  ) {
    this.el.id = "menu";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Main menu");
    document.body.append(this.el);
    this.el.addEventListener("click", (e) => void this.click(e));
    this.el.addEventListener("keydown", (e) => this.key(e));
  }

  get open() {
    return !this.el.hidden;
  }

  async show() {
    this.page = "home";
    this.el.hidden = false;
    await this.render();
    this.el.querySelector<HTMLElement>(".menu-continue [data-act], .menu-play, .menu-actions button")?.focus({ preventScroll: true });
  }

  hide() {
    this.el.hidden = true;
    this.hideUndo();
  }

  // ---- rendering --------------------------------------------------------------

  private async render() {
    if (this.page === "puzzles") return this.renderPuzzles();
    const [last, saved] = await Promise.all([this.saves.lastWorld(), this.saves.listSaved()]);
    const was = load<Last | null>(LAST_KEY, null);
    const puzzle = was?.kind === "puzzle" ? SCENARIOS.find((s) => s.id === was.id) : undefined;
    const firstRun = !last && !saved?.length && !solvedPuzzles().length && !puzzle && was?.kind !== "room";
    this.el.classList.toggle("first", firstRun);

    this.el.innerHTML = `
      <header class="menu-top">
        <h1>Cosmic Playground</h1>
        <a class="menu-help" href="guide.html" target="_blank" rel="noopener" aria-label="Help" title="Help">?</a>
      </header>
      <div class="menu-main">
        ${firstRun ? `<button class="menu-play" data-act="new">${PLAY}<span>Play</span></button>` : this.continueCard(last, was, puzzle)}
        <nav class="menu-actions" aria-label="Start">
          ${firstRun ? "" : `<button data-act="new">${NEW}<span>New world</span></button>`}
          <button data-act="puzzles">${RINGS}<span>Puzzles</span></button>
          <button data-act="together">${PEOPLE}<span>Play together</span></button>
          <button data-act="file">${FILE}<span>Open file</span></button>
        </nav>
      </div>
      ${firstRun ? "" : `<section class="menu-worlds" aria-label="Your worlds"><h2>Your worlds</h2>${this.grid(saved, last)}</section>`}
      <div class="menu-undo" role="status" hidden></div>`;
  }

  private continueCard(last: LastWorld | null, was: Last | null, puzzle: (typeof SCENARIOS)[number] | undefined): string {
    if (puzzle) {
      const also = last ? `<button class="menu-also" data-act="continue">or your world <b>${esc(last.doc.name)}</b></button>` : "";
      return `<div class="menu-continue puzzle">
        <button data-act="puzzle" data-id="${esc(puzzle.id)}" class="menu-card">
          <span class="menu-thumb">${puzzle.icon}</span>
          <span class="menu-card-text"><b>${PLAY} Continue</b><span>${esc(puzzle.name)}</span><small>Puzzle</small></span>
        </button>${also}</div>`;
    }
    const rejoin = was?.kind === "room" && this.canRejoin(was.code) ? `<button class="menu-also" data-act="rejoin" data-code="${esc(was.code)}">Rejoin room <b>${esc(was.code)}</b></button>` : "";
    if (!last) return rejoin ? `<div class="menu-continue">${rejoin}</div>` : "";
    const d = last.doc;
    const keep = last.of ? "" : `<button class="menu-keep" data-act="keep" title="Keep this world in Your worlds" aria-label="Keep ${esc(d.name)}">${STAR}</button>`;
    return `<div class="menu-continue">
      <button data-act="continue" class="menu-card">
        ${d.thumbnail ? `<img class="menu-thumb" src="${esc(d.thumbnail)}" alt="">` : `<span class="menu-thumb">${WORLD}</span>`}
        <span class="menu-card-text"><b>${PLAY} Continue</b><span>${esc(d.name)}</span><small>${ago(d.modified)} · ${toys(d.toys.length)}</small></span>
      </button>${keep}${rejoin}</div>`;
  }

  private grid(saved: WorldMeta[] | null, last: LastWorld | null): string {
    if (!saved) return `<p class="menu-empty">Saving is off in this window; Open file still works.</p>`;
    if (!saved.length) return `<p class="menu-empty">Worlds you save (${WORLD_HINT}) show up here.</p>`;
    return `<ul class="menu-grid">${saved
      .map((r) => {
        const unsaved = last?.of === r.id && last.doc.modified > r.modified;
        const thumb = (unsaved ? last!.doc.thumbnail : r.thumbnail) ?? r.thumbnail;
        const name = this.renaming === r.id ? `<input class="menu-rename" data-id="${esc(r.id)}" value="${esc(r.name)}" maxlength="60" spellcheck="false" aria-label="New name">` : `<span class="menu-tile-name">${esc(r.name)}</span>`;
        return `<li class="menu-tile${unsaved ? " unsaved" : ""}">
          <button data-act="open" data-id="${esc(r.id)}" title="Open ${esc(r.name)}${unsaved ? " (changed since it was saved)" : ""}">
            ${thumb ? `<img src="${esc(thumb)}" alt="">` : `<span class="menu-tile-thumb">${WORLD}</span>`}
            <i class="menu-dot" aria-hidden="true"></i>
          </button>
          <div class="menu-tile-foot">
            ${name}
            <small>${ago(unsaved ? last!.doc.modified : r.modified)} · ${toys(unsaved ? last!.doc.toys.length : r.toys)}</small>
          </div>
          <button class="menu-more" data-act="more" data-id="${esc(r.id)}" aria-label="More for ${esc(r.name)}" aria-expanded="false">⋯</button>
          <div class="menu-tile-menu" hidden>
            <button data-act="rename" data-id="${esc(r.id)}">Rename</button>
            <button data-act="export" data-id="${esc(r.id)}">Export file</button>
            <button data-act="delete" data-id="${esc(r.id)}" class="bad">Delete</button>
          </div>
        </li>`;
      })
      .join("")}</ul>`;
  }

  private renderPuzzles() {
    const solved = solvedPuzzles();
    this.el.classList.remove("first");
    this.el.innerHTML = `
      <header class="menu-top">
        <button class="menu-back" data-act="back" aria-label="Back">‹</button>
        <h1>Puzzles</h1>
      </header>
      <ul class="menu-puzzles">${SCENARIOS.map((s) => {
        const open = this.puzzles.unlocked(s, solved);
        const done = solved.includes(s.id);
        return `<li><button data-act="puzzle" data-id="${esc(s.id)}" class="${done ? "solved" : ""}" ${open ? "" : "disabled"}>
          <span class="menu-thumb">${s.icon}</span><span>${esc(s.name)}</span>${done ? `<b aria-label="solved">✓</b>` : open ? "" : `<small>locked</small>`}
        </button></li>`;
      }).join("")}</ul>
      <div class="menu-undo" role="status" hidden></div>`;
    this.el.querySelector<HTMLElement>(".menu-puzzles button:not([disabled])")?.focus({ preventScroll: true });
  }

  // ---- actions ------------------------------------------------------------------

  private async click(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b || (b as HTMLButtonElement).disabled) {
      this.closeTileMenus();
      return;
    }
    const act = b.dataset.act!;
    const id = b.dataset.id ?? "";
    if (act !== "more") this.closeTileMenus();
    switch (act) {
      case "continue":
        return this.onEnter?.({ kind: "continue" });
      case "new":
        return this.onEnter?.({ kind: "new" });
      case "open":
        return this.onEnter?.({ kind: "saved", id });
      case "file":
        return this.onEnter?.({ kind: "file" });
      case "together":
        return this.onEnter?.({ kind: "together" });
      case "rejoin":
        return this.onEnter?.({ kind: "rejoin", code: b.dataset.code! });
      case "puzzle":
        return this.onEnter?.({ kind: "puzzle", id });
      case "puzzles":
        this.page = "puzzles";
        return this.render();
      case "back":
        this.page = "home";
        await this.render();
        this.el.querySelector<HTMLElement>("[data-act=puzzles]")?.focus();
        return;
      case "keep":
        if (await this.saves.keepLast()) await this.render();
        return;
      case "more": {
        const menu = b.parentElement!.querySelector<HTMLElement>(".menu-tile-menu")!;
        const open = menu.hidden;
        this.closeTileMenus();
        menu.hidden = !open;
        b.setAttribute("aria-expanded", String(open));
        if (open) menu.querySelector("button")?.focus();
        return;
      }
      case "rename":
        this.renaming = id;
        await this.render();
        this.startRename(id);
        return;
      case "export":
        return this.saves.exportSaved(id);
      case "delete": {
        const name = b.closest(".menu-tile")?.querySelector(".menu-tile-name")?.textContent ?? "world";
        const undo = await this.saves.removeSaved(id);
        await this.render();
        if (undo) this.offerUndo(name, undo);
        return;
      }
    }
  }

  private startRename(id: string) {
    const input = this.el.querySelector<HTMLInputElement>(`.menu-rename[data-id="${CSS.escape(id)}"]`);
    if (!input) return;
    input.focus();
    input.select();
    let done = false;
    const finish = async (keep: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      if (keep) await this.saves.renameSaved(id, input.value);
      await this.render();
      this.el.querySelector<HTMLElement>(`[data-act=open][data-id="${CSS.escape(id)}"]`)?.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void finish(true);
      if (e.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
  }

  private offerUndo(name: string, undo: () => Promise<void>) {
    const bar = this.el.querySelector<HTMLElement>(".menu-undo")!;
    bar.innerHTML = `<span>Deleted <b>${esc(name)}</b></span><button data-undo>Undo</button>`;
    bar.hidden = false;
    bar.querySelector("[data-undo]")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      this.hideUndo();
      await undo();
      await this.render();
    });
    clearTimeout(this.undoTimer);
    this.undoTimer = window.setTimeout(() => this.hideUndo(), UNDO_MS);
  }

  private hideUndo() {
    clearTimeout(this.undoTimer);
    const bar = this.el.querySelector<HTMLElement>(".menu-undo");
    if (bar) bar.hidden = true;
  }

  private closeTileMenus() {
    for (const m of this.el.querySelectorAll<HTMLElement>(".menu-tile-menu")) m.hidden = true;
    for (const b of this.el.querySelectorAll("[data-act=more]")) b.setAttribute("aria-expanded", "false");
  }

  private key(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (this.el.querySelector(".menu-tile-menu:not([hidden])")) this.closeTileMenus();
    else if (this.page === "puzzles") this.el.querySelector<HTMLElement>("[data-act=back]")?.click();
  }
}

const WORLD_HINT = "Ctrl+S, or Save in a world's Constellations";

function toys(n: number) {
  return `${n} toy${n === 1 ? "" : "s"}`;
}
