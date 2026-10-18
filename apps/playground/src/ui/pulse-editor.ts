import * as THREE from "three";
import { Kind, MAX_STEPS, Snap } from "../audio/protocol";
import { ConfigToy } from "../toys/config-toy";
import { euclid, SnapView, type Toy } from "../toys/toy";
import { RecipeBox } from "./recipe-box";
import { SoundRow } from "./sound";
import type { World } from "../world";

const RING_R = 92;
const LONG_PRESS_MS = 420;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Rates as shapes: one, two, three or four dots per beat. */
const RATES = [
  { spb: 1, title: "Quarter notes" },
  { spb: 2, title: "Eighth notes" },
  { spb: 3, title: "Triplets" },
  { spb: 4, title: "Sixteenth notes" },
];
const SPEEDS = [
  { speed: 0.5, title: "Half speed" },
  { speed: 1, title: "Normal speed" },
  { speed: 2, title: "Double speed" },
];

/**
 * Pulse editing without numbers: a ring of dots you tap on and off (long-press
 * for "sometimes"), a rate picked by shape, and a big play/pause heart.
 */
export class PulseEditor {
  toy: Toy | null = null;
  /** "Keep this one": save the toy as a variant (set by main.ts; SAVE-LOAD.md §6.2). */
  onKeep: ((toy: Toy) => void) | null = null;
  private el: HTMLElement;
  private svg: SVGSVGElement;
  private dots: SVGCircleElement[] = [];
  private lastStep = -1;
  private script: HTMLInputElement;
  private scriptError: HTMLElement;
  private recipes: RecipeBox;
  private sound: SoundRow;

