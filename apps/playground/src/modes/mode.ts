import type { PulseState, Toy } from "../toys/toy";

/**
 * A mode changes the rules of the world without changing the toys (MODES.md §3.1).
 * Every local edit passes through it; remote edits and loading (`world.applying`)
 * bypass it, like they bypass `canEdit`.
 */
export interface Mode {
  id: string;
  /** The value to apply (clamped / snapped to what's allowed), or null to refuse. */
  constrain(toy: Toy, param: string, v: number): number | null;
  constrainPulse(toy: Toy, p: Partial<PulseState>): Partial<PulseState> | null;
  constrainPattern(toy: Toy, text: string): string | null;
  allowAdd(entryId: string): boolean;
  allowRemove(toy: Toy): boolean;
  allowMove(toy: Toy): boolean;
  allowWorld(what: "tempo" | "tuning"): boolean;
  update(dt: number): void;
  dispose(): void;
}

/** Everything is allowed: today's behaviour. */
export const sandbox: Mode = {
  id: "sandbox",
  constrain: (_t, _p, v) => v,
  constrainPulse: (_t, p) => p,
  constrainPattern: (_t, text) => text,
  allowAdd: () => true,
  allowRemove: () => true,
  allowMove: () => true,
  allowWorld: () => true,
  update() {},
  dispose() {},
};
