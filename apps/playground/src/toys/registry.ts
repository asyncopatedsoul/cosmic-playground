import { Kind, type KindId } from "../audio/protocol";
import type { World } from "../world";
import { Kettle } from "./kettle";
import { Orrery } from "./orrery";
import { Spire } from "./spire";
import type { Toy } from "./toy";

export interface ToyEntry {
  kind: KindId;
  name: string;
  family: string;
  color: string;
  /** Inline SVG icon for the chest (no text needed to play). */
  icon: string;
  create(world: World, slot: number): Toy;
}

export const TOYS: ToyEntry[] = [
  {
    kind: Kind.Spire,
    name: "Monochord Spire",
    family: "Vibration",
    color: "#b18cff",
    icon: `<svg viewBox="0 0 48 48"><path d="M16 6v36M16 8h10M24 8c6 8-6 16 0 24s-6 10 0 10" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="16" cy="6" r="4" fill="currentColor"/><circle cx="34" cy="16" r="2" fill="currentColor"/><circle cx="34" cy="24" r="2" fill="currentColor"/><circle cx="34" cy="32" r="2" fill="currentColor"/></svg>`,
    create: (w, s) => new Spire(w, s),
  },
  {
    kind: Kind.Orrery,
    name: "Kepler Orrery",
    family: "Orbit",
    color: "#ffb347",
    icon: `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="5" fill="currentColor"/><circle cx="24" cy="24" r="11" stroke="currentColor" stroke-width="2" fill="none" opacity=".6"/><circle cx="24" cy="24" r="19" stroke="currentColor" stroke-width="2" fill="none" opacity=".6"/><circle cx="35" cy="24" r="3" fill="currentColor"/><circle cx="11" cy="11" r="3" fill="currentColor"/></svg>`,
    create: (w, s) => new Orrery(w, s),
  },
  {
    kind: Kind.Kettle,
    name: "Reaction Kettle",
    family: "Reaction",
    color: "#3fe0c5",
    icon: `<svg viewBox="0 0 48 48"><path d="M8 22h32l-4 18H12z" stroke="currentColor" stroke-width="3" fill="none" stroke-linejoin="round"/><circle cx="20" cy="14" r="3" fill="currentColor"/><circle cx="29" cy="9" r="2" fill="currentColor"/><circle cx="27" cy="17" r="2.5" fill="currentColor"/><path d="M14 30c4-3 6 3 10 0s6 3 10 0" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
    create: (w, s) => new Kettle(w, s),
  },
];

export const toyEntry = (kind: KindId) => TOYS.find((t) => t.kind === kind)!;
