import type { AudioHost } from "./audio/host";
import { parseRoom } from "./net/room";
import { clearWorld } from "./persist/doc";
import { save } from "./prefs";
import { ask } from "./ui/ask";
import type { Constellations } from "./ui/constellations";
import { LAST_KEY, Menu, type Entry, type Last } from "./ui/menu";
import type { PuzzleShelf } from "./ui/puzzles";
import type { RoomSheet } from "./ui/room";
import type { World } from "./world";

const HOME = `<svg viewBox="0 0 20 20"><path d="M3 9.5 10 3.5l7 6M5 8v8.5h3.8v-5h2.4v5H15V8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

/** How long the sound fades before a world is cleared (MAIN-MENU.md §5). */
const FADE_MS = 300;
/** The menu's slow camera drift, radians per second. */
const DRIFT = 0.025;

export interface ShellDeps {
  world: World;
  audio: AudioHost;
  constellations: Constellations;
  puzzles: PuzzleShelf;
  room: RoomSheet;
  /** Fill an empty world with the starter toys. */
  starter: () => void;
  /** Close every sheet and panel, leave avatar and focus modes, forget undo. */
  tidy: () => void;
  /** Turn world input on or off. */
  setInput: (on: boolean) => void;
  /** Open the chest (a new world starts with it open). */
  openChest: () => void;
}

/**
 * The app's two states (docs/MAIN-MENU.md §3): the main menu, or a world.
 * Every way in goes through `enter`; Home, the back button and leaving a
 * room all come out through `home`.
 */
export class Shell {
  state: "menu" | "world" = "menu";
  readonly menu: Menu;
  private busy = false;
  private homeButton = document.createElement("button");

  constructor(private d: ShellDeps) {
    this.menu = new Menu(d.constellations, d.puzzles, (code) => !!parseRoom(code));
    this.menu.onEnter = (e) => void this.enter(e);

    this.homeButton.className = "hud-home";
    this.homeButton.innerHTML = HOME;
    this.homeButton.title = "Main menu (your world is kept)";
    this.homeButton.setAttribute("aria-label", "Main menu");
    document.getElementById("hud")!.prepend(this.homeButton);
    this.homeButton.addEventListener("click", () => this.requestHome());

    // Back (browser, Android) from a world is Home; entering pushed an entry for it.
    addEventListener("popstate", () => {
      if (this.state !== "world") return;
      void this.home().then((left) => {
        if (!left) this.push();
      });
    });
    addEventListener("pagehide", () => {
      if (this.state === "world") this.noteLast();
    });
  }

  /** On start: links, invites and puzzles open straight in; otherwise the menu (MAIN-MENU.md §4.5). */
  async boot(o: { puzzle: string | null }) {
    const linked = await this.d.constellations.start();
    if (linked || this.d.room.session) return this.entered();
    if (o.puzzle && this.d.puzzles.open(o.puzzle)) return this.entered();
    await this.showMenu();
  }

  /** The world is showing (a test start, a link, or a file dropped on the menu). */
  entered() {
    if (this.state === "world") return;
    this.state = "world";
    this.menu.hide();
    document.body.classList.remove("in-menu");
    this.d.setInput(true);
    this.push();
    this.noteLast();
  }

  async enter(e: Entry) {
    if (this.busy || this.state !== "menu") return;
    this.busy = true;
    // The click is the gesture that lets sound start.
    this.d.audio.start();
    const { constellations, puzzles, room } = this.d;
    try {
      let ok = true;
      switch (e.kind) {
        case "continue":
          ok = await constellations.continueLast();
          break;
        case "saved":
          ok = await constellations.openSaved(e.id);
          break;
        case "file":
          ok = await constellations.pickAndImport();
          break;
        case "puzzle":
          ok = !!puzzles.open(e.id);
          break;
        case "new":
        case "together":
        case "rejoin":
          await constellations.startFresh(this.d.starter);
          if (e.kind === "new") this.d.openChest();
          break;
      }
      if (!ok) return;
      this.entered();
      if (e.kind === "together") room.toggle(true);
      if (e.kind === "rejoin") {
        const addr = parseRoom(e.code);
        if (addr) room.join(addr);
      }
    } finally {
      this.busy = false;
    }
  }

  /** The Home button: through history when there's an entry for the world, so Back and Home agree. */
  requestHome() {
    if (this.state !== "world") return;
    if ((history.state as { cosmic?: string } | null)?.cosmic === "world") history.back();
    else void this.home();
  }

  /** Leave the world for the menu (MAIN-MENU.md §5). False if the player chose to stay. */
  async home(): Promise<boolean> {
    if (this.state !== "world" || this.busy) return false;
    const { world, constellations, puzzles, room } = this.d;
    if (room.session && !(await ask("Leave the room? The others keep playing.", "Leave", "Stay"))) return false;
    this.busy = true;
    try {
      this.noteLast();
      await constellations.autosave();
      room.leave();
      if (puzzles.mode) puzzles.leave();
      world.audio.send({ t: "master", gain: 0 });
      await new Promise((r) => setTimeout(r, FADE_MS));
      this.d.tidy();
      clearWorld(world);
      world.mix.apply();
      await this.showMenu();
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** The menu's backdrop: a slow turn of the empty sky. */
  update(dt: number) {
    if (this.state === "menu" && !this.d.world.stage.reducedMotion) this.d.world.stage.orbit(dt * DRIFT, 0);
  }

  private async showMenu() {
    this.state = "menu";
    document.body.classList.add("in-menu");
    this.d.setInput(false);
    await this.menu.show();
  }

  private push() {
    history.pushState({ cosmic: "world" }, "");
  }

  /** What to put on the Continue card next time. */
  private noteLast() {
    const { puzzles, room } = this.d;
    const last: Last = puzzles.mode ? { kind: "puzzle", id: puzzles.mode.doc.id } : room.session ? { kind: "room", code: room.session.address.code } : { kind: "world" };
    save(LAST_KEY, last);
  }
}

