/** One gamepad's state this frame, from the browser or from a test (fake-gamepad.ts). */
export interface PadSnapshot {
  /** Stable while connected: "pad:<index>" for real pads, "fake:<n>" for fakes. */
  key: string;
  /** `Gamepad.id` (brand and model, as the browser reports it). */
  id: string;
  /** "standard" when the browser knows the layout; "" otherwise. */
  mapping: string;
  /** Button values, 0..1 (triggers are analog). */
  buttons: number[];
  axes: number[];
  /** A short rumble, where supported. */
  rumble?(ms: number, strength: number): void;
}

/** Anything that can report gamepads once a frame. */
export interface GamepadSource {
  poll(): PadSnapshot[];
}

/** A button counts as down above this (analog triggers included). */
export const PRESSED = 0.5;

/** The browser's Gamepad API. Pads only appear after their first button press. */
export class NavigatorGamepads implements GamepadSource {
  poll(): PadSnapshot[] {
    if (!navigator.getGamepads) return [];
    const out: PadSnapshot[] = [];
    for (const g of navigator.getGamepads()) {
      if (!g || !g.connected) continue;
      out.push({
        key: `pad:${g.index}`,
        id: g.id,
        mapping: g.mapping,
        buttons: g.buttons.map((b) => (b.pressed ? Math.max(b.value, 1) : b.value)),
        axes: [...g.axes],
        rumble: (ms, strength) => {
          // Not in every browser's types or every pad; a missing actuator is fine.
          const a = (g as Gamepad & { vibrationActuator?: { playEffect?(t: string, p: object): Promise<unknown> } }).vibrationActuator;
          a?.playEffect?.("dual-rumble", { duration: ms, strongMagnitude: strength, weakMagnitude: strength })?.catch(() => {});
        },
      });
    }
    return out;
  }
}

/** Several sources at once (real pads plus fakes in dev mode). */
export class MergedSource implements GamepadSource {
  constructor(private sources: GamepadSource[]) {}

  poll(): PadSnapshot[] {
    return this.sources.flatMap((s) => s.poll());
  }
}
