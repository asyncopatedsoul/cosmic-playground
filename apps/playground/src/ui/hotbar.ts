import { load, save } from "../prefs";
import { TOYS, toyEntry } from "../toys/registry";

const SLOTS = 9;

/**
 * The avatar hotbar (docs/AVATAR.md §5.2): 1–9 or the wheel select a slot,
 * right-click places its toy. Fills from the chest (drag a card onto a slot)
 * and from middle-clicking a toy in the world.
 */
export class Hotbar {
  readonly slots: (string | null)[];
  selected = load("cosmic.hotbar.selected", 0);
  private el = document.createElement("div");

  constructor() {
    const saved = load<(string | null)[] | null>("cosmic.hotbar", null);
    // Start full, so a Minecraft player can build without first visiting the chest.
    this.slots = saved?.length === SLOTS ? saved : Array.from({ length: SLOTS }, (_, i) => TOYS[i]?.id ?? null);
    this.el.id = "hotbar";
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", "Hotbar");
    document.body.append(this.el);
    this.el.addEventListener("click", (e) => {
      const slot = (e.target as HTMLElement).closest<HTMLElement>(".hotbar-slot");
      if (slot) this.select(Number(slot.dataset.i));
    });
    this.render();
  }

  /** The toy the selected slot places, if any. */
  current(): string | null {
    const id = this.slots[this.selected];
    return id && toyEntry(id) ? id : null;
  }

  select(i: number) {
    this.selected = ((i % SLOTS) + SLOTS) % SLOTS;
    save("cosmic.hotbar.selected", this.selected);
    this.render();
  }

  cycle(d: number) {
    this.select(this.selected + d);
  }

  /** Put a toy in a slot (the selected one by default). */
  set(id: string, i = this.selected) {
    this.slots[i] = id;
    save("cosmic.hotbar", this.slots);
    this.render();
  }

  /** The slot index under a screen point, for drops from the chest. */
  slotAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".hotbar-slot");
    return el && this.el.contains(el) ? Number(el.dataset.i) : null;
  }

  render() {
    this.el.replaceChildren(
      ...this.slots.map((id, i) => {
        const entry = id ? toyEntry(id) : undefined;
        const b = document.createElement("button");
        b.className = "hotbar-slot" + (i === this.selected ? " on" : "");
        b.dataset.i = String(i);
        b.title = `${i + 1}: ${entry?.name ?? "empty"}`;
        if (entry) {
          b.style.setProperty("--toy", entry.color);
          b.innerHTML = `${entry.icon}<kbd>${i + 1}</kbd>`;
        } else {
          b.innerHTML = `<kbd>${i + 1}</kbd>`;
        }
        return b;
      }),
    );
  }
}
