import { Param } from "./protocol";
import { load, save } from "../prefs";
import type { Toy } from "../toys/toy";
import type { World } from "../world";

/** Everything but the focused toy ducks to about −14 dB. */
export const FOCUS_DUCK = 0.2;
/** The engine's headroom: the HUD's full volume sends this master gain. */
const HEADROOM = 0.85;
const PREFS_KEY = "cosmic.mix";

/** How a toy is being heard, for its visuals (AUDIO-MIX.md §4.2). */
export type Listening = "normal" | "muted" | "solo" | "focus" | "dimmed";

interface Saved {
  master: number;
  muted: boolean;
  muteWhenHidden: boolean;
}

/**
 * What this player hears (docs/AUDIO-MIX.md §3): the master level, global
 * mute, and per-toy mute, solo and focus. None of it is shared in a room or
 * saved with a world; master, mute and "mute when hidden" are remembered per
 * device. Each toy's level goes to the engine as its `Monitor` param, which
 * sits after the bus tap, so listening toys and visuals are unaffected.
 */
export class MixState {
  master: number;
  muted: boolean;
  muteWhenHidden: boolean;
  readonly toyMute = new Set<string>();
  readonly solo = new Set<string>();
  focus: string | null = null;
  /**
   * Focus view's ring (FOCUS-VIEW.md §4.4): while non-empty it replaces solo and
   * single focus. `focusSolo` silences everything off the set instead of ducking it.
   */
  readonly focusSet = new Set<string>();
  focusSolo = false;
  /** Called after any change, for the HUD, Listen sheet and toy panel. */
  readonly listeners: (() => void)[] = [];

  private sent = new WeakMap<Toy, number>();
  private hidden = false;

  constructor(private world: World) {
    const s = load<Partial<Saved>>(PREFS_KEY, {});
    this.master = typeof s.master === "number" ? Math.min(1, Math.max(0, s.master)) : 0.7;
    this.muted = s.muted === true;
    this.muteWhenHidden = s.muteWhenHidden === true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        this.hidden = document.visibilityState === "hidden";
        if (this.muteWhenHidden) this.sendMaster();
      });
    }
  }

  /** The level this player hears `toy` at, before its volume. */
  monitor(toy: Toy): number {
    if (this.toyMute.has(toy.id)) return 0;
    if (this.focusSet.size) return this.focusSet.has(toy.id) ? 1 : this.focusSolo ? 0 : FOCUS_DUCK;
    if (this.solo.size) return this.solo.has(toy.id) ? 1 : 0;
    if (this.focus) return toy.id === this.focus ? 1 : FOCUS_DUCK;
    return 1;
  }

  listening(toy: Toy): Listening {
    if (this.toyMute.has(toy.id)) return "muted";
    if (this.focusSet.size) return this.focusSet.has(toy.id) ? (this.focusSolo ? "solo" : "focus") : "dimmed";
    if (this.solo.size) return this.solo.has(toy.id) ? "solo" : "dimmed";
    if (this.focus) return toy.id === this.focus ? "focus" : "dimmed";
    return "normal";
  }

  get audible() {
    return !this.muted && !(this.muteWhenHidden && this.hidden);
  }

  setMaster(gain: number) {
    this.master = Math.min(1, Math.max(0, gain));
    // Turning the volume up while muted unmutes, so the slider never seems broken.
    if (this.muted && gain > 0) this.muted = false;
    this.changed();
  }

  setMuted(on: boolean) {
    this.muted = on;
    this.changed();
  }

  setMuteWhenHidden(on: boolean) {
    this.muteWhenHidden = on;
    this.changed();
  }

  /** Mute or unmute one toy for this player. */
  toggleMute(toy: Toy, on = !this.toyMute.has(toy.id)) {
    if (on) this.toyMute.add(toy.id);
    else this.toyMute.delete(toy.id);
    this.changed();
  }

  /** Solo is additive: soloing a second toy adds it. */
  toggleSolo(toy: Toy, on = !this.solo.has(toy.id)) {
    if (on) this.solo.add(toy.id);
    else this.solo.delete(toy.id);
    this.changed();
  }

  /** One focused toy at a time; focusing it again clears focus. */
  toggleFocus(toy: Toy, on = this.focus !== toy.id) {
    this.focus = on ? toy.id : this.focus === toy.id ? null : this.focus;
    this.changed();
  }

  /** Set (or clear, with an empty list) focus view's listening set. */
  setFocusSet(ids: Iterable<string>, solo: boolean) {
    this.focusSet.clear();
    for (const id of ids) this.focusSet.add(id);
    this.focusSolo = solo;
    this.changed();
  }

  /** Clear every toy's mute, solo and focus (global mute and volume stay). */
  clearToys() {
    this.toyMute.clear();
    this.solo.clear();
    this.focus = null;
    this.changed();
  }

  /** A toy left the world: forget its listening state. */
  forget(toy: Toy) {
    const muted = this.toyMute.delete(toy.id);
    const soloed = this.solo.delete(toy.id);
    const focused = this.focus === toy.id;
    if (focused) this.focus = null;
    const ringed = this.focusSet.delete(toy.id);
    if (muted || soloed || focused || ringed) this.changed();
  }

  /** A toy's volume changed (here or from the room): redraw the controls. */
  volumeChanged() {
    for (const l of this.listeners) l();
  }

  /** Send the master level and any toy monitors that changed. */
  apply() {
    this.sendMaster();
    for (const toy of this.world.toys) {
      if (!toy) continue;
      const v = this.monitor(toy);
      if (this.sent.get(toy) === v) continue;
      this.sent.set(toy, v);
      this.world.audio.send({ t: "param", slot: toy.slot, p: Param.Monitor, v });
    }
  }

  private sendMaster() {
    this.world.audio.send({ t: "master", gain: this.audible ? this.master * HEADROOM : 0 });
  }

  private changed() {
    this.apply();
    save(PREFS_KEY, { master: this.master, muted: this.muted, muteWhenHidden: this.muteWhenHidden } satisfies Saved);
    for (const l of this.listeners) l();
  }
}