  constructor(private world: World) {
    this.el = document.getElementById("pulse")!;
    this.el.innerHTML = `
      <button class="pulse-close" aria-label="Close">×</button>
      <button class="pulse-keep" aria-label="Keep this one" title="Keep this one: save it as a variant in the chest (Ctrl+Shift+K)">${starIcon()}</button>
      <svg class="pulse-ring" viewBox="-120 -120 240 240" aria-label="Pulse pattern"></svg>
      <div class="pulse-row pulse-rates"></div>
      <div class="pulse-row pulse-shape">
        <button data-act="fewer" title="Fewer steps">${dotsIcon(3)}</button>
        <button data-act="spread" title="Spread the hits evenly">${spiralIcon()}</button>
        <button data-act="more" title="More steps">${dotsIcon(5)}</button>
        <button data-act="script" title="Script the Pulse (mini-notation)">${scriptIcon()}</button>
      </div>
      <form class="pulse-script" hidden>
        <input type="text" spellcheck="false" autocomplete="off" aria-label="Pulse pattern"
          placeholder="x . x [x x]  <0 2> x(3,8)  x?">
        <small class="pulse-script-error" role="status"></small>
      </form>
      <div class="pulse-recipes"></div>`;
    this.sound = new SoundRow(world);
    this.el.querySelector(".pulse-rates")!.before(this.sound.el);
    this.svg = this.el.querySelector("svg")!;
    const form = this.el.querySelector<HTMLFormElement>(".pulse-script")!;
    this.script = form.querySelector("input")!;
    this.scriptError = form.querySelector(".pulse-script-error")!;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.applyScript();
    });
    this.script.addEventListener("change", () => this.applyScript());
    // Keys typed into the pattern must not reach the world's shortcuts.
    this.script.addEventListener("keydown", (e) => e.stopPropagation());
    this.recipes = new RecipeBox(this.el.querySelector(".pulse-recipes")!);
    this.el.querySelector(".pulse-close")!.addEventListener("click", () => this.close());
    const keep = this.el.querySelector<HTMLElement>(".pulse-keep")!;
    keep.addEventListener("click", () => {
      if (!this.toy) return;
      this.onKeep?.(this.toy);
      keep.classList.remove("kept");
      void keep.offsetWidth;
      keep.classList.add("kept");
    });
    this.el.querySelector(".pulse-shape")!.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "script") {
        const form = this.script.form!;
        form.hidden = !form.hidden;
        if (!form.hidden) this.script.focus();
      } else if (act) this.shape(act);
    });
  }

  toggle(toy: Toy) {
    if (this.toy === toy) this.close();
    else this.open(toy);
  }

  open(toy: Toy) {
    if (this.toy) this.toy.selected = false;
    this.toy = toy;
    toy.selected = true;
    this.el.style.setProperty("--toy", toy.css);
    this.el.classList.toggle("continuous", toy.kind === Kind.Orrery);
    // Open on the side away from the toy so it stays visible while you edit.
    const camera = this.world.stage.camera;
    const x = toy.group.getWorldPosition(new THREE.Vector3()).project(camera).x;
    this.el.classList.toggle("right", x < 0);
    this.el.classList.add("open");
    this.script.value = toy.pattern;
    this.script.form!.hidden = !toy.pattern;
    this.recipes.show(toy instanceof ConfigToy && toy.config.voice.engine === "zap" ? toy : null);
    this.sound.show(toy);
    this.render();
  }

  private applyScript() {
    const toy = this.toy;
    if (!toy) return;
    toy.setPattern(this.script.value);
    if (toy.pattern && !toy.pulse.enabled) toy.setPulse({ enabled: true });
    this.render();
  }

  close() {
    if (this.toy) this.toy.selected = false;
    this.toy = null;
    this.sound.show(null);
    this.el.classList.remove("open");
  }

  private render() {
    const toy = this.toy;
    if (!toy) return;
    const p = toy.pulse;
    this.svg.replaceChildren();
    this.dots = [];
    this.lastStep = -1;
    this.el.classList.toggle("scripted", !!toy.pattern);

    if (toy.kind !== Kind.Orrery) {
      for (let i = 0; i < p.steps; i++) {
        const a = (i / p.steps) * Math.PI * 2 - Math.PI / 2;
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", String(RING_R * Math.cos(a)));
        dot.setAttribute("cy", String(RING_R * Math.sin(a)));
        dot.setAttribute("r", p.steps > 12 ? "10" : "13");
        dot.classList.add("step");
        dot.style.setProperty("--p", String(p.prob[i]));
        this.bindDot(dot, i);
        this.svg.append(dot);
        this.dots.push(dot);
      }
    }

    // The heart in the middle plays and pauses the Pulse.
    const heart = document.createElementNS(SVG_NS, "g");
    heart.classList.add("pulse-heart");
    heart.innerHTML = `<circle r="44"/><path d="${p.enabled ? "M-12 -16h8v32h-8zM4 -16h8v32h-8z" : "M-10 -18L18 0L-10 18z"}"/>`;
    heart.addEventListener("click", () => {
      toy.setPulse({ enabled: !toy.pulse.enabled });
      this.render();
    });
    this.svg.append(heart);

    const rates = this.el.querySelector(".pulse-rates")!;
    rates.replaceChildren();
    const options = toy.kind === Kind.Orrery ? SPEEDS : RATES;
    options.forEach((o, i) => {
      const b = document.createElement("button");
      b.title = o.title;
      const active = "speed" in o ? o.speed === p.speed : o.spb === p.stepsPerBeat;
      b.classList.toggle("active", active);
      b.innerHTML = "speed" in o ? speedIcon(i) : rateIcon(o.spb);
      b.addEventListener("click", () => {
        toy.setPulse("speed" in o ? { speed: o.speed } : { stepsPerBeat: o.spb });
        this.render();
      });
      rates.append(b);
    });
  }

  private bindDot(dot: SVGCircleElement, i: number) {
    let timer = 0;
    let long = false;
    dot.addEventListener("pointerdown", () => {
      long = false;
      timer = window.setTimeout(() => {
        // Long press: "sometimes". Cycles 1 -> 1/2 -> 1/4 -> 1.
        long = true;
        const p = this.toy!.pulse.prob[i];
        this.setProb(i, p >= 1 ? 0.5 : p >= 0.5 ? 0.25 : 1);
      }, LONG_PRESS_MS);
    });
    const release = () => clearTimeout(timer);
    dot.addEventListener("pointerleave", release);
    dot.addEventListener("pointerup", () => {
      release();
      if (!long) this.setProb(i, this.toy!.pulse.prob[i] > 0 ? 0 : 1);
    });
  }

  private setProb(i: number, prob: number) {
    const toy = this.toy!;
    const next = toy.pulse.prob.slice();
    next[i] = prob;
    toy.setPulse({ prob: next });
    this.dots[i]?.style.setProperty("--p", String(prob));
  }

  private shape(act: string) {
    const toy = this.toy;
    if (!toy || toy.kind === Kind.Orrery) return;
    const p = toy.pulse;
    const hits = p.prob.slice(0, p.steps).filter((x) => x > 0).length;
    if (act === "spread") {
      toy.setPulse({ prob: euclid((hits % p.steps) + 1, p.steps) });
    } else {
      const steps = Math.min(MAX_STEPS, Math.max(2, p.steps + (act === "more" ? 1 : -1)));
      toy.setPulse({ steps, prob: euclid(Math.min(hits, steps), steps) });
    }
    this.render();
  }

  /** Light the dot under the playhead (and show pattern errors). */
  update() {
    const toy = this.toy;
    if (toy) {
      const err = toy.patternError ?? "";
      if (this.scriptError.textContent !== err) this.scriptError.textContent = err;
      this.script.classList.toggle("bad", !!err);
    }
    const data = this.world.audio.snapshot;
    if (!toy || !data || !this.dots.length || toy.pattern) return;
    const step = new SnapView(data, toy.slot, 0).get(Snap.step);
    if (step === this.lastStep) return;
    this.dots[this.lastStep]?.classList.remove("now");
    this.dots[step]?.classList.add("now");
    this.lastStep = step;
  }
}

function starIcon() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.8 6.3 20l1.4-6.3-4.8-4.3 6.4-.7z"/></svg>`;
}

function dotsIcon(n: number) {
  const dots = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return `<circle cx="${12 + 8 * Math.cos(a)}" cy="${12 + 8 * Math.sin(a)}" r="2.4"/>`;
  }).join("");
  return `<svg viewBox="0 0 24 24" fill="currentColor">${dots}</svg>`;
}

function scriptIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13 5l-2 14"/></svg>`;
}

function spiralIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8" stroke-dasharray="3 4"/><circle cx="12" cy="4" r="2" fill="currentColor"/><circle cx="18.9" cy="16" r="2" fill="currentColor"/><circle cx="5.1" cy="16" r="2" fill="currentColor"/></svg>`;
}

function rateIcon(spb: number) {
  const w = 24 / (spb + 1);
  const dots = Array.from({ length: spb }, (_, i) => `<circle cx="${w * (i + 1)}" cy="12" r="${spb > 3 ? 2.2 : 2.8}"/>`).join("");
  return `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="1" y="19" width="22" height="1.6" opacity=".5"/>${dots}</svg>`;
}

function speedIcon(i: number) {
  const arrows = ["M8 6l8 6-8 6", "M5 6l7 6-7 6M12 6l7 6-7 6", "M2 6l6 6-6 6M9 6l6 6-6 6M16 6l6 6-6 6"][i];
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="${arrows}"/></svg>`;
}
