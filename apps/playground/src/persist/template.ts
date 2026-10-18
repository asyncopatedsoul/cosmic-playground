import * as THREE from "three";
import type { ToyConfig } from "../audio/config";
import { isShipped, toyEntry } from "../toys/registry";
import type { Toy, ToyState } from "../toys/toy";
import { cleanToy, MAX_FILE_BYTES, newId } from "./doc";

/**
 * A toy variant (docs/SAVE-LOAD.md §6, REVISIONS.md R3.3): a base toy type plus
 * a preset, shown under its base in the chest. Tint and badge only; a variant
 * never changes the toy's Form. Unknown keys are kept and written back.
 */

export const TEMPLATE_FORMAT = "cosmic-toy";
export const TEMPLATE_VERSION = 1;

export interface ToyTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  id: string;
  /** Registry id of the root toy type (never another variant). */
  base: string;
  name: string;
  tint: string | null;
  badge: string | null;
  author: string | null;
  created: string;
  state: Required<Pick<ToyState, "params" | "pulse" | "pattern" | "recipe" | "volume">> & { wild?: true };
  /** Data toys whose config was edited: the full config, with `extends: base`. */
  config: (ToyConfig & { extends: string }) | null;
  [unknown: string]: unknown;
}

export type TemplateResult = { ok: true; template: ToyTemplate; readOnly: boolean } | { ok: false; error: string };

export const FORM_LOCKED = "Variants can change sound and colour, not shape (yet).";

