import { load, save } from "../prefs";

/** Size set points for the slider (AVATAR.md §13.2): S is "be tiny", M the child-sized default. */
export const SIZES = { S: 0.3, M: 1, L: 1.6 } as const;
export const SIZE_RANGE: [number, number] = [0.15, 2];

/** Per-device avatar settings. */
export class AvatarSettings {
  /** Scale of the child-sized avatar; eye height, speed, jump and reach follow it. */
  size: number = load("cosmic.avatar.size", SIZES.M);
  /** Freeze the fly frame at take-off instead of following the last body's up (AVATAR.md §13.1). */
  frozenFlyFrame = load("cosmic.avatar.frozenFly", false);
  /** Third person by default for a first session, so the world feels big around you. */
  thirdPerson = load("cosmic.avatar.third", true);
  /**
   * Toy Forms block the avatar (walk around a Spire) instead of being passable
   * light. Not exposed in the UI yet (AVATAR.md §13.3).
   */
  solidToys = false;

  set(patch: Partial<Pick<AvatarSettings, "size" | "frozenFlyFrame" | "thirdPerson">>) {
    Object.assign(this, patch);
    if (patch.size !== undefined) {
      this.size = snapSize(patch.size);
      save("cosmic.avatar.size", this.size);
    }
    if (patch.frozenFlyFrame !== undefined) save("cosmic.avatar.frozenFly", this.frozenFlyFrame);
    if (patch.thirdPerson !== undefined) save("cosmic.avatar.third", this.thirdPerson);
  }
}

/** Clamp to the slider's range and snap to a set point when close to one. */
export function snapSize(v: number): number {
  const c = Math.min(SIZE_RANGE[1], Math.max(SIZE_RANGE[0], v));
  for (const s of Object.values(SIZES)) if (Math.abs(c - s) < 0.06) return s;
  return Math.round(c * 100) / 100;
}
