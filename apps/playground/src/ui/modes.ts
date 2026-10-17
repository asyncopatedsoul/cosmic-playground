import type { Avatar } from "../avatar/avatar";
import { SIZE_RANGE, SIZES } from "../avatar/settings";
import type { AimPreview } from "../render/aim-preview";

const GLYPHS = {
  orbit: `<svg viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="8" ry="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="2.4" fill="currentColor"/></svg>`,
  walk: `<svg viewBox="0 0 20 20"><circle cx="11" cy="3.5" r="2" fill="currentColor"/><path d="M10 6.5l-2 5 3 2.5-1 4.5M10 6.5l3 4 2.5 1M8 11.5l-3 1.5M11 14l3 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  fly: `<svg viewBox="0 0 20 20"><path d="M2 11l16-6-5 12-3-5z M10 12l8-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
};

/**
 * The view switch on the HUD: Orbit, Walk, Fly (C, double-tap Space), plus a
 * gear with avatar settings: size (S/M/L set points), first/third person, the
 * fly frame and the aim ray preview.
 */
export class ModeSwitch {
  constructor(hud: HTMLElement, avatar: Avatar, preview: AimPreview) {
    const el = document.createElement("div");
    el.className = "hud-group hud-modes";
    el.innerHTML = `
      <button data-mode="orbit" title="Orbit view (C)" aria-label="Orbit view">${GLYPHS.orbit}</button>
      <button data-mode="walk" title="Walk as an avatar (C)" aria-label="Walk">${GLYPHS.walk}</button>
      <button data-mode="fly" title="Fly (double-tap Space)" aria-label="Fly">${GLYPHS.fly}</button>
      <button class="hud-gear" title="Avatar settings" aria-label="Avatar settings" aria-expanded="false">⚙</button>`;
    hud.prepend(el);

    const panel = document.createElement("div");
    panel.className = "avatar-settings";
    panel.hidden = true;
    panel.innerHTML = `
      <label>Size <input type="range" min="${SIZE_RANGE[0]}" max="${SIZE_RANGE[1]}" step="0.01" list="avatar-sizes" aria-label="Avatar size"><output></output></label>
      <datalist id="avatar-sizes">${Object.values(SIZES).map((v) => `<option value="${v}"></option>`).join("")}</datalist>
      <div class="sizes">${Object.entries(SIZES).map(([k, v]) => `<button data-size="${v}">${k}</button>`).join("")}</div>
      <label><input type="checkbox" data-opt="third"> Third person (V)</label>
      <label><input type="checkbox" data-opt="frozen"> Keep my up while flying</label>
      <label><input type="checkbox" data-opt="ray"> Show aim ray (B)</label>`;
    document.body.append(panel);

    const size = panel.querySelector<HTMLInputElement>("input[type=range]")!;
    const out = panel.querySelector("output")!;
    const opt = (k: string) => panel.querySelector<HTMLInputElement>(`[data-opt=${k}]`)!;
    const gear = el.querySelector<HTMLButtonElement>(".hud-gear")!;

    const render = () => {
      const mode = avatar.active ? avatar.mode : "orbit";
      for (const b of el.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.classList.toggle("active", b.dataset.mode === mode);
      const s = avatar.settings;
      size.value = String(s.size);
      out.textContent = `${Math.round(s.size * 120)} cm`;
      for (const b of panel.querySelectorAll<HTMLButtonElement>("[data-size]")) b.classList.toggle("active", Number(b.dataset.size) === s.size);
      opt("third").checked = s.thirdPerson;
      opt("frozen").checked = s.frozenFlyFrame;
      opt("ray").checked = preview.enabled;
    };
    avatar.onChange = render;

    el.addEventListener("click", (e) => {
      const mode = (e.target as HTMLElement).closest<HTMLElement>("[data-mode]")?.dataset.mode;
      if (!mode) return;
      if (mode === "orbit") avatar.exit();
      else {
        avatar.enter();
        avatar.setMode(mode as "walk" | "fly");
      }
      render();
    });
    gear.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      gear.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) avatar.unlock();
      render();
    });
    size.addEventListener("input", () => {
      avatar.settings.set({ size: Number(size.value) });
      render();
    });
    panel.addEventListener("click", (e) => {
      const v = (e.target as HTMLElement).closest<HTMLElement>("[data-size]")?.dataset.size;
      if (v) avatar.settings.set({ size: Number(v) });
      render();
    });
    opt("third").addEventListener("change", () => avatar.setThirdPerson(opt("third").checked));
    opt("frozen").addEventListener("change", () => avatar.settings.set({ frozenFlyFrame: opt("frozen").checked }));
    opt("ray").addEventListener("change", () => preview.toggle(opt("ray").checked));
    this.render = render;
    render();
  }

  render: () => void;
}
