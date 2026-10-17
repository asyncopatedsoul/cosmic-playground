import type { AudioHost } from "../audio/host";
import { SCALE_CUSTOM } from "../audio/protocol";
import type { World } from "../world";
import { announce } from "./announce";
import { GLYPHS } from "./sound";
import { Tunings } from "./tunings";

const SCALES = [
  { id: 0, glyph: "☀", name: "Bright" },
  { id: 1, glyph: "☾", name: "Moody" },
  { id: 2, glyph: "✦", name: "Pure" },
  { id: 3, glyph: "♪", name: "Major" },
  { id: 4, glyph: "◐", name: "Dorian" },
];

const LONG_PRESS_MS = 420;

/** Mute or unmute everything for this player, and say so. */
export function toggleGlobalMute(world: World) {
  world.mix.setMuted(!world.mix.muted);
  announce(world.mix.muted ? "Sound off" : "Sound on");
}

/** World controls: tempo, Tuning, the wild switch and volume. */
export class Hud {
  /** Opens the Listen sheet (long-press on the speaker); set by main.ts. */
  onListen: (() => void) | null = null;

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
      <div class="hud-volume">
        <button class="hud-mute" title="Mute everything (M). Long-press: Listen (L)" aria-pressed="false"></button>
        <input type="range" min="0" max="1" step="0.01" aria-label="Volume" title="Volume">
      </div>
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
    // The speaker: tap mutes everything (the engine keeps running, so the beat
    // stays locked); long-press opens the Listen sheet.
    const mute = el.querySelector<HTMLButtonElement>(".hud-mute")!;
    const renderMix = () => {
      const { muted, master } = world.mix;
      mute.innerHTML = muted ? GLYPHS.muted : GLYPHS.speaker;
      mute.setAttribute("aria-pressed", String(muted));
      mute.setAttribute("aria-label", muted ? "Unmute" : "Mute");
      mute.classList.toggle("active", muted);
      volume.classList.toggle("muted", muted);
      if (document.activeElement !== volume) volume.value = String(master);
    };
    world.mix.listeners.push(renderMix);
    let timer = 0;
    let long = false;
    mute.addEventListener("pointerdown", () => {
      long = false;
      timer = window.setTimeout(() => {
        long = true;
        this.onListen?.();
      }, LONG_PRESS_MS);
    });
    const release = () => clearTimeout(timer);
    mute.addEventListener("pointerup", release);
    mute.addEventListener("pointerleave", release);
    mute.addEventListener("click", () => {
      if (long) return;
      audio.start();
      toggleGlobalMute(world);
    });
    volume.addEventListener("input", () => {
      audio.start();
      world.setMaster(Number(volume.value));
    });
    renderMix();

    const help = document.getElementById("help")!;
    el.querySelector(".hud-help")!.addEventListener("click", () => help.classList.toggle("open"));
    help.addEventListener("click", () => help.classList.remove("open"));
    world.onWorld = render;
    render();
  }
}
