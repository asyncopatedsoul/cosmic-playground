import type * as THREE from "three";
import type { AudioHost } from "../audio/host";
import { library } from "../persist/library";
import type { ToyTemplate } from "../persist/template";
import type { Stage } from "../render/stage";
import { TOYS, type ToyEntry } from "../toys/registry";
import type { World } from "../world";
import type { Variants } from "./variants";
import { emit } from "../events";

/** How long a press or a resting mouse waits before fanning out a toy's variants. */
const FAN_PRESS_MS = 450;
const FAN_HOVER_MS = 700;

/**
 * The chest: a drawer of hypertoys along the bottom edge. Tap a toy to place
 * it, drag it into the world to put it somewhere, drag a placed toy back onto
 * the chest to put it away. Tab toggles it. A toy with variants (SAVE-LOAD.md
 * §6.3) has a stack edge; long-press, right-click or rest on it to fan them out.
 */
export class Chest {
  private el: HTMLElement;
  private drawer: HTMLElement;
  /** Somewhere else a card can be dropped (the avatar hotbar); returns true when it took the card. */
  dropTarget: ((x: number, y: number, kind: string) => boolean) | null = null;
  /** Variants: set by main.ts; without it the chest shows base toys only. */
  variants: Variants | null = null;
  private fan: HTMLElement;
  private menu: HTMLElement;
  private fanBase: string | null = null;
  private hoverTimer = 0;

