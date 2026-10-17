// The Toy Forge (minimal, docs/AUDIO-GEN.md step F): write a Voice in Faust,
// compile it in a Worker, hear it hot-loaded into a custom toy slot, script
// its Pulse, then send it to the playground's chest. Also loads native Voice
// Modules (docs/VMA.md), like the example Ring Listener.

import { compileVoice, validate, type ConfigParam, type ToyConfig } from "../audio/config";
import { AudioHost } from "../audio/host";
import {
  describeLoadError,
  Kind,
  MODULE_LOAD_LIMIT,
  MODULE_LOAD_WARN,
  Param,
  SNAP_HEADER,
  SNAP_STRIDE,
  Snap,
  type ModuleCost,
  type ModuleSpec,
} from "../audio/protocol";
import type { Gesture } from "../toys/toy";
import type { CompileResult } from "./faust.worker";
import FaustWorker from "./faust.worker.ts?worker";
import type { MeasureResult } from "./measure.worker";
import MeasureWorker from "./measure.worker.ts?worker";
import "./forge.css";

const SLOT = 0;
export const FORGE_CHANNEL = "hypertoys-forge";

const EXAMPLES: Record<string, string> = {
  "FM bell": `import("stdfaust.lib");
// freq, gate and gain are wired to the toy: its Law, its Pulse, its velocity.
freq = hslider("freq", 220, 40, 2000, 0.01);
gate = button("gate");
gain = hslider("gain", 0.8, 0, 1, 0.01);
// Any other slider becomes a toy param; [gesture:twist] lets hands, wheels and MIDI turn it.
index = hslider("index [gesture:twist]", 2, 0, 8, 0.01);
env = en.adsr(0.005, 0.25, 0.3, 0.6, gate);
process = os.osc(freq + os.osc(freq * 2) * index * freq * env) * env * gain * 0.4 <: _, _;`,
  Djembe: `import("stdfaust.lib");
// A physical model from the Faust libraries, struck by the gate.
freq = hslider("freq", 120, 40, 800, 0.01);
gate = button("gate");
gain = hslider("gain", 0.8, 0, 1, 0.01);
pos = hslider("position [gesture:twist]", 0.3, 0, 1, 0.01);
process = gate : ba.impulsify : pm.djembe(freq, pos, 0.5, gain) <: _, _;`,
  "Listening comb": `import("stdfaust.lib");
// Audio input: pick "microphone" or another toy below. The comb rings at the toy's pitch.
freq = hslider("freq", 220, 40, 2000, 0.01);
gate = button("gate");
fb = hslider("feedback [gesture:twist]", 0.9, 0, 0.98, 0.001);
env = en.asr(0.01, 1, 0.8, gate);
comb = fi.fb_fcomb(4096, ma.SR / freq, 1, fb);
process = _, _ :> comb * env * 0.5 <: _, _;`,
};

interface FaustItem {
  type: string;
  shortname?: string;
  label?: string;
  min?: number;
  max?: number;
  init?: number;
  step?: number;
  meta?: Record<string, string>[];
  items?: FaustItem[];
}

const el = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const source = el<HTMLTextAreaElement>("#source");
const nameField = el<HTMLInputElement>("#name");
const status = el<HTMLElement>("#status");
const paramsEl = el<HTMLElement>("#params");
const pattern = el<HTMLInputElement>("#pattern");
const inputSel = el<HTMLSelectElement>("#input");
const meter = el<HTMLCanvasElement>("#meter");

const audio = new AudioHost();
const worker = new FaustWorker();
const measurer = new MeasureWorker();
let nextId = 1;
let current: ToyConfig | null = null;
let playing = false;

for (const name of Object.keys(EXAMPLES)) {
  const o = document.createElement("option");
  o.textContent = name;
  el<HTMLSelectElement>("#example").append(o);
}
source.value = EXAMPLES["FM bell"];
el<HTMLSelectElement>("#example").addEventListener("change", (e) => {
  const name = (e.target as HTMLSelectElement).value;
  source.value = EXAMPLES[name];
  nameField.value = name;
});

function say(msg: string, bad = false) {
  status.textContent = msg;
  status.classList.toggle("bad", bad);
}

function compileFaust(name: string, code: string): Promise<CompileResult> {
  const id = nextId++;
  return new Promise((resolve) => {
    const on = (ev: MessageEvent<CompileResult>) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", on);
      resolve(ev.data);
    };
    worker.addEventListener("message", on);
    worker.postMessage({ id, name, code });
  });
}

