import type { AimHit } from "../aim";
import { localPlayer, PLAYER_COLORS } from "../net/presence";
import type { DragHandler, Toy } from "../toys/toy";
import type { ToySnapshot } from "../world";

/**
 * A seat is one player on this client (docs/LOCAL-MULTIPLAYER.md, cut down by
 * docs/PLAYTESTS.md §3.1): the mouse is always seat 1, each gamepad that joins
 * takes the next free number. Seats share the client's role and the camera;
 * each has its own cursor, held toy and put-away stack.
 */
export interface SeatState {
  /** Stable for the seat's lifetime ("mouse", "pad:0", "fake:1", ...). */
  id: string;
  /** 1 for the mouse, 2.. for gamepads; reused after a seat leaves. */
  number: number;
  color: string;
  /** What drives it: "mouse" or the gamepad's key. */
  device: string;
  /** Cursor in client (CSS) pixels. Unused by seat 1, which aims with the pointer. */
  x: number;
  y: number;
  /** Where the seat actually aims: the cursor, or the toy part aim assist snapped it to. */
  aimX: number;
  aimY: number;
  /** What the cursor is on this frame (after aim assist). */
  hit: AimHit | null;
  /** The toy this seat is dragging (soft lock: no other seat may grab it). */
  holding: Toy | null;
  /** The active drag (a grab or a handle). */
  drag: DragHandler | null;
  /** Put-away toys, newest last, for this seat's undo. */
  putAway: ToySnapshot[];
  /** Actions taken so far; the first-use hint fades after a few. */
  actions: number;
}

/** Most gamepads Windows reports at once; seats 2..5. */
export const MAX_PAD_SEATS = 4;
/** Each seat's undo keeps this many put-away toys. */
export const PUT_AWAY_DEPTH = 20;

export class Seats {
  /** Seat 1 first, then gamepad seats in join order. */
  readonly list: SeatState[];
  onJoin: ((seat: SeatState) => void) | null = null;
  onLeave: ((seat: SeatState) => void) | null = null;

  constructor() {
    this.list = [blank("mouse", 1, localPlayer().color, "mouse")];
  }

  get mouse(): SeatState {
    return this.list[0];
  }

  /** Gamepad seats only. */
  get pads(): SeatState[] {
    return this.list.slice(1);
  }

  byDevice(device: string): SeatState | null {
    return this.list.find((s) => s.device === device) ?? null;
  }

  /** Seat a new device at (x, y); null when all gamepad seats are taken. */
  join(device: string, x: number, y: number): SeatState | null {
    if (this.byDevice(device)) return this.byDevice(device);
    if (this.pads.length >= MAX_PAD_SEATS) return null;
    // The player may have changed colour in the Room sheet since we started.
    this.mouse.color = localPlayer().color;
    let number = 2;
    while (this.list.some((s) => s.number === number)) number++;
    const used = new Set(this.list.map((s) => s.color.toLowerCase()));
    const color = PLAYER_COLORS.find((c) => !used.has(c.toLowerCase())) ?? PLAYER_COLORS[number % PLAYER_COLORS.length];
    const seat = blank(`${device}#${number}`, number, color, device);
    seat.x = seat.aimX = x;
    seat.y = seat.aimY = y;
    this.list.push(seat);
    this.list.sort((a, b) => a.number - b.number);
    this.onJoin?.(seat);
    return seat;
  }

  /** A gamepad seat leaves; its toys stay in the world. */
  leave(seat: SeatState) {
    const i = this.list.indexOf(seat);
    if (i <= 0) return;
    seat.drag?.end?.({ x: seat.x, y: seat.y, dx: 0, dy: 0, hit: null });
    seat.drag = null;
    seat.holding = null;
    this.list.splice(i, 1);
    this.onLeave?.(seat);
  }

  /** The seat holding `toy`, if any. */
  holder(toy: Toy): SeatState | null {
    return this.list.find((s) => s.holding === toy) ?? null;
  }
}

function blank(id: string, number: number, color: string, device: string): SeatState {
  return { id, number, color, device, x: 0, y: 0, aimX: 0, aimY: 0, hit: null, holding: null, drag: null, putAway: [], actions: 0 };
}