  constructor(
    private world: World,
    private stage: Stage,
    private audio: AudioHost,
  ) {
    this.el = document.getElementById("chest")!;
    this.el.innerHTML = `
      <button class="chest-handle" aria-label="Open the chest" title="Chest (Tab)">
        <svg viewBox="0 0 32 20"><path d="M3 9h26v9H3zM3 9c0-5 4-7 13-7s13 2 13 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><rect x="13.5" y="8" width="5" height="5" rx="1" fill="currentColor"/></svg>
      </button>
      <div class="chest-drawer" role="toolbar" aria-label="Hypertoys"></div>`;
    this.drawer = this.el.querySelector(".chest-drawer")!;
    this.el.querySelector(".chest-handle")!.addEventListener("click", () => this.toggle());

    this.fan = document.createElement("div");
    this.fan.className = "chest-fan";
    this.fan.hidden = true;
    this.fan.setAttribute("role", "toolbar");
    this.fan.setAttribute("aria-label", "Variants");
    this.el.prepend(this.fan);
    this.menu = document.createElement("div");
    this.menu.className = "chest-menu";
    this.menu.hidden = true;
    this.menu.setAttribute("role", "menu");
    document.body.append(this.menu);
    this.fan.addEventListener("pointerleave", () => this.scheduleHide());
    this.fan.addEventListener("pointerenter", () => clearTimeout(this.hoverTimer));
    addEventListener("pointerdown", (e) => {
      const t = e.target as Element;
      if (!this.menu.contains(t)) this.menu.hidden = true;
      if (!this.fan.contains(t) && !this.menu.contains(t) && !t.closest?.(".toy-card.has-variants")) this.hideFan();
    });
    addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      this.menu.hidden = true;
      this.hideFan();
    });
    library.listeners.push(() => this.render());

    // A .cosmic-toy.json dropped on the chest is added (the page-wide drop handler reads it).
    this.el.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) this.highlightDrop(true);
    });
    this.el.addEventListener("dragleave", () => this.highlightDrop(false));
    this.el.addEventListener("drop", () => this.highlightDrop(false));

    this.render();
  }

  /** (Re)build the cards: built-in toys, then a shelf of toys described as data. */
  render() {
    this.drawer.replaceChildren();
    let shelf = false;
    for (const entry of TOYS) {
      // A variant's own config entry shows in its base's fan, not as a card of its own.
      if (entry.config?.extends) continue;
      if (entry.config && !shelf) {
        shelf = true;
        const divider = document.createElement("span");
        divider.className = "chest-shelf";
        divider.title = "Toys made from configs";
        this.drawer.append(divider);
      }
      const card = document.createElement("button");
      card.className = "toy-card";
      card.style.setProperty("--toy", entry.color);
      card.title = `${entry.name} · ${entry.family}`;
      card.innerHTML = `${entry.icon}<span>${entry.name.split(" ").pop()}</span>`;
      this.drawer.append(card);
      const variants = this.variants ? library.forBase(entry.id) : [];
      if (variants.length) {
        card.classList.add("has-variants");
        card.dataset.base = entry.id;
        card.style.setProperty("--stack", String(Math.min(3, variants.length)));
        card.title += ` · ${variants.length === 1 ? "1 variant" : `${variants.length} variants`} (hold or right-click)`;
        card.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          this.showFan(entry, card);
        });
        card.addEventListener("pointerenter", (e) => {
          if (e.pointerType !== "mouse") return;
          clearTimeout(this.hoverTimer);
          this.hoverTimer = window.setTimeout(() => this.showFan(entry, card), FAN_HOVER_MS);
        });
        card.addEventListener("pointerleave", () => this.scheduleHide());
      }
      this.makeDraggable(card, entry.id, (at) => void this.world.add(entry.id, at), variants.length ? () => this.showFan(entry, card) : undefined);
    }
    // Keep an open fan open (and current) across redraws.
    if (this.fanBase) {
      const entry = TOYS.find((t) => t.id === this.fanBase);
      const card = this.drawer.querySelector<HTMLElement>(`.toy-card[data-base="${CSS.escape(this.fanBase)}"]`);
      if (entry && card) this.showFan(entry, card);
      else this.hideFan();
    }
  }

  /** Fan a toy's variants out above its card: each a normal card, tinted and badged. */
  private showFan(entry: ToyEntry, card: HTMLElement) {
    const v = this.variants;
    if (!v) return;
    clearTimeout(this.hoverTimer);
    this.fanBase = entry.id;
    this.fan.replaceChildren();
    for (const t of library.forBase(entry.id)) {
      const c = document.createElement("button");
      c.className = "toy-card variant";
      c.style.setProperty("--toy", t.tint ?? entry.color);
      c.title = `${t.name} · a ${entry.name} variant (right-click to rename, export or remove)`;
      c.innerHTML = `${entry.icon}${t.badge ? `<b class="toy-badge"></b>` : ""}<span></span>`;
      c.querySelector("span")!.textContent = t.name;
      if (t.badge) c.querySelector("b")!.textContent = t.badge;
      c.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showMenu(t, c);
      });
      this.makeDraggable(c, t.config?.id ?? t.base, (at) => void v.place(t, at), () => this.showMenu(t, c));
      this.fan.append(c);
    }
    const add = document.createElement("button");
    add.className = "toy-card variant-import";
    add.title = "Add a toy from a .cosmic-toy.json file (or drop one on the chest)";
    add.innerHTML = `<svg viewBox="0 0 48 48"><path d="M24 10v20M14 20l10 10 10-10M12 38h24" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Import</span>`;
    add.addEventListener("click", () => v.pick());
    this.fan.append(add);
    this.fan.hidden = false;
    for (const c of this.drawer.querySelectorAll(".fanned")) c.classList.remove("fanned");
    card.classList.add("fanned");
    // Centre the fan over its card, kept on screen.
    const r = card.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    const w = this.fan.offsetWidth;
    const left = Math.max(8 - host.left, Math.min(innerWidth - 8 - host.left - w, r.left + r.width / 2 - host.left - w / 2));
    this.fan.style.left = `${left}px`;
  }

  private scheduleHide() {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = window.setTimeout(() => {
      if (!this.fan.matches(":hover") && this.menu.hidden) this.hideFan();
    }, 500);
  }

  private hideFan() {
    clearTimeout(this.hoverTimer);
    this.fanBase = null;
    this.fan.hidden = true;
    for (const c of this.drawer.querySelectorAll(".fanned")) c.classList.remove("fanned");
  }

  /** Rename, export or remove a variant. */
  private showMenu(t: ToyTemplate, card: HTMLElement) {
    const v = this.variants!;
    this.menu.innerHTML = `
      <input class="chest-menu-name" maxlength="60" spellcheck="false" aria-label="Variant name" title="Rename">
      <button data-act="export" role="menuitem">Export file</button>
      <button data-act="remove" role="menuitem">Take out of the chest</button>`;
    const name = this.menu.querySelector("input")!;
    name.value = t.name;
    name.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") this.menu.hidden = true;
    });
    name.addEventListener("change", () => v.rename(t, name.value));
    this.menu.onclick = (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "export") v.exportFile(t);
      if (act === "remove") v.remove(t);
      if (act) this.menu.hidden = true;
    };
    this.menu.hidden = false;
    const r = card.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(innerWidth - 220, r.left))}px`;
    this.menu.style.bottom = `${innerHeight - r.top + 8}px`;
  }

  /** Tap to place, drag into the world (or onto the hotbar, as `kind`); `onHold` runs on a long press instead. */
  private makeDraggable(card: HTMLElement, kind: string, place: (at?: THREE.Vector3) => void, onHold?: () => void) {
    let ghost: HTMLElement | null = null;
    let start: { x: number; y: number } | null = null;
    let hold = 0;
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.audio.start();
      card.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(hold);
      if (onHold) {
        hold = window.setTimeout(() => {
          start = null;
          ghost?.remove();
          ghost = null;
          onHold();
        }, FAN_PRESS_MS);
      }
    });
    card.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
        clearTimeout(hold);
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.add("ghost");
        document.body.append(ghost);
      }
      if (ghost) ghost.style.transform = `translate(${e.clientX - 36}px, ${e.clientY - 36}px)`;
    });
    const finish = (e: PointerEvent, cancelled: boolean) => {
      clearTimeout(hold);
      if (!start) return;
      start = null;
      const dragged = !!ghost;
      ghost?.remove();
      ghost = null;
      if (cancelled) return;
      if (!dragged) {
        place();
        return;
      }
      if (this.dropTarget?.(e.clientX, e.clientY, kind)) return;
      if (document.elementFromPoint(e.clientX, e.clientY) === this.stage.canvas) {
        const at = this.stage.planePoint(e.clientX, e.clientY);
        place(at && at.length() < 12 ? at : undefined);
      }
    };
    card.addEventListener("pointerup", (e) => finish(e, false));
    card.addEventListener("pointercancel", (e) => finish(e, true));
  }

  toggle(open = !this.el.classList.contains("open")) {
    if (open !== this.el.classList.contains("open")) emit("player.chest", { open });
    this.el.classList.toggle("open", open);
    if (!open) this.hideFan();
  }

  isOver(x: number, y: number) {
    const r = this.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  highlightDrop(on: boolean) {
    this.el.classList.toggle("drop", on);
  }
}
