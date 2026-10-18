import * as THREE from "three";
import type { Aim, AimHit } from "./aim";
import type { AudioHost } from "./audio/host";
import type { Avatar } from "./avatar/avatar";
import type { FocusView } from "./focus/focus";
import type { AimPreview } from "./render/aim-preview";
import type { PlacementGhost } from "./render/ghost";
import type { Stage } from "./render/stage";
import { canPlace, dragPart, grab, putAway, release, undoPutAway, type ActionDeps } from "./seats/actions";
import type { Seats } from "./seats/seats";
import { toyEntry } from "./toys/registry";
import type { DragHandler, PointerInfo, Toy } from "./toys/toy";
import type { Chest } from "./ui/chest";
import type { FocusBar } from "./ui/focus-bar";
import type { Hotbar } from "./ui/hotbar";
import { toggleGlobalMute } from "./ui/hud";
import type { ListenSheet } from "./ui/listen";
import { toggleFocus, toggleMute, toggleSolo } from "./ui/sound";
import type { SoundBadge } from "./ui/sound-badge";
import type { ModeSwitch } from "./ui/modes";
import type { PulseEditor } from "./ui/pulse-editor";
import type { World } from "./world";

/**
 * The intent layer for mouse, touch and keyboard. Raw input becomes
 * poke / grab / stretch / twist; toys only ever see those. Every action is
 * aimed through `Aim` (docs/AVATAR.md §5): the pointer in Orbit, the
 * crosshair in avatar mode.
 *
 *   poke     tap / click (shift = soft)        stretch  wheel, pinch, drag a handle
 *   grab     drag a toy's base (drop on chest)  twist    Q/E, alt-drag, two-finger rotate
 *
 * In avatar mode (Walk/Fly) with pointer lock, mouse movement looks around;
 * holding left on a handle sends movement to that handle through a virtual
 * cursor that starts at the crosshair, so toys' drag handlers work unchanged.
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
  /** Shift+click on a toy: select it instead of playing it (FOCUS-VIEW.md §3.1). */
  select: boolean;
  /** Shift+drag on empty ground: a lasso rectangle. */
  lasso: HTMLElement | null;
}

interface TwoFinger {
  toy: Toy | null;
  distance: number;
  angle: number;
}

export interface InputDeps {
  stage: Stage;
  world: World;
  editor: PulseEditor;
  chest: Chest;
  audio: AudioHost;
  aim: Aim;
  preview: AimPreview;
  avatar: Avatar;
  hotbar: Hotbar;
  ghost: PlacementGhost;
  modes: ModeSwitch;
  listen: ListenSheet;
  badge: SoundBadge;
  /** Seat 1 (the mouse) is `seats.mouse`; gamepad seats share its helpers (seats/actions.ts). */
  seats: Seats;
  focus: FocusView;
  focusBar: FocusBar;
}

/** Holding H longer than this makes focus momentary: it ends on release. */
const HOLD_MS = 350;

const TAP_SLOP = 7;

export class Input {
  private tracks = new Map<number, Track>();
  private two: TwoFinger | null = null;
  private lastToy: Toy | null = null;
  /** Last free-cursor position, for the Orbit preview. */
  private cursor: { x: number; y: number } | null = null;
  /** The toy being carried with R. */
  private carry: Toy | null = null;
  /** When H went down on a toy that wasn't focused, for hold-to-focus. */
  private focusHeld: { toy: Toy; at: number } | null = null;
  /** Off on the main menu (MAIN-MENU.md §3): keys do nothing. */
  enabled = true;

  constructor(private d: InputDeps) {
    const c = d.stage.canvas;
    c.addEventListener("pointerdown", (e) => this.down(e));
    c.addEventListener("pointermove", (e) => this.move(e));
    c.addEventListener("pointerup", (e) => this.up(e));
    c.addEventListener("pointercancel", (e) => this.cancel(e));
    c.addEventListener("pointerleave", () => (this.cursor = null));
    c.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("auxclick", (e) => e.preventDefault());
    addEventListener("keydown", (e) => this.key(e));
    addEventListener("keyup", (e) => this.keyUp(e));
    d.chest.dropTarget = (x, y, kind) => {
      const i = d.avatar.active ? d.hotbar.slotAt(x, y) : null;
      if (i === null) return false;
      d.hotbar.set(kind, i);
      d.hotbar.select(i);
      return true;
    };
  }

