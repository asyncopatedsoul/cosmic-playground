import { ZZFX_DEFAULTS, ZZFX_SLOTS } from "../audio/config";
import type { ConfigToy } from "../toys/config-toy";

/**
 * The Recipe Box: for toys whose voice is a ZzFX-style recipe. Roll a new
 * sound, mutate the current one, or copy/paste it as a short string (the same
 * array the ZzFX designer uses, so recipes travel both ways).
 */
export class RecipeBox {
  private toy: ConfigToy | null = null;
  private field: HTMLInputElement;

  constructor(private el: HTMLElement) {
    el.innerHTML = `
      <div class="pulse-row">
        <button data-act="roll" title="Roll a new sound">${die()}</button>
        <button data-act="mutate" title="Nudge this sound">${sparkle()}</button>
        <button data-act="copy" title="Copy the recipe">${copy()}</button>
      </div>
      <input class="recipe-field" type="text" spellcheck="false" aria-label="Sound recipe" title="Paste a ZzFX recipe and press Enter">`;
    this.field = el.querySelector("input")!;
    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act) this.act(act);
    });
    this.field.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.paste(this.field.value);
    });
    this.show(null);
  }

  show(toy: ConfigToy | null) {
    this.toy = toy;
    this.el.hidden = !toy;
    if (toy) this.field.value = format(toy.recipe());
  }

  private act(act: string) {
    const toy = this.toy;
    if (!toy) return;
    if (act === "roll") this.set(roll());
    if (act === "mutate") this.set(mutate(toy.recipe()));
    if (act === "copy") void navigator.clipboard?.writeText(format(toy.recipe()));
    toy.poke(0.8);
  }

  private paste(text: string) {
    const nums = text.replace(/zzfx\(|\)|\[|\]/g, "").split(",").map((x) => (x.trim() === "" ? NaN : Number(x)));
    if (!nums.length || nums.length > ZZFX_SLOTS.length || nums.some((x, i) => Number.isNaN(x) && text.split(",")[i]?.trim() !== "")) {
      this.field.classList.add("bad");
      return;
    }
    this.field.classList.remove("bad");
    this.set(nums.map((x, i) => (Number.isNaN(x) ? ZZFX_DEFAULTS[i] : x)));
    this.toy?.poke(0.8);
  }

  private set(recipe: number[]) {
    this.toy?.setRecipe(recipe);
    this.field.value = format(recipe);
  }
}

/** ZzFX's compact style: defaults left empty, 2-3 significant figures. */
function format(r: number[]): string {
  const parts = r.map((x, i) => (x === ZZFX_DEFAULTS[i] && i > 2 ? "" : String(+x.toPrecision(3))));
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return `[${parts.join(",")}]`;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** A random but usually pleasant recipe. */
function roll(): number[] {
  const r = ZZFX_DEFAULTS.slice();
  r[0] = rand(0.8, 1.4);
  r[2] = rand(150, 1500);
  r[3] = pick([0, 0, 0.01, 0.05]);
  r[4] = pick([0, 0.02, 0.1, 0.2]);
  r[5] = rand(0.05, 0.5);
  r[6] = pick([0, 0, 1, 1, 2, 3, 4]);
  r[7] = rand(0.5, 2.5);
  r[8] = pick([0, 0, rand(-10, 10)]);
  r[10] = pick([0, 0, rand(-600, 900)]);
  r[11] = r[10] ? rand(0.02, 0.15) : 0;
  r[12] = pick([0, 0, 0, rand(0.05, 0.2)]);
  r[13] = pick([0, 0, 0, rand(0, 1)]);
  r[14] = pick([0, 0, rand(0, 20)]);
  r[16] = pick([0, 0, rand(0.05, 0.25)]);
  r[17] = rand(0.5, 1);
  r[18] = pick([0, rand(0.02, 0.2)]);
  return r;
}

/** Jitter every non-default slot by up to ±15%. */
function mutate(r: number[]): number[] {
  return r.map((x, i) => (x === ZZFX_DEFAULTS[i] || i === 6 ? x : x * rand(0.85, 1.15)));
}

function die() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.4" fill="currentColor"/><circle cx="15" cy="15" r="1.4" fill="currentColor"/><circle cx="15" cy="9" r="1.4" fill="currentColor"/><circle cx="9" cy="15" r="1.4" fill="currentColor"/></svg>`;
}

function sparkle() {
  return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2 7 7 3-7 3-2 7-2-7-7-3 7-3z"/></svg>`;
}

function copy() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/></svg>`;
}