/** A ToyConfig for a compiled Faust module: freq/gate/gain are wired, other sliders become params. */
function faustConfig(name: string, wasm: ArrayBuffer, json: string): ToyConfig {
  const items: FaustItem[] = [];
  const walk = (xs: FaustItem[]) => xs.forEach((x) => (x.items ? walk(x.items) : items.push(x)));
  walk(JSON.parse(json).ui);
  const params: Record<string, ConfigParam> = {};
  const binds: Record<string, string> = {};
  const freq = items.find((x) => x.shortname === "freq");
  if (freq) {
    params.pitch = { range: [freq.min ?? 40, freq.max ?? 2000], default: freq.init ?? 220, unit: "Hz", gesture: "stretch" };
    binds.freq = "freq";
  }
  for (const x of items) {
    const n = x.shortname ?? x.label ?? "";
    if (n === "gate") binds.gate = "gate";
    else if (n === "gain" || n === "vel" || n === "velocity") binds[n] = "vel";
    else if (n !== "freq" && x.min !== undefined && x.max !== undefined && x.max > x.min) {
      const g = x.meta?.find((m) => m.gesture)?.gesture as Gesture | undefined;
      params[n] = { range: [x.min, x.max], default: x.init ?? x.min, step: x.step, gesture: g };
      binds[n] = n;
    }
  }
  return {
    id: `forge/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "toy"}`,
    name,
    family: "Forged",
    color: "#c792ff",
    params,
    law: freq ? { fn: "fixed", args: { freq: "pitch" }, wild: true } : { fn: "fixed", args: { freq: 220 } },
    voice: { engine: "module", module: { abi: "faust", bytes: wasm, json, binds, gate: 0.25, input: inputValue() } },
    pulse: { pattern: pattern.value },
    form: { kind: "totem" },
  };
}

/** The example native module (crates/vma-ring). */
async function ringConfig(): Promise<ToyConfig> {
  const r = await fetch(new URL(`${import.meta.env.BASE_URL}modules/ring.wasm`, location.href));
  if (!r.ok) throw new Error(`modules/ring.wasm: HTTP ${r.status} (run npm run build:wasm)`);
  const bytes = await r.arrayBuffer();
  const module: Omit<ModuleSpec, "binds"> & { binds: Record<string, string> } = {
    abi: "vma",
    bytes,
    binds: { "0": "freq", "1": "gate", "2": "depth", "3": "echo" },
    gate: 0.4,
    input: inputValue(),
  };
  return {
    id: "forge/ring-listener",
    name: "Ring Listener",
    family: "Forged",
    color: "#ff9e64",
    params: {
      pitch: { range: [60, 1200], default: 220, unit: "Hz", gesture: "stretch" },
      depth: { range: [0, 1], default: 0.8, gesture: "twist" },
      echo: { range: [0, 0.9], default: 0.4 },
    },
    law: { fn: "fixed", args: { freq: "pitch" } },
    voice: { engine: "module", module },
    pulse: { pattern: pattern.value },
    form: { kind: "totem" },
  };
}

function inputValue(): ModuleSpec["input"] {
  const v = inputSel.value;
  return v === "mic" ? "mic" : v === "" ? undefined : Number(v);
}

/** Render a module offline in a Worker (about 10 s of audio) and time it. */
function measure(spec: ModuleSpec): Promise<ModuleCost> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const on = (ev: MessageEvent<MeasureResult>) => {
      if (ev.data.id !== id) return;
      measurer.removeEventListener("message", on);
      if (ev.data.ok) resolve(ev.data.cost);
      else reject(new Error(ev.data.error));
    };
    measurer.addEventListener("message", on);
    measurer.postMessage({ id, spec, sampleRate: audio.ctx?.sampleRate ?? 48_000 });
  });
}

/** A one-line verdict on a module's measured cost. */
function costNote(cost: ModuleCost | undefined): string {
  if (!cost) return "";
  const pct = `${(cost.load * 100).toFixed(1)}% of the audio budget (${cost.usPerBlock.toFixed(0)} µs per block here)`;
  const loud = cost.peak > 1.5 ? " It's very loud: the toy's soft clip will flatten it." : "";
  return cost.load > MODULE_LOAD_WARN
    ? ` Heavy: ${pct}. It may glitch on phones and the Quest.${loud}`
    : ` Cost: ${pct}.${loud}`;
}