  /** Pointer-locked avatar mode: aim from the crosshair, movement is relative. */
  private get locked() {
    return this.d.avatar.active && this.d.avatar.locked;
  }

  private get seat() {
    return this.d.seats.mouse;
  }

  private get actions(): ActionDeps {
    return this.d;
  }

  private centre() {
    const r = this.d.stage.canvas.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private info(e: PointerEvent, t: Track, x: number, y: number): PointerInfo {
    return { x, y, dx: x - t.x, dy: y - t.y, event: e, hit: t.hit };
  }

  /** What a press aims at; avatar actions ignore what's out of reach. */
  private aimAt(x: number, y: number): AimHit {
    return this.locked ? this.d.aim.fromCrosshair() : this.d.aim.fromScreen(x, y);
  }

  private down(e: PointerEvent) {
    const { avatar, audio, stage } = this.d;
    audio.start();
    if (avatar.active && !avatar.locked && !avatar.fallback) {
      // The first click in avatar mode takes pointer lock and does nothing else.
      avatar.lock();
      return;
    }
    if (!this.locked) stage.canvas.setPointerCapture(e.pointerId);
    const { x, y } = this.locked ? this.centre() : { x: e.clientX, y: e.clientY };
    const hit = this.aimAt(x, y);

    if (avatar.active && e.button === 2) {
      this.place(hit);
      return;
    }
    if (avatar.active && e.button === 1) {
      e.preventDefault();
      if (hit.toy && hit.inReach) this.d.hotbar.set(hit.toy.entryId);
      return;
    }

    const usable = hit.kind === "part" && (hit.inReach || !avatar.active);
    const toy = usable ? hit.toy! : null;
    const t: Track = {
      x,
      y,
      startX: x,
      startY: y,
      moved: false,
      toy,
      part: usable ? hit.part! : "",
      hit: hit.intersection,
      handler: null,
      twist: false,
      select: !!toy && e.shiftKey && !avatar.active && e.button === 0,
      lasso: null,
    };

    if (this.tracks.size === 1 && !this.locked) {
      // Second finger: pinch = stretch, rotate = twist on the first finger's toy (or camera).
      const first = [...this.tracks.values()][0];
      first.handler = null;
      release(this.seat);
      first.moved = true;
      this.two = { toy: first.toy, distance: Math.hypot(t.x - first.x, t.y - first.y), angle: Math.atan2(t.y - first.y, t.x - first.x) };
      t.moved = true;
      this.tracks.set(e.pointerId, t);
      return;
    }
    this.tracks.set(e.pointerId, t);
    if (!toy) {
      if (e.shiftKey && !avatar.active && e.button === 0) t.lasso = lassoBox();
      return;
    }

    this.lastToy = toy;
    if (t.select) return;
    if (e.altKey || e.button === 2) t.twist = true;
    else if (t.part === "base") t.handler = this.grab(toy);
    else t.handler = dragPart(this.actions, this.seat, toy, t.part, this.info(e, t, x, y));
  }

  /** Grab: drag a toy along the surface under the pointer; dropping it on the chest puts it away. */
  private grab(toy: Toy): DragHandler | null {
    const { chest } = this.d;
    return grab(this.actions, this.seat, toy, {
      moved: (p) => {
        if (!this.locked) chest.highlightDrop(chest.isOver(p.x, p.y));
      },
      ended: (p) => {
        chest.highlightDrop(false);
        if (!this.locked && chest.isOver(p.x, p.y)) this.putAwayToy(toy);
      },
    });
  }

  private move(e: PointerEvent) {
    const { avatar, stage } = this.d;
    const t = this.tracks.get(e.pointerId);
    if (this.locked) {
      if (!t) {
        avatar.look(e.movementX, e.movementY);
        return;
      }
    } else if (!t) {
      this.cursor = { x: e.clientX, y: e.clientY };
      this.hover();
      return;
    }
    const x = this.locked ? t.x + e.movementX : e.clientX;
    const y = this.locked ? t.y + e.movementY : e.clientY;
    const info = this.info(e, t, x, y);
    if (!t.moved && Math.hypot(x - t.startX, y - t.startY) > TAP_SLOP) t.moved = true;
    if (t.lasso) {
      const s = t.lasso.style;
      s.left = `${Math.min(x, t.startX)}px`;
      s.top = `${Math.min(y, t.startY)}px`;
      s.width = `${Math.abs(x - t.startX)}px`;
      s.height = `${Math.abs(y - t.startY)}px`;
      t.x = x;
      t.y = y;
      return;
    }

    if (this.two && this.tracks.size >= 2) {
      t.x = x;
      t.y = y;
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
      } else if (!avatar.active) {
        stage.zoom(1 / ratio);
      }
      this.two.distance = distance;
      this.two.angle = angle;
      return;
    }

    if (t.moved) {
      if (t.twist && t.toy) t.toy.nudge("twist", (info.dx - info.dy) * 0.003);
      else if (t.handler) t.handler.move(info);
      else if (avatar.active) {
        avatar.look(this.locked ? e.movementX : info.dx, this.locked ? e.movementY : info.dy);
        // Looking doesn't move the virtual cursor: it stays on the crosshair.
        return;
      } else if (!t.toy) stage.orbit(-info.dx * 0.006, info.dy * 0.004);
    }
    t.x = x;
    t.y = y;
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
    if (t.lasso) {
      t.lasso.remove();
      if (t.moved) this.lassoSelect(t.startX, t.startY, t.x, t.y);
      else this.d.world.clearSelection();
      return;
    }
    const info = this.info(e, t, t.x, t.y);
    t.handler?.end?.(info);
    if (t.moved) return;
    if (t.toy && t.select) {
      this.d.world.select(t.toy);
      return;
    }
    if (t.toy) {
      if (t.part === "heart") {
        this.d.editor.toggle(t.toy);
        this.d.avatar.unlock();
      } else t.toy.tap(t.part, info, strength(e));
    } else if (this.d.editor.toy) {
      this.d.editor.close();
    }
  }

