import type { FocusView, ListenMode } from "../focus/focus";
import { toyEntry } from "../toys/registry";
import type { World } from "../world";
import { GLYPHS, toyName } from "./sound";

const LISTEN: { mode: ListenMode; label: string; glyph: string }[] = [
  { mode: "set", label: "Ring full, others quiet", glyph: GLYPHS.focus },
  { mode: "soloSet", label: "Only the ring", glyph: GLYPHS.solo },
  { mode: "soloLead", label: "Only the lead", glyph: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4" fill="currentColor"/></svg>` },
];

const TRACE_GLYPH = `<svg viewBox="0 0 20 20"><path d="M1 14h18" stroke="currentColor" stroke-width="1.2" opacity=".5"/><path d="M1 10c2-5 4-5 6 0s4 5 6 0 4-5 6 0" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

/** How many times the `Tab ›` hint is shown (FOCUS-VIEW.md §5). */
const TAB_HINTS = 3;

/**
 * The focus bar (FOCUS-VIEW.md §5): ‹ and › to move the lead, the quick-select
 * strip of ring toys (a listbox), + to bring another toy onto the ring, the
 * listen switch, the Trace glyph and × to leave.
 */
export class FocusBar {
  private el: HTMLElement;
  private strip: HTMLElement;
  private menu: HTMLElement;
  private hints = 0;

  constructor(
    private world: World,
    private focus: FocusView,
  ) {
    this.el = document.createElement("nav");
    this.el.className = "focus-bar";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Focus view");
    this.el.innerHTML = `
      <button class="focus-prev" aria-label="Previous toy (Shift+Tab)" title="Previous (Shift+Tab)">‹</button>
      <div class="focus-strip" role="listbox" aria-label="Toys on the ring" aria-orientation="horizontal"></div>
      <button class="focus-add" aria-label="Add a toy to the ring" title="Add a toy" aria-haspopup="true">+</button>
      <button class="focus-next" aria-label="Next toy (Tab)" title="Next (Tab)">›</button>
      <span class="focus-sep"></span>
      <div class="focus-listen" role="radiogroup" aria-label="Listen">
        ${LISTEN.map((l) => `<button role="radio" data-mode="${l.mode}" title="${l.label}" aria-label="${l.label}">${l.glyph}</button>`).join("")}
      </div>
      <button class="focus-trace" aria-pressed="false" title="Pitch Trace (T)" aria-label="Pitch Trace">${TRACE_GLYPH}</button>
      <button class="focus-remove" title="Take the lead off the ring" aria-label="Take the lead off the ring">−</button>
      <button class="focus-close" title="Leave focus view (F or Esc)" aria-label="Leave focus view">×</button>
      <span class="focus-hint" hidden>Tab ›</span>
      <div class="focus-menu" role="menu" hidden></div>`;
    document.body.append(this.el);
    this.strip = this.el.querySelector(".focus-strip")!;
    this.menu = this.el.querySelector(".focus-menu")!;

    this.el.querySelector(".focus-prev")!.addEventListener("click", () => focus.cycle(-1));
    this.el.querySelector(".focus-next")!.addEventListener("click", () => focus.cycle(1));
    this.el.querySelector(".focus-close")!.addEventListener("click", () => focus.leave());
    this.el.querySelector(".focus-remove")!.addEventListener("click", () => {
      const t = focus.leadToy;
      if (t) focus.remove(t);
    });
    this.el.querySelector(".focus-trace")!.addEventListener("click", () => this.toggleTrace());
    this.el.querySelector(".focus-add")!.addEventListener("click", () => this.toggleMenu());
    this.el.querySelector(".focus-listen")!.addEventListener("click", (e) => {
      const mode = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.mode as ListenMode | undefined;
      if (mode) focus.setListen(mode);
    });
    this.strip.addEventListener("click", (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i !== undefined) focus.setLead(Number(i));
    });
    this.strip.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        focus.cycle(e.key === "ArrowRight" ? 1 : -1);
        this.strip.querySelector<HTMLElement>("[aria-selected=true]")?.focus();
      }
    });
    this.menu.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-id]")?.dataset.id;
      const toy = id ? world.byId(id) : null;
      if (toy) focus.add(toy);
      this.menu.hidden = true;
    });
    // A swipe along the bar moves the lead (touch).
    let swipe: number | null = null;
    this.el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse") swipe = e.clientX;
    });
    this.el.addEventListener("pointerup", (e) => {
      if (swipe !== null && Math.abs(e.clientX - swipe) > 50) focus.cycle(e.clientX < swipe ? 1 : -1);
      swipe = null;
    });

    const prev = focus.onChange;
    focus.onChange = () => {
      prev?.();
      this.render();
    };
    world.mix.listeners.push(() => this.render());
  }

  toggleTrace(open?: boolean) {
    if (!this.focus.active) return;
    this.focus.setTrace(open);
  }

  /** Show `Tab ›` the first few times Tab cycles. */
  tabbed() {
    const hint = this.el.querySelector<HTMLElement>(".focus-hint")!;
    if (this.hints >= TAB_HINTS) return;
    this.hints++;
    hint.hidden = false;
    setTimeout(() => (hint.hidden = true), 1400);
  }

  private toggleMenu() {
    this.menu.hidden = !this.menu.hidden;
    if (this.menu.hidden) return;
    const off = this.world.toys.filter((t) => t && !this.focus.ring.includes(t));
    const full = this.focus.ring.length >= this.focus.max;
    this.menu.innerHTML = off.length
      ? `<small>${full ? "Swap in for the lead" : "Add to the ring"}</small>` +
        off.map((t) => `<button role="menuitem" data-id="${t!.id}" style="--toy:${t!.css}">${toyEntry(t!.entryId)?.icon ?? ""}<span>${toyName(t!)}</span></button>`).join("")
      : `<small>Every toy is on the ring</small>`;
    this.menu.querySelector<HTMLElement>("button")?.focus();
  }

  private render() {
    const f = this.focus;
    this.el.hidden = !f.active;
    if (!f.active) {
      this.menu.hidden = true;
      return;
    }
    // Sit just under the HUD, which wraps to more rows on narrow screens.
    const hud = document.getElementById("hud")?.getBoundingClientRect();
    if (hud) this.el.style.top = `${Math.round(hud.bottom + 8)}px`;
    this.strip.replaceChildren(
      ...f.ring.map((toy, i) => {
        const b = document.createElement("button");
        b.className = "focus-icon";
        b.dataset.i = String(i);
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", String(i === f.lead));
        b.tabIndex = i === f.lead ? 0 : -1;
        b.style.setProperty("--toy", toy.css);
        b.title = `${toyName(toy)} (${i + 1})`;
        b.setAttribute("aria-label", `${toyName(toy)}, ${i + 1} of ${f.ring.length}`);
        b.innerHTML = toyEntry(toy.entryId)?.icon ?? "";
        return b;
      }),
    );
    const single = f.ring.length < 2;
    for (const sel of [".focus-prev", ".focus-next"]) this.el.querySelector<HTMLButtonElement>(sel)!.disabled = single;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>(".focus-listen button")) b.setAttribute("aria-checked", String(b.dataset.mode === f.listen));
    this.el.querySelector(".focus-trace")!.setAttribute("aria-pressed", String(f.trace.open));
  }
}
