import { Kind, type KindId } from "../audio/protocol";
import type { ToyConfig } from "../audio/config";
import type { World } from "../world";
import { ConfigToy } from "./config-toy";
import { Kettle } from "./kettle";
import { Orrery } from "./orrery";
import { Spire } from "./spire";
import type { Toy } from "./toy";
import bottle from "./configs/bottle-organ.json";
import bowl from "./configs/singing-bowl.json";
import pendulum from "./configs/pendulum-clock.json";
import zapbox from "./configs/spark-box.json";

export interface ToyEntry {
  id: string;
  kind: KindId;
  name: string;
  family: string;
  color: string;
  /** Inline SVG icon for the chest (no text needed to play). */
  icon: string;
  /** Toys described as data (shown on the chest's "made from configs" shelf). */
  config?: ToyConfig;
  create(world: World, slot: number): Toy;
}

const BUILTIN: ToyEntry[] = [
  {
    id: "spire",
    kind: Kind.Spire,
    name: "Monochord Spire",
    family: "Vibration",
    color: "#b18cff",
    icon: `<svg viewBox="0 0 48 48"><path d="M16 6v36M16 8h10M24 8c6 8-6 16 0 24s-6 10 0 10" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="16" cy="6" r="4" fill="currentColor"/><circle cx="34" cy="16" r="2" fill="currentColor"/><circle cx="34" cy="24" r="2" fill="currentColor"/><circle cx="34" cy="32" r="2" fill="currentColor"/></svg>`,
    create: (w, s) => new Spire(w, s),
  },
  {
    id: "orrery",
    kind: Kind.Orrery,
    name: "Kepler Orrery",
    family: "Orbit",
    color: "#ffb347",
    icon: `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="5" fill="currentColor"/><circle cx="24" cy="24" r="11" stroke="currentColor" stroke-width="2" fill="none" opacity=".6"/><circle cx="24" cy="24" r="19" stroke="currentColor" stroke-width="2" fill="none" opacity=".6"/><circle cx="35" cy="24" r="3" fill="currentColor"/><circle cx="11" cy="11" r="3" fill="currentColor"/></svg>`,
    create: (w, s) => new Orrery(w, s),
  },
  {
    id: "kettle",
    kind: Kind.Kettle,
    name: "Reaction Kettle",
    family: "Reaction",
    color: "#3fe0c5",
    icon: `<svg viewBox="0 0 48 48"><path d="M8 22h32l-4 18H12z" stroke="currentColor" stroke-width="3" fill="none" stroke-linejoin="round"/><circle cx="20" cy="14" r="3" fill="currentColor"/><circle cx="29" cy="9" r="2" fill="currentColor"/><circle cx="27" cy="17" r="2.5" fill="currentColor"/><path d="M14 30c4-3 6 3 10 0s6 3 10 0" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
    create: (w, s) => new Kettle(w, s),
  },
];

const GENERIC_ICON = `<svg viewBox="0 0 48 48"><circle cx="24" cy="12" r="5" fill="currentColor"/><ellipse cx="24" cy="24" rx="12" ry="4" stroke="currentColor" stroke-width="3" fill="none"/><ellipse cx="24" cy="34" rx="15" ry="5" stroke="currentColor" stroke-width="3" fill="none"/></svg>`;

/** A chest entry for a toy described as data. */
export function configEntry(config: ToyConfig): ToyEntry {
  return {
    id: config.id,
    kind: Kind.Custom,
    name: config.name,
    family: config.family,
    color: config.color,
    icon: config.icon ?? GENERIC_ICON,
    config,
    create: (w, s) => new ConfigToy(w, s, config),
  };
}

const CONFIGS = [bowl, bottle, zapbox, pendulum] as unknown as ToyConfig[];

export const TOYS: ToyEntry[] = [...BUILTIN, ...CONFIGS.map(configEntry)];

/** Add (or replace, by id) a toy entry at runtime, e.g. one sent from the Forge. */
export function registerToy(entry: ToyEntry) {
  const i = TOYS.findIndex((t) => t.id === entry.id);
  if (i >= 0) TOYS[i] = entry;
  else TOYS.push(entry);
}

export const toyEntry = (id: string) => TOYS.find((t) => t.id === id);
