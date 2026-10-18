import * as THREE from "three";
import { validate as validateConfig, type ToyConfig } from "../audio/config";
import { MAX_STEPS, MAX_TOYS, SCALE_CUSTOM, type ModuleSpec } from "../audio/protocol";
import { configEntry, isShipped, registerToy, toyEntry } from "../toys/registry";
import { euclid, type PulseState, type ToyState } from "../toys/toy";
import { library } from "./library";
import type { CustomTuning, World } from "../world";

/**
 * The `WorldDoc` (docs/SAVE-LOAD.md §3): one plain, versioned JSON shape for
 * the autosave, named saves, `.constellation.json` files and share links.
 * Nothing in it refers to a local store (no IndexedDB keys, paths or device ids).
 */

export const FORMAT = "cosmic-world";
export const VERSION = 1;
/** Import limits (SAVE-LOAD.md §8). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MODULE_BYTES = 512 * 1024;
const MAX_TEMPLATES = 64;

export interface ToyDoc {
  id: string;
  /** Registry id. */
  kind: string;
  /** The variant it came from (SAVE-LOAD.md §6), embedded in `WorldDoc.templates`. */
  template?: string | null;
  /** An embedded config for this toy alone; usually null, configs live in `WorldDoc.configs`. */
  config: ToyConfig | null;
  pos: [number, number, number];
  quat: [number, number, number, number];
  body: string | null;
  params: Record<string, number>;
  pulse: PulseState;
  pattern: string;
  recipe: number[] | null;
  volume: number;
  wild?: true;
}

/** A WASM voice module, stored once per world by content hash. */
export interface ModuleDoc {
  abi: ModuleSpec["abi"];
  /** Base64 of the module bytes. */
  bytes: string;
  json?: string;
}

export interface ViewDoc {
  camera: { azimuth: number; elevation: number; distance: number; target: [number, number, number] };
}

export interface WorldDoc {
  format: typeof FORMAT;
  version: number;
  name: string;
  created: string;
  modified: string;
  app: { build: string; engine: string };
  seed: string;
  tempo: { bpm: number };
  tuning: { root: number; scale: number; wild: boolean; custom: CustomTuning | null };
  toys: ToyDoc[];
  templates: Record<string, unknown>;
  configs: Record<string, ToyConfig>;
  modules: Record<string, ModuleDoc>;
  bodies: unknown[];
  view?: ViewDoc;
  thumbnail?: string;
}

/** What a save knows that the world doesn't: its name, dates and seed. */
export interface DocMeta {
  name: string;
  created: string;
  seed: string;
}

const KNOWN_DOC_KEYS = new Set(["format", "version", "name", "created", "modified", "app", "seed", "tempo", "tuning", "toys", "templates", "configs", "modules", "bodies", "view", "thumbnail"]);
const KNOWN_TOY_KEYS = new Set(["id", "kind", "template", "config", "pos", "quat", "body", "params", "pulse", "pattern", "recipe", "volume", "wild"]);

const BASE32 = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

/** A random 8-character id, optionally with a type prefix (`w_`, `t_`, `v_`). */
export function newId(prefix = ""): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return prefix + Array.from(b, (x) => BASE32[x & 31]).join("");
}

const round = (x: number, places = 4) => Math.round(x * 10 ** places) / 10 ** places;

// ---- world → doc ------------------------------------------------------------

