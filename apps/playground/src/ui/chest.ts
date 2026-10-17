import type { AudioHost } from "../audio/host";
import type { Stage } from "../render/stage";
import { TOYS } from "../toys/registry";
import type { World } from "../world";
import { emit } from "../events";

/**
 * The chest: a drawer of hypertoys along the bottom edge. Tap a toy to place
 * it, drag it into the world to put it somewhere, drag a placed toy back onto
 * the chest to put it away. Tab toggles it.
 */
export class Chest {
  private el: HTMLElement;
  private drawer: HTMLElement;
  /** Somewhere else a card can be dropped (the avatar hotbar); returns true when it took the card. */
  dropTarget: ((x: number, y: number, kind: string) => boolean) | null = null;

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

    this.render();
  }

  /** (Re)build the cards: built-in toys, then a shelf of toys described as data. */
  render() {
    this.drawer.replaceChildren();
    let shelf = false;
    for (const entry of TOYS) {
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
      this.makeDraggable(card, entry.id);
    }
  }

  private makeDraggable(card: HTMLElement, kind: string) {
    let ghost: HTMLElement | null = null;
    let start: { x: number; y: number } | null = null;
    card.addEventListener("pointerdown", (e) => {
      this.audio.start();
      card.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
    });
    card.addEventListener("pointermove", (e) => {
      if (!start) return;
      if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) {
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.add("ghost");
        document.body.append(ghost);
      }
      if (ghost) ghost.style.transform = `translate(${e.clientX - 36}px, ${e.clientY - 36}px)`;
    });
    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (!start) return;
      start = null;
      const dragged = !!ghost;
      ghost?.remove();
      ghost = null;
      if (cancelled) return;
      if (!dragged) {
        this.world.add(kind);
        return;
      }
      if (this.dropTarget?.(e.clientX, e.clientY, kind)) return;
      if (document.elementFromPoint(e.clientX, e.clientY) === this.stage.canvas) {
        const at = this.stage.planePoint(e.clientX, e.clientY);
        this.world.add(kind, at && at.length() < 12 ? at : undefined);
      }
    };
    card.addEventListener("pointerup", (e) => finish(e, false));
    card.addEventListener("pointercancel", (e) => finish(e, true));
  }

  toggle(open = !this.el.classList.contains("open")) {
    if (open !== this.el.classList.contains("open")) emit("player.chest", { open });
    this.el.classList.toggle("open", open);
  }

  isOver(x: number, y: number) {
    const r = this.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  highlightDrop(on: boolean) {
    this.el.classList.toggle("drop", on);
  }
}
