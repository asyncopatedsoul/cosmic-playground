import * as THREE from "three";
import type { AudioHost } from "../audio/host";
import { clearWorld, loadDoc, moduleCount, newId, parseDoc, serialize, toDoc, viewOf, type DocMeta, type ParseResult, type ViewDoc, type WorldDoc } from "../persist/doc";
import { exportFile, importFile, pickFile } from "../persist/file";
import { readLink, worldLink } from "../persist/link";
import { worldName } from "../persist/names";
import { AUTOSAVE, IdbStore, persistStorage, type WorldMeta, type WorldStore } from "../persist/store";
import { load as loadPref, save as savePref } from "../prefs";
import type { World } from "../world";
import { toast } from "./announce";

const GLYPH = `<svg viewBox="0 0 20 20"><path d="M3.5 13.5 8 6.5l5 4 3.5-6" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".6"/><circle cx="3.5" cy="13.5" r="1.7" fill="currentColor"/><circle cx="8" cy="6.5" r="1.7" fill="currentColor"/><circle cx="13" cy="10.5" r="1.7" fill="currentColor"/><circle cx="16.5" cy="4.5" r="1.7" fill="currentColor"/><circle cx="12" cy="16.5" r="1" fill="currentColor" opacity=".6"/></svg>`;
const EYE = `<svg viewBox="0 0 20 20"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/></svg>`;

const AUTOSAVE_MS = 30_000;
/** How long the "Jump to the saved view" chip stays (SAVE-LOAD.md §3). */
const EYE_MS = 8_000;
/** Which named save the autosave belongs to (a local detail, never in the doc). */
const AUTOSAVE_OF = "cosmic.autosaveOf";

export interface ConstellationDeps {
  world: World;
  audio: AudioHost;
  /** Avatar modes ignore the saved view. */
  avatarActive: () => boolean;
  /** In a room, only the admin may load a world into it (SAVE-LOAD.md §7). */
  room: () => { inRoom: boolean; admin: boolean };
  /** Before a world replaces this one (leave a puzzle). */
  beforeLoad: () => void;
  /** After toys may have been registered (redraw the chest); `doc` is the world that opened, if any. */
  afterLoad: (doc?: WorldDoc) => void;
  /** A dropped or imported `.cosmic-toy.json` (variants, SAVE-LOAD.md §6.3). */
  importToy?: (text: string) => Promise<boolean>;
  /** False while a puzzle is open: puzzles aren't autosaved as sandbox worlds. */
  saving: () => boolean;
}

/**
 * The Constellation sheet (docs/SAVE-LOAD.md §5, §7): New, Save, Save as,
 * Open (recent list), Import, Export, Share link; plus the autosave, the
 * Continue chip on start and the saved-view chip after an open.
 */
export class Constellations {
  private store: WorldStore = new IdbStore();
  /** The named save this world is (null: not saved yet), and its name, dates and seed. */
  private id: string | null = null;
  private meta: DocMeta = freshMeta();
  /** Fingerprints of the world at the last named save and the last autosave. */
  private namedPrint = "";
  private autoPrint = "";
  private print = "";
  private checking = false;
  private recheck = false;
  private button: HTMLButtonElement;
  private sheet: HTMLElement;
  private nameField: HTMLInputElement;
  private msg: HTMLElement;
  private list: HTMLElement;
  private chip: HTMLElement;
  private eyeTimer = 0;

