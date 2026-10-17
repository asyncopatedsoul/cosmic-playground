/**
 * The gamepad map for Orbit view (docs/PLAYTESTS.md §3.2), as the one table
 * the controller code, the in-game hint and the guide page all read, so they
 * can't drift. The player guides (docs/guides/) copy these rows by hand: when
 * a row changes here, change them too.
 *
 * Button and axis numbers are the W3C "standard" mapping (Xbox names, with the
 * PlayStation names alongside).
 */

export const BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  View: 8,
  Menu: 9,
  LS: 10,
  RS: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
} as const;

export const AXIS = { LX: 0, LY: 1, RX: 2, RY: 3 } as const;

export type PadAction =
  | "join"
  | "cursor"
  | "poke"
  | "grab"
  | "handle"
  | "stretch"
  | "twist"
  | "camera"
  | "pulse"
  | "picker"
  | "putAway"
  | "undo"
  | "focusMute"
  | "volume"
  | "leave";

export interface PadBinding {
  action: PadAction;
  /** Xbox names, as printed in the guide. */
  control: string;
  /** PlayStation names, or "" when the control has no other name. */
  ps: string;
  /** What it does, in the guide's words. */
  does: string;
  /** Buttons that trigger it: [primary, secondary] where an action goes both ways (up/down, less/more). */
  buttons?: readonly number[];
  axes?: readonly number[];
  /** Press-and-hold time, ms. */
  holdMs?: number;
}

export const GAMEPAD_MAP: readonly PadBinding[] = [
  { action: "join", control: "Any button", ps: "", does: "Join as the next player (a numbered ring in your colour appears)" },
  { action: "cursor", control: "Left stick", ps: "", does: "Move your cursor; it snaps to toys and handles within 24 px", axes: [AXIS.LX, AXIS.LY] },
  { action: "poke", control: "A", ps: "✕", does: "Poke what your cursor is on", buttons: [BUTTON.A] },
  { action: "grab", control: "Hold A on a toy's base", ps: "✕", does: "Grab it; the left stick slides it along the ground", buttons: [BUTTON.A], holdMs: 250 },
  { action: "handle", control: "Hold A on a handle", ps: "✕", does: "Drag the handle with the left stick", buttons: [BUTTON.A], holdMs: 250 },
  { action: "stretch", control: "RT / LT", ps: "R2 / L2", does: "Stretch the toy under your cursor up / down", buttons: [BUTTON.RT, BUTTON.LT] },
  { action: "twist", control: "Right stick left/right on a toy", ps: "", does: "Twist it", axes: [AXIS.RX] },
  { action: "camera", control: "Right stick over empty space", ps: "", does: "Turn the camera (left/right) and zoom (up/down)", axes: [AXIS.RX, AXIS.RY] },
  { action: "pulse", control: "X", ps: "□", does: "Start or stop the toy's Pulse", buttons: [BUTTON.X] },
  { action: "picker", control: "Y", ps: "△", does: "Open the place picker: LB / RB choose a toy, A places it at your cursor, B closes", buttons: [BUTTON.Y] },
  { action: "putAway", control: "Hold B on a toy for 1 s", ps: "○", does: "Put it away", buttons: [BUTTON.B], holdMs: 1000 },
  { action: "undo", control: "View", ps: "Create / Share", does: "Undo your last put-away", buttons: [BUTTON.View] },
  { action: "focusMute", control: "D-pad up / down", ps: "", does: "Focus / mute the toy under your cursor", buttons: [BUTTON.Up, BUTTON.Down] },
  { action: "volume", control: "D-pad left / right", ps: "", does: "That toy's volume down / up", buttons: [BUTTON.Left, BUTTON.Right] },
  { action: "leave", control: "Hold Menu 2 s", ps: "Options", does: "Leave (your toys stay)", buttons: [BUTTON.Menu], holdMs: 2000 },
];

/** Buttons inside the place picker (the `picker` row). */
export const PICKER = { prev: BUTTON.LB, next: BUTTON.RB, place: BUTTON.A, close: BUTTON.B } as const;

export function binding(action: PadAction): PadBinding {
  return GAMEPAD_MAP.find((b) => b.action === action)!;
}

/** The first-use hint by a new gamepad cursor (L4). */
export const PAD_HINT = "A poke · Y add a toy · hold B put away";
/** The hint fades after this many actions. */
export const HINT_ACTIONS = 3;
