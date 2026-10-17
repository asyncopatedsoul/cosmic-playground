import type { World } from "../world";

/** Tonal (MIT) loads on first use, so the playground's first paint doesn't pay for it. */
const tonal = () => import("tonal");

/** Scales offered by name (all from Tonal); the full list is searchable. */
const FAVOURITES = [
  "major pentatonic", "minor pentatonic", "hirajoshi", "in-sen", "pelog", "egyptian",
  "whole tone", "major blues", "lydian", "phrygian dominant", "harmonic minor", "chromatic",
];

/**
 * More tunings: any scale Tonal knows by name, n equal divisions of the
 * octave, or a Scala .scl file from the Huygens-Fokker archive. Tonal only
 * names and spells scales here; the engine's Tuning does the snapping.
 */
export class Tunings {
  private el: HTMLElement;

  constructor(
    private world: World,
    anchor: HTMLElement,
    private onChange: () => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "tunings";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="tunings-list">${FAVOURITES.map((n) => `<button data-scale="${n}">${n}</button>`).join("")}</div>
      <label>Any scale <input list="tonal-scales" class="tunings-search" placeholder="e.g. kumoijoshi"></label>
      <datalist id="tonal-scales"></datalist>
      <label>Equal steps per octave <input type="number" class="tunings-edo" min="5" max="53" value="31"></label>
      <label class="tunings-file">Scala file (.scl) <input type="file" accept=".scl,text/plain"></label>
      <small class="tunings-msg" role="status"></small>`;
    anchor.after(this.el);
    const msg = this.el.querySelector<HTMLElement>(".tunings-msg")!;
    this.el.addEventListener("click", (e) => {
      const name = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-scale]")?.dataset.scale;
      if (name) void this.scale(name, msg);
    });
    const search = this.el.querySelector<HTMLInputElement>(".tunings-search")!;
    search.addEventListener("change", () => void this.scale(search.value, msg));
    const edo = this.el.querySelector<HTMLInputElement>(".tunings-edo")!;
    edo.addEventListener("change", () => {
      const n = Math.round(Number(edo.value));
      if (!(n >= 5 && n <= 53)) return;
      this.world.setTuningTable(`${n}-EDO`, Array.from({ length: n }, (_, i) => (i * 1200) / n));
      this.done(msg, `${n} equal steps`);
    });
    this.el.querySelector<HTMLInputElement>(".tunings-file input")!.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      this.world.setTuningScala(file.name.replace(/\.scl$/i, ""), text);
      this.done(msg, file.name);
    });
    // Typing here must not trigger world shortcuts.
    this.el.addEventListener("keydown", (e) => e.stopPropagation());
  }

  toggle(open = this.el.hidden) {
    this.el.hidden = !open;
    const list = this.el.querySelector("datalist")!;
    if (open && !list.childElementCount) {
      void tonal().then(({ Scale }) => {
        list.innerHTML = Scale.names().sort().map((n) => `<option value="${n}">`).join("");
      });
    }
  }

  private async scale(name: string, msg: HTMLElement) {
    const { Interval, Scale } = await tonal();
    const s = Scale.get(`C ${name}`);
    if (s.empty) {
      msg.textContent = `Tonal doesn't know "${name}"`;
      return;
    }
    const cents = s.intervals.map((i) => (Interval.semitones(i) ?? 0) * 100);
    this.world.setTuningTable(name, cents);
    this.done(msg, name);
  }

  private done(msg: HTMLElement, what: string) {
    msg.textContent = `Tuned to ${what}`;
    this.onChange();
  }
}
