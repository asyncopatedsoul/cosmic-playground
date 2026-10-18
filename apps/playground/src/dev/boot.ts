import type { AudioHost } from "../audio/host";
import type { Avatar } from "../avatar/avatar";
import type { DevMode } from "../devmode";
import type { Stage } from "../render/stage";
import type { PulseEditor } from "../ui/pulse-editor";
import type { RoomSheet } from "../ui/room";
import type { World } from "../world";
import { resolveConfig, setOverride, type DevConfig } from "./config";
import { Log } from "./log";
import { DevlogSink } from "./sink";
import { connectSources } from "./sources";

/** What the dev tools can see and drive. */
export interface DevContext {
  mode: Exclude<DevMode, "off">;
  /** The page's query string at startup (joining a room rewrites the URL). */
  search: string;
  world: World;
  audio: AudioHost;
  stage: Stage;
  room: RoomSheet;
  editor: PulseEditor;
  avatar: Avatar;
}

export interface DevTools {
  config: DevConfig;
  log: Log;
  /** Call once per rendered frame: the perf channel, the panel's fps readout. */
  frame(dt: number): void;
  readonly frameHooks: ((dt: number) => void)[];
}

/**
 * Starts developer mode (docs/DEV-MODE.md §3): config, the muted start, the
 * log and its sources, the devlog sink, and the panel (dev and `?test&panel`).
 * Loaded as its own chunk, only when `devMode()` isn't "off".
 */
export async function boot(ctx: DevContext): Promise<DevTools> {
  const { config, warnings, layers } = resolveConfig(ctx.search);
  const { world } = ctx;

  // Listening (§3.3): test mode is always silent; dev mode follows audio.muted
  // (default true); feedback mode leaves the player's own setting alone.
  if (ctx.mode === "test") setMuted(world, true);
  else if (ctx.mode === "dev") setMuted(world, config.audio.muted);
  if (ctx.mode === "dev" && config.audio.master !== null) {
    world.mix.master = config.audio.master;
    world.mix.apply();
  }
  // In dev mode, muting or unmuting anywhere (HUD, panel, key) is remembered as the dev setting.
  if (ctx.mode === "dev") {
    let muted = world.mix.muted;
    world.mix.listeners.push(() => {
      if (world.mix.muted === muted) return;
      muted = world.mix.muted;
      config.audio.muted = muted;
      setOverride("audio.muted", muted);
    });
  }

  const beat = () => {
    const snap = ctx.audio.snapshot;
    if (!snap || !ctx.audio.ready) return undefined;
    return snap[0] + (((performance.now() - ctx.audio.snapTime) / 1000) * snap[1]) / 60;
  };
  const log = new Log(config.log, beat);
  log.log("app", "info", "app.boot", {
    build: __BUILD_ID__,
    mode: ctx.mode,
    url: location.pathname + ctx.search,
    ua: navigator.userAgent,
    viewport: [innerWidth, innerHeight],
    dpr: devicePixelRatio,
    config: layers.map((l) => l.name),
  });
  for (const w of warnings) log.log("app", "warn", "app.config", { warning: w });
  const frameHooks = [connectSources(log, ctx)];
  if (import.meta.env.DEV && config.log.sink === "devlog") new DevlogSink(log);

  const tools: DevTools = {
    config,
    log,
    frameHooks,
    frame: (dt) => {
      for (const h of frameHooks) h(dt);
    },
  };
  if (ctx.mode === "dev" || new URLSearchParams(ctx.search).has("panel")) {
    const { DevPanel } = await import("../ui/dev/panel");
    new DevPanel(ctx, tools, warnings, layers);
  }
  return tools;
}

/** Mute or unmute without touching the player's saved preference (cosmic.mix). */
function setMuted(world: World, on: boolean) {
  if (world.mix.muted === on) return;
  world.mix.muted = on;
  world.mix.apply();
  for (const l of world.mix.listeners) l();
}
