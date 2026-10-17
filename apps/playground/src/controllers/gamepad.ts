import * as THREE from "three";
import type { AimHit } from "../aim";
import type { AudioHost } from "../audio/host";
import type { SeatCursors } from "../render/seat-cursors";
import type { Stage } from "../render/stage";
import { dragPart, grab, heldByOther, putAway, release, undoPutAway, type ActionDeps } from "../seats/actions";
import type { SeatState } from "../seats/seats";
import type { PointerInfo, Toy } from "../toys/toy";
import { announce, toast } from "../ui/announce";
import type { PlacePicker } from "../ui/place-picker";
import { toggleFocus, toggleMute, toyName } from "../ui/sound";
import { AXIS, BUTTON, PICKER, binding } from "./gamepad-map";
import { PRESSED, type GamepadSource, type PadSnapshot } from "./source";

/**
 * Gamepad seats in Orbit view (docs/PLAYTESTS.md §3, L2–L3). Polls a
 * `GamepadSource` once a frame from the main loop and turns each pad into a
 * seat's actions, using the bindings in gamepad-map.ts:
 *
 *   any button  join            left stick  cursor (aim assist 24 px)
 *   A           poke / hold: grab or drag a handle
 *   RT / LT     stretch         right stick twist a toy, or turn/zoom the shared camera
 *   X pulse · Y place picker · hold B put away · View undo · D-pad listen · hold Menu leave
 */
export interface GamepadDeps extends ActionDeps {
  stage: Stage;
  audio: AudioHost;
  picker: PlacePicker;
  cursors: SeatCursors;
}

/** Radial dead zone on both sticks. */
const DEAD = 0.15;
/** Aim assist: snap to a toy part this close to the cursor. */
const ASSIST_PX = 24;
/** Cursor speed at full deflection, CSS px per second, before hold acceleration. */
const CURSOR_SPEED = 620;
/** Full deflection held this long starts accelerating, up to ×ACCEL_MAX over ACCEL_RAMP seconds. */
const ACCEL_AFTER = 0.35;
const ACCEL_RAMP = 0.6;
const ACCEL_MAX = 1.8;
/** The cursor slows over toys, so it's easy to stop on one. */
const OVER_TOY = 0.6;
/** A held A starts a drag early once the cursor has moved this far. */
const DRAG_SLOP = 6;
/** A seat whose pad has been gone this long leaves. */
const DISCONNECT_S = 30;
/** Per second at full trigger / stick. */
const STRETCH_RATE = 0.45;
const TWIST_RATE = 0.45;
const ORBIT_RATE = 2.2;
const ZOOM_RATE = 1.3;
const POKE = 0.85;
const VOLUME_STEP = 0.05;

const HOLD_GRAB = binding("grab").holdMs! / 1000;
const HOLD_PUT_AWAY = binding("putAway").holdMs! / 1000;
const HOLD_LEAVE = binding("leave").holdMs! / 1000;

interface Press {
  toy: Toy;
  part: string;
  hit: THREE.Intersection | null;
  x: number;
  y: number;
  at: number;
  /** A drag was tried (started or refused), so releasing doesn't poke. */
  done: boolean;
}

interface Pad {
  key: string;
  id: string;
  mapping: string;
  seat: SeatState | null;
  /** Effective buttons last frame (suppressed ones count as up). */
  prev: boolean[];
  /** Buttons ignored until released (the press that joined, or left). */
  suppress: Set<number>;
  /** When the pad stopped reporting, on the controller's clock. */
  lostAt: number | null;
  /** Seconds the left stick has been at full deflection. */
  full: number;
  press: Press | null;
  /** Last cursor position fed to the active drag. */
  dragAt: { x: number; y: number } | null;
  putAway: { toy: Toy; at: number } | null;
  menuAt: number | null;
  /** What the right stick does until it's released: decided when it leaves the dead zone. */
  right: { toy: Toy | null } | null;
  rumble?: PadSnapshot["rumble"];
}

export class Gamepads {
  private pads = new Map<string, Pad>();
  /** The controller's own clock (seconds), advanced by `update(dt)`. */
  private time = 0;
  private banner: HTMLButtonElement;
  private v = new THREE.Vector3();
  /** The seat that last turned the shared camera (for observation; it never locks). */
  cameraBy: SeatState | null = null;

  constructor(
    private d: GamepadDeps,
    private source: GamepadSource,
  ) {
    this.banner = document.createElement("button");
    this.banner.className = "pad-wake";
    this.banner.textContent = "Click here to wake the controllers";
    this.banner.hidden = true;
    this.banner.addEventListener("click", () => {
      focus();
      this.d.stage.canvas.focus?.();
      this.banner.hidden = true;
    });
    document.body.append(this.banner);
  }

