import type { DevContext, DevTools } from "../../dev/boot";
import { CHANNELS, clearOverrides, LEVELS, setOverride, type Layer, type Level } from "../../dev/config";
import { loudest } from "../../dev/state";
import type { PanelTab } from "./panel";

/** Settings: listening, log levels, panel and flags, and where the config came from. */
export class SettingsTab implements PanelTab {
  readonly el = document.createElement("section");
  private meterTimer = 0;
  private readonly renderMix: () => void;

  constructor(
    private ctx: DevContext,
    tools: DevTools,
    warnings: string[],
    layers: Layer[],
    onDock: (dock: "right" | "left") => void,
  ) {
    const { config, log } = tools;
    const { world } = ctx;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    this.el.innerHTML = `
      <h3>Audio</h3>
      <div class="devp-row">
        <button class="devp-mute" aria-pressed="false"></button>
        <input class="devp-master" type="range" min="0" max="1" step="0.01" aria-label="Master volume">
        <span class="devp-master-v"></span>
      </div>
      <div class="devp-row" title="The loudest toy envelope right now: a muted world still moves this, a silent one doesn't">
        <span class="devp-label">Level</span><meter class="devp-meter" min="0" max="1" low="0.6" high="0.9" value="0"></meter>
      </div>
      <p class="devp-note">Dev mode starts muted (audio.muted). Muting or unmuting anywhere is remembered here.</p>

      <h3>Logs</h3>
      <div class="devp-grid">${CHANNELS.map(
        (c) => `<label>${c}</label><select data-ch="${c}">${LEVELS.map((l) => `<option${l === config.log.channels[c] ? " selected" : ""}>${l}</option>`).join("")}</select>`,
      ).join("")}</div>
      <label class="devp-check"><input type="checkbox" data-set="console"${config.log.console ? " checked" : ""}> Mirror to the devtools console</label>
      <p class="devp-note">Keeps the last ${config.log.ring} events.
        ${import.meta.env.DEV && config.log.sink === "devlog" ? "Sessions are written to <code>devlog/sessions/</code>." : "Sessions aren't written to disk (dev server only, log.sink)."}</p>

      <h3>Panel</h3>
      <div class="devp-row">
        <span class="devp-label">Dock</span>
        <select data-set="dock"><option${config.panel.dock === "right" ? " selected" : ""}>right</option><option${config.panel.dock === "left" ? " selected" : ""}>left</option></select>
        <label class="devp-check"><input type="checkbox" data-set="fps"${config.flags.fps ? " checked" : ""}> Show fps</label>
      </div>

      <h3>Config</h3>
      <p class="devp-note">Defaults &lt; ${layers.map((l) => `<code>${esc(l.name)}</code>`).join(" &lt; ") || "nothing else"}</p>
      ${warnings.length ? `<ul class="devp-warn">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <div class="devp-row">
        <button data-act="copy">Copy as JSON</button>
        <button data-act="reset" title="Forget the changes made in this panel and reload">Reset to file</button>
      </div>`;

    const mute = this.el.querySelector<HTMLButtonElement>(".devp-mute")!;
    const master = this.el.querySelector<HTMLInputElement>(".devp-master")!;
    const masterV = this.el.querySelector<HTMLElement>(".devp-master-v")!;
    this.renderMix = () => {
      mute.textContent = world.mix.muted ? "Unmute" : "Mute";
      mute.setAttribute("aria-pressed", String(world.mix.muted));
      mute.classList.toggle("on", world.mix.muted);
      master.value = String(world.mix.master);
      masterV.textContent = `${Math.round(world.mix.master * 100)}%`;
    };
    world.mix.listeners.push(this.renderMix);
    this.renderMix();
    mute.addEventListener("click", () => {
      ctx.audio.start();
      world.mix.setMuted(!world.mix.muted);
    });
    master.addEventListener("input", () => {
      ctx.audio.start();
      world.mix.setMaster(Number(master.value));
    });

    this.el.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement & HTMLSelectElement;
      if (t.dataset.ch) {
        const ch = t.dataset.ch as (typeof CHANNELS)[number];
        log.setLevel(ch, t.value as Level);
        setOverride(`log.channels.${ch}`, t.value);
      } else if (t.dataset.set === "console") {
        log.setConsole(t.checked);
        setOverride("log.console", t.checked);
      } else if (t.dataset.set === "dock") {
        config.panel.dock = t.value as "right" | "left";
        setOverride("panel.dock", t.value);
        onDock(config.panel.dock);
      } else if (t.dataset.set === "fps") {
        config.flags.fps = t.checked;
        setOverride("flags.fps", t.checked);
      }
    });
    this.el.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "copy") void navigator.clipboard.writeText(JSON.stringify({ format: "cosmic-dev-config", version: 1, ...config }, null, 2));
      if (act === "reset") {
        clearOverrides();
        location.reload();
      }
    });
  }

  shown(on: boolean) {
    clearInterval(this.meterTimer);
    if (!on) return;
    const meter = this.el.querySelector<HTMLMeterElement>(".devp-meter")!;
    this.meterTimer = window.setInterval(() => (meter.value = loudest(this.ctx.audio.snapshot) ?? 0), 100);
    this.renderMix();
  }
}