/** Parse JSON text (or a parsed value) into a ToyTemplate. Never throws. */
export function parseTemplate(input: unknown): TemplateResult {
  try {
    let raw = input;
    if (typeof raw === "string") {
      if (raw.length > MAX_FILE_BYTES) return { ok: false, error: "That toy file is too big." };
      raw = JSON.parse(raw);
    }
    if (!isObj(raw) || raw.format !== TEMPLATE_FORMAT) return { ok: false, error: "That isn't a Cosmic Playground toy." };
    const version = Number(raw.version);
    if (!Number.isInteger(version) || version < 1) return { ok: false, error: "This toy file has no version." };
    const base = str(raw.base, 80);
    if (!base) return { ok: false, error: "This toy file doesn't say what kind of toy it is." };
    const id = /^v_[A-Z0-9]{8}$/.test(String(raw.id)) ? String(raw.id) : newId("v_");
    const s = isObj(raw.state) ? raw.state : {};
    const t = cleanToy({ ...s, kind: base });
    const config = cleanConfig(raw.config, base, id);
    if (typeof config === "string") return { ok: false, error: config };
    const template: ToyTemplate = {
      // Unknown keys first, so the known ones win and a round trip keeps both.
      ...raw,
      format: TEMPLATE_FORMAT,
      version,
      id,
      base,
      name: str(raw.name, 60).trim() || `My ${shortName(base)}`,
      tint: typeof raw.tint === "string" && /^#[0-9a-f]{6}$/i.test(raw.tint) ? raw.tint.toLowerCase() : null,
      badge: typeof raw.badge === "string" && raw.badge.trim() ? [...raw.badge.trim()].slice(0, 2).join("") : null,
      author: typeof raw.author === "string" ? raw.author.slice(0, 40) : null,
      created: str(raw.created, 40) || new Date().toISOString(),
      state: {
        params: t.params,
        pulse: t.pulse,
        pattern: t.pattern,
        recipe: t.recipe,
        volume: t.volume,
        ...(t.wild ? { wild: true as const } : {}),
      },
      config,
    };
    return { ok: true, template, readOnly: version > TEMPLATE_VERSION };
  } catch (e) {
    return { ok: false, error: e instanceof SyntaxError ? "That file isn't valid JSON." : `Couldn't read that toy: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A variant's config: built-ins have none; a data toy's must keep its base's `form`. */
function cleanConfig(c: unknown, base: string, id: string): ToyTemplate["config"] | string {
  if (c == null) return null;
  if (!isObj(c) || !isObj(c.voice) || !isObj(c.form)) return "This toy's sound settings are broken.";
  const entry = toyEntry(base);
  if (entry && !entry.config) return "Variants of this toy keep its sound; only its settings can change.";
  // The base is in this build: the shape must match. Otherwise the config travels as is.
  if (entry?.config && !deepEqual(c.form, entry.config.form)) return FORM_LOCKED;
  // Its own registry entry, never one that ships (that would replace a built-in toy).
  const cfgId = typeof c.id === "string" && c.id.length <= 120 && c.id !== base && !isShipped(c.id) ? c.id : `${base}~${id}`;
  return { ...(c as unknown as ToyConfig), id: cfgId, extends: base };
}

/** JSON for files, the clipboard and the store. */
export function serializeTemplate(t: ToyTemplate, pretty = false): string {
  return JSON.stringify(t, null, pretty ? 2 : undefined);
}

/** The root type a toy belongs to: a data-toy variant's config `extends` it. */
export function baseOf(entryId: string): string {
  return toyEntry(entryId)?.config?.extends ?? entryId;
}

/**
 * Snapshot a toy as a new variant: auto-named from what changed, a tint near
 * the base colour and a number badge. `taken` are the names already used.
 */
export function templateFrom(toy: Toy, taken: string[], index: number): ToyTemplate {
  const entry = toyEntry(toy.entryId);
  const base = baseOf(toy.entryId);
  const s = toy.state();
  const config = entry?.config?.extends ? (structuredClone(entry.config) as ToyTemplate["config"]) : null;
  const id = newId("v_");
  if (config) config.id = `${base}~${id}`;
  return {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    id,
    base,
    name: uniqueName(autoName(toy, base), taken),
    tint: tintNear(toyEntry(base)?.color ?? toy.css, index),
    badge: String(((index - 1) % 9) + 1),
    author: null,
    created: new Date().toISOString(),
    state: {
      params: s.params ?? {},
      pulse: s.pulse!,
      pattern: s.pattern ?? "",
      recipe: s.recipe ?? null,
      volume: s.volume ?? 0.8,
      ...(s.wild ? { wild: true as const } : {}),
    },
    config,
  };
}

/** A name from the biggest change against the toy's defaults: "Fast Orrery", "Moody Bottle". */
export function autoName(toy: Toy, base = baseOf(toy.entryId)): string {
  const s = toy.state();
  const scores: [string, number][] = [];
  for (const [name, d] of Object.entries(toy.defs)) {
    if (d.derived) continue;
    const delta = ((s.params?.[name] ?? d.default) - d.default) / (d.range[1] - d.range[0] || 1);
    if (Math.abs(delta) > 0.08) scores.push([paramWord(name, delta > 0), Math.abs(delta)]);
  }
  const p = s.pulse!;
  if (p.speed > 1 || p.stepsPerBeat >= 3) scores.push(["Fast", 0.5]);
  if (p.speed < 1 || p.stepsPerBeat === 1) scores.push(["Slow", 0.5]);
  const hits = p.prob.slice(0, p.steps).filter((x) => x > 0).length / Math.max(1, p.steps);
  if (hits > 0.6) scores.push(["Busy", 0.35]);
  if (p.prob.slice(0, p.steps).some((x) => x > 0 && x < 1)) scores.push(["Dreamy", 0.3]);
  if (s.pattern) scores.push(["Chatty", 0.4]);
  if ((s.volume ?? 0.8) < 0.45) scores.push(["Soft", 0.3]);
  if ((s.volume ?? 0.8) > 0.95) scores.push(["Loud", 0.3]);
  scores.sort((a, b) => b[1] - a[1]);
  const word = scores[0]?.[0] ?? FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
  return `${word} ${shortName(base)}`;
}

const FALLBACK = ["Lucky", "Starry", "Cosy", "Sunny", "Secret"];

function paramWord(name: string, up: boolean): string {
  const n = name.toLowerCase();
  if (/speed|rate|tempo/.test(n)) return up ? "Fast" : "Slow";
  if (/harm|pitch|freq|note|tone|tune/.test(n)) return up ? "High" : "Low";
  if (/length|size|radius|^p\d$|wide|far/.test(n)) return up ? "Big" : "Little";
  if (/tension|tight/.test(n)) return up ? "Tight" : "Loose";
  if (/reagent|fizz|bright|drive|noise/.test(n)) return up ? "Fizzy" : "Calm";
  return up ? "Wild" : "Moody";
}

function shortName(base: string): string {
  return (toyEntry(base)?.name ?? base).split(" ").pop() ?? base;
}

function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let i = 2; ; i++) if (!taken.includes(`${name} ${i}`)) return `${name} ${i}`;
}

/** A tint that stays near the base colour: a small hue step per variant, a touch lighter. */
export function tintNear(css: string, index: number): string {
  const c = new THREE.Color(css);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const steps = [0.06, -0.06, 0.11, -0.11, 0.03, -0.03, 0.15, -0.15];
  const dh = steps[(index - 1) % steps.length];
  c.setHSL((hsl.h + dh + 1) % 1, Math.min(1, hsl.s * 0.95), Math.min(0.82, hsl.l + 0.06));
  return `#${c.getHexString()}`;
}

/** File names for toy exports: `<name>.cosmic-toy.json`. */
export function templateFileName(t: ToyTemplate) {
  const base = t.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").trim().slice(0, 60) || "toy";
  return `${base}.cosmic-toy.json`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function isObj(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown, max: number): string {
  return typeof x === "string" ? x.slice(0, max) : "";
}