  /** Each connected pad, for the Room sheet's Details (later) and the scenario. */
  get connected(): { key: string; id: string; mapping: string; seat: number | null }[] {
    return [...this.pads.values()].filter((p) => p.lostAt === null).map((p) => ({ key: p.key, id: p.id, mapping: p.mapping, seat: p.seat?.number ?? null }));
  }

  /** Per frame, from the main loop. */
  update(dt: number) {
    this.time += dt;
    const seen = new Set<string>();
    for (const s of this.source.poll()) {
      seen.add(s.key);
      let pad = this.pads.get(s.key);
      if (!pad) {
        pad = { key: s.key, id: s.id, mapping: s.mapping, seat: null, prev: [], suppress: new Set(), lostAt: null, full: 0, press: null, dragAt: null, putAway: null, menuAt: null, right: null };
        this.pads.set(s.key, pad);
      }
      pad.lostAt = null;
      pad.rumble = s.rumble;
      const raw = s.buttons.map((v) => v > PRESSED);
      for (const b of pad.suppress) if (!raw[b]) pad.suppress.delete(b);
      const down = raw.map((on, b) => on && !pad.suppress.has(b));
      if (pad.seat && !this.d.seats.list.includes(pad.seat)) pad.seat = null;
      if (!pad.seat) this.tryJoin(pad, down, raw);
      else this.drive(pad, s, down, dt);
      // Re-read suppression: joining or leaving this frame suppresses what's held.
      pad.prev = raw.map((on, b) => on && !pad.suppress.has(b));
    }
    for (const pad of this.pads.values()) {
      if (seen.has(pad.key)) continue;
      if (!pad.seat) {
        this.pads.delete(pad.key);
        continue;
      }
      if (pad.lostAt === null) {
        pad.lostAt = this.time;
        this.letGo(pad);
      } else if (this.time - pad.lostAt > DISCONNECT_S) {
        this.leave(pad);
        this.pads.delete(pad.key);
      }
    }
    this.banner.hidden = !this.d.seats.pads.length || document.hasFocus();
    this.d.picker.update();
    this.d.cursors.update((seat) => this.holdProgress(seat));
  }

  private tryJoin(pad: Pad, down: boolean[], raw: boolean[]) {
    if (!down.some((on, b) => on && !pad.prev[b])) return;
    const r = this.d.stage.canvas.getBoundingClientRect();
    const n = this.d.seats.pads.length;
    const seat = this.d.seats.join(pad.key, r.left + r.width * (0.35 + 0.15 * n), r.top + r.height * 0.6);
    // The press that joined doesn't also poke.
    raw.forEach((on, b) => on && pad.suppress.add(b));
    if (!seat) return;
    pad.seat = seat;
    this.d.audio.start();
    pad.rumble?.(60, 0.4);
    toast(`Player ${seat.number} joined`, seat.color);
  }

  private leave(pad: Pad) {
    const seat = pad.seat;
    if (!seat) return;
    this.letGo(pad);
    this.d.picker.close(seat);
    this.d.seats.leave(seat);
    pad.seat = null;
    pad.menuAt = null;
    toast(`Player ${seat.number} left`, seat.color);
  }

  /** Drop whatever the pad was doing (a drag, a hold). */
  private letGo(pad: Pad) {
    const seat = pad.seat;
    if (seat?.drag) seat.drag.end?.(this.info(seat, 0, 0));
    if (seat) release(seat);
    pad.press = null;
    pad.dragAt = null;
    pad.putAway = null;
    pad.right = null;
  }

