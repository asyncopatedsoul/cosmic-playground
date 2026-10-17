import { toyEntry } from "../toys/registry";
import type { World } from "../world";
import { listenButtons, toyName, volumeDial } from "./sound";

/**
 * The Listen sheet (AUDIO-MIX.md §4.4): every toy in play with its volume,
 * mute, solo and focus. The one mixer-like view, closed by default; it's also
 * the keyboard and screen-reader route to every listening control.
 */
export class ListenSheet {
  private el: HTMLElement;
  private list: HTMLElement;
  private parts: { render(): void }[] = [];

  constructor(
    private world: World,
    anchor: HTMLElement,
  ) {
    this.el = document.createElement("section");
    this.el.className = "listen";
    this.el.hidden = true;
    this.el.setAttribute("aria-label", "Listen");
    this.el.innerHTML = `
      <ul class="listen-list"></ul>
      <div class="listen-foot">
        <button class="listen-clear" title="Clear every mute, solo and focus (Shift+M)">Clear all</button>
        <label title="For classrooms: silence this tab while it's in the background">
          <input type="checkbox" class="listen-hidden"> Mute when hidden
        </label>
      </div>`;
    anchor.after(this.el);
    this.list = this.el.querySelector(".listen-list")!;
    this.el.querySelector(".listen-clear")!.addEventListener("click", () => world.mix.clearToys());
    const hidden = this.el.querySelector<HTMLInputElement>(".listen-hidden")!;
    hidden.addEventListener("change", () => world.mix.setMuteWhenHidden(hidden.checked));
    // Keys pressed here (arrows on a dial, Space on a button) stay here.
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.code === "KeyL" && !e.ctrlKey && !e.metaKey)) this.toggle(false);
      e.stopPropagation();
    });

    world.mix.listeners.push(() => this.refresh());
    const prev = world.onChange;
    world.onChange = () => {
      prev?.();
      if (!this.el.hidden) this.build();
    };
  }

  get open() {
    return !this.el.hidden;
  }

  toggle(open = this.el.hidden) {
    this.el.hidden = !open;
    if (open) {
      this.build();
      this.el.querySelector<HTMLElement>(".volume-dial, button")?.focus();
    }
  }

  private build() {
    this.list.replaceChildren();
    this.parts = [];
    for (const toy of this.world.toys) {
      if (!toy) continue;
      const li = document.createElement("li");
      li.style.setProperty("--toy", toy.css);
      const icon = document.createElement("span");
      icon.className = "listen-icon";
      icon.innerHTML = toyEntry(toy.entryId)?.icon ?? "";
      const name = document.createElement("span");
      name.className = "listen-name";
      name.textContent = toyName(toy);
      const dial = volumeDial(() => toy.volume, (v) => toy.setVolume(v), `${toyName(toy)} volume`);
      const buttons = listenButtons(this.world, toy);
      li.append(icon, name, dial.el, buttons.el);
      this.list.append(li);
      this.parts.push(dial, buttons);
    }
    if (!this.parts.length) this.list.innerHTML = `<li class="listen-empty">No toys yet</li>`;
    this.refresh();
  }

  private refresh() {
    if (this.el.hidden) return;
    for (const p of this.parts) p.render();
    this.el.querySelector<HTMLInputElement>(".listen-hidden")!.checked = this.world.mix.muteWhenHidden;
  }
}
