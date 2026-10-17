import { AXIS, BUTTON } from "./gamepad-map";
import type { GamepadSource, PadSnapshot } from "./source";

type ButtonName = keyof typeof BUTTON;

interface FakePad {
  key: string;
  buttons: number[];
  axes: number[];
  rumbles: number;
}

/**
 * Scripted gamepads for dev mode and the seats scenario (dev/seats-scenario.ts):
 * the controller can't tell them from real ones. In dev, `cosmic.pads` is one
 * of these, so pads can be driven from the console:
 *
 *   const p = cosmic.pads.connect(); cosmic.pads.tap(p, "A"); cosmic.pads.stick(p, "left", 0.6, 0);
 */
export class FakeGamepadSource implements GamepadSource {
  private pads: FakePad[] = [];
  private next = 0;

  /** Plug in a pad; returns its handle. */
  connect(): number {
    const n = this.next++;
    this.pads.push({ key: `fake:${n}`, buttons: new Array(17).fill(0), axes: [0, 0, 0, 0], rumbles: 0 });
    return n;
  }

  disconnect(n: number) {
    this.pads = this.pads.filter((p) => p.key !== `fake:${n}`);
  }

  key(n: number) {
    return `fake:${n}`;
  }

  press(n: number, b: ButtonName, value = 1) {
    this.pad(n).buttons[BUTTON[b]] = value;
  }

  release(n: number, b: ButtonName) {
    this.pad(n).buttons[BUTTON[b]] = 0;
  }

  /** Press and release on the next frames. */
  async tap(n: number, b: ButtonName) {
    this.press(n, b);
    await nextFrame();
    await nextFrame();
    this.release(n, b);
    await nextFrame();
  }

  stick(n: number, which: "left" | "right", x: number, y: number) {
    const a = this.pad(n).axes;
    a[which === "left" ? AXIS.LX : AXIS.RX] = x;
    a[which === "left" ? AXIS.LY : AXIS.RY] = y;
  }

  /** How many rumbles the pad has been asked for. */
  rumbles(n: number) {
    return this.pad(n).rumbles;
  }

  poll(): PadSnapshot[] {
    return this.pads.map((p) => ({
      key: p.key,
      id: `Fake pad ${p.key} (STANDARD GAMEPAD)`,
      mapping: "standard",
      buttons: [...p.buttons],
      axes: [...p.axes],
      rumble: () => p.rumbles++,
    }));
  }

  private pad(n: number): FakePad {
    const p = this.pads.find((q) => q.key === `fake:${n}`);
    if (!p) throw new Error(`no fake pad ${n}`);
    return p;
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