  private drive(pad: Pad, s: PadSnapshot, down: boolean[], dt: number) {
    const seat = pad.seat!;
    const { audio, picker, world } = this.d;
    const pressed = (b: number) => !!down[b] && !pad.prev[b];
    const released = (b: number) => !down[b] && !!pad.prev[b];
    if (down.some((on, b) => on && !pad.prev[b])) audio.start();

    // A toy removed under us (another seat, or the room) ends the drag.
    if (seat.holding && !world.toys.includes(seat.holding)) this.letGo(pad);

    this.moveCursor(pad, seat, s, dt);
    this.aim(seat, picker.isOpen(seat));
    const hit = seat.hit;
    const under = hit?.kind === "part" ? hit.toy! : null;

    this.rightStick(pad, seat, s, dt, under);

    // Menu: hold to leave.
    if (pressed(BUTTON.Menu)) pad.menuAt = this.time;
    if (released(BUTTON.Menu)) pad.menuAt = null;
    if (pad.menuAt !== null && this.time - pad.menuAt >= HOLD_LEAVE) {
      this.leave(pad);
      down.forEach((on, b) => on && pad.suppress.add(b));
      return;
    }

    if (picker.isOpen(seat)) {
      if (pressed(PICKER.prev)) picker.cycle(seat, -1);
      if (pressed(PICKER.next)) picker.cycle(seat, 1);
      if (pressed(PICKER.place) && picker.place(seat)) {
        seat.actions++;
        pad.rumble?.(40, 0.3);
      }
      if (pressed(PICKER.close) || pressed(BUTTON.Y)) picker.close(seat);
      return;
    }

    // A: poke on release, or hold to grab / drag a handle.
    if (pressed(BUTTON.A) && under && hit) {
      seat.x = seat.aimX;
      seat.y = seat.aimY;
      pad.press = { toy: under, part: hit.part!, hit: hit.intersection, x: seat.x, y: seat.y, at: this.time, done: false };
    }
    const p = pad.press;
    if (p && down[BUTTON.A] && !p.done && world.toys.includes(p.toy)) {
      if (this.time - p.at >= HOLD_GRAB || Math.hypot(seat.x - p.x, seat.y - p.y) > DRAG_SLOP) {
        p.done = true;
        const info: PointerInfo = { x: p.x, y: p.y, dx: 0, dy: 0, hit: p.hit };
        const h = p.part === "base" ? grab(this.d, seat, p.toy) : dragPart(this.d, seat, p.toy, p.part, info);
        if (h) {
          seat.actions++;
          pad.dragAt = { x: p.x, y: p.y };
          h.move({ ...info, x: seat.x, y: seat.y, dx: seat.x - p.x, dy: seat.y - p.y });
          pad.dragAt = { x: seat.x, y: seat.y };
        } else if (heldByOther(this.d.seats, seat, p.toy)) {
          pad.rumble?.(120, 0.15);
          announce(`Player ${this.d.seats.holder(p.toy)!.number} has the ${toyName(p.toy)}`);
        }
      }
    }
    if (seat.drag && pad.dragAt && (seat.x !== pad.dragAt.x || seat.y !== pad.dragAt.y)) {
      seat.drag.move(this.info(seat, seat.x - pad.dragAt.x, seat.y - pad.dragAt.y));
      pad.dragAt = { x: seat.x, y: seat.y };
    }
    if (released(BUTTON.A)) {
      if (seat.drag) seat.drag.end?.(this.info(seat, 0, 0));
      else if (p && !p.done && world.toys.includes(p.toy)) this.poke(pad, seat, p);
      pad.press = null;
      pad.dragAt = null;
    }

    // Triggers: stretch whatever the seat holds or points at.
    const target = seat.holding ?? under;
    const stretch = (s.buttons[BUTTON.RT] ?? 0) - (s.buttons[BUTTON.LT] ?? 0);
    if (target && Math.abs(stretch) > 0.05) {
      const amount = stretch * STRETCH_RATE * dt;
      if (!target.nudge("stretch", amount)) target.nudge("twist", amount);
    }

    if (pressed(BUTTON.X) && under) {
      under.setPulse({ enabled: !under.pulse.enabled });
      seat.actions++;
      announce(`${toyName(under)} Pulse ${under.pulse.enabled ? "on" : "off"}`);
    }
    if (pressed(BUTTON.Y) && !seat.drag) picker.show(seat);

    // B: hold on a toy to put it away.
    if (pressed(BUTTON.B) && under) pad.putAway = { toy: under, at: this.time };
    if (released(BUTTON.B)) pad.putAway = null;
    if (pad.putAway && this.time - pad.putAway.at >= HOLD_PUT_AWAY) {
      const toy = pad.putAway.toy;
      pad.putAway = null;
      if (world.toys.includes(toy) && putAway(this.d, seat, toy)) {
        seat.actions++;
        pad.rumble?.(80, 0.5);
        announce(`${toyName(toy)} put away`);
      } else pad.rumble?.(120, 0.15);
    }
    if (pressed(BUTTON.View) && undoPutAway(this.d, seat)) {
      seat.actions++;
      pad.rumble?.(40, 0.3);
    }

    if (under) {
      if (pressed(BUTTON.Up)) toggleFocus(world, under);
      if (pressed(BUTTON.Down)) toggleMute(world, under);
      if (pressed(BUTTON.Left)) under.setVolume(under.volume - VOLUME_STEP);
      if (pressed(BUTTON.Right)) under.setVolume(under.volume + VOLUME_STEP);
    }
  }

