import { PuzzleMode, solvedPuzzles } from "../modes/puzzle";
import { SCENARIOS } from "../modes/scenarios";
import type { ScenarioDoc } from "../modes/scenario";
import type { World } from "../world";
import { announce } from "./announce";

const GLYPH = `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6" fill="currentColor"/><circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 1.6"/><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".6"/></svg>`;

/**
 * The scenario shelf (MODES.md §9 P3): puzzle icons, no titles needed to
 * choose. A series unlocks in order; solved puzzles can be replayed any time.
 * While a puzzle is open the button shows its progress as dots.
 */
export class PuzzleShelf {
  mode: PuzzleMode | null = null;
  /** Called when a puzzle starts or ends (to close the chest etc.). */
  onChange: ((mode: PuzzleMode | null) => void) | null = null;
  private button: HTMLButtonElement;
  private sheet: HTMLElement;

  constructor(
    hud: HTMLElement,
    private world: World,
    /** Dev builds open every puzzle, not just the next in the series. */
    private unlockAll: boolean,
  ) {
    this.button = document.createElement("button");
    this.button.className = "hud-puzzles";
    this.button.title = "Puzzles";
    this.button.setAttribute("aria-label", "Puzzles");
    this.button.setAttribute("aria-expanded", "false");
    hud.prepend(this.button);
    this.sheet = document.createElement("div");
    this.sheet.className = "puzzle-shelf";
    this.sheet.hidden = true;
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-label", "Puzzles");
    document.body.append(this.sheet);

    this.button.addEventListener("click", () => this.toggle());
    this.sheet.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b || b.disabled) return;
      if (b.dataset.leave !== undefined) this.leave();
      else if (b.dataset.id) this.open(b.dataset.id);
      this.toggle(false);
    });
    addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.sheet.hidden) this.toggle(false);
    });
    this.render();
  }

  toggle(open = this.sheet.hidden) {
    this.sheet.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (open) this.render();
  }

  open(id: string) {
    const doc = SCENARIOS.find((s) => s.id === id || s.id === `puzzle-${id}`);
    if (!doc) return null;
    this.mode = new PuzzleMode(this.world, doc);
    this.mode.onProgress = () => this.render();
    this.mode.start();
    announce(`${doc.name}: find every layer of the Heart`);
    this.render();
    this.onChange?.(this.mode);
    return this.mode;
  }

  leave() {
    this.mode?.dispose();
    this.mode = null;
    this.render();
    this.onChange?.(null);
  }

  unlocked(s: ScenarioDoc, solved: string[]) {
    if (this.unlockAll) return true;
    const prev = SCENARIOS.filter((x) => x.series === s.series && x.order < s.order);
    return prev.every((x) => solved.includes(x.id));
  }

  render() {
    const solved = solvedPuzzles();
    const m = this.mode;
    if (m) {
      const req = m.states.filter((s) => !s.goal.optional);
      const dots = req.map((s) => `<i class="${s.locked ? "on" : ""}"></i>`).join("");
      this.button.innerHTML = `${GLYPH}<span class="puzzle-dots" aria-hidden="true">${dots}</span>`;
      this.button.classList.toggle("bloomed", m.solved);
      this.button.title = `${m.doc.name}: ${req.filter((s) => s.locked).length} of ${req.length} layers`;
    } else {
      this.button.innerHTML = GLYPH;
      this.button.classList.remove("bloomed");
      this.button.title = "Puzzles";
    }
    this.sheet.innerHTML =
      SCENARIOS.map((s) => {
        const open = this.unlocked(s, solved);
        const done = solved.includes(s.id);
        const cls = [done ? "solved" : "", m?.doc.id === s.id ? "current" : ""].join(" ");
        return `<button data-id="${s.id}" class="${cls}" ${open ? "" : "disabled"} title="${s.name}${done ? " (solved)" : open ? "" : " (locked)"}" aria-label="${s.name}">${s.icon}${done ? `<b aria-hidden="true">✓</b>` : ""}</button>`;
      }).join("") + (m ? `<button data-leave title="Back to the sandbox (keeps your toys)" aria-label="Leave puzzle">✕</button>` : "");
  }
}
