import type { DevContext, DevTools } from "../../dev/boot";
import { setOverride, type Layer } from "../../dev/config";
import { load, save } from "../../prefs";
import { LogsTab } from "./logs";
import { SettingsTab } from "./settings";
import { StateTab } from "./state";
import "./dev.css";

const TABS = ["settings", "logs", "state"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY = "cosmic.devTab";

export interface PanelTab {
  readonly el: HTMLElement;
  /** The tab became visible or hidden. */
  shown(on: boolean): void;
}

/**
 * The developer panel (docs/DEV-MODE.md §3, §4.3): a docked drawer toggled
 * with ` (Backquote). Plain DOM with text labels: it's for developers.
 * Keys typed inside it never reach the playground's shortcuts.
 */
export class DevPanel {
  private readonly el = document.createElement("aside");
  private readonly tabs: Record<Tab, PanelTab>;
  private tab: Tab = load<Tab>(TAB_KEY, "settings");

  constructor(
    ctx: DevContext,
    private tools: DevTools,
    warnings: string[],
    layers: Layer[],
  ) {
    const { config } = tools;
    this.el.className = "devp";
    this.el.dataset.dock = config.panel.dock;
    this.el.setAttribute("aria-label", "Developer panel");
    this.el.innerHTML = `
      <header>
        <b>Dev</b><span class="devp-mode">${ctx.mode}</span>
        <nav role="tablist">${TABS.map((t) => `<button role="tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</nav>
        <span class="devp-fps" hidden></span>
        <button class="devp-close" aria-label="Close developer panel" title="Close (\`)">×</button>
      </header>`;
    this.tabs = {
      settings: new SettingsTab(ctx, tools, warnings, layers, (dock) => (this.el.dataset.dock = dock)),
      logs: new LogsTab(ctx, tools.log),
      state: new StateTab(ctx),
    };
    for (const t of TABS) {
      this.tabs[t].el.dataset.panel = t;
      this.el.append(this.tabs[t].el);
    }
    document.body.append(this.el);

    this.el.querySelector("nav")!.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
      if (t) this.show(t);
    });
    this.el.querySelector(".devp-close")!.addEventListener("click", () => this.toggle(false));
    // Typing in the panel never plucks a string or flies the avatar.
    this.el.addEventListener("keydown", (e) => {
      if (e.code === "Escape") this.toggle(false);
      e.stopPropagation();
    });
    addEventListener("keydown", (e) => {
      if (!isHotkey(e, config.panel.hotkey) || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return;
      e.preventDefault();
      this.toggle();
    });

    const fps = this.el.querySelector<HTMLElement>(".devp-fps")!;
    let frames = 0;
    let since = performance.now();
    tools.frameHooks.push(() => {
      if (!config.flags.fps) {
        fps.hidden = true;
        return;
      }
      frames++;
      const now = performance.now();
      if (now - since < 500) return;
      fps.hidden = false;
      fps.textContent = `${Math.round((frames * 1000) / (now - since))} fps`;
      frames = 0;
      since = now;
    });

    this.show(this.tab);
    this.toggle(config.panel.open, false);
  }

  toggle(open = this.el.hidden, remember = true) {
    this.el.hidden = !open;
    this.tabs[this.tab].shown(open);
    if (remember) {
      this.tools.config.panel.open = open;
      setOverride("panel.open", open);
    }
  }

  private show(tab: Tab) {
    this.tabs[this.tab].shown(false);
    this.tab = tab;
    save(TAB_KEY, tab);
    for (const t of TABS) {
      this.tabs[t].el.hidden = t !== tab;
      this.el.querySelector(`[data-tab="${t}"]`)!.setAttribute("aria-selected", String(t === tab));
    }
    this.tabs[tab].shown(!this.el.hidden);
  }
}

/** The hotkey is a key code ("Backquote", "F9") or a key ("`"); Backquote also matches the ` character on any layout. */
function isHotkey(e: KeyboardEvent, hotkey: string): boolean {
  return e.code === hotkey || e.key === hotkey || (hotkey === "Backquote" && e.key === "`");
}