  private poke(pad: Pad, seat: SeatState, p: Press) {
    // The heart opens the Pulse editor for the mouse; from a pad it just plays (X toggles the Pulse).
    if (p.part === "heart") p.toy.poke(POKE);
    else p.toy.tap(p.part, { x: p.x, y: p.y, dx: 0, dy: 0, hit: p.hit }, POKE);
    seat.actions++;
    pad.rumble?.(30, 0.25);
  }

  private moveCursor(pad: Pad, seat: SeatState, s: PadSnapshot, dt: number) {
    const [x, y] = radial(s.axes[AXIS.LX] ?? 0, s.axes[AXIS.LY] ?? 0);
    const m = Math.hypot(x, y);
    pad.full = m > 0.95 ? pad.full + dt : 0;
    const accel = 1 + (ACCEL_MAX - 1) * THREE.MathUtils.clamp((pad.full - ACCEL_AFTER) / ACCEL_RAMP, 0, 1);
    const slow = seat.hit?.kind === "part" && !seat.drag ? OVER_TOY : 1;
    const r = this.d.stage.canvas.getBoundingClientRect();
    seat.x = THREE.MathUtils.clamp(seat.x + x * CURSOR_SPEED * accel * slow * dt, r.left, r.right);
    seat.y = THREE.MathUtils.clamp(seat.y + y * CURSOR_SPEED * accel * slow * dt, r.top, r.bottom);
  }

  /** What the seat points at, with aim assist when it isn't dragging or placing. */
  private aim(seat: SeatState, placing: boolean) {
    const { aim, world, stage } = this.d;
    seat.aimX = seat.x;
    seat.aimY = seat.y;
    seat.hit = aim.probe(seat.x, seat.y, seat.holding);
    if (seat.drag || placing || seat.hit.kind === "part") return;
    const r = stage.canvas.getBoundingClientRect();
    let best: { x: number; y: number; d: number } | null = null;
    for (const o of world.pickables()) {
      o.getWorldPosition(this.v).project(stage.camera);
      if (this.v.z > 1) continue;
      const sx = r.left + ((this.v.x + 1) / 2) * r.width;
      const sy = r.top + ((1 - this.v.y) / 2) * r.height;
      const dist = Math.hypot(sx - seat.x, sy - seat.y);
      if (dist <= ASSIST_PX && (!best || dist < best.d)) best = { x: sx, y: sy, d: dist };
    }
    if (!best) return;
    const snapped: AimHit = aim.probe(best.x, best.y);
    if (snapped.kind !== "part") return;
    seat.hit = snapped;
    seat.aimX = best.x;
    seat.aimY = best.y;
  }

  /** Right stick: twist the toy it started on, or turn and zoom the shared camera. */
  private rightStick(pad: Pad, seat: SeatState, s: PadSnapshot, dt: number, under: Toy | null) {
    const [rx, ry] = radial(s.axes[AXIS.RX] ?? 0, s.axes[AXIS.RY] ?? 0);
    if (!rx && !ry) {
      pad.right = null;
      return;
    }
    pad.right ??= { toy: seat.holding ?? under };
    const toy = pad.right.toy;
    if (toy) {
      if (this.d.world.toys.includes(toy)) toy.nudge("twist", rx * TWIST_RATE * dt);
      return;
    }
    const { stage } = this.d;
    if (stage.rig !== "orbit") return;
    stage.orbit(-rx * ORBIT_RATE * dt, 0);
    stage.zoom(1 + ry * ZOOM_RATE * dt);
    this.cameraBy = seat;
  }

  /** 0..1 through the longest press-and-hold in progress (B put away, Menu leave), for the cursor ring. */
  holdProgress(seat: SeatState): number {
    const pad = [...this.pads.values()].find((p) => p.seat === seat);
    if (!pad) return 0;
    const b = pad.putAway ? (this.time - pad.putAway.at) / HOLD_PUT_AWAY : 0;
    const m = pad.menuAt !== null ? (this.time - pad.menuAt) / HOLD_LEAVE : 0;
    return THREE.MathUtils.clamp(Math.max(b, m), 0, 1);
  }

  private info(seat: SeatState, dx: number, dy: number): PointerInfo {
    return { x: seat.x, y: seat.y, dx, dy, hit: seat.hit?.intersection ?? null };
  }
}

/** Radial dead zone, rescaled to 0..1, then the x²·sign(x) curve on the magnitude. */
export function radial(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0];
  const t = Math.min(1, (m - DEAD) / (1 - DEAD));
  const k = (t * t) / m;
  return [x * k, y * k];
}
