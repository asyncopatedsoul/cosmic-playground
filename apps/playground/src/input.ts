import type { AudioHost } from "./audio/host";
import type { Stage } from "./render/stage";
import type { DragHandler, PointerInfo, Toy } from "./toys/toy";
import type { Chest } from "./ui/chest";
import type { PulseEditor } from "./ui/pulse-editor";
import type { World } from "./world";

/**
 * The intent layer for mouse, touch and keyboard. Raw input becomes
 * poke / grab / stretch / twist; toys only ever see those.
 *
 *   poke     tap / click (shift = soft)        stretch  wheel, pinch, drag a handle
 *   grab     drag a toy's base (drop on chest)  twist    Q/E, alt-drag, two-finger rotate
 */

interface Track {
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  toy: Toy | null;
  part: string;
  hit: PointerInfo["hit"];
  handler: DragHandler | null;
  twist: boolean;
}

interface TwoFinger {
  toy: Toy | null;
  distance: number;
  angle: number;
}

const TAP_SLOP = 7;

export class Input {
  private tracks = new Map<number, Track>();
  private two: TwoFinger | null = null;
  private lastToy: Toy | null = null;

  constructor(
    private stage: Stage,
    private world: World,
    private editor: PulseEditor,
    private chest: Chest,
    private audio: AudioHost,
  ) {
    const c = stage.canvas;
    c.addEventListener("pointerdown", (e) => this.down(e));
    c.addEventListener("pointermove", (e) => this.move(e));
    c.addEventListener("pointerup", (e) => this.up(e));
    c.addEventListener("pointercancel", (e) => this.cancel(e));
    c.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("keydown", (e) => this.key(e));
  }

  private info(e: PointerEvent, t: Track): PointerInfo {
    return { x: e.clientX, y: e.clientY, dx: e.clientX - t.x, dy: e.clientY - t.y, event: e, hit: t.hit };
  }

  private down(e: PointerEvent) {
    this.audio.start();
    this.stage.canvas.setPointerCapture(e.pointerId);
    const hit = this.stage.pick(e.clientX, e.clientY, this.world.pickables());
    const toy: Toy | null = hit?.object.userData.toy ?? null;
    const t: Track = {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      toy,
      part: hit?.object.userData.part ?? "",
      hit,
      handler: null,
      twist: false,
    };

    if (this.tracks.size === 1) {
      // Second finger: pinch = stretch, rotate = twist on the first finger's toy (or camera).
      const first = [...this.tracks.values()][0];
      first.handler = null;
      first.moved = true;
      this.two = { toy: first.toy, distance: Math.hypot(t.x - first.x, t.y - first.y), angle: Math.atan2(t.y - first.y, t.x - first.x) };
      t.moved = true;
      this.tracks.set(e.pointerId, t);
      return;
    }
    this.tracks.set(e.pointerId, t);
    if (!toy) return;

    this.lastToy = toy;
    if (e.altKey || e.button === 2) t.twist = true;
    else if (t.part === "base") t.handler = this.grab(toy, e);
    else t.handler = toy.down(t.part, this.info(e, t));
  }

  /** Grab: drag a toy around the world; dropping it on the chest puts it away. */
  private grab(toy: Toy, e: PointerEvent): DragHandler {
    const start = this.stage.planePoint(e.clientX, e.clientY);
    const offset = start ? start.sub(toy.group.position) : null;
    return {
      move: (p) => {
        const g = this.stage.planePoint(p.x, p.y);
        if (!g || !offset) return;
        g.sub(offset).setY(0);
        if (g.length() > 12) g.setLength(12);
        toy.moveTo(g);
        this.chest.highlightDrop(this.chest.isOver(p.x, p.y));
      },
      end: (p) => {
        this.chest.highlightDrop(false);
        if (this.chest.isOver(p.x, p.y)) {
          if (this.editor.toy === toy) this.editor.close();
          if (this.lastToy === toy) this.lastToy = null;
          this.world.remove(toy);
        }
      },
    };
  }

