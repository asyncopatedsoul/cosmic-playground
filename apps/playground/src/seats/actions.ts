import type * as THREE from "three";
import type { Aim, AimHit } from "../aim";
import { MAX_TOYS } from "../audio/protocol";
import type { DragHandler, PointerInfo, Toy } from "../toys/toy";
import type { PulseEditor } from "../ui/pulse-editor";
import type { World } from "../world";
import { PUT_AWAY_DEPTH, type SeatState, type Seats } from "./seats";

/**
 * Seat actions shared by the mouse (seat 1, input.ts) and gamepad seats
 * (controllers/gamepad.ts): grab, handle drags, put away and its undo, with a
 * per-seat soft lock so two seats never drag the same toy.
 */
export interface ActionDeps {
  aim: Aim;
  world: World;
  editor: PulseEditor;
  seats: Seats;
}

/** Toy bases closer than this overlap (two base radii). */
export const BASE_GAP = 1.25;
/** Toys stay within this distance of the middle. */
const WORLD_RADIUS = 12;

/** Whether a toy may be placed at a surface hit (avatar right-click, the place picker). */
export function canPlace(world: World, hit: AimHit): boolean {
  if (hit.kind !== "surface" || !hit.inReach || !world.canEdit() || world.count >= MAX_TOYS) return false;
  return world.toys.every((t) => !t || t.worldPos.distanceTo(hit.point!) > BASE_GAP);
}

/** Another seat on this client is dragging `toy`. */
export function heldByOther(seats: Seats, seat: SeatState, toy: Toy): boolean {
  const h = seats.holder(toy);
  return !!h && h !== seat;
}

/** Let go of whatever the seat holds, without ending the drag's gesture. */
export function release(seat: SeatState) {
  seat.holding = null;
  seat.drag = null;
}

/** The seat holds `toy` until the drag ends. */
function hold(seat: SeatState, toy: Toy, h: DragHandler): DragHandler {
  const wrapped: DragHandler = {
    move: (p) => h.move(p),
    end: (p) => {
      if (seat.drag === wrapped) release(seat);
      h.end?.(p);
    },
  };
  seat.holding = toy;
  seat.drag = wrapped;
  return wrapped;
}

export interface GrabHooks {
  /** After each move (the mouse highlights the chest under the pointer). */
  moved?(p: PointerInfo): void;
  /** When the drag ends (the mouse puts the toy away if dropped on the chest). */
  ended?(p: PointerInfo): void;
}

/** Grab: drag a toy along the surface under the seat's cursor. Null if the room is locked or another seat holds it. */
export function grab(d: ActionDeps, seat: SeatState, toy: Toy, hooks: GrabHooks = {}): DragHandler | null {
  const { aim, seats, world } = d;
  // On focus view's ring a toy is shown, not placed: dragging its base does nothing (FOCUS-VIEW.md §4.2).
  if (!world.canEdit() || toy.home || heldByOther(seats, seat, toy)) return null;
  let offset: THREE.Vector3 | null = null;
  return hold(seat, toy, {
    move: (p) => {
      const h = aim.probeSurface(p.x, p.y, toy);
      if (h.kind !== "surface") return;
      const g = h.point!;
      offset ??= g.clone().sub(toy.group.position).setY(0);
      g.sub(offset).setY(0);
      if (g.length() > WORLD_RADIUS) g.setLength(WORLD_RADIUS);
      toy.moveTo(g);
      hooks.moved?.(p);
    },
    end: (p) => hooks.ended?.(p),
  });
}

/** Start dragging one of a toy's handles. Null if the part has no drag or another seat holds the toy. */
export function dragPart(d: ActionDeps, seat: SeatState, toy: Toy, part: string, p: PointerInfo): DragHandler | null {
  if (heldByOther(d.seats, seat, toy)) return null;
  const h = toy.down(part, p);
  return h ? hold(seat, toy, h) : null;
}

/** Put a toy away onto the seat's own undo stack. False if not allowed. */
export function putAway(d: ActionDeps, seat: SeatState, toy: Toy): boolean {
  const { editor, seats, world } = d;
  if (!world.canEdit() || heldByOther(seats, seat, toy)) return false;
  const snap = world.snapshot(toy);
  if (editor.toy === toy) editor.close();
  if (seat.holding === toy) release(seat);
  world.remove(toy);
  seat.putAway.push(snap);
  if (seat.putAway.length > PUT_AWAY_DEPTH) seat.putAway.shift();
  return true;
}

/** Bring back the seat's last put-away toy. */
export function undoPutAway(d: ActionDeps, seat: SeatState): Toy | null {
  const snap = seat.putAway.pop();
  if (!snap) return null;
  const toy = d.world.restore(snap);
  if (!toy) seat.putAway.push(snap);
  return toy;
}
