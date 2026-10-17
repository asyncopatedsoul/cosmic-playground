import type { Toy } from "../toys/toy";
import { DEFAULT_VOLUME } from "../toys/toy";
import { toyEntry } from "../toys/registry";
import type { World } from "../world";
import { announce } from "./announce";

const DIAL_R = 15;
const DIAL_LEN = 2 * Math.PI * DIAL_R;
/** The dial sticks at the default level when dragged within this of it. */
const DETENT = 0.03;

export const GLYPHS = {
  speaker: `<svg viewBox="0 0 20 20"><path d="M3 8h3l4-4v12l-4-4H3zM13 7c1.5 1.5 1.5 4.5 0 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  muted: `<svg viewBox="0 0 20 20"><path d="M3 8h3l4-4v12l-4-4H3zM13 7l5 6M18 7l-5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  solo: `<svg viewBox="0 0 20 20"><path d="M4 12V10a6 6 0 0 1 12 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="11" width="3.5" height="5.5" rx="1.4" fill="currentColor"/><rect x="13.5" y="11" width="3.5" height="5.5" rx="1.4" fill="currentColor"/></svg>`,
  focus: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".5"/><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/></svg>`,
};

/** A toy's display name, for labels and announcements. */
export function toyName(toy: Toy): string {
  return toyEntry(toy.entryId)?.name ?? "Toy";
}

/**
 * The volume dial: a ring that fills, with a soft detent at the default.
 * Drag up/right to raise, wheel, or arrow keys; it's a slider to screen readers.
 */
export function volumeDial(get: () => number, set: (v: number) => void, label: string) {
  const el = document.createElement("div");
  el.className = "volume-dial";
  el.tabIndex = 0;
  el.setAttribute("role", "slider");
  el.setAttribute("aria-label", label);
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", "100");
  const a = (DEFAULT_VOLUME * 2 - 0.5) * Math.PI;
  el.innerHTML = `<svg viewBox="-20 -20 40 40">
      <circle class="dial-track" r="${DIAL_R}"/>
      <circle class="dial-fill" r="${DIAL_R}" transform="rotate(-90)"/>
      <line class="dial-detent" x1="${(DIAL_R - 4) * Math.cos(a)}" y1="${(DIAL_R - 4) * Math.sin(a)}" x2="${(DIAL_R + 4) * Math.cos(a)}" y2="${(DIAL_R + 4) * Math.sin(a)}"/>
    </svg>`;
  const fill = el.querySelector<SVGCircleElement>(".dial-fill")!;

  const render = () => {
    const v = get();
    fill.setAttribute("stroke-dasharray", `${v * DIAL_LEN} ${DIAL_LEN}`);
    el.setAttribute("aria-valuenow", String(Math.round(v * 100)));
  };
  const change = (v: number) => {
    v = Math.min(1, Math.max(0, v));
    set(v);
    render();
  };

  let drag: { y: number; x: number; v: number } | null = null;
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, v: get() };
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    let v = drag.v + ((e.clientX - drag.x) - (e.clientY - drag.y)) * 0.005;
    if (Math.abs(v - DEFAULT_VOLUME) < DETENT) v = DEFAULT_VOLUME;
    change(v);
  });
  const end = () => (drag = null);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    change(get() - Math.sign(e.deltaY) * 0.05);
  }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
    if (step !== undefined) change(get() + step);
    else if (e.key === "Home") change(0);
    else if (e.key === "End") change(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  render();
  return { el, render };
}

/** Mute / solo / focus toggles for one toy, with `aria-pressed`. */
export function listenButtons(world: World, toy: Toy) {
  const el = document.createElement("div");
  el.className = "listen-buttons";
  const mix = world.mix;
  const defs = [
    { act: "mute", title: "Mute (N): stop hearing it; it keeps playing" },
    { act: "solo", title: "Solo (Shift+N): hear only this" },
    { act: "focus", title: "Focus (H): this one up front, the rest quieter" },
  ] as const;
  const buttons = defs.map((d) => {
    const b = document.createElement("button");
    b.dataset.act = d.act;
    b.title = d.title;
    b.setAttribute("aria-label", `${d.act[0].toUpperCase()}${d.act.slice(1)} ${toyName(toy)}`);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (d.act === "mute") toggleMute(world, toy);
      if (d.act === "solo") toggleSolo(world, toy);
      if (d.act === "focus") toggleFocus(world, toy);
    });
    el.append(b);
    return b;
  });
  const render = () => {
    const on = [mix.toyMute.has(toy.id), mix.solo.has(toy.id), mix.focus === toy.id];
    buttons.forEach((b, i) => {
      b.setAttribute("aria-pressed", String(on[i]));
      b.classList.toggle("active", on[i]);
      b.innerHTML = i === 0 ? (on[0] ? GLYPHS.muted : GLYPHS.speaker) : i === 1 ? GLYPHS.solo : GLYPHS.focus;
    });
  };
  render();
  return { el, render };
}

export function toggleMute(world: World, toy: Toy) {
  world.mix.toggleMute(toy);
  announce(`${toyName(toy)} ${world.mix.toyMute.has(toy.id) ? "muted" : "unmuted"}`);
}

export function toggleSolo(world: World, toy: Toy) {
  world.mix.toggleSolo(toy);
  announce(`${toyName(toy)} ${world.mix.solo.has(toy.id) ? "soloed" : "unsoloed"}`);
}

export function toggleFocus(world: World, toy: Toy, on?: boolean) {
  world.mix.toggleFocus(toy, on);
  announce(world.mix.focus === toy.id ? `Focus on ${toyName(toy)}` : "Focus off");
}

/** The toy panel's Sound row: volume dial, mute, solo, focus. */
export class SoundRow {
  readonly el = document.createElement("div");
  private toy: Toy | null = null;
  private parts: { render(): void }[] = [];

  constructor(private world: World) {
    this.el.className = "pulse-row sound-row";
    world.mix.listeners.push(() => this.render());
  }

  show(toy: Toy | null) {
    this.toy = toy;
    this.el.replaceChildren();
    this.parts = [];
    if (!toy) return;
    const dial = volumeDial(() => toy.volume, (v) => toy.setVolume(v), `${toyName(toy)} volume`);
    const buttons = listenButtons(this.world, toy);
    this.el.append(dial.el, buttons.el);
    this.parts = [dial, buttons];
  }

  render() {
    if (this.toy) for (const p of this.parts) p.render();
  }
}