/** Hot-load a config into the Forge's own engine slot. Modules are measured first. */
async function load(cfg: ToyConfig): Promise<ModuleCost | undefined> {
  const problem = validate(cfg);
  if (problem) throw new Error(problem);
  audio.start();
  if (inputValue() === "mic") await audio.enableMic();
  const commands = compileVoice(cfg, SLOT);
  let cost: ModuleCost | undefined;
  for (const c of commands) {
    if (c.t !== "external" || cfg.voice.engine !== "module") continue;
    cost = cfg.voice.module.cost ?? (await measure(c.module));
    cfg.voice.module.cost = cost;
    c.module.cost = cost;
    if (cost.load > MODULE_LOAD_LIMIT) {
      throw new Error(`Too heavy to play: it needs ${(cost.load * 100).toFixed(0)}% of the audio budget (limit ${MODULE_LOAD_LIMIT * 100}%).`);
    }
  }
  current = cfg;
  audio.send({ t: "add", slot: SLOT, kind: Kind.Custom });
  for (const c of commands) audio.send(c);
  Object.values(cfg.params).forEach((p, i) => audio.send({ t: "param", slot: SLOT, p: Param.A + i, v: p.default }));
  audio.send({ t: "pattern", slot: SLOT, text: pattern.value });
  audio.send({ t: "param", slot: SLOT, p: Param.PulseOn, v: playing ? 1 : 0 });
  renderParams(cfg);
  return cost;
}

function renderParams(cfg: ToyConfig) {
  paramsEl.replaceChildren();
  Object.entries(cfg.params).forEach(([name, p], i) => {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = `${name}${p.gesture ? ` · ${p.gesture}` : ""}`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(p.range[0]);
    input.max = String(p.range[1]);
    input.step = String(p.step ?? (p.range[1] - p.range[0]) / 200);
    input.value = String(p.default);
    input.addEventListener("input", () => {
      p.default = Number(input.value);
      audio.send({ t: "param", slot: SLOT, p: Param.A + i, v: p.default });
    });
    label.append(span, input);
    paramsEl.append(label);
  });
}

el("#compile").addEventListener("click", async () => {
  audio.start();
  say("Compiling… (the first compile loads the Faust compiler, a few seconds)");
  const res = await compileFaust(nameField.value, source.value);
  if (!res.ok) return say(res.error, true);
  try {
    say(`Compiled in ${res.ms} ms. Measuring…`);
    const cost = await load(faustConfig(nameField.value || "Forged toy", res.wasm, res.json));
    say(`Compiled in ${res.ms} ms and loaded. Strike it, or press play.${costNote(cost)}`);
  } catch (e) {
    say(String(e), true);
  }
});

el("#ring").addEventListener("click", async () => {
  try {
    const cost = await load(await ringConfig());
    say(`Loaded the Ring Listener (a native module from crates/vma-ring). Choose an input to hear it listen.${costNote(cost)}`);
  } catch (e) {
    say(String(e), true);
  }
});

el("#strike").addEventListener("click", () => {
  audio.start();
  audio.send({ t: "poke", slot: SLOT, strength: 0.9, aux: 0 });
});

el("#play").addEventListener("click", (e) => {
  playing = !playing;
  (e.currentTarget as HTMLElement).textContent = playing ? "Pause" : "Play";
  audio.send({ t: "param", slot: SLOT, p: Param.PulseOn, v: playing ? 1 : 0 });
});

pattern.addEventListener("change", () => {
  audio.send({ t: "pattern", slot: SLOT, text: pattern.value });
  if (current) current.pulse = { pattern: pattern.value };
});

inputSel.addEventListener("change", async () => {
  if (current?.voice.engine === "module") {
    current.voice.module.input = inputValue();
    await load(current).catch((e) => say(String(e), true));
  }
});

el("#send").addEventListener("click", () => {
  if (!current) return say("Compile or load something first.", true);
  const channel = new BroadcastChannel(FORGE_CHANNEL);
  channel.postMessage({ t: "toy", config: current });
  channel.close();
  say(`Sent "${current.name}" to the playground's chest (open the playground in another tab).`);
});

audio.onLoadError = (_slot, what, code, detail) => say(`${what}: ${describeLoadError(code)}${detail ? ` (${detail})` : ""}`, true);

// A level meter from the engine snapshot, so you can see the toy is alive.
const ctx2d = meter.getContext("2d")!;
const tick = () => {
  const d = audio.snapshot;
  const env = d ? d[SNAP_HEADER + SLOT * SNAP_STRIDE + Snap.env] : 0;
  const w = meter.width;
  ctx2d.clearRect(0, 0, w, meter.height);
  ctx2d.fillStyle = current?.color ?? "#c792ff";
  ctx2d.fillRect(0, 0, Math.min(1, env * 2) * w, meter.height);
  requestAnimationFrame(tick);
};
tick();

if (import.meta.env.DEV) Object.assign(window, { forge: { audio, current: () => current } });