  private move(e: PointerEvent) {
    const t = this.tracks.get(e.pointerId);
    if (!t) {
      this.hover(e);
      return;
    }
    const info = this.info(e, t);
    if (!t.moved && Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > TAP_SLOP) t.moved = true;

    if (this.two && this.tracks.size >= 2) {
      t.x = e.clientX;
      t.y = e.clientY;
      const [a, b] = [...this.tracks.values()];
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      let dAngle = angle - this.two.angle;
      if (dAngle > Math.PI) dAngle -= Math.PI * 2;
      if (dAngle < -Math.PI) dAngle += Math.PI * 2;
      const ratio = distance / Math.max(1, this.two.distance);
      if (this.two.toy) {
        this.two.toy.nudge("stretch", Math.log(ratio) * 0.6);
        this.two.toy.nudge("twist", dAngle / (Math.PI * 2));
      } else {
        this.stage.zoom(1 / ratio);
      }
      this.two.distance = distance;
      this.two.angle = angle;
      return;
    }

    if (t.moved) {
      if (t.twist && t.toy) t.toy.nudge("twist", (info.dx - info.dy) * 0.003);
      else if (t.handler) t.handler.move(info);
      else if (!t.toy) this.stage.orbit(-info.dx * 0.006, info.dy * 0.004);
    }
    t.x = e.clientX;
    t.y = e.clientY;
  }

  private up(e: PointerEvent) {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    this.tracks.delete(e.pointerId);
    if (this.two) {
      if (this.tracks.size < 2) this.two = null;
      // Lift the remaining finger's tap so the gesture doesn't also poke.
      for (const other of this.tracks.values()) other.moved = true;
      return;
    }
    const info = this.info(e, t);
    t.handler?.end?.(info);
    if (t.moved) return;
    if (t.toy) {
      if (t.part === "heart") this.editor.toggle(t.toy);
      else t.toy.tap(t.part, info, strength(e));
    } else if (this.editor.toy) {
      this.editor.close();
    }
  }

  private cancel(e: PointerEvent) {
    this.tracks.delete(e.pointerId);
    if (this.tracks.size < 2) this.two = null;
    this.chest.highlightDrop(false);
  }

  private hover(e: PointerEvent) {
    const hit = this.stage.pick(e.clientX, e.clientY, this.world.pickables());
    const part: string = hit?.object.userData.part ?? "";
    this.stage.canvas.style.cursor = !hit ? "grab" : part === "base" ? "move" : "pointer";
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const hit = this.stage.pick(e.clientX, e.clientY, this.world.pickables());
    const toy: Toy | undefined = hit?.object.userData.toy;
    if (toy) {
      this.lastToy = toy;
      if (!toy.nudge("stretch", -e.deltaY * 0.0006)) toy.nudge("twist", -e.deltaY * 0.0006);
    } else {
      this.stage.zoom(1 + e.deltaY * 0.001);
    }
  }

  private key(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    const toy = this.lastToy;
    switch (e.key) {
      case "Tab":
        e.preventDefault();
        this.chest.toggle();
        break;
      case "Escape":
        this.editor.close();
        break;
      case "q":
      case "Q":
        toy?.nudge("twist", -0.03);
        break;
      case "e":
      case "E":
        toy?.nudge("twist", 0.03);
        break;
      case " ":
        if (toy) {
          e.preventDefault();
          this.audio.start();
          toy.poke(e.shiftKey ? 0.4 : 0.85);
        }
        break;
    }
  }
}

/** Poke strength from pressure (touch/pen) or modifiers (mouse). */
function strength(e: PointerEvent): number {
  if (e.pointerType !== "mouse" && e.pressure > 0 && e.pressure < 1) return 0.45 + 0.55 * e.pressure;
  return e.shiftKey ? 0.4 : 0.85;
}
