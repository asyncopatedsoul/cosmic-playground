import type { AudioHost } from "../audio/host";
import { SCALE_CUSTOM } from "../audio/protocol";
import type { World } from "../world";
import { Tunings } from "./tunings";

const SCALES = [
  { id: 0, glyph: "☀", name: "Bright" },
  { id: 1, glyph: "☾", name: "Moody" },
  { id: 2, glyph: "✦", name: "Pure" },
  { id: 3, glyph: "♪", name: "Major" },
  { id: 4, glyph: "◐", name: "Dorian" },
];

/** World controls: tempo, Tuning, the wild switch and volume. */
export class Hud {
  constructor(world: World, audio: AudioHost) {
    const el = document.getElementById("hud")!;
    el.innerHTML = `
      <div class="hud-group" title="Tempo">
        <button data-act="slower" aria-label="Slower">−</button>
        <span class="tempo"><svg viewBox="0 0 20 20"><path d="M7 2h6l4 16H3zM10 14l5-9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><b></b></span>
        <button data-act="faster" aria-label="Faster">+</button>
      </div>
      <button class="hud-scale" title="Tuning: what every toy snaps to"></button>
      <button class="hud-tunings" title="More tunings: named scales, equal steps, Scala files" aria-label="More tunings">≋</button>
      <button class="hud-wild" title="Wild: turn snapping off (microtonal)">✺</button>
      <label class="hud-volume" title="Volume">
        <svg viewBox="0 0 20 20"><path d="M3 8h3l4-4v12l-4-4H3zM13 7c1.5 1.5 1.5 4.5 0 6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
        <input type="range" min="0" max="1" step="0.01" aria-label="Volume">
      </label>
      <button class="hud-help" aria-label="Help">?</button>`;

    const tempo = el.querySelector(".tempo b")!;
    const scale = el.querySelector<HTMLButtonElement>(".hud-scale")!;
    const wild = el.querySelector<HTMLButtonElement>(".hud-wild")!;
    const volume = el.querySelector<HTMLInputElement>(".hud-volume input")!;
    const render = () => {
      tempo.textContent = String(world.bpm);
      const s = SCALES.find((x) => x.id === world.tuning.scale);
      scale.innerHTML = s ? `<span>${s.glyph}</span> ${s.name}` : `<span>≋</span> ${world.tuning.custom ?? "Custom"}`;
      wild.classList.toggle("active", world.tuning.wild);
    };

    el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "slower") world.setTempo(world.bpm - 4);
      if (act === "faster") world.setTempo(world.bpm + 4);
      render();
    });
    scale.addEventListener("click", () => {
      // From a custom tuning, the presets start over at the first one.
      const i = world.tuning.scale === SCALE_CUSTOM ? -1 : SCALES.findIndex((x) => x.id === world.tuning.scale);
      world.setTuning({ scale: SCALES[(i + 1) % SCALES.length].id });
      render();
    });
    const tunings = new Tunings(world, el, render);
    el.querySelector(".hud-tunings")!.addEventListener("click", () => tunings.toggle());
    wild.addEventListener("click", () => {
      world.setTuning({ wild: !world.tuning.wild });
      render();
    });
    volume.value = String(world.master);
    volume.addEventListener("input", () => {
      audio.start();
      world.setMaster(Number(volume.value));
    });

    const help = document.getElementById("help")!;
    el.querySelector(".hud-help")!.addEventListener("click", () => help.classList.toggle("open"));
    help.addEventListener("click", () => help.classList.remove("open"));
    render();
  }
}
