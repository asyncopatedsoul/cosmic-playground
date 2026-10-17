import * as THREE from "three";
import type { Toy } from "../toys/toy";
import type { World } from "../world";
import { GLYPHS, toggleMute, toyName } from "./sound";

const SHOW_MS = 2000;
const LONG_PRESS_MS = 420;
const box = new THREE.Box3();
const at = new THREE.Vector3();

/**
 * A small speaker badge above the aimed toy (AUDIO-MIX.md §4.2), shown for 2 s
 * when you point at a toy. Tap: mute / unmute for you. Long-press: open the
 * toy's panel, which has its Sound row.
 */
export class SoundBadge {
  private el: HTMLButtonElement;
  private toy: Toy | null = null;
  private top = 1;
  private until = 0;
  private hovered = false;
  /** Opens the toy's panel (the Pulse editor); set by main.ts. */
  onLongPress: ((toy: Toy) => void) | null = null;

  constructor(private world: World) {
    this.el = document.createElement("button");
    this.el.className = "sound-badge";
    this.el.hidden = true;
    document.body.append(this.el);
    world.mix.listeners.push(() => this.render());

    let timer = 0;
    let long = false;
    this.el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      long = false;
      timer = window.setTimeout(() => {
        long = true;
        if (this.toy) this.onLongPress?.(this.toy);
      }, LONG_PRESS_MS);
    });
    this.el.addEventListener("pointerup", () => clearTimeout(timer));
    this.el.addEventListener("pointerleave", () => {
      clearTimeout(timer);
      this.hovered = false;
    });
    this.el.addEventListener("pointerenter", () => (this.hovered = true));
    this.el.addEventListener("click", () => {
      if (!long && this.toy) toggleMute(this.world, this.toy);
      this.until = performance.now() + SHOW_MS;
    });
  }

  /** Per frame, with the toy under the pointer or crosshair (or null). */
  update(target: Toy | null) {
    const now = performance.now();
    if (target && target !== this.toy) {
      this.toy = target;
      // The badge floats just above the toy's tallest part.
      box.setFromObject(target.group);
      this.top = box.max.y - target.group.position.y + 0.25;
      this.render();
    }
    if (target) this.until = now + SHOW_MS;
    const toy = this.toy;
    const live = toy && this.world.toys.includes(toy) && (now < this.until || this.hovered);
    if (!live) {
      this.el.hidden = true;
      if (toy && !this.world.toys.includes(toy)) this.toy = null;
      return;
    }
    at.copy(toy.group.position).setY(toy.group.position.y + this.top).project(this.world.stage.camera);
    if (at.z > 1) {
      this.el.hidden = true;
      return;
    }
    const r = this.world.stage.canvas.getBoundingClientRect();
    this.el.style.transform = `translate(${r.left + ((at.x + 1) / 2) * r.width}px, ${r.top + ((1 - at.y) / 2) * r.height}px) translate(-50%, -100%)`;
    this.el.hidden = false;
  }

  private render() {
    const toy = this.toy;
    if (!toy) return;
    const muted = this.world.mix.toyMute.has(toy.id);
    const listening = this.world.mix.listening(toy);
    this.el.innerHTML = muted ? GLYPHS.muted : listening === "solo" ? GLYPHS.solo : listening === "focus" ? GLYPHS.focus : GLYPHS.speaker;
    this.el.classList.toggle("muted", muted);
    this.el.style.setProperty("--toy", toy.css);
    this.el.setAttribute("aria-label", `${toyName(toy)}: ${muted ? "unmute" : "mute"} (long-press for sound settings)`);
  }
}
