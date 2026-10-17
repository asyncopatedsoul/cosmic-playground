import * as THREE from "three";
import { HINT_ACTIONS, PAD_HINT } from "../controllers/gamepad-map";
import type { SeatState, Seats } from "../seats/seats";
import type { Stage } from "./stage";

interface Cursor {
  el: HTMLDivElement;
  hint: HTMLDivElement;
}

/**
 * What each local seat looks like (docs/PLAYTESTS.md L1): gamepad seats get a
 * ring in their colour with their number, clamped to the canvas; any seat that
 * holds a toy puts a ring of its colour round the toy's base (seat 1's only
 * while gamepad seats are present: alone, the mouse needs no label).
 */
export class SeatCursors {
  private cursors = new Map<SeatState, Cursor>();
  private rings = new Map<SeatState, THREE.Mesh>();
  private layer: HTMLDivElement;

  constructor(
    private stage: Stage,
    private seats: Seats,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "seat-cursors";
    this.layer.setAttribute("aria-hidden", "true");
    document.body.append(this.layer);
  }

  /** Per frame. `hold` is how far each seat is through a press-and-hold (0..1). */
  update(hold: (seat: SeatState) => number) {
    const pads = this.seats.pads;
    for (const seat of pads) {
      const c = this.cursors.get(seat) ?? this.cursor(seat);
      const r = this.stage.canvas.getBoundingClientRect();
      const x = Math.min(r.right, Math.max(r.left, seat.aimX));
      const y = Math.min(r.bottom, Math.max(r.top, seat.aimY));
      c.el.style.transform = `translate(${x}px, ${y}px)`;
      // Near the right edge, the hint and number go on the left.
      c.el.classList.toggle("flip", x > r.right - 300);
      c.el.classList.toggle("on-toy", seat.hit?.kind === "part");
      c.el.classList.toggle("holding", !!seat.holding);
      c.el.style.setProperty("--hold", String(hold(seat)));
      c.hint.classList.toggle("gone", seat.actions >= HINT_ACTIONS);
    }
    for (const [seat, c] of this.cursors) {
      if (!pads.includes(seat)) {
        c.el.remove();
        this.cursors.delete(seat);
      }
    }

    const show = pads.length > 0;
    for (const seat of this.seats.list) {
      const toy = show ? seat.holding : null;
      let ring = this.rings.get(seat);
      if (toy && !ring) ring = this.ring(seat);
      if (!ring) continue;
      ring.visible = !!toy;
      if (toy) ring.position.copy(toy.group.position).setY(0.1);
    }
    for (const [seat, ring] of this.rings) {
      if (!this.seats.list.includes(seat)) {
        ring.removeFromParent();
        ring.geometry.dispose();
        (ring.material as THREE.Material).dispose();
        this.rings.delete(seat);
      }
    }
  }

  private cursor(seat: SeatState): Cursor {
    const el = document.createElement("div");
    el.className = "seat-cursor";
    el.style.setProperty("--seat", seat.color);
    const num = document.createElement("b");
    num.textContent = String(seat.number);
    const hint = document.createElement("div");
    hint.className = "seat-hint";
    hint.textContent = PAD_HINT;
    el.append(num, hint);
    this.layer.append(el);
    const c = { el, hint };
    this.cursors.set(seat, c);
    return c;
  }

  private ring(seat: SeatState): THREE.Mesh {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.035, 8, 64),
      new THREE.MeshBasicMaterial({ color: seat.color, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2;
    this.stage.scene.add(ring);
    this.rings.set(seat, ring);
    return ring;
  }
}