  constructor(
    hud: HTMLElement,
    private d: ConstellationDeps,
  ) {
    this.button = document.createElement("button");
    this.button.className = "hud-constellations";
    this.button.innerHTML = `${GLYPH}<i class="cst-dot" aria-hidden="true"></i>`;
    this.button.title = "Constellations: save and open worlds (Ctrl+S, Ctrl+O)";
    this.button.setAttribute("aria-label", "Constellations");
    this.button.setAttribute("aria-expanded", "false");
    hud.prepend(this.button);

    this.sheet = document.createElement("div");
    this.sheet.className = "cst";
    this.sheet.hidden = true;
    this.sheet.setAttribute("role", "dialog");
    this.sheet.setAttribute("aria-label", "Constellations");
    this.sheet.innerHTML = `
      <div class="cst-head">
        ${GLYPH}
        <input class="cst-name" maxlength="60" spellcheck="false" aria-label="World name" title="This world's name">
      </div>
      <div class="cst-actions">
        <button data-act="save" title="Save (Ctrl+S)">Save</button>
        <button data-act="saveAs" title="Save a copy (Ctrl+Shift+S)">Save as</button>
        <button data-act="new" title="A fresh, empty world">New</button>
        <button data-act="view" title="Remember the current camera view with this world">Save view</button>
        <button data-act="import" title="Open a .constellation.json file (or drop it on the world)">Import</button>
        <button data-act="export" title="Download this world as a file (Ctrl+E)">Export</button>
        <button data-act="link" title="Copy a link to this world">Share link</button>
      </div>
      <p class="cst-msg" role="status"></p>
      <ul class="cst-list" aria-label="Saved worlds"></ul>`;
    document.body.append(this.sheet);
    this.nameField = this.sheet.querySelector(".cst-name")!;
    this.msg = this.sheet.querySelector(".cst-msg")!;
    this.list = this.sheet.querySelector(".cst-list")!;

    this.chip = document.createElement("div");
    this.chip.className = "cst-chip";
    this.chip.hidden = true;
    document.body.append(this.chip);

    this.button.addEventListener("click", () => this.toggle());
    this.sheet.addEventListener("click", (e) => void this.click(e));
    this.nameField.addEventListener("change", () => {
      this.meta.name = this.nameField.value.trim() || worldName();
      this.nameField.value = this.meta.name;
      this.changed();
    });
    this.nameField.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.nameField.blur();
    });
    addEventListener("keydown", (e) => this.key(e));

    // Anything that may have changed the world: check its fingerprint soon.
    const mark = () => this.changed();
    d.world.listeners.push({ add: mark, remove: mark, edit: mark, world: mark });
    setInterval(() => void this.autosave(), AUTOSAVE_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.autosave();
    });
    addEventListener("pagehide", () => void this.autosave());

    // Drop a world file anywhere on the page.
    addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      e.preventDefault();
      void this.importFrom(file);
    });
  }

  /** On start: open a world from the link, or offer to continue the autosave. */
  async start() {
    this.nameField.value = this.meta.name;
    await this.fingerprint();
    this.namedPrint = this.autoPrint = this.print;
    const link = await readLink();
    if (link) {
      history.replaceState(null, "", location.pathname + location.search);
      if (!link.ok) return this.say(link.error, true);
      await this.apply(link, null, { allowModules: false });
      return;
    }
    try {
      const auto = await this.store.get(AUTOSAVE);
      if (auto && auto.toys.length) this.offerContinue(auto);
    } catch {
      /* no storage (private window): nothing to continue */
    }
  }

  toggle(open = this.sheet.hidden) {
    this.sheet.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (open) {
      this.nameField.value = this.meta.name;
      void this.renderList();
    }
  }

  // ---- actions ----------------------------------------------------------

  /** Save to the current named save, or make one (`as`: always a new one). */
  async save(as = false) {
    if (as || !this.id) {
      if (as && this.id) this.meta = { ...freshMeta(), name: `${this.meta.name} copy`.slice(0, 60) };
      this.id = newId("w_");
    }
    const doc = await this.doc({ thumbnail: true, view: true });
    try {
      await this.store.put(this.id, doc);
      await this.store.put(AUTOSAVE, doc);
      savePref(AUTOSAVE_OF, this.id);
      persistStorage();
    } catch {
      return this.say("Couldn't save here (storage is off in this window). Export a file instead.", true);
    }
    this.namedPrint = this.autoPrint = this.print = fingerprintOf(doc);
    this.render();
    this.say(`Saved “${doc.name}”`);
    if (!this.sheet.hidden) void this.renderList();
  }

  /** Update only the saved view bookmark of the current save. */
  private async saveView() {
    this.viewBookmark = viewOf(this.d.world);
    if (this.id) await this.save();
    else this.say("View remembered; it's saved with the world.");
  }

  private viewBookmark: ViewDoc | null = null;

  async openSaved(id: string) {
    const doc = await this.store.get(id).catch(() => null);
    if (!doc) return this.say("That world is gone.", true);
    await this.apply(parseDoc(doc), id);
  }

  newWorld() {
    if (!this.mayLoad()) return;
    this.d.beforeLoad();
    clearWorld(this.d.world);
    this.d.afterLoad();
    this.id = null;
    this.meta = freshMeta();
    this.viewBookmark = null;
    this.nameField.value = this.meta.name;
    savePref(AUTOSAVE_OF, null);
    void this.fingerprint().then(() => {
      this.namedPrint = this.print;
      this.render();
    });
    this.say("A fresh world");
  }

  async exportNow() {
    exportFile(await this.doc({ thumbnail: true, view: true }));
    this.say("Downloaded");
  }

  private async importFrom(file: File) {
    // A toy file (a variant) goes to the chest, not into the world.
    if (this.d.importToy && file.size < 2 * 1024 * 1024) {
      const text = await file.text();
      if (isToyFile(text)) {
        await this.d.importToy(text);
        return;
      }
    }
    const r = await importFile(file);
    if (!r.ok) return this.say(r.error, true);
    await this.apply(r, null);
  }

  private async shareLink() {
    const url = await worldLink(await this.doc({ thumbnail: false, view: true }));
    if (!url) return this.say("Too big for a link: share the file instead (Export).", true);
    try {
      await navigator.clipboard.writeText(url);
      this.say("Link copied");
    } catch {
      prompt("Copy this link", url);
    }
  }

  private async remove(id: string) {
    await this.store.remove(id).catch(() => {});
    if (id === this.id) this.id = null;
    void this.renderList();
  }

  // ---- loading ----------------------------------------------------------

  private mayLoad() {
    const r = this.d.room();
    if (r.inRoom && !r.admin) {
      this.say("Only the room's admin can load a world into it.", true);
      return false;
    }
    if (!this.d.world.canEdit()) {
      this.say("The world is locked.", true);
      return false;
    }
    return true;
  }

  /** Replace the world with a parsed doc; `id` is its named save, if it has one. */
  private async apply(r: ParseResult, id: string | null, opts?: { allowModules: boolean }) {
    if (!r.ok) return this.say(r.error, true);
    if (!this.mayLoad()) return;
    const doc = r.doc;
    const n = moduleCount(doc);
    const allowModules = opts?.allowModules ?? (n === 0 || (await this.ask(`This world has ${n === 1 ? "1 custom sound" : `${n} custom sounds`} made in the Forge. Play ${n === 1 ? "it" : "them"}?`)));
    this.d.beforeLoad();
    const before = this.d.world.stage.getOrbit();
    const result = loadDoc(this.d.world, doc, { allowModules });
    this.d.afterLoad(doc);
    // A newer file opens, but saving goes to a new copy so the original stays whole.
    this.id = r.readOnly ? null : id;
    this.meta = { name: doc.name, created: doc.created, seed: doc.seed };
    this.viewBookmark = result.view;
    this.nameField.value = this.meta.name;
    savePref(AUTOSAVE_OF, this.id);
    await this.fingerprint();
    this.namedPrint = id ? this.print : "";
    this.render();
    const inRoom = this.d.room().inRoom;
    for (const note of [...r.warnings, ...result.notes]) toast(note);
    this.say(inRoom ? `Loaded “${doc.name}” into the room` : `Opened “${doc.name}”`);
    if (result.view && !inRoom && !this.d.avatarActive() && viewDiffers(before, result.view)) this.offerView(result.view);
  }

  // ---- autosave and fingerprints -------------------------------------------

  /** Something outside the world's edit events changed what a save holds (a toy kept as a variant). */
  markChanged() {
    this.changed();
  }

  /** Something may have changed: refresh the fingerprint (coalesced). */
  private changed() {
    if (this.checking) {
      this.recheck = true;
      return;
    }
    this.checking = true;
    setTimeout(async () => {
      try {
        await this.fingerprint();
        this.render();
        // Playing on instead of continuing: the Continue chip goes away.
        if (this.print !== this.autoPrint && this.chip.classList.contains("cst-continue")) this.hideChip();
      } finally {
        this.checking = false;
        if (this.recheck) {
          this.recheck = false;
          this.changed();
        }
      }
    }, 500);
  }

  private async fingerprint() {
    this.print = fingerprintOf(await this.doc({ thumbnail: false, view: false }));
  }

  private async autosave() {
    if (!this.d.saving()) return;
    await this.fingerprint();
    if (this.print === this.autoPrint) return;
    try {
      await this.store.put(AUTOSAVE, await this.doc({ thumbnail: true, view: true }));
      savePref(AUTOSAVE_OF, this.id);
      this.autoPrint = this.print;
    } catch {
      /* no storage: nothing to do, the world keeps playing */
    }
  }

  private async doc(o: { thumbnail: boolean; view: boolean }): Promise<WorldDoc> {
    const view = o.view ? (this.viewBookmark ?? viewOf(this.d.world)) : undefined;
    return toDoc(this.d.world, this.meta, { view, thumbnail: o.thumbnail ? this.thumbnail() : undefined });
  }

  /** A small WebP of the canvas, drawn right after a render so the buffer is still there. */
  private thumbnail(): string | undefined {
    try {
      const stage = this.d.world.stage;
      stage.render();
      const src = stage.renderer.domElement;
      const c = document.createElement("canvas");
      c.width = 192;
      c.height = 120;
      const g = c.getContext("2d")!;
      const s = Math.max(c.width / src.width, c.height / src.height);
      g.drawImage(src, (c.width - src.width * s) / 2, (c.height - src.height * s) / 2, src.width * s, src.height * s);
      const url = c.toDataURL("image/webp", 0.6);
      return url.length < 24 * 1024 * 1.37 ? url : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- chips --------------------------------------------------------------

  /** "Continue where you left off" (SAVE-LOAD.md §7). */
  private offerContinue(auto: WorldDoc) {
    this.chip.className = "cst-chip cst-continue";
    this.chip.innerHTML = `<button data-act="continue">${GLYPH}<span>Continue <b></b></span></button><button data-act="fresh" class="cst-fresh">start fresh</button>`;
    this.chip.querySelector("b")!.textContent = auto.name;
    this.chip.hidden = false;
    this.chip.onclick = (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (!act) return;
      this.d.audio.start();
      this.hideChip();
      if (act === "continue") void this.apply(parseDoc(auto), loadPref<string | null>(AUTOSAVE_OF, null)).then(() => (this.autoPrint = this.print));
    };
  }

  /** "Jump to the saved view", offered for 8 s and never forced. */
  private offerView(view: ViewDoc) {
    this.chip.className = "cst-chip cst-eye";
    this.chip.innerHTML = `<button data-act="eye" title="Jump to the saved view">${EYE}<span>Saved view</span></button>`;
    this.chip.hidden = false;
    this.chip.onclick = () => {
      const c = view.camera;
      this.d.world.stage.flyTo({ target: new THREE.Vector3(...c.target), azimuth: c.azimuth, elevation: c.elevation, distance: c.distance }, 600);
      this.hideChip();
    };
    clearTimeout(this.eyeTimer);
    this.eyeTimer = window.setTimeout(() => this.hideChip(), EYE_MS);
  }

  private hideChip() {
    this.chip.hidden = true;
    this.chip.onclick = null;
  }

  /** A yes/no question in the sheet's place (custom sounds need an OK). */
  private ask(question: string): Promise<boolean> {
    return new Promise((resolve) => {
      const box = document.createElement("div");
      box.className = "cst-ask";
      box.setAttribute("role", "alertdialog");
      box.innerHTML = `<p></p><div><button data-yes>Play them</button><button data-no>Leave them out</button></div>`;
      box.querySelector("p")!.textContent = question;
      document.body.append(box);
      box.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest("button");
        if (!b) return;
        box.remove();
        resolve(b.hasAttribute("data-yes"));
      });
      box.querySelector<HTMLButtonElement>("[data-yes]")!.focus();
    });
  }

  // ---- UI -----------------------------------------------------------------

  private async click(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "save") await this.save();
    if (act === "saveAs") await this.save(true);
    if (act === "new") this.newWorld();
    if (act === "view") await this.saveView();
    if (act === "import") {
      const f = await pickFile();
      if (f) await this.importFrom(f);
    }
    if (act === "export") await this.exportNow();
    if (act === "link") await this.shareLink();
    if (act === "open" && b.dataset.id) {
      await this.openSaved(b.dataset.id);
      this.toggle(false);
    }
    if (act === "delete" && b.dataset.id) await this.remove(b.dataset.id);
  }

  private key(e: KeyboardEvent) {
    if (e.key === "Escape" && !this.sheet.hidden) return this.toggle(false);
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "s") void this.save(e.shiftKey);
    else if (k === "o" && !e.shiftKey) this.toggle(true);
    else if (k === "e" && !e.shiftKey) void this.exportNow();
    else return;
    e.preventDefault();
  }

  private render() {
    const dirty = this.print !== this.namedPrint;
    this.button.classList.toggle("dirty", dirty);
    this.button.title = `Constellations: ${this.meta.name}${dirty ? " (unsaved changes)" : ""}`;
  }

  private async renderList() {
    let rows: WorldMeta[] = [];
    try {
      rows = await this.store.list();
    } catch {
      this.list.innerHTML = `<li class="cst-empty">Saving is off in this window; Export still works.</li>`;
      return;
    }
    if (!rows.length) {
      this.list.innerHTML = `<li class="cst-empty">No saved worlds yet.</li>`;
      return;
    }
    this.list.innerHTML = rows
      .map(
        (r) => `<li class="${r.id === this.id ? "current" : ""}">
          <button data-act="open" data-id="${esc(r.id)}" title="Open ${esc(r.name)}">
            ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="">` : `<span class="cst-thumb">${GLYPH}</span>`}
            <span class="cst-row-name">${esc(r.name)}</span>
            <small>${ago(r.modified)} · ${r.toys} toy${r.toys === 1 ? "" : "s"}</small>
          </button>
          <button data-act="delete" data-id="${esc(r.id)}" class="cst-del" title="Delete ${esc(r.name)}" aria-label="Delete ${esc(r.name)}">×</button>
        </li>`,
      )
      .join("");
  }

  private say(text: string, bad = false) {
    this.msg.textContent = text;
    this.msg.classList.toggle("bad", bad);
    if (this.sheet.hidden) toast(text);
  }
}

function freshMeta(): DocMeta {
  return { name: worldName(), created: new Date().toISOString(), seed: newId() };
}

/** The doc without what changes on every save, for "has anything changed?". */
function fingerprintOf(doc: WorldDoc): string {
  const { modified: _m, thumbnail: _t, view: _v, ...rest } = doc;
  return serialize(rest as WorldDoc);
}

/** More than ~15° or 20% distance away (REVISIONS.md R3.1). */
function viewDiffers(o: { azimuth: number; elevation: number; distance: number; target: THREE.Vector3 }, v: ViewDoc) {
  const c = v.camera;
  const tau = Math.PI * 2;
  const dAz = Math.abs(((((c.azimuth - o.azimuth) % tau) + tau * 1.5) % tau) - Math.PI);
  const deg15 = (15 * Math.PI) / 180;
  return dAz > deg15 || Math.abs(c.elevation - o.elevation) > deg15 || Math.abs(c.distance / o.distance - 1) > 0.2 || o.target.distanceTo(new THREE.Vector3(...c.target)) > 1.5;
}

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** True for a `.cosmic-toy.json` (a variant), which goes to the chest instead of opening as a world. */
function isToyFile(text: string): boolean {
  try {
    const v = JSON.parse(text) as { format?: unknown } | null;
    return v?.format === "cosmic-toy";
  } catch {
    return false;
  }
}