  /** Select every toy whose centre is inside the screen rectangle. */
  private lassoSelect(x0: number, y0: number, x1: number, y1: number) {
    const { stage, world } = this.d;
    const r = stage.canvas.getBoundingClientRect();
    const p = new THREE.Vector3();
    const [l, rt, tp, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    for (const toy of world.toys) {
      if (!toy) continue;
      p.copy(toy.group.position).project(stage.camera);
      const sx = r.left + ((p.x + 1) / 2) * r.width;
      const sy = r.top + ((1 - p.y) / 2) * r.height;
      if (sx >= l && sx <= rt && sy >= tp && sy <= b) world.select(toy, true);
    }
  }

  private cancel(e: PointerEvent) {
    this.tracks.get(e.pointerId)?.lasso?.remove();
    if (this.tracks.get(e.pointerId)?.handler) release(this.seat);
    this.tracks.delete(e.pointerId);
    if (this.tracks.size < 2) this.two = null;
    this.d.chest.highlightDrop(false);
  }

  private hover() {
    const hit = this.d.aim.current;
    const part = hit.kind === "part" ? hit.part : "";
    this.d.stage.canvas.style.cursor = this.d.avatar.active ? "crosshair" : !part ? "grab" : part === "base" ? "move" : "pointer";
  }

  /** The toy that shortcuts outside Input act on (variants: Ctrl+Shift+K, Ctrl+C). */
  targetToy(): Toy | null {
    const t = this.target();
    return t && this.d.world.toys.includes(t) ? t : null;
  }

  /** The toy that keys like Q/E and [ ] act on: the aimed one, else the last touched. */
  private target(): Toy | null {
    const h = this.d.aim.current;
    return h.kind === "part" && h.inReach ? h.toy! : this.lastToy;
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const { avatar, hotbar, stage } = this.d;
    const delta = e.deltaY || e.deltaX;
    if (avatar.active) {
      if (e.shiftKey) this.target()?.nudge("stretch", -delta * 0.0006);
      else hotbar.cycle(Math.sign(delta));
      return;
    }
    const hit = this.d.aim.fromScreen(e.clientX, e.clientY);
    const toy = hit.kind === "part" ? hit.toy : undefined;
    if (toy) {
      this.lastToy = toy;
      if (!toy.nudge("stretch", -e.deltaY * 0.0006)) toy.nudge("twist", -e.deltaY * 0.0006);
    } else {
      stage.zoom(1 + e.deltaY * 0.001);
    }
  }

  /** Right-click in avatar mode: place the hotbar toy where you aim, or drop what you carry. */
  private place(hit: AimHit) {
    if (this.carry) {
      this.drop();
      return;
    }
    const id = this.d.hotbar.current();
    if (id && hit.kind === "surface" && canPlace(this.d.world, hit)) {
      const toy = this.d.world.add(id, hit.point!.clone());
      if (toy) this.lastToy = toy;
    }
  }

  private putAwayToy(toy: Toy) {
    const carried = this.carry === toy;
    if (!putAway(this.actions, this.seat, toy)) return;
    if (this.lastToy === toy) this.lastToy = null;
    if (carried) this.drop();
  }

  private drop() {
    this.carry = null;
    this.d.aim.ignore = null;
  }

  /** Leaving a world (MAIN-MENU.md §5): back to orbit, nothing held, nothing to undo. */
  reset() {
    this.drop();
    this.d.avatar.exit();
    this.d.ghost.hide();
    this.lastToy = null;
    this.focusHeld = null;
    for (const s of this.d.seats.list) s.putAway.length = 0;
  }

  private toggleAvatar() {
    const { avatar } = this.d;
    if (avatar.active) {
      this.drop();
      avatar.exit();
    } else avatar.enter();
    this.d.ghost.hide();
  }

  private key(e: KeyboardEvent) {
    if (!this.enabled) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const { avatar, chest, editor, hotbar, preview, world } = this.d;
    if (avatar.active && !e.ctrlKey && !e.metaKey && avatar.keyDown(e)) {
      if (e.code === "Space") e.preventDefault();
      return;
    }
    const toy = avatar.active ? this.target() : this.lastToy;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") {
      if (this.seat.putAway.length) {
        e.preventDefault();
        undoPutAway(this.actions, this.seat);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.focusKey(e)) return;
    if (this.listenKey(e)) return;
    if (avatar.active && /^Digit[1-9]$/.test(e.code)) {
      hotbar.select(Number(e.code.slice(5)) - 1);
      return;
    }
    switch (e.code) {
      case "Tab":
        e.preventDefault();
        avatar.unlock();
        chest.toggle();
        return;
      case "KeyC":
        this.toggleAvatar();
        return;
      case "KeyV":
        if (avatar.active) avatar.setThirdPerson(!avatar.settings.thirdPerson);
        return;
      case "KeyB":
        if (e.shiftKey) preview.gravity = !preview.gravity;
        else preview.toggle();
        this.d.modes.render();
        return;
      case "KeyG": {
        // Bind gravity to the aimed surface; with one body this keeps you on the ground.
        const h = this.d.aim.current;
        if (avatar.active && h.kind === "surface" && h.body) avatar.body = h.body;
        return;
      }
      case "KeyR": {
        if (!avatar.active) return;
        if (this.carry) this.drop();
        else {
          const h = this.d.aim.current;
          if (h.kind === "part" && h.inReach && world.canEdit()) {
            this.carry = h.toy!;
            this.d.aim.ignore = h.toy!;
          }
        }
        return;
      }
      case "Delete":
      case "Backspace": {
        const h = this.d.aim.current;
        if (h.kind === "part" && (h.inReach || !avatar.active)) {
          e.preventDefault();
          this.putAwayToy(h.toy!);
        }
        return;
      }
      case "BracketLeft":
        toy?.nudge("stretch", -0.03);
        return;
      case "BracketRight":
        toy?.nudge("stretch", 0.03);
        return;
      case "Escape":
        editor.close();
        this.d.listen.toggle(false);
        world.clearSelection();
        return;
      case "KeyQ":
        toy?.nudge("twist", -0.03);
        return;
      case "KeyE":
        toy?.nudge("twist", 0.03);
        return;
      case "Space":
        if (toy) {
          e.preventDefault();
          this.d.audio.start();
          toy.poke(e.shiftKey ? 0.4 : 0.85);
        }
        return;
    }
  }

  /** Focus view keys (FOCUS-VIEW.md §10): F, and inside it Tab, digits, T and Esc. */
  private focusKey(e: KeyboardEvent): boolean {
    const { focus, focusBar } = this.d;
    if (e.code === "KeyF" && !e.shiftKey) {
      focus.toggle(this.target());
      return true;
    }
    if (!focus.active) return false;
    const digit = /^Digit([0-9])$/.exec(e.code);
    switch (true) {
      case e.code === "Tab":
        e.preventDefault();
        focus.cycle(e.shiftKey ? -1 : 1);
        focusBar.tabbed();
        return true;
      case e.code === "Escape":
        focus.leave();
        return true;
      case e.code === "KeyT":
        focusBar.toggleTrace();
        return true;
      case !!digit: {
        // 1–9 pick by ring order; on a 12-toy ring Shift+1–3 pick 10–12.
        const n = Number(digit![1]);
        const i = e.shiftKey ? 9 + n - 1 : n - 1;
        if (n > 0 && i < focus.ring.length) focus.setLead(i);
        return true;
      }
    }
    return false;
  }

  /** Listening keys (AUDIO-MIX.md §4.5): M, Shift+M, N, Shift+N, H, L, - and =. */
  private listenKey(e: KeyboardEvent): boolean {
    const { listen, world } = this.d;
    const toy = this.target();
    switch (e.code) {
      case "KeyM":
        if (e.shiftKey) world.mix.clearToys();
        else {
          this.d.audio.start();
          toggleGlobalMute(world);
        }
        return true;
      case "KeyN":
        if (toy) (e.shiftKey ? toggleSolo : toggleMute)(world, toy);
        return true;
      case "KeyH":
        if (toy && !e.repeat) {
          const was = world.mix.focus === toy.id;
          toggleFocus(world, toy);
          this.focusHeld = was ? null : { toy, at: performance.now() };
        }
        return true;
      case "KeyL":
        listen.toggle();
        return true;
      case "Minus":
      case "Equal":
        toy?.setVolume(toy.volume + (e.code === "Minus" ? -0.05 : 0.05));
        return true;
    }
    return false;
  }

  private keyUp(e: KeyboardEvent) {
    const held = this.focusHeld;
    if (e.code !== "KeyH" || !held) return;
    this.focusHeld = null;
    if (performance.now() - held.at > HOLD_MS && this.d.world.mix.focus === held.toy.id) toggleFocus(this.d.world, held.toy, false);
  }

  /** Per frame: move the avatar, refresh the aim, the carried toy, the ghost and the preview. */
  update(dt: number) {
    const { aim, avatar, ghost, hotbar, preview, world } = this.d;
    avatar.update(dt);
    if (avatar.active) {
      aim.reach = avatar.reach;
      aim.reachOrigin = avatar.eye();
    } else {
      aim.reach = Infinity;
      aim.reachOrigin = null;
    }
    const c = this.cursor;
    aim.current = this.locked ? aim.fromCrosshair() : c ? aim.fromScreen(c.x, c.y) : aim.nothing();
    const hit = aim.current;

    if (this.carry) {
      if (!world.toys.includes(this.carry)) this.drop();
      else if (hit.kind === "surface" && hit.inReach) this.carry.moveTo(hit.point!.clone().setY(0));
    }

    const id = avatar.active && !this.carry ? hotbar.current() : null;
    if (id && hit.kind === "surface") ghost.show(hit.point!, hit.normal!, toyEntry(id)!.color, canPlace(world, hit));
    else ghost.hide();

    this.d.badge.update(hit.kind === "part" && hit.inReach ? hit.toy! : null);
    preview.update(hit, avatar.active ? avatar.hand() : null, this.label(hit, !!id), avatar.active ? { at: avatar.pos.clone(), dir: avatar.up() } : undefined);
  }

  /** The preview's tiny label: what a click would do here. */
  private label(hit: AimHit, placing: boolean): string {
    if (hit.kind === "none") return "";
    if (!hit.inReach) return "out of reach";
    if (hit.kind === "surface") return placing ? "right-click: place" : "";
    const part = hit.part!;
    if (part === "base") return this.d.avatar.active ? "drag · R carry" : "move";
    if (part === "heart") return "pulse";
    return hit.toy!.hint(part);
  }
}

function lassoBox(): HTMLElement {
  const el = document.createElement("div");
  el.className = "lasso";
  document.body.append(el);
  return el;
}

/** Poke strength from pressure (touch/pen) or modifiers (mouse). */
function strength(e: PointerEvent): number {
  if (e.pointerType !== "mouse" && e.pressure > 0 && e.pressure < 1) return 0.45 + 0.55 * e.pressure;
  return e.shiftKey ? 0.4 : 0.85;
}
