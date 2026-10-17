import { canPlace } from "../seats/actions";
import type { SeatState } from "../seats/seats";
import { TOYS } from "../toys/registry";
import type { Toy } from "../toys/toy";
import type { World } from "../world";
import { announce } from "./announce";

interface Open {
  el: HTMLDivElement;
  name: HTMLSpanElement;
  index: number;
}

/**
 * The gamepad seats' way to add toys (docs/PLAYTESTS.md §3.1): a strip of toy
 * icons at the seat's cursor. LB / RB choose, A places at the cursor's
 * surface hit (same rules as avatar placing), B closes. One per seat.
 */
export class PlacePicker {
  private open = new Map<SeatState, Open>();
  /** The last toy each seat chose, so the picker reopens on it. */
  private last = new Map<string, number>();

  constructor(private world: World) {}

  isOpen(seat: SeatState) {
    return this.open.has(seat);
  }

  toggle(seat: SeatState) {
    if (this.isOpen(seat)) this.close(seat);
    else this.show(seat);
  }

  show(seat: SeatState) {
    if (this.isOpen(seat)) return;
    const el = document.createElement("div");
    el.className = "place-picker";
    el.style.setProperty("--seat", seat.color);
    el.setAttribute("aria-hidden", "true");
    const strip = document.createElement("div");
    strip.className = "place-picker-strip";
    for (const t of TOYS) {
      const i = document.createElement("i");
      i.innerHTML = t.icon;
      i.style.color = t.color;
      strip.append(i);
    }
    const name = document.createElement("span");
    name.className = "place-picker-name";
    el.append(strip, name);
    document.body.append(el);
    const o = { el, name, index: Math.min(this.last.get(seat.id) ?? 0, TOYS.length - 1) };
    this.open.set(seat, o);
    this.render(seat, o);
  }

  close(seat: SeatState) {
    const o = this.open.get(seat);
    if (!o) return;
    o.el.remove();
    this.open.delete(seat);
  }

  cycle(seat: SeatState, step: number) {
    const o = this.open.get(seat);
    if (!o) return;
    o.index = (o.index + step + TOYS.length) % TOYS.length;
    this.last.set(seat.id, o.index);
    this.render(seat, o);
    announce(TOYS[o.index].name);
  }

  /** Place the chosen toy at the seat's cursor; null (and a shake) if it can't go there. */
  place(seat: SeatState): Toy | null {
    const o = this.open.get(seat);
    if (!o) return null;
    const hit = seat.hit;
    const toy = hit && canPlace(this.world, hit) ? this.world.add(TOYS[o.index].id, hit.point!.clone().setY(0)) : null;
    if (!toy) {
      o.el.classList.remove("refused");
      void o.el.offsetWidth;
      o.el.classList.add("refused");
    }
    return toy;
  }

  /** Per frame: follow the cursors and show whether the spot is free. */
  update() {
    for (const [seat, o] of this.open) {
      o.el.style.left = `${seat.x}px`;
      o.el.style.top = `${seat.y}px`;
      o.el.classList.toggle("blocked", !seat.hit || !canPlace(this.world, seat.hit));
    }
  }

  private render(seat: SeatState, o: Open) {
    [...o.el.querySelectorAll(".place-picker-strip i")].forEach((icon, i) => icon.classList.toggle("on", i === o.index));
    o.name.textContent = TOYS[o.index].name;
    this.last.set(seat.id, o.index);
  }
}
