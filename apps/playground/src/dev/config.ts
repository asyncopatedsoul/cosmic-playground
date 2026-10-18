import files from "virtual:dev-config";
import { load, save } from "../prefs";

/**
 * Developer settings (docs/DEV-MODE.md §3.2), merged in this order:
 *
 *   built-in defaults < dev.config.json < dev.config.local.json < localStorage "cosmic.dev" < URL params
 *
 * The two files reach the page through `virtual:dev-config` (dev-files.ts);
 * production builds don't bundle them. URL params use dotted paths:
 * `?dev&dev.audio.muted=false&dev.log.channels.net=debug`.
 */
export const CHANNELS = ["app", "player", "world", "toy", "net", "session", "audio", "perf"] as const;
export type Channel = (typeof CHANNELS)[number];
export const LEVELS = ["off", "error", "warn", "info", "debug"] as const;
export type Level = (typeof LEVELS)[number];

export interface DevConfig {
  audio: {
    /** null: keep this device's own master volume. */
    master: number | null;
    /** Start muted (dev mode only; test mode is always muted, players never). */
    muted: boolean;
  };
  log: {
    /** Events kept in memory. */
    ring: number;
    /** Mirror events to the devtools console. */
    console: boolean;
    /** Where sessions are written: devlog/sessions/ through the dev server, or nowhere. */
    sink: "devlog" | "none";
    channels: Record<Channel, Level>;
    /** ms windows that coalesce continuous changes into one event. */
    throttle: Record<string, number>;
  };
  notes: { hotkey: string; attach: { world: boolean; log: number; screenshot: boolean } };
  scenarios: { autoload: string | null };
  panel: { hotkey: string; dock: "right" | "left"; open: boolean };
  flags: { fps: boolean; netdebug: boolean; reducedMotion: boolean | null; seed: string | null };
}

export const DEFAULTS: DevConfig = {
  audio: { master: null, muted: true },
  log: {
    ring: 5000,
    console: false,
    sink: "devlog",
    channels: { app: "info", player: "info", world: "info", toy: "info", net: "info", session: "info", audio: "warn", perf: "off" },
    throttle: { "toy.param": 100, "toy.derived": 1000, "toy.move": 250, "toy.volume": 150, "audio.master": 150 },
  },
  notes: { hotkey: "F8", attach: { world: true, log: 200, screenshot: true } },
  scenarios: { autoload: null },
  panel: { hotkey: "Backquote", dock: "right", open: false },
  flags: { fps: false, netdebug: false, reducedMotion: null, seed: null },
};

const STORAGE_KEY = "cosmic.dev";

/** Values that may only be one of a list. */
const ENUMS: Record<string, readonly unknown[]> = {
  "log.sink": ["devlog", "none"],
  "panel.dock": ["right", "left"],
  ...Object.fromEntries(CHANNELS.map((c) => [`log.channels.${c}`, LEVELS])),
};
/** Defaults that are null, and the type a value must have instead. */
const NULLABLE: Record<string, string> = {
  "audio.master": "number",
  "scenarios.autoload": "string",
  "flags.reducedMotion": "boolean",
  "flags.seed": "string",
};
/** Objects whose keys are open (any name, values typed like the defaults). */
const OPEN: Record<string, string> = { "log.throttle": "number" };
const RANGES: Record<string, [number, number]> = {
  "audio.master": [0, 1],
  "log.ring": [100, 100_000],
  "notes.attach.log": [0, 5000],
};

export interface Layer {
  name: string;
  values: unknown;
}

export interface Resolved {
  config: DevConfig;
  /** Unknown keys and bad values, with where they came from. */
  warnings: string[];
  /** What each layer contributed, for the panel. */
  layers: Layer[];
}

/** Merge every layer over the defaults. */
export function resolveConfig(search = location.search): Resolved {
  const layers: Layer[] = [];
  if (files.error) layers.push({ name: "files", values: null });
  if (files.file) layers.push({ name: "dev.config.json", values: files.file });
  if (files.local) layers.push({ name: "dev.config.local.json", values: files.local });
  const stored = storedOverrides();
  if (Object.keys(stored).length) layers.push({ name: "localStorage", values: stored });
  const url = urlOverrides(search);
  if (Object.keys(url).length) layers.push({ name: "URL", values: url });

  const warnings: string[] = files.error ? [`dev config files: ${files.error}`] : [];
  let config = clone(DEFAULTS);
  for (const l of layers) {
    if (l.values) config = merge(config, strip(l.values), "", (w) => warnings.push(`${l.name}: ${w}`));
  }
  return { config, warnings, layers };
}

/** Panel changes: only what differs from the files lives in localStorage. */
export function storedOverrides(): Record<string, unknown> {
  const v = load<unknown>(STORAGE_KEY, {});
  return isObject(v) ? v : {};
}

/** Remember one setting on this device (`path` is dotted, e.g. "log.channels.net"). */
export function setOverride(path: string, value: unknown) {
  const o = storedOverrides();
  setPath(o, path.split("."), value);
  save(STORAGE_KEY, o);
}

/** Forget every panel change ("Reset to file"). */
export function clearOverrides() {
  save(STORAGE_KEY, {});
}

function urlOverrides(search: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of new URLSearchParams(search)) {
    if (!k.startsWith("dev.")) continue;
    setPath(out, k.slice(4).split("."), parseValue(raw));
  }
  return out;
}

function parseValue(raw: string): unknown {
  if (raw === "true" || raw === "") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
}

function merge<T>(base: T, over: Record<string, unknown>, path: string, warn: (w: string) => void): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const p = path ? `${path}.${k}` : k;
    const open = OPEN[path];
    if (!(k in out) && !open) {
      warn(`unknown key "${p}"`);
      continue;
    }
    const b = out[k];
    if (isObject(b)) {
      if (isObject(v)) out[k] = merge(b, v, p, warn);
      else warn(`"${p}" should be an object`);
      continue;
    }
    const want = open ?? (b === null ? NULLABLE[p] : typeof b);
    const ok = (v === null && (b === null || p in NULLABLE)) || typeof v === want;
    if (!ok) {
      warn(`"${p}" should be ${b === null ? `${want} or null` : want}, got ${JSON.stringify(v)}`);
      continue;
    }
    if (ENUMS[p] && !ENUMS[p].includes(v)) {
      warn(`"${p}" must be one of ${ENUMS[p].join(", ")}, got ${JSON.stringify(v)}`);
      continue;
    }
    const range = RANGES[p];
    if (range && typeof v === "number" && (v < range[0] || v > range[1])) {
      warn(`"${p}" must be between ${range[0]} and ${range[1]}, got ${v}`);
      continue;
    }
    out[k] = v;
  }
  return out as T;
}

/** The file header isn't a setting. */
function strip(v: unknown): Record<string, unknown> {
  if (!isObject(v)) return {};
  const { format: _f, version: _v, ...rest } = v;
  return rest;
}

function setPath(o: Record<string, unknown>, keys: string[], value: unknown) {
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!isObject(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