/** Snapshot the world as a WorldDoc. Async only because module bytes are hashed. */
export async function toDoc(world: World, meta: DocMeta, extra: { view?: ViewDoc; thumbnail?: string; modified?: string } = {}): Promise<WorldDoc> {
  const configs: Record<string, ToyConfig> = {};
  const modules: Record<string, ModuleDoc> = {};
  const toys: ToyDoc[] = [];
  // Every variant the world came with stays (a round trip is exact); variants placed since join them.
  const keptTemplates = (world.kept.keys.templates ?? {}) as Record<string, unknown>;
  const templates: Record<string, unknown> = { ...keptTemplates };
  for (const toy of world.toys) {
    if (!toy) continue;
    const entry = toyEntry(toy.entryId);
    if (entry?.config && !isShipped(entry.id) && !configs[entry.id]) configs[entry.id] = await packConfig(entry.config, modules);
    const s = toy.state();
    const p = toy.worldPos;
    if (toy.template && !templates[toy.template]) {
      const t = keptTemplates[toy.template] ?? library.get(toy.template);
      if (t) templates[toy.template] = t;
    }
    toys.push({
      id: toy.id,
      kind: toy.entryId,
      ...(toy.template ? { template: toy.template } : {}),
      config: null,
      pos: [p.x, p.y, p.z],
      quat: [0, 0, 0, 1],
      body: null,
      params: s.params ?? {},
      pulse: s.pulse!,
      pattern: s.pattern ?? "",
      recipe: s.recipe ?? null,
      volume: s.volume ?? 0.8,
      ...(s.wild ? { wild: true as const } : {}),
      // Unknown keys go last, so a save → load → save round trip is byte-identical.
      ...world.kept.toyKeys.get(toy.id),
    });
  }
  // Toys this build couldn't place go back exactly as they came.
  for (const t of world.kept.toys) toys.push(t as unknown as ToyDoc);

  const { configs: keptConfigs, modules: keptModules, templates: _t, bodies, ...unknown } = world.kept.keys as {
    configs?: Record<string, ToyConfig>;
    modules?: Record<string, ModuleDoc>;
    templates?: Record<string, unknown>;
    bodies?: unknown[];
  };
  return {
    format: FORMAT,
    version: VERSION,
    name: meta.name,
    created: meta.created,
    modified: extra.modified ?? new Date().toISOString(),
    app: { build: __BUILD_ID__, engine: "hypertoy-wasm" },
    seed: meta.seed,
    tempo: { bpm: world.bpm },
    tuning: {
      root: world.tuning.root,
      scale: world.tuning.scale,
      wild: world.tuning.wild,
      custom: world.tuning.scale === SCALE_CUSTOM ? world.customTuning : null,
    },
    toys,
    templates,
    configs: { ...keptConfigs, ...configs },
    modules: { ...keptModules, ...modules },
    bodies: bodies ?? [],
    ...(extra.view ? { view: extra.view } : {}),
    ...(extra.thumbnail ? { thumbnail: extra.thumbnail } : {}),
    ...unknown,
  };
}

/** The orbit camera as a view bookmark. */
export function viewOf(world: World): ViewDoc {
  const o = world.stage.getOrbit();
  return {
    camera: {
      azimuth: round(o.azimuth),
      elevation: round(o.elevation),
      distance: round(o.distance),
      target: [round(o.target.x), round(o.target.y), round(o.target.z)],
    },
  };
}

/** A config as JSON: module bytes move into `modules`, keyed by hash. */
async function packConfig(cfg: ToyConfig, modules: Record<string, ModuleDoc>): Promise<ToyConfig> {
  const v = cfg.voice;
  if (v.engine !== "module") return structuredClone(cfg);
  const bytes = new Uint8Array(v.module.bytes);
  const hash = `sha256:${await sha256(bytes)}`;
  modules[hash] = { abi: v.module.abi, bytes: toBase64(bytes), ...(v.module.json ? { json: v.module.json } : {}) };
  const { bytes: _b, json: _j, ...rest } = v.module;
  return { ...cfg, voice: { engine: "module", module: { ...rest, bytes: hash } as unknown as typeof v.module } };
}

// ---- parsing and validation -------------------------------------------------

export type ParseResult = { ok: true; doc: WorldDoc; readOnly: boolean; warnings: string[] } | { ok: false; error: string };

/** Parse JSON text (or an already-parsed value) into a WorldDoc. Never throws. */
export function parseDoc(input: unknown): ParseResult {
  try {
    let raw = input;
    if (typeof raw === "string") {
      if (raw.length > MAX_FILE_BYTES) return { ok: false, error: "That world is too big (over 2 MB)." };
      raw = JSON.parse(raw);
    }
    if (!isObj(raw)) return { ok: false, error: "That isn't a Cosmic Playground world." };
    if (raw.format !== FORMAT) {
      if (raw.format === "cosmic-toy") return { ok: false, error: "That's a toy, not a world (toy files arrive with variants)." };
      return { ok: false, error: "That isn't a Cosmic Playground world." };
    }
    const version = Number(raw.version);
    if (!Number.isInteger(version) || version < 1) return { ok: false, error: "This world file has no version." };
    const readOnly = version > VERSION;
    const warnings: string[] = [];
    if (readOnly) warnings.push("This world was saved by a newer Cosmic Playground; it opens, but saving it here may lose things.");
    const doc = clean(migrate(raw), warnings);
    return { ok: true, doc, readOnly, warnings };
  } catch (e) {
    return { ok: false, error: e instanceof SyntaxError ? "That file isn't valid JSON." : `Couldn't read that world: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Step older versions forward one at a time (v1 → v2 → …). v1 is the first. */
export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const doc = { ...raw };
  // Future: if (doc.version === 1) { …; doc.version = 2; }
  return doc;
}

/** Check types and ranges, fill gaps, and keep unknown keys as they are. */
function clean(raw: Record<string, unknown>, warnings: string[]): WorldDoc {
  const tempo = isObj(raw.tempo) ? raw.tempo : {};
  const tuning = isObj(raw.tuning) ? raw.tuning : {};
  const toysIn = Array.isArray(raw.toys) ? raw.toys : [];
  if (toysIn.length > MAX_TOYS) warnings.push(`Only the first ${MAX_TOYS} toys fit in a world.`);
  const configs: Record<string, ToyConfig> = {};
  for (const [id, c] of Object.entries(isObj(raw.configs) ? raw.configs : {})) if (isObj(c)) configs[id] = c as unknown as ToyConfig;
  const modules: Record<string, ModuleDoc> = {};
  for (const [hash, m] of Object.entries(isObj(raw.modules) ? raw.modules : {})) {
    if (!isObj(m) || typeof m.bytes !== "string" || (m.abi !== "vma" && m.abi !== "faust")) continue;
    if ((m.bytes.length * 3) / 4 > MAX_MODULE_BYTES) {
      warnings.push("A custom sound in this world is too big to load.");
      continue;
    }
    modules[hash] = { abi: m.abi, bytes: m.bytes, ...(typeof m.json === "string" ? { json: m.json } : {}) };
  }
  const templates = isObj(raw.templates) ? raw.templates : {};
  if (Object.keys(templates).length > MAX_TEMPLATES) warnings.push(`Only ${MAX_TEMPLATES} variants are kept per world.`);
  const view = cleanView(raw.view);
  return {
    ...raw,
    format: FORMAT,
    version: Number(raw.version),
    name: str(raw.name, 80) || "Untitled world",
    created: str(raw.created, 40) || new Date().toISOString(),
    modified: str(raw.modified, 40) || new Date().toISOString(),
    app: isObj(raw.app) ? { build: str(raw.app.build, 80), engine: str(raw.app.engine, 80) } : { build: "", engine: "" },
    seed: str(raw.seed, 32) || newId(),
    tempo: { bpm: clampNum(tempo.bpm, 40, 180, 96) },
    tuning: {
      root: Math.round(clampNum(tuning.root, 0, 127, 60)),
      scale: Math.round(clampNum(tuning.scale, 0, 255, 0)),
      wild: tuning.wild === true,
      custom: cleanCustom(tuning.custom),
    },
    toys: toysIn.slice(0, MAX_TOYS).filter(isObj).map(cleanToy),
    templates: Object.fromEntries(Object.entries(templates).slice(0, MAX_TEMPLATES)),
    configs,
    modules,
    bodies: Array.isArray(raw.bodies) ? raw.bodies : [],
    ...(view ? { view } : {}),
    ...(typeof raw.thumbnail === "string" && raw.thumbnail.startsWith("data:image/") ? { thumbnail: raw.thumbnail } : {}),
  } as WorldDoc;
}

/** Check a toy's fields (also used for a variant's state, persist/template.ts). */
export function cleanToy(t: Record<string, unknown>): ToyDoc {
  const pos = vec(t.pos, 3, 0, 40) as [number, number, number];
  const p = isObj(t.pulse) ? t.pulse : {};
  // Keep the saved length (the Orrery has none): only clamp, so a round trip is exact.
  const prob = Array.isArray(p.prob) ? p.prob.slice(0, MAX_STEPS).map((x) => clampNum(x, 0, 1, 0)) : euclid(3, 8);
  const params: Record<string, number> = {};
  for (const [k, v] of Object.entries(isObj(t.params) ? t.params : {})) if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
  return {
    ...t,
    id: str(t.id, 40) || newId("t_"),
    kind: str(t.kind, 80),
    config: isObj(t.config) ? (t.config as unknown as ToyConfig) : null,
    pos,
    quat: vec(t.quat, 4, 1, 1, [0, 0, 0, 1]) as [number, number, number, number],
    body: typeof t.body === "string" ? t.body : null,
    params,
    pulse: {
      enabled: p.enabled === true,
      steps: Math.round(clampNum(p.steps, 1, MAX_STEPS, 8)),
      prob,
      stepsPerBeat: Math.round(clampNum(p.stepsPerBeat, 1, 4, 2)),
      speed: clampNum(p.speed, 0, 16, 1),
    },
    pattern: str(t.pattern, 4000),
    recipe: Array.isArray(t.recipe) ? t.recipe.slice(0, 32).map((x) => (typeof x === "number" && Number.isFinite(x) ? x : 0)) : null,
    volume: clampNum(t.volume, 0, 1, 0.8),
    ...(t.wild === true ? { wild: true as const } : { wild: undefined }),
  };
}

function cleanCustom(c: unknown): CustomTuning | null {
  if (!isObj(c)) return null;
  const name = str(c.name, 80) || "Custom";
  if (typeof c.scl === "string") return { name, scl: c.scl.slice(0, 64 * 1024) };
  if (Array.isArray(c.cents) && c.cents.length > 0 && c.cents.length <= 256 && c.cents.every((x) => typeof x === "number" && Number.isFinite(x))) {
    return { name, cents: c.cents as number[], period: clampNum(c.period, 1, 4800, 1200) };
  }
  return null;
}

function cleanView(v: unknown): ViewDoc | null {
  if (!isObj(v) || !isObj(v.camera)) return null;
  const c = v.camera;
  return {
    camera: {
      azimuth: clampNum(c.azimuth, -1e4, 1e4, 0),
      elevation: clampNum(c.elevation, 0.15, 1.35, 0.6),
      distance: clampNum(c.distance, 2, 60, 9.5),
      target: vec(c.target, 3, 0, 40) as [number, number, number],
    },
  };
}

// ---- doc → world ------------------------------------------------------------

export interface LoadResult {
  /** The saved camera bookmark; `loadDoc` never moves the camera itself (SAVE-LOAD.md §3). */
  view: ViewDoc | null;
  /** Toys kept as data because this build can't make them. */
  placeholders: number;
  /** Things worth telling the player. */
  notes: string[];
}

export interface LoadOptions {
  /** Whether embedded WASM voice modules may load (the player said yes). */
  allowModules: boolean;
}

/** Number of embedded custom voice modules in a doc (they need the player's OK, SAVE-LOAD.md §8). */
export function moduleCount(doc: WorldDoc): number {
  return Object.values(doc.configs).filter((c) => isObj(c) && isObj(c.voice) && c.voice.engine === "module").length;
}

/**
 * Replace the world with `doc`: toys out, tempo and Tuning, embedded configs
 * registered, then toys in, each with its state applied before its first
 * Pulse. Runs through the world's normal edit path, so a room hears it.
 */
export function loadDoc(world: World, doc: WorldDoc, opts: LoadOptions): LoadResult {
  const notes: string[] = [];
  for (const toy of world.toys) if (toy) world.remove(toy);
  world.clearSelection();
  world.kept.toys.length = 0;
  world.kept.toyKeys.clear();
  world.kept.keys = {};
  for (const [k, v] of Object.entries(doc)) if (!KNOWN_DOC_KEYS.has(k)) world.kept.keys[k] = v;
  world.kept.keys.templates = doc.templates;
  world.kept.keys.bodies = doc.bodies;

  world.setTempo(doc.tempo.bpm);
  const { root, scale, wild, custom } = doc.tuning;
  if (custom && "cents" in custom) world.setTuningTable(custom.name, custom.cents, custom.period);
  else if (custom && "scl" in custom) world.setTuningScala(custom.name, custom.scl);
  world.setTuning(custom ? { root, wild } : { root, scale: scale === SCALE_CUSTOM ? 0 : scale, wild });

  // Configs this build doesn't ship: compile-checked like the Forge's, then registered.
  const unusable = new Set<string>();
  const keptConfigs: Record<string, ToyConfig> = {};
  const keptModules: Record<string, ModuleDoc> = {};
  const embedded = { ...doc.configs };
  for (const t of doc.toys) if (t.config && !embedded[t.kind]) embedded[t.kind] = t.config;
  for (const [id, raw] of Object.entries(embedded)) {
    if (isShipped(id)) continue;
    const cfg = unpackConfig(raw, doc.modules, opts.allowModules);
    const problem = cfg ? validateConfig(cfg) : "custom sound not loaded";
    if (!cfg || problem || cfg.id !== id) {
      unusable.add(id);
      keptConfigs[id] = raw;
      const hash = moduleHash(raw);
      if (hash && doc.modules[hash]) keptModules[hash] = doc.modules[hash];
      if (cfg && problem) notes.push(`${cfg.name ?? id}: ${problem}`);
      continue;
    }
    registerToy(configEntry(cfg));
  }
  world.kept.keys.configs = keptConfigs;
  world.kept.keys.modules = keptModules;

  let placeholders = 0;
  for (const t of doc.toys) {
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t)) if (!KNOWN_TOY_KEYS.has(k)) extra[k] = v;
    const template = typeof t.template === "string" ? t.template : null;
    const tint = template ? tintOf(doc.templates[template] ?? library.get(template)) : null;
    const state: ToyState = { params: t.params, pulse: t.pulse, pattern: t.pattern, recipe: t.recipe, volume: t.volume, wild: t.wild === true, tint };
    const toy = !unusable.has(t.kind) && toyEntry(t.kind) ? world.add(t.kind, new THREE.Vector3(...t.pos), t.id, state) : null;
    if (toy) toy.template = template;
    if (!toy) {
      placeholders++;
      world.kept.toys.push(stripUndefined(t));
      continue;
    }
    if (Object.keys(extra).length) world.kept.toyKeys.set(toy.id, extra);
  }
  if (placeholders) notes.push(`${placeholders === 1 ? "1 toy needs" : `${placeholders} toys need`} a newer Cosmic Playground (kept safe in the file).`);
  return { view: doc.view ?? null, placeholders, notes };
}

/** Empty the world for *New*: no toys, default tempo and Tuning. */
export function clearWorld(world: World) {
  for (const toy of world.toys) if (toy) world.remove(toy);
  world.clearSelection();
  world.kept.toys.length = 0;
  world.kept.toyKeys.clear();
  world.kept.keys = {};
  world.setTempo(96);
  world.setTuning({ root: 60, scale: 0, wild: false });
}

function tintOf(t: unknown): string | null {
  return isObj(t) && typeof t.tint === "string" && /^#[0-9a-f]{6}$/i.test(t.tint) ? t.tint : null;
}

function moduleHash(cfg: ToyConfig): string | null {
  const v = cfg.voice as { engine?: string; module?: { bytes?: unknown } };
  return v?.engine === "module" && typeof v.module?.bytes === "string" ? v.module.bytes : null;
}

/** A config from JSON: module voices get their bytes back from `modules` (if allowed). */
function unpackConfig(raw: ToyConfig, modules: Record<string, ModuleDoc>, allowModules: boolean): ToyConfig | null {
  if (!isObj(raw) || !isObj(raw.voice)) return null;
  const hash = moduleHash(raw);
  if (raw.voice.engine !== "module") return structuredClone(raw);
  if (!allowModules || !hash || !modules[hash]) return null;
  const m = modules[hash];
  const cfg = structuredClone(raw);
  if (cfg.voice.engine !== "module") return null;
  cfg.voice.module = { ...cfg.voice.module, abi: m.abi, bytes: fromBase64(m.bytes).buffer as ArrayBuffer, ...(m.json ? { json: m.json } : {}) };
  return cfg;
}

// ---- helpers ----------------------------------------------------------------

/** JSON for files and stores; `undefined` fields drop out. */
export function serialize(doc: WorldDoc, pretty = false): string {
  return JSON.stringify(doc, null, pretty ? 2 : undefined);
}

function stripUndefined<T extends object>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function isObj(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown, max: number): string {
  return typeof x === "string" ? x.slice(0, max) : "";
}

function clampNum(x: unknown, lo: number, hi: number, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
}

function vec(x: unknown, n: number, fallback: number, limit: number, defaults?: number[]): number[] {
  const a = Array.isArray(x) ? x : [];
  return Array.from({ length: n }, (_, i) => clampNum(a[i], -limit, limit, defaults ? defaults[i] : fallback));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
